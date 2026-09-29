window.M = window.M || {};
/* ============================================================================
   Chalk · household cloud sync + backup (m-sync.js) — M.cloud
   Shares foods and saved meals between Nick's and Katerina's phones and keeps
   a cloud copy of diaries, body logs, profiles and each person's training, so
   a lost or reset phone gets its history back. Supabase REST (PostgREST) over
   plain fetch; no library. Loads after m-core.js / m-trends.js.

   Table public.chalk_sync — see supabase/chalk_sync.sql. (household, kind, id)
   primary key; data jsonb; deleted boolean (tombstones: rows are never
   deleted); client_updated bigint; device text; updated_at stamped by a server
   trigger. Row-level security shows and writes only the rows whose household
   equals the request's x-household header. The code travels ONLY in that
   header (never in a URL); every row that comes back is checked again.

   Change detection never touches m-core internals: a hash of every record as
   it was when it last matched the cloud lives in localStorage "chalk.sync.v1".
   Hashes are over canonical JSON (sorted keys) because jsonb hands objects
   back with its own key order. Foods and meals travel without uses/lastUsed
   (this phone's own counts), so logging a food is not an edit.

   Each phone keeps only its own person's diary days and weigh-ins; the other
   person's stay in the cloud (pulled when the phone switches person).
   Every incoming row is cleaned by kind before it touches M.MS.

   Training: one backup row per person holds the exact chalk.v1 text. It is
   tied to the person AND the phone: a phone never overwrites workouts it
   doesn't have, and after "Switch person" it only backs up the new person once
   they trained on this phone. Restore keeps the replaced training for Undo.

   With SB_URL / SB_KEY empty this file makes zero network requests.
   Never throws at load, never throws from any M.cloud method.
   ========================================================================== */
