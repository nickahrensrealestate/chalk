window.M = window.M || {};
/* ============================================================================
   Chalk · Macros — core (the `M` namespace)
   State, localStorage, Claude-db sync, calorie/macro calculator, food math,
   foods / meals / log / body CRUD, search ranking, check-ins, streaks, week
   summary. Plain ES2020, no DOM, never throws at load.
   Chalk globals (S, PRESETS, uid, esc, render) are only read lazily inside
   functions, guarded with typeof, so this file can load before Chalk boots.

   New OPTIONAL fields (old data stays valid; nothing else in M.MS changed):
   · Food.cook = { y, word:"raw"|"dry", per100gCooked, alts? } — the food
     changes weight when cooked. serving / per / per100g / alts stay the raw
     (or dry) state. y = cooked grams per raw gram. per100gCooked = the cooked
     profile (custom foods: per100g ÷ y). cook.alts = cooked-state portions.
   · Entry.state = "raw"|"cooked", Entry.cook = { y, word } — which weight was
     logged. servingLabel / g / per describe ONE unit in that state, e.g.
     "1 oz raw" (g 28.35). Meal items may carry the same two fields.
   · Meal.batch = { cookedG, rawG } — cooked as one batch, logged by cooked
     weight. servingsMade is 1, so per = the whole batch; rawG = raw grams of
     the items. A logged portion keeps its own per, so editing the meal later
     never changes days already logged.
   · M.storage (never saved) = { ok, lastError, bytes, bakDay, restoredFrom };
     M.onStorageError(fn). localStorage also keeps a daily copy under
     M.KEY + ".bak"; M.load() falls back to it when the main copy is damaged.
   ========================================================================== */
