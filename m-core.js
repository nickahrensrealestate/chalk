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
     Both are written with characters past U+00FF as \uXXXX (M.lsJSON), which
     JSON.parse (and every older build) reads back unchanged.
   · M.MS.codes = { "<barcode>": foodId } — only there once a barcode was linked to
     a built-in food (M.foods.linkCode); older builds ignore it.
   · New calls: M.log.shown (K1), M.clean (K4), M.foods.byCode / linkCode (K3),
     M.searchQuery, M.checkins.daysSince / weeksSince.
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
  /* Breakfast until 10:30, Lunch until 14:30, Snacks until 17:00, Dinner until 20:30, then Snacks. */
  M.defaultSlot = date => {
    const d = date instanceof Date ? date : new Date(M.now());
    const mins = d.getHours() * 60 + d.getMinutes();
    return mins < 630 ? "Breakfast" : mins < 870 ? "Lunch" : mins < 1020 ? "Snacks" : mins < 1230 ? "Dinner" : "Snacks";
  };
  M.isSlot = s => M.SLOTS.indexOf(s) >= 0;

  /* --------------------------------------------------------------- servings */
  /* {qty:1, unit:"cup", g:240} <-> "1 cup (240 g)". Amounts read as fractions ("¼ cup",
     "1 ½ cups" stays "1 ½ cup"), a gram label never repeats itself ("100 g", not
     "100 g (100 g)"). parseServing reads these, "1 container (6 oz, 170 g)" and the
     old "0.25 cup (46 g)" / "1 oz (23 almonds) (28 g)" labels too. */
  const FRAC = [[0.25, "¼"], [1 / 3, "⅓"], [0.5, "½"], [2 / 3, "⅔"], [0.75, "¾"]];
  const FRAC_V = { "¼": 0.25, "⅓": 1 / 3, "½": 0.5, "⅔": 2 / 3, "¾": 0.75, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875, "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8, "⅙": 1 / 6, "⅚": 5 / 6 };
  /* Metric amounts (g, ml, kg, l) read as decimals ("12.5 g", never "12 ½ g"). */
  const METRIC_UNIT = /^(g|grams?|kg|kilograms?|ml|milliliters?|millilitres?|l|liters?|litres?)$/i;
  function qtyText(q, unit) {
    if (unit && METRIC_UNIT.test(String(unit).trim())) return String(+q.toFixed(1));
    const w = Math.floor(q + 1e-9), rem = q - w;
    if (rem > 1e-6) for (const f of FRAC) if (Math.abs(rem - f[0]) <= 0.02) return (w ? w + " " : "") + f[1];
    return String(+q.toFixed(2));
  }
  /* Drinks and other pourable foods. food.liquid (true / false) wins over the name. */
  const LIQ_WORDS = /\b(milk|buttermilk|juice|coffee|cold brew|espresso|latte|tea|beer|ipa|lager|wine|whiskey|vodka|tequila|rum|gin|seltzer|soda|cola|water|drinks?|gatorade|kefir|creamer|broth|smoothie|lemonade|kombucha)\b/i;
  const NOT_LIQ = /\b(milk chocolate|dark chocolate|chocolate (bar|chips?)|powder|packets?|bars?|cheese|bread|ice cream|in water|chestnuts?|mix|jerky|cake|baking|beans|grounds|yogh?urt|cottage|pudding|cereal|oats|oatmeal|butter)\b/i;
  M.isLiquid = food => {
    if (!isObj(food)) return false;
    if (food.liquid === true || food.liquid === false) return food.liquid;
    const name = String(food.name || "");
    return LIQ_WORDS.test(name) && !NOT_LIQ.test(name);
  };
  /* ml in one serving of a liquid, from the serving's own volume words ("12 fl oz",
     "12 oz", "1 cup", "1 tbsp"); without them ("1 bottle (591 g)") about 1 ml a gram. */
  const ML_OF = { "fl oz": 29.5735, oz: 29.5735, cup: 240, tbsp: 15, tsp: 5, ml: 1, l: 1000, pint: 473, quart: 946, gallon: 3785 };
  function volWord(unit) {
    const u = String(unit || "").toLowerCase().replace(/\(.*$/, "").replace(/,.*$/, "").trim();
    if (/^fl\.?\s*oz\b|^fluid ounces?\b/.test(u)) return "fl oz";
    if (/^(oz|ounces?)\b/.test(u)) return "oz";          /* "12 oz", "12 oz can", "1 ½ oz shot" */
    if (/^cups?\b/.test(u)) return "cup";
    if (/^(tbsp|tablespoons?)\b/.test(u)) return "tbsp";
    if (/^(tsp|teaspoons?)\b/.test(u)) return "tsp";
    if (/^(ml|milliliters?|millilitres?)$/.test(u)) return "ml";
    if (/^(l|liters?|litres?)$/.test(u)) return "l";
    const m = /^(pint|quart|gallon)s?\b/.exec(u);
    return m ? m[1] : null;
  }
  M.servingMl = (s, food) => {
    s = s || {};
    if (!M.isLiquid(food)) return null;
    const v = volWord(s.unit), k = ML_OF[v];
    const ml = k ? (num(s.qty, 1) || 1) * k : num(s.g);
    if (!(ml > 0)) return null;
    return ml >= 10 ? Math.round(ml) : +ml.toFixed(1);
  };
  /* Pass the food as the 2nd argument and a liquid reads in ml: "1 cup (240 ml)",
     "12 oz (355 ml)"; a unit that already names its volume keeps its own words
     ("1 can (355 ml)"). Without the food the label is the same as before. */
  M.fmtServing = (s, food) => {
    s = s || {};
    const qty = num(s.qty, 1) || 1, unit = String(s.unit || "serving").trim() || "serving", g = num(s.g);
    const head = qtyText(qty, unit) + " " + unit;
    if (METRIC_UNIT.test(unit)) return head;
    const liq = food !== undefined && M.isLiquid(food);
    if (liq && /\d\s*(ml|l|fl\.?\s*oz)\b/i.test(unit)) return head;
    const ml = liq ? M.servingMl(s, food) : null;
    if (!(g > 0) && ml == null) return head;
    const gs = ml != null ? ml + " ml" : String(+g.toFixed(1)) + " g";
    /* MF-09/KJ-07: grams go inside a bracket the unit already has: "1 container (6 oz, 170 g)",
       not "(6 oz) (170 g)". M.parseServing and the diary row read both. */
    if (ml == null && /\)\s*$/.test(head) && head.indexOf("(") >= 0) return head.replace(/\)\s*$/, ", " + gs + ")");
    return head + " (" + gs + ")";
  };
  function parseQty(s) {
    s = String(s || "").trim(); if (!s) return null;
    let m = /^(\d+(?:\.\d+)?)?\s*([¼⅓½⅔¾⅛⅜⅝⅞⅕⅖⅗⅘⅙⅚])$/.exec(s);
    if (m) return num(m[1]) + FRAC_V[m[2]];
    m = /^(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/.exec(s);
    if (m) return num(m[1]) + (num(m[3]) > 0 ? num(m[2]) / num(m[3]) : 0);
    m = /^\d+(?:\.\d+)?$|^\.\d+$/.exec(s);
    return m ? num(s) : null;
  }
  M.parseServing = label => {
    let str = String(label == null ? "" : label).trim();
    if (!str) return { qty: 1, unit: "serving", g: null };
    let g = null;
    /* grams at the end: "(28 g)" on its own, or ", 28 g)" inside the unit's own bracket */
    let m = /\s*\(\s*(\d+(?:\.\d+)?)\s*g\s*\)\s*$/i.exec(str);
    if (m) { g = num(m[1]); str = str.slice(0, m.index).trim(); }
    else if ((m = /,\s*(\d+(?:\.\d+)?)\s*g\s*\)\s*$/i.exec(str)) && str.lastIndexOf("(", m.index) >= 0) { g = num(m[1]); str = str.slice(0, m.index).trim() + ")"; }
    m = /^((?:\d+(?:\.\d+)?|\.\d+)?\s*[¼⅓½⅔¾⅛⅜⅝⅞⅕⅖⅗⅘⅙⅚]|(?:\d+\s+)?\d+\s*\/\s*\d+|\d+(?:\.\d+)?|\.\d+)(?=\s|$|[a-z(])\s*/i.exec(str);
    let qty = 1;
    if (m) { const q = parseQty(m[1]); if (q != null) { qty = q; str = str.slice(m[0].length); } }
    return { qty: qty > 0 ? qty : 1, unit: str.trim() || "serving", g };
  };
  /* A serving label without its grams: "1 container (6 oz, 170 g)" → "1 container (6 oz)". */
  M.servingText = label => {
    const p = M.parseServing(label);
    return qtyText(p.qty, p.unit) + " " + p.unit;
  };

  /* ------------------------------------------------------------------ state */
  function freshState() {
    return { v: 1, updatedAt: 0, ui: { mode: "train", person: null, date: null, tab: "diary" }, profiles: {}, foods: {}, meals: {}, days: {}, body: {} };
  }
  /* Keys that must never become properties of a plain object (prototype pollution). */
  const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
  const okKey = k => typeof k === "string" && k !== "" && !BAD_KEYS.has(k);
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  /* A stored record by id: own keys only ("__proto__" or "constructor" never finds anything). */
  const ownRec = (map, id) => { if (typeof id === "number" && isFinite(id)) id = String(id); return isObj(map) && okKey(id) && hasOwn(map, id) && isObj(map[id]) ? map[id] : null; };
  /* a foodId / mealId that can't be a safe key ("__proto__", an object) is dropped; old number ids stay */
  const badRef = v => !v || (typeof v !== "string" && typeof v !== "number") || BAD_KEYS.has(String(v));
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
    /* K3: barcodes linked to built-in foods (only there once a code was linked) */
    if (isObj(s.codes)) { const c = cleanCodes(s.codes); if (Object.keys(c).length) o.codes = c; }
    return o;
  }
  function cleanCodes(m) {
    const out = {};
    Object.keys(isObj(m) ? m : {}).forEach(k => { if (/^\d{6,14}$/.test(k) && okKey(m[k]) && String(m[k]).length <= 120) out[k] = m[k]; });
    return out;
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
  /* On disk:
       M.KEY               everything, in one key, the same format as always
       M.UI_KEY            {mode, person, tab, date}: Train | Macros taps write only this small key
       M.KEY + ".bak"      a daily copy of the last good save (the last 60 days only, when it's big)
       M.KEY + ".damaged"  a copy of a main copy that couldn't be read, made before any save
                           (".damaged.2" … ".5" for later ones; an older copy is never overwritten)
     A failed save never loses data silently: M.MS stays in memory, every later
     M.save() tries again, M.storage says what happened and M.onStorageError
     listeners hear about it once per failure streak. The backup is never deleted
     to make room: a full copy is swapped for a trimmed one instead. */
  M.UI_KEY = "chalk.macros.ui";
  const BAK_KEY = () => M.KEY + ".bak";
  const STATE_KEYS = ["profiles", "foods", "meals", "days", "body"];
  function parseJSON(s) { if (s == null) return undefined; try { return JSON.parse(s); } catch (e) { return undefined; } }
  function validState(s) { return isObj(s) && s.v === 1 && (s.ui === undefined || isObj(s.ui)) && STATE_KEYS.every(k => s[k] === undefined || isObj(s[k])); }
  /* bakMax: a full backup copy is kept up to 600,000 characters (like Chalk's own
     "chalk.bak"). Past that the copy keeps profiles, foods, meals, weigh-ins and
     the last 60 days, so it never crowds the training log out. */
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

  /* Every ".damaged" copy (Erase removes them too). */
  function damagedKeys() {
    const pre = M.KEY + ".damaged", out = [pre, pre + ".2", pre + ".3", pre + ".4", pre + ".5"];
    try {
      if (typeof localStorage !== "undefined" && typeof localStorage.key === "function" && typeof localStorage.length === "number") {
        for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf(pre) === 0 && out.indexOf(k) < 0) out.push(k); }
      }
    } catch (e) {}
    return out;
  }
  /* A main copy that can't be read is copied aside before anything overwrites it.
     An older copy is never overwritten; the same copy is never kept twice. */
  let damagedPending = null;
  function keepDamaged(raw) {
    const base = M.KEY + ".damaged";
    for (let n = 1; n <= 5; n++) {
      const k = n === 1 ? base : base + "." + n, have = lsGet(k);
      if (have === raw) { damagedPending = null; return true; }
      if (have != null) continue;
      if (lsWrite(k, raw)) { damagedPending = raw; return false; }   /* no room yet: try again before the next save */
      damagedPending = null;
      M.storage.damaged.push(k);
      return true;
    }
    damagedPending = null;   /* five copies kept already */
    return false;
  }

  /* JSON for localStorage with every character past U+00FF written as \uXXXX (’ — ⅔ ½).
     Safari keeps a string that has only Latin-1 characters at 1 byte a character and any
     other string at 2, so one "’" doubled the room the diary took. JSON.parse reads the
     escapes back to the same characters, so every build reads it the same way. */
  const WIDE = /[\u0100-\uffff]/g;
  const hex4 = c => "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4);
  const narrow = s => (typeof s === "string" ? s.replace(WIDE, hex4) : s);
  /* The same, for other files that write JSON to localStorage (m-sync). */
  M.lsJSON = v => narrow(JSON.stringify(v));
  /* A copy with profiles, foods, meals, weigh-ins and only the last 60 (or `keep`) days. */
  function trimState(s, keep) {
    const t = Object.assign({}, s, { days: {} }), from = M.addDays(M.today(), -(num(keep) > 0 ? num(keep) : 60)), days = cleanMap(s.days);
    Object.keys(days).forEach(id => {
      const d = days[id], date = isStr(d.date) ? d.date : id.slice(id.lastIndexOf("|") + 1);
      if (date >= from) t.days[id] = d;
    });
    return t;
  }
  const bakHead = (day, at, trim) => '{"bak":1,"day":"' + day + '","at":' + num(at) + (trim ? ',"trim":1' : "");
  const TRIMMED = /^\{"bak":1,"day":"[^"]*","at":\d+,"trim":1/;
  /* First save of each day: copy the last good save on disk to .bak. A good older
     copy is never deleted: when the data is big the copy is trimmed, and when the
     main copy on disk can't be read, today's copy is skipped. */
  /* SP-04: the day a backup last failed to write (phone full). Kept in the small ui key, so a
     relaunch doesn't try again that day: a full phone tries at most once a day. */
  let bakTryDay = null;
  function dailyBak() {
    const day = M.today();
    if (M.storage.bakDay === day || bakTryDay === day) return;
    const prev = lsGet(M.KEY);
    if (prev == null) return;
    const s = parseJSON(prev);
    if (!validState(s)) return;
    M.storage.bakDay = day;   /* one try a day, even when the phone is full */
    const at = M.now(), trimmed = () => bakHead(day, at, true) + ',"data":' + narrow(JSON.stringify(trimState(s))) + "}";
    let err;
    if (prev.length > num(M.storage.bakMax, 600000)) err = lsWrite(BAK_KEY(), trimmed());
    else {
      err = lsWrite(BAK_KEY(), bakHead(day, at) + ',"data":' + narrow(prev) + "}");
      if (err && isQuota(err)) err = lsWrite(BAK_KEY(), trimmed());   /* a failed write leaves the older copy as it was */
    }
    /* the UI may say once that the phone is full (M.storage.bakFailed = that day) */
    if (err) { bakTryDay = day; M.storage.bakFailed = day; }
  }
  /* Phone full: swap a full backup for a trimmed one (60 days, then `keep` days) to make room. */
  function shrinkBak(keep) {
    const str = lsGet(BAK_KEY());
    if (str == null || (!keep && TRIMMED.test(str))) return false;
    const b = parseJSON(str);
    if (!isObj(b) || b.bak !== 1 || !validState(b.data)) return false;
    const out = bakHead(/^\d{4}-\d{2}-\d{2}$/.test(String(b.day)) ? b.day : M.today(), b.at, true) + ',"data":' + narrow(JSON.stringify(trimState(b.data, keep))) + "}";
    if (out.length >= str.length) return false;
    return !lsWrite(BAK_KEY(), out);
  }

  M.load = function () {
    M.storage.restoredFrom = null;
    M.storage.damaged = [];
    damagedPending = null;
    const raw = lsGet(M.KEY), bak = lsGet(BAK_KEY());
    const bm = bak ? /^\{"bak":1,"day":"(\d{4}-\d{2}-\d{2})"/.exec(bak) : null;
    M.storage.bakDay = bm ? bm[1] : null;
    let s = parseJSON(raw);
    if (!validState(s)) {
      s = null;
      if (raw != null) keepDamaged(raw);   /* before anything can overwrite it */
      const b = parseJSON(bak);
      if (isObj(b) && validState(b.data)) { s = b.data; M.storage.restoredFrom = String(b.day || "backup"); }
    }
    M.MS = shape(s);
    /* taps on Train | Macros live in their own small key. The newer copy wins: an
       older build (after a rollback) only writes mode/person into the main key. */
    lastUi = null;
    const uiStr = lsGet(M.UI_KEY), ui = parseJSON(uiStr);
    bakTryDay = isObj(ui) && /^\d{4}-\d{2}-\d{2}$/.test(String(ui.bakTry || "")) ? ui.bakTry : null;
    if (isObj(ui)) {
      const mainAt = num(s && s.updatedAt), uiAt = num(ui.at);
      if (!(mainAt > uiAt + 1000 && uiAt > 0 && !M.storage.restoredFrom)) applyUi(M.MS.ui, ui);
      lastUi = uiStr.replace(/,"at":\d+\}$/, "}");
    }
    M.storage.bytes = raw && s && !M.storage.restoredFrom ? raw.length : 0;
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
  let lastUi = null;
  function uiJSON() {
    const u = M.MS.ui || {}, o = { mode: u.mode === "macros" ? "macros" : "train", person: isPid(u.person) ? u.person : null, tab: isStr(u.tab) && u.tab ? u.tab : "diary", date: u.date || null };
    if (bakTryDay) o.bakTry = bakTryDay;   /* SP-04 */
    return JSON.stringify(o);
  }
  /* Writes only the small ui key (mode, person, tab, date, at). Never a full save.
     "at" lets M.load() tell it apart from a newer main key written by an older build. */
  M.saveUi = function () {
    const s = uiJSON();
    if (s === lastUi) return true;
    if (lsWrite(M.UI_KEY, s.slice(0, -1) + ',"at":' + num(M.now()) + "}")) return false;
    lastUi = s;
    return true;
  };
  function persist() {
    let str;
    try { str = narrow(JSON.stringify(Object.assign({}, M.MS, { profiles: keptProfiles(M.MS.profiles) }))); } catch (e) { storeFail(e); return false; }
    /* the damaged copy must be kept before the main key is written over */
    if (damagedPending != null && !keepDamaged(damagedPending) && damagedPending != null && shrinkBak()) keepDamaged(damagedPending);
    if (damagedPending != null) { storeFail(new Error("No room to keep a copy of the damaged data")); return false; }
    try { dailyBak(); } catch (e) {}
    try { M.saveUi(); } catch (e) {}
    let err = lsWrite(M.KEY, str);
    /* out of room: today's save comes first. Trim the backup to 60 days, then to 7,
       and if that is still not enough, drop it and write the main copy. */
    const bakTry = shrink => {
      const before = lsGet(BAK_KEY());
      if (before == null || !shrink()) return;
      err = lsWrite(M.KEY, str);
      if (err) lsWrite(BAK_KEY(), before);   /* it didn't help: the backup goes back as it was */
    };
    if (err && isQuota(err)) bakTry(() => shrinkBak());
    if (err && isQuota(err)) bakTry(() => shrinkBak(7));
    if (err && isQuota(err)) bakTry(() => { lsDel(BAK_KEY()); return true; });
    if (err) { storeFail(err); return false; }
    storeOk();
    M.storage.bytes = str.length;
    return true;
  }

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
    [M.KEY, BAK_KEY()].concat(damagedKeys()).forEach(lsDel);
    M.MS = freshState();
    damagedPending = null;
    M.storage.bakDay = null; M.storage.restoredFrom = null; M.storage.damaged = []; bakTryDay = null; M.storage.bakFailed = null;
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
    },
    /* Round once: every row shows whole numbers and the total adds up the rows as
       shown, so the rows on screen always add up to the total on screen.
       rows(list) → { rows: [{cal, p, …} | null], total }. */
    rows(list) {
      const total = M.foodMath.blank(), rows = [];
      (Array.isArray(list) ? list : []).forEach(it => {
        if (!isObj(it)) { rows.push(null); return; }
        const s = it.servings == null ? 1 : num(it.servings, 1), per = isObj(it.per) ? it.per : it, o = {};
        M.NUT.forEach(k => { o[k] = Math.round(num(per[k]) * s); total[k] += o[k]; });
        rows.push(o);
      });
      return { rows, total };
    },
    /* What's left, from the two numbers on screen: round(target) − round(eaten). */
    left(target, eaten) { return Math.round(num(target)) - Math.round(num(eaten)); }
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
    const F = [[0, ""], [0.25, "¼"], [1 / 3, "⅓"], [0.5, "½"], [2 / 3, "⅔"], [0.75, "¾"], [1, ""]];
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

  function alwaysRawOf(e) {
    if (!isObj(e) || !isStr(e.foodId) || e.mealId) return false;
    try { const f = M.foods.get(e.foodId); return !!(f && f.alwaysRaw === true); } catch (x) { return false; }
  }
  /* Cooked grams of the whole batch for a portion of a batch meal, else 0. */
  function batchOf(e) {
    if (!isObj(e) || !e.mealId || e.state !== "cooked") return 0;
    if (num(e.batchG) > 0) return num(e.batchG);
    const m = M.meals && M.meals.get ? M.meals.get(e.mealId) : null;
    return isObj(m) && isObj(m.batch) && num(m.batch.cookedG) > 0 ? num(m.batch.cookedG) : 0;
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
      /* NJ-05: what was weighed cooked reads cooked first: "4 oz cooked (5.1 oz raw)" */
      if (opt.cookedFirst) return side("cooked", cooked) + " cooked (" + side("raw", raw) + " " + c.word + ")";
      return side("raw", raw) + " " + c.word + " (" + side("cooked", cooked) + " cooked)";
    },
    /* The food's own serving, raw first: "4 oz raw (2.9 oz cooked)", "1/4 cup dry (4.6 oz cooked)". */
    servingLabel(food, units) {
      const c = M.cook.of(food); if (!c) return "";
      const sv = normServing(food.serving); if (!sv.g) return "";
      const u = unitWord(sv.unit);
      /* KJ-06: an oz / lb / g serving counts from its unit (28.3495 g an oz), like the Diary does */
      const g = u && WEIGHT_G[u] ? sv.qty * WEIGHT_G[u] : sv.g;
      return M.cook.label(g, "raw", c, units || personUnits(), { vol: u && VOLUME[u] ? { unit: u, g: sv.g / (sv.qty || 1) } : null });
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
      const add = (unit, st, g, vol, label, step, per) => {
        const key = unit + "-" + st;
        if (!(g > 0) || out.some(o => o.key === key)) return;
        out.push({ key, unit, state: st, label: label || unit + " " + (st === "cooked" ? "cooked" : word), g: r4(g), per: per || perAt(st === "cooked" ? ck100 : raw100, g), step: step || (vol ? 0.25 : (STEP[unit] || 0.25)), vol: !!vol });
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
          if (byU[u] && byU[u].own) return;
          if (a.own || !byU[u] || Math.abs(q - 1) < Math.abs(byU[u].q - 1)) byU[u] = { q, g: num(a.g) / q, own: !!a.own };
        });
        Object.keys(byU).forEach(u => add(u, st, byU[u].g, true));
      };
      if (opt.vol !== false && isObj(food)) {
        const sv = normServing(food.serving);
        vols((sv.g ? [{ label: sv.qty + " " + sv.unit, g: sv.g, own: true }] : []).concat(normAlts(food.alts)), "raw");
        vols(c && c.alts, "cooked");
        /* the food's own count servings, raw: "breast (175 g raw)" for "1 breast" / "½ breast" */
        if (states.indexOf("raw") >= 0) {
          (sv.g ? [{ label: sv.qty + " " + sv.unit, g: sv.g }] : []).concat(normAlts(food.alts)).forEach(a => {
            const p = M.parseServing(a.label), u = String(p.unit || "").replace(/\([^)]*\)/g, " ").replace(/,.*$/, "").trim();
            if (!(num(a.g) > 0) || !u || unitWord(u) || /^(servings?|g|grams?|ml)$/i.test(u) || /\d/.test(u)) return;
            const g1 = num(a.g) / (p.qty || 1);
            add(u, "raw", g1, false, u + " (" + r0(g1) + " g " + word + ")", 0.5);
          });
        }
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
    /* "6 oz raw (4.4 oz cooked)" for an entry-like, "" when it isn't a cook food.
       A portion of a batch meal reads cooked only: "6 oz cooked · of 80 oz batch"
       ("170 g cooked · of 2.3 kg batch"). */
    entryLabel(e, units) {
      const i = M.cook.entryInfo(e); if (!i) return "";
      const b = batchOf(e);
      if (b) {
        const fam = famOf(i.fam || units || personUnits());
        /* whole grams up to 10 kg ("of 1,950 g batch", not "of 2 kg batch") */
        const whole = fam === "g" ? (b >= 10000 ? String(r1(b / 1000)) + " kg" : r0(b).toLocaleString("en-US") + " g") : fmtWeight(b, fam);
        return fmtWeight(i.grams, fam) + " cooked · of " + whole + " batch";
      }
      /* K8: a food always weighed raw (the chicken breast) reads in grams, whatever the
         person's units: "175 g raw (127 g cooked)", also for "1 breast (175 g)" or "6 oz raw" */
      if (alwaysRawOf(e)) return M.cook.label(i.grams, i.state, i.cook, "g", {});
      /* NJ-05: saved cooked (or an old entry named "…, cooked" with no state): cooked first */
      const cookedFirst = i.state === "cooked" && (e.state === "cooked" || (!e.state && /,\s*cooked\s*$/i.test(String(e.name || ""))) || (!e.state && !!(e.foodId && M.cook.alias(e.foodId))));
      return M.cook.label(i.grams, i.state, i.cook, i.fam || units || personUnits(), { vol: i.vol, cookedFirst });
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
  /* L2: edit stamps. Every diary entry and meal item carries `u` (ms), set when it is made
     or its content changes; foods and meals carry a record-level `u`, set on add and on a
     real change. A record loaded from disk without `u` keeps none until it is edited (old
     records count as 0), so this update never changes the hash of an untouched record.
     Sync uses the stamps to settle conflicts the same way on both phones. */
  const STAMP_SKIP = { u: 1, updatedAt: 1, createdAt: 1, uses: 1, lastUsed: 1 };
  function bodyStr(o, noItemU) {
    if (!isObj(o)) return "";
    const c = {};
    Object.keys(o).forEach(k => { if (!STAMP_SKIP[k]) c[k] = o[k]; });
    if (noItemU && Array.isArray(c.items)) c.items = c.items.map(it => { if (!isObj(it) || !("u" in it)) return it; const x = Object.assign({}, it); delete x.u; return x; });
    try { return canon(c) || ""; } catch (e) { return ""; }
  }
  const stampOk = v => isNum(v) && v > 0;
  /* the stamp after an edit: the caller's own stamp when it gave one, now when the content
     changed, else the old one (or none) */
  function restamp(prev, next, given, noItemU) {
    if (stampOk(given)) { next.u = given; return next; }
    if (bodyStr(prev, noItemU) !== bodyStr(next, noItemU)) next.u = M.now();
    else if (isObj(prev) && stampOk(prev.u)) next.u = prev.u;
    else delete next.u;
    return next;
  }
  /* meal items after an update: new or changed items get a new stamp, the rest keep theirs */
  function stampItems(prevItems, items) {
    const old = new Map();
    (Array.isArray(prevItems) ? prevItems : []).forEach((it, i) => { if (isObj(it)) old.set(it.id ? "i:" + it.id : "n:" + i, it); });
    items.forEach((it, i) => {
      const was = old.get("i:" + it.id) || old.get("n:" + i);
      if (!was) { it.u = M.now(); return; }
      restamp(was, it, undefined);
    });
    return items;
  }
  function normFood(f) {
    f = isObj(f) ? f : {};
    const now = M.now();
    const o = Object.assign({}, f);
    o.id = okKey(o.id) ? o.id : M.uid();
    o.name = String(o.name || "Food").trim().slice(0, 120);
    o.brand = String(o.brand || "").trim().slice(0, 120);
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
    add(food) { const f = normFood(food); f.u = M.now(); M.MS.foods[f.id] = f; M.save(); return f; },
    update(id, patch) {
      const f = ownRec(M.MS.foods, id); if (!f) return null;
      const merged = normFood(Object.assign({}, f, isObj(patch) ? patch : {}, { id }));
      merged.createdAt = f.createdAt;
      restamp(f, merged, isObj(patch) ? patch.u : undefined);
      M.MS.foods[id] = merged; M.save(); return merged;
    },
    remove(id) { if (!ownRec(M.MS.foods, id)) return false; delete M.MS.foods[id]; M.save(); return true; },
    get(id) { return ownRec(M.MS.foods, id) || genericById(id); },   /* old raw/cooked generic ids resolve to the merged food */
    list() {
      return Object.values(M.MS.foods).sort((a, b) => num(b.lastUsed) - num(a.lastUsed) || num(b.updatedAt) - num(a.updatedAt) || lc(a.name).localeCompare(lc(b.name)));
    },
    findByBarcode(code) {
      const c = normCode(code); if (!c) return null;
      return Object.values(M.MS.foods).find(f => normCode(f.barcode) === c) || null;
    },
    touch(id) { const f = touchFood(id); if (f) M.save(); return f; },
    /* K3: the food for a barcode on this phone: My foods first, then a code linked to a
       built-in food, then built-in foods' own `barcodes`. UPC-A and EAN-13 match with or
       without the leading zero. null when none. */
    byCode(code) {
      const c = normCode(code); if (!c) return null;
      const mine = M.foods.findByBarcode(c); if (mine) return mine;
      const codes = isObj(M.MS.codes) ? M.MS.codes : {};
      for (const k of Object.keys(codes)) if (normCode(k) === c) { const f = M.foods.get(codes[k]); if (isObj(f)) return f; }
      return genericList().find(f => isObj(f) && Array.isArray(f.barcodes) && f.barcodes.some(b => normCode(b) === c)) || null;
    },
    /* K3: "Pick one of my foods" for a barcode. A saved food gets it as its barcode (a food
       that has one already keeps it and the new code is linked too); a built-in food is
       linked in M.MS.codes. Saves. → the food, or null. */
    linkCode(code, foodId) {
      const c = String(code == null ? "" : code).replace(/\D/g, "");
      if (!normCode(c) || c.length < 6 || c.length > 14 || !okKey(foodId)) return null;
      const own = ownRec(M.MS.foods, foodId);
      if (!own && !genericById(foodId)) return null;
      const id = own ? own.id : genericById(foodId).id;
      if (own && (!own.barcode || normCode(own.barcode) === normCode(c))) { if (own.barcode !== c) own.u = M.now(); own.barcode = c; own.updatedAt = M.now(); }
      else { if (!isObj(M.MS.codes)) M.MS.codes = {}; M.MS.codes[c] = id; }
      M.save();
      return M.foods.get(id);
    }
  };
  /* uses / lastUsed without a save (the caller saves once) */
  function touchFood(id) { const f = ownRec(M.MS.foods, id); if (!f) return null; f.uses = num(f.uses) + 1; f.lastUsed = M.now(); return f; }
  function touchMeal(id) { const m = ownRec(M.MS.meals, id); if (!m) return null; m.uses = num(m.uses) + 1; m.lastUsed = M.now(); return m; }

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
    if (badRef(o.foodId)) delete o.foodId;
    if (badRef(o.mealId)) delete o.mealId;
    return o;
  }
  function normMeal(m) {
    m = isObj(m) ? m : {};
    const now = M.now();
    const o = Object.assign({}, m);
    o.id = okKey(o.id) ? o.id : M.uid();
    o.name = String(o.name || "Meal").trim().slice(0, 120);
    o.desc = String(o.desc || "").trim().slice(0, 120);
    o.slot = M.isSlot(o.slot) ? o.slot : "Any";
    o.items = (Array.isArray(o.items) ? o.items : []).map(normItem);
    o.servingsMade = num(o.servingsMade, 1) > 0 ? num(o.servingsMade, 1) : 1;
    /* batch: per = the whole batch; rawG always recomputed from the items */
    if (isObj(o.batch) && num(o.batch.cookedG) > 0) { o.servingsMade = 1; const bu = ["g", "oz", "lb"].indexOf(o.batch.unit) >= 0 ? o.batch.unit : null; o.batch = { cookedG: r1(num(o.batch.cookedG)), rawG: M.cook.rawTotal(o.items) }; if (bu) o.batch.unit = bu; }
    else delete o.batch;
    o.per = M.meals.computePer(o);
    o.createdAt = num(o.createdAt) || now;
    o.updatedAt = now;
    o.uses = num(o.uses);
    o.lastUsed = num(o.lastUsed);
    /* the owner (pid) is set once, in M.meals.add; an update keeps what the meal had */
    return o;
  }
  const byUse =(a, b) => num(b.lastUsed) - num(a.lastUsed) || num(b.uses) - num(a.uses) || lc(a.name).localeCompare(lc(b.name));
  M.meals = {
    computePer(meal) {
      const n = num(meal && meal.servingsMade, 1) > 0 ? num(meal.servingsMade, 1) : 1;
      /* KJ-05: summed and kept unrounded (4 places) so a meal adds up like the Breakfast it
         came from; rounded once, on screen */
      const tot = {}; M.NUT.forEach(k => { tot[k] = 0; });
      ((meal && Array.isArray(meal.items)) ? meal.items : []).forEach(it => {
        if (!it) return;
        const sv = it.servings == null ? 1 : num(it.servings, 1), per = isObj(it.per) ? it.per : it;
        M.NUT.forEach(k => { tot[k] += num(per[k]) * sv; });
      });
      const o = {}; M.NUT.forEach(k => { o[k] = r4(tot[k] / n); });
      return o;
    },
    add(meal) {
      const m = normMeal(meal), now = M.now();
      m.pid = m.pid || M.pid() || null;
      m.u = now; m.items.forEach(it => { it.u = now; });
      M.MS.meals[m.id] = m; M.save(); return m;
    },
    update(id, patch) {
      const m = ownRec(M.MS.meals, id); if (!m) return null;
      const merged = normMeal(Object.assign({}, m, isObj(patch) ? patch : {}, { id }));
      merged.createdAt = m.createdAt;
      stampItems(m.items, merged.items);
      restamp(m, merged, isObj(patch) ? patch.u : undefined, true);
      M.MS.meals[id] = merged; M.save(); return merged;
    },
    remove(id) { if (!ownRec(M.MS.meals, id)) return false; delete M.MS.meals[id]; M.save(); return true; },
    get(id) { return ownRec(M.MS.meals, id); },
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
    o.name = String(o.name || (food && food.name) || "Food").trim().slice(0, 120);
    o.brand = String(o.brand || (food && food.brand) || "").trim().slice(0, 120);
    o.servings = num(o.servings, 1) > 0 ? num(o.servings, 1) : 1;
    if (!o.servingLabel) {
      if (isObj(o.serving)) { o.servingLabel = M.fmtServing(o.serving); if (o.g == null) o.g = o.serving.g; }
      else if (food) { o.servingLabel = M.fmtServing(food.serving); if (o.g == null) o.g = food.serving.g; }
      else o.servingLabel = "1 serving";
    }
    o.g = num(o.g) > 0 ? num(o.g) : null;
    o.per = normPer(isObj(o.per) ? o.per : (food ? food.per : null));
    o.at = num(o.at) || M.now();
    if (badRef(o.foodId)) delete o.foodId;
    if (badRef(o.mealId)) delete o.mealId;
    /* a portion of a batch meal remembers the batch's cooked weight, so its label never changes later */
    if (o.mealId && o.state === "cooked" && !(num(o.batchG) > 0)) {
      const m = ownRec(M.MS.meals, o.mealId);
      if (isObj(m) && isObj(m.batch) && num(m.batch.cookedG) > 0) { o.batch = true; o.batchG = r1(num(m.batch.cookedG)); }
    }
    return o;
  }
  M.log = {
    add(dateKey, entry) {
      const d = M.day(dateKey);
      const e = normEntry(entry);
      e.u = M.now();   /* L2: a new entry's edit stamp */
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
      const prev = d.entries[i];
      const merged = normEntry(Object.assign({}, prev, patch, { id: entryId }));
      /* an edit keeps the entry's own name, brand and food id (an old generic chicken entry
         doesn't turn into "Kirkland" or change its id just because its amount changed) */
      if (patch.name === undefined && isStr(prev.name) && prev.name.trim()) merged.name = prev.name;
      if (patch.brand === undefined) merged.brand = isStr(prev.brand) ? prev.brand : "";
      if (patch.foodId === undefined && isStr(prev.foodId) && prev.foodId && !badRef(prev.foodId)) merged.foodId = prev.foodId;
      restamp(prev, merged, patch.u);
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
      const m = ownRec(M.MS.meals, mealId); if (!m) return [];
      /* the foods inside count as used too (saved in the one save below) */
      (Array.isArray(m.items) ? m.items : []).forEach(it => { if (isObj(it) && isStr(it.foodId)) touchFood(it.foodId); });
      const s = M.isSlot(slot) ? slot : (M.isSlot(m.slot) ? m.slot : M.defaultSlot());
      if (isObj(m.batch) && num(m.batch.cookedG) > 0 && isObj(opt) && num(opt.grams) > 0) {
        const u = WEIGHT_G[opt.unit] ? opt.unit : "oz", ug = WEIGHT_G[u], cg = num(m.batch.cookedG);
        const per = {}; M.NUT.forEach(k => { per[k] = r4(num(m.per[k]) * ug / cg); });
        return [M.log.add(dateKey, { slot: s, name: m.name, brand: "", servings: r4(num(opt.grams) / ug), servingLabel: "1 " + u + " cooked", g: r4(ug), per, mealId, state: "cooked", cook: M.cook.batchCook(m), batch: true, batchG: r1(cg) })];
      }
      const e = M.log.add(dateKey, { slot: s, name: m.name, brand: "", servings: num(servings, 1) > 0 ? num(servings, 1) : 1, servingLabel: "1 serving", g: null, per: m.per, mealId });
      return [e];
    },
    copySlot(fromKey, toKey, slot) {
      const src = M.dayOf(fromKey); if (!src) return [];
      const items = src.entries.filter(x => x.slot === slot); if (!items.length) return [];
      const d = M.day(toKey);
      const out = items.map(x => { const c = Object.assign(M.cp(x), { id: M.uid(), at: M.now(), u: M.now() }); d.entries.push(c); return c; });
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
    slotEntries(dateKey, slot, pid) { const d = M.dayOf(dateKey, pid); return d && Array.isArray(d.entries) ? d.entries.filter(x => isObj(x) && x.slot === slot) : []; },
    totals(dateKey, pid) { const d = M.dayOf(dateKey, pid); return M.foodMath.sum(d && Array.isArray(d.entries) ? d.entries.filter(isObj) : []); },
    /* K1: a day's totals as the Diary shows them: each row rounded to whole numbers
       (per × servings, to 0.1, then to 1), then added. The Diary, Suggest, the Train
       summary and the week summary all use this, so a day shows one number everywhere.
       → {cal, p, c, f, fiber, sugar, sodium, water} */
    shown(dateKey, pid) {
      const d = M.dayOf(dateKey || M.today(), pid);
      const o = { cal: 0, p: 0, c: 0, f: 0, fiber: 0, sugar: 0, sodium: 0, water: 0 };
      (d && Array.isArray(d.entries) ? d.entries : []).forEach(e => {
        if (!isObj(e)) return;
        const s = Math.max(0, num(e.servings, 1)), per = isObj(e.per) ? e.per : {};
        M.NUT.forEach(k => { o[k] += r0(r1(num(per[k]) * s)); });
      });
      o.water = d ? Math.max(0, r0(num(d.water))) : 0;
      return o;
    },
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
  const BODY_OK = { ok: true, msg: "" };
  M.body = {
    /* Is this a real weight or resting heart rate? value is in the person's units
       (lb, or kg when units is "metric"). → {ok, msg} with a plain message. */
    check(value, kind, units) {
      const rhr = kind === "rhr", kg = units === "metric";
      const v = typeof value === "number" ? value : String(value == null ? "" : value).trim() === "" ? NaN : Number(String(value).trim());
      if (rhr) return v >= 25 && v <= 220 ? BODY_OK : { ok: false, msg: "Resting heart rate should be 25 to 220 beats a minute." };
      if (kg) return v >= 23 && v <= 320 ? BODY_OK : { ok: false, msg: "Weight should be 23 to 320 kg." };
      return v >= 50 && v <= 700 ? BODY_OK : { ok: false, msg: "Weight should be 50 to 700 lb." };
    },
    /* {date?, w?, rhr?, pid?} — w in lb. Merges into the existing record for that day.
       Refuses (null) a weight or heart rate out of range. The 2-week weigh-in clock
       (lastBody) only moves for a weigh-in dated today or yesterday. */
    add(rec) {
      rec = isObj(rec) ? rec : {};
      const pid = rec.pid || M.pid(); if (!isPid(pid)) return null;
      const date = isStr(rec.date) && /^\d{4}-\d{2}-\d{2}$/.test(rec.date) ? rec.date : M.today();
      const id = dayId(pid, date);
      const w = rec.w == null || rec.w === "" ? null : num(rec.w, null);
      const rhr = rec.rhr == null || rec.rhr === "" ? null : num(rec.rhr, null);
      const hasW = w != null && w > 0, hasR = rhr != null && rhr > 0;
      if (!hasW && !hasR) return M.MS.body[id] || null;
      if ((hasW && !M.body.check(w, "w", "us").ok) || (hasR && !M.body.check(rhr, "rhr").ok)) return null;
      const b = isObj(M.MS.body[id]) ? M.MS.body[id] : { id, pid, date, w: null, rhr: null, at: 0 };
      if (hasW) b.w = r1(w);
      if (hasR) b.rhr = r0(rhr);
      b.at = M.now();
      M.MS.body[id] = b;
      M.sync.dirty.body.add(id);
      const p = M.person(pid);
      if (date === M.today() || date === M.addDays(M.today(), -1)) p.lastBody = M.now();
      if (hasW) { const latest = M.body.latest(pid, "w"); if (!latest || latest.date <= date) { p.weightLb = b.w; p.updatedAt = M.now(); } }
      M.save();
      return b;
    },
    /* Deletes that day's record. The weight goes back to the latest weigh-in left and
       the targets follow (unless they're set by hand). One save. */
    remove(date, pid) {
      pid = pid || M.pid(); if (!pid) return false;
      const id = dayId(pid, date); if (!M.MS.body[id]) return false;
      delete M.MS.body[id];
      M.sync.dirty.body.delete(id); M.sync.deleted.body.add(id);
      if (isPid(pid)) {
        const p = M.person(pid), latest = M.body.latest(pid, "w");
        if (latest && latest.value !== p.weightLb) { p.weightLb = latest.value; p.updatedAt = M.now(); }
        M.calc.applyTargets(p);   /* saves */
      } else M.save();
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
    /* lb a week: the best straight line (least squares) through the weigh-ins of the
       56 days ending at the latest one. Works with a weigh-in every 2 weeks: needs 2+
       weigh-ins at least 14 days apart, else null. */
    ratePerWeek(pid) {
      const all = M.body.series(pid, "w", 0); if (all.length < 2) return null;
      const end = all[all.length - 1].date, start = M.addDays(end, -55);
      const win = all.filter(x => x.date >= start);
      if (win.length < 2 || M.daysBetween(win[0].date, end) < 14) return null;
      const xs = win.map(x => M.daysBetween(start, x.date)), ys = win.map(x => num(x.v));
      const mx = xs.reduce((t, x) => t + x, 0) / xs.length, my = ys.reduce((t, y) => t + y, 0) / ys.length;
      let sxy = 0, sxx = 0;
      for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); }
      return sxx > 0 ? r2(sxy / sxx * 7) : null;
    }
  };

  /* ---------------------------------------------------------------- recents */
  /* A recent row seen on the LIVE food or meal: today's numbers, serving and cook
     info, with last time's amount, unit and state. Old merged ids resolve through
     M.DB.alias. A food marked alwaysRaw (the chicken breast) comes back raw: the
     cooked grams ÷ y. Only a food or meal that no longer exists keeps its snapshot. */
  /* Nutrition of `grams` of a food in a state, not rounded (a "1 g" unit times 175 must stay exact). */
  function perExact(f, state, grams) {
    const p = M.cook.per100(f, state); if (!p) return null;
    const o = {}; M.NUT.forEach(k => { o[k] = r4(num(p[k]) * num(grams) / 100); });
    return o;
  }
  /* The food's own portion with these unit words ("bar", "large egg", "cup, halves"): its
     serving or one of its alts, with the food's numbers for it. null when it has none. */
  const unitKey = u => toksOf(String(u == null ? "" : u).replace(/\([^)]*\)/g, " ")).join(" ");
  function portionOf(f, L) {
    const key = unitKey(L.unit);
    if (!key || key === "serving") return null;
    const S = normServing(f.serving), fp = normPer(f.per), lq = L.qty || 1;
    const alt = a => { const per = {}; M.NUT.forEach(k => { per[k] = fp[k] * num(a.g) / S.g; }); const A = M.parseServing(a.label); return { qty: A.qty || 1, unit: A.unit, g: num(a.g), per }; };
    const alts = S.g > 0 ? normAlts(f.alts).filter(a => num(a.g) > 0 && unitKey(M.parseServing(a.label).unit) === key) : [];
    const same = q => Math.abs(q - lq) < 1e-6;
    /* the same amount first ("½ breast" is its own portion), then the serving's unit, then any portion in that unit */
    const exact = alts.find(a => same(M.parseServing(a.label).qty || 1));
    if (unitKey(S.unit) === key && (same(S.qty) || !exact)) return { qty: S.qty, unit: S.unit, g: S.g, per: fp };
    if (exact) return alt(exact);
    return alts.length ? alt(alts[0]) : null;
  }
  function liveRecent(o) {
    if (o.mealId) {
      const m = M.meals.get(o.mealId);
      if (!isObj(m)) return o;
      o.name = m.name; o.brand = "";
      if (isObj(m.batch) && num(m.batch.cookedG) > 0) {
        const g1 = unitGrams(o), cg = num(m.batch.cookedG);
        if (g1 > 0) { const per = {}; M.NUT.forEach(k => { per[k] = r4(num(m.per && m.per[k]) * g1 / cg); }); o.per = per; }
        if (o.state === "cooked") { o.batch = true; o.batchG = r1(cg); }   /* the label and the math use today's batch */
      }
      else { const sv = M.parseServing(o.servingLabel); if (lc(sv.unit) === "serving" && sv.qty === 1) o.per = normPer(m.per); }
      return o;
    }
    if (!o.foodId) return bigGuard(o, null);
    const f = M.foods.get(o.foodId);
    if (!isObj(f)) return bigGuard(o, null);
    const al = M.cook.alias(o.foodId), c = M.cook.of(f);
    /* NJ-04: logged as another food (an old generic chicken now read as the Kirkland breast):
       its old amount isn't this food's, so the row starts at the food's own serving */
    const other = lc(o.name) !== lc(f.name) || lc(o.brand || "") !== lc(f.brand || "");
    o.foodId = f.id; o.name = f.name; o.brand = f.brand || "";
    if (other) return foodServingRecent(o, f, c);
    return bigGuard(liveFood(o, f, al, c), f);
  }
  /* NJ-04: a recent row never starts at more than 3,000 cal: the food's own serving instead */
  function bigGuard(o, f) {
    if (num(o.per && o.per.cal) * num(o.servings, 1) <= 3000) return o;
    if (f) return foodServingRecent(o, f, M.cook.of(f));
    if (num(o.per && o.per.cal) <= 3000) o.servings = 1;
    return o;
  }
  function foodServingRecent(o, f, c) {
    const sv = normServing(f.serving);
    o.servings = 1; o.g = sv.g; o.per = normPer(f.per);
    o.servingLabel = M.fmtServing(sv, M.isLiquid(f) ? f : undefined);
    if (c) { o.state = "raw"; o.cook = cookLite(c); } else { delete o.state; delete o.cook; }
    delete o.batch; delete o.batchG;
    return o;
  }
  function liveFood(o, f, al, c) {
    if (c) { o.state = o.state || (al ? al.state : "raw"); o.cook = cookLite(c); }
    else { delete o.state; delete o.cook; }
    /* A count or cup unit the food has ("1 bar", "1 large egg", "1 slice", "½ cup", "1 breast"):
       the food's own numbers for that unit, never its grams, so fixing a food's grams
       doesn't change "1 bar". Grams only for g / oz / lb. */
    const L = M.parseServing(o.servingLabel), lu = unitWord(L.unit);
    if (!(lu && WEIGHT_G[lu]) && (!c || (o.state !== "cooked" && !(lu && VOLUME[lu])))) {
      const pt = portionOf(f, L);
      if (pt) {
        const k = (L.qty || 1) / (pt.qty || 1), per = {};
        M.NUT.forEach(n => { per[n] = r4(num(pt.per[n]) * k); });
        o.g = pt.g ? r4(pt.g * k) : null;
        /* a cook food (the chicken breast) counts by the portion's raw grams, like its oz and g units */
        o.per = c && o.g ? perExact(f, "raw", o.g) || per : per;
        o.servingLabel = M.fmtServing({ qty: L.qty || 1, unit: pt.unit, g: pt.g ? r1(pt.g * k) : null }, M.isLiquid(f) ? f : undefined);
        return o;
      }
    }
    const g1 = unitGrams(o);
    if (c && f.alwaysRaw === true && o.state === "cooked" && g1 > 0) {
      /* cooked grams → raw grams, in the same family of unit (oz / lb → oz, else g) */
      const rawG = g1 * o.servings / c.y, u = unitWord(M.parseServing(o.servingLabel).unit), oz = u === "oz" || u === "lb";
      o.state = "raw";
      o.servingLabel = (oz ? "1 oz " : "1 g ") + c.word;
      o.g = oz ? OZ_G : 1;
      o.servings = oz ? r2(rawG / OZ_G) || 0.01 : Math.max(1, Math.round(rawG));   /* 2 places: 6 oz cooked stays 170 g, not 171 */
      o.per = perExact(f, "raw", o.g) || o.per;
      return o;
    }
    const per = g1 > 0 ? perExact(f, o.state === "cooked" ? "cooked" : "raw", g1) : null;
    if (per) o.per = per;
    else {
      /* no grams to go on: the food's own serving or one of its portions, by label */
      const sv = normServing(f.serving), lab = lc(M.servingText(o.servingLabel));
      if (lab === lc(M.servingText(M.fmtServing(sv)))) o.per = normPer(f.per);
    }
    return o;
  }
  /* A tiny add-on (about a teaspoon of oil or less): listed after the rest. */
  function tinyRecent(o) {
    if (num(o.per && o.per.cal) * num(o.servings, 1) > 60) return false;   /* real food: no need to look closer */
    const g1 = unitGrams(o), sv = M.parseServing(o.servingLabel), u = unitWord(sv.unit) || lc(sv.unit);
    if (g1 > 0) return g1 * o.servings <= 5;
    return /^(tsp|teaspoons?)$/.test(u) && sv.qty * o.servings <= 1;
  }
  /* M.recents(pid, n = 30, slot): one row per food / meal / name, logged in the last 60 days.
     With a slot: most often logged in that slot in the last 14 days first, then newest.
     Tiny add-ons always go last. */
  M.recents = function (pid, n, slot) {
    pid = pid || M.pid(); n = num(n, 30) || 30;
    if (!pid) return [];
    const from = M.addDays(M.today(), -59), from14 = M.addDays(M.today(), -13);
    const map = new Map();
    const snap = e => {
      const o = { servingLabel: e.servingLabel || "1 serving", servings: num(e.servings, 1) || 1, g: num(e.g) > 0 ? num(e.g) : null, per: normPer(e.per), foodId: e.foodId || null, mealId: e.mealId || null, lastUsed: num(e.at) };
      if (e.state === "raw" || e.state === "cooked") { o.state = e.state; if (cookLite(e.cook)) o.cook = cookLite(e.cook); }
      /* FD-03: a batch portion keeps its batch, so it still reads "8 oz cooked · of 45 oz batch" after the meal is gone */
      if (e.mealId && e.batch) { o.batch = true; if (num(e.batchG) > 0) o.batchG = r1(num(e.batchG)); }
      return o;
    };
    const keyOfEntry = e => {
      if (e.mealId && M.meals.get(e.mealId)) return "m:" + e.mealId;
      if (e.foodId) { const f = M.foods.get(e.foodId); if (isObj(f)) return "f:" + f.id; }
      return lc(e.name) + "|" + lc(e.brand);
    };
    Object.values(M.MS.days).forEach(d => {
      if (!isObj(d) || d.pid !== pid || !isStr(d.date) || d.date < from || !Array.isArray(d.entries)) return;
      d.entries.forEach(e => {
        if (!isObj(e) || !e.name) return;
        const k = keyOfEntry(e), inSlot = slot && e.slot === slot && d.date >= from14 ? 1 : 0, at = num(e.at);
        const cur = map.get(k);
        if (!cur) map.set(k, { e, at, count: 1, slotCount: inSlot });
        else { cur.count++; cur.slotCount += inSlot; if (at >= cur.at) { cur.e = e; cur.at = at; } }
      });
    });
    /* the newest entry of each; order on what was logged, then rebuild only the rows handed back */
    const rows = Array.from(map.values()).map(x => Object.assign({ name: x.e.name, brand: x.e.brand || "", count: x.count, slotCount: x.slotCount }, snap(x.e)));
    rows.forEach(o => { o.tiny = tinyRecent(o); });
    rows.sort((a, b) => (a.tiny - b.tiny) || (slot ? b.slotCount - a.slotCount : 0) || b.lastUsed - a.lastUsed);
    return rows.slice(0, n).map(o => { try { return liveRecent(o); } catch (x) { return o; } });
  };

  /* ----------------------------------------------------------------- search */
  /* Words for matching: lowercase, no apostrophes, no leading amounts ("2 eggs",
     "200 g chicken"), one form for plurals (berries → berry, potatoes → potato,
     eggs → egg), split on anything that isn't a letter. Used for queries and names. */
  const AMOUNT_WORDS = new Set(["g", "gram", "grams", "oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds", "kg", "ml", "x", "cup", "cups", "tbsp", "tsp", "of"]);
  function singular(w) {
    if (w.length <= 3) return w;
    if (/ies$/.test(w)) return w.slice(0, -3) + "y";
    if (/oes$/.test(w)) return w.slice(0, -2);
    if (/(sses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
    if (/s$/.test(w) && !/(ss|us)$/.test(w)) return w.slice(0, -1);
    return w;
  }
  M.searchTokens = function (text) {
    const s = lc(text).replace(/['’‘`]/g, "");
    const parts = s.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < parts.length && /^[\d.,/½¼¾⅓⅔×x-]+$/.test(parts[i]) && /[\d½¼¾⅓⅔]/.test(parts[i])) {
      i++;
      while (i < parts.length && AMOUNT_WORDS.has(parts[i])) i++;
    }
    return parts.slice(i).join(" ").split(/[^\p{L}]+/u).filter(Boolean).map(singular);
  };
  const tokens = q => M.searchTokens(q);
  const tokCache = new Map();
  function toksOf(s) {
    s = String(s == null ? "" : s);
    let t = tokCache.get(s);
    if (!t) { t = M.searchTokens(s); if (tokCache.size > 5000) tokCache.clear(); tokCache.set(s, t); }
    return t;
  }
  /* -1 = no match; otherwise higher is better. Every word must hit the name, brand, kw or extra.
     Whole words beat word starts, which beat letters inside a word. The head noun of
     the name ("rice" in "White rice", not in "Rice cake") counts most.
     kw = words that count like name words ("raw" / "cooked" on meat, rice, pasta). */
  /* The words of a name (and brand), worked out once per name. */
  const nameCache = new Map();
  function nameInfo(name, brand) {
    const key = String(name == null ? "" : name) + "\u0001" + String(brand == null ? "" : brand);
    let o = nameCache.get(key);
    if (o) return o;
    const n = lc(name), words = toksOf(name), bw = toksOf(brand);
    /* a name that repeats its brand ("Dave's Killer Bread Powerseed") is matched without it */
    let hw = toksOf(n.split(/[,(]/)[0]);
    if (bw.length && bw.every(w => hw.indexOf(w) >= 0)) { const nb = hw.filter(w => bw.indexOf(w) < 0); if (nb.length) hw = nb; }
    o = { n, plain: n.replace(/['’]/g, ""), words, bw, lb: lc(brand), hw, head: hw.length ? hw[hw.length - 1] : "", j: words.join(" "), nums: n.match(NUMS) || [] };
    if (nameCache.size > 5000) nameCache.clear();
    nameCache.set(key, o);
    return o;
  }
  let scoreWeak = false;   /* set by scoreText: some word only matched inside another word, a brand or the description */
  let scoreInside = false; /* set by scoreText: some word only matched inside another word ("oil" in "boiled") */
  function scoreText(toks, name, brand, extra, kw) {
    const ni = nameInfo(name, brand), n = ni.n, words = ni.words, bw = ni.bw, hw = ni.hw, headNoun = ni.head;
    const xw = toksOf(extra), kws = toksOf(kw);
    let s = 0;
    scoreWeak = false; scoreInside = false;
    for (const t of toks) {
      if (hw.length === 1 && hw[0] === t) s += 50;
      else if (t === headNoun) s += 36;
      else if (hw.indexOf(t) >= 0) s += 28 + (hw[0] === t ? 2 : 0);
      else if (words.indexOf(t) >= 0 || kws.indexOf(t) >= 0) s += 22;
      else if (words.some(w => w.startsWith(t))) s += 14 + (words[0] && words[0].startsWith(t) ? 4 : 0);
      else if (bw.indexOf(t) >= 0) s += 12;
      else if (kws.some(w => w.startsWith(t))) s += 10;
      /* letters inside a word only for 4+ letters ("pb" never finds Raspberries) */
      else if (t.length >= 4 && ni.plain.includes(t)) { s += 8; scoreWeak = true; scoreInside = true; }
      else if (bw.some(w => w.startsWith(t)) || (t.length >= 4 && ni.lb.includes(t))) { s += 6; scoreWeak = true; }
      else if (xw.some(w => w.startsWith(t))) { s += 3; scoreWeak = true; }
      else return -1;
    }
    return s - Math.min(8, n.length / 10);
  }
  /* A word the person may leave out ("grilled", "organic", "cup"): a small plus when the
     food has it, a small minus when it doesn't. Never needed for a match. */
  function optHit(t, name, brand, extra, kw) {
    const ni = nameInfo(name, brand), st = w => w.startsWith(t);
    return ni.words.some(st) || ni.bw.some(st) || toksOf(kw).some(st) || toksOf(extra).some(st);
  }
  function scoreQuery(pq, name, brand, extra, kw) {
    let s = scoreText(pq.req, name, brand, extra, kw);
    if (s < 0) return -1;
    for (const o of pq.opt) s += optHit(o, name, brand, extra, kw) ? 2 : -3;
    return s;
  }

  /* ------------------------------------------------ what the person typed */
  /* "2 large eggs", "6oz chicken", "chicken 6 oz", "a cup of milk", "eggs x2", "half cup rice":
     amounts, counts and size words go; prep and package words ("grilled", "boneless",
     "organic", "deli", "low fat") and bare units ("cup") may be missing from the food.
     → { req: words a food must have, opt: words it may have, all: every word left } */
  const Q_FILL = new Set(["large", "medium", "small", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "a", "an", "of", "the", "half", "scoop", "piece", "glass", "handful", "bowl", "serving", "and", "with", "x", "some"]);
  const Q_OPT = new Set(["grilled", "baked", "roasted", "rotisserie", "fried", "scrambled", "boneless", "skinless", "organic", "signature", "fillet", "filet", "deli", "lunchmeat", "natural", "plain", "frozen", "tender", "strip",
    "g", "gram", "oz", "ounce", "lb", "pound", "kg", "ml", "cup", "tbsp", "tsp", "tablespoon", "teaspoon", "slice", "can", "bottle", "container", "packet", "stick",
    /* count words after a food ("6 asparagus spears", "2 links sausage") */
    "spear", "stalk", "clove", "ear", "wedge", "link", "sprig", "bunch"]);
  /* Words that only describe a food. When no food has every word, these may be left
     out ("red onion" → Onion, "chopped tomato" → Tomato). Other words never are:
     "string cheese" is not Cottage cheese, "garlic bread" is not Dave's. */
  const Q_DESC = new Set(["red", "green", "yellow", "white", "brown", "black", "purple", "fresh", "whole", "sliced", "chopped", "diced", "minced", "shredded", "steamed", "boiled", "mashed", "canned", "dried", "baby", "mini", "jumbo", "lean", "wild", "ripe", "raw", "cooked"]);
  const Q_OPT2 = [["low", "fat"], ["lunch", "meat"], ["reduced", "fat"], ["fat", "free"]];
  const Q_UNIT = "g|grams?|gr|kg|oz|ounces?|lbs?|pounds?|ml|cups?|c|tbsps?|tablespoons?|tsps?|teaspoons?|slices?|pieces?|pcs|servings?|scoops?";
  const Q_AMT = new RegExp("(?:\\d+\\s*\\/\\s*\\d+|\\d+(?:[.,]\\d+)?\\s*[½¼¾⅓⅔⅛]?|[½¼¾⅓⅔⅛])\\s*(?:" + Q_UNIT + ")?(?![\\p{L}])", "gu");
  /* numbers that name a food ("ground beef 90/10", "5% greek yogurt", "21 whole grains") */
  const NUMS = /\d+(?:[.,]\d+)?(?:\/\d+)?%?/g;
  /* MF-01: a lean/fat ratio also answers to each side ("90/10" → "90", "10"), and a
     nonfat / fat-free / skim food answers to "0%". */
  const ratioParts = x => { const m = /^(\d{1,2})\/(\d{1,2})$/.exec(x); return m && +m[1] + +m[2] === 100 ? [m[1], m[2]] : null; };
  function nameNums(ni) {
    if (ni.numSet) return ni.numSet;
    const s = new Set();
    ni.nums.forEach(x => { s.add(x); const p = ratioParts(x); if (p) { s.add(p[0]); s.add(p[1]); } });
    if (/\bnon-?fat\b|\bfat[- ]free\b|\bskim\b/.test(ni.n)) s.add("0%");
    ni.numSet = s;
    return s;
  }
  /* The query's numbers that can name a food: "90 10" and "90-10" → "90/10" too. */
  function queryNums(s) {
    const out = s.match(NUMS) || [];
    const re = /(?:^|[^\d.,/])(\d{1,2})\s*(?:-|–|\s)\s*(\d{1,2})(?![\d/.,])/g;
    let m;
    while ((m = re.exec(s))) { if (+m[1] + +m[2] === 100) out.push(m[1] + "/" + m[2]); re.lastIndex = m.index + m[0].length - m[2].length; }
    return out;
  }
  /* A plain "ground beef" (no ratio typed) → 80/20 first: USDA's standard ground beef and
     the grind stores sell most. A ratio or a "%" typed picks that one instead. */
  const COMMON_RATIO = "80/20";
  const ratioAsked = nums => nums.some(x => /[/%]/.test(x) || (+x >= 50 && +x < 100));
  /* the query names a ratio or a % ("90/10", "90 10", "2%", "ground beef 90"; not "60 g oats") */
  const Q_RATIO_BARE = new RegExp("(?:^|\\s)([5-9]\\d)(?![\\d.,/%])(?!\\s*(?:" + "g|grams?|gr|kg|oz|ounces?|lbs?|pounds?|ml|cups?|c|tbsps?|tablespoons?|tsps?|teaspoons?|slices?|pieces?|pcs|servings?|scoops?" + ")(?![\\p{L}]))", "u");
  const numAsked = (q, nums) => nums.some(x => /[/%]/.test(x)) || Q_RATIO_BARE.test(lc(q));
  const numHit = (pq, r) => {
    const ns = nameNums(nameInfo(r.name, r.brand)), qn = pq.nums || [];
    let b = 0;
    qn.forEach(x => { if (ns.has(x)) b += 16; });
    if (!b && ns.has(COMMON_RATIO) && !(pq.asked !== undefined ? pq.asked : ratioAsked(qn))) b += 1.5;
    return b;
  };
  const qCache = new Map();
  function searchQuery(q, noPb) {
    const key = String(q == null ? "" : q);
    let o = qCache.get((noPb ? "\u0002" : "") + key);
    if (o) return o;
    let s = lc(key).replace(/['’‘`]/g, "");
    if (!noPb) s = s.replace(/\bpb\s*(?:&|and|n)\s*j\b|\bpbj\b|\bpb\b/g, " peanut butter ");
    s = s.replace(/(^|\s)[×x]\s*\d+(?:\.\d+)?(?![\p{L}])/gu, "$1 ").replace(/\d+(?:\.\d+)?\s*[×x](?![\p{L}])/gu, " ");
    s = s.replace(Q_AMT, " ");
    const all = M.searchTokens(s);
    const fill = all.map(t => Q_FILL.has(t)), opt = all.map(t => Q_OPT.has(t));
    /* "half and half" / "half & half" is a food, not an amount */
    for (let i = 0; i + 1 < all.length; i++) {
      if (all[i] !== "half") continue;
      const j = all[i + 1] === "and" && all[i + 2] === "half" ? i + 2 : all[i + 1] === "half" ? i + 1 : -1;
      if (j > 0) { fill[i] = fill[j] = false; i = j; }
    }
    for (let i = 0; i + 1 < all.length; i++) Q_OPT2.forEach(p => { if (all[i] === p[0] && all[i + 1] === p[1]) opt[i] = opt[i + 1] = true; });
    const kept = all.filter((t, i) => !fill[i]);
    let req = all.filter((t, i) => !fill[i] && !opt[i]), op = all.filter((t, i) => !fill[i] && opt[i]);
    if (!req.length) { req = op; op = []; }
    if (!req.length) req = all.slice();
    const nums = queryNums(lc(key));
    o = { req, opt: op, all: kept.length ? kept : all.slice(), nums, asked: numAsked(key, nums), fill: all.filter((t, i) => fill[i]) };
    if (qCache.size > 500) qCache.clear();
    qCache.set((noPb ? "\u0002" : "") + key, o);
    return o;
  }
  M.searchQuery = q => { const o = searchQuery(q); return { req: o.req.slice(), opt: o.opt.slice(), all: o.all.slice() }; };

  /* L1: M.searchAmount(q) → { qty, unit, state } or null: the amount typed in a Log food
     search. unit = the unit word, singular ("egg", "cup", "oz", "g", "slice", "breast",
     "tbsp"…; a count with no unit word gives the food word: "2 eggs" → egg). state =
     "raw" | "cooked" | "dry" | null. Only a state ("cooked rice") → qty and unit null.
     Nothing found → null. */
  const AMT_UNIT = { g: "g", gr: "g", gram: "g", grams: "g", kg: "kg", kgs: "kg", oz: "oz", ounce: "oz", ounces: "oz", lb: "lb", lbs: "lb", pound: "lb", pounds: "lb", ml: "ml",
    cup: "cup", cups: "cup", c: "cup", tbsp: "tbsp", tbsps: "tbsp", tbs: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp", tsp: "tsp", tsps: "tsp", teaspoon: "tsp", teaspoons: "tsp",
    slice: "slice", slices: "slice", piece: "piece", pieces: "piece", pc: "piece", pcs: "piece", serving: "serving", servings: "serving", scoop: "scoop", scoops: "scoop",
    can: "can", cans: "can", bottle: "bottle", bottles: "bottle", container: "container", containers: "container", packet: "packet", packets: "packet", stick: "stick", sticks: "stick",
    link: "link", links: "link", spear: "spear", spears: "spear", breast: "breast", breasts: "breast", glass: "glass", glasses: "glass", shot: "shot", shots: "shot" };
  const AMT_WORD = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5, quarter: 0.25 };
  const AMT_SKIP = new Set(["large", "medium", "small", "jumbo", "extra", "big", "of", "the", "whole", "raw", "cooked", "dry", "uncooked", "fresh", "a", "an"]);
  const AFRAC = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };
  M.searchAmount = function (q) {
    let s = lc(String(q == null ? "" : q)).replace(/['’‘`]/g, "");
    if (!s.trim()) return null;
    const state = /\b(?:raw|uncooked)\b/.test(s) ? "raw" : /\bdry\b/.test(s) ? "dry" : /\bcooked\b/.test(s) ? "cooked" : null;
    s = s.replace(/(\d)\s*([½¼¾⅓⅔⅛])/g, (m, d, f) => " " + (+d + AFRAC[f]) + " ").replace(/[½¼¾⅓⅔⅛]/g, f => " " + AFRAC[f] + " ");
    s = s.replace(/\b(\d+)\s+(\d)\/(\d{1,2})\b/g, (m, a, n, d) => " " + (+a + n / d) + " ");
    s = s.replace(/(?:^|\s)(\d{1,2})\/(\d{1,2})(?=\s|$)/g, (m, n, d) => (+n + +d === 100 ? m : " " + (n / d) + " "));   /* 90/10 is a ratio, not an amount */
    s = s.replace(/(\d)(?=[a-z])/g, "$1 ").replace(/\b[x×](\d)/g, "x $1").replace(/(\d)[x×]\b/g, "$1 x");
    const w = s.split(/[\s,;]+/).filter(Boolean);
    let qty = null, at = -1;
    for (let i = 0; i < w.length; i++) {
      const t = w[i];
      if (/^\d+(?:\.\d+)?$/.test(t) && !/%$/.test(w[i + 1] || "") ) {
        if (w[i + 1] === "%" ) continue;
        qty = +t; at = i;
        if (w[i + 1] && /^\d+(?:\.\d+)?$/.test(w[i + 1]) && +t + +w[i + 1] === 100) { qty = null; at = -1; i++; continue; }   /* "90 10" */
        break;
      }
      if (hasOwn(AMT_WORD, t) && (t !== "a" && t !== "an" || (w[i + 1] && (hasOwn(AMT_UNIT, w[i + 1]) || AMT_WORD[w[i + 1]] === 0.5 || w[i + 1] === "cup")))) {
        qty = AMT_WORD[t]; at = i;
        if ((t === "a" || t === "an") && w[i + 1] === "half") { qty = 0.5; at = i + 1; }
        else if (t === "half" && (w[i + 1] === "a" || w[i + 1] === "an")) at = i + 1;
        break;
      }
    }
    if (qty == null) {
      /* "a banana": an article right before a food word counts as 1 */
      if (/^(?:a|an|one)\s+[a-z]/.test(s.trim())) { qty = 1; at = 0; }
      else return state ? { qty: null, unit: null, state } : null;
    }
    if (!(qty > 0)) return state ? { qty: null, unit: null, state } : null;
    let unit = null;
    for (let j = at + 1; j < w.length; j++) {
      const t = w[j];
      if (t === "x" || AMT_SKIP.has(t)) continue;
      if (hasOwn(AMT_UNIT, t)) unit = AMT_UNIT[t];
      break;
    }
    if (!unit) {
      /* a count: the food word it counts ("2 large eggs" → egg, "eggs x2" → egg, "3 chicken breasts" → breast) */
      const food = w.filter((t, i) => i !== at && !/^[\d.]+$/.test(t) && t !== "x" && !AMT_SKIP.has(t) && !hasOwn(AMT_WORD, t) && /^[a-z]/.test(t));
      const last = food.length ? singular(food[food.length - 1].replace(/[^a-z]/g, "")) : "";
      unit = last ? (hasOwn(AMT_UNIT, last) ? AMT_UNIT[last] : last) : null;
    }
    return { qty: Math.round(qty * 1000) / 1000, unit, state };
  };

  /* Typos: "chiken", "cotage cheese", "bannana", "hilshire", "peanutbutter". One letter off
     for words of 4+ letters, two for 7+, against the words of the foods on hand. */
  function editDist(a, b, max) {
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    let p2 = null, p1 = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) p1[j] = j;
    for (let i = 1; i <= la; i++) {
      const c = new Array(lb + 1); c[0] = i;
      let rowMin = c[0];
      for (let j = 1; j <= lb; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(p1[j] + 1, c[j - 1] + 1, p1[j - 1] + cost);
        if (p2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, p2[j - 2] + 1);   /* swapped letters */
        c[j] = v; if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      p2 = p1; p1 = c;
    }
    return p1[lb];
  }
  const fuzzMax = t => (t.length >= 7 ? 2 : t.length >= 4 ? 1 : 0);
  const NO_FIX = new Set(["crab", "clam", "cram"]);
  const sortedLetters = w => w.split("").sort().join("");
  /* Typo distance with guards against real words that aren't in the app: in a word
     under 6 letters only a missing, extra or swapped letter counts ("coke" is not cake,
     "bull" is not bell, "soup" is not sour); two changes need 8+ letters and the same
     first 2 letters ("creamer" is not creamy, "snickers" is not smuckers). */
  function typoDist(t, w, max) {
    const d = editDist(t, w, max);
    if (d < 1 || d > max) return d;
    if (t.length < 6 && t.length === w.length && sortedLetters(t) !== sortedLetters(w)) return max + 1;
    /* SD-20: a short word keeps its first letter; a real food the app doesn't have is never
       "fixed" into another food ("crab" is not Carb balance tortilla) */
    if (t.length < 6 && t[0] !== w[0]) return max + 1;
    if (NO_FIX.has(t)) return max + 1;
    if (d >= 2 && (t.length < 8 || t.slice(0, 2) !== w.slice(0, 2))) return max + 1;
    return d;
  }
  /* → the query with typo words swapped for real words, or null when nothing changed. */
  function fuzzQuery(pq, vocab) {
    const fix = t => {
      if (vocab.has(t)) return null;
      for (const w of vocab.keys()) if (w.startsWith(t)) return null;   /* a word still being typed */
      /* two words typed as one ("peanutbutter", "lunchmeat") */
      for (let i = 3; i <= t.length - 3; i++) { const a = t.slice(0, i), b = t.slice(i); if (vocab.has(a) && vocab.has(singular(b))) return [a, singular(b)]; }
      const max = fuzzMax(t); if (!max) return null;
      let best = null, bd = max + 1, bf = 0;
      vocab.forEach((f, w) => {
        if (w.length < 3) return;
        /* a real word with more on the end is another food ("brownie", "creamer") */
        if (t.length - w.length >= 2 && t.startsWith(w)) return;
        let d = typoDist(t, w, max);
        /* a typo in a word still being typed ("chike" → chicken): 5+ letters, same first letter */
        if (d > max && w.length - t.length >= 2 && t.length >= 5 && w[0] === t[0]) {
          const pd = Math.min(typoDist(t, w.slice(0, t.length), max), typoDist(t, w.slice(0, t.length + 1), max));
          if (pd <= max) d = pd + 0.5;
        }
        if (d > max + 0.5) return;
        const same = w[0] === t[0] ? 0 : 0.25;
        if (d + same < bd || (d + same === bd && f > bf)) { best = w; bd = d + same; bf = f; }
      });
      return best ? [best] : null;
    };
    let changed = false;
    /* SD-11: one word typed as two ("rib eye" → ribeye) */
    const join = list => { const out = []; for (let i = 0; i < list.length; i++) { const j = i + 1 < list.length ? singular(list[i] + list[i + 1]) : ""; if (j && (!vocab.has(list[i]) || !vocab.has(list[i + 1])) && vocab.has(j)) { out.push(j); i++; changed = true; } else out.push(list[i]); } return out; };
    const map = list => { const out = []; join(list).forEach(t => { const r = fix(t); if (r) { changed = true; out.push.apply(out, r); } else out.push(t); }); return out; };
    const req = map(pq.req), op = pq.opt.slice(), all = map(pq.all);
    return changed ? { req, opt: op, all, nums: pq.nums, asked: pq.asked } : null;
  }
  const usesBonus = o => Math.min(10, Math.log2(num(o.uses) + 1) * 2);
  /* Cook foods also answer to "raw" / "dry" / "cooked" ("cooked chicken", "dry pasta"). */
  const cookWords = f => { const c = M.cook.of(f); return c ? (c.word === "dry" ? "dry uncooked cooked" : "raw cooked") : ""; };
  /* The words Nick and Katerina use for the foods they buy (built-in foods marked
     staple / alwaysRaw in m-data). These foods come first for these words, still
     below their own saved foods and meals. */
  const hasW = (f, w) => toksOf(f.name).concat(toksOf(f.brand)).some(x => x === w || x.startsWith(w));
  const STAPLE_WORDS = [
    { q: ["chicken", "chicken breast", "breast", "raw chicken", "chicken raw", "chicken breast raw", "raw chicken breast", "cooked chicken", "cooked chicken breast", "chicken breast cooked"],
      hit: f => f.alwaysRaw === true || (f.staple === true && hasW(f, "chicken") && hasW(f, "breast")) },
    { q: ["cottage cheese"], hit: f => f.staple === true && hasW(f, "cottage") && hasW(f, "cheese") },
    { q: ["jam", "jelly", "strawberry jam", "strawberry jelly"], hit: f => f.staple === true && (hasW(f, "jam") || hasW(f, "jelly") || hasW(f, "smucker")) },
    { q: ["turkey", "turkey slice", "slice turkey", "sliced turkey", "deli turkey", "lunch meat", "turkey lunch meat", "turkey deli meat", "deli meat"],
      hit: f => f.staple === true && hasW(f, "turkey") && (hasW(f, "slice") || hasW(f, "deli") || hasW(f, "lunch") || hasW(f, "hillshire")) }
  ];
  function stapleRule(toks) { const q = toks.join(" "); return STAPLE_WORDS.find(r => r.q.indexOf(q) >= 0) || null; }
  const COOK_Q = new Set(["raw", "cooked", "uncooked", "dry"]);
  /* SD-08: the rule for these words, also with raw / cooked left out ("chicken cooked") */
  const ruleFor = pq => stapleRule(pq.req) || stapleRule(pq.all) || stapleRule(pq.req.filter(w => !COOK_Q.has(w))) || stapleRule(pq.all.filter(w => !COOK_Q.has(w)));
  /* Amount words: missing one never pushes a saved food down ("cup of rice"). */
  const Q_MEASURE = new Set(["g", "gram", "oz", "ounce", "lb", "pound", "kg", "ml", "cup", "tbsp", "tsp", "tablespoon", "teaspoon"]);
  const Q_KEEPFILL = new Set(["the", "and", "with", "some", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]);
  /* Their own foods, meals and recents that match on whole words or word starts always
     come before built-in foods (a tier of their own, above any name score). */
  const STAPLE = 12;     /* a built-in food they buy: above other built-in foods */
  const NAMED = 60;      /* a built-in food they named for these words (chicken, turkey, jam, cottage cheese) */
  function foodResult(kind, f) {
    const serving = normServing(f.serving);
    const r = { kind, id: f.id, name: f.name, brand: f.brand || "", sub: M.fmtServing(serving, f), per: normPer(f.per), serving, alts: normAlts(f.alts), foodId: f.id, mealId: null, ref: f };
    const c = M.cook.of(f);
    if (c) { r.cook = c; r.state = "raw"; const l = M.cook.servingLabel(f); if (l) r.sub = l; }
    return r;
  }
  /* L3: a saved meal's owner. pid = who made it (null on old meals); own = made by the
     person searching, or by nobody in particular (old meals). */
  const mealOwn = (m, pid) => { const o = isObj(m) && isPid(m.pid) ? m.pid : null; return { pid: o, own: !o || o === (pid || M.pid()) }; };
  function mealResult(m, pid) {
    const r = { kind: "meal", id: m.id, name: m.name, brand: "", desc: m.desc || "", slot: m.slot, sub: "1 serving", per: normPer(m.per), serving: { qty: 1, unit: "serving", g: null }, alts: [], foodId: null, mealId: m.id, ref: m };
    Object.assign(r, mealOwn(m, pid));
    if (isObj(m.batch) && num(m.batch.cookedG) > 0) {
      /* the batch's own unit when it has one ("Batch · 1,400 g cooked · per 100 g") */
      const u = WEIGHT_G[m.batch.unit] ? m.batch.unit : personUnits(), pg = M.cook.portionG(u);
      Object.assign(r, { batch: true, portionG: pg, per: M.cook.batchPer(m, pg), sub: M.cook.batchSub(m, u), portion: "per " + fmtWeight(pg, famOf(u)) });
    }
    return r;
  }
  function recentResult(rc, pid) {
    const f = rc.foodId ? M.foods.get(rc.foodId) : null;
    const serving = f ? normServing(f.serving) : Object.assign(M.parseServing(rc.servingLabel), rc.g ? { g: rc.g } : {});
    const r = { kind: "recent", id: "r:" + lc(rc.name) + "|" + lc(rc.brand), name: rc.name, brand: rc.brand || "", sub: rc.servingLabel || "1 serving", per: normPer(rc.per), serving, alts: f ? normAlts(f.alts) : [], foodId: rc.foodId || null, mealId: rc.mealId || null, ref: rc };
    if (rc.state) { r.state = rc.state; r.cook = rc.cook || (f && cookLite(f.cook)) || null; }
    /* L3: a recent of a saved meal carries the meal's owner too */
    if (rc.mealId) { const m = ownRec(M.MS.meals, rc.mealId); if (m) Object.assign(r, mealOwn(m, pid)); }
    return r;
  }
  /* opt.recents === false / opt.meals === false leave those out (the add sheet's Foods list),
     so a food already logged still shows up as a food instead of being folded into its recent. */
  /* A saved meal answers to its description and the names of the foods in it. */
  const mealText = m => [m.desc].concat((Array.isArray(m.items) ? m.items : []).map(it => (isObj(it) && isStr(it.name) ? it.name : ""))).filter(Boolean).join(" ");
  /* Built-in foods' extra search words (m-data `words`: "preserves fruit spread"). */
  const foodWords = f => { const w = f && f.words; return Array.isArray(w) ? w.filter(isStr).join(" ") : isStr(w) ? w : ""; };
  function vocabOf(cands) {
    const v = new Map(), add = w => { if (w.length >= 3 || v.has(w)) v.set(w, (v.get(w) || 0) + 1); };
    cands.forEach(c => {
      const ni = nameInfo(c.r.name, c.r.brand);
      ni.words.forEach(add); ni.bw.forEach(add);
      if (c.kw) toksOf(c.kw).forEach(add);
      if (c.extra) toksOf(c.extra).forEach(add);
    });
    return v;
  }
  M.search = function (q, opt) {
    opt = isObj(opt) ? opt : {};
    const pid = opt.pid || M.pid(), slot = opt.slot, limit = num(opt.limit, 40) || 40;
    const wantRecents = opt.recents !== false, wantMeals = opt.meals !== false;
    let pq = searchQuery(q);
    const toks = pq.req;
    const out = [], seen = new Set();
    /* Dedupe: same kind+name+brand, or a food/meal a recent already points at. Saved
       meals only by id (L3): two people's meals with one name both show. */
    const push = r => {
      const keys = r.kind === "meal" ? [] : [r.kind + "|" + lc(r.name) + "|" + lc(r.brand)];
      if (r.foodId) keys.push("f:" + r.foodId);
      if (r.mealId) keys.push("m:" + r.mealId);
      if (keys.some(k => seen.has(k))) return false;
      keys.forEach(k => seen.add(k));
      out.push(r);
      return true;
    };
    /* the person's own meals first, the order of use kept inside each group */
    const mealsOwnFirst = () => { const all = M.meals.list(); return all.filter(m => mealOwn(m, pid).own).concat(all.filter(m => !mealOwn(m, pid).own)); };
    if (!toks.length) {
      /* In a meal: what they ate in this meal lately, their meals for this meal, their
         "Any time" meals, then other recents, other meals and their own foods. */
      const rec = wantRecents ? M.recents(pid, 30, slot) : [];
      const meals = wantMeals ? mealsOwnFirst() : [];
      if (slot) rec.filter(rc => num(rc.slotCount) > 0).forEach(rc => push(recentResult(rc, pid)));
      if (slot) meals.filter(m => m.slot === slot).forEach(m => push(mealResult(m, pid)));
      meals.filter(m => m.slot === "Any").forEach(m => push(mealResult(m, pid)));
      rec.forEach(rc => push(recentResult(rc, pid)));
      meals.forEach(m => push(mealResult(m, pid)));
      M.foods.list().forEach(f => push(foodResult("food", f)));
      return out.slice(0, limit);
    }
    const cands = [];
    const cand = (r, bonus, extra, kw, own, gen) => cands.push({ r, bonus, extra, kw, own, gen });
    if (wantRecents) M.recents(pid, 40, slot).forEach((rc, i) => cand(recentResult(rc, pid), 25 + Math.max(0, 10 - i / 4), "", "", true));
    /* L3: the person's own meals get a small plus over the other person's */
    if (wantMeals) M.meals.list().forEach(m => { const r = mealResult(m, pid); cand(r, 15 + (slot && m.slot === slot ? 25 : m.slot === "Any" ? 6 : 0) + usesBonus(m) + (r.own ? 4 : 0), mealText(m), "", true); });
    /* SD-20: built-in foods' extra words count as weak extra words, not name words */
    M.foods.list().forEach(f => cand(foodResult("food", f), 10 + usesBonus(f), foodWords(f), cookWords(f), true));
    /* built-in foods: a food they named for these words first, then foods they buy,
       then plain meat / fish / rice / pasta (the cook foods) before mixed dishes that share a word */
    genericList().forEach(f => {
      if (!isObj(f) || !f.name) return;
      cand(foodResult("generic", f), (f.staple === true ? STAPLE : 0) + (M.cook.of(f) ? 3 : 0), foodWords(f), cookWords(f), false, f);
    });
    /* SD-10: a filler word that is a whole word of one of their own names ("rice bowl",
       "yogurt bowl") stays, as a word the food may have */
    if (pq.fill && pq.fill.length) {
      const ownW = new Set();
      cands.forEach(c => { if (c.own) nameInfo(c.r.name, c.r.brand).words.forEach(w => ownW.add(w)); });
      const keep = pq.fill.filter(w => w.length >= 3 && !Q_KEEPFILL.has(w) && ownW.has(w) && pq.req.indexOf(w) < 0 && pq.opt.indexOf(w) < 0);
      if (keep.length) pq = Object.assign({}, pq, { opt: pq.opt.concat(keep), keep });
    }
    /* SD-09: their own names are also matched against the words as typed ("pb&j", "pbj") */
    const rq = /\bpb/.test(lc(q)) ? searchQuery(q, true) : null;
    const rqLetters = rq ? rq.all.join("") : "";
    /* MF-01: a typed ratio or % ("ground beef 90/10", "2% milk"): a saved item without it drops like one missing a word */
    const askedNum = !!pq.asked;
    const pass = (pq, fuzzy) => {
      const qn = pq.req.join(" "), rule = ruleFor(pq), res = [];
      cands.forEach(c => {
        let named = false;
        /* SD-08: the food they named for these words, or a recent / saved food pointing at it */
        const g = c.gen || (rule && c.r.kind !== "meal" && c.r.foodId && !ownRec(M.MS.foods, c.r.foodId) ? genericById(c.r.foodId) : null);
        if (rule && g) { try { named = !!rule.hit(g); } catch (e) {} }
        /* a kept word ("chicken bowl") must be in the named food too */
        if (named && pq.keep && pq.keep.some(w => !optHit(w, c.r.name, c.r.brand, "", c.kw))) named = false;
        let s = scoreQuery(pq, c.r.name, c.r.brand, c.extra, c.kw);
        let weak = scoreWeak, inside = s >= 0 && scoreInside, exact = nameInfo(c.r.name, c.r.brand).j === qn;
        if (rq && c.own && !fuzzy) {
          const ni = nameInfo(c.r.name, c.r.brand);
          let s2 = scoreQuery(rq, c.r.name, c.r.brand, c.extra, c.kw);
          const w2 = scoreWeak;
          if (rqLetters.length >= 2 && ni.words.join("") === rqLetters) { s2 = Math.max(s2, 50); exact = true; }
          if (s2 > s) { s = s2; weak = w2 && !exact; inside = false; }
        }
        if (s < 0) { if (!named) return; s = 0; }
        /* SD-08: a saved item missing a word the query has ("turkey slices" → Turkey wrap)
           drops to the built-in foods' tier, without its own bonus */
        /* (the word must be in its own name: a meal's ingredients don't count here) */
        const miss = c.own && !named && (pq.opt.some(o => !Q_MEASURE.has(o) && !optHit(o, c.r.name, c.r.brand, "", c.kw)) || (askedNum && !numHit(pq, c.r)));
        const tier = named || (c.own && !weak && !miss) ? 0 : 1;
        /* a saved item found only through its ingredients or brand ranks like a built-in food */
        const bonus = c.own && (miss || weak) ? 0 : c.bonus;
        res.push({ r: c.r, inside, tier: tier + (fuzzy ? 2 : 0), s: s + bonus + (named ? NAMED : 0) + (exact ? 40 : 0) + numHit(pq, c.r) });
      });
      /* letters inside a word ("apple" in Pineapple) only when no word matches whole or at its start */
      return res.some(x => !x.inside) ? res.filter(x => !x.inside) : res;
    };
    let scored = pass(pq, false);
    /* fewer than 3 hits: try again with typos fixed; those come after the exact hits */
    let fq = null;
    if (scored.length < 3) { fq = fuzzQuery(pq, vocabOf(cands)); if (fq) scored = scored.concat(pass(fq, true)); }
    /* a typo fix that hits whole words beats letters inside another word ("aple": Apple, not Maple syrup) */
    if (scored.some(x => x.inside) && scored.some(x => !x.inside)) scored = scored.filter(x => !x.inside);
    /* still nothing ("red onion", "chopped tomato"): the last word must match and the
       describing words before it may be missing. Never drops a word that names a food. */
    const lq = fq || pq;
    if (!scored.length && lq.req.length > 1) {
      /* MF-01: a describing word anywhere may go ("lean ground beef", "ground beef lean") */
      const keep = lq.req.filter(w => !Q_DESC.has(w)), drop = lq.req.filter(w => Q_DESC.has(w));
      if (keep.length && drop.length) scored = pass({ req: keep, opt: drop.concat(lq.opt), all: lq.all, nums: lq.nums, asked: lq.asked }, true);
    }
    scored.sort((a, b) => a.tier - b.tier || b.s - a.s || lc(a.r.name).localeCompare(lc(b.r.name)));
    for (const x of scored) { if (out.length >= limit) break; push(x.r); }
    return out;
  };

  /* --------------------------------------------------------------- checkins */
  /* Whole calendar days from a time to today: a check-in comes due in the morning of its
     day, not at the clock time of the last one. */
  const daysSince = ts => (num(ts) > 0 ? M.daysBetween(M.tsToKey(num(ts)), M.today()) : 0);
  const snoozed = until => num(until) > 0 && M.today() < M.tsToKey(num(until));
  M.checkins = {
    due(pid) {
      pid = pid || M.pid(); if (!pid) return null;
      const p = M.person(pid), sn = p.snooze || {};
      if (!p.setupAt) return "setup";
      if (daysSince(p.setupAt) >= 60 && !snoozed(sn.refresh60)) return "refresh60";
      /* The 2-week weigh-in clock runs from the last weigh-in only (setup sets it:
         setup collects a weight). A 60-day refresh doesn't reset it. */
      const lastBody = num(p.lastBody) || num(p.setupAt);
      if (daysSince(lastBody) >= 14 && !snoozed(sn.body14)) return "body14";
      return null;
    },
    /* Days / whole weeks since the last weigh-in ("body14") or setup ("refresh60"), for the card's words. */
    daysSince(pid, kind) {
      const p = M.person(pid || M.pid());
      return daysSince(kind === "refresh60" ? p.setupAt : num(p.lastBody) || num(p.setupAt));
    },
    weeksSince(pid, kind) { return Math.floor(M.checkins.daysSince(pid, kind) / 7); },
    snooze(pid, kind, days) {
      const p = M.person(pid || M.pid());
      if (!isObj(p.snooze)) p.snooze = { refresh60: 0, body14: 0 };
      /* noon of the calendar day it comes back: "7 days" stays 7 days across a clock change */
      const back = parseKey(M.addDays(M.today(), Math.max(1, Math.round(num(days, 7)))));
      back.setHours(12, 0, 0, 0);
      p.snooze[kind] = back.getTime();
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
    },
    /* After the person edits their numbers (You): a complete profile that was never set
       up counts as set up; a due 60-day refresh counts as done. Saves only when
       something changed. → what's due now. */
    numbersChanged(pid) {
      pid = pid || M.pid(); if (!isPid(pid)) return null;
      const p = M.person(pid), now = M.now();
      if (!isObj(p.snooze)) p.snooze = { refresh60: 0, body14: 0 };
      let changed = false;
      if (!p.setupAt) { if (M.calc.complete(p)) { p.setupAt = now; if (!p.lastBody) p.lastBody = now; changed = true; } }
      else if (daysSince(p.setupAt) >= 60) { p.setupAt = now; p.snooze.refresh60 = 0; changed = true; }
      if (changed) { p.updatedAt = now; M.save(); }
      return M.checkins.due(pid);
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
    /* Today is still going: its bar shows (sofar: true) but it stays out of the
       averages, unless it is the only day logged. */
    const today = M.today(), daily = [], acc = { cal: 0, p: 0, c: 0, f: 0 }, tAcc = { cal: 0, p: 0, c: 0, f: 0 };
    let logged = 0, full = 0, todayLogged = false;
    for (let i = 0; i < 7; i++) {
      const date = M.addDays(start, i);
      const d = pid ? M.dayOf(date, pid) : null;
      const es = d && Array.isArray(d.entries) ? d.entries.filter(isObj) : [];
      const has = es.length > 0;
      const t = has ? M.log.shown(date, pid) : M.foodMath.blank();   /* K1: the Diary's numbers */
      const into = date === today ? tAcc : acc;
      if (has) { logged++; if (date === today) todayLogged = true; else full++; into.cal += t.cal; into.p += t.p; into.c += t.c; into.f += t.f; }
      const row = { date, logged: has, cal: t.cal, p: t.p, c: t.c, f: t.f };
      if (date === today) row.sofar = true;
      daily.push(row);
    }
    const useToday = !full && todayLogged, n = useToday ? 1 : full, src = useToday ? tAcc : acc;
    const avg = k => (n ? r0(src[k] / n) : 0);
    return { days: 7, start, end, logged, avgDays: n, todayLeftOut: todayLogged && !useToday, avgCal: avg("cal"), avgP: avg("p"), avgC: avg("c"), avgF: avg("f"), daily, target: M.cp(p.targets) };
  };

  /* ---------------------------------------------------------- export/import */
  function mergeById(dst, src, tsKey) {
    Object.keys(isObj(src) ? src : {}).forEach(id => {
      if (!okKey(id)) return;
      const a = hasOwn(dst, id) ? dst[id] : null, b = src[id];
      if (!isObj(b)) return;
      if (!isObj(a) || num(b[tsKey]) >= num(a[tsKey])) dst[id] = b;
    });
  }
  /* When a profile last changed (the same clock sync uses). */
  const profTs = p => Math.max(num(p.updatedAt), num(p.setupAt), num(p.lastBody));
  /* Names, brands and descriptions are capped at 120 characters. */
  const cap = v => (isStr(v) && v.length > 120 ? v.slice(0, 120) : v);
  function capRec(r) { if (isObj(r)) ["name", "brand", "desc"].forEach(k => { if (isStr(r[k])) r[k] = cap(r[k]); }); return r; }
  /* ------------------------------------------------------------------ clean */
  /* K4: M.clean(kind, id, rec) → a cleaned copy of one stored record, or null when it
     can't be used. kind: "food" | "meal" | "day" | "body" | "profile". Rules (from
     m-sync's cleaner): only JSON values and own keys ("__proto__" never), finite
     numbers in sane ranges, names capped, entries and items are objects in an array,
     every entry has an id and a real meal, servings > 0, foodId / mealId that aren't
     safe keys are dropped, weigh-ins must pass M.body.check. Clean data comes back
     the same. */
  const C_LEN = 120, C_MAX = 1e6;
  function scrubJSON(v, d) {
    if (Array.isArray(v)) return d > 40 ? [] : v.map(x => { const y = scrubJSON(x, d + 1); return y === undefined ? null : y; });
    if (v && typeof v === "object") {
      const o = {};
      if (d > 40) return o;
      Object.keys(v).forEach(k => { if (BAD_KEYS.has(k)) return; const x = scrubJSON(v[k], d + 1); if (x !== undefined) o[k] = x; });
      return o;
    }
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v === "string" || typeof v === "boolean" || v === null) return v;
    return undefined;
  }
  function cStr(o, k, max, dflt) {
    if (!(k in o)) { if (dflt !== undefined) o[k] = dflt; return; }
    if (typeof o[k] === "number") o[k] = String(o[k]);
    if (typeof o[k] !== "string") { if (dflt === undefined) delete o[k]; else o[k] = dflt; return; }
    if (o[k].length > max) o[k] = o[k].slice(0, max);
  }
  /* a number in [min, max]; else null (nul) or the field goes */
  function cNum(o, k, nul, min, max) {
    if (!(k in o)) return;
    let v = o[k];
    if (v === null && nul) return;
    if (typeof v === "string" && v.trim() !== "" && isFinite(+v)) v = +v;
    if (!isNum(v) || (min != null && v < min) || v > (max == null ? C_MAX * 1e7 : max)) { if (nul) o[k] = null; else delete o[k]; return; }
    o[k] = v;
  }
  function cPer(o, k, keepNull) {
    if (!(k in o)) { if (k === "per") o.per = M.foodMath.blank(); return; }
    if (!isObj(o[k])) { if (k === "per" || !keepNull) o[k] = k === "per" ? M.foodMath.blank() : null; return; }
    const p = o[k];
    Object.keys(p).forEach(n => { let v = p[n]; if (typeof v === "string" && v.trim() !== "" && isFinite(+v)) v = +v; p[n] = isNum(v) && v >= 0 && v <= C_MAX ? v : 0; });
  }
  function cCook(o) {
    if (!("cook" in o)) return;
    if (!cookLite(o.cook)) { delete o.cook; return; }
    cNum(o.cook, "y", false, 0, 20); cStr(o.cook, "word", 12);
    if ("per100gCooked" in o.cook) cPer(o.cook, "per100gCooked", true);
    if ("alts" in o.cook && !Array.isArray(o.cook.alts)) delete o.cook.alts;
  }
  const cKey = (o, k) => { if (k in o && !((isNum(o[k]) && o[k] > 0) || (okKey(o[k]) && o[k].length <= 120))) delete o[k]; };
  function cLine(it, dflt) {   /* a diary entry or a meal item */
    cStr(it, "name", C_LEN, dflt); cStr(it, "brand", C_LEN, "");
    cNum(it, "servings", false, 1e-9, 1e4);
    if ("servings" in it && !(it.servings > 0)) delete it.servings;
    cStr(it, "servingLabel", C_LEN); cNum(it, "g", true, 0, C_MAX); cPer(it, "per");
    cNum(it, "at", false, 0); cKey(it, "foodId"); cKey(it, "mealId");
    if ("state" in it && it.state !== "raw" && it.state !== "cooked") delete it.state;
    cCook(it);
    cNum(it, "batchG", false, 0, C_MAX);
    cNum(it, "u", false, 0);   /* L2 edit stamp */
    if (!okKey(it.id) || it.id.length > 120) it.id = M.uid();
    return it;
  }
  const C_DAYID = /^(nick|kat)\|(\d{4}-\d{2}-\d{2})$/;
  const C_FIX = {
    food(o, id) {
      o.id = id;
      cStr(o, "name", C_LEN, "Food"); cStr(o, "brand", C_LEN, ""); cStr(o, "barcode", 40, ""); cStr(o, "source", 40, "custom");
      if ("serving" in o) {
        if (!isObj(o.serving)) o.serving = { qty: 1, unit: "serving", g: null };
        else { cNum(o.serving, "qty", false, 1e-9, 1e4); cStr(o.serving, "unit", 60, "serving"); cNum(o.serving, "g", true, 0, C_MAX); }
      }
      cPer(o, "per"); if ("per100g" in o) cPer(o, "per100g", true);
      if ("alts" in o) o.alts = Array.isArray(o.alts) ? o.alts.filter(a => isObj(a) && isStr(a.label)).map(a => { cStr(a, "label", C_LEN); cNum(a, "g", true, 0, C_MAX); return a; }) : [];
      cCook(o);
      ["createdAt", "updatedAt", "uses", "lastUsed", "u"].forEach(k => cNum(o, k, false, 0));
      return o;
    },
    meal(o, id) {
      o.id = id;
      cStr(o, "name", C_LEN, "Meal"); cStr(o, "desc", C_LEN, "");
      if (!(o.slot === "Any" || M.isSlot(o.slot))) o.slot = "Any";
      o.items = Array.isArray(o.items) ? o.items.filter(isObj).map(it => cLine(it, "Item")) : [];
      cNum(o, "servingsMade", false, 1e-9, 1e4); cPer(o, "per");
      if ("batch" in o) { if (!isObj(o.batch)) delete o.batch; else { cNum(o.batch, "cookedG", false, 0, C_MAX); cNum(o.batch, "rawG", false, 0, C_MAX); if (o.batch.unit !== undefined && ["g", "oz", "lb"].indexOf(o.batch.unit) < 0) delete o.batch.unit; } }
      ["createdAt", "updatedAt", "uses", "lastUsed", "u"].forEach(k => cNum(o, k, false, 0));
      return o;
    },
    day(o, id) {
      const m = C_DAYID.exec(id); if (!m) return null;
      o.id = id; o.pid = m[1]; o.date = m[2];
      o.entries = Array.isArray(o.entries) ? o.entries.filter(isObj) : [];
      const ids = new Set();
      o.entries.forEach(e => {
        cLine(e, "Food");
        if (ids.has(e.id)) e.id = M.uid();
        ids.add(e.id);
        if (!M.isSlot(e.slot)) e.slot = isNum(e.at) && e.at > 0 ? M.defaultSlot(new Date(e.at)) : "Snacks";
      });
      cNum(o, "water", false, 0, 1e4); if (!isNum(o.water)) o.water = 0;
      cStr(o, "note", 1000, "");
      cNum(o, "updatedAt", false, 0); if (!isNum(o.updatedAt)) o.updatedAt = 0;
      return o;
    },
    body(o, id) {
      const m = C_DAYID.exec(id); if (!m) return null;
      o.id = id; o.pid = m[1]; o.date = m[2];
      cNum(o, "w", true, 0); cNum(o, "rhr", true, 0); cNum(o, "at", false, 0);
      if (o.w != null && !M.body.check(o.w, "w", "us").ok) o.w = null;
      if (o.rhr != null && !M.body.check(o.rhr, "rhr").ok) o.rhr = null;
      if (o.w == null && o.rhr == null) return null;
      if (o.at > M.now() + DAY) o.at = M.now();
      return o;
    },
    profile(o, id) {
      if (!isPid(id)) return null;
      o.id = id;
      cStr(o, "name", C_LEN);
      if ("sex" in o && o.sex !== null && o.sex !== "m" && o.sex !== "f") o.sex = null;
      ["age", "heightIn", "weightLb", "goalWeightLb", "setupAt"].forEach(k => cNum(o, k, true, 0));
      ["pace", "lastBody", "updatedAt"].forEach(k => cNum(o, k, false));
      cStr(o, "activity", 20); cStr(o, "split", 20); cStr(o, "aiModel", 80);
      if ("units" in o && o.units !== "us" && o.units !== "metric") o.units = "us";
      if ("targetsManual" in o && typeof o.targetsManual !== "boolean") delete o.targetsManual;
      ["custom", "targets", "snooze"].forEach(k => {
        if (!(k in o)) return;
        if (!isObj(o[k])) { delete o[k]; return; }
        Object.keys(o[k]).forEach(n => cNum(o[k], n, false, k === "snooze" ? 0 : -1e4, C_MAX * 1e7));
      });
      return o;
    }
  };
  M.clean = function (kind, id, rec) {
    if (!isObj(rec) || !okKey(id) || !hasOwn(C_FIX, kind)) return null;
    const o = scrubJSON(rec, 0);
    if (!isObj(o)) return null;
    try { return C_FIX[kind](o, id) || null; } catch (e) { return null; }
  };

  M.export = () => M.cp(M.MS);
  M.import = function (obj) {
    if (!isObj(obj) || obj.v !== 1) return false;
    const cur = M.MS, inc = shape(M.cp(obj));
    /* K4: every incoming record cleaned first; one that can't be used is left out */
    [["profiles", "profile"], ["foods", "food"], ["meals", "meal"], ["days", "day"], ["body", "body"]].forEach(([k, kind]) => {
      const src = inc[k], out = {};
      Object.keys(src).forEach(id => { const c = M.clean(kind, id, src[id]); if (c) out[id] = c; });
      inc[k] = out;
    });
    /* profiles one by one: a set-up profile beats one never set up; else the newer one wins */
    Object.keys(inc.profiles).forEach(id => {
      if (!isPid(id)) return;
      const b = inc.profiles[id], a = hasOwn(cur.profiles, id) ? cur.profiles[id] : null;
      if (!isObj(b)) return;
      if (!isObj(a) || (!a.setupAt && b.setupAt)) { cur.profiles[id] = b; return; }
      if (a.setupAt && !b.setupAt) return;
      if (profTs(b) >= profTs(a)) cur.profiles[id] = b;
    });
    Object.keys(inc.foods).forEach(id => capRec(inc.foods[id]));
    Object.keys(inc.meals).forEach(id => capRec(inc.meals[id]));
    Object.keys(inc.days).forEach(id => { const d = inc.days[id]; if (Array.isArray(d.entries)) { d.entries = d.entries.filter(isObj); d.entries.forEach(capRec); } });
    mergeById(cur.foods, inc.foods, "updatedAt");
    mergeById(cur.meals, inc.meals, "updatedAt");
    mergeById(cur.days, inc.days, "updatedAt");
    mergeById(cur.body, inc.body, "at");
    if (isObj(inc.codes)) { if (!isObj(cur.codes)) cur.codes = {}; Object.keys(inc.codes).forEach(k => { if (!hasOwn(cur.codes, k)) cur.codes[k] = inc.codes[k]; }); }
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

  /* --------------------------------------------------------------- two tabs */
  /* CO-08: another tab (desktop) saved: read the new copy and redraw, so this tab never
     writes its older copy over it. Waits while a box here has focus (typing). */
  let otherTab = false;
  function otherTabSaved() {
    otherTab = false;
    /* this tab's own last save failed (phone full): what it holds is only in memory,
       so it is kept, never swapped for the other tab's copy. The next save retries. */
    if (!M.storage.ok) return;
    try { M.load(); } catch (e) { return; }
    rerender();
  }
  try {
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("storage", ev => {
        if (!ev || (ev.key !== M.KEY && ev.key !== null)) return;
        if (ev.key === null && lsGet(M.KEY) == null) return;
        const a = typeof document !== "undefined" ? document.activeElement : null;
        if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName || "")) { otherTab = true; return; }
        otherTabSaved();
      });
      if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
        document.addEventListener("focusout", () => { if (otherTab) setTimeout(() => { const a = document.activeElement; if (otherTab && !(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName || ""))) otherTabSaved(); }, 0); }, true);
      }
    }
  } catch (e) {}

  /* ------------------------------------------------------------------- boot */
  try { M.load(); } catch (e) { M.MS = freshState(); }
})(window.M);