(function (M) {
  "use strict";
  /* ================= CLOUD SYNC SETTINGS: the only two lines to fill in =================
     Both empty = sync is off: no network requests at all, and the card says
     "Cloud sync isn't set up yet."
     SB_URL: the Supabase project URL, like "https://abcd1234.supabase.co"
     SB_KEY: the project's PUBLISHABLE key ("sb_publishable_…"), never a secret key.
             It goes only in the apikey header (it is not a JWT). */
  const SB_URL = "https://jjyrlxiywqcchknkajir.supabase.co"; const SB_KEY = "sb_publishable_J2DJ7_IGpPZ3xWhTrD67TQ_BnWiAM6K";
  /* ===================================================================================== */

  /* ------------------------------------------------------------- constants */
  const ST_KEY = "chalk.sync.v1";            /* this file's own state */
  const TRAIN_KEY = "chalk.v1";              /* Chalk's training state (backup only) */
  const UNDO_KEY = "chalk.sync.undo";        /* the training a restore replaced (for Undo) */
  const RESTORED_KEY = "chalk.sync.restored";/* one-time note: N workouts restored */
  const TABLE = "chalk_sync";
  const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   /* 32 symbols: no 0 O 1 I */
  const CODE_RE = /^[A-HJ-NP-Z2-9]{20}$/;
  const COLL = { food: "foods", meal: "meals", day: "days", body: "body", profile: "profiles" };
  const ORDER = { train: 0, meta: 1, profile: 2, food: 3, meal: 4, body: 5, day: 6 };  /* training + small rows first */
  const NUT = ["cal", "p", "c", "f", "fiber", "sugar", "sodium"];
  const SELECT = "household,kind,id,data,deleted,client_updated,updated_at,device";
  const BASE_DAYS = 60;                      /* diary days keep a merge base this long */
  const EPOCH = "1970-01-01T00:00:00Z";
  const PAGE = 500;                          /* rows per pull page */
  const CHUNK_ROWS = 200, CHUNK_BYTES = 1e6; /* per upsert request */
  const MAX_ROW_BYTES = 2.9e6;               /* a row's data must stay under 3 MB */
  const SAVE_DELAY = 1500, SAVE_MAX_WAIT = 10000;
  const TICK_MS = 120000;                    /* every 2 min while visible */
  const TRAIN_GAP = 10 * 60000;              /* mid-workout training uploads at most every 10 min */
  const OVERLAP_MS = 10000;                  /* re-read the last 10 s: catches rows that committed late */
  const TIMEOUT_MS = 30000, MAX_PAGES = 400;
  const RETRY = [15000, 30000, 60000, 120000, 300000];
  const HOUR = 36e5, DAY_MS = 864e5;
  const META_EVERY = DAY_MS;                 /* is the household still there? once per start and per day */
  const REFUSED_AGAIN = DAY_MS, ASIDE_AGAIN = HOUR;   /* stuck rows are tried again this often (Sync now: always) */
  const UNDO_KEEP = DAY_MS;                   /* the Undo copy of a restore: one day (it can be big) */
  /* A copy made by the build before (no `bk`): that restore replaced every workout on the
     phone, so the copy may be the only one left of them. It keeps the week that build gave it. */
  const undoKeep = u => (isObj(u) && !Array.isArray(u.bk) ? 7 * DAY_MS : UNDO_KEEP);
  const MAXLEN = 120;                        /* names, brands, descriptions */
  const BISECT_BUDGET = 40;                  /* requests one cycle may spend hunting a bad row */
  const PREFER = { Prefer: "resolution=merge-duplicates,return=minimal" };
  const EAGER = { retry: 1, online: 1, show: 1, start: 1, join: 1, create: 1, code: 1, person: 1 };

  /* --------------------------------------------------------------- helpers */
  const isNum = v => typeof v === "number" && isFinite(v);
  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  function num(v, d) { if (d === undefined) d = 0; if (typeof v === "string" && v.trim() !== "") v = Number(v); return isNum(v) ? v : d; }
  const now = () => { try { return typeof M.now === "function" ? M.now() : Date.now(); } catch (e) { return Date.now(); } };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const kindOf = key => key.slice(0, key.indexOf("|"));
  const idOf = key => key.slice(key.indexOf("|") + 1);
  const isBadKey = k => k === "__proto__" || k === "constructor" || k === "prototype";
  const okPid = p => p === "nick" || p === "kat";
  const pidOfId = id => id.slice(0, id.indexOf("|"));
  const cpy = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  function lsGet(k) { try { return typeof localStorage === "undefined" ? null : localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (typeof localStorage === "undefined") return false; localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { if (typeof localStorage !== "undefined") localStorage.removeItem(k); } catch (e) {} }
  function unref(t) { try { if (t && typeof t.unref === "function") t.unref(); } catch (e) {} return t; }
  function rand(n) {
    const out = [];
    try {
      const c = typeof crypto !== "undefined" ? crypto : (typeof window !== "undefined" ? window.crypto : null);
      if (c && typeof c.getRandomValues === "function") { const b = c.getRandomValues(new Uint8Array(n)); for (let i = 0; i < n; i++) out.push(ALPHA[b[i] % 32]); return out.join(""); }
    } catch (e) {}
    for (let i = 0; i < n; i++) out.push(ALPHA[Math.floor(Math.random() * 32)]);
    return out.join("");
  }
  function curPid() {
    let p = null;
    try { p = typeof M.pid === "function" ? M.pid() : null; } catch (e) { p = null; }
    return okPid(p) ? p : null;
  }
  function activeWorkout() { try { return typeof S !== "undefined" && S && !!S.active; } catch (e) { return false; } }

  /* Canonical JSON: sorted keys at every level, undefined dropped (like JSON.stringify). */
  function canon(v) {
    if (v === null) return "null";
    const t = typeof v;
    if (t === "number") return isFinite(v) ? JSON.stringify(v) : "null";
    if (t === "string" || t === "boolean") return JSON.stringify(v);
    if (t !== "object") return undefined;
    if (typeof v.toJSON === "function") return canon(v.toJSON());
    if (Array.isArray(v)) { let s = "["; for (let i = 0; i < v.length; i++) { const x = canon(v[i]); s += (i ? "," : "") + (x === undefined ? "null" : x); } return s + "]"; }
    const keys = Object.keys(v).sort();
    let s = "{", first = true;
    for (const k of keys) { const x = canon(v[k]); if (x === undefined) continue; s += (first ? "" : ",") + JSON.stringify(k) + ":" + x; first = false; }
    return s + "}";
  }
  /* FNV-1a, two 32-bit lanes (different basis + multiplier) + length. */
  function fnv(str) {
    let a = 0x811c9dc5, b = 0x9747b28c;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      a ^= c; a = Math.imul(a, 0x01000193);
      b ^= c; b = Math.imul(b, 0x5bd1e995);
    }
    return (a >>> 0).toString(36) + "." + (b >>> 0).toString(36) + "." + str.length.toString(36);
  }
  const H = obj => fnv(canon(obj) || "");
  function utf8len(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1; else if (c < 0x800) n += 2; else if (c >= 0xd800 && c < 0xdc00) { n += 4; i++; } else n += 3;
    }
    return n;
  }
  const bytesOf = s => (s.length * 3 < MAX_ROW_BYTES ? s.length : utf8len(s));

  /* Server timestamps ("2026-09-28T19:22:33.123456+00:00") → microseconds since 1970. */
  function tsVal(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(String(s == null ? "" : s).trim());
    if (!m) return NaN;
    let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    if (m[8] && m[8].toUpperCase() !== "Z") {
      const z = m[8].replace(":", ""), sign = z[0] === "-" ? -1 : 1;
      ms -= sign * ((+z.slice(1, 3)) * 60 + (+(z.slice(3, 5) || 0))) * 60000;
    }
    return ms * 1000 + (m[7] ? +(m[7] + "000000").slice(0, 6) : 0);
  }
  /* A cursor may only move to a time we can read and that isn't absurdly far ahead. */
  function okTs(s) { const v = tsVal(s); return isFinite(v) && v / 1000 < now() + 7 * DAY_MS; }
  function later(a, b) { const x = tsVal(a), y = tsVal(b); return isFinite(x) && isFinite(y) ? x > y : isFinite(x); }
  function back(ts, ms) { const v = tsVal(ts); if (!isFinite(v)) return EPOCH; try { return new Date(Math.floor(v / 1000) - ms).toISOString(); } catch (e) { return EPOCH; } }
  function maxTs(rows, cur) {
    let best = cur;
    rows.forEach(r => { const t = r && r.updated_at; if (typeof t === "string" && okTs(t) && (!best || later(t, best))) best = t; });
    return best;
  }

  /* ----------------------------------------------------------------- state */
  function freshSt(device) {
    return { v: 1, code: "", device: device || "d" + rand(12).toLowerCase(), cursor: "", lastSync: 0, lastError: "", note: "",
      hashes: {}, gone: {}, bad: {}, fail: {}, base: {}, sent: {}, tomb: {}, train: {}, trainAt: 0, meta: null,
      verified: false, joining: false, pp: "", metaAt: 0, retryAt: 0, tp: null, tsw: null, prev: null, old: [], home: "" };
  }
  function loadSt() {
    let s = null;
    try { s = JSON.parse(lsGet(ST_KEY)); } catch (e) { s = null; }
    const o = freshSt(isObj(s) && typeof s.device === "string" && s.device && s.device.length <= 64 ? s.device : null);
    if (!isObj(s) || s.v !== 1) return o;
    o.code = typeof s.code === "string" && CODE_RE.test(s.code) ? s.code : "";
    o.cursor = typeof s.cursor === "string" && isFinite(tsVal(s.cursor)) ? s.cursor : "";   /* a bad saved cursor is dropped */
    o.cursorAt = num(s.cursorAt); o.ov = typeof s.ov === "string" ? s.ov : "";
    o.lastSync = num(s.lastSync);
    o.lastError = typeof s.lastError === "string" ? s.lastError : "";
    o.note = typeof s.note === "string" ? s.note : "";
    ["hashes", "gone", "fail", "base", "sent", "tomb", "train"].forEach(k => { if (isObj(s[k])) o[k] = s[k]; });
    if (isObj(s.bad)) Object.keys(s.bad).forEach(k => { const b = s.bad[k]; o.bad[k] = isObj(b) ? b : { h: String(b), at: 0, s: 0, k: "refused" }; });
    o.trainAt = num(s.trainAt);
    o.meta = isObj(s.meta) ? s.meta : null;
    o.verified = s.verified === true || (s.verified === undefined && !!o.code);
    o.joining = s.joining === true;
    o.pp = okPid(s.pp) ? s.pp : "";
    o.home = okPid(s.home) ? s.home : "";
    o.metaAt = num(s.metaAt); o.retryAt = num(s.retryAt);
    o.tp = isObj(s.tp) && Array.isArray(s.tp.pids) ? { pids: s.tp.pids.filter(okPid) } : null;
    o.tsw = isObj(s.tsw) && okPid(s.tsw.to) && Array.isArray(s.tsw.ids) ? { to: s.tsw.to, ids: s.tsw.ids.map(String) } : null;
    o.prev = isObj(s.prev) && typeof s.prev.code === "string" && CODE_RE.test(s.prev.code) ? s.prev : null;
    o.old = Array.isArray(s.old) ? s.old.filter(j => isObj(j) && typeof j.code === "string" && CODE_RE.test(j.code)).map(j => ({ code: j.code, why: j.why === "moved" ? "moved" : "deleted", at: num(j.at) })) : [];
    return o;
  }
  let st = loadSt();
  let unsaved = false;       /* M.MS holds pulled data that isn't on disk yet (phone was full) */
  /* The sync state says which records match the cloud. It is only written when the data it
     describes is on disk too; otherwise a restart would see "missing" records and delete them. */
  /* Inside a sync cycle the state is written once, at the end (it can be large). A phone killed
     before that only sends or reads a few rows again. force: write now. */
  let deferSt = 0, stDirty = false;
  function saveSt(force) {
    if (deferSt > 0 && !force) { stDirty = true; return true; }
    stDirty = false;
    if (unsaved && !commitLocal()) return false;
    return lsSet(ST_KEY, JSON.stringify(st));
  }
  /* The training copy a restore replaced lives for a day. */
  try { const u = JSON.parse(lsGet(UNDO_KEY)); if (u !== null && (!isObj(u) || now() - num(u.at) > undoKeep(u))) lsDel(UNDO_KEY); } catch (e) { lsDel(UNDO_KEY); }

  const over = { url: null, key: null, delay: null };
  function cfg() {
    /* pasted values can carry invisible characters (a header with one makes every request fail) */
    const url = String(over.url != null ? over.url : SB_URL || "").replace(/[^\x21-\x7e]/g, "").replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
    const key = String(over.key != null ? over.key : SB_KEY || "").replace(/[^\x21-\x7e]/g, "");
    return { url, key };
  }
  /* a secret key must never ship in a web page: with one, sync stays off */
  const configured = () => { const c = cfg(); return !!(c.url && c.key) && /^https?:\/\//i.test(c.url) && !/^sb_secret_/i.test(c.key); };
  const isOn = () => configured() && !!st.code;
  const endpoint = () => cfg().url + "/rest/v1/" + TABLE;
  const upsertURL = () => endpoint() + "?on_conflict=household,kind,id";

  let epoch = 0;            /* bumps on create / join / leave: an in-flight cycle for an old household stops */
  let inflight = null, queued = null, busy = false;
  let saveT = null, firstDirty = 0, ticker = null, retryT = null, retryN = 0;
  let applying = false, pendingN = 0, hold = null, badNote = "";
  let postOk = false, budget = 0, sentOk = new Set();
  let metaChecked = false;   /* the household row was checked since this page loaded */
  let origSave = null;       /* m-core's M.save, before the wrap below */
  const rcache = new Map();  /* key → {s: JSON.stringify(rec), h} so unchanged records skip canonical hashing */
  let tcache = { raw: null, val: null };

  /* ---------------------------------------------------------------- hashing */
  /* Foods and meals travel without this phone's own use counts. */
  function upData(kind, rec) {
    if ((kind === "food" || kind === "meal") && isObj(rec) && ("uses" in rec || "lastUsed" in rec)) {
      const o = Object.assign({}, rec); delete o.uses; delete o.lastUsed; return o;
    }
    /* a day an older build stored with a row's delete list: the list is never part of the day */
    if (kind === "day" && isObj(rec) && "gone" in rec) { const o = Object.assign({}, rec); delete o.gone; return o; }
    return rec;
  }
  /* Diary days and weigh-ins are most of the data: each one's hash is kept with the record
     itself and its edit stamp (m-core stamps every change), so a sync only re-reads the few
     that changed instead of all of them. */
  const wcache = typeof WeakMap === "function" ? new WeakMap() : null;
  function sigOf(kind, rec) {
    if (kind === "day") {
      const e = rec.entries, u = rec.updatedAt;
      if (typeof u !== "number" || !(u > 0) || !Array.isArray(e)) return "";
      const last = e.length ? e[e.length - 1] : null;
      return u + "|" + e.length + "|" + (last && typeof last === "object" ? last.id + "|" + last.servings : "") + "|" + rec.water + "|" + (typeof rec.note === "string" ? rec.note.length : 0);
    }
    if (kind === "body") return typeof rec.at === "number" && rec.at > 0 ? rec.at + "|" + rec.w + "|" + rec.rhr : "";
    return "";
  }
  function hashRec(key, rec) {
    const kind = kindOf(key);
    const sig = wcache && (kind === "day" || kind === "body") && isObj(rec) ? sigOf(kind, rec) : "";
    if (sig) { const w = wcache.get(rec); if (w && w.sig === sig && w.key === key) return w.h; }
    let s;
    try { s = JSON.stringify(rec); } catch (e) { return ""; }
    if (typeof s !== "string") return "";
    const c = rcache.get(key);
    let h;
    if (c && c.s === s) h = c.h;
    else { h = fnv(canon(upData(kind, rec)) || ""); rcache.set(key, { s, h }); }
    if (sig) { wcache.set(rec, { sig, key, h }); rcache.delete(key); }   /* one copy is enough */
    return h;
  }
  const blankDay = d => !(Array.isArray(d.entries) && d.entries.length) && !num(d.water) && !d.note && !num(d.updatedAt);
  /* The time a local record was last edited — compared with a remote row's client_updated. */
  function localTime(kind, rec) {
    if (kind === "body") return num(rec.at);
    if (kind === "profile") return Math.max(num(rec.updatedAt), num(rec.setupAt), num(rec.lastBody));
    if (kind === "food" || kind === "meal") return Math.max(num(rec.u), num(rec.updatedAt));   /* the edit stamp (L2) */
    return num(rec.updatedAt);
  }
  /* A phone can't have edited something after the server got it: cap its clock at the server's. */
  function remoteTime(r) {
    const t = num(r.client_updated), s = tsVal(r.updated_at);
    return isFinite(s) ? Math.min(t, Math.floor(s / 1000)) : t;
  }
  function markDirty(kind, id) {
    try { if (typeof M.markDirty === "function") M.markDirty(kind, id); } catch (e) {}
    try {
      const d = M.sync && M.sync.dirty;
      if (d && kind === "day" && d.days && typeof d.days.add === "function") d.days.add(id);
      if (d && kind === "body" && d.body && typeof d.body.add === "function") d.body.add(id);
    } catch (e) {}
  }

  /* ------------------------------------------------------ cleaning (by kind) */
  /* Copy JSON data without prototype keys; numbers must be finite. */
  function scrub(v, d) {
    if (Array.isArray(v)) return d > 40 ? [] : v.map(x => { const y = scrub(x, d + 1); return y === undefined ? null : y; });
    if (v && typeof v === "object") {
      const o = {};
      if (d > 40) return o;
      for (const k of Object.keys(v)) { if (isBadKey(k)) continue; const x = scrub(v[k], d + 1); if (x !== undefined) o[k] = x; }
      return o;
    }
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v === "string" || typeof v === "boolean" || v === null) return v;
    return undefined;
  }
  function hasBadKey(v, d) {
    if (!v || typeof v !== "object" || d > 60) return false;
    if (Array.isArray(v)) return v.some(x => hasBadKey(x, d + 1));
    for (const k of Object.keys(v)) if (isBadKey(k) || hasBadKey(v[k], d + 1)) return true;
    return false;
  }
  function fixStr(o, k, max, dflt) {
    if (!(k in o)) return;
    if (typeof o[k] === "number") o[k] = String(o[k]);
    if (typeof o[k] !== "string") { if (dflt === undefined) delete o[k]; else o[k] = dflt; return; }
    if (o[k].length > max) o[k] = o[k].slice(0, max);
  }
  function fixNum(o, k, nul, min) {
    if (!(k in o)) return;
    let v = o[k];
    if (v === null && nul) return;
    if (typeof v === "string" && v.trim() !== "" && isFinite(+v)) v = +v;
    if (!isNum(v) || (min != null && v < min)) { if (nul) o[k] = null; else delete o[k]; return; }
    o[k] = v;
  }
  const blankPer = () => { const o = {}; NUT.forEach(n => { o[n] = 0; }); return o; };
  function fixPer(o, k) {
    if (!(k in o)) return;
    if (!isObj(o[k])) { o[k] = k === "per" ? blankPer() : null; return; }
    const p = o[k];
    Object.keys(p).forEach(n => { let v = p[n]; if (typeof v === "string" && v.trim() !== "" && isFinite(+v)) v = +v; p[n] = isNum(v) ? v : 0; });
  }
  function fixNums(o, keys) { keys.forEach(k => fixNum(o, k, false)); }
  function fixObjNums(o, k) {
    if (!(k in o)) return;
    if (!isObj(o[k])) { delete o[k]; return; }
    Object.keys(o[k]).forEach(n => fixNum(o[k], n, false));
  }
  function fixPid(o) { if ("pid" in o && o.pid !== null && !okPid(o.pid)) o.pid = null; }
  function fixCook(o) {
    if (!("cook" in o)) return;
    if (!isObj(o.cook)) { delete o.cook; return; }
    fixNum(o.cook, "y", false, 0); fixStr(o.cook, "word", 12); fixPer(o.cook, "per100gCooked");
    if ("alts" in o.cook && !Array.isArray(o.cook.alts)) delete o.cook.alts;
  }
  function fixState(o) { if ("state" in o && o.state !== "raw" && o.state !== "cooked") delete o.state; }
  function fixLine(it, dfltName) {   /* a diary entry or a meal item */
    fixStr(it, "id", 120); fixStr(it, "name", MAXLEN, dfltName); if (typeof it.name !== "string") it.name = dfltName;
    fixStr(it, "brand", MAXLEN, ""); fixNum(it, "servings", false, 0); fixStr(it, "servingLabel", MAXLEN);
    fixNum(it, "g", true, 0); fixPer(it, "per"); if (!isObj(it.per)) it.per = blankPer();
    fixNum(it, "at", false); fixStr(it, "foodId", 120); fixStr(it, "mealId", 120); fixState(it); fixCook(it);
    ["foodId", "mealId"].forEach(k => { if (k in it && (!it[k] || isBadKey(it[k]))) delete it[k]; });   /* never a lookup by "__proto__" */
    return it;
  }
  /* Every line gets an id, the same one each time (a merge matches lines by id), never twice. */
  function lineIds(list) {
    const seen = new Set();
    list.forEach((x, i) => {
      if (typeof x.id !== "string" || !x.id || isBadKey(x.id) || x.id.length > 120) x.id = "x" + i;
      if (seen.has(x.id)) x.id = x.id.slice(0, 100) + "-" + i;
      seen.add(x.id);
    });
    return list;
  }
  function fixFood(o, id) {
    if (o.id !== id) o.id = id;
    fixStr(o, "name", MAXLEN, "Food"); fixStr(o, "brand", MAXLEN, ""); fixStr(o, "barcode", 40, ""); fixStr(o, "source", 40, "custom");
    if ("serving" in o) {
      if (!isObj(o.serving)) o.serving = { qty: 1, unit: "serving", g: null };
      else { fixNum(o.serving, "qty", false, 0); fixStr(o.serving, "unit", 60, "serving"); fixNum(o.serving, "g", true, 0); }
    }
    fixPer(o, "per"); fixPer(o, "per100g");
    if ("alts" in o) o.alts = Array.isArray(o.alts) ? o.alts.filter(a => isObj(a) && typeof a.label === "string").map(a => { fixStr(a, "label", MAXLEN); fixNum(a, "g", true); return a; }) : [];
    fixCook(o);
    fixNums(o, ["createdAt", "updatedAt", "uses", "lastUsed"]); fixPid(o);
    return true;
  }
  function fixMeal(o, id) {
    if (o.id !== id) o.id = id;
    fixStr(o, "name", MAXLEN, "Meal"); fixStr(o, "desc", 500, ""); fixStr(o, "slot", 20, "Any");
    if ("items" in o) o.items = Array.isArray(o.items) ? lineIds(o.items.filter(isObj).map(it => fixLine(it, "Item"))) : [];
    fixNum(o, "servingsMade", false, 0); fixPer(o, "per");
    if ("batch" in o) { if (!isObj(o.batch)) delete o.batch; else { fixNum(o.batch, "cookedG", false, 0); fixNum(o.batch, "rawG", false, 0); } }
    fixNums(o, ["createdAt", "updatedAt", "uses", "lastUsed"]); fixPid(o);
    return true;
  }
  function fixDay(o, id) {
    delete o.gone;            /* the entries a phone deleted travel with the row, not in the day */
    const p = pidOfId(id), date = id.slice(id.indexOf("|") + 1);
    if (o.id !== id) o.id = id;
    if (o.pid !== p) o.pid = p;
    if (o.date !== date) o.date = date;
    if (!Array.isArray(o.entries)) o.entries = [];
    else if (o.entries.some(e => !isObj(e))) o.entries = o.entries.filter(isObj);
    o.entries.forEach(e => { fixLine(e, "Food"); if (typeof e.slot !== "string" || !(typeof M.isSlot === "function" ? M.isSlot(e.slot) : true)) e.slot = "Snacks"; });
    lineIds(o.entries);
    fixNum(o, "water", false, 0); fixStr(o, "note", 1000, ""); fixNum(o, "updatedAt", false);
    /* the app reads these on every day: fill what a bad row dropped (own rows always have them) */
    if (!isNum(o.water)) o.water = 0;
    if (typeof o.note !== "string") o.note = "";
    if (!isNum(o.updatedAt)) o.updatedAt = 0;
    return true;
  }
  function fixBody(o, id) {
    const p = pidOfId(id), date = id.slice(id.indexOf("|") + 1);
    if (o.id !== id) o.id = id;
    if (o.pid !== p) o.pid = p;
    if (o.date !== date) o.date = date;
    fixNum(o, "w", true, 0); fixNum(o, "rhr", true, 0); fixNum(o, "at", false);
    return true;
  }
  function fixProfile(o, id) {
    if (o.id !== id) o.id = id;
    fixStr(o, "name", MAXLEN);
    if ("sex" in o && o.sex !== null && o.sex !== "m" && o.sex !== "f") o.sex = null;
    ["age", "heightIn", "weightLb", "goalWeightLb", "setupAt"].forEach(k => fixNum(o, k, true, 0));
    fixNums(o, ["pace", "lastBody", "updatedAt"]);
    fixStr(o, "activity", 20); fixStr(o, "split", 20); fixStr(o, "aiModel", 80);
    if ("units" in o && o.units !== "us" && o.units !== "metric") o.units = "us";
    if ("targetsManual" in o && typeof o.targetsManual !== "boolean") delete o.targetsManual;
    fixObjNums(o, "custom"); fixObjNums(o, "targets"); fixObjNums(o, "snooze");
    return true;
  }
  /* A clean copy of a cloud row's data, or null when it can't be repaired. For data this
     app wrote itself it changes nothing (so hashes match and nothing echoes). */
  function clean(kind, id, data) {
    if (!isObj(data)) return null;
    const o = scrub(data, 0);
    if (!isObj(o)) return null;
    try {
      if (kind === "food") fixFood(o, id);
      else if (kind === "meal") fixMeal(o, id);
      else if (kind === "day") fixDay(o, id);
      else if (kind === "body") fixBody(o, id);
      else if (kind === "profile") fixProfile(o, id);
    } catch (e) { return null; }
    /* K4: then m-core's own cleaner, when this build has it (weigh-in limits, the app's rules).
       Ours runs first, so every line already has a steady id and nothing random is added. */
    if (typeof M.clean === "function") {
      let c;
      try { c = M.clean(kind, id, cpy(o)); } catch (e) { return o; }
      if (c === null) return null;                   /* it can't be used: ours stays */
      if (isObj(c)) { const s2 = scrub(c, 0); if (isObj(s2)) return s2; }
    }
    return o;
  }
  function validId(kind, id) {
    if (!id || isBadKey(id)) return false;
    if (kind === "profile" || kind === "train") return okPid(id);
    if (kind === "day" || kind === "body") return /^(nick|kat)\|\d{4}-\d{2}-\d{2}$/.test(id);
    if (kind === "meta") return /^[a-z0-9_:-]{1,40}$/.test(id);
    return id.length <= 120 && !/[\u0000-\u001f]/.test(id);
  }

  /* --------------------------------------------------------------- training */
  function trainSum(d) {
    const log = Array.isArray(d && d.log) ? d.log : [];
    let last = 0;
    const ids = [];
    log.forEach(r => {
      if (!r || typeof r !== "object") return;
      const id = r.id != null ? String(r.id) : (r.start ? "s" + r.start : "");
      if (id) ids.push(id);
      last = Math.max(last, num(r.start));
    });
    return { n: log.length, last, ids };
  }
  /* The training backup row holds the exact chalk.v1 text: data = {v:1, json:"…"}. jsonb keeps a
     string byte for byte but re-sorts object keys, and Chalk lists a workout's exercises in key
     order — so the state travels as text and a restore writes back exactly what was saved. */
  function trainText(data) {
    if (!isObj(data)) return null;
    if (typeof data.json === "string") return data.json;
    return data.v === 1 && Array.isArray(data.log) ? JSON.stringify(data) : null;   /* a plain state object */
  }
  /* A backup is only usable for `pid` when it really is that person's Chalk save. */
  function trainCheck(pid, data) {
    if (!okPid(pid)) return null;
    const raw = trainText(data);
    if (raw == null || raw.length > 8e6) return null;
    let d = null;
    try { d = JSON.parse(raw); } catch (e) { return null; }
    if (!isObj(d) || d.v !== 1 || d.profile !== pid || !Array.isArray(d.log) || hasBadKey(d, 0)) return null;
    return { raw, d, sum: trainSum(d) };
  }
  function trainLocal() {
    const raw = lsGet(TRAIN_KEY);
    if (!raw) { tcache = { raw: null, val: null }; return null; }
    if (raw === tcache.raw) return tcache.val;
    let d = null;
    try { d = JSON.parse(raw); } catch (e) { d = null; }
    let val = null;
    if (isObj(d) && d.v === 1 && okPid(d.profile)) {
      const sum = trainSum(d);
      val = { id: d.profile, raw, h: fnv(raw), n: sum.n, last: sum.last, ids: sum.ids,
        gone: Array.isArray(d.gone) ? d.gone.map(String) : [], updated: num(d.updatedAt), busy: !!d.active, bytes: bytesOf(raw) };
    }
    tcache = { raw, val };
    return val;
  }
  function trainPid() {
    try { if (typeof S !== "undefined" && S && okPid(S.profile)) return S.profile; } catch (e) {}
    const tl = trainLocal();
    return tl ? tl.id : null;
  }
  /* Workouts in the cloud copy that this phone doesn't have (and didn't delete). */
  function missingCount(seen, tl) {
    const have = new Set(tl ? tl.ids : []);
    if (tl) tl.gone.forEach(g => have.add(g));
    return (Array.isArray(seen && seen.ids) ? seen.ids : []).filter(x => !have.has(String(x))).length;
  }
  /* Whose training history is on this phone? Chalk's "Switch person" keeps the history, so a
     switch alone never makes it the new person's: only a workout they log here does. */
  function trainOwner(tl) {
    const own = st.tp && Array.isArray(st.tp.pids) ? st.tp.pids : [];
    if (!tl.n) { st.tp = { pids: [tl.id] }; st.tsw = null; return true; }       /* nothing to mix up */
    if (!own.length) { st.tp = { pids: [tl.id] }; st.tsw = null; return true; }  /* first look */
    if (own.indexOf(tl.id) >= 0) { st.tsw = null; return true; }
    if (!st.tsw || st.tsw.to !== tl.id) st.tsw = { to: tl.id, ids: tl.ids.slice() };
    const before = new Set(st.tsw.ids);
    if (tl.ids.some(x => !before.has(x))) { st.tp = { pids: own.concat(tl.id) }; st.tsw = null; return true; }
    return false;
  }
  function noteTrain(r) {
    const id = String(r.id);
    const at = String(r.updated_at || ""), dev = typeof r.device === "string" ? r.device.slice(0, 64) : "";
    if (r.deleted === true) { st.train[id] = { del: true, t: num(r.client_updated), at }; return; }
    const t = trainCheck(id, r.data);
    if (!t) return;
    const h = fnv(t.raw);
    st.train[id] = { h, t: num(r.client_updated), at, n: t.sum.n, last: t.sum.last, ids: t.sum.ids, del: false, dev, guest: r.data.guest === true };
    const tl = trainLocal();
    if (tl && tl.id === id && tl.h === h) st.hashes["train|" + id] = h;
  }
  /* Workouts from `extra` whose ids `have` doesn't hold, added to state `d`, newest first like
     Chalk keeps them (its log[0] is the last workout). This phone's workout in progress stays.
     Returns how many were added. */
  const wid = w => (w.id != null ? String(w.id) : (w.start ? "s" + w.start : ""));
  function addWorkouts(d, cur, have, active) {
    const extra = (Array.isArray(cur.log) ? cur.log : []).filter(w => isObj(w) && wid(w) && !have.has(wid(w)));
    if (extra.length) d.log = d.log.concat(extra).map((w, i) => ({ w, i })).sort((a, b) => num(b.w.start) - num(a.w.start) || a.i - b.i).map(o => o.w);
    if (active) d.active = cur.active;
    if (extra.length && Array.isArray(cur.gone) && cur.gone.length) {
      const inLog = new Set(d.log.map(wid)), g = Array.isArray(d.gone) ? d.gone.slice() : [], seenG = new Set(g.map(String));
      cur.gone.forEach(x => { const k = String(x); if (!seenG.has(k) && !inLog.has(k)) { seenG.add(k); g.push(x); } });
      d.gone = g;
    }
    return extra.length;
  }
  function parseTrain(raw, pid) {
    let d = null;
    try { d = raw ? JSON.parse(raw) : null; } catch (e) { d = null; }
    return isObj(d) && d.v === 1 && d.profile === pid && Array.isArray(d.log) && !hasBadKey(d, 0) ? d : null;
  }
  /* Restore = the backup plus the workouts only this phone has (never a silent loss). */
  function mergeRestore(pid, t, curRaw) {
    const cur = parseTrain(curRaw, pid);
    if (!cur) return { raw: t.raw, kept: 0 };
    const have = new Set(t.sum.ids);
    (Array.isArray(t.d.gone) ? t.d.gone : []).forEach(g => have.add(String(g)));
    /* after Switch person, the workouts that were here at the switch are the other person's:
       they never go into this person's history (they stay in their own backup) */
    if (st.tsw && st.tsw.to === pid && Array.isArray(st.tsw.ids)) st.tsw.ids.forEach(x => have.add(String(x)));
    const d = JSON.parse(t.raw);
    const kept = addWorkouts(d, cur, have, isObj(cur.active));
    if (!kept && !isObj(cur.active)) return { raw: t.raw, kept: 0 };
    d.updatedAt = now();
    return { raw: JSON.stringify(d), kept };
  }
  function readUndo() {
    try {
      const u = JSON.parse(lsGet(UNDO_KEY));
      if (!isObj(u) || typeof u.raw !== "string" || now() - num(u.at) > undoKeep(u)) return null;
      return u;
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ http */
  /* As few headers as possible, the same for every request of a kind: reads send apikey and
     x-household; writes add content-type and Prefer. The browser checks these first (a CORS
     preflight). A publishable key is not a JWT: it goes in apikey only, never Authorization. */
  function headers(code, extra, hasBody) {
    const key = cfg().key;
    const h = { apikey: key, "x-household": code };
    if (hasBody) h["content-type"] = "application/json";
    if (/^eyJ[\w-]*\.[\w-]+\.[\w-]*$/.test(key)) h.Authorization = "Bearer " + key;   /* only an old-style JWT key */
    if (extra) Object.keys(extra).forEach(k => { h[k] = extra[k]; });
    return h;
  }
  /* This phone's clock minus the server's (Date header), used only when it's clearly off (over a
     minute): edit times are then compared in server time, so a phone whose clock runs fast
     can't win with an edit it made earlier (and a slow one isn't always beaten). */
  let skew = 0;
  function noteClock(res) {
    try {
      const d = res && res.headers && typeof res.headers.get === "function" ? res.headers.get("date") : null;
      const srv = d ? Date.parse(d) : NaN;
      if (!isFinite(srv)) return;
      const off = now() - (srv + 500);          /* Date is whole seconds */
      skew = Math.abs(off) > 60000 ? off : 0;
    } catch (e) {}
  }
  const srvTime = t => (isNum(t) && t > 0 ? t - skew : t);
  /* An Anthropic key never leaves the phone, even if it was pasted into a name or a note. */
  function noKey(s) {
    if (!s) return s;
    if (s.indexOf("sk-ant-") >= 0) s = s.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "");
    const k = String(lsGet("chalk.ai.key") || "").trim();
    if (k.length >= 16 && s.indexOf(k) >= 0) s = s.split(k).join("");
    return s;
  }
  function retryAfter(res) {
    try {
      const v = res && res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
      if (v == null || v === "") return 0;
      const s = Number(v);
      const ms = isFinite(s) ? s * 1000 : Date.parse(v) - Date.now();
      return isFinite(ms) && ms > 0 ? Math.min(ms, HOUR) : 0;
    } catch (e) { return 0; }
  }
  function request(method, url, body, code, extra) {
    return new Promise((resolve, reject) => {
      if (!configured()) { reject({ code: "config" }); return; }
      if (typeof fetch !== "function") { reject({ code: "net", message: "no fetch" }); return; }
      let done = false, ctl = null;
      try { ctl = typeof AbortController === "function" ? new AbortController() : null; } catch (e) { ctl = null; }
      const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
      const timer = setTimeout(() => { try { if (ctl) ctl.abort(); } catch (e) {} finish(reject, { code: "net", message: "timeout" }); }, TIMEOUT_MS);
      let p;
      try {
        const opt = { method, headers: headers(code, extra, body != null), cache: "no-store", credentials: "omit" };
        if (body != null) opt.body = body;
        if (ctl) opt.signal = ctl.signal;
        p = fetch(url, opt);
      } catch (e) { finish(reject, { code: "net", message: String(e && e.message || e) }); return; }
      /* a blocked CORS check (preflight) or a dropped connection rejects with a TypeError */
      Promise.resolve(p).then(res => {
        if (done) return;
        noteClock(res);
        if (!res || !res.ok) {
          const status = res ? res.status : 0, ra = retryAfter(res);
          Promise.resolve(res && typeof res.text === "function" ? res.text() : "").catch(() => "").then(t => finish(reject, { code: "http", status, retryAfter: ra, message: String(t || "").slice(0, 300) }));
          return;
        }
        if (method !== "GET") { finish(resolve, null); return; }
        Promise.resolve(res.json()).then(j => finish(resolve, j), () => finish(reject, { code: "bad", message: "not json" }));
      }, e => finish(reject, { code: "net", message: String(e && e.message || e) }));
    });
  }
  const getRows = (q, code) => request("GET", endpoint() + "?select=" + SELECT + q, null, code || st.code);
  function offline() { try { return typeof navigator !== "undefined" && navigator && navigator.onLine === false; } catch (e) { return false; } }
  function errText(e) {
    if (e && e.code === "http") {
      const s = e.status;
      if (s === 401 || s === 403) return "The cloud didn't let this phone in. We'll try again later.";
      if (s === 404) return "The cloud isn't ready yet. We'll try again.";
      if (s === 413) return "Something is too big to back up.";
      if (s === 429) return "The cloud is busy. We'll try again soon.";
      if (s >= 500) return "The cloud is having trouble. We'll try again soon.";
      return "Sync didn't work. We'll try again.";
    }
    if (e && e.code === "storage") return "This phone's storage is full. Free up space, then tap Sync now.";
    if (e && e.code === "bad") return "The cloud sent back something odd. We'll try again.";
    if (e && e.code === "setup") return "The cloud isn't set up right yet. We'll try again.";
    if (e && e.code === "unsafe") return "The cloud isn't set up safely. Nothing was shared.";
    if (e && e.code === "net" && e.message === "timeout" && !offline()) return "The cloud is slow to answer. We'll try again soon.";
    if (offline()) return "Can't reach the internet. We'll try again soon.";
    /* online, but the request never got an answer (blocked check, dropped connection) */
    return "Couldn't reach the cloud. We'll try again soon.";
  }
  /* join doesn't try again by itself */
  const joinErr = e => errText(e).replace(/ We'll try again(?: soon| later)?\.$/, " Try again in a minute.");
  /* Delete cloud copy couldn't start: say why, and that nothing was deleted */
  const notDeleted = r => String((r && r.error) || "Sync didn't work.").replace(/ We'll (?:keep trying|try again(?: soon| later)?)\.$/, "").replace(/, then tap Sync now\.$/, ".") + " Nothing was deleted. Try again in a minute.";

  /* ------------------------------------------------------------------ pull */
  function forget(key) { delete st.hashes[key]; delete st.gone[key]; delete st.base[key]; delete st.sent[key]; delete st.tomb[key]; delete st.bad[key]; delete st.fail[key]; rcache.delete(key); }
  /* Both sides now hold `data` (hash rh). Foods and meals keep that copy for field merges. */
  function agree(key, kind, data, rh) {
    st.hashes[key] = rh;
    delete st.sent[key];      /* the cloud copy is newer than our last push: it is the base now */
    if (kind === "food" || kind === "meal") st.base[key] = cpy(upData(kind, data));
    else if (kind === "day") { if (recentDay(idOf(key))) st.base[key] = dayBase(data); else delete st.base[key]; }
  }
  function keepLocal(kind, rec, local) {
    if ((kind === "food" || kind === "meal") && isObj(local)) {
      if (local.uses !== undefined) rec.uses = local.uses;
      if (local.lastUsed !== undefined) rec.lastUsed = local.lastUsed;
    }
    return rec;
  }
  /* Edit stamps (u, ms; m-core sets them on every change; a record without one counts as 0).
     A conflict both phones see settles the same way on both: the newer stamp wins, and on an
     exact tie the larger canonical copy. Never this phone's own clock or the day's time. */
  const stampOf = o => (isObj(o) ? Math.max(0, num(o.u)) : 0);
  const recStamp = o => (isObj(o) ? Math.max(0, num(o.u), num(o.updatedAt)) : 0);
  function theirsWin(sm, st_, m, t) {
    if (sm !== st_) return st_ > sm;
    const cm = canon(m), ct = canon(t);
    return (ct === undefined ? "" : ct) > (cm === undefined ? "" : cm);
  }
  /* One value, three copies: b (both phones last agreed), s (what this phone last sent, or
     undefined), m (mine), t (theirs). They hold exactly what we sent: our push is their base. */
  function pick3(b, s, hasS, m, t, tw) {
    if (m === t) return "m";
    const base = hasS && t === s ? s : b;
    if (t === base) return "m";
    if (m === base) return "t";
    if (hasS && m === s) return "t";        /* unchanged here since our push: theirs came after it */
    return tw() ? "t" : "m";
  }
  /* Field by field against the copy both phones last agreed on (and what we last sent). */
  function merge3(base, mine, theirs, sent, tw) {
    const out = {};
    const keys = new Set(Object.keys(base).concat(Object.keys(mine), Object.keys(theirs)));
    keys.forEach(k => {
      if (isBadKey(k)) return;
      const b = canon(base[k]), m = canon(mine[k]), t = canon(theirs[k]);
      const w = pick3(b, sent ? canon(sent[k]) : undefined, !!sent, m, t, () => tw(mine[k], theirs[k]));
      const v = w === "t" ? theirs[k] : mine[k];
      if (v !== undefined) out[k] = cpy(v);
    });
    return out;
  }
  /* ------------------------------ lists merged item by item (diary entries, meal items) */
  /* An entry's or item's fingerprint: short, since a day's merge base lives for weeks. */
  const eh = x => fnv(canon(x) || "").split(".")[0];
  /* Entries and items are matched by id ("i…"); one without an id by its content ("#…"). */
  const lineKey = x => (typeof x.id === "string" && x.id ? "i" + x.id : "#" + eh(x));
  /* B: {key: fingerprint} of the list both phones last agreed on, or null when there is none
     (then nothing counts as deleted: both sides' entries are kept). Kept from either side:
     new entries. Dropped: an entry deleted on one side and untouched on the other. Changed on
     both sides (or deleted on one, edited on the other): the newer change wins. Nothing doubles. */
  /* S: {e: {key: fingerprint}, f: {key: 1}} of what this phone last sent (f: first sent in
     that push), or null. seen: their copy was built on that push (see seenPush). */
  function mergeList(B, S, seen, mine, theirs, byTime, X, T) {
    const mL = (Array.isArray(mine) ? mine : []).filter(isObj), tL = (Array.isArray(theirs) ? theirs : []).filter(isObj);
    const tBy = new Map(), mBy = new Map();
    tL.forEach(x => { const k = lineKey(x); if (!tBy.has(k)) tBy.set(k, x); });
    mL.forEach(x => { const k = lineKey(x); if (!mBy.has(k)) mBy.set(k, x); });
    const Se = S && isObj(S.e) ? S.e : null;
    const pick = (k, m, t) => {
      const sk = Se && has(Se, k) ? Se[k] : undefined;
      /* the version both sides built on: what we sent, when they hold exactly that (or read that
         push); else the copy both phones last agreed on */
      const b = sk !== undefined && (seen || (t && eh(t) === sk)) ? sk : B && has(B, k) ? B[k] : undefined;
      if (m && t) {
        const hm = eh(m), ht = eh(t);
        if (hm === ht) return m;
        if (b !== undefined) { if (ht === b) return m; if (hm === b) return t; }
        if (sk !== undefined && hm === sk) return t;       /* unchanged here since our push */
        return theirsWin(stampOf(m), stampOf(t), m, t) ? t : m;
      }
      const x = m || t;
      if ((m && X && has(X, k)) || (t && T && has(T, k))) return null;   /* the other side deleted it */
      if (b === undefined) return x;                       /* new on one side */
      return null;   /* deleted on one side (untouched on the other, or changed there too: the delete sticks on both phones) */
    };
    const out = [], used = new Set();
    let added = false;
    mL.forEach(m => { const k = lineKey(m); if (used.has(k)) return; used.add(k); const v = pick(k, m, tBy.get(k)); if (v) out.push(v); });
    tL.forEach(t => { const k = lineKey(t); if (used.has(k)) return; used.add(k); const v = pick(k, null, t); if (v) { out.push(v); added = true; } });
    /* the same as one side: keep that side's own order (so nothing echoes back) */
    const same = (L, by) => out.length === L.length && out.every(x => { const y = by.get(lineKey(x)); return !!y && eh(y) === eh(x); });
    if (same(tL, tBy)) return tL;
    if (same(mL, mBy)) return mL;
    if (added && byTime) return out.map((x, i) => ({ x, i })).sort((a, b) => num(a.x.at) - num(b.x.at) || a.i - b.i).map(o => o.x);
    return out;
  }
  const listBase = L => { const B = {}; (Array.isArray(L) ? L : []).forEach(x => { if (isObj(x)) { const k = lineKey(x); if (!has(B, k)) B[k] = eh(x); } }); return B; };
  /* A diary day's merge base: its entries' fingerprints, water and note (not the whole day). */
  const dayBase = d => ({ d: 1, e: listBase(d && d.entries), w: num(d && d.water), n: typeof (d && d.note) === "string" ? d.note : "" });
  /* Deleted entries: a day row carries {key: fingerprint} of the entries its phone deleted (or
     took a delete for), so a phone that sent one of them sees it was deleted, not missed. */
  const TOMB_MAX = 60;
  function readGone(d) {
    if (!isObj(d) || !isObj(d.gone)) return null;
    const out = {};
    let n = 0;
    for (const k of Object.keys(d.gone)) {
      if (n >= TOMB_MAX * 2) break;
      const v = d.gone[k];
      if (typeof k === "string" && k.length <= 80 && /^[i#]/.test(k) && typeof v === "string" && v.length <= 40 && !isBadKey(k)) { out[k] = v; n++; }
    }
    return n ? out : null;
  }
  function capTomb(T) {
    const ks = Object.keys(T);
    if (ks.length > TOMB_MAX) ks.slice(0, ks.length - TOMB_MAX).forEach(k => { delete T[k]; });
    return T;
  }
  /* What goes up with a day: every entry this phone knew (agreed, sent, or deleted before) that
     it no longer has. */
  function tombsFor(key, rec) {
    if (st.hashes[key] === undefined) return {};   /* a day this phone doesn't track: nothing it knew */
    const have = new Set((Array.isArray(rec && rec.entries) ? rec.entries : []).filter(isObj).map(lineKey));
    const out = {};
    const add = E => { if (isObj(E)) Object.keys(E).forEach(k => { if (!have.has(k) && typeof E[k] === "string") out[k] = E[k]; }); };
    add(st.tomb[key]);
    const b = st.base[key]; if (isObj(b) && b.d === 1) add(b.e);
    const sn = st.sent[key]; if (isObj(sn)) add(sn.e);
    return capTomb(out);
  }
  let cutC = { at: 0, v: "" };
  function cutoffDate() {
    const t = now();
    if (t - cutC.at < 60000 && cutC.v) return cutC.v;
    let v = "";
    try { if (typeof M.addDays === "function" && typeof M.today === "function") v = String(M.addDays(M.today(), -BASE_DAYS)); } catch (e) { v = ""; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) v = new Date(t - BASE_DAYS * DAY_MS).toISOString().slice(0, 10);
    cutC = { at: t, v };
    return v;
  }
  const dateOfId = id => id.slice(id.indexOf("|") + 1);
  const recentDay = id => dateOfId(id) >= cutoffDate();
  function pruneBase() {
    const cut = cutoffDate();
    /* a {d: 0} mark (sent, not agreed yet) stays until that day comes back from the cloud */
    Object.keys(st.base).forEach(k => { if (kindOf(k) === "day" && dateOfId(idOf(k)) < cut && !(isObj(st.base[k]) && st.base[k].d === 0)) delete st.base[k]; });
    Object.keys(st.tomb).forEach(k => { if (dateOfId(idOf(k)) < cut) delete st.tomb[k]; });
  }
  /* Their copy was built on our last push: it holds an entry version that went up for the
     first time in that push (a day row goes up whole, so they read all of it). */
  function seenPush(S, theirs) {
    if (!S || !isObj(S.e) || !isObj(S.f)) return false;
    return (Array.isArray(theirs) ? theirs : []).some(x => { if (!isObj(x)) return false; const k = lineKey(x); return S.f[k] === 1 && has(S.e, k) && eh(x) === S.e[k]; });
  }
  /* What this phone sent of a day: entry fingerprints, water, note, and which entries went up
     for the first time (not in the agreed copy or in the push before). */
  function sentDay(d, B, prev) {
    const sb = dayBase(d), f = {};
    /* with no agreed copy we can't tell what the other phone already had: nothing counts as new */
    if (B) Object.keys(sb.e).forEach(k => { if (B[k] !== sb.e[k] && !(prev && isObj(prev.e) && prev.e[k] === sb.e[k])) f[k] = 1; });
    return { e: sb.e, w: sb.w, n: sb.n, f };
  }
  /* Two copies of one diary day become one: entries by id, water and note on their own. */
  function mergeDay(b, S, mine, theirs, X, T) {
    const B = isObj(b) && isObj(b.e) ? b.e : null;
    const seen = seenPush(S, theirs.entries);
    const entries = mergeList(B, S, seen, mine.entries, theirs.entries, true, X, T);
    const field = (k, bv, sv, blank) => {
      const m = mine[k], t = theirs[k], cm = canon(m), ct = canon(t);
      if (cm === ct) return m;
      if (!B && !(S && (seen || ct === canon(sv)))) { if (blank(m)) return t; if (blank(t)) return m; }   /* a day just made on one side */
      const w = pick3(B ? canon(bv) : null, S ? canon(sv) : undefined, !!S, cm, ct, () => theirsWin(0, 0, m, t));
      return w === "t" ? t : m;
    };
    const out = Object.assign({}, mine, { id: mine.id, pid: mine.pid, date: mine.date });
    delete out.gone;          /* a delete list an older build kept in the day never stays in the diary */
    out.entries = cpy(entries);
    out.water = field("water", B ? b.w : 0, S ? S.w : 0, v => !num(v));
    out.note = field("note", B ? b.n : "", S ? S.n : "", v => !v);
    const body = d => { const o = Object.assign({}, d); delete o.updatedAt; delete o.gone; return canon(o); };
    const ob = body(out);
    if (ob === body(theirs)) return theirs;
    if (ob === body(mine)) return mine;
    out.updatedAt = Math.max(num(mine.updatedAt), num(theirs.updatedAt));
    return out;
  }
  /* Foods: the numbers belong together, so they all come from one side. Meals: items by id,
     the batch's cooked weight and unit on their own; then per and the batch's raw weight are
     worked out again from the merged items (never merged as numbers). */
  const FOOD_NUMS = ["serving", "per", "per100g", "alts", "cook"];
  /* sm, stt: the two copies' edit stamps in server time (a phone with a fast clock can't win
     with an edit it made earlier): ours from our clock, theirs as their row says (both phones
     see the same two numbers for the same two copies) */
  function mergeRec(kind, base, sent, mine, theirs, sm, stt) {
    sent = isObj(sent) ? sent : null;
    const tw = (m, t) => theirsWin(sm, stt, m, t);
    const out = merge3(base, mine, theirs, sent, tw);
    /* the stamps: the newer one */
    ["u", "updatedAt"].forEach(k => { if (mine[k] !== undefined || theirs[k] !== undefined) out[k] = Math.max(num(mine[k]), num(theirs[k])); });
    if (kind === "food") {
      const g = o => canon(FOOD_NUMS.map(k => (o[k] === undefined ? null : o[k])));
      const w = pick3(g(base), sent ? g(sent) : undefined, !!sent, g(mine), g(theirs), () => tw(FOOD_NUMS.map(k => mine[k]), FOOD_NUMS.map(k => theirs[k])));
      const src = w === "t" ? theirs : mine;
      FOOD_NUMS.forEach(k => { if (src[k] === undefined) delete out[k]; else out[k] = cpy(src[k]); });
    } else if (kind === "meal") {
      out.items = cpy(mergeList(listBase(base.items), sent ? { e: listBase(sent.items) } : null, false, mine.items, theirs.items, false));
      const bp = o => (isObj(o && o.batch) ? { cookedG: o.batch.cookedG, unit: o.batch.unit } : {});
      const bf = merge3(bp(base), bp(mine), bp(theirs), sent ? bp(sent) : null, tw);
      if (num(bf.cookedG) > 0) {
        const batch = Object.assign({}, isObj(out.batch) ? out.batch : {}, { cookedG: bf.cookedG });
        if (bf.unit !== undefined) batch.unit = bf.unit; else delete batch.unit;
        try { if (M.cook && typeof M.cook.rawTotal === "function") batch.rawG = M.cook.rawTotal(out.items); } catch (e) {}
        out.batch = batch; out.servingsMade = 1;
      } else delete out.batch;
      try { if (M.meals && typeof M.meals.computePer === "function") out.per = M.meals.computePer(out); } catch (e) {}
    }
    /* the same as one side (stamps aside): exactly that side's copy, so nothing echoes back */
    const body = o => { const x = Object.assign({}, o); delete x.u; delete x.updatedAt; return canon(x); };
    const ob = body(out);
    if (ob === body(theirs)) return cpy(theirs);
    if (ob === body(mine)) return cpy(mine);
    return out;
  }
  /* This phone's own person (its first one): their diary never leaves this phone. */
  function homePid() {
    if (okPid(st.home)) return st.home;
    return st.tp && Array.isArray(st.tp.pids) && okPid(st.tp.pids[0]) ? st.tp.pids[0] : null;
  }
  const lcs = s => String(s == null ? "" : s).trim().toLowerCase();
  const digits = s => String(s == null ? "" : s).replace(/\D/g, "").replace(/^0+/, "");
  const itemsSig = items => (Array.isArray(items) ? items : []).map(it => lcs(it && it.name) + "x" + num(it && it.servings, 1)).sort().join(";");
  /* First join: the same food or meal made on both phones before sync was on becomes one. */
  function findDup(kind, id, data, coll) {
    for (const lid of Object.keys(coll)) {
      if (lid === id || st.hashes[kind + "|" + lid] !== undefined) continue;
      const x = coll[lid];
      if (!isObj(x)) continue;
      if (kind === "food") {
        const bc = digits(data.barcode);
        if ((bc && digits(x.barcode) === bc) || (lcs(x.name) === lcs(data.name) && lcs(x.brand) === lcs(data.brand))) return lid;
      } else if (lcs(x.name) === lcs(data.name) && itemsSig(x.items) === itemsSig(data.items)) return lid;
    }
    return null;
  }
  function remap(kind, from, to) {
    const MS = M.MS, field = kind === "food" ? "foodId" : "mealId";
    Object.keys(isObj(MS.days) ? MS.days : {}).forEach(did => {
      const d = MS.days[did];
      if (!isObj(d) || !Array.isArray(d.entries)) return;
      let hit = false;
      d.entries.forEach(e => { if (isObj(e) && e[field] === from) { e[field] = to; hit = true; } });
      if (hit) { markDirty("day", did); if (wcache) wcache.delete(d); }
    });
    if (kind === "food") Object.keys(isObj(MS.meals) ? MS.meals : {}).forEach(mid => {
      const m = MS.meals[mid];
      if (isObj(m) && Array.isArray(m.items)) m.items.forEach(it => { if (isObj(it) && it.foodId === from) it.foodId = to; });
    });
  }
  /* How many days of this person's diary (with food logged) this phone made itself and hasn't
     synced yet (days that just came down from the cloud don't count). */
  function usedDays(pid) {
    const days = isObj(M.MS) && isObj(M.MS.days) ? M.MS.days : {};
    let n = 0;
    for (const id of Object.keys(days)) {
      const d = days[id];
      if (id.indexOf(pid + "|") === 0 && st.hashes["day|" + id] === undefined && isObj(d) && Array.isArray(d.entries) && d.entries.length && ++n >= 3) break;
    }
    return n;
  }
  function applyRow(r, ch) {
    if (!isObj(r)) return;
    if (r.household != null && r.household !== st.code) return;     /* never another household's row */
    const kind = String(r.kind || ""), id = r.id == null ? "" : String(r.id);
    if (!validId(kind, id)) return;
    const key = kind + "|" + id;
    if (kind === "meta") { applyMeta(r, id); return; }
    if (kind === "train") { noteTrain(r); return; }
    const cn = COLL[kind];
    if (!cn) return;
    const MS = M.MS;
    if (!isObj(MS)) return;
    if (!isObj(MS[cn])) MS[cn] = {};
    const coll = MS[cn];
    const local = has(coll, id) && isObj(coll[id]) ? coll[id] : undefined;
    const synced = st.hashes[key];
    /* the other person's diary and weigh-ins stay in the cloud */
    /* (the person picker is open: the phone's own person counts) */
    if ((kind === "day" || kind === "body") && local === undefined && synced === undefined && pidOfId(id) !== (curPid() || homePid()) && !keepAll) return;
    if (r.deleted === true || r.deleted === "true") {
      if (local === undefined) { forget(key); return; }
      /* a delete wins over a copy nobody touched here since the last sync, and (first join,
         nothing agreed yet) over a copy older than the delete */
      if ((synced !== undefined && hashRec(key, local) === synced) || (synced === undefined && remoteTime(r) > srvTime(localTime(kind, local)))) {
        delete coll[id]; forget(key); markDirty(kind, id); ch.applied++;
      }
      return;
    }
    const data = clean(kind, id, r.data);
    if (!data) return;                              /* can't be repaired: ours stays */
    const X = kind === "day" && local !== undefined && synced !== undefined ? readGone(r.data) : null;
    if (X) st.tomb[key] = capTomb(Object.assign({}, isObj(st.tomb[key]) ? st.tomb[key] : {}, X));   /* passed on in our own pushes of this day */
    const up = upData(kind, data), rh = H(up), remoteAt = remoteTime(r);
    const take = rec => { coll[id] = rec; agree(key, kind, data, rh); rcache.delete(key); delete st.gone[key]; markDirty(kind, id); ch.applied++; };
    if (local !== undefined) {
      const lh = hashRec(key, local);
      if (lh === rh) { agree(key, kind, data, rh); return; }
      if (synced !== undefined && rh === synced) return;               /* nothing new in the cloud */
      if (kind === "day") {
        /* Never one whole day over the other: entries from both phones are kept, a delete
           sticks, and an entry changed on both takes the newer edit. The cloud copy replaced
           our last push when ours hasn't changed since, so it counts as the newer one. */
        let b = isObj(st.base[key]) && st.base[key].d === 1 ? st.base[key] : null;
        /* No base kept (a phone that synced before bases were kept, or a day older than the
           base window) and nothing changed here since both phones agreed: this copy IS that
           base, so the other phone's deletes stick. Not after our own push without a base
           ({d: 0}): the other phone may never have seen what we sent. */
        if (!b && !has(st.base, key) && synced !== undefined && lh === synced) b = dayBase(local);
        /* What we last sent. Unchanged here since then (a phone from before this was kept):
           our copy is what we sent. */
        let S = synced !== undefined && isObj(st.sent[key]) && isObj(st.sent[key].e) ? st.sent[key] : null;
        if (!S && synced !== undefined && lh === synced) { const lb = dayBase(local); S = { e: lb.e, w: lb.w, n: lb.n, f: {} }; }
        const m = mergeDay(b, S, local, data, X, synced !== undefined && isObj(st.tomb[key]) ? st.tomb[key] : null);
        if (m === data) { take(data); return; }
        if (m !== local) { coll[id] = m; markDirty(kind, id); ch.applied++; }
        agree(key, kind, data, rh); rcache.delete(key);
        return;
      }
      if (kind === "profile") {
        const rs = num(data.setupAt) > 0, ls = num(local.setupAt) > 0;
        /* a profile nobody set up never replaces a real one; ours goes back up */
        if (!rs && ls) { delete st.hashes[key]; return; }
        /* a phone that never synced this person takes the profile the cloud already set up:
           a new phone's first-day setup must not overwrite real targets. A phone that has been
           this person's for a while (days of diary here) is no new phone: the newer edit wins. */
        if (synced === undefined && rs && !(ls && num(local.setupAt) < num(data.setupAt)) && !(ls && usedDays(id) >= 3)) { take(data); return; }
      }
      if (synced !== undefined && lh === synced) {
        /* Unchanged here since our last push. If that push carried edits the other phone hadn't
           seen yet (the copy we both last agreed on differs), its own push may have raced ours:
           merge field by field against that copy instead of losing our edits. The cloud copy was
           written after our push (it replaced it), so on a field both changed, it wins. */
        const b = st.base[key];
        if ((kind === "food" || kind === "meal") && isObj(b) && H(b) !== lh) {
          const sent = isObj(st.sent[key]) ? st.sent[key] : upData(kind, local);   /* unchanged since our push: ours is what we sent */
          const m = mergeRec(kind, b, sent, upData(kind, local), up, srvTime(recStamp(local)), remoteAt);
          coll[id] = keepLocal(kind, m, local); agree(key, kind, data, rh); rcache.delete(key); markDirty(kind, id); ch.applied++;
          return;
        }
        take(keepLocal(kind, up === data ? data : up, local)); return;
      }
      /* both sides changed since they last agreed */
      if (kind === "food" || kind === "meal") {
        if (isObj(st.base[key])) {
          const m = mergeRec(kind, st.base[key], synced !== undefined ? st.sent[key] : null, upData(kind, local), up, srvTime(recStamp(local)), remoteAt);
          coll[id] = keepLocal(kind, m, local); agree(key, kind, data, rh); rcache.delete(key); markDirty(kind, id); ch.applied++;
          return;
        }
        /* no copy both phones agreed on: the newer edit stamp, the same on both phones */
        const ul = upData(kind, local);
        if (theirsWin(srvTime(recStamp(ul)), remoteAt, ul, up)) take(keepLocal(kind, up === data ? data : up, local));
        return;
      }
      if (remoteAt > srvTime(localTime(kind, local))) take(keepLocal(kind, up === data ? data : up, local));
      return;
    }
    if (synced !== undefined) {
      /* deleted here since the last sync: only a newer edit from the other phone brings it back */
      if (rh !== synced && remoteAt > srvTime(num(st.gone[key], now()))) take(up === data ? data : up);
      return;
    }
    if (st.joining && (kind === "food" || kind === "meal")) {
      const dup = findDup(kind, id, data, coll);
      if (dup) {
        const old = coll[dup];
        delete coll[dup]; rcache.delete(kind + "|" + dup);
        take(keepLocal(kind, up === data ? data : up, old));
        remap(kind, dup, id);
        return;
      }
    }
    take(up === data ? data : up);
  }
  function applyMeta(r, id) {
    if (id !== "household") return;
    if (r.deleted === true) { closed(); return; }
    const d = isObj(r.data) ? scrub(r.data, 0) : null;
    if (!isObj(d)) return;
    st.meta = d; st.hashes["meta|household"] = H(d);
  }
  /* Write M.MS once through m-core's own save (its daily backup and storage-error
     reporting included) without scheduling a push. False when the phone is full. */
  function commitLocal() {
    const MS = M.MS;
    if (!isObj(MS)) return true;
    let ok = true;
    applying = true;
    try {
      if (typeof origSave === "function") {
        origSave.call(M);
        ok = !(M.storage && M.storage.ok === false);
      } else {
        MS.updatedAt = now();
        ok = lsSet(M.KEY || "chalk.macros.v1", JSON.stringify(MS));
        try { if (M.sync && typeof M.sync.push === "function") M.sync.push(); } catch (e) {}
      }
    } catch (e) { ok = false; }
    applying = false;
    unsaved = !ok;
    return ok;
  }
  let renderWait = false;
  function doRerender() {
    try {
      if (M.ui && typeof M.ui.rerender === "function") M.ui.rerender();
      else if (typeof render === "function") render();
    } catch (e) {}
  }
  /* Re-render, but never while someone is typing in the page (that would drop the keyboard). */
  function safeRerender() {
    try {
      if (typeof document !== "undefined" && document) {
        const a = document.activeElement, app = typeof document.getElementById === "function" ? document.getElementById("app") : null;
        if (a && app && a !== document.body && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName || "") && app.contains(a)) {
          if (!renderWait && typeof a.addEventListener === "function") {
            renderWait = true;
            a.addEventListener("blur", () => { renderWait = false; setTimeout(doRerender, 0); }, { once: true });
          }
          return;
        }
      }
    } catch (e) {}
    doRerender();
  }
  /* Keyset paging on updated_at. One upsert = one updated_at for all its rows, so when a full
     page ends inside such a group, the whole group is read by that one timestamp (offset
     pages, ordered by kind and id) before the cursor moves past it. */
  async function pages(gen, filter, from, onRows) {
    let cursor = from;
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await getRows(filter + "&updated_at=gt." + encodeURIComponent(cursor) + "&order=updated_at.asc,kind.asc,id.asc&limit=" + PAGE);
      if (gen !== epoch) return null;
      if (!Array.isArray(rows)) throw { code: "bad" };
      if (rows.length < PAGE) { if (!onRows(rows, maxTs(rows, ""))) return null; return cursor; }
      const T = rows[rows.length - 1] && rows[rows.length - 1].updated_at;
      if (typeof T !== "string" || !okTs(T)) {
        /* can't page past a time we can't read: keep what came and stop for now */
        onRows(rows, maxTs(rows, ""));
        return null;
      }
      if (!onRows(rows.filter(r => !r || r.updated_at !== T), "")) return null;
      for (let off = 0; off < PAGE * MAX_PAGES; off += PAGE) {
        const grp = await getRows(filter + "&updated_at=eq." + encodeURIComponent(T) + "&order=kind.asc,id.asc&limit=" + PAGE + "&offset=" + off);
        if (gen !== epoch) return null;
        if (!Array.isArray(grp)) throw { code: "bad" };
        const last = grp.length < PAGE;
        if (!onRows(grp, last ? T : "")) return null;
        if (last) break;
      }
      cursor = T;
    }
    return cursor;
  }
  function applier(gen, ch, moveCursor) {
    return (rows, cur) => {
      const before = ch.applied;
      for (const r of rows) {
        if (gen !== epoch) return false;
        try { applyRow(r, ch); } catch (e) {}
      }
      if (gen !== epoch) return false;
      /* Local data first, then the sync state that describes it — never the other way round,
         so a phone killed mid-pull never thinks it holds data it didn't save. */
      if ((ch.applied > before || unsaved) && !commitLocal()) throw { code: "storage" };
      if (moveCursor && cur && okTs(cur) && (!st.cursor || later(cur, st.cursor))) { st.cursor = cur; st.cursorAt = now(); }
      saveSt();
      return true;
    };
  }
  /* The last 10 s before the cursor are read again until a pull made a minute after the
     cursor moved has read them (a late row has committed by then); after that, an idle sync
     reads nothing again (not a whole big upload, every time). */
  const SETTLE_MS = 60000;
  async function pull(gen) {
    const ch = { applied: 0 };
    const c0 = st.cursor, t0 = now();
    const settled = !!c0 && st.ov === c0;
    try { await pages(gen, "", c0 ? (settled ? c0 : back(c0, OVERLAP_MS)) : EPOCH, applier(gen, ch, true)); }
    finally { if (ch.applied && gen === epoch) safeRerender(); }
    if (gen === epoch && c0 && st.cursor === c0 && !settled && Math.abs(t0 - num(st.cursorAt)) >= SETTLE_MS) st.ov = c0;
    return ch.applied;
  }
  /* This phone switched person: bring that person's diary and weigh-ins down. */
  async function catchUp(gen, pid) {
    const ch = { applied: 0 };
    try { await pages(gen, "&kind=in.(day,body)&id=like." + encodeURIComponent(pid + "|") + "*", EPOCH, applier(gen, ch, false)); }
    finally { if (ch.applied && gen === epoch) safeRerender(); }
    if (gen !== epoch) return 0;
    st.pp = pid;
    saveSt();
    return ch.applied;
  }
  /* Before the cloud copy goes away (Delete cloud copy, Change code), this phone takes back every
     diary day and weigh-in it doesn't hold: the other person's, or its own after a switch of
     person. Then nothing lives only in the cloud. */
  let keepAll = false;
  async function takeAll(gen) {
    const ch = { applied: 0 };
    keepAll = true;
    try { await pages(gen, "&kind=in.(day,body)", EPOCH, applier(gen, ch, false)); }
    finally { keepAll = false; if (ch.applied && gen === epoch) safeRerender(); }
    return ch.applied;
  }
  /* Each phone keeps only its own person's diary days and weigh-ins. The other person's rows
     that already match the cloud leave this phone (they stay in the cloud, and switching
     person pulls them back); rows changed here go up first. Their sync memory is written
     away BEFORE the rows go, so a phone killed in between sends them again (harmless) and
     never reads them as deleted. */
  function trimOther(pid) {
    const MS = M.MS;
    if (!okPid(pid) || !isObj(MS) || unsaved) return 0;
    const drop = [];
    ["day", "body"].forEach(kind => {
      const coll = MS[COLL[kind]];
      if (!isObj(coll)) return;
      Object.keys(coll).forEach(id => {
        if (!validId(kind, id) || pidOfId(id) === pid) return;
        const key = kind + "|" + id, rec = coll[id], h = st.hashes[key];
        if (h !== undefined && isObj(rec) && hashRec(key, rec) === h) drop.push({ kind, id, key, h });
      });
    });
    if (!drop.length) return 0;
    drop.forEach(x => { delete st.hashes[x.key]; delete st.base[x.key]; delete st.sent[x.key]; delete st.tomb[x.key]; });
    if (!lsSet(ST_KEY, JSON.stringify(st))) { drop.forEach(x => { st.hashes[x.key] = x.h; }); return 0; }
    drop.forEach(x => { delete MS[COLL[x.kind]][x.id]; rcache.delete(x.key); markDirty(x.kind, x.id); });
    commitLocal();
    return drop.length;
  }

  /* ------------------------------------------------ records lost on this phone */
  /* Records that vanish from this phone without the app deleting them (a damaged save that fell
     back to the daily backup copy, storage cleared, a bug) must never go up as deletes: that
     would empty the cloud copy and delete them on the other phone too. The app never deletes a
     diary day or a profile, and people delete foods, meals and weigh-ins one at a time. So when
     records go missing like that, this phone forgets what it knew about them and reads the
     whole household again; for each record the newest copy wins, and nothing is deleted. */
  const LOST_MANY = 10;
  let lostChecked = false;   /* the "damaged save" check runs once per page load */
  function guardLost() {
    const MS = M.MS;
    if (!isObj(MS) || !st.code) return false;
    let keys = [];
    if (!lostChecked) {
      lostChecked = true;
      const s = M.storage;
      /* m-core read the backup copy (or nothing): every record here may be older than the cloud's */
      if (isObj(s) && (s.restoredFrom || (Array.isArray(s.damaged) && s.damaged.length))) keys = Object.keys(st.hashes).filter(k => !!COLL[kindOf(k)]);
    }
    if (!keys.length) {
      const lost = Object.keys(st.hashes).filter(key => {
        const cn = COLL[kindOf(key)];
        if (!cn) return false;
        const coll = MS[cn], id = idOf(key);
        return !(isObj(coll) && has(coll, id) && isObj(coll[id]));
      });
      /* deletes noticed one by one (st.gone) were real; most of a kind vanishing at once was not */
      const fresh = lost.filter(k => !st.gone[k]);
      const crowd = Object.keys(COLL).some(kind => {
        const n = fresh.filter(k => kindOf(k) === kind).length;
        return n >= LOST_MANY && n * 2 >= Object.keys(st.hashes).filter(k => kindOf(k) === kind).length;
      });
      if (lost.some(k => kindOf(k) === "day" || kindOf(k) === "profile") || crowd)
        keys = lost.filter(k => kindOf(k) === "day" || kindOf(k) === "profile" || !st.gone[k]);
    }
    if (!keys.length) return false;
    keys.forEach(forget);
    st.cursor = "";           /* read everything again: the lost records come back */
    saveSt(true);                 /* at once: a restart must not find the old memory again */
    return true;
  }

  /* ------------------------------------------------------------------ push */
  function due(b, opts) { return !!(opts && opts.manual) || now() - num(b.at) > (b.k === "aside" ? ASIDE_AGAIN : REFUSED_AGAIN); }
  function scan(opts) {
    const out = { changed: [], removed: [], stuck: 0 };
    const MS = M.MS;
    if (!isObj(MS)) return out;
    guardLost();
    const seen = new Set();
    Object.keys(COLL).forEach(kind => {
      const coll = MS[COLL[kind]];
      if (!isObj(coll)) return;
      Object.keys(coll).forEach(id => {
        const rec = coll[id];
        if (!validId(kind, id) || !isObj(rec)) return;
        const key = kind + "|" + id;
        if (kind === "day" && st.hashes[key] === undefined && blankDay(rec)) return;   /* a day someone only looked at */
        if (kind === "profile" && st.hashes[key] === undefined && !(num(rec.setupAt) > 0)) return;   /* defaults nobody set up stay here */
        seen.add(key);
        if (st.gone[key]) delete st.gone[key];
        const h = hashRec(key, rec);
        if (!h || h === st.hashes[key]) return;
        const b = st.bad[key];
        if (b && b.h === h && !due(b, opts)) { out.stuck++; return; }
        out.changed.push({ kind, id, key, rec, h });
      });
    });
    const t = now();
    Object.keys(st.hashes).forEach(key => {
      if (!COLL[kindOf(key)] || seen.has(key)) return;
      if (!st.gone[key]) st.gone[key] = t;
      out.removed.push(key);
    });
    return out;
  }
  function makeItem(kind, id, data, deleted, at, key, h, ok) {
    const row = { household: st.code, kind, id, data, deleted: !!deleted, client_updated: Math.max(0, Math.round(srvTime(num(at)))), device: st.device };
    let s = "";
    try { s = noKey(JSON.stringify(row)); } catch (e) { s = ""; }
    return { kind, key, h, s, bytes: s ? bytesOf(s) : 0, ok };
  }
  function trainItem(opts, out) {
    const tl = trainLocal();
    if (!tl) { hold = null; return null; }
    const key = "train|" + tl.id;
    if (!trainOwner(tl)) { hold = { id: tl.id, missing: 0, why: "switched" }; return null; }
    if (tl.h === st.hashes[key]) { hold = null; return null; }
    const seen = st.train[tl.id];
    if (seen && !seen.del && seen.h === tl.h) { st.hashes[key] = tl.h; hold = null; return null; }
    /* This phone's first person is its home person; anyone else only borrowed it. */
    const home = !!(st.tp && st.tp.pids && st.tp.pids[0] === tl.id);
    /* The cloud copy came from another phone. Never overwrite workouts this phone doesn't have
       (a fresh phone would wipe the backup it's meant to restore from) — unless that copy was
       made on a borrowed phone and this is the person's own phone, with workouts of its own. */
    if (seen && !seen.del && seen.h !== st.hashes[key]) {
      const miss = missingCount(seen, tl);
      if (miss > 0 && !(seen.guest && home && tl.n > 0)) { hold = { id: tl.id, missing: miss, why: "missing" }; return null; }
    }
    hold = null;
    const b = st.bad[key];
    if (b && b.h === tl.h && !due(b, opts)) { if (out) out.stuck++; return null; }
    if (!opts.manual && tl.busy && now() - num(st.trainAt) < TRAIN_GAP) return null;
    return makeItem("train", tl.id, home ? { v: 1, json: tl.raw } : { v: 1, json: tl.raw, guest: true }, false, tl.updated || now(), key, tl.h, () => {
      st.hashes[key] = tl.h; st.trainAt = now();
      st.train[tl.id] = { h: tl.h, t: tl.updated, at: "", n: tl.n, last: tl.last, ids: tl.ids, del: false, dev: st.device, guest: !home };
    });
  }
  function metaItem() {
    if (!isObj(st.meta)) return null;
    const key = "meta|household", h = H(st.meta);
    if (h === st.hashes[key]) return null;
    return makeItem("meta", "household", st.meta, false, num(st.meta.createdAt) || now(), key, h, () => { st.hashes[key] = h; });
  }
  function collect(opts) {
    opts = opts || {};
    const snap = scan(opts), items = [];
    snap.changed.forEach(it => {
      let data = upData(it.kind, it.rec), tomb = null;
      if (it.kind === "day") { tomb = tombsFor(it.key, it.rec); if (Object.keys(tomb).length) data = Object.assign({}, data, { gone: tomb }); else tomb = null; }
      const x = makeItem(it.kind, it.id, data, false, localTime(it.kind, it.rec), it.key, it.h, () => {
        st.hashes[it.key] = it.h; delete st.gone[it.key];
        /* The merge base stays the copy both phones last agreed on until ours comes back in a
           pull; what we sent is kept beside it, so the other phone's copy built on our push
           counts from there (a delete or edit made here right after it sticks). */
        let sent = null;
        try { sent = JSON.parse(x.s).data; } catch (e) { sent = null; }
        if (it.kind === "food" || it.kind === "meal") {
          if (!isObj(st.base[it.key]) && isObj(sent)) st.base[it.key] = sent;
          if (isObj(sent)) st.sent[it.key] = sent; else delete st.sent[it.key];
        } else if (it.kind === "day") {
          /* a day sent with no base: mark it, so what we sent never counts as agreed */
          if (!isObj(st.base[it.key])) st.base[it.key] = { d: 0 };
          const bb = st.base[it.key].d === 1 && isObj(st.base[it.key].e) ? st.base[it.key].e : null;
          if (isObj(sent)) st.sent[it.key] = sentDay(sent, bb, st.sent[it.key]); else delete st.sent[it.key];
          if (tomb) st.tomb[it.key] = tomb; else delete st.tomb[it.key];
        }
      });
      items.push(x);
    });
    snap.removed.forEach(key => items.push(makeItem(kindOf(key), idOf(key), {}, true, st.gone[key] || now(), key, "",
      () => { forget(key); })));
    const m = metaItem(); if (m) items.push(m);
    const tr = trainItem(opts, snap); if (tr) items.push(tr);
    items.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
    return { items, stuck: snap.stuck };
  }
  const dirtyLocal = () => { try { return collect({}).items.length > 0; } catch (e) { return false; } };
  const stuckKeys = () => Object.keys(st.bad);
  function stuckLine() {
    const b = stuckKeys().map(k => st.bad[k]);
    if (!b.length) return "";
    const n = b.length, one = n === 1;
    const big = b.every(x => x && x.s === 413);
    return (one ? "1 item isn't" : n + " items aren't") + " backed up" + (big ? (one ? ". It's too big." : ". They're too big.") : " yet. We'll keep trying.");
  }
  function classify(e) {
    if (e && e.code === "http") {
      const s = e.status;
      if (s === 400 || s === 413 || s === 422) return "refuse";   /* this row, as it is, will never go in */
      if (s === 409 || s >= 500) return "retry";                  /* maybe this row, maybe the server */
      return "fatal";                                             /* 401 / 403 / 404 / 429: stop, try later */
    }
    if (e && e.code === "net" && e.message === "timeout" && !offline()) return "retry";
    return "fatal";
  }
  async function post(ch, gen) {
    budget++;
    try { await request("POST", upsertURL(), "[" + ch.map(x => x.s).join(",") + "]", st.code, PREFER); }
    catch (e) { return e || { code: "net" }; }
    if (gen !== epoch) return null;
    ch.forEach(x => { try { x.ok(); } catch (e) {} delete st.fail[x.key]; delete st.bad[x.key]; sentOk.add(x.key); });
    pendingN = Math.max(0, pendingN - ch.length);
    postOk = true;
    saveSt();
    return null;
  }
  function setBad(x, e, k) { st.bad[x.key] = { h: x.h, at: now(), s: e && e.status ? e.status : 0, k }; delete st.fail[x.key]; }
  function bumpFail(ch, e) {
    ch.forEach(x => { const f = st.fail[x.key]; st.fail[x.key] = { h: x.h, n: f && f.h === x.h ? num(f.n) + 1 : 1, at: now(), s: e && e.status ? e.status : 0 }; });
  }
  const maxFail = ch => ch.reduce((m, x) => { const f = st.fail[x.key]; return Math.max(m, f && f.h === x.h ? num(f.n) : 0); }, 0);
  /* Does the server take a write at all right now? Send our own household row again (same
     data, harmless). If even that fails, it's an outage, not a bad row. */
  async function takesWrites(gen) {
    if (!isObj(st.meta) || budget > BISECT_BUDGET) return false;
    const it = makeItem("meta", "household", st.meta, false, num(st.meta.createdAt) || now(), "meta|household", H(st.meta), () => {});
    budget++;
    try { await request("POST", upsertURL(), "[" + it.s + "]", st.code, PREFER); } catch (e2) { return false; }
    return gen === epoch;
  }
  /* The server refused a request: find the rows it refuses and set them aside. */
  async function refuse(ch, e, gen) {
    if (ch.length === 1) { setBad(ch[0], e, "refused"); saveSt(); return; }
    for (const x of ch) {
      const e2 = await post([x], gen);
      if (gen !== epoch) return;
      if (!e2) continue;
      const c = classify(e2);
      if (c === "fatal") throw e2;
      if (c === "refuse") setBad(x, e2, "refused"); else bumpFail([x], e2);
    }
    saveSt();
  }
  /* A chunk failed twice (409 / 5xx / timeout): halve it until the row that keeps failing is
     found, and set that row aside. Both halves go first, then the failing ones are split
     again. A row is only set aside once something else got in during this sync (so the fault
     is that row, not the server) or after it failed three times on its own. */
  async function bisect(ch, gen, e) {
    if (ch.length === 1) {
      /* nothing else got in this sync: only blame the row if the server takes a write */
      if (!postOk && !(await takesWrites(gen))) throw e;
      if (gen !== epoch) return;
      setBad(ch[0], e, "aside"); saveSt(); return;
    }
    const mid = Math.ceil(ch.length / 2), parts = [ch.slice(0, mid), ch.slice(mid)], bad = [];
    for (const p of parts) {
      if (budget > BISECT_BUDGET) throw e;
      const e2 = await post(p, gen);
      if (gen !== epoch) return;
      if (!e2) continue;
      const c = classify(e2);
      if (c === "fatal") throw e2;
      if (c === "refuse") { await refuse(p, e2, gen); if (gen !== epoch) return; }
      else bad.push({ p, e2 });
    }
    /* both halves failed and nothing got in: that's the server, not a row (unless it's the
       same few rows, sync after sync) */
    if (bad.length === 2 && !postOk && !(ch.length <= 4 && maxFail(ch) >= 3)) throw e;
    for (const b of bad) { await bisect(b.p, gen, b.e2); if (gen !== epoch) return; }
  }
  /* Training goes alone; rows that failed before go in their own chunks, after the rest. */
  function chunkify(list) {
    const out = [];
    let ch = [], size = 0;
    for (const x of list) {
      if (ch.length && (ch.length >= CHUNK_ROWS || size + x.bytes > CHUNK_BYTES || x.kind === "train" || ch[0].kind === "train" || !!x.f !== !!ch[0].f)) { out.push(ch); ch = []; size = 0; }
      ch.push(x); size += x.bytes;
    }
    if (ch.length) out.push(ch);
    return out;
  }
  async function push(gen, opts) {
    const got = collect(opts);
    const send = [], again = [];
    let big = 0;
    got.items.forEach(x => {
      if (!x.s) return;
      if (x.bytes > MAX_ROW_BYTES) { setBad(x, { status: 413 }, "refused"); big++; return; }
      const b = st.bad[x.key], f = st.fail[x.key];
      x.f = !!(f && f.h === x.h);
      (b && b.h === x.h ? again : send).push(x);
    });
    send.sort((a, b) => (a.f ? 1 : 0) - (b.f ? 1 : 0));   /* stable: kind order kept within each group */
    pendingN = send.length + again.length + got.stuck + big;
    postOk = false; budget = 0; sentOk = new Set();
    if (!send.length && !again.length) return 0;
    const failed = [];
    let firstErr = null;
    for (const ch of chunkify(send)) {
      const e = await post(ch, gen);
      if (gen !== epoch) return 0;
      if (!e) continue;
      const c = classify(e);
      if (c === "fatal") throw e;
      if (c === "refuse") { await refuse(ch, e, gen); if (gen !== epoch) return 0; continue; }
      bumpFail(ch, e); failed.push({ ch, e });
      if (!firstErr) firstErr = e;
      if (!postOk && failed.length >= 2) break;    /* nothing gets in: the server, not a row */
    }
    for (const f of failed) { if (maxFail(f.ch) >= 2) await bisect(f.ch, gen, f.e); if (gen !== epoch) return 0; }
    /* rows set aside earlier go last, one by one, so they can never hold up the rest */
    for (const x of again) {
      const e = await post([x], gen);
      if (gen !== epoch) return 0;
      if (!e) continue;
      const c = classify(e);
      if (c === "fatal") throw e;
      setBad(x, e, c === "refuse" ? "refused" : "aside");
    }
    saveSt();
    if (failed.length) {
      const left = failed.some(f => f.ch.some(x => !sentOk.has(x.key) && !(st.bad[x.key] && st.bad[x.key].h === x.h)));
      if (left || !postOk) throw firstErr;
    }
    return sentOk.size;
  }

  /* ------------------------------------------------ household checks + wipes */
  /* Before anything goes up: our row comes back with our code, a second write of it gets a
     newer server time (the updated_at trigger works: without it the other phone would never
     see an edit), and another code sees none of it. */
  async function selfTest(gen, write) {
    const code = st.code;
    const q = "?select=household,kind,id,deleted,updated_at&kind=eq.meta&id=eq.household&limit=5";
    const stamp = rows => { const r = Array.isArray(rows) ? rows.find(x => isObj(x) && x.household === code) : null; return r ? tsVal(r.updated_at) : NaN; };
    let mine = null;
    if (write) {
      if (!isObj(st.meta)) st.meta = { v: 1, createdAt: now(), by: st.device };
      const it = metaItem() || makeItem("meta", "household", st.meta, false, num(st.meta.createdAt) || now(), "meta|household", H(st.meta), () => {});
      await request("POST", upsertURL(), "[" + it.s + "]", code, PREFER);
      if (gen !== epoch) return false;
      const t1 = stamp(await request("GET", endpoint() + q, null, code));
      if (gen !== epoch) return false;
      await request("POST", upsertURL(), "[" + it.s + "]", code, PREFER);
      if (gen !== epoch) return false;
      mine = await request("GET", endpoint() + q, null, code);
      if (gen !== epoch) return false;
      const t2 = stamp(mine);
      if (!(t2 > t1)) throw { code: "setup" };
      try { it.ok(); } catch (e) {}
    } else {
      mine = await request("GET", endpoint() + q, null, code);
      if (gen !== epoch) return false;
    }
    if (!Array.isArray(mine) || !mine.some(r => isObj(r) && r.household === code)) throw { code: "setup" };
    const other = await request("GET", endpoint() + q, null, rand(20));
    if (gen !== epoch) return false;
    if (!Array.isArray(other) || other.some(r => isObj(r) && r.household === code)) throw { code: "unsafe" };
    st.verified = true; st.metaAt = now(); metaChecked = true;
    saveSt();
    return true;
  }
  /* Is the household still in the cloud? Gone → the cloud lost it: send everything again.
     Deleted → the other phone deleted it or changed the code: stop here. */
  async function checkMeta(gen) {
    const rows = await request("GET", endpoint() + "?select=household,kind,id,data,deleted&kind=eq.meta&id=eq.household&limit=5", null, st.code);
    if (gen !== epoch) return "";
    if (!Array.isArray(rows)) throw { code: "bad" };
    metaChecked = true;
    const r = rows.find(x => isObj(x) && x.household === st.code);
    if (r && r.deleted === true) { closed(); return "gone"; }
    if (!r) {
      st.hashes = {}; st.base = {}; st.sent = {}; st.tomb = {}; st.gone = {}; st.fail = {}; st.bad = {}; st.train = {}; st.cursor = "";
      rcache.clear();
      if (!isObj(st.meta)) st.meta = { v: 1, createdAt: now(), by: st.device };
      st.pp = curPid() || "";
    } else if (!isObj(st.meta) && isObj(r.data)) { st.meta = scrub(r.data, 0); st.hashes["meta|household"] = H(st.meta); }
    st.metaAt = now();
    saveSt(true);
    return "ok";
  }
  function closed() {
    try { commitLocal(); } catch (e) {}
    resetFor("");
    st.note = "Sync is off. The other phone deleted the cloud copy or changed the code. Everything is still on this phone.";
    saveSt(true); notify(); safeRerender();
  }
  /* Mark every row of a household deleted (row-level security allows no real deletes).
     The household row goes first, alone, so other phones stop before they see the rest. */
  async function wipeHousehold(code, why) {
    const t = now();
    const tomb = (kind, id, data) => JSON.stringify({ household: code, kind, id, data, deleted: true, client_updated: t, device: st.device });
    await request("POST", upsertURL(), "[" + tomb("meta", "household", { v: 1, gone: why, at: t }) + "]", code, PREFER);
    for (let pass = 0; pass < 2; pass++) {
      const keys = [];
      /* page by what came back: a server that caps pages below 1000 rows still gets every row */
      for (let off = 0; off < 1e6;) {
        const rows = await request("GET", endpoint() + "?select=household,kind,id&deleted=eq.false&order=kind.asc,id.asc&limit=1000&offset=" + off, null, code);
        if (!Array.isArray(rows)) throw { code: "bad" };
        rows.forEach(r => { if (isObj(r) && r.household === code && ORDER[r.kind] !== undefined && !(r.kind === "meta" && r.id === "household")) keys.push(tomb(String(r.kind), String(r.id), {})); });
        if (!rows.length) break;
        off += rows.length;
      }
      if (!keys.length) break;
      for (let i = 0; i < keys.length; i += CHUNK_ROWS) await request("POST", upsertURL(), "[" + keys.slice(i, i + CHUNK_ROWS).join(",") + "]", code, PREFER);
    }
  }
  let oldBusy = null;
  function finishOld() {
    if (oldBusy) return oldBusy;
    if (!configured() || !st.old.length) return Promise.resolve(true);
    oldBusy = (async () => {
      while (st.old.length) {
        const job = st.old[0];
        /* a moved household is cleared only once the new one holds everything */
        if (job.why === "moved" && !(isOn() && st.code !== job.code && st.lastSync > num(job.at))) return false;
        await wipeHousehold(job.code, job.why);
        st.old = st.old.filter(j => j !== job);
        saveSt(true);
      }
      return true;
    })().then(v => { oldBusy = null; return v; }, () => { oldBusy = null; return false; });
    return oldBusy;
  }

  /* ----------------------------------------------------------------- cycle */
  function notify() {
    try {
      if (typeof window !== "undefined" && window && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function")
        window.dispatchEvent(new CustomEvent("chalk-sync", { detail: M.cloud.status() }));
    } catch (e) {}
  }
  async function runCycle(opts) {
    const gen = epoch;
    const stopped = { ok: false, error: "Sync stopped." };
    if (!isOn()) return { ok: false, error: "Sync is off." };
    busy = true; badNote = ""; notify();
    deferSt++;
    try {
      if (!okPid(st.home) && st.tp && okPid(st.tp.pids[0])) st.home = st.tp.pids[0];   /* phones that joined before "home" was kept */
      const tested = !st.verified;
      if (tested) await selfTest(gen, !st.joining);
      if (gen !== epoch) return stopped;
      /* Is the household still there? Once per start and per day, and on every Sync now. */
      if (!tested && (!metaChecked || opts.manual || now() - num(st.metaAt) > META_EVERY)) {
        const m = await checkMeta(gen);
        if (m === "gone") return { ok: false, error: st.note };
        if (gen !== epoch) return stopped;
      }
      let applied = 0;
      guardLost();
      if (opts.pull !== false) {
        applied = await pull(gen);
        if (gen !== epoch) return isOn() ? stopped : { ok: false, error: st.note || "Sync stopped." };
        const p = curPid();
        if (p && p !== st.pp) { applied += await catchUp(gen, p); if (gen !== epoch) return stopped; }
        if (opts.all) { applied += await takeAll(gen); if (gen !== epoch) return stopped; }
        if (st.joining) st.joining = false;
      }
      const pushed = await push(gen, opts);
      if (gen !== epoch) return stopped;
      /* Only the phone's own (home) person's phone sheds a borrowed person's rows. The home
         person's diary never leaves their own phone, whoever is picked right now. */
      const who = curPid();
      if (who && who === st.pp && who === homePid() && !opts.all) trimOther(who);
      pruneBase();
      st.lastSync = now(); st.lastError = stuckLine() || badNote; retryN = 0; st.retryAt = 0;
      clearTimeout(retryT); retryT = null;
      if (!saveSt(true)) st.lastError = errText({ code: "storage" });
      if (st.old.length) finishOld();
      return { ok: true, applied, pushed };
    } catch (e) {
      if (gen !== epoch) return stopped;
      st.lastError = errText(e);
      try { pendingN = Math.max(pendingN, collect({}).items.length); } catch (x) {}
      saveSt(true);   /* skipped by saveSt itself while pulled data can't reach the disk */
      scheduleRetry(e);
      return { ok: false, error: st.lastError };
    } finally {
      deferSt = Math.max(0, deferSt - 1);
      if (!deferSt && stDirty) saveSt(true);
      busy = false;
      notify();
    }
  }
  function cycle(opts) {
    opts = opts || {};
    if (!isOn()) return Promise.resolve({ ok: false, error: configured() ? (st.note || "Sync is off.") : "Cloud sync isn't set up yet." });
    /* backing off after an error (or a Retry-After): background saves and ticks wait; Sync now,
       the retry timer, coming back online and opening the app go right away */
    if (!opts.manual && !EAGER[opts.reason] && now() < num(st.retryAt)) return Promise.resolve({ ok: false, error: st.lastError || "Waiting to try again." });
    if (inflight) {
      if (!queued) {
        const q = { opts: Object.assign({}, opts), p: null };
        queued = q;
        q.p = inflight.then(() => { if (queued === q) queued = null; return cycle(q.opts); });
      } else {
        if (opts.manual) queued.opts.manual = true;
        if (opts.all) queued.opts.all = true;
      }
      return queued.p;
    }
    inflight = runCycle(opts).then(r => { inflight = null; return r; }, e => { inflight = null; return { ok: false, error: errText(e) }; });
    return inflight;
  }
  function scheduleRetry(e) {
    if (!isOn()) return;
    clearTimeout(retryT);
    /* a browser often can't read Retry-After (not exposed): a 429 waits at least a minute anyway */
    const ms = Math.max(RETRY[Math.min(retryN, RETRY.length - 1)], num(e && e.retryAfter), e && e.status === 429 ? 60000 : 0);
    retryN++;
    st.retryAt = now() + ms;
    retryT = unref(setTimeout(() => { retryT = null; cycle({ reason: "retry" }); }, ms));
  }
  function schedule() {
    if (!isOn()) return;
    const t = Date.now(), delay = over.delay != null ? over.delay : SAVE_DELAY;
    if (!firstDirty) firstDirty = t;
    const dueAt = Math.min(t + delay, firstDirty + Math.max(delay, SAVE_MAX_WAIT));
    clearTimeout(saveT);
    /* saves that only touched this phone's own UI state (mode, tab) have nothing to send */
    saveT = unref(setTimeout(() => { saveT = null; firstDirty = 0; if (dirtyLocal()) cycle({ reason: "save" }); }, Math.max(0, dueAt - t)));
  }
  function stopTimers() {
    clearTimeout(saveT); saveT = null; firstDirty = 0;
    clearTimeout(retryT); retryT = null; retryN = 0;
    if (ticker) { clearInterval(ticker); ticker = null; }
  }
  function startTicker() {
    if (ticker || typeof setInterval !== "function") return;
    ticker = unref(setInterval(() => {
      try {
        if (!isOn() || retryT) return;
        if (typeof document !== "undefined" && document && document.visibilityState === "hidden") return;
        cycle({ reason: "tick" });
      } catch (e) {}
    }, TICK_MS));
  }
  let attached = false;
  function attach() {
    if (attached) return;
    attached = true;
    try {
      if (typeof document !== "undefined" && document && typeof document.addEventListener === "function")
        document.addEventListener("visibilitychange", () => {
          try {
            if (!isOn()) return;
            if (document.visibilityState === "hidden") { if (dirtyLocal()) cycle({ reason: "hide" }); }
            else cycle({ reason: "show" });
          } catch (e) {}
        });
    } catch (e) {}
    try {
      if (typeof window !== "undefined" && window && typeof window.addEventListener === "function")
        window.addEventListener("online", () => { try { if (st.old.length) finishOld(); if (isOn()) cycle({ reason: "online" }); } catch (e) {} });
    } catch (e) {}
  }
  function resetFor(code) {
    epoch++;
    stopTimers();
    queued = null;
    rcache.clear();
    tcache = { raw: null, val: null };
    hold = null; pendingN = 0; badNote = ""; metaChecked = false;
    unsaved = false;          /* a state with no hashes claims nothing, so it can always be written */
    const keep = { device: st.device, tp: st.tp, tsw: st.tsw, old: st.old, home: st.home };
    st = freshSt(keep.device);
    st.tp = keep.tp; st.tsw = keep.tsw; st.old = keep.old; st.home = keep.home;
    st.code = code || "";
  }

  /* ------------------------------------------------ wrap M.save / M.reset */
  /* Every macro change calls M.save(); push 1.5 s after the last one. */
  if (typeof M.save === "function" && !M.save.__cloud) {
    origSave = M.save;
    const wrapped = function () {
      const r = origSave.apply(this, arguments);
      try {
        if (!applying && !(M.storage && M.storage.ok === false)) unsaved = false;   /* everything in memory is on disk now */
        if (!applying && isOn()) schedule();
      } catch (e) {}
      return r;
    };
    wrapped.__cloud = true; wrapped.orig = origSave;
    M.save = wrapped;
  }
  /* Chalk's "Erase everything" wipes this phone only: the phone leaves the household and the
     cloud copy (and the other phone) keep everything. Join again with the code to get it back.
     Nothing from before the wipe is kept: no sync memory, no training copy for Undo. */
  if (typeof M.reset === "function" && !M.reset.__cloud) {
    const origReset = M.reset;
    const wrappedReset = function () {
      const r = origReset.apply(this, arguments);
      try {
        resetFor(""); st.tp = null; st.tsw = null; st.prev = null; st.home = "";
        lsDel(UNDO_KEY); lsDel(RESTORED_KEY);
        saveSt(true); notify();
      } catch (e) {}
      return r;
    };
    wrappedReset.__cloud = true; wrappedReset.orig = origReset;
    M.reset = wrappedReset;
  }

  /* ------------------------------------------------------------------- API */
  const normCode = s => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  /* Find the code in whatever was typed or pasted ("Chalk code: abcd-efgh-…", spaces, dashes). */
  function pickCode(s) {
    const up = String(s == null ? "" : s).toUpperCase();
    const all = normCode(up);
    if (CODE_RE.test(all)) return all;
    /* groups of letters split by anything else: the code is some run of them that adds up to 20 */
    const groups = up.split(/[^A-Z0-9]+/).filter(Boolean);
    for (let i = 0; i < groups.length; i++) {
      let c = "";
      for (let j = i; j < groups.length && c.length < 20; j++) { c += groups[j]; if (c.length === 20 && CODE_RE.test(c)) return c; }
    }
    return all;
  }
  /* Workouts on this phone that the cloud copy doesn't have: a restore keeps them. */
  function keepCount(seen, tl) {
    const have = new Set(Array.isArray(seen && seen.ids) ? seen.ids.map(String) : []);
    if (tl && st.tsw && st.tsw.to === tl.id && Array.isArray(st.tsw.ids)) st.tsw.ids.forEach(x => have.add(String(x)));
    return tl ? tl.ids.filter(x => !have.has(String(x))).length : 0;
  }
  function catchingUp() {
    const p = curPid();
    return !!(isOn() && p && p !== st.pp && p !== homePid() && !st.joining);
  }
  function trainingInfo() {
    const pid = trainPid();
    if (!isOn() || !pid) return null;
    const tl = trainLocal();
    const here = tl && tl.id === pid ? tl : null;
    const switched = !!(hold && hold.id === pid && hold.why === "switched");
    const seen = st.train[pid];
    if (!seen || seen.del) return switched ? { pid, t: 0, n: 0, last: 0, same: false, mine: false, missing: 0, held: true, why: "switched", busy: !!(here && here.busy) } : null;
    /* mine: the cloud copy is what this phone itself last sent (or restored) */
    return { pid, t: num(seen.t), n: num(seen.n), last: num(seen.last), same: !!(here && here.h === seen.h),
      mine: !!seen.h && seen.h === st.hashes["train|" + pid],
      missing: missingCount(seen, here), held: !!(hold && hold.id === pid), why: hold && hold.id === pid ? hold.why : "", busy: !!(here && here.busy),
      keep: keepCount(seen, here) };
  }
  M.cloud = {
    configured() { try { return configured(); } catch (e) { return false; } },
    /* Tests / previews only: point at another endpoint without editing the file. Not persisted. */
    configure(o) {
      try {
        o = isObj(o) ? o : {};
        if ("url" in o) over.url = o.url == null ? null : String(o.url);
        if ("key" in o) over.key = o.key == null ? null : String(o.key);
        if ("delay" in o) over.delay = o.delay == null ? null : Math.max(0, num(o.delay, SAVE_DELAY));
        notify();
      } catch (e) {}
      return M.cloud.configured();
    },
    status() {
      try {
        return { on: isOn(), configured: configured(), code: st.code || "", lastSync: num(st.lastSync), lastError: st.lastError || "",
          pending: pendingN, stuck: stuckKeys().length, busy: !!busy, device: st.device, note: st.note || "", verified: !!st.verified, catchUp: catchingUp() };
      } catch (e) { return { on: false, configured: false, code: "", lastSync: 0, lastError: "", pending: 0, stuck: 0, busy: false, note: "" }; }
    },
    start() {
      try {
        attach();
        if (st.old.length && configured()) finishOld();
        if (!isOn()) return false;
        startTicker();
        cycle({ reason: "start" });
        return true;
      } catch (e) { return false; }
    },
    /* First phone: a new household. The first cycle checks the cloud (write our row, read it
       back, make sure another code can't see it) before anything else goes up. */
    create() {
      try {
        if (!configured()) return null;
        resetFor(rand(20));
        if (!okPid(st.home)) st.home = homePid() || curPid() || "";
        st.meta = { v: 1, createdAt: now(), by: st.device };
        st.verified = false; st.pp = curPid() || "";
        saveSt(true);
        attach(); startTicker();
        cycle({ reason: "create", manual: true });
        notify();
        return st.code;
      } catch (e) { return null; }
    },
    join(input) {
      try {
        if (!configured()) return Promise.resolve({ ok: false, error: "Cloud sync isn't set up yet." });
        const code = pickCode(input);
        if (!CODE_RE.test(code)) return Promise.resolve({ ok: false, error: "That code doesn't look right. It has 20 letters and numbers, and never O, 0, I or 1." });
        if (code === st.code) return cycle({ reason: "join", manual: true }).then(r => ({ ok: true, synced: !!r.ok, error: r.ok ? "" : r.error }));
        const q = "?select=household,kind,id,deleted&kind=eq.meta&id=eq.household&limit=5";
        return request("GET", endpoint() + q, null, code).then(async rows => {
          const meta = Array.isArray(rows) ? rows.find(r => isObj(r) && r.household === code) : null;
          if (meta && meta.deleted === true) return { ok: false, error: "That code isn't used anymore. Get the new code from the other phone." };
          if (!meta) {
            const any = await request("GET", endpoint() + "?select=household,kind,id&deleted=eq.false&limit=1", null, code);
            if (!Array.isArray(any) || !any.some(r => isObj(r) && r.household === code)) return { ok: false, error: "No one is using that code yet. Check it on the other phone." };
          }
          const other = await request("GET", endpoint() + q, null, rand(20));
          if (!Array.isArray(other) || other.some(r => isObj(r) && r.household === code)) return { ok: false, error: errText({ code: "unsafe" }) };
          const prev = st.prev && st.prev.code === code ? st.prev : null;
          resetFor(code);
          if (!okPid(st.home)) st.home = homePid() || curPid() || "";
          st.verified = true;
          if (prev) {
            /* same household as before Turn off: pick up where this phone left off */
            ["hashes", "gone", "base", "train"].forEach(k => { if (isObj(prev[k])) st[k] = prev[k]; });
            st.cursor = typeof prev.cursor === "string" && isFinite(tsVal(prev.cursor)) ? prev.cursor : "";
            st.meta = isObj(prev.meta) ? prev.meta : null;
            st.pp = okPid(prev.pp) ? prev.pp : "";
          } else { st.joining = true; st.pp = curPid() || ""; }
          saveSt(true);
          attach(); startTicker();
          const r = await cycle({ reason: "join", manual: true });
          return { ok: true, synced: !!r.ok, error: r.ok ? "" : r.error };
        }, e => ({ ok: false, error: joinErr(e) })).catch(e => ({ ok: false, error: joinErr(e) }));
      } catch (e) { return Promise.resolve({ ok: false, error: joinErr(e) }); }
    },
    /* Turn off: this phone stops syncing and keeps everything. It remembers what it last
       agreed with this household, so joining the same code later can't bring back things
       the other phone deleted meanwhile. */
    leave() {
      try {
        const prev = st.code ? { code: st.code, hashes: st.hashes, gone: st.gone, base: st.base, train: st.train, cursor: st.cursor, meta: st.meta, pp: st.pp } : st.prev;
        resetFor(""); st.prev = prev; saveSt(true); notify();
      } catch (e) {}
      return true;
    },
    syncNow() {
      try { return cycle({ reason: "manual", manual: true }); }
      catch (e) { return Promise.resolve({ ok: false, error: errText(e) }); }
    },
    /* Chalk calls this right after the person on this phone changes (pick profile, Switch
       person): that person's diary and weigh-ins come down now, not at the next tick. */
    personChanged() {
      try {
        if (!isOn()) return Promise.resolve({ ok: false, error: configured() ? (st.note || "Sync is off.") : "Cloud sync isn't set up yet." });
        notify();
        return cycle({ reason: "person" });
      } catch (e) { return Promise.resolve({ ok: false, error: errText(e) }); }
    },
    /* True while the person picked on this phone is waiting for their diary to come down
       (show "Getting your diary…"). Never for the phone's own person: theirs stays here. */
    catchingUp() { try { return catchingUp(); } catch (e) { return false; } },
    /* Delete my cloud data: every row of this household is marked deleted (and emptied), the
       other phone stops syncing, and this phone keeps everything. Finishes later if offline. */
    deleteCloud() {
      try {
        if (!isOn()) return Promise.resolve({ ok: false, error: configured() ? "Sync is off." : "Cloud sync isn't set up yet." });
        /* First everything comes down to this phone (both people's diaries and weigh-ins), so
           nothing lived only in the cloud. Can't do that (offline, phone full): nothing is deleted. */
        return cycle({ reason: "manual", manual: true, all: true }).then(r0 => {
          if (!r0 || !r0.ok || !isOn()) return { ok: false, error: notDeleted(r0) };
          st.old = st.old.filter(j => j.code !== st.code).concat({ code: st.code, why: "deleted", at: now() });
          resetFor("");
          st.note = "Your cloud copy is deleted. Everything is still on this phone.";
          saveSt(true); notify();
          return finishOld().then(done => (done && !st.old.length ? { ok: true, error: "" }
            : { ok: false, later: true, error: "Couldn't reach the cloud. We'll finish deleting when you're online." }));
        }).catch(e => ({ ok: false, error: notDeleted({ error: errText(e) }) }));
      } catch (e) { return Promise.resolve({ ok: false, error: errText(e) }); }
    },
    /* Change code: a new household gets everything from this phone; once it's all up, the old
       household is cleared. The other phone stops and needs the new code. */
    changeCode() {
      try {
        if (!isOn()) return Promise.resolve({ ok: false, error: configured() ? "Sync is off." : "Cloud sync isn't set up yet." });
        /* First bring in what the other phone added (like her profile), so the new code gets it too. */
        return cycle({ reason: "manual", manual: true, all: true }).then(async r0 => {
          if (!r0 || !r0.ok || !isOn()) return { ok: false, code: st.code, error: (r0 && r0.error) || "Sync is off." };
          const old = st.code, t = now(), nc = rand(20), gen = epoch;
          /* The other person's training backup lives only in the cloud: it moves to the new code
             first. If that can't happen, nothing changes (the old code keeps working). */
          const tl = trainLocal();
          const rows = await request("GET", endpoint() + "?select=" + SELECT + "&kind=eq.train&deleted=eq.false&limit=10", null, old);
          if (gen !== epoch || !isOn() || st.code !== old) return { ok: false, code: st.code, error: "Sync stopped." };
          const carry = (Array.isArray(rows) ? rows : []).filter(x => isObj(x) && x.household === old && okPid(String(x.id)) && !(tl && tl.id === String(x.id)) && trainCheck(String(x.id), x.data));
          if (carry.length) {
            const body = "[" + carry.map(x => noKey(JSON.stringify({ household: nc, kind: "train", id: String(x.id), data: x.data, deleted: false,
              client_updated: Math.max(0, Math.round(num(x.client_updated))), device: typeof x.device === "string" ? x.device.slice(0, 64) : "" }))).join(",") + "]";
            await request("POST", upsertURL(), body, nc, PREFER);
            if (gen !== epoch || !isOn() || st.code !== old) return { ok: false, code: st.code, error: "Sync stopped." };
          }
          resetFor(nc);
          st.old = st.old.filter(j => j.code !== old).concat({ code: old, why: "moved", at: t });
          st.meta = { v: 1, createdAt: t, by: st.device };
          st.verified = false; st.pp = curPid() || "";
          saveSt(true); attach(); startTicker(); notify();
          return cycle({ reason: "code", manual: true }).then(r => Promise.resolve(finishOld()).then(() => ({ ok: !!r.ok, code: st.code, error: r.ok ? "" : r.error })));
        }).catch(e => ({ ok: false, code: st.code, error: errText(e) }));
      } catch (e) { return Promise.resolve({ ok: false, error: errText(e) }); }
    },
    /* What the cloud holds for this person's training (from the last pull), or null. */
    training() { try { return trainingInfo(); } catch (e) { return null; } },
    hasTrainingBackup() {
      try {
        const pid = trainPid();
        if (!isOn() || !pid) return Promise.resolve(false);
        const url = endpoint() + "?select=household,id,deleted,client_updated,updated_at&kind=eq.train&id=eq." + encodeURIComponent(pid) + "&limit=1";
        return request("GET", url, null, st.code).then(rows => {
          const r = Array.isArray(rows) ? rows.find(x => isObj(x) && x.household === st.code) : null;
          const yes = !!(r && !r.deleted);
          const seen = st.train[pid];
          if (yes && (!seen || seen.del || String(seen.at) !== String(r.updated_at))) cycle({ reason: "train" });   /* learn what it holds */
          if (!yes && seen && !seen.del) { st.train[pid] = { del: true, t: 0, at: "" }; saveSt(true); }
          return yes;
        }, () => { const s = st.train[pid]; return !!(s && !s.del); }).catch(() => false);
      } catch (e) { return Promise.resolve(false); }
    },
    /* Bring back the cloud copy of this person's training, then reload. Refuses mid-workout.
       Workouts only this phone has stay (added in date order); the next sync backs them up.
       The phone's training from before is kept for a day so Undo can put it back. */
    restoreTraining() {
      try {
        const pid = trainPid();
        if (!isOn() || !pid || activeWorkout()) return Promise.resolve(false);
        const url = endpoint() + "?select=" + SELECT + "&kind=eq.train&id=eq." + encodeURIComponent(pid) + "&limit=1";
        const gen = epoch;
        return request("GET", url, null, st.code).then(rows => {
          if (gen !== epoch || activeWorkout()) return false;
          const r = Array.isArray(rows) ? rows.find(x => isObj(x) && x.household === st.code) : null;
          const t = r && r.deleted !== true ? trainCheck(pid, r.data) : null;
          if (!t) return false;
          const cur = lsGet(TRAIN_KEY);
          const mr = mergeRestore(pid, t, cur);
          if (cur) {
            let n = 0;
            try { n = trainSum(JSON.parse(cur)).n; } catch (e) { n = 0; }
            /* with nothing of this phone's lost, a phone too full for the Undo copy may still restore */
            if (!lsSet(UNDO_KEY, JSON.stringify({ v: 1, at: now(), pid, n, raw: cur, bk: t.sum.ids })) && n > 0 && n > mr.kept) {
              st.lastError = errText({ code: "storage" }); saveSt(true); notify(); return false;
            }
          }
          if (!lsSet(TRAIN_KEY, mr.raw)) { lsDel(UNDO_KEY); st.lastError = errText({ code: "storage" }); saveSt(true); notify(); return false; }
          lsSet(RESTORED_KEY, String(t.sum.n));
          const h = fnv(t.raw);
          st.hashes["train|" + pid] = h;
          st.train[pid] = { h, t: num(r.client_updated), at: String(r.updated_at || ""), n: t.sum.n, last: t.sum.last, ids: t.sum.ids, del: false, dev: String(r.device || "").slice(0, 64), guest: r.data.guest === true };
          st.tp = { pids: [pid] }; st.tsw = null;
          hold = null;
          tcache = { raw: null, val: null };
          saveSt(true);
          try { if (typeof location !== "undefined" && location && typeof location.reload === "function") location.reload(); } catch (e) {}
          return true;
        }, () => false).catch(() => false);
      } catch (e) { return Promise.resolve(false); }
    },
    /* The training a restore replaced: {at, n, pid} while Undo is possible, else null. */
    undoInfo() { try { const u = readUndo(); return u ? { at: num(u.at), n: num(u.n), pid: okPid(u.pid) ? u.pid : null } : null; } catch (e) { return null; } },
    /* Put back the training a restore replaced, then reload. Refuses mid-workout. */
    undoRestore() {
      try {
        const u = readUndo();
        if (!u || activeWorkout()) return false;
        /* exactly what the phone had, plus any workout logged since the restore */
        let raw = u.raw;
        const pid = okPid(u.pid) ? u.pid : null, old = pid ? parseTrain(u.raw, pid) : null, now_ = pid ? parseTrain(lsGet(TRAIN_KEY), pid) : null;
        if (old && now_) {
          const have = new Set(Array.isArray(u.bk) ? u.bk.map(String) : []);
          old.log.forEach(w => { if (isObj(w) && wid(w)) have.add(wid(w)); });
          const fresh = isObj(now_.active) && num(now_.active.start) > num(u.at);   /* a workout started after the restore */
          if (addWorkouts(old, now_, have, fresh) || fresh) { old.updatedAt = now(); raw = JSON.stringify(old); }
        }
        if (!lsSet(TRAIN_KEY, raw)) { st.lastError = errText({ code: "storage" }); saveSt(true); notify(); return false; }
        lsDel(UNDO_KEY); lsDel(RESTORED_KEY);
        if (okPid(u.pid)) delete st.hashes["train|" + u.pid];
        st.tp = null; st.tsw = null; hold = null;
        tcache = { raw: null, val: null };
        saveSt(true);
        try { if (typeof location !== "undefined" && location && typeof location.reload === "function") location.reload(); } catch (e) {}
        return true;
      } catch (e) { return false; }
    },
    /* The one-time "restored" note (workouts restored), cleared once read. */
    takeRestored() { try { const v = lsGet(RESTORED_KEY); lsDel(RESTORED_KEY); const n = v == null ? NaN : Number(v); return isFinite(n) ? n : null; } catch (e) { return null; } },
    fmtCode(code) { return normCode(code).replace(/(.{4})(?=.)/g, "$1-"); },
    /* The code with all but the first 4 letters hidden, for the card (Show reveals it). */
    codeMasked() { try { const c = st.code; return c ? c.slice(0, 4) + "-••••-••••-••••-••••" : ""; } catch (e) { return ""; } },
    pickCode(s) { try { const c = pickCode(s); return CODE_RE.test(c) ? c : ""; } catch (e) { return ""; } },
    /* internals for tests */
    _: { canon, hash: H, tsVal, normCode, clean, merge3, mergeDay, dayBase, mergeRec, state: () => st, scan: () => scan({}), cycle: o => cycle(o), CODE_RE }
  };
  /* A phone from before merge bases were kept: each recent diary day still exactly as it was at
     the last sync becomes that day's base now, before anything is changed here, so a delete
     made before the first sync with this build sticks. */
  try {
    const days = isObj(M.MS) && isObj(M.MS.days) ? M.MS.days : null;
    let n = 0;
    if (days) Object.keys(days).forEach(id => {
      const key = "day|" + id, rec = days[id];
      if (!isObj(rec)) return;
      /* A day an older build took whole from a newer phone's row keeps that row's delete list.
         It never belongs in the diary (or a backup). If the day is still just as it was at the
         last sync (its old hash counted the list), it still counts as synced: nothing to send. */
      if ("gone" in rec) {
        const old = st.code && st.hashes[key] !== undefined ? H(rec) : "";
        delete rec.gone;
        if (old && old === st.hashes[key]) { st.hashes[key] = hashRec(key, rec); n++; }
      }
      if (!st.code || !validId("day", id) || st.hashes[key] === undefined || has(st.base, key) || !recentDay(id)) return;
      if (hashRec(key, rec) === st.hashes[key]) { st.base[key] = dayBase(rec); n++; }
    });
    if (n) saveSt(true);
  } catch (e) {}
})(window.M);