(function (M) {
  "use strict";

  const DAY = 864e5;
  M.KEY = "chalk.macros.v1";
  M.SLOTS = ["Breakfast", "Lunch", "Dinner", "Snacks"];
  M.NUT = ["cal", "p", "c", "f", "fiber", "sugar", "sodium"];
  /* Clock. Tests (and nothing else) may replace this. */
  M.now = function () { return Date.now(); };

  /* ---------------------------------------------------------------- helpers */
  const isNum = v => typeof v === "number" && isFinite(v);
  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  function num(v, d) { if (d === undefined) d = 0; if (typeof v === "string") v = parseFloat(v); return isNum(v) ? v : d; }
  /* Round with a float-noise nudge so 3.3*1.5 (=4.949999…) rounds to 5, not 4.9. */
  const r1 = v => Math.round(v * 10 + (v >= 0 ? 1e-9 : -1e-9)) / 10;
  const r2 = v => Math.round(v * 100 + (v >= 0 ? 1e-9 : -1e-9)) / 100;
  const r4 = v => Math.round(v * 1e4) / 1e4;
  const r0 = v => Math.round(v);
  const pad = n => (n < 10 ? "0" : "") + n;
  const lc = s => String(s == null ? "" : s).toLowerCase();
  const noop = () => {};

  M.uid = function () {
    try { if (typeof uid === "function") return uid(); } catch (e) {}
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  };
  M.esc = function (s) {
    try { if (typeof esc === "function") return esc(s); } catch (e) {}
    return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  };
  M.cp = o => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

  /* ------------------------------------------------------------------ dates */
  /* All date keys are LOCAL calendar days "YYYY-MM-DD". Parsing anchors at
     local noon so DST shifts never move a key by a day. */
  function parseKey(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0);
  }
  function keyOf(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  M.tsToKey = ts => keyOf(new Date(ts));
  M.today = () => M.tsToKey(M.now());
  M.addDays = (key, n) => { const d = parseKey(key) || new Date(M.now()); d.setDate(d.getDate() + (num(n))); return keyOf(d); };
  M.daysBetween = (a, b) => { const da = parseKey(a), db = parseKey(b); if (!da || !db) return 0; return Math.round((db - da) / DAY); };
  M.fmtDay = key => {
    const t = M.today();
    if (key === t) return "Today";
    if (key === M.addDays(t, -1)) return "Yesterday";
    if (key === M.addDays(t, 1)) return "Tomorrow";
    const d = parseKey(key); if (!d) return String(key || "");
    try { return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); } catch (e) { return key; }
  };
  M.defaultSlot = date => {
    const d = date instanceof Date ? date : new Date(M.now());
    const mins = d.getHours() * 60 + d.getMinutes();
    return mins < 630 ? "Breakfast" : mins < 870 ? "Lunch" : mins < 1230 ? "Dinner" : "Snacks";
  };
  M.isSlot = s => M.SLOTS.indexOf(s) >= 0;

  /* --------------------------------------------------------------- servings */
  /* "1 cup (240 g)" <-> {qty:1, unit:"cup", g:240} */
  M.fmtServing = s => {
    s = s || {};
    const qty = num(s.qty, 1) || 1, unit = String(s.unit || "serving").trim(), g = num(s.g);
    return String(+qty.toFixed(2)) + " " + unit + (g > 0 ? " (" + String(+g.toFixed(1)) + " g)" : "");
  };
  M.parseServing = label => {
    const str = String(label || "").trim();
    const m = /^([\d.]+(?:\s*\/\s*\d+)?)?\s*([^()]*?)\s*(?:\((\d+(?:\.\d+)?)\s*g\))?\s*$/i.exec(str);
    if (!m) return { qty: 1, unit: str || "serving", g: null };
    let qty = 1;
    if (m[1]) { const fr = m[1].split("/"); qty = fr.length === 2 ? num(fr[0], 1) / (num(fr[1], 1) || 1) : num(m[1], 1); }
    return { qty: qty || 1, unit: (m[2] || "serving").trim() || "serving", g: m[3] ? num(m[3]) : null };
  };

  /* ------------------------------------------------------------------ state */
  function freshState() {
    return { v: 1, updatedAt: 0, ui: { mode: "train", person: null, date: null, tab: "diary" }, profiles: {}, foods: {}, meals: {}, days: {}, body: {} };
  }
  /* Keys that must never become properties of a plain object (prototype pollution). */
  const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
  const okKey = k => typeof k === "string" && k !== "" && !BAD_KEYS.has(k);
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isStr = v => typeof v === "string";
  /* The only two people. Any other id gets a default profile that is never stored. */
  const isPid = id => id === "nick" || id === "kat";
  /* id → record map: plain objects only, no dangerous keys. */
  function cleanMap(o) {
    const out = {};
    if (!isObj(o)) return out;
    Object.keys(o).forEach(k => { if (okKey(k) && isObj(o[k])) out[k] = o[k]; });
    return out;
  }
  const UI_FIELDS = ["mode", "person", "date", "tab"];
  function applyUi(ui, src) {
    if (!isObj(src)) return ui;
    UI_FIELDS.forEach(k => { if (src[k] !== undefined) ui[k] = src[k]; });
    if (ui.mode !== "macros") ui.mode = "train";
    if (!isPid(ui.person)) ui.person = null;
    if (!isStr(ui.tab) || !ui.tab) ui.tab = "diary";
    if (ui.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(ui.date))) ui.date = null;
    return ui;
  }
  function shape(s) {
    const o = freshState();
    if (!isObj(s)) return o;
    o.updatedAt = num(s.updatedAt);
    applyUi(o.ui, s.ui);
    STATE_KEYS.forEach(k => { if (isObj(s[k])) o[k] = cleanMap(s[k]); });
    return o;
  }
  function lsGet(k) { try { if (typeof localStorage === "undefined") return null; return localStorage.getItem(k); } catch (e) { return null; } }
  /* null on success, else the error (quota full, storage blocked…). */
  function lsWrite(k, v) {
    try {
      if (typeof localStorage === "undefined") return new Error("This browser has no storage");
      localStorage.setItem(k, v);
      return null;
    } catch (e) { return e || new Error("Save failed"); }
  }
  function lsDel(k) { try { if (typeof localStorage !== "undefined") localStorage.removeItem(k); } catch (e) {} }
  const isQuota = e => !!e && (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || e.code === 22 || /quota|full/i.test(String(e.message || "")));

  /* ---------------------------------------------------------- storage safety */
  /* On disk (format 2):
       M.KEY                  {v:1, fmt:2, updatedAt, profiles, foods, meals, months:["2026-09", …]}
       M.KEY + ".d.YYYY-MM"   {v:1, d:{dayId: packed day}}   one key per month of logged days
       M.KEY + ".body"        {v:1, b:{id: [w, rhr, at]}}    weigh-ins and resting heart rate
       M.UI_KEY               {mode, person, tab, date}      Train | Macros taps only write this
       M.KEY + ".bak"         a daily copy of the last good save (only recent months when big)
       M.KEY + ".damaged…"    a copy of anything that couldn't be read, made before any save
     A save writes the main key plus only the months (and body) that changed.
     Entries are packed small on disk (short keys, nutrients as a list, no empty
     fields) and unpacked on load, so M.MS looks exactly like it always did. The
     old one-key format (everything under M.KEY) still loads and moves over on
     the next save; if that doesn't fit, the old key stays as it was.
     A failed save never loses data silently: M.MS stays in memory, every later
     M.save() tries again, M.storage says what happened and M.onStorageError
     listeners hear about it once per failure streak. */
  M.UI_KEY = "chalk.macros.ui";
  const BAK_KEY = () => M.KEY + ".bak";
  const BODY_KEY = () => M.KEY + ".body";
  const MONTH_PRE = () => M.KEY + ".d.";
  const MONTH_KEY = m => MONTH_PRE() + m;
  const STATE_KEYS = ["profiles", "foods", "meals", "days", "body"];
  function parseJSON(s) { if (s == null) return undefined; try { return JSON.parse(s); } catch (e) { return undefined; } }
  function validState(s) { return isObj(s) && s.v === 1 && (s.ui === undefined || isObj(s.ui)) && STATE_KEYS.every(k => s[k] === undefined || isObj(s[k])); }
  function validMain(s) {
    if (!validState(s)) return false;
    if (s.fmt === undefined) return true;
    return s.fmt === 2 && s.days === undefined && s.body === undefined && (s.months === undefined || Array.isArray(s.months));
  }
  const validChunk = o => isObj(o) && o.v === 1 && isObj(o.d);
  const validBodyFile = o => isObj(o) && o.v === 1 && isObj(o.b);
  /* bakMax: a full backup copy is kept up to 600,000 characters (like Chalk's own
     "chalk.bak"). Past that the copy keeps profiles, foods, meals, weigh-ins and
     the last two months of days, so it never crowds the training log out. */
  M.storage = { ok: true, lastError: null, bytes: 0, bakDay: null, restoredFrom: null, bakMax: 600000, damaged: [] };
  const storeFns = [];
  let storeStreak = false;
  M.onStorageError = function (fn) {
    if (typeof fn !== "function") return;
    storeFns.push(fn);
    if (storeStreak) { try { fn(M.storage); } catch (e) {} }   /* joined mid-streak: tell it now */
  };
  function storeFail(err) {
    const name = err && err.name && err.name !== "Error" ? err.name + ": " : "";
    M.storage.ok = false;
    M.storage.lastError = name + String((err && err.message) || err || "Save failed");
    if (storeStreak) return;
    storeStreak = true;
    storeFns.slice().forEach(fn => { try { fn(M.storage); } catch (e) {} });
  }
  function storeOk() { M.storage.ok = true; M.storage.lastError = null; storeStreak = false; }

  /* ------------------------------------------------------------ packing */
  const SLOT_I = { Breakfast: 0, Lunch: 1, Dinner: 2, Snacks: 3 };
  const ENTRY_STD = { id: 1, slot: 1, name: 1, brand: 1, servings: 1, servingLabel: 1, g: 1, per: 1, at: 1, foodId: 1, mealId: 1, state: 1, cook: 1 };
  const DAY_STD = { id: 1, pid: 1, date: 1, entries: 1, water: 1, note: 1, updatedAt: 1 };
  function stdPer(p) {
    if (!isObj(p)) return false;
    let n = 0;
    for (const k in p) { if (!hasOwn(p, k)) continue; n++; if (!isNum(p[k]) || M.NUT.indexOf(k) < 0) return false; }
    return n === M.NUT.length;
  }
  function extras(o, std) {
    let x = null;
    for (const k in o) { if (!hasOwn(o, k) || std[k] || o[k] === undefined || !okKey(k)) continue; (x || (x = {}))[k] = o[k]; }
    return x;
  }
  /* An entry as the app writes it → a small list:
       [id, slot 0-3, name, servingLabel, at, servings, per (7 numbers, trailing zeros dropped),
        g (0 = none), foodId (0 = none), brand, state/cook, mealId (0 = none), other fields]
     where state/cook is 0, "r" / "c", or ["r"|"c", y] (["r"|"c", y, "dry"] for rice and pasta).
     Trailing defaults are dropped. Anything unusual is kept whole as {r: entry}. */
  function packEntry(e) {
    if (!isObj(e)) return { r: e === undefined ? null : e };
    if (!(isStr(e.id) && SLOT_I[e.slot] !== undefined && isStr(e.name) && isStr(e.brand) && isNum(e.servings) && isStr(e.servingLabel) &&
      (e.g === null || (isNum(e.g) && e.g > 0)) && stdPer(e.per) && isNum(e.at))) return { r: e };
    if ((e.foodId !== undefined && !(isStr(e.foodId) && e.foodId)) || (e.mealId !== undefined && !(isStr(e.mealId) && e.mealId)) ||
      (e.state !== undefined && e.state !== "raw" && e.state !== "cooked")) return { r: e };
    let sc = 0;
    if (e.cook !== undefined) {
      const c = e.cook;
      if (e.state === undefined || !isObj(c) || Object.keys(c).length !== 2 || !isNum(c.y) || (c.word !== "raw" && c.word !== "dry")) return { r: e };
      sc = c.word === "dry" ? [e.state === "cooked" ? "c" : "r", c.y, "dry"] : [e.state === "cooked" ? "c" : "r", c.y];
    } else if (e.state !== undefined) sc = e.state === "cooked" ? "c" : "r";
    const per = e.per, p = [per.cal, per.p, per.c, per.f, per.fiber, per.sugar, per.sodium];
    while (p.length && p[p.length - 1] === 0) p.pop();
    const x = extras(e, ENTRY_STD);
    const a = [e.id, SLOT_I[e.slot], e.name, e.servingLabel, e.at, e.servings, p, e.g === null ? 0 : e.g, e.foodId === undefined ? 0 : e.foodId, e.brand, sc, e.mealId === undefined ? 0 : e.mealId];
    if (x) a.push(x);
    else while (a.length > 7 && (a[a.length - 1] === 0 || a[a.length - 1] === "")) a.pop();
    return a;
  }
  const pv = (p, j) => (j < p.length && isNum(p[j]) ? p[j] : 0);
  const SLOT_N = ["Breakfast", "Lunch", "Dinner", "Snacks"];
  function unpackEntry(a) {
    if (!Array.isArray(a)) return isObj(a) && hasOwn(a, "r") ? a.r : (a === undefined ? null : a);
    const p = a[6];
    const per = Array.isArray(p) && p.length === 7 ? { cal: p[0], p: p[1], c: p[2], f: p[3], fiber: p[4], sugar: p[5], sodium: p[6] }
      : Array.isArray(p) ? { cal: pv(p, 0), p: pv(p, 1), c: pv(p, 2), f: pv(p, 3), fiber: pv(p, 4), sugar: pv(p, 5), sodium: pv(p, 6) }
      : { cal: 0, p: 0, c: 0, f: 0, fiber: 0, sugar: 0, sodium: 0 };
    const e = { id: a[0], slot: SLOT_N[a[1]] || "Snacks", name: a[2], brand: a[9] || "", servings: a[5], servingLabel: a[3], g: a[7] || null, per, at: a[4] };
    if (a.length > 8) {
      if (a[8]) e.foodId = a[8];
      if (a[11]) e.mealId = a[11];
      const sc = a[10];
      if (sc) {
        if (Array.isArray(sc)) { e.state = sc[0] === "c" ? "cooked" : "raw"; e.cook = { y: sc[1], word: sc[2] === "dry" ? "dry" : "raw" }; }
        else e.state = sc === "c" ? "cooked" : "raw";
      }
      const x = a[12];
      if (isObj(x)) Object.keys(x).forEach(k => { if (okKey(k)) e[k] = x[k]; });
    }
    return e;
  }
  function splitId(id) { const i = String(id).lastIndexOf("|"); return i < 0 ? null : { pid: id.slice(0, i), date: id.slice(i + 1) }; }
  function packDay(id, d) {
    if (!(d.id === id && isStr(d.pid) && isStr(d.date) && d.date.indexOf("|") < 0 && id === d.pid + "|" + d.date &&
      Array.isArray(d.entries) && isNum(d.water) && isStr(d.note) && isNum(d.updatedAt))) return { r: d };
    const o = { u: d.updatedAt };
    if (d.water !== 0) o.w = d.water;
    if (d.note) o.n = d.note;
    o.e = d.entries.map(packEntry);
    const x = extras(d, DAY_STD); if (x) o.x = x;
    return o;
  }
  function unpackDay(id, o) {
    if (!isObj(o)) return null;
    if (hasOwn(o, "r")) return isObj(o.r) ? o.r : null;
    const s = splitId(id); if (!s) return null;
    const d = { id, pid: s.pid, date: s.date, entries: Array.isArray(o.e) ? o.e.map(unpackEntry) : [], water: o.w !== undefined ? o.w : 0, note: o.n !== undefined ? o.n : "", updatedAt: o.u };
    if (isObj(o.x)) Object.keys(o.x).forEach(k => { if (okKey(k)) d[k] = o.x[k]; });
    return d;
  }
  function packBody(id, b) {
    if (b.id === id && isStr(b.pid) && isStr(b.date) && b.date.indexOf("|") < 0 && id === b.pid + "|" + b.date &&
      (b.w === null || isNum(b.w)) && (b.rhr === null || isNum(b.rhr)) && isNum(b.at) && Object.keys(b).length === 6) return [b.w, b.rhr, b.at];
    return { r: b };
  }
  function unpackBody(id, o) {
    if (Array.isArray(o)) { const s = splitId(id); return s ? { id, pid: s.pid, date: s.date, w: o[0] === undefined ? null : o[0], rhr: o[1] === undefined ? null : o[1], at: o[2] } : null; }
    return isObj(o) && isObj(o.r) ? o.r : null;
  }
  M.storage._ = { packEntry, unpackEntry, packDay, unpackDay, packBody, unpackBody };

  /* --------------------------------------------------------- disk bookkeeping */
  /* What the disk holds, so a save can tell what changed since the last good write.
     A day counts as changed when its object, entries list, entry count, water,
     note or updatedAt differ from what was written (M.log.* always bumps
     updatedAt; m-sync swaps in new objects). */
  const MONTH_RE = /^(\d{4})-(\d{2})-\d{2}$/;
  function monthOf(id, d) {
    let date = isObj(d) && isStr(d.date) ? d.date : "";
    if (!MONTH_RE.test(date)) { const s = splitId(String(id)); date = s ? s.date : ""; }
    const m = MONTH_RE.exec(date);
    return m ? m[1] + "-" + m[2] : "x";
  }
  const emptyDay = d => !(Array.isArray(d.entries) && d.entries.length) && !num(d.water) && !d.note && !num(d.updatedAt);
  const daySig = (id, d) => ({ ref: d, u: d.updatedAt, er: d.entries, n: Array.isArray(d.entries) ? d.entries.length : -1, w: d.water, no: d.note, m: monthOf(id, d) });
  const sameDay = (s, d) => s.ref === d && s.u === d.updatedAt && s.er === d.entries && s.n === (Array.isArray(d.entries) ? d.entries.length : -1) && s.w === d.water && s.no === d.note;
  const bodySig = b => ({ ref: b, at: b.at, w: b.w, rhr: b.rhr });
  const sameBody = (s, b) => s.ref === b && s.at === b.at && s.w === b.w && s.rhr === b.rhr;
  function freshDisk() {
    return {
      fmt: 0,                 /* 0 nothing yet · 1 old one-key format · 2 month keys */
      months: new Set(),      /* month keys present on disk */
      monthIds: new Map(),    /* month → Set of day ids written there */
      daySig: new Map(), bodySig: new Map(),
      dirtyMonths: new Set(), bodyDirty: false, bodyOnDisk: false,
      bad: new Set(),         /* keys that couldn't be read at load (copied to .damaged) */
      sizes: new Map(), uiStr: null, noMove: false, strs: new Map()
    };
  }
  let disk = freshDisk();
  const noteMonth = date => { if (MONTH_RE.test(String(date || ""))) disk.dirtyMonths.add(String(date).slice(0, 7)); };
  function sumBytes() { let n = 0; disk.sizes.forEach(v => { n += v; }); M.storage.bytes = n; return n; }

  /* Months whose keys exist: the index in the main key, every key the browser
     lists, and (where the storage can't list keys) a probe of each month from
     the oldest known one to next month. */
  function addMonth(m, n) { const y = +m.slice(0, 4), mo = +m.slice(5, 7) - 1 + n; const d = new Date(y, mo, 1, 12); return d.getFullYear() + "-" + pad(d.getMonth() + 1); }
  function diskMonths(hint) {
    const out = new Set();
    (Array.isArray(hint) ? hint : []).forEach(m => { if (/^\d{4}-\d{2}$|^x$/.test(String(m))) out.add(String(m)); });
    try {
      if (typeof localStorage !== "undefined" && typeof localStorage.key === "function" && typeof localStorage.length === "number") {
        const pre = MONTH_PRE();
        for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf(pre) === 0) out.add(k.slice(pre.length)); }
        return out;
      }
    } catch (e) {}
    const cur = M.today().slice(0, 7), known = Array.from(out).filter(m => m !== "x").sort();
    let m = known.length ? known[0] : addMonth(cur, -120);
    const end = addMonth(cur, 1);
    for (let guard = 0; m <= end && guard < 600; guard++, m = addMonth(m, 1)) if (!out.has(m) && lsGet(MONTH_KEY(m)) != null) out.add(m);
    if (lsGet(MONTH_KEY("x")) != null) out.add("x");
    return out;
  }

  /* Every ".damaged" copy (Erase removes them too). */
  function damagedKeys() {
    const pre = M.KEY + ".damaged", out = [];
    try {
      if (typeof localStorage !== "undefined" && typeof localStorage.key === "function" && typeof localStorage.length === "number") {
        for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf(pre) === 0) out.push(k); }
        return out;
      }
    } catch (e) {}
    return out.concat([pre, pre + ".2", pre + ".3", pre + ".body", pre + ".body.2"]);
  }
  /* A copy of something that can't be read, before anything overwrites it. Never overwrites an older copy. */
  function keepDamaged(key, raw) {
    const base = key.replace(M.KEY, M.KEY + ".damaged");
    for (let n = 1; n <= 5; n++) {
      const k = n === 1 ? base : base + "." + n;
      if (lsGet(k) != null) continue;
      if (!lsWrite(k, raw)) M.storage.damaged.push(k);
      return;
    }
  }

  /* The daily backup as {day, trim, main:{profiles,foods,meals,ui,updatedAt}, days, body}, or null. */
  function readBak(str) {
    const b = parseJSON(str === undefined ? lsGet(BAK_KEY()) : str);
    if (!isObj(b)) return null;
    if (b.bak === 1 && validState(b.data)) return { day: String(b.day || "backup"), main: b.data, days: cleanMap(b.data.days), body: cleanMap(b.data.body) };
    if (b.bak === 2 && validMain(b.main)) {
      const days = {}, body = {};
      if (isObj(b.d)) Object.keys(b.d).forEach(m => { const c = b.d[m]; if (validChunk(c)) Object.keys(c.d).forEach(id => { if (okKey(id)) { const d = unpackDay(id, c.d[id]); if (d) days[id] = d; } }); });
      if (validBodyFile(b.body)) Object.keys(b.body.b).forEach(id => { if (okKey(id)) { const r = unpackBody(id, b.body.b[id]); if (r) body[id] = r; } });
      return { day: String(b.day || "backup"), main: b.main, days, body };
    }
    return null;
  }
  const bakDayOf = str => { const m = str ? /^\{"bak":[12],"day":"(\d{4}-\d{2}-\d{2})"/.exec(str) : null; return m ? m[1] : null; };
  /* newer record wins (by tsKey); missing ones are added */
  function takeNewer(dst, src, tsKey) {
    Object.keys(src).forEach(id => { const a = dst[id], b = src[id]; if (!isObj(b)) return; if (!isObj(a) || num(b[tsKey]) > num(a[tsKey])) dst[id] = b; });
  }

  M.load = function () {
    disk = freshDisk();
    M.storage.restoredFrom = null;
    M.storage.damaged = [];
    const bakStr = lsGet(BAK_KEY());
    M.storage.bakDay = bakDayOf(bakStr);
    const damaged = [];
    const rawMain = lsGet(M.KEY);
    let main = parseJSON(rawMain);
    if (rawMain != null && !validMain(main)) { damaged.push([M.KEY, rawMain]); main = null; }
    const fmt2 = !!(main && main.fmt === 2);
    const s = freshState();
    if (main) {
      s.updatedAt = num(main.updatedAt);
      ["profiles", "foods", "meals"].forEach(k => { s[k] = cleanMap(main[k]); });
      if (isObj(main.ui)) s.ui = main.ui;
      if (!fmt2) { s.days = cleanMap(main.days); s.body = cleanMap(main.body); }
      disk.sizes.set(M.KEY, rawMain.length);
    }
    /* month keys and the body key */
    const fromDisk = { days: {}, body: {} }, dayMonth = new Map();
    diskMonths(fmt2 ? main.months : null).forEach(m => {
      const k = MONTH_KEY(m), str = lsGet(k);
      if (str == null) return;
      disk.months.add(m); disk.sizes.set(k, str.length);
      const o = parseJSON(str);
      if (!validChunk(o)) { damaged.push([k, str]); disk.bad.add(k); disk.dirtyMonths.add(m); return; }
      Object.keys(o.d).forEach(id => { if (!okKey(id)) return; const d = unpackDay(id, o.d[id]); if (d) { fromDisk.days[id] = d; dayMonth.set(id, m); } });
    });
    const bstr = lsGet(BODY_KEY());
    if (bstr != null) {
      disk.bodyOnDisk = true; disk.sizes.set(BODY_KEY(), bstr.length);
      const o = parseJSON(bstr);
      if (!validBodyFile(o)) { damaged.push([BODY_KEY(), bstr]); disk.bad.add(BODY_KEY()); disk.bodyDirty = true; }
      else Object.keys(o.b).forEach(id => { if (!okKey(id)) return; const r = unpackBody(id, o.b[id]); if (r) fromDisk.body[id] = r; });
    }
    const chunksAreTruth = fmt2 || !main;
    const legacyLost = !main && !disk.months.size;   /* the damaged key held everything (old format) */
    if (chunksAreTruth) { s.days = fromDisk.days; s.body = fromDisk.body; }
    else { takeNewer(s.days, fromDisk.days, "updatedAt"); takeNewer(s.body, fromDisk.body, "at"); }   /* old key: keep anything newer a month key holds */
    /* anything unreadable: keep a copy, then fill the gaps from the daily backup */
    if (damaged.length) {
      damaged.forEach(x => keepDamaged(x[0], x[1]));
      const b = readBak(bakStr);
      if (b) {
        let used = false;
        if (!main) {
          s.updatedAt = num(b.main.updatedAt);
          ["profiles", "foods", "meals"].forEach(k => { s[k] = cleanMap(b.main[k]); });
          if (isObj(b.main.ui)) s.ui = b.main.ui;
          used = true;
        }
        const badMonths = new Set(Array.from(disk.bad).filter(k => k.indexOf(MONTH_PRE()) === 0).map(k => k.slice(MONTH_PRE().length)));
        Object.keys(b.days).forEach(id => {
          const d = b.days[id];
          if (s.days[id] ? (badMonths.has(monthOf(id, d)) && num(d.updatedAt) > num(s.days[id].updatedAt)) : (badMonths.has(monthOf(id, d)) || legacyLost)) { s.days[id] = d; used = true; }
        });
        if (disk.bad.has(BODY_KEY()) || legacyLost) Object.keys(b.body).forEach(id => { if (!s.body[id]) { s.body[id] = b.body[id]; used = true; } });
        if (used) M.storage.restoredFrom = b.day;
      }
    }
    disk.fmt = fmt2 ? 2 : main ? 1 : (disk.months.size || disk.bodyOnDisk ? 2 : 0);
    M.MS = shape(s);
    /* taps on Train | Macros live in their own small key */
    const uiStr = lsGet(M.UI_KEY), ui = parseJSON(uiStr);
    if (isObj(ui)) { applyUi(M.MS.ui, ui); disk.uiStr = uiStr; disk.sizes.set(M.UI_KEY, uiStr.length); }
    /* what's on disk right now, so the next save writes only what changes */
    if (disk.fmt === 2) {
      const days = M.MS.days;
      dayMonth.forEach((m, id) => {
        const d = days[id];
        if (d !== fromDisk.days[id]) { disk.dirtyMonths.add(m); return; }
        disk.daySig.set(id, daySig(id, d));
        if (!disk.monthIds.has(m)) disk.monthIds.set(m, new Set());
        disk.monthIds.get(m).add(id);
      });
      if (!disk.bad.has(BODY_KEY())) Object.keys(M.MS.body).forEach(id => { const b = M.MS.body[id]; if (b === fromDisk.body[id]) disk.bodySig.set(id, bodySig(b)); else disk.bodyDirty = true; });
    }
    sumBytes();
    return M.MS;
  };

  /* ---------------------------------------------------------------- saving */
  /* Profiles still exactly as M.person() made them (never set up, never edited) aren't written. */
  function canon(v) { return JSON.stringify(v, (k, x) => (isObj(x) ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x)); }
  const pristine = (id, p) => isObj(p) && !p.setupAt && canon(p) === canon(defaultProfile(id));
  function keptProfiles(ps) {
    const out = {};
    Object.keys(isObj(ps) ? ps : {}).forEach(id => { const p = ps[id]; if (okKey(id) && isObj(p) && !pristine(id, p)) out[id] = p; });
    return out;
  }
  function uiJSON() { const u = M.MS.ui || {}; return JSON.stringify({ mode: u.mode === "macros" ? "macros" : "train", person: isPid(u.person) ? u.person : null, tab: isStr(u.tab) && u.tab ? u.tab : "diary", date: u.date || null }); }
  /* Writes only the small ui key (mode, person, tab, date). Never a full save. */
  M.saveUi = function () {
    const s = uiJSON();
    if (s === disk.uiStr) return true;
    const err = lsWrite(M.UI_KEY, s);
    if (err) return false;
    disk.uiStr = s; disk.sizes.set(M.UI_KEY, s.length);
    return true;
  };

  /* Recent months for a trimmed backup: everything from 2 months before this one. */
  const trimFrom = () => addMonth(M.today().slice(0, 7), -2);
  /* The last good save on disk as one backup string, or null when something on disk is damaged or missing. */
  function bakFromDisk(day) {
    const mainStr = lsGet(M.KEY), main = parseJSON(mainStr);
    if (!validMain(main)) return null;
    const head = '{"bak":' + (main.fmt === 2 ? 2 : 1) + ',"day":"' + day + '","at":' + M.now();
    const max = num(M.storage.bakMax, 600000);
    if (main.fmt !== 2) {
      if (mainStr.length <= max) return head + ',"data":' + mainStr + "}";
      const t = Object.assign({}, main, { days: {} }), from = trimFrom();
      Object.keys(cleanMap(main.days)).forEach(id => { if (monthOf(id, main.days[id]) >= from) t.days[id] = main.days[id]; });
      return head + ',"trim":1,"data":' + JSON.stringify(t) + "}";
    }
    if (disk.bad.size) return null;
    const bodyStr = lsGet(BODY_KEY());
    let total = mainStr.length + (bodyStr ? bodyStr.length : 0);
    const parts = [];
    Array.from(disk.months).sort().forEach(m => { const str = lsGet(MONTH_KEY(m)); if (str != null) { parts.push([m, str]); total += str.length; } });
    let trim = false;
    if (total > max) { const from = trimFrom(); trim = true; for (let i = parts.length - 1; i >= 0; i--) if (parts[i][0] < from || parts[i][0] === "x") parts.splice(i, 1); }
    return head + (trim ? ',"trim":1' : "") + ',"main":' + mainStr + ',"body":' + (bodyStr || "null") + ',"d":{' + parts.map(x => '"' + x[0] + '":' + x[1]).join(",") + "}}";
  }
  /* First save of each day: copy the last good save to .bak. A good older copy is
     never deleted: when the data is big the copy is trimmed, and when something
     on disk is damaged today's copy is skipped. */
  function dailyBak() {
    const day = M.today();
    if (M.storage.bakDay === day) return;
    const b = bakFromDisk(day);
    if (b == null) return;
    M.storage.bakDay = day;   /* one try a day, even when the phone is full */
    lsWrite(BAK_KEY(), b);
  }
  /* Phone full: swap a full backup for a trimmed one to make room. Never deletes it. */
  function shrinkBak() {
    const str = lsGet(BAK_KEY());
    if (str == null || /^\{"bak":[12],"day":"[^"]*","at":\d+,"trim":1/.test(str)) return false;
    const b = parseJSON(str); if (!isObj(b)) return false;
    const from = trimFrom();
    let out = null;
    if (b.bak === 2 && isObj(b.d)) {
      const d = {}; Object.keys(b.d).forEach(m => { if (m >= from && m !== "x") d[m] = b.d[m]; });
      out = JSON.stringify({ bak: 2, day: b.day, at: b.at, trim: 1, main: b.main, body: b.body, d });
    } else if (b.bak === 1 && validState(b.data)) {
      const t = Object.assign({}, b.data, { days: {} });
      Object.keys(cleanMap(b.data.days)).forEach(id => { if (monthOf(id, b.data.days[id]) >= from) t.days[id] = b.data.days[id]; });
      out = JSON.stringify({ bak: 1, day: b.day, at: b.at, trim: 1, data: t });
    }
    if (!out || out.length >= str.length) return false;
    return !lsWrite(BAK_KEY(), out);
  }
  function put(k, s) {
    let e = lsWrite(k, s);
    if (e && isQuota(e) && shrinkBak()) e = lsWrite(k, s);
    if (!e) disk.sizes.set(k, s.length);
    return e;
  }
  /* The old one-key format: everything in M.KEY (used only while the move to month keys doesn't fit). */
  function persistOld() {
    let str;
    try { str = JSON.stringify(Object.assign({}, M.MS, { profiles: keptProfiles(M.MS.profiles) })); } catch (e) { storeFail(e); return false; }
    const err = put(M.KEY, str);
    if (err) { storeFail(err); return false; }
    disk.fmt = 1;
    storeOk(); sumBytes();
    return true;
  }
  function persist() {
    const MS = M.MS;
    try { dailyBak(); } catch (e) {}
    try { M.saveUi(); } catch (e) {}
    if (disk.fmt === 1 && disk.noMove) return persistOld();
    const moving = disk.fmt !== 2;
    const days = isObj(MS.days) ? MS.days : {}, body = isObj(MS.body) ? MS.body : {};
    let monthStr, bodyStr, groups;
    try {
      /* 1. which months changed since the last good write */
      const dirty = new Set(disk.dirtyMonths), seen = new Set();
      Object.keys(days).forEach(id => {
        const d = days[id];
        if (!isObj(d) || !okKey(id)) return;
        seen.add(id);
        const sg = disk.daySig.get(id);
        if (sg && sameDay(sg, d)) return;
        if (sg) dirty.add(sg.m);
        if (sg || !emptyDay(d)) dirty.add(monthOf(id, d));
      });
      disk.daySig.forEach((sg, id) => { if (!seen.has(id)) dirty.add(sg.m); });
      /* 2. those months, packed */
      monthStr = new Map(); groups = new Map();
      if (dirty.size) {
        dirty.forEach(m => groups.set(m, []));
        Object.keys(days).forEach(id => { const d = days[id]; if (!isObj(d) || !okKey(id) || emptyDay(d)) return; const g = groups.get(monthOf(id, d)); if (g) g.push(id); });
        groups.forEach((ids, m) => {
          if (!ids.length) { monthStr.set(m, null); return; }
          const o = {}; ids.forEach(id => { o[id] = packDay(id, days[id]); });
          monthStr.set(m, '{"v":1,"d":' + JSON.stringify(o) + "}");
        });
      }
      /* 3. body, when any record changed */
      let bodyChanged = disk.bodyDirty || moving;
      const bseen = new Set();
      Object.keys(body).forEach(id => { const b = body[id]; if (!isObj(b) || !okKey(id)) return; bseen.add(id); const sg = disk.bodySig.get(id); if (!sg || !sameBody(sg, b)) bodyChanged = true; });
      if (!bodyChanged) disk.bodySig.forEach((sg, id) => { if (!bseen.has(id)) bodyChanged = true; });
      if (bodyChanged) {
        const o = {}; let n = 0;
        bseen.forEach(id => { o[id] = packBody(id, body[id]); n++; });
        bodyStr = n ? '{"v":1,"b":' + JSON.stringify(o) + "}" : null;
      }
    } catch (e) { storeFail(e); return false; }
    /* 4. write the months, then the body, then the main key (which lists the months) */
    let err = null;
    const wroteNow = [];
    monthStr.forEach((str, m) => {
      const k = MONTH_KEY(m);
      if (str == null) {
        lsDel(k); disk.months.delete(m); disk.sizes.delete(k); disk.bad.delete(k); disk.dirtyMonths.delete(m);
        const old = disk.monthIds.get(m); if (old) old.forEach(id => { const sg = disk.daySig.get(id); if (sg && sg.m === m) disk.daySig.delete(id); });
        disk.monthIds.delete(m);
        return;
      }
      const e = put(k, str);
      if (e) { err = err || e; return; }
      wroteNow.push(k);
      disk.months.add(m); disk.bad.delete(k); disk.dirtyMonths.delete(m);
      const ids = groups.get(m), idSet = new Set(ids), old = disk.monthIds.get(m);
      if (old) old.forEach(id => { if (!idSet.has(id)) { const sg = disk.daySig.get(id); if (sg && sg.m === m) disk.daySig.delete(id); } });
      ids.forEach(id => disk.daySig.set(id, daySig(id, days[id])));
      disk.monthIds.set(m, idSet);
    });
    if (bodyStr !== undefined) {
      if (bodyStr === null) { lsDel(BODY_KEY()); disk.sizes.delete(BODY_KEY()); disk.bad.delete(BODY_KEY()); disk.bodySig.clear(); disk.bodyDirty = false; disk.bodyOnDisk = false; }
      else {
        const e = put(BODY_KEY(), bodyStr);
        if (e) err = err || e;
        else {
          wroteNow.push(BODY_KEY());
          disk.bodySig.clear(); Object.keys(body).forEach(id => { if (isObj(body[id]) && okKey(id)) disk.bodySig.set(id, bodySig(body[id])); });
          disk.bodyDirty = false; disk.bodyOnDisk = true; disk.bad.delete(BODY_KEY());
        }
      }
    }
    if (moving && err && disk.fmt === 1) {
      /* The move to month keys didn't fit next to the old key: take back what this
         save wrote and keep the old format until the next start. */
      wroteNow.forEach(k => { lsDel(k); disk.sizes.delete(k); });
      disk.months.clear(); disk.monthIds.clear(); disk.daySig.clear(); disk.bodySig.clear(); disk.bodyOnDisk = false;
      disk.noMove = true;
      return persistOld();
    }
    let mainStr;
    try { mainStr = JSON.stringify({ v: 1, fmt: 2, updatedAt: num(MS.updatedAt), profiles: keptProfiles(MS.profiles), foods: isObj(MS.foods) ? MS.foods : {}, meals: isObj(MS.meals) ? MS.meals : {}, months: Array.from(disk.months).sort() }); }
    catch (e) { storeFail(e); return false; }
    const e = put(M.KEY, mainStr);
    if (e) err = err || e;
    else { disk.fmt = 2; disk.bad.delete(M.KEY); }
    if (err) { storeFail(err); sumBytes(); return false; }
    storeOk(); sumBytes();
    return true;
  }
  /* For code that edits a logged day in place (without M.log.*): marks that day's month to be written on the next save. */
  M.markDay = function (dateKey) { noteMonth(dateKey); };

  M.save = function () {
    const s = M.MS;
    s.updatedAt = M.now();
    persist();
    try { M.sync.push(); } catch (e) {}
    return s;
  };
  M.reset = function () {
    try {
      M.sync.dirty.days.clear(); M.sync.dirty.body.clear();
      Object.keys(M.MS.days).forEach(id => M.sync.deleted.days.add(id));
      Object.keys(M.MS.body).forEach(id => M.sync.deleted.body.add(id));
    } catch (e) {}
    diskMonths(Array.from(disk.months)).forEach(m => { lsDel(MONTH_KEY(m)); lsDel(M.KEY + ".damaged.d." + m); lsDel(M.KEY + ".damaged.d." + m + ".2"); });
    [M.KEY, BODY_KEY(), BAK_KEY()].concat(damagedKeys()).forEach(lsDel);
    M.MS = freshState();
    disk = freshDisk();
    M.storage.bakDay = null; M.storage.restoredFrom = null; M.storage.damaged = [];
    M.save();
    return M.MS;
  };

  /* ------------------------------------------------------------------- mode */
  M.mode = () => (M.MS.ui.mode === "macros" ? "macros" : "train");
  M.setMode = m => { M.MS.ui.mode = m === "macros" ? "macros" : "train"; M.saveUi(); return M.MS.ui.mode; };

  /* ----------------------------------------------------------------- person */
  function presetName(id) {
    try { if (typeof PRESETS !== "undefined" && PRESETS && PRESETS[id] && PRESETS[id].name) return PRESETS[id].name; } catch (e) {}
    return id === "kat" ? "Katerina" : "Nick";
  }
  function defaultProfile(id) {
    return {
      id, name: presetName(id), sex: null, age: null, heightIn: null, weightLb: null, goalWeightLb: null,
      activity: "moderate", pace: 0, units: "us", split: "highprotein", custom: { p: 30, c: 40, f: 30 },
      targets: { cal: 2000, p: 150, c: 200, f: 65, fiber: 28, water: 80 }, targetsManual: false,
      setupAt: null, snooze: { refresh60: 0, body14: 0 }, lastBody: 0, aiModel: "claude-sonnet-5-5"
    };
  }
  M.pid = function () {
    let p = null;
    try { if (typeof S !== "undefined" && S && S.profile) p = S.profile; } catch (e) {}
    return p || M.MS.ui.person || null;
  };
  /* The person's profile, filled with defaults. Only "nick" and "kat" are kept in
     M.MS.profiles; a profile nobody has set up or changed is not written to disk. */
  M.person = function (id) {
    if (id === undefined) id = M.pid();
    if (!id) return defaultProfile(null);
    if (!isPid(id)) return defaultProfile(okKey(String(id)) ? String(id) : null);
    const ps = M.MS.profiles;
    const d = defaultProfile(id);
    if (!isObj(ps[id])) { ps[id] = d; return d; }
    const p = ps[id];
    Object.keys(d).forEach(k => { if (p[k] === undefined) p[k] = d[k]; });
    p.id = id;
    if (!p.name) p.name = d.name;
    p.custom = Object.assign(d.custom, isObj(p.custom) ? p.custom : {});
    p.targets = Object.assign(d.targets, isObj(p.targets) ? p.targets : {});
    p.snooze = Object.assign(d.snooze, isObj(p.snooze) ? p.snooze : {});
    return p;
  };
  M.setPerson = id => { M.MS.ui.person = isPid(id) ? id : null; M.saveUi(); return M.MS.ui.person; };

  /* ------------------------------------------------------------------ units */
  const LB = 0.45359237, IN = 2.54, OZ = 29.5735295625;
  M.units = {
    lb2kg: lb => lb * LB, kg2lb: kg => kg / LB,
    in2cm: i => i * IN, cm2in: cm => cm / IN,
    oz2ml: oz => oz * OZ, ml2oz: ml => ml / OZ,
    fmtW(lb, units) {
      if (!isNum(lb)) return "—";
      return units === "metric" ? M.units.lb2kg(lb).toFixed(1) + " kg" : String(r1(lb)) + " lb";
    },
    fmtH(inch, units) {
      if (!isNum(inch)) return "—";
      if (units === "metric") return Math.round(M.units.in2cm(inch)) + " cm";
      let ft = Math.floor(inch / 12), i = Math.round(inch - ft * 12);
      if (i === 12) { ft++; i = 0; }
      return ft + "'" + i + '"';
    },
    parseH(str, units) {
      if (isNum(str)) return units === "metric" ? r1(M.units.cm2in(str)) : (str <= 8 ? r0(str * 12) : r1(str));
      const s = lc(str).trim(); if (!s) return null;
      const nums = s.match(/\d+(?:\.\d+)?/g); if (!nums) return null;
      if (units === "metric") return r1(M.units.cm2in(parseFloat(nums[0])));
      if (nums.length >= 2) return r1(parseFloat(nums[0]) * 12 + parseFloat(nums[1]));
      const n = parseFloat(nums[0]);
      if (/ft|'|feet|foot/.test(s) || (n <= 8 && !/in|"|inch/.test(s))) return r0(n * 12);
      return r1(n);
    },
    parseW(str, units) {
      const n = isNum(str) ? str : parseFloat(String(str == null ? "" : str));
      if (!isNum(n) || n <= 0) return null;
      return r1(units === "metric" ? M.units.kg2lb(n) : n);
    },
    fmtVol(oz, units) { if (!isNum(oz)) return "—"; return units === "metric" ? Math.round(M.units.oz2ml(oz)) + " ml" : String(r0(oz)) + " oz"; }
  };

  /* ------------------------------------------------------------------- calc */
  const DEFAULT_TARGETS = { cal: 2000, p: 150, c: 200, f: 65, fiber: 28, water: 80 };
  function normPct(c) {
    let p = num(c && c.p, 30), cc = num(c && c.c, 40), f = num(c && c.f, 30);
    let t = p + cc + f;
    if (!(t > 0)) { p = 30; cc = 40; f = 30; t = 100; }
    return { p: p * 100 / t, c: cc * 100 / t, f: f * 100 / t };
  }
  M.calc = {
    ACT: { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very: 1.9 },
    ACT_LABEL: { sedentary: "Desk job, little exercise", light: "Light exercise 1–3 days/wk", moderate: "Moderate exercise 3–5 days/wk", active: "Hard training 6–7 days/wk", very: "Athlete / physical job" },
    PACES: [-2, -1.5, -1, -0.5, 0, 0.5, 1],
    PACE_LABEL: { "-2": "Lose 2 lb/wk", "-1.5": "Lose 1.5 lb/wk", "-1": "Lose 1 lb/wk", "-0.5": "Lose 0.5 lb/wk", "0": "Maintain", "0.5": "Gain 0.5 lb/wk", "1": "Gain 1 lb/wk" },
    SPLITS: {
      highprotein: { label: "High protein", desc: "1 g protein per lb of bodyweight, 25% fat, rest carbs" },
      balanced: { label: "Balanced", desc: "30% protein · 40% carbs · 30% fat", p: 30, c: 40, f: 30 },
      lowcarb: { label: "Low carb", desc: "40% protein · 20% carbs · 40% fat", p: 40, c: 20, f: 40 },
      keto: { label: "Keto", desc: "25% protein · 5% carbs · 70% fat", p: 25, c: 5, f: 70 },
      custom: { label: "Custom", desc: "Set your own percentages" }
    },
    /* Mifflin-St Jeor. Inputs in lb / in / years. */
    bmr(p) {
      p = p || {};
      const kg = M.units.lb2kg(num(p.weightLb)), cm = M.units.in2cm(num(p.heightIn));
      return 10 * kg + 6.25 * cm - 5 * num(p.age) + (p.sex === "m" ? 5 : -161);
    },
    tdee(p) { p = p || {}; return M.calc.bmr(p) * (M.calc.ACT[p.activity] || M.calc.ACT.moderate); },
    calories(p) {
      p = p || {};
      const floor = p.sex === "m" ? 1500 : 1200;
      let cal = r0(M.calc.tdee(p) + num(p.pace) * 500);
      const floored = cal < floor;
      if (floored) cal = floor;
      return { cal, floored };
    },
    targets(p) {
      p = p || {};
      if (!M.calc.complete(p)) return Object.assign({}, DEFAULT_TARGETS, isObj(p.targets) ? p.targets : {});
      const cal = M.calc.calories(p).cal, w = num(p.weightLb);
      const split = p.split || "highprotein";
      let pr, c, f;
      if (split === "highprotein" || !M.calc.SPLITS[split]) {
        pr = r0(w);
        if (pr * 4 > cal * 0.4) pr = r0(cal * 0.4 / 4);
        f = r0(0.25 * cal / 9);
        c = Math.max(50, r0((cal - pr * 4 - f * 9) / 4));
      } else {
        const sp = split === "custom" ? normPct(p.custom) : M.calc.SPLITS[split];
        pr = r0(cal * sp.p / 100 / 4);
        c = r0(cal * sp.c / 100 / 4);
        f = r0(cal * sp.f / 100 / 9);
      }
      const fiber = r0(cal / 1000 * 14);
      const water = Math.max(64, r0(w * 0.5 / 8) * 8);
      return { cal, p: pr, c, f, fiber, water };
    },
    complete(p) { return !!(p && (p.sex === "m" || p.sex === "f") && num(p.age) > 0 && num(p.heightIn) > 0 && num(p.weightLb) > 0); },
    /* Recompute + store profile.targets unless the person edits them by hand. Saves. */
    applyTargets(p) {
      if (!p) return null;
      if (!p.targetsManual && M.calc.complete(p)) p.targets = M.calc.targets(p);
      M.save();
      return p.targets;
    }
  };

  /* -------------------------------------------------------------- food math */
  function normPer(per) { const o = {}; M.NUT.forEach(k => { o[k] = num(per && per[k]); }); return o; }
  M.foodMath = {
    blank() { const o = {}; M.NUT.forEach(k => { o[k] = 0; }); return o; },
    scale(per, servings) {
      const s = num(servings, 1);
      const o = {}; M.NUT.forEach(k => { o[k] = r1(num(per && per[k]) * s); });
      return o;
    },
    sum(list) {
      const o = M.foodMath.blank();
      (Array.isArray(list) ? list : []).forEach(it => {
        if (!it) return;
        const s = it.servings == null ? 1 : num(it.servings, 1);
        const per = isObj(it.per) ? it.per : it;
        M.NUT.forEach(k => { o[k] += num(per[k]) * s; });
      });
      M.NUT.forEach(k => { o[k] = r1(o[k]); });
      return o;
    },
    fromPer100(per100, grams) {
      const g = num(grams);
      const o = {}; M.NUT.forEach(k => { o[k] = r1(num(per100 && per100[k]) * g / 100); });
      return o;
    },
    pct(per) {
      const p = num(per && per.p) * 4, c = num(per && per.c) * 4, f = num(per && per.f) * 9, t = p + c + f;
      if (!(t > 0)) return { p: 0, c: 0, f: 0 };
      return { p: r0(p / t * 100), c: r0(c / t * 100), f: r0(f / t * 100) };
    }
  };

  /* ---------------------------------------------------------- cooked weight */
  /* Meat, fish, rice and pasta weigh differently raw (or dry) and cooked. Every
     amount of such a food reads raw first, cooked in parentheses:
     "6 oz raw (4.4 oz cooked)", "170 g raw (123 g cooked)", "2 oz dry (1 cup cooked)".
     Nutrition always comes from the profile of the state that was weighed. */
  const OZ_G = 28.349523125, LB_G = 453.59237;
  const WEIGHT_G = { oz: OZ_G, g: 1, lb: LB_G };
  const VOLUME = { cup: 1, tbsp: 1, tsp: 1 };
  const STEP = { oz: 0.5, g: 5, lb: 0.25 };
  function unitWord(u) {
    const w = lc(u).trim().split(/[\s,(]+/)[0];
    if (/^(oz|ounces?)$/.test(w)) return "oz";
    if (/^(g|grams?)$/.test(w)) return "g";
    if (/^(lb|lbs|pounds?)$/.test(w)) return "lb";
    if (/^cups?$/.test(w)) return "cup";
    if (/^(tbsp|tablespoons?)$/.test(w)) return "tbsp";
    if (/^(tsp|teaspoons?)$/.test(w)) return "tsp";
    return null;
  }
  function cookLite(c) {
    if (!isObj(c)) return null;
    const y = num(c.y);
    if (!(y > 0.05 && y < 20)) return null;
    return { y, word: c.word === "dry" ? "dry" : "raw" };
  }
  /* derive=true (custom foods): the one label profile is raw; cooked = raw ÷ y. */
  function normCook(c, per100, derive) {
    const o = cookLite(c); if (!o) return null;
    if (!derive && isObj(c.per100gCooked)) o.per100gCooked = normPer(c.per100gCooked);
    else if (isObj(per100)) { o.per100gCooked = {}; M.NUT.forEach(k => { o.per100gCooked[k] = r2(num(per100[k]) / o.y); }); }
    const alts = normAlts(c.alts); if (alts.length) o.alts = alts;
    return o;
  }
  function rawPer100(food) {
    if (!isObj(food)) return null;
    if (isObj(food.per100g)) return normPer(food.per100g);
    const g = num(food.serving && food.serving.g);
    if (g > 0 && isObj(food.per)) { const o = {}; M.NUT.forEach(k => { o[k] = num(food.per[k]) * 100 / g; }); return o; }
    return null;
  }
  const perAt = (p100, g) => { const o = {}; M.NUT.forEach(k => { o[k] = r4(num(p100 && p100[k]) * g / 100); }); return o; };
  function fracTxt(q) {
    const w = Math.floor(q + 1e-9), rem = q - w;
    const F = [[0, ""], [0.25, "1/4"], [1 / 3, "1/3"], [0.5, "1/2"], [2 / 3, "2/3"], [0.75, "3/4"], [1, ""]];
    for (const x of F) {
      if (Math.abs(rem - x[0]) <= 0.02) { const whole = x[0] === 1 ? w + 1 : w; return x[1] ? (whole ? whole + " " : "") + x[1] : String(whole); }
    }
    return String(r1(q));
  }
  function famOf(units) { return units === "metric" || units === "g" ? "g" : units === "lb" ? "lb" : "oz"; }
  function fmtWeight(g, fam) {
    if (fam === "g") return String(r0(g)) + " g";
    if (fam === "lb") return String(r2(g / LB_G)) + " lb";
    return String(r1(g / OZ_G)) + " oz";
  }
  const fmtVolume = (q, unit) => fracTxt(q) + " " + (unit === "cup" && q > 1.02 ? "cups" : unit);
  function personUnits() { try { const p = M.person(); return p && p.units === "metric" ? "metric" : "us"; } catch (e) { return "us"; } }
  function isWeightLabel(label) { const u = unitWord(M.parseServing(label).unit); return !!(u && WEIGHT_G[u]); }
  /* Grams of ONE servingLabel. The label wins ("4 oz (113 g)", "6 oz raw", "1 g"):
     describe items store g as the whole portion, entries store it per label. */
  function unitGrams(e) {
    if (!isObj(e)) return 0;
    const sv = M.parseServing(e.servingLabel || ""), u = unitWord(sv.unit);
    if (num(sv.g) > 0) return num(sv.g);
    if (u && WEIGHT_G[u]) return (sv.qty || 1) * WEIGHT_G[u];
    return num(e.g) > 0 ? num(e.g) : 0;
  }

  M.cook = {
    OZ: OZ_G, LB: LB_G, UNIT_G: WEIGHT_G,
    unitWord, fmtWeight, fmtVolume,
    stepFor: unit => STEP[unit] || 0.25,
    /* The food's cook info ({y, word, per100gCooked, alts}) or null. */
    of(food) { return isObj(food) && cookLite(food.cook) ? food.cook : null; },
    /* Old raw/cooked generic id → { id, state } (M.DB.alias from m-data.js). */
    alias(id) {
      try { const a = M.DB && M.DB.alias && M.DB.alias[id]; return isObj(a) && a.id ? { id: a.id, state: a.state === "cooked" ? "cooked" : "raw" } : null; }
      catch (e) { return null; }
    },
    /* Nutrition per 100 g in a state ("raw" also means dry). */
    per100(food, state) {
      const raw = rawPer100(food), c = M.cook.of(food);
      if (state !== "cooked" || !c) return raw;
      if (isObj(c.per100gCooked)) return normPer(c.per100gCooked);
      if (!raw) return null;
      const o = {}; M.NUT.forEach(k => { o[k] = raw[k] / num(c.y); }); return o;
    },
    perFor(food, state, grams) { const p = M.cook.per100(food, state); return p ? M.foodMath.fromPer100(p, grams) : null; },
    toRaw(grams, state, cook) { const c = cookLite(cook); return state === "cooked" ? (c ? grams / c.y : null) : grams; },
    toCooked(grams, state, cook) { const c = cookLite(cook); return state === "cooked" ? grams : (c ? grams * c.y : null); },
    /* label(170, "raw", {y:.7258}, "us") → "6 oz raw (4.4 oz cooked)"; "metric" → "170 g raw (123 g cooked)".
       units: "us" | "metric" | "oz" | "g" | "lb". opt.vol = {unit:"cup", g:158}: the weighed side was measured by volume. */
    label(grams, state, cook, units, opt) {
      opt = isObj(opt) ? opt : {};
      grams = Math.max(0, num(grams));
      state = state === "cooked" ? "cooked" : "raw";
      const c = cookLite(cook), fam = famOf(units);
      const vol = isObj(opt.vol) && num(opt.vol.g) > 0 && opt.vol.unit ? opt.vol : null;
      const side = (st, g) => (vol && st === state ? fmtVolume(g / num(vol.g), vol.unit) : fmtWeight(g, fam));
      if (!c) return side(state, grams) + " " + (state === "cooked" ? "cooked" : opt.word === "dry" ? "dry" : "raw");
      const raw = state === "cooked" ? grams / c.y : grams, cooked = state === "cooked" ? grams : grams * c.y;
      return side("raw", raw) + " " + c.word + " (" + side("cooked", cooked) + " cooked)";
    },
    /* The food's own serving, raw first: "4 oz raw (2.9 oz cooked)", "1/4 cup dry (4.6 oz cooked)". */
    servingLabel(food, units) {
      const c = M.cook.of(food); if (!c) return "";
      const sv = normServing(food.serving); if (!sv.g) return "";
      const u = unitWord(sv.unit);
      return M.cook.label(sv.g, "raw", c, units || personUnits(), { vol: u && VOLUME[u] ? { unit: u, g: sv.g / (sv.qty || 1) } : null });
    },
    /* Units for the servings screen: "oz raw", "oz cooked", "g raw", "g cooked", "lb raw", "lb cooked",
       plus volume units ("cup dry", "cup cooked") from the food's portions. Each option:
       { key, unit, state, label, g (grams of ONE unit), per (per ONE unit), step, vol }.
       opt.only = "cooked" · opt.weights = ["oz","g"] · opt.cooked100 / opt.raw100 override the profiles. */
    unitsFor(food, units, opt) {
      opt = isObj(opt) ? opt : {};
      const c = M.cook.of(food);
      const only = opt.only === "cooked" ? "cooked" : null;
      const raw100 = isObj(opt.raw100) ? normPer(opt.raw100) : rawPer100(food);
      const ck100 = isObj(opt.cooked100) ? normPer(opt.cooked100) : (c ? M.cook.per100(food, "cooked") : null);
      if (!ck100 || (!only && (!c || !raw100))) return [];
      const states = only ? ["cooked"] : ["raw", "cooked"];
      const word = c ? c.word : "raw";
      const out = [];
      const add = (unit, st, g, vol) => {
        const key = unit + "-" + st;
        if (!(g > 0) || out.some(o => o.key === key)) return;
        out.push({ key, unit, state: st, label: unit + " " + (st === "cooked" ? "cooked" : word), g: r4(g), per: perAt(st === "cooked" ? ck100 : raw100, g), step: vol ? 0.25 : (STEP[unit] || 0.25), vol: !!vol });
      };
      const ws = Array.isArray(opt.weights) ? opt.weights : famOf(units) === "g" ? ["g", "oz", "lb"] : ["oz", "g", "lb"];
      ws.forEach(u => { if (WEIGHT_G[u]) states.forEach(st => add(u, st, WEIGHT_G[u])); });
      const vols = (list, st) => {
        if (states.indexOf(st) < 0) return;
        const byU = {};
        (Array.isArray(list) ? list : []).forEach(a => {
          if (!isObj(a) || !(num(a.g) > 0)) return;
          const p = M.parseServing(a.label), u = unitWord(p.unit);
          if (!u || !VOLUME[u]) return;
          const q = p.qty || 1;
          if (!byU[u] || Math.abs(q - 1) < Math.abs(byU[u].q - 1)) byU[u] = { q, g: num(a.g) / q };
        });
        Object.keys(byU).forEach(u => add(u, st, byU[u].g, true));
      };
      if (opt.vol !== false && isObj(food)) {
        const sv = normServing(food.serving);
        vols(normAlts(food.alts).concat(sv.g ? [{ label: sv.qty + " " + sv.unit, g: sv.g }] : []), "raw");
        vols(c && c.alts, "cooked");
      }
      return out;
    },
    /* For an Entry / meal item / suggestion item: { state, cook, grams (in that state), fam, vol } or null.
       Old entries on merged ids get their state from M.DB.alias. */
    entryInfo(e) {
      if (!isObj(e)) return null;
      let state = e.state === "raw" || e.state === "cooked" ? e.state : null;
      let cook = cookLite(e.cook);
      if ((!state || !cook) && e.foodId) {
        const al = M.cook.alias(e.foodId), f = M.foods.get(e.foodId), fc = cookLite(f && f.cook);
        if (!state) state = al ? al.state : fc ? "raw" : null;
        if (!cook) cook = fc;
      }
      if (!state) return null;
      const sv = M.parseServing(e.servingLabel || ""), u = unitWord(sv.unit);
      const g1 = unitGrams(e);
      if (!(g1 > 0)) return null;
      return { state, cook, grams: g1 * Math.max(0, num(e.servings, 1)), fam: u && WEIGHT_G[u] ? u : null, vol: u && VOLUME[u] ? { unit: u, g: g1 / (sv.qty || 1) } : null };
    },
    /* "6 oz raw (4.4 oz cooked)" for an entry-like, "" when it isn't a cook food. */
    entryLabel(e, units) {
      const i = M.cook.entryInfo(e); if (!i) return "";
      return M.cook.label(i.grams, i.state, i.cook, i.fam || units || personUnits(), { vol: i.vol });
    },
    /* A copy of a cook food seen in its cooked state (serving / per / per100g /
       alts all cooked). For code that only knows plain foods, e.g. describe. */
    view(food, state) {
      const c = M.cook.of(food);
      if (!c || state !== "cooked") return food;
      const p100 = M.cook.per100(food, "cooked"); if (!p100) return food;
      const sv = normServing(food.serving), u = unitWord(sv.unit);
      const cAlts = normAlts(c.alts);
      let serving;
      if (u && WEIGHT_G[u] && sv.g) serving = { qty: sv.qty, unit: sv.unit, g: sv.g };
      else {
        const vol = cAlts.filter(a => a.g && !isWeightLabel(a.label));
        const a = vol.find(x => Math.abs((M.parseServing(x.label).qty || 1) - 1) < 1e-9) || vol[0] || cAlts[0];
        if (a) { const p = M.parseServing(a.label); serving = { qty: p.qty || 1, unit: p.unit || "serving", g: a.g }; }
        else serving = { qty: 100, unit: "g", g: 100 };
      }
      const wAlts = normAlts(food.alts).filter(a => isWeightLabel(a.label));
      return Object.assign({}, food, { serving, per: M.foodMath.fromPer100(p100, serving.g), per100g: normPer(p100), alts: wAlts.concat(cAlts.filter(a => !wAlts.some(w => lc(w.label) === lc(a.label)))), state: "cooked" });
    },
    /* Raw grams of a list of items (cooked amounts are turned back into raw with y). */
    rawTotal(items) {
      let t = 0;
      (Array.isArray(items) ? items : []).forEach(it => {
        if (!isObj(it)) return;
        const i = M.cook.entryInfo(it);
        if (i) { t += i.state === "cooked" ? (i.cook ? i.grams / i.cook.y : i.grams) : i.grams; return; }
        t += unitGrams(it) * Math.max(0, num(it.servings, 1));
      });
      return r1(t);
    },
    unitGrams,
    /* Batch meals: {y, word:"raw"} from the batch's raw and cooked grams (null when unknown). */
    batchCook(meal) {
      const b = meal && meal.batch; if (!isObj(b)) return null;
      const cg = num(b.cookedG), rg = num(b.rawG);
      return cg > 0 && rg > 0 ? cookLite({ y: r4(cg / rg), word: "raw" }) : null;
    },
    /* Nutrition of `grams` cooked grams of a batch meal. */
    batchPer(meal, grams) {
      const cg = num(meal && meal.batch && meal.batch.cookedG);
      return cg > 0 ? M.foodMath.scale(meal.per, num(grams) / cg) : M.foodMath.blank();
    },
    /* The display portion for batch macros: 4 oz (US) or 100 g (metric). */
    portionG: units => (famOf(units || personUnits()) === "g" ? 100 : 4 * OZ_G),
    batchSub(meal, units) { const cg = num(meal && meal.batch && meal.batch.cookedG); return cg > 0 ? "Batch · " + fmtWeight(cg, famOf(units || personUnits())) + " cooked" : ""; }
  };

  /* ------------------------------------------------------------ generic DB */
  /* M.DB.generic is loaded by m-data.js AFTER this file; always read lazily. */
  let gCache = null, gCacheSrc = null;
  function genericList() { try { const g = M.DB && M.DB.generic; return Array.isArray(g) ? g : []; } catch (e) { return []; } }
  function genericById(id) {
    const g = genericList();
    if (gCacheSrc !== g) { gCacheSrc = g; gCache = new Map(); g.forEach(f => { if (f && f.id) gCache.set(f.id, f); }); }
    const f = gCache.get(id);
    if (f) return f;
    const a = M.cook.alias(id);
    return a ? gCache.get(a.id) || null : null;
  }

  /* ------------------------------------------------------------------ foods */
  function normServing(s) {
    s = isObj(s) ? s : {};
    return { qty: num(s.qty, 1) || 1, unit: String(s.unit || "serving").trim() || "serving", g: num(s.g) > 0 ? num(s.g) : null };
  }
  function normAlts(a) {
    return (Array.isArray(a) ? a : []).filter(x => x && x.label).map(x => ({ label: String(x.label), g: num(x.g) > 0 ? num(x.g) : null }));
  }
  function normCode(c) { return String(c == null ? "" : c).replace(/\D/g, "").replace(/^0+/, ""); }
  function normFood(f) {
    f = isObj(f) ? f : {};
    const now = M.now();
    const o = Object.assign({}, f);
    o.id = o.id || M.uid();
    o.name = String(o.name || "Food").trim();
    o.brand = String(o.brand || "").trim();
    o.barcode = String(o.barcode || "").trim();
    o.source = o.source || "custom";
    o.serving = normServing(o.serving);
    o.per = normPer(o.per);
    o.per100g = isObj(o.per100g) ? normPer(o.per100g) : null;
    o.alts = normAlts(o.alts);
    o.cook = normCook(o.cook, o.per100g, o.source !== "generic");
    if (!o.cook) delete o.cook;
    o.createdAt = num(o.createdAt) || now;
    o.updatedAt = now;
    o.uses = num(o.uses);
    o.lastUsed = num(o.lastUsed);
    o.pid = o.pid || M.pid() || null;
    return o;
  }
  M.foods = {
    add(food) { const f = normFood(food); M.MS.foods[f.id] = f; M.save(); return f; },
    update(id, patch) {
      const f = M.MS.foods[id]; if (!f) return null;
      const merged = normFood(Object.assign({}, f, isObj(patch) ? patch : {}, { id }));
      merged.createdAt = f.createdAt;
      M.MS.foods[id] = merged; M.save(); return merged;
    },
    remove(id) { if (!M.MS.foods[id]) return false; delete M.MS.foods[id]; M.save(); return true; },
    get(id) { return M.MS.foods[id] || genericById(id); },   /* old raw/cooked generic ids resolve to the merged food */
    list() {
      return Object.values(M.MS.foods).sort((a, b) => num(b.lastUsed) - num(a.lastUsed) || num(b.updatedAt) - num(a.updatedAt) || lc(a.name).localeCompare(lc(b.name)));
    },
    findByBarcode(code) {
      const c = normCode(code); if (!c) return null;
      return Object.values(M.MS.foods).find(f => normCode(f.barcode) === c) || null;
    },
    touch(id) { const f = touchFood(id); if (f) M.save(); return f; }
  };
  /* uses / lastUsed without a save (the caller saves once) */
  function touchFood(id) { const f = M.MS.foods[id]; if (!isObj(f)) return null; f.uses = num(f.uses) + 1; f.lastUsed = M.now(); return f; }
  function touchMeal(id) { const m = M.MS.meals[id]; if (!isObj(m)) return null; m.uses = num(m.uses) + 1; m.lastUsed = M.now(); return m; }

  /* ------------------------------------------------------------------ meals */
  /* state/cook on entries and meal items: old merged ids → the new id + their
     state; a cook food without a state was logged raw (its default); cook is
     trimmed to {y, word}. Entries without a valid state carry neither field. */
  function cookFields(o) {
    const al = o.foodId ? M.cook.alias(o.foodId) : null;
    const has = () => o.state === "raw" || o.state === "cooked";
    if (al) { o.foodId = al.id; if (!has()) o.state = al.state; }
    let ck = cookLite(o.cook);
    if (o.foodId && (!ck || !has())) {
      const f = M.foods.get(o.foodId), fc = cookLite(f && f.cook);
      if (fc) { if (!ck) ck = fc; if (!has()) o.state = "raw"; }
    }
    if (has()) { if (ck) o.cook = ck; else delete o.cook; }
    else { delete o.state; delete o.cook; }
    return o;
  }
  function normItem(it) {
    it = isObj(it) ? it : {};
    const o = Object.assign({}, it);
    cookFields(o);
    o.id = o.id || M.uid();
    o.name = String(o.name || "Item").trim();
    o.brand = String(o.brand || "").trim();
    o.servings = num(o.servings, 1) > 0 ? num(o.servings, 1) : 1;
    o.servingLabel = o.servingLabel || (isObj(o.serving) ? M.fmtServing(o.serving) : "1 serving");
    o.g = num(o.g) > 0 ? num(o.g) : null;
    o.per = normPer(o.per);
    delete o.slot;
    if (!o.foodId) delete o.foodId;
    if (!o.mealId) delete o.mealId;
    return o;
  }
  function normMeal(m) {
    m = isObj(m) ? m : {};
    const now = M.now();
    const o = Object.assign({}, m);
    o.id = o.id || M.uid();
    o.name = String(o.name || "Meal").trim();
    o.desc = String(o.desc || "").trim();
    o.slot = M.isSlot(o.slot) ? o.slot : "Any";
    o.items = (Array.isArray(o.items) ? o.items : []).map(normItem);
    o.servingsMade = num(o.servingsMade, 1) > 0 ? num(o.servingsMade, 1) : 1;
    /* batch: per = the whole batch; rawG always recomputed from the items */
    if (isObj(o.batch) && num(o.batch.cookedG) > 0) { o.servingsMade = 1; o.batch = { cookedG: r1(num(o.batch.cookedG)), rawG: M.cook.rawTotal(o.items) }; }
    else delete o.batch;
    o.per = M.meals.computePer(o);
    o.createdAt = num(o.createdAt) || now;
    o.updatedAt = now;
    o.uses = num(o.uses);
    o.lastUsed = num(o.lastUsed);
    o.pid = o.pid || M.pid() || null;
    return o;
  }
  const byUse = (a, b) => num(b.lastUsed) - num(a.lastUsed) || num(b.uses) - num(a.uses) || lc(a.name).localeCompare(lc(b.name));
  M.meals = {
    computePer(meal) {
      const n = num(meal && meal.servingsMade, 1) > 0 ? num(meal.servingsMade, 1) : 1;
      const tot = M.foodMath.sum((meal && meal.items) || []);
      const o = {}; M.NUT.forEach(k => { o[k] = r1(tot[k] / n); });
      return o;
    },
    add(meal) { const m = normMeal(meal); M.MS.meals[m.id] = m; M.save(); return m; },
    update(id, patch) {
      const m = M.MS.meals[id]; if (!m) return null;
      const merged = normMeal(Object.assign({}, m, isObj(patch) ? patch : {}, { id }));
      merged.createdAt = m.createdAt;
      M.MS.meals[id] = merged; M.save(); return merged;
    },
    remove(id) { if (!M.MS.meals[id]) return false; delete M.MS.meals[id]; M.save(); return true; },
    get(id) { return M.MS.meals[id] || null; },
    list(slot) {
      let arr = Object.values(M.MS.meals);
      if (slot) arr = arr.filter(m => m.slot === slot || m.slot === "Any");
      return arr.sort(byUse);
    },
    touch(id) { const m = touchMeal(id); if (m) M.save(); return m; }
  };

  /* ------------------------------------------------------------------- days */
  const dayId = (pid, date) => pid + "|" + date;
  function blankDay(id, pid, date) { return { id, pid, date, entries: [], water: 0, note: "", updatedAt: 0 }; }
  /* Read-only lookup: never creates. */
  M.dayOf = (dateKey, pid) => {
    pid = pid || M.pid(); if (!pid) return null;
    const d = M.MS.days[dayId(pid, dateKey || M.today())];
    if (d && !Array.isArray(d.entries)) d.entries = [];
    return d || null;
  };
  /* Creates the Day in MS.days if missing. Does NOT save. */
  M.day = (dateKey, pid) => {
    pid = pid || M.pid(); dateKey = dateKey || M.today();
    if (!pid) return blankDay(null, null, dateKey);
    const id = dayId(pid, dateKey);
    let d = M.MS.days[id];
    if (!isObj(d)) d = M.MS.days[id] = blankDay(id, pid, dateKey);
    if (!Array.isArray(d.entries)) d.entries = [];
    return d;
  };
  function touchDay(d) { d.updatedAt = M.now(); if (d.id) M.sync.dirty.days.add(d.id); }

  /* -------------------------------------------------------------------- log */
  function normEntry(e) {
    e = isObj(e) ? e : {};
    const o = cookFields(Object.assign({}, e));
    let food = o.foodId ? M.foods.get(o.foodId) : null;
    if (food && o.state === "cooked") food = M.cook.view(food, "cooked");   /* fills below use the weighed state */
    o.id = o.id || M.uid();
    o.slot = M.isSlot(o.slot) ? o.slot : M.defaultSlot();
    o.name = String(o.name || (food && food.name) || "Food").trim();
    o.brand = String(o.brand || (food && food.brand) || "").trim();
    o.servings = num(o.servings, 1) > 0 ? num(o.servings, 1) : 1;
    if (!o.servingLabel) {
      if (isObj(o.serving)) { o.servingLabel = M.fmtServing(o.serving); if (o.g == null) o.g = o.serving.g; }
      else if (food) { o.servingLabel = M.fmtServing(food.serving); if (o.g == null) o.g = food.serving.g; }
      else o.servingLabel = "1 serving";
    }
    o.g = num(o.g) > 0 ? num(o.g) : null;
    o.per = normPer(isObj(o.per) ? o.per : (food ? food.per : null));
    o.at = num(o.at) || M.now();
    if (!o.foodId) delete o.foodId;
    if (!o.mealId) delete o.mealId;
    return o;
  }
  M.log = {
    add(dateKey, entry) {
      const d = M.day(dateKey);
      const e = normEntry(entry);
      d.entries.push(e);
      if (e.foodId) touchFood(e.foodId);
      if (e.mealId) touchMeal(e.mealId);
      touchDay(d); M.save();   /* one save per action */
      return e;
    },
    update(dateKey, entryId, patch) {
      const d = M.dayOf(dateKey); if (!d) return null;
      const i = d.entries.findIndex(x => x.id === entryId); if (i < 0) return null;
      patch = isObj(patch) ? Object.assign({}, patch) : {};
      if (patch.slot !== undefined && !M.isSlot(patch.slot)) delete patch.slot;
      const merged = normEntry(Object.assign({}, d.entries[i], patch, { id: entryId }));
      d.entries[i] = merged;
      touchDay(d); M.save();
      return merged;
    },
    remove(dateKey, entryId) {
      const d = M.dayOf(dateKey); if (!d) return false;
      const n = d.entries.length;
      d.entries = d.entries.filter(x => x.id !== entryId);
      if (d.entries.length === n) return false;
      touchDay(d); M.save();
      return true;
    },
    move(dateKey, entryId, slot) { if (!M.isSlot(slot)) return null; return M.log.update(dateKey, entryId, { slot }); },
    /* opt.grams (+ opt.unit "oz"|"g"|"lb") logs a portion of a batch meal by cooked
       weight: per = the batch per one unit, so later edits to the meal never
       change this day. */
    addMeal(dateKey, mealId, servings, slot, opt) {
      const m = M.MS.meals[mealId]; if (!m) return [];
      const s = M.isSlot(slot) ? slot : (M.isSlot(m.slot) ? m.slot : M.defaultSlot());
      if (isObj(m.batch) && num(m.batch.cookedG) > 0 && isObj(opt) && num(opt.grams) > 0) {
        const u = WEIGHT_G[opt.unit] ? opt.unit : "oz", ug = WEIGHT_G[u], cg = num(m.batch.cookedG);
        const per = {}; M.NUT.forEach(k => { per[k] = r4(num(m.per[k]) * ug / cg); });
        return [M.log.add(dateKey, { slot: s, name: m.name, brand: "", servings: r4(num(opt.grams) / ug), servingLabel: "1 " + u + " cooked", g: r4(ug), per, mealId, state: "cooked", cook: M.cook.batchCook(m) })];
      }
      const e = M.log.add(dateKey, { slot: s, name: m.name, brand: "", servings: num(servings, 1) > 0 ? num(servings, 1) : 1, servingLabel: "1 serving", g: null, per: m.per, mealId });
      return [e];
    },
    copySlot(fromKey, toKey, slot) {
      const src = M.dayOf(fromKey); if (!src) return [];
      const items = src.entries.filter(x => x.slot === slot); if (!items.length) return [];
      const d = M.day(toKey);
      const out = items.map(x => { const c = Object.assign(M.cp(x), { id: M.uid(), at: M.now() }); d.entries.push(c); return c; });
      touchDay(d); M.save();
      return out;
    },
    clearSlot(dateKey, slot) {
      const d = M.dayOf(dateKey); if (!d) return 0;
      const n = d.entries.length;
      d.entries = d.entries.filter(x => x.slot !== slot);
      const removed = n - d.entries.length;
      if (removed) { touchDay(d); M.save(); }
      return removed;
    },
    slotEntries(dateKey, slot, pid) { const d = M.dayOf(dateKey, pid); return d ? d.entries.filter(x => x.slot === slot) : []; },
    totals(dateKey, pid) { const d = M.dayOf(dateKey, pid); return M.foodMath.sum(d ? d.entries : []); },
    slotTotals(dateKey, slot, pid) { return M.foodMath.sum(M.log.slotEntries(dateKey, slot, pid)); },
    setWater(dateKey, oz) { const d = M.day(dateKey); d.water = Math.max(0, r0(num(oz))); touchDay(d); M.save(); return d.water; },
    setNote(dateKey, note) { const d = M.day(dateKey); d.note = String(note || ""); touchDay(d); M.save(); return d.note; },
    loggedDays(pid) {
      pid = pid || M.pid(); if (!pid) return [];
      return Object.values(M.MS.days).filter(d => d && d.pid === pid && Array.isArray(d.entries) && d.entries.length).map(d => d.date).sort();
    }
  };

  /* ------------------------------------------------------------------- body */
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  M.body = {
    /* {date?, w?, rhr?, pid?} — w in lb. Merges into the existing record for that day. */
    add(rec) {
      rec = isObj(rec) ? rec : {};
      const pid = rec.pid || M.pid(); if (!pid) return null;
      const date = rec.date || M.today();
      const id = dayId(pid, date);
      const w = rec.w == null || rec.w === "" ? null : num(rec.w, null);
      const rhr = rec.rhr == null || rec.rhr === "" ? null : num(rec.rhr, null);
      const hasW = w != null && w > 0, hasR = rhr != null && rhr > 0;
      if (!hasW && !hasR) return M.MS.body[id] || null;
      const b = isObj(M.MS.body[id]) ? M.MS.body[id] : { id, pid, date, w: null, rhr: null, at: 0 };
      if (hasW) b.w = r1(w);
      if (hasR) b.rhr = r0(rhr);
      b.at = M.now();
      M.MS.body[id] = b;
      M.sync.dirty.body.add(id);
      const p = M.person(pid);
      p.lastBody = M.now();
      if (hasW) { const latest = M.body.latest(pid, "w"); if (!latest || latest.date <= date) p.weightLb = b.w; }
      M.save();
      return b;
    },
    remove(date, pid) {
      pid = pid || M.pid(); if (!pid) return false;
      const id = dayId(pid, date); if (!M.MS.body[id]) return false;
      delete M.MS.body[id];
      M.sync.dirty.body.delete(id); M.sync.deleted.body.add(id);
      M.save();
      return true;
    },
    list(pid) { pid = pid || M.pid(); return Object.values(M.MS.body).filter(b => b && b.pid === pid).sort(byDate); },
    latest(pid, field) {
      const arr = M.body.list(pid);
      for (let i = arr.length - 1; i >= 0; i--) { const v = arr[i][field]; if (isNum(v)) return { date: arr[i].date, value: v }; }
      return null;
    },
    series(pid, field, days) {
      let arr = M.body.list(pid).filter(b => isNum(b[field]));
      if (num(days) > 0) { const from = M.addDays(M.today(), -(num(days) - 1)); arr = arr.filter(b => b.date >= from); }
      return arr.map(b => ({ date: b.date, v: b[field] }));
    },
    /* Trailing 7-calendar-day average at each point. */
    avg7(series) {
      const s = (Array.isArray(series) ? series : []).slice().sort(byDate);
      const out = [];
      let j = 0;
      for (let i = 0; i < s.length; i++) {
        while (j < i && M.daysBetween(s[j].date, s[i].date) > 6) j++;
        let sum = 0; for (let k = j; k <= i; k++) sum += num(s[k].v);
        out.push({ date: s[i].date, v: r2(sum / (i - j + 1)) });
      }
      return out;
    },
    /* lb/wk: mean of the last 7 days vs mean of the first 7 days of the 28-day
       window ending at the latest weigh-in, divided by the weeks between the
       two groups' mean dates. null until there is ~2 weeks of data. */
    ratePerWeek(pid) {
      const all = M.body.series(pid, "w", 0); if (all.length < 4) return null;
      const end = all[all.length - 1].date, start = M.addDays(end, -27);
      const win = all.filter(x => x.date >= start); if (win.length < 4) return null;
      const a = win.filter(x => M.daysBetween(win[0].date, x.date) <= 6);
      const b = win.filter(x => M.daysBetween(x.date, end) <= 6);
      if (!a.length || !b.length) return null;
      const mean = arr => arr.reduce((t, x) => t + num(x.v), 0) / arr.length;
      const mDate = arr => arr.reduce((t, x) => t + M.daysBetween(start, x.date), 0) / arr.length;
      const gap = mDate(b) - mDate(a); if (gap < 7) return null;
      return r2((mean(b) - mean(a)) / gap * 7);
    }
  };

  /* ---------------------------------------------------------------- recents */
  M.recents = function (pid, n) {
    pid = pid || M.pid(); n = num(n, 20) || 20;
    if (!pid) return [];
    const from = M.addDays(M.today(), -59);
    const map = new Map();
    const snap = e => {
      const o = { servingLabel: e.servingLabel || "1 serving", servings: num(e.servings, 1) || 1, g: num(e.g) > 0 ? num(e.g) : null, per: normPer(e.per), foodId: e.foodId || null, mealId: e.mealId || null, lastUsed: num(e.at) };
      if (e.state === "raw" || e.state === "cooked") { o.state = e.state; if (cookLite(e.cook)) o.cook = cookLite(e.cook); }
      return o;
    };
    Object.values(M.MS.days).forEach(d => {
      if (!d || d.pid !== pid || d.date < from || !Array.isArray(d.entries)) return;
      d.entries.forEach(e => {
        if (!e || !e.name) return;
        const k = lc(e.name) + "|" + lc(e.brand);
        const cur = map.get(k);
        if (!cur) map.set(k, Object.assign({ name: e.name, brand: e.brand || "", count: 1 }, snap(e)));
        else { cur.count++; if (num(e.at) >= cur.lastUsed) Object.assign(cur, { name: e.name, brand: e.brand || "" }, snap(e)); }
      });
    });
    return Array.from(map.values()).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, n);
  };

  /* ----------------------------------------------------------------- search */
  const WORD_SPLIT = /[^\p{L}\p{N}%]+/u;
  function tokens(q) { return lc(q).split(WORD_SPLIT).filter(Boolean); }
  /* -1 = no match; otherwise higher is better. Every token must hit name, brand, kw or extra.
     kw = words that count like name words ("raw" / "cooked" on meat, rice, pasta). */
  function scoreText(toks, name, brand, extra, kw) {
    const n = lc(name), b = lc(brand), x = lc(extra);
    const words = n.split(WORD_SPLIT).filter(Boolean), kws = lc(kw).split(WORD_SPLIT).filter(Boolean);
    let s = 0;
    for (const t of toks) {
      if (n === t) s += 60;
      else if (n.startsWith(t)) s += 30;
      else if (words.some(w => w.startsWith(t)) || kws.some(w => w.startsWith(t))) s += 20;
      else if (n.includes(t)) s += 10;
      else if (b.includes(t)) s += 6;
      else if (x.includes(t)) s += 3;
      else return -1;
    }
    return s - Math.min(10, n.length / 8);
  }
  const usesBonus = o => Math.min(10, Math.log2(num(o.uses) + 1) * 2);
  /* Cook foods also answer to "raw" / "dry" / "cooked" ("cooked chicken", "dry pasta"). */
  const cookWords = f => { const c = M.cook.of(f); return c ? (c.word === "dry" ? "dry uncooked cooked" : "raw cooked") : ""; };
  function foodResult(kind, f) {
    const serving = normServing(f.serving);
    const r = { kind, id: f.id, name: f.name, brand: f.brand || "", sub: M.fmtServing(serving), per: normPer(f.per), serving, alts: normAlts(f.alts), foodId: f.id, mealId: null, ref: f };
    const c = M.cook.of(f);
    if (c) { r.cook = c; r.state = "raw"; const l = M.cook.servingLabel(f); if (l) r.sub = l; }
    return r;
  }
  function mealResult(m) {
    const r = { kind: "meal", id: m.id, name: m.name, brand: "", desc: m.desc || "", slot: m.slot, sub: "1 serving", per: normPer(m.per), serving: { qty: 1, unit: "serving", g: null }, alts: [], foodId: null, mealId: m.id, ref: m };
    if (isObj(m.batch) && num(m.batch.cookedG) > 0) {
      const u = personUnits(), pg = M.cook.portionG(u);
      Object.assign(r, { batch: true, portionG: pg, per: M.cook.batchPer(m, pg), sub: M.cook.batchSub(m, u), portion: "per " + fmtWeight(pg, famOf(u)) });
    }
    return r;
  }
  function recentResult(rc) {
    const f = rc.foodId ? M.foods.get(rc.foodId) : null;
    const serving = f ? normServing(f.serving) : Object.assign(M.parseServing(rc.servingLabel), rc.g ? { g: rc.g } : {});
    const r = { kind: "recent", id: "r:" + lc(rc.name) + "|" + lc(rc.brand), name: rc.name, brand: rc.brand || "", sub: rc.servingLabel || "1 serving", per: normPer(rc.per), serving, alts: f ? normAlts(f.alts) : [], foodId: rc.foodId || null, mealId: rc.mealId || null, ref: rc };
    if (rc.state) { r.state = rc.state; r.cook = rc.cook || (f && cookLite(f.cook)) || null; }
    return r;
  }
  /* opt.recents === false / opt.meals === false leave those out (the add sheet's Foods list),
     so a food already logged still shows up as a food instead of being folded into its recent. */
  M.search = function (q, opt) {
    opt = isObj(opt) ? opt : {};
    const pid = opt.pid || M.pid(), slot = opt.slot, limit = num(opt.limit, 40) || 40;
    const wantRecents = opt.recents !== false, wantMeals = opt.meals !== false;
    const toks = tokens(q);
    const out = [], seen = new Set();
    /* Dedupe: same kind+name+brand, or a food/meal a recent already points at. */
    const push = r => {
      const keys = [r.kind + "|" + lc(r.name) + "|" + lc(r.brand)];
      if (r.foodId) keys.push("f:" + r.foodId);
      if (r.mealId) keys.push("m:" + r.mealId);
      if (keys.some(k => seen.has(k))) return false;
      keys.forEach(k => seen.add(k));
      out.push(r);
      return true;
    };
    if (!toks.length) {
      if (wantRecents) M.recents(pid, 10).forEach(rc => push(recentResult(rc)));
      const meals = wantMeals ? M.meals.list() : [];
      if (slot) meals.filter(m => m.slot === slot).forEach(m => push(mealResult(m)));
      meals.filter(m => m.slot === "Any").forEach(m => push(mealResult(m)));
      meals.forEach(m => push(mealResult(m)));
      M.foods.list().forEach(f => push(foodResult("food", f)));
      return out.slice(0, limit);
    }
    const qn = lc(q).trim();
    const scored = [];
    const consider = (r, bonus, extra, kw) => {
      const s = scoreText(toks, r.name, r.brand, extra, kw);
      if (s < 0) return;
      scored.push({ r, s: s + bonus + (lc(r.name) === qn ? 40 : 0) });
    };
    if (wantRecents) M.recents(pid, 40).forEach((rc, i) => consider(recentResult(rc), 25 + Math.max(0, 10 - i / 4)));
    if (wantMeals) M.meals.list().forEach(m => consider(mealResult(m), 15 + (slot && m.slot === slot ? 15 : m.slot === "Any" ? 6 : 0) + usesBonus(m), m.desc));
    M.foods.list().forEach(f => consider(foodResult("food", f), 10 + usesBonus(f), "", cookWords(f)));
    /* plain meat / fish / rice / pasta (the cook foods) edge out mixed dishes that share a word */
    genericList().forEach(f => { if (f && f.name) consider(foodResult("generic", f), M.cook.of(f) ? 3 : 0, "", cookWords(f)); });
    scored.sort((a, b) => b.s - a.s || lc(a.r.name).localeCompare(lc(b.r.name)));
    for (const x of scored) { if (out.length >= limit) break; push(x.r); }
    return out;
  };

  /* --------------------------------------------------------------- checkins */
  M.checkins = {
    due(pid) {
      pid = pid || M.pid(); if (!pid) return null;
      const p = M.person(pid), now = M.now(), sn = p.snooze || {};
      if (!p.setupAt) return "setup";
      if (now - num(p.setupAt) > 60 * DAY && num(sn.refresh60) < now) return "refresh60";
      /* Setup collects a weight, so it counts as the first body check-in. */
      const lastBody = Math.max(num(p.lastBody), num(p.setupAt));
      if (now - lastBody > 14 * DAY && num(sn.body14) < now) return "body14";
      return null;
    },
    snooze(pid, kind, days) {
      const p = M.person(pid || M.pid());
      if (!isObj(p.snooze)) p.snooze = { refresh60: 0, body14: 0 };
      p.snooze[kind] = M.now() + num(days, 7) * DAY;
      M.save();
      return p.snooze[kind];
    },
    done(pid, kind) {
      const p = M.person(pid || M.pid()), now = M.now();
      if (!isObj(p.snooze)) p.snooze = { refresh60: 0, body14: 0 };
      if (kind === "setup") { p.setupAt = now; if (!p.lastBody) p.lastBody = now; }
      else if (kind === "refresh60") { p.setupAt = now; p.snooze.refresh60 = 0; }
      else if (kind === "body14") { p.lastBody = now; p.snooze.body14 = 0; }
      M.save();
      return p;
    }
  };

  /* ----------------------------------------------------- streak + week stats */
  M.streak = function (pid) {
    pid = pid || M.pid(); if (!pid) return 0;
    const set = new Set(M.log.loggedDays(pid));
    let d = M.today();
    if (!set.has(d)) { d = M.addDays(d, -1); if (!set.has(d)) return 0; }
    let n = 0;
    while (set.has(d)) { n++; d = M.addDays(d, -1); }
    return n;
  };
  M.weekSummary = function (pid, weeksBack) {
    pid = pid || M.pid(); weeksBack = Math.max(0, num(weeksBack));
    const end = M.addDays(M.today(), -7 * weeksBack), start = M.addDays(end, -6);
    const p = M.person(pid);
    const daily = [], acc = { cal: 0, p: 0, c: 0, f: 0 };
    let logged = 0;
    for (let i = 0; i < 7; i++) {
      const date = M.addDays(start, i);
      const d = pid ? M.dayOf(date, pid) : null;
      const has = !!(d && d.entries.length);
      const t = has ? M.foodMath.sum(d.entries) : M.foodMath.blank();
      if (has) { logged++; acc.cal += t.cal; acc.p += t.p; acc.c += t.c; acc.f += t.f; }
      daily.push({ date, logged: has, cal: t.cal, p: t.p, c: t.c, f: t.f });
    }
    const avg = k => (logged ? r0(acc[k] / logged) : 0);
    return { days: 7, start, end, logged, avgCal: avg("cal"), avgP: avg("p"), avgC: avg("c"), avgF: avg("f"), daily, target: M.cp(p.targets) };
  };

  /* ---------------------------------------------------------- export/import */
  function mergeById(dst, src, tsKey) {
    Object.keys(isObj(src) ? src : {}).forEach(id => {
      const a = dst[id], b = src[id];
      if (!isObj(b)) return;
      if (!a || num(b[tsKey]) >= num(a[tsKey])) dst[id] = b;
    });
  }
  M.export = () => M.cp(M.MS);
  M.import = function (obj) {
    if (!isObj(obj) || obj.v !== 1) return false;
    const cur = M.MS, inc = shape(M.cp(obj));
    const newer = num(inc.updatedAt) >= num(cur.updatedAt);
    Object.keys(inc.profiles).forEach(id => { if (!cur.profiles[id] || newer) cur.profiles[id] = inc.profiles[id]; });
    mergeById(cur.foods, inc.foods, "updatedAt");
    mergeById(cur.meals, inc.meals, "updatedAt");
    mergeById(cur.days, inc.days, "updatedAt");
    mergeById(cur.body, inc.body, "at");
    if (!cur.ui.person && inc.ui.person) cur.ui.person = inc.ui.person;
    M.sync.markAll();
    M.save();
    return true;
  };

  /* ------------------------------------------------------------------- sync */
  /* Mirror to the Claude artifact db, only when opened inside claude.ai.
     Doc "macros/state" = {v, updatedAt, ui, profiles, foods, meals};
     collections "mdays" (Day docs) and "mbody" (Body docs). Newer updatedAt
     wins; collections are unioned. Silent no-op everywhere else. */
  let db = null, pushT = null;
  const docId = id => String(id).replace(/[^A-Za-z0-9_.-]/g, "_");
  const PUSH_MAX = 60;
  function rerender() {
    try {
      if (M.ui && typeof M.ui.rerender === "function") M.ui.rerender();
      else if (typeof render === "function") render();
    } catch (e) {}
  }
  function mergeState(r) {
    const cur = M.MS;
    const newer = num(r.updatedAt) > num(cur.updatedAt);
    Object.keys(isObj(r.profiles) ? r.profiles : {}).forEach(id => { if (newer || !cur.profiles[id]) cur.profiles[id] = r.profiles[id]; });
    mergeById(cur.foods, r.foods, "updatedAt");
    mergeById(cur.meals, r.meals, "updatedAt");
    if (!cur.ui.person && isObj(r.ui) && r.ui.person) cur.ui.person = r.ui.person;
    if (newer) cur.updatedAt = num(r.updatedAt);
  }
  M.sync = {
    on: false,
    db: null,
    dirty: { days: new Set(), body: new Set() },
    deleted: { days: new Set(), body: new Set() },
    markAll() {
      Object.keys(M.MS.days).forEach(id => M.sync.dirty.days.add(id));
      Object.keys(M.MS.body).forEach(id => M.sync.dirty.body.add(id));
    },
    async init() {
      try {
        if (typeof window === "undefined" || !(window.claude && typeof window.claude.use === "function")) return false;
        db = await window.claude.use("db");
        if (!db) return false;
        M.sync.on = true; M.sync.db = db;
        const st = await db.doc("macros/state").get();
        if (st && st.exists) { const r = st.data(); if (isObj(r) && r.v === 1) mergeState(r); }
        const cloudDays = new Set(), cloudBody = new Set();
        const qd = await db.collection("mdays").limit(2000).get();
        (qd && qd.docs ? qd.docs : []).forEach(d => {
          const r = d.data(); if (!isObj(r) || !r.id) return;
          cloudDays.add(r.id);
          const l = M.MS.days[r.id];
          if (!l || num(r.updatedAt) > num(l.updatedAt)) M.MS.days[r.id] = r;
        });
        const qb = await db.collection("mbody").limit(2000).get();
        (qb && qb.docs ? qb.docs : []).forEach(d => {
          const r = d.data(); if (!isObj(r) || !r.id) return;
          cloudBody.add(r.id);
          const l = M.MS.body[r.id];
          if (!l || num(r.at) > num(l.at)) M.MS.body[r.id] = r;
        });
        Object.keys(M.MS.days).forEach(id => { if (!cloudDays.has(id)) M.sync.dirty.days.add(id); });
        Object.keys(M.MS.body).forEach(id => { if (!cloudBody.has(id)) M.sync.dirty.body.add(id); });
        persist();
        M.sync.pushNow();
        rerender();
        return true;
      } catch (e) { return false; }
    },
    push() {
      if (!db) return;
      clearTimeout(pushT);
      pushT = setTimeout(() => { try { M.sync.pushNow(); } catch (e) {} }, 800);
      if (pushT && typeof pushT.unref === "function") pushT.unref();
    },
    pushNow() {
      if (!db) return;
      try {
        const s = M.MS;
        db.doc("macros/state").set({ v: 1, updatedAt: s.updatedAt, ui: s.ui, profiles: s.profiles, foods: s.foods, meals: s.meals }).catch(noop);
        let n = 0;
        for (const id of Array.from(M.sync.dirty.days)) { if (n++ >= PUSH_MAX) break; M.sync.pushDay(id); }
        for (const id of Array.from(M.sync.dirty.body)) { if (n++ >= PUSH_MAX) break; M.sync.pushBody(id); }
        for (const id of Array.from(M.sync.deleted.days)) { M.sync.deleted.days.delete(id); db.doc("mdays/" + docId(id)).delete().catch(noop); }
        for (const id of Array.from(M.sync.deleted.body)) { M.sync.deleted.body.delete(id); db.doc("mbody/" + docId(id)).delete().catch(noop); }
        if (M.sync.dirty.days.size || M.sync.dirty.body.size) M.sync.push();
      } catch (e) {}
    },
    pushDay(id) {
      if (!db) return;
      M.sync.dirty.days.delete(id);
      const d = M.MS.days[id]; if (!isObj(d)) return;
      try { db.doc("mdays/" + docId(id)).set(d).catch(noop); } catch (e) {}
    },
    pushBody(id) {
      if (!db) return;
      M.sync.dirty.body.delete(id);
      const b = M.MS.body[id]; if (!isObj(b)) return;
      try { db.doc("mbody/" + docId(id)).set(b).catch(noop); } catch (e) {}
    }
  };

  /* ------------------------------------------------------------------- boot */
  try { M.load(); } catch (e) { M.MS = freshState(); }
})(window.M);
