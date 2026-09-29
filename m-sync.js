window.M = window.M || {};
/* ============================================================================
   Chalk · household cloud sync + backup (m-sync.js) — M.cloud
   Shares foods and saved meals between Nick's and Katerina's phones and keeps
   a cloud copy of diaries, body logs, profiles and each phone's training, so a
   lost or reset phone gets its history back. Supabase REST (PostgREST) over
   plain fetch; no library. Loads after m-core.js / m-trends.js.

   Table public.chalk_sync (household, kind, id) primary key; data jsonb;
   deleted boolean (tombstones — rows are never deleted); client_updated bigint;
   device text; updated_at stamped by a server trigger. Row-level security lets
   a request see / write only rows whose household equals its x-household header.

   Change detection never touches m-core internals: a hash of every record as
   it was when it last matched the cloud lives in localStorage "chalk.sync.v1".
   Hashes are over canonical JSON (sorted keys) because jsonb hands objects back
   with its own key order.
   With SB_URL / SB_KEY empty this file makes zero network requests.
   Never throws at load, never throws from any M.cloud method.
   ========================================================================== */
(function (M) {
  "use strict";
  const SB_URL = ""; const SB_KEY = "";

  /* ------------------------------------------------------------- constants */
  const ST_KEY = "chalk.sync.v1";            /* this file's own state */
  const TRAIN_KEY = "chalk.v1";              /* Chalk's training state (backup only) */
  const TABLE = "chalk_sync";
  const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   /* 32 symbols: no 0 O 1 I */
  const CODE_RE = /^[A-HJ-NP-Z2-9]{20}$/;
  const COLL = { food: "foods", meal: "meals", day: "days", body: "body", profile: "profiles" };
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
  const BAD_IDS = { __proto__: 1, constructor: 1, prototype: 1 };

  /* --------------------------------------------------------------- helpers */
  const isNum = v => typeof v === "number" && isFinite(v);
  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  function num(v, d) { if (d === undefined) d = 0; if (typeof v === "string" && v.trim() !== "") v = Number(v); return isNum(v) ? v : d; }
  const now = () => { try { return typeof M.now === "function" ? M.now() : Date.now(); } catch (e) { return Date.now(); } };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const kindOf = key => key.slice(0, key.indexOf("|"));
  const idOf = key => key.slice(key.indexOf("|") + 1);
  function lsGet(k) { try { return typeof localStorage === "undefined" ? null : localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (typeof localStorage === "undefined") return false; localStorage.setItem(k, v); return true; } catch (e) { return false; } }
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
  function later(a, b) { const x = tsVal(a), y = tsVal(b); return isFinite(x) && isFinite(y) ? x > y : String(a) > String(b); }
  function back(ts, ms) { const v = tsVal(ts); if (!isFinite(v)) return ts; try { return new Date(Math.floor(v / 1000) - ms).toISOString(); } catch (e) { return ts; } }

  /* ----------------------------------------------------------------- state */
  function freshSt(device) {
    return { v: 1, code: "", device: device || "d" + rand(12).toLowerCase(), cursor: "", lastSync: 0, lastError: "",
      hashes: {}, gone: {}, bad: {}, train: {}, trainAt: 0, meta: null };
  }
  function loadSt() {
    let s = null;
    try { s = JSON.parse(lsGet(ST_KEY)); } catch (e) { s = null; }
    const o = freshSt(isObj(s) && typeof s.device === "string" && s.device && s.device.length <= 64 ? s.device : null);
    if (!isObj(s) || s.v !== 1) return o;
    o.code = typeof s.code === "string" && CODE_RE.test(s.code) ? s.code : "";
    o.cursor = typeof s.cursor === "string" ? s.cursor : "";
    o.lastSync = num(s.lastSync);
    o.lastError = typeof s.lastError === "string" ? s.lastError : "";
    ["hashes", "gone", "bad", "train"].forEach(k => { if (isObj(s[k])) o[k] = s[k]; });
    o.trainAt = num(s.trainAt);
    o.meta = isObj(s.meta) ? s.meta : null;
    return o;
  }
  let st = loadSt();
  let unsaved = false;       /* M.MS holds pulled data that isn't on disk yet (phone was full) */
  /* The sync state says which records match the cloud. It is only written when the data it
     describes is on disk too; otherwise a restart would see "missing" records and delete them. */
  function saveSt() {
    if (unsaved && !commitLocal()) return false;
    return lsSet(ST_KEY, JSON.stringify(st));
  }

  const over = { url: null, key: null, delay: null };
  function cfg() {
    const url = String(over.url != null ? over.url : SB_URL || "").trim().replace(/\/+$/, "");
    const key = String(over.key != null ? over.key : SB_KEY || "").trim();
    return { url, key };
  }
  const configured = () => { const c = cfg(); return !!(c.url && c.key); };
  const isOn = () => configured() && !!st.code;
  const endpoint = () => cfg().url + "/rest/v1/" + TABLE;

  let epoch = 0;            /* bumps on create / join / leave: an in-flight cycle for an old household stops */
  let inflight = null, queued = null, busy = false;
  let saveT = null, firstDirty = 0, ticker = null, retryT = null, retryN = 0;
  let applying = false, pendingN = 0, hold = null, badNote = "";
  let origSave = null;       /* m-core's M.save, before the wrap below */
  const rcache = new Map();  /* key → {s: JSON.stringify(rec), h} so unchanged records skip canonical hashing */
  let tcache = { raw: null, val: null };

  /* ---------------------------------------------------------------- hashing */
  function hashRec(key, rec) {
    let s;
    try { s = JSON.stringify(rec); } catch (e) { return ""; }
    if (typeof s !== "string") return "";
    const c = rcache.get(key);
    if (c && c.s === s) return c.h;
    const h = fnv(canon(rec) || "");
    rcache.set(key, { s, h });
    return h;
  }
  const blankDay = d => !(Array.isArray(d.entries) && d.entries.length) && !num(d.water) && !d.note && !num(d.updatedAt);
  /* The time a local record was last edited — compared with a remote row's client_updated. */
  function localTime(kind, rec) {
    if (kind === "body") return num(rec.at);
    if (kind === "profile") return Math.max(num(rec.updatedAt), num(rec.setupAt), num(rec.lastBody));
    return num(rec.updatedAt);
  }

  /* --------------------------------------------------------------- training */
  const validPid = v => typeof v === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(v);
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
  function trainLocal() {
    const raw = lsGet(TRAIN_KEY);
    if (!raw) { tcache = { raw: null, val: null }; return null; }
    if (raw === tcache.raw) return tcache.val;
    let d = null;
    try { d = JSON.parse(raw); } catch (e) { d = null; }
    let val = null;
    if (isObj(d) && d.v === 1 && validPid(d.profile)) {
      const sum = trainSum(d);
      val = { id: d.profile, raw, h: fnv(raw), n: sum.n, last: sum.last, ids: sum.ids,
        gone: Array.isArray(d.gone) ? d.gone.map(String) : [], updated: num(d.updatedAt), busy: !!d.active, bytes: bytesOf(raw) };
    }
    tcache = { raw, val };
    return val;
  }
  function trainPid() {
    try { if (typeof S !== "undefined" && S && validPid(S.profile)) return S.profile; } catch (e) {}
    const tl = trainLocal();
    return tl ? tl.id : null;
  }
  /* Workouts in the cloud copy that this phone doesn't have (and didn't delete). */
  function missingCount(seen, tl) {
    const have = new Set(tl ? tl.ids : []);
    if (tl) tl.gone.forEach(g => have.add(g));
    return (Array.isArray(seen && seen.ids) ? seen.ids : []).filter(x => !have.has(String(x))).length;
  }
  function noteTrain(r) {
    const id = String(r.id);
    if (!validPid(id)) return;
    if (r.deleted) { st.train[id] = { del: true, t: num(r.client_updated), at: String(r.updated_at || "") }; return; }
    const raw = trainText(r.data);
    if (raw == null) return;
    let d = null;
    try { d = JSON.parse(raw); } catch (e) { d = null; }
    if (!isObj(d)) return;
    const h = fnv(raw), sum = trainSum(d);
    st.train[id] = { h, t: num(r.client_updated), at: String(r.updated_at || ""), n: sum.n, last: sum.last, ids: sum.ids, del: false };
    const tl = trainLocal();
    if (tl && tl.id === id && tl.h === h) st.hashes["train|" + id] = h;
  }

  /* ------------------------------------------------------------------ http */
  function headers(code, extra) {
    const key = cfg().key;
    const h = { apikey: key, "x-household": code, "content-type": "application/json" };
    if (/^eyJ/.test(key)) h.Authorization = "Bearer " + key;
    if (extra) Object.keys(extra).forEach(k => { h[k] = extra[k]; });
    return h;
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
        const opt = { method, headers: headers(code, extra), cache: "no-store", credentials: "omit" };
        if (body != null) opt.body = body;
        if (ctl) opt.signal = ctl.signal;
        p = fetch(url, opt);
      } catch (e) { finish(reject, { code: "net", message: String(e && e.message || e) }); return; }
      Promise.resolve(p).then(res => {
        if (done) return;
        if (!res || !res.ok) {
          const status = res ? res.status : 0;
          Promise.resolve(res && typeof res.text === "function" ? res.text() : "").catch(() => "").then(t => finish(reject, { code: "http", status, message: String(t || "").slice(0, 300) }));
          return;
        }
        if (method !== "GET") { finish(resolve, null); return; }
        Promise.resolve(res.json()).then(j => finish(resolve, j), () => finish(reject, { code: "bad", message: "not json" }));
      }, e => finish(reject, { code: "net", message: String(e && e.message || e) }));
    });
  }
  function errText(e) {
    if (e && e.code === "http") {
      const s = e.status;
      if (s === 401 || s === 403) return "The cloud turned this phone away (error " + s + "). Turn sync off and join again with the code.";
      if (s === 404) return "The cloud isn't ready yet (error 404). We'll try again.";
      if (s === 413) return "Something was too big to save in the cloud.";
      if (s >= 500) return "The cloud is having trouble (error " + s + "). We'll try again soon.";
      return "Sync didn't work (error " + s + "). We'll try again.";
    }
    if (e && e.code === "storage") return "This phone's storage is full. Free up space, then tap Sync now.";
    if (e && e.code === "bad") return "The cloud sent back something odd. We'll try again.";
    return "Can't reach the internet. We'll try again soon.";
  }

  /* ------------------------------------------------------------------ pull */
  function applyRow(r, ch) {
    if (!isObj(r)) return;
    const kind = String(r.kind || ""), id = r.id == null ? "" : String(r.id);
    if (!id || BAD_IDS[id]) return;
    const key = kind + "|" + id;
    if (kind === "train") { noteTrain(r); return; }
    if (kind === "meta") { if (id === "household" && !r.deleted && isObj(r.data)) { st.meta = r.data; st.hashes[key] = H(r.data); } return; }
    const cn = COLL[kind];
    if (!cn) return;
    const MS = M.MS;
    if (!isObj(MS)) return;
    if (!isObj(MS[cn])) MS[cn] = {};
    const coll = MS[cn];
    const local = has(coll, id) && isObj(coll[id]) ? coll[id] : undefined;
    const synced = st.hashes[key];
    const take = (data, h) => { coll[id] = data; st.hashes[key] = h; rcache.delete(key); delete st.gone[key]; delete st.bad[key]; ch.applied++; };
    if (r.deleted) {
      if (local === undefined) { delete st.hashes[key]; delete st.gone[key]; return; }
      /* a delete only wins over a copy nobody touched here since the last sync */
      if (synced !== undefined && hashRec(key, local) === synced) { delete coll[id]; delete st.hashes[key]; delete st.gone[key]; rcache.delete(key); ch.applied++; }
      return;
    }
    const data = r.data;
    if (!isObj(data)) return;
    const remoteAt = num(r.client_updated), rh = H(data);
    /* Three-way: `synced` is the version both sides last agreed on. A cloud copy equal to it is
       nothing new (a re-read), so a local edit made since then always goes up, clocks aside. */
    if (local !== undefined) {
      const lh = hashRec(key, local);
      if (lh === rh) { st.hashes[key] = rh; return; }
      if (synced !== undefined && rh === synced) return;
      if ((synced !== undefined && lh === synced) || remoteAt > localTime(kind, local)) take(data, rh);
      return;
    }
    if (synced !== undefined) {
      /* deleted here since the last sync: only a newer edit from the other phone brings it back */
      if (rh !== synced && remoteAt > num(st.gone[key], now())) take(data, rh);
      return;
    }
    take(data, rh);
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
  async function pull(gen) {
    const ch = { applied: 0 };
    let cursor = st.cursor || "", first = true;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const from = !cursor ? EPOCH : (first ? back(cursor, OVERLAP_MS) : cursor);
        first = false;
        const url = endpoint() + "?select=kind,id,data,deleted,client_updated,updated_at&household=eq." + st.code +
          "&updated_at=gt." + encodeURIComponent(from) + "&order=updated_at.asc&limit=" + PAGE;
        const rows = await request("GET", url, null, st.code);
        if (gen !== epoch) return 0;
        if (!Array.isArray(rows)) throw { code: "bad" };
        /* One upsert request = one transaction = one updated_at for all its rows. A full page may
           end in the middle of such a group, so leave that group for the next page. */
        let use = rows;
        if (rows.length >= PAGE) {
          const lastTs = rows[rows.length - 1] && rows[rows.length - 1].updated_at;
          let k = rows.length - 1;
          while (k > 0 && rows[k - 1] && rows[k - 1].updated_at === lastTs) k--;
          if (k > 0) use = rows.slice(0, k);
        }
        const before = ch.applied;
        use.forEach(r => { try { applyRow(r, ch); } catch (e) {} });
        const lastTs = use.length && use[use.length - 1] ? use[use.length - 1].updated_at : null;
        if (lastTs && (!cursor || later(lastTs, cursor))) cursor = String(lastTs);
        /* Local data first, then the sync state that describes it — never the other way round,
           so a phone killed mid-pull never thinks it holds data it didn't save. */
        if ((ch.applied > before || unsaved) && !commitLocal()) throw { code: "storage" };
        st.cursor = cursor;
        saveSt();
        if (rows.length < PAGE) break;
      }
    } finally {
      if (ch.applied && gen === epoch) safeRerender();
    }
    return ch.applied;
  }

  /* ------------------------------------------------------------------ push */
  function scan() {
    const out = { changed: [], removed: [] };
    const MS = M.MS;
    if (!isObj(MS)) return out;
    const seen = new Set();
    Object.keys(COLL).forEach(kind => {
      const coll = MS[COLL[kind]];
      if (!isObj(coll)) return;
      Object.keys(coll).forEach(id => {
        const rec = coll[id];
        if (!id || BAD_IDS[id] || !isObj(rec)) return;
        const key = kind + "|" + id;
        if (kind === "day" && st.hashes[key] === undefined && blankDay(rec)) return;   /* a day someone only looked at */
        seen.add(key);
        if (st.gone[key]) delete st.gone[key];
        const h = hashRec(key, rec);
        if (h && h !== st.hashes[key] && st.bad[key] !== h) out.changed.push({ kind, id, key, rec, h });
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
    const row = { household: st.code, kind, id, data, deleted: !!deleted, client_updated: Math.max(0, Math.round(num(at))), device: st.device };
    let s = "";
    try { s = JSON.stringify(row); } catch (e) { s = ""; }
    return { key, h, s, bytes: s ? bytesOf(s) : 0, ok };
  }
  function trainItem(opts) {
    const tl = trainLocal();
    if (!tl) { hold = null; return null; }
    const key = "train|" + tl.id;
    if (tl.h === st.hashes[key] || st.bad[key] === tl.h) { hold = null; return null; }
    const seen = st.train[tl.id];
    if (seen && !seen.del && seen.h === tl.h) { st.hashes[key] = tl.h; hold = null; return null; }
    /* The cloud copy came from another phone. Never overwrite workouts this phone doesn't have
       (a fresh phone would wipe the backup it's meant to restore from). */
    if (seen && !seen.del && seen.h !== st.hashes[key]) {
      const miss = missingCount(seen, tl);
      if (miss > 0) { hold = { id: tl.id, missing: miss }; return null; }
    }
    hold = null;
    if (!opts.manual && tl.busy && now() - num(st.trainAt) < TRAIN_GAP) return null;
    return makeItem("train", tl.id, { v: 1, json: tl.raw }, false, tl.updated || now(), key, tl.h, () => {
      st.hashes[key] = tl.h; st.trainAt = now(); delete st.bad[key];
      st.train[tl.id] = { h: tl.h, t: tl.updated, at: "", n: tl.n, last: tl.last, ids: tl.ids, del: false };
    });
  }
  function metaItem() {
    if (!isObj(st.meta)) return null;
    const key = "meta|household", h = H(st.meta);
    if (h === st.hashes[key]) return null;
    return makeItem("meta", "household", st.meta, false, num(st.meta.createdAt) || now(), key, h, () => { st.hashes[key] = h; });
  }
  function collect(opts) {
    const snap = scan(), items = [];
    snap.changed.forEach(it => items.push(makeItem(it.kind, it.id, it.rec, false, localTime(it.kind, it.rec), it.key, it.h,
      () => { st.hashes[it.key] = it.h; delete st.gone[it.key]; delete st.bad[it.key]; })));
    snap.removed.forEach(key => items.push(makeItem(kindOf(key), idOf(key), {}, true, st.gone[key] || now(), key, "",
      () => { delete st.hashes[key]; delete st.gone[key]; rcache.delete(key); })));
    const m = metaItem(); if (m) items.push(m);
    const tr = trainItem(opts || {}); if (tr) items.push(tr);
    return items;
  }
  const dirtyLocal = () => { try { return collect({}).length > 0; } catch (e) { return false; } };
  async function sendChunk(ch, gen) {
    const url = endpoint() + "?on_conflict=household,kind,id";
    try {
      await request("POST", url, "[" + ch.map(x => x.s).join(",") + "]", st.code, { Prefer: "resolution=merge-duplicates,return=minimal" });
    } catch (e) {
      if (gen !== epoch) return;
      if (e && e.code === "http" && (e.status === 400 || e.status === 413 || e.status === 422)) {
        if (ch.length > 1) { for (const x of ch) await sendChunk([x], gen); return; }
        st.bad[ch[0].key] = ch[0].h;           /* skip this one record until it changes */
        badNote = e.status === 413 ? "Something was too big to save in the cloud." : "One item couldn't be saved to the cloud (error " + e.status + ").";
        pendingN = Math.max(0, pendingN - 1);
        saveSt();
        return;
      }
      throw e;
    }
    if (gen !== epoch) return;
    ch.forEach(x => { try { x.ok(); } catch (e) {} });
    pendingN = Math.max(0, pendingN - ch.length);
    saveSt();
  }
  async function push(gen, opts) {
    const items = collect(opts);
    const send = [];
    items.forEach(x => {
      if (!x.s) return;
      if (x.bytes > MAX_ROW_BYTES) { st.bad[x.key] = x.h; badNote = "Something was too big to save in the cloud."; return; }
      send.push(x);
    });
    pendingN = send.length;
    if (!send.length) return 0;
    let ch = [], size = 0;
    for (const x of send) {
      if (ch.length && (ch.length >= CHUNK_ROWS || size + x.bytes > CHUNK_BYTES)) { await sendChunk(ch, gen); if (gen !== epoch) return 0; ch = []; size = 0; }
      ch.push(x); size += x.bytes;
    }
    if (ch.length) await sendChunk(ch, gen);
    return send.length;
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
    if (!isOn()) return { ok: false, error: "Sync is off." };
    busy = true; badNote = ""; notify();
    try {
      let applied = 0;
      if (opts.pull !== false) applied = await pull(gen);
      if (gen !== epoch) return { ok: false, error: "Sync stopped." };
      const pushed = await push(gen, opts);
      if (gen !== epoch) return { ok: false, error: "Sync stopped." };
      st.lastSync = now(); st.lastError = badNote; retryN = 0;
      clearTimeout(retryT); retryT = null;
      saveSt();
      return { ok: true, applied, pushed };
    } catch (e) {
      if (gen !== epoch) return { ok: false, error: "Sync stopped." };
      st.lastError = errText(e);
      try { pendingN = collect({}).length; } catch (x) {}
      saveSt();   /* skipped by saveSt itself while pulled data can't reach the disk */
      scheduleRetry();
      return { ok: false, error: st.lastError };
    } finally {
      busy = false;
      notify();
    }
  }
  function cycle(opts) {
    opts = opts || {};
    if (!isOn()) return Promise.resolve({ ok: false, error: configured() ? "Sync is off." : "Cloud sync isn't set up yet." });
    if (inflight) {
      if (!queued) {
        const q = { opts: Object.assign({}, opts), p: null };
        queued = q;
        q.p = inflight.then(() => { if (queued === q) queued = null; return cycle(q.opts); });
      } else if (opts.manual) queued.opts.manual = true;
      return queued.p;
    }
    inflight = runCycle(opts).then(r => { inflight = null; return r; }, e => { inflight = null; return { ok: false, error: errText(e) }; });
    return inflight;
  }
  function scheduleRetry() {
    if (!isOn()) return;
    clearTimeout(retryT);
    const ms = RETRY[Math.min(retryN, RETRY.length - 1)];
    retryN++;
    retryT = unref(setTimeout(() => { retryT = null; cycle({ reason: "retry" }); }, ms));
  }
  function schedule() {
    if (!isOn()) return;
    const t = Date.now(), delay = over.delay != null ? over.delay : SAVE_DELAY;
    if (!firstDirty) firstDirty = t;
    const due = Math.min(t + delay, firstDirty + Math.max(delay, SAVE_MAX_WAIT));
    clearTimeout(saveT);
    /* saves that only touched this phone's own UI state (mode, tab) have nothing to send */
    saveT = unref(setTimeout(() => { saveT = null; firstDirty = 0; if (dirtyLocal()) cycle({ reason: "save" }); }, Math.max(0, due - t)));
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
        if (!isOn()) return;
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
        window.addEventListener("online", () => { try { if (isOn()) cycle({ reason: "online" }); } catch (e) {} });
    } catch (e) {}
  }
  function resetFor(code) {
    epoch++;
    stopTimers();
    queued = null;
    rcache.clear();
    tcache = { raw: null, val: null };
    hold = null; pendingN = 0; badNote = "";
    unsaved = false;          /* a state with no hashes claims nothing, so it can always be written */
    st = freshSt(st.device);
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
     cloud copy (and the other phone) keep everything. Join again with the code to get it back. */
  if (typeof M.reset === "function" && !M.reset.__cloud) {
    const origReset = M.reset;
    const wrappedReset = function () {
      const r = origReset.apply(this, arguments);
      try { if (st.code) { resetFor(""); saveSt(); notify(); } } catch (e) {}
      return r;
    };
    wrappedReset.__cloud = true; wrappedReset.orig = origReset;
    M.reset = wrappedReset;
  }

  /* ------------------------------------------------------------------- API */
  const normCode = s => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
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
          pending: pendingN, busy: !!busy, device: st.device };
      } catch (e) { return { on: false, configured: false, code: "", lastSync: 0, lastError: "", pending: 0, busy: false }; }
    },
    start() {
      try {
        attach();
        if (!isOn()) return false;
        startTicker();
        cycle({ reason: "start" });
        return true;
      } catch (e) { return false; }
    },
    create() {
      try {
        if (!configured()) return null;
        resetFor(rand(20));
        st.meta = { v: 1, createdAt: now(), by: st.device };
        saveSt();
        attach(); startTicker();
        cycle({ reason: "create", manual: true });
        notify();
        return st.code;
      } catch (e) { return null; }
    },
    join(input) {
      try {
        if (!configured()) return Promise.resolve({ ok: false, error: "Cloud sync isn't set up yet." });
        const code = normCode(input);
        if (!CODE_RE.test(code)) return Promise.resolve({ ok: false, error: "That code doesn't look right. It has 20 letters and numbers." });
        if (code === st.code) return cycle({ reason: "join", manual: true }).then(r => ({ ok: true, synced: !!r.ok, error: r.ok ? "" : r.error }));
        return request("GET", endpoint() + "?select=kind,id&household=eq." + code + "&limit=1", null, code).then(rows => {
          if (!Array.isArray(rows) || !rows.length) return { ok: false, error: "No one is using that code yet. Check it on the other phone." };
          resetFor(code);
          saveSt();
          attach(); startTicker();
          return cycle({ reason: "join", manual: true }).then(r => ({ ok: true, synced: !!r.ok, error: r.ok ? "" : r.error }));
        }, e => ({ ok: false, error: errText(e) })).catch(e => ({ ok: false, error: errText(e) }));
      } catch (e) { return Promise.resolve({ ok: false, error: errText(e) }); }
    },
    leave() {
      try { resetFor(""); saveSt(); notify(); } catch (e) {}
      return true;
    },
    syncNow() {
      try { return cycle({ reason: "manual", manual: true }); }
      catch (e) { return Promise.resolve({ ok: false, error: errText(e) }); }
    },
    /* What the cloud holds for this person's training (from the last pull), or null. */
    training() {
      try {
        const pid = trainPid();
        if (!isOn() || !pid) return null;
        const seen = st.train[pid];
        if (!seen || seen.del) return null;
        const tl = trainLocal();
        const here = tl && tl.id === pid ? tl : null;
        /* mine: the cloud copy is what this phone itself last sent (or restored) */
        return { pid, t: num(seen.t), n: num(seen.n), last: num(seen.last), same: !!(here && here.h === seen.h),
          mine: !!seen.h && seen.h === st.hashes["train|" + pid],
          missing: missingCount(seen, here), held: !!(hold && hold.id === pid), busy: !!(here && here.busy) };
      } catch (e) { return null; }
    },
    hasTrainingBackup() {
      try {
        const pid = trainPid();
        if (!isOn() || !pid) return Promise.resolve(false);
        const url = endpoint() + "?select=id,deleted,client_updated,updated_at&household=eq." + st.code + "&kind=eq.train&id=eq." + encodeURIComponent(pid) + "&limit=1";
        return request("GET", url, null, st.code).then(rows => {
          const r = Array.isArray(rows) ? rows[0] : null;
          const yes = !!(r && !r.deleted);
          const seen = st.train[pid];
          if (yes && (!seen || seen.del || String(seen.at) !== String(r.updated_at))) cycle({ reason: "train" });   /* learn what it holds */
          if (!yes && seen && !seen.del) { st.train[pid] = { del: true, t: 0, at: "" }; saveSt(); }
          return yes;
        }, () => { const s = st.train[pid]; return !!(s && !s.del); }).catch(() => false);
      } catch (e) { return Promise.resolve(false); }
    },
    /* Replace this phone's training with the cloud copy, then reload. Refuses mid-workout. */
    restoreTraining() {
      try {
        const pid = trainPid();
        if (!isOn() || !pid) return Promise.resolve(false);
        try { if (typeof S !== "undefined" && S && S.active) return Promise.resolve(false); } catch (e) {}
        const url = endpoint() + "?select=kind,id,data,deleted,client_updated,updated_at&household=eq." + st.code + "&kind=eq.train&id=eq." + encodeURIComponent(pid) + "&limit=1";
        const gen = epoch;
        return request("GET", url, null, st.code).then(rows => {
          if (gen !== epoch) return false;
          const r = Array.isArray(rows) ? rows[0] : null;
          const raw = r && !r.deleted ? trainText(r.data) : null;
          let d = null;
          try { d = raw == null ? null : JSON.parse(raw); } catch (e) { d = null; }
          if (!isObj(d) || d.v !== 1) return false;
          if (!lsSet(TRAIN_KEY, raw)) { st.lastError = errText({ code: "storage" }); saveSt(); notify(); return false; }
          const h = fnv(raw), sum = trainSum(d);
          st.hashes["train|" + pid] = h;
          st.train[pid] = { h, t: num(r.client_updated), at: String(r.updated_at || ""), n: sum.n, last: sum.last, ids: sum.ids, del: false };
          hold = null;
          tcache = { raw: null, val: null };
          saveSt();
          try { if (typeof location !== "undefined" && location && typeof location.reload === "function") location.reload(); } catch (e) {}
          return true;
        }, () => false).catch(() => false);
      } catch (e) { return Promise.resolve(false); }
    },
    fmtCode(code) { return normCode(code).replace(/(.{4})(?=.)/g, "$1-"); },
    /* internals for tests */
    _: { canon, hash: H, tsVal, normCode, state: () => st, scan: () => scan(), cycle: o => cycle(o), CODE_RE }
  };
})(window.M);
