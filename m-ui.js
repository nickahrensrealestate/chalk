window.M = window.M || {};
/* ============================================================================
   Chalk · Macros — UI (M.ui)
   Shell (mode bar, tabs, event delegation), Diary, Add-food flows (search,
   barcode, label, photo, describe, suggest), entry edit, Foods tab (saved
   meals, meal builder, my foods, food form). All markup uses data-m
   attributes; Chalk's own data-a is only reused for sheet-close and the
   person picker. Views for Trends / You and the check-in cards come from
   m-trends.js, which extends M.ui.views / M.ui.actions after this file.
   Plain ES2020, never throws at load, Chalk globals read lazily.
   ========================================================================== */
(function (M) {
  "use strict";

  M.ui = M.ui || {};
  const UI = M.ui;
  UI.tab = UI.tab || "diary";
  UI.date = UI.date || null;
  UI.actions = UI.actions || {};
  UI.inputs = UI.inputs || {};
  UI.changes = UI.changes || {};
  UI.views = UI.views || {};
  UI.draft = UI.draft || null;      /* meal-builder draft, survives sheet closes */
  UI.more = !!UI.more;              /* "More" section open on the diary day card */
  UI.foodsSeg = UI.foodsSeg || "meals";
  UI.foodsQ = UI.foodsQ || "";

  /* ---------------------------------------------------------------- helpers */
  const A = UI.actions, I = UI.inputs, C = UI.changes;
  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  const isNum = v => typeof v === "number" && isFinite(v);
  function num(v, d) { if (d === undefined) d = 0; if (typeof v === "string") v = parseFloat(v.replace(",", ".")); return isNum(v) ? v : d; }
  const r0 = v => Math.round(v + (v >= 0 ? 1e-9 : -1e-9));
  const r1 = v => Math.round(v * 10 + (v >= 0 ? 1e-9 : -1e-9)) / 10;
  const r2 = v => Math.round(v * 100 + (v >= 0 ? 1e-9 : -1e-9)) / 100;
  const qstep = (v, dir, min) => Math.max(min == null ? 0 : min, r2(Math.round((v + dir * 0.25) * 4) / 4));
  const esc = s => M.esc(s);
  const $ = id => (typeof document === "undefined" ? null : document.getElementById(id));
  const qs = (sel, root) => (root || document).querySelector(sel);
  const qsa = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));
  const fmtQty = n => String(+num(n, 1).toFixed(2));
  const kcal = v => String(r0(num(v)));
  const g0 = v => String(r0(num(v)));
  const lc = s => String(s == null ? "" : s).toLowerCase();
  const NUT = ["cal", "p", "c", "f", "fiber", "sugar", "sodium"];
  const pid = () => M.pid();
  const today = () => M.today();
  /* The day on screen. A Diary left on "today" follows the clock: after midnight
     (the app sat in the background all night) it moves to the new day, and so
     does an open Log food / servings sheet. A day picked on purpose stays. */
  let seenToday = null;
  function rollDay() {
    const t = today();
    if (seenToday && seenToday !== t) {
      if (UI.date === seenToday) UI.date = t;
      if (add && add.date === seenToday) add.date = t;
      if (det && det.mode !== "edit" && det.date === seenToday) det.date = t;
    }
    seenToday = t;
    if (!UI.date) UI.date = t;
    return t;
  }
  const date = () => { rollDay(); return UI.date; };
  /* " · Yesterday" / " · Fri, Sep 25" for a day that isn't today; "" for today. */
  const dayTag = d => (d && d !== today() ? " · " + M.fmtDay(d) : "");
  const personName = id => { try { const p = M.person(id || pid()); return p && p.name ? p.name : "You"; } catch (e) { return "You"; } };
  const slotOr = s => (M.isSlot(s) ? s : M.defaultSlot());
  const macroLine = per => "P " + g0(per.p) + " · C " + g0(per.c) + " · F " + g0(per.f);
  const errMsg = e => (isObj(e) && e.message ? String(e.message) : e && e.message ? String(e.message) : "Something went wrong. Try again.");
  const scaleTo100 = (per, g) => { if (!(num(g) > 0)) return null; const o = {}; NUT.forEach(k => { const v = num(per && per[k]) * 100 / g; o[k] = k === "cal" || k === "sodium" ? r0(v) : r1(v); }); return o; };
  const perOfGrams = (per100, g) => M.foodMath.fromPer100(per100, g);
  /* servingsOf: a saved entry (blank → 1). rawServings: what the person typed (0 stays 0 so it can be skipped). */
  const servingsOf = e => (num(e && e.servings, 1) > 0 ? num(e.servings, 1) : 1);
  const rawServings = e => Math.max(0, num(e && e.servings, 1));
  const entryTotals = e => M.foodMath.scale(e.per, rawServings(e));
  const isGramLabel = l => /^1\s*g$/i.test(String(l || ""));
  /* "100 g (100 g)" → "100 g" (labels built from a gram-only serving repeat themselves) */
  const tidyLabel = l => String(l == null ? "" : l).replace(/^(\d+(?:\.\d+)?)\s*g\s*\(\s*\1(?:\.0)?\s*g\s*\)$/i, "$1 g");
  const units = () => { try { const p = M.person(); return p && p.units === "metric" ? "metric" : "us"; } catch (e) { return "us"; } };
  /* Meat, fish, rice, pasta: raw first, cooked in parentheses ("6 oz raw (4.4 oz cooked)"). "" for other foods. */
  const cookText = e => { try { return M.cook ? M.cook.entryLabel(e, units()) : ""; } catch (x) { return ""; } };
  /* Units counted in whole pieces: the stepper moves by 1 and amounts fold ("3 eggs"). */
  const COUNT_U = /^(eggs?|whites?|slices?|tortillas?|pieces?|pcs?|bars?|scoops?|medium|large|small|jumbo|cans?|bottles?|containers?|links?|patt(?:y|ies)|sticks?|packets?|pouch(?:es)?|cookies?|crackers?|fillets?|wraps?|buns?|bagels?|muffins?|each|items?)$/i;
  const MEASURE_U = /^(cups?|tbsp|tsp|oz|fl oz|g|ml|lb|kg|l)$/i;
  const PLURAL = { egg: "eggs", white: "whites", slice: "slices", tortilla: "tortillas", piece: "pieces", bar: "bars", scoop: "scoops", can: "cans", bottle: "bottles", container: "containers", link: "links", patty: "patties", stick: "sticks", packet: "packets", pouch: "pouches", cookie: "cookies", cracker: "crackers", fillet: "fillets", wrap: "wraps", bun: "buns", bagel: "bagels", muffin: "muffins", item: "items", serving: "servings", cup: "cups" };
  const unitOfLabel = l => String(M.parseServing(l).unit || "").trim();
  /* "large egg", "slice", "2 whites": any word that counts pieces */
  const isCountUnit = u => lc(u).split(/[^a-z]+/).filter(Boolean).some(w => COUNT_U.test(w));
  /* "large egg" × 3 → "large eggs": the last word follows the number */
  function unitNoun(u, n) {
    const parts = String(u).split(" "), last = lc(parts[parts.length - 1]);
    let one = last; Object.keys(PLURAL).forEach(k => { if (PLURAL[k] === last) one = k; });
    if (PLURAL[one]) parts[parts.length - 1] = Math.abs(n - 1) < 1e-9 ? one : PLURAL[one];
    return parts.join(" ");
  }
  /* { text, grams } for `servings` of a label: "2 eggs" + 100, "1.5 cups" + 360, "150 g" + null,
     "2 × 1 bowl" when the unit is one we don't know. gEach = grams of one label when the label doesn't say. */
  function amountParts(servings, label, gEach) {
    const s = Math.max(0, num(servings, 1)), l = tidyLabel(label) || "1 serving";
    if (isGramLabel(l)) return { text: fmtQty(s) + " g", grams: null };
    const p = M.parseServing(l), u = String(p.unit || "").trim(), lu = lc(u);
    const hasG = /\(\s*[\d.]+\s*g\s*\)\s*$/i.test(l), gl = num(p.g) > 0 ? num(p.g) : (!hasG && num(gEach) > 0 ? num(gEach) : 0);
    if (lu === "g") return { text: fmtQty(s * p.qty) + " g", grams: null };
    const known = (isCountUnit(u) || MEASURE_U.test(u) || /^servings?$/.test(lu)) && p.qty > 0;
    if (Math.abs(s - 1) < 1e-9) return known && num(p.g) > 0 ? { text: l.replace(/\s*\(\s*[\d.]+\s*g\s*\)\s*$/i, ""), grams: r0(num(p.g)) } : { text: l, grams: !hasG && gl > 0 ? r0(gl) : null };
    if (!known) return { text: fmtQty(s) + " × " + l, grams: null };
    const tot = s * p.qty;
    return { text: fmtQty(tot) + " " + unitNoun(u, tot), grams: gl > 0 ? r0(s * gl) : null };
  }
  /* Plain text amount: "2 eggs", "3 large (150 g)", "1.5 cups (360 g)", "150 g", "1 cup (240 g)". Not escaped. */
  function amountText(servings, label, gEach) { const a = amountParts(servings, label, gEach); return a.text + (a.grams != null ? " (" + a.grams + " g)" : ""); }
  /* HTML-escaped amount of an entry-like: the cook label, "150 g", "2 eggs", "1.5 cups (360 g)". */
  const amountLabel = e => { const c = cookText(e); if (c) return esc(c); return esc(amountText(e.servings, e.servingLabel, e.g)); };
  /* Same, for lists of items that are mostly one serving (suggestions, photo / describe items). */
  const itemAmount = e => { const c = cookText(e); if (c) return esc(c); return servingsOf(e) === 1 ? esc(tidyLabel(e.servingLabel) || "1 serving") : amountLabel(e); };
  /* state / cook fields to carry from an item into an entry or meal item */
  const cookOf = it => (it && (it.state === "raw" || it.state === "cooked") ? (it.cook ? { state: it.state, cook: it.cook } : { state: it.state }) : {});

  /* Two-tap confirmation inside a sheet (no confirm()). Returns true on the 2nd tap. */
  const armed = new WeakMap();
  function confirmTap(el, label) {
    if (!el) return true;
    if (armed.get(el)) { clearTimeout(armed.get(el)); armed.delete(el); return true; }
    const old = el.innerHTML;
    el.innerHTML = "Tap again to " + esc(label);
    el.classList.add("m-armed");
    armed.set(el, setTimeout(() => { armed.delete(el); try { el.innerHTML = old; el.classList.remove("m-armed"); } catch (e) {} }, 3500));
    return false;
  }

  /* Object URLs for photo previews, revoked when the sheet closes. */
  let urls = [];
  function objURL(file) {
    try { const u = URL.createObjectURL(file); urls.push(u); return u; } catch (e) { return ""; }
  }
  function revokeURLs() { urls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} }); urls = []; }

  /* ---------------------------------------------------------------- sheet */
  UI.sheet = function (title, html) {
    if (typeof openSheet === "function") { openSheet(title, html); return; }
    const t = $("sheetT"), b = $("sheetB"), bg = $("sheetBg"), sh = $("sheet");
    if (t) t.textContent = title; if (b) { b.innerHTML = html; b.scrollTop = 0; }
    if (bg) bg.classList.add("on"); if (sh) sh.classList.add("on");
  };
  /* Everything that must stop when any sheet goes away (also runs on Chalk's × and backdrop). */
  UI.cleanup = function () {
    try { if (M.food && M.food.scanner && typeof M.food.scanner.stop === "function") M.food.scanner.stop(); } catch (e) {}
    revokeURLs();
    /* a field left focused in a closed sheet keeps the keyboard up and holds back re-renders */
    try { const a = document.activeElement, sh = $("sheet"); if (a && sh && a !== document.body && sh.contains(a) && a.blur) a.blur(); } catch (e) {}
    add = null; det = null; sug = null; items = null; ff = null; menu = null; mealSheet = null; quick = null;
  };
  UI.close = function () {
    UI.cleanup();
    if (typeof closeSheet === "function") { closeSheet(); return; }
    const bg = $("sheetBg"), sh = $("sheet");
    if (bg) bg.classList.remove("on"); if (sh) sh.classList.remove("on");
  };
  UI.sheetOpen = function () { const sh = $("sheet"); return !!(sh && sh.classList.contains("on")); };
  UI.toast = function (m) {
    if (typeof toast === "function") { toast(m); return; }
    const t = $("toast"); if (!t) return;
    t.textContent = m; t.classList.add("on"); clearTimeout(UI._toastT); UI._toastT = setTimeout(() => t.classList.remove("on"), 1800);
  };
  /* ------------------------------------------------ focus-safe re-render */
  /* On iPhone, rebuilding the screen while someone moves between form fields
     destroys the field they just tapped and drops the keyboard. So while a
     keyboard field inside #app or #sheet has focus, render() / rerender()
     wait: once focus leaves form fields entirely (focusout, then a
     setTimeout(0) look at document.activeElement) they render once. A tap on
     a button renders right away and flushes anything waiting. */
  const KEY_TYPES = /^(text|search|number|tel|email|url|password|date|time|datetime-local|month|week)$/i;
  function typingIn() {
    if (typeof document === "undefined") return null;
    const a = document.activeElement;
    if (!a || !a.tagName) return null;
    if (a.tagName === "INPUT") { if (!KEY_TYPES.test(a.getAttribute("type") || "text")) return null; }
    else if (a.tagName !== "SELECT" && a.tagName !== "TEXTAREA") return null;
    const app = $("app"), sh = $("sheet");
    return (app && app.contains(a)) || (sh && sh.contains(a)) ? a : null;
  }
  let pend = null, inClick = false, focusHooked = false;
  function hookFocus() {
    if (focusHooked || typeof document === "undefined") return;
    focusHooked = true;
    document.addEventListener("focusout", () => { if (pend) setTimeout(() => { if (pend && !typingIn()) flushPending(); }, 0); }, true);
  }
  function flushPending() {
    const k = pend; pend = null; if (!k) return;
    const was = inClick; inClick = true;   /* a flush always renders */
    try { if (k === "rerender") UI.rerender(); else UI.render(); } finally { inClick = was; }
  }
  function deferRender(kind) {
    if (inClick || !typingIn()) return false;
    if (pend !== "rerender") pend = kind;   /* rerender covers render */
    hookFocus();
    return true;
  }
  UI.pendingRender = () => pend;
  UI.rerender = function () {
    if (deferRender("rerender")) return;
    pend = null;
    return typeof render === "function" ? render() : UI.render();
  };

  /* ---------------------------------------------------------------- chrome */
  const ICONS = {
    diary: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
    foods: '<svg viewBox="0 0 24 24"><path d="M4 11h16a8 8 0 0 1-16 0z"/><path d="M8 11V8M12 11V6M16 11V8M6 20h12"/></svg>',
    trends: '<svg viewBox="0 0 24 24"><path d="M4 20V11M10 20V5M16 20v-8M22 20H2"/></svg>',
    you: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>'
  };
  UI.tabsHTML = function () {
    return [["diary", "Diary"], ["foods", "Foods"], ["trends", "Trends"], ["you", "You"]]
      .map(t => '<button data-mtab="' + t[0] + '"' + (UI.tab === t[0] ? ' class="on" aria-current="page"' : "") + ">" + ICONS[t[0]].replace("<svg ", '<svg aria-hidden="true" ') + t[1] + "</button>").join("");
  };
  UI.chrome = function () {
    if (typeof document === "undefined") return;
    const mode = M.mode();
    qsa("#modebar button[data-v]").forEach(b => b.classList.toggle("on", b.dataset.v === mode));
    const tabs = $("tabs"); if (!tabs) return;
    const isMacro = !!tabs.querySelector("[data-mtab]");
    if (mode === "macros") {
      if (!isMacro) tabs.innerHTML = UI.tabsHTML();
      qsa("button[data-mtab]", tabs).forEach(b => { const on = b.dataset.mtab === UI.tab; b.classList.toggle("on", on); if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
    } else if (isMacro) {
      let train = null;
      try { if (typeof TRAIN_TABS === "string") train = TRAIN_TABS; } catch (e) {}
      if (train == null && typeof window !== "undefined" && typeof window.TRAIN_TABS === "string") train = window.TRAIN_TABS;
      if (train != null) tabs.innerHTML = train;
    }
  };

  /* ---------------------------------------------------------------- render */
  let lastTab = null, lastSetup = false;
  /* Scroll memory per mode + tab ("macros|diary", "train|today"): switching
     Train ↔ Macros or between tabs comes back to where you were. */
  const scrollAt = {};
  function trainTab() { try { return typeof tab !== "undefined" && tab ? String(tab) : "today"; } catch (e) { return "today"; } }
  const scrollKey = () => (M.mode() === "macros" ? "macros|" + UI.tab : "train|" + trainTab());
  function saveScroll(key) { const sc = $("scroll"); if (sc) scrollAt[key || scrollKey()] = sc.scrollTop; }
  function restoreScroll(key) { const sc = $("scroll"); if (sc) sc.scrollTop = scrollAt[key || scrollKey()] || 0; }
  UI.saveScroll = saveScroll; UI.restoreScroll = restoreScroll;
  function pickerHTML() {
    let P = null; try { if (typeof PRESETS !== "undefined") P = PRESETS; } catch (e) {}
    const people = [["nick", "Nick"], ["kat", "Katerina"]];
    return '<div class="card"><div class="hd"><h3>Who is this?</h3></div><div class="bd"><p class="hint" style="margin-bottom:10px">Pick your name. Training and macros both follow it.</p></div></div>' +
      people.map(p => { const name = P && P[p[0]] && P[p[0]].name ? P[p[0]].name : p[1]; return '<div class="card"><div class="hd"><h3>' + esc(name) + '</h3></div><div class="bd"><button class="btn primary block" data-a="pick-profile" data-v="' + p[0] + '">Use this</button></div></div>'; }).join("");
  }
  function loadingCard(tab) { return '<div class="card"><div class="empty">Loading…</div></div>'; }
  UI.render = function () {
    if (typeof document === "undefined") return;
    if (deferRender("render")) return;
    pend = null;
    const app = $("app"), title = $("title"), sub = $("subtitle"), cta = $("cta");
    if (!app) return;
    rollDay();
    UI.chrome();
    if (title) title.textContent = "Macros";
    const id = pid();
    if (!id) {
      if (sub) sub.textContent = "";
      app.innerHTML = pickerHTML();
      if (cta) { cta.classList.remove("on"); cta.innerHTML = ""; }
      return;
    }
    const tab = UI.tab;
    if (sub) sub.textContent = personName(id) + (tab === "diary" ? " · " + M.fmtDay(date()) : "");
    let html;
    const view = UI.views[tab];
    try { html = typeof view === "function" ? view() : loadingCard(tab); }
    catch (e) { html = '<div class="card"><div class="bd"><p class="hint">Something went wrong drawing this screen. ' + esc(errMsg(e)) + '</p><button class="btn block" data-m="tab" data-v="diary" style="margin-top:8px">Back to Diary</button></div></div>'; try { console.error(e); } catch (x) {} }
    const sc = $("scroll");
    if (lastTab && lastTab !== tab && sc) scrollAt["macros|" + lastTab] = sc.scrollTop;
    app.innerHTML = html;
    let setupNow = false;
    if (tab === "diary") { try { setupNow = M.checkins.due(id) === "setup"; } catch (e) { setupNow = false; } }
    if (cta) {
      const show = tab === "diary" && !setupNow;
      cta.classList.toggle("on", show);
      cta.innerHTML = show ? '<button class="btn primary block" data-m="add" data-slot="">+ Log food</button>' : "";
    }
    if (lastTab !== tab) { restoreScroll("macros|" + tab); lastTab = tab; }
    else if (lastSetup && !setupNow && sc) sc.scrollTop = 0;   /* first-day setup just saved: start at the top */
    lastSetup = setupNow;
  };

  /* ---------------------------------------------------------------- bind */
  const FORM = { INPUT: 1, SELECT: 1, TEXTAREA: 1, LABEL: 1 };
  function dispatch(map, el, e) {
    const name = el.dataset.m; const fn = map[name];
    if (typeof fn !== "function") return false;
    try { fn(el, e); } catch (err) { try { console.error("m-ui " + name, err); } catch (x) {} UI.toast(errMsg(err)); }
    return true;
  }
  UI.bind = function () {
    if (typeof document === "undefined" || document.__mUiBound) return;
    document.__mUiBound = true;
    hookFocus();
    /* button taps render right away (capture runs before every handler; the
       window listener runs after all of them and flushes anything waiting) */
    document.addEventListener("click", e => {
      const b = e.target && e.target.closest ? e.target.closest("button,[role=button],a[href]") : null;
      if (!b) return;
      inClick = true;
      setTimeout(() => { if (inClick) { inClick = false; if (pend) flushPending(); } }, 0);
    }, true);
    const W = document.defaultView;
    if (W && typeof W.addEventListener === "function") W.addEventListener("click", () => { if (!inClick) return; if (pend) flushPending(); inClick = false; });
    /* storage: tell the person once per failure streak; say so when the backup copy was used */
    if (typeof M.onStorageError === "function") M.onStorageError(() => UI.toast("Phone storage is full. Back up in Train → Settings."));
    if (M.storage && M.storage.restoredFrom) setTimeout(() => UI.toast("Your macros were damaged. Restored the daily backup copy."), 600);
    document.addEventListener("click", e => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-a="sheet-close"]') || t.id === "sheetBg") {
        const back = !!(add && add.onPick && UI.draft);   /* picking an item for the meal builder: return to it */
        UI.cleanup();
        if (back) setTimeout(() => { if (UI.draft && !UI.sheetOpen()) UI.openBuilder(); }, 260);
        return;
      }
      const el = t.closest("[data-m]");
      if (!el) return;
      if (FORM[el.tagName]) return;                       /* inputs/selects use input/change */
      if (t !== el && t.closest("input,select,textarea,label")) return;
      if (el.tagName === "BUTTON" && el.disabled) return;
      dispatch(A, el, e);
    });
    document.addEventListener("input", e => { const el = e.target && e.target.closest ? e.target.closest("[data-m]") : null; if (el) dispatch(I, el, e); });
    document.addEventListener("change", e => { const el = e.target && e.target.closest ? e.target.closest("[data-m]") : null; if (el) dispatch(C, el, e); });
    document.addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      const el = e.target && e.target.closest ? e.target.closest("[data-m]") : null;
      if (!el) return;
      const name = el.dataset.m;
      if (name === "code-in") { e.preventDefault(); A["code-lookup"](el, e); }
      else if (name === "search" || name === "foods-q") { try { el.blur(); } catch (x) {} }
    });
    /* Back from the background (iPhone keeps the app in memory overnight): follow the clock. */
    const wake = () => {
      if (document.visibilityState === "hidden") return;
      const was = seenToday; rollDay();
      if (!was || was === seenToday) return;
      retitle();
      if (M.mode() === "macros") UI.rerender();
    };
    document.addEventListener("visibilitychange", wake);
    if (W && typeof W.addEventListener === "function") { W.addEventListener("pageshow", wake); W.addEventListener("focus", wake); }
    /* Log food: while the search box is in use, the tools step aside so results sit above the keyboard */
    document.addEventListener("focusin", e => { if (e.target && e.target.id === "m-search") searchMode(true); });
    document.addEventListener("focusout", e => { if (e.target && e.target.id === "m-search") setTimeout(() => searchMode(), 0); });
  };
  /* Sheet titles name the day when it isn't today ("Log food · Yesterday"). */
  const addTitle = () => (add && add.onPick ? "Add item" : "Log food" + dayTag(add ? add.date : date()));
  const detTitle = () => (!det ? "Add" : det.mode === "edit" ? "Edit" + dayTag(det.date) : det.mode === "pick" ? "Add" : "Add" + dayTag(det.date));
  function retitle() {
    const t = $("sheetT"); if (!t || !UI.sheetOpen()) return;
    if (det && $("m-det-box")) t.textContent = detTitle();
    else if (add && $("m-search")) t.textContent = addTitle();
  }
  function searchMode(force) {
    const box = qs(".m-add"), inp = $("m-search"); if (!box) return;
    const on = force === true || !!(inp && (inp.value.trim() || document.activeElement === inp));
    box.classList.toggle("m-typing", on);
  }

  /* Core actions */
  /* data-tab picks the macro tab to land on; data-then="add" opens Log food right away */
  /* Each mode + tab keeps its own scroll spot. */
  A.mode = el => {
    const from = scrollKey(), was = M.mode();
    saveScroll(from);
    const m = M.setMode(el.dataset.tab && !el.dataset.v ? "macros" : el.dataset.v);
    if (m === "macros" && el.dataset.tab) UI.tab = el.dataset.tab;
    if (m === "macros" && UI.tab === "diary") UI.date = today();
    if (m === "macros" && was !== "macros") lastTab = null;
    if (UI.sheetOpen()) UI.close();
    UI.rerender();
    const to = scrollKey();
    if (to !== from) restoreScroll(to);
    if (m === "macros" && el.dataset.then === "add" && pid()) UI.openAdd({ slot: M.defaultSlot(), date: today() });
  };

  /* One-row card for Chalk's Train → Today: calories and protein eaten today vs
     target, and a button into Macros. "" with no person or before first-day setup. */
  UI.trainSummaryHTML = function () {
    const id = pid(); if (!id) return "";
    let p = null; try { p = M.person(id); } catch (e) { return ""; }
    if (!p || !p.setupAt) return "";
    const t = M.log.totals(today(), id), tg = p.targets || {};
    const cell = (v, g, unit, k, cls) => {
      const pct = num(g) > 0 ? Math.min(100, num(v) / num(g) * 100) : 0, over = num(g) > 0 && num(v) > num(g);
      return '<div class="m-ts-c ' + cls + (over ? " over" : "") + '"><div class="m-ts-v num"><b>' + r0(num(v)) + '</b> / ' + r0(num(g)) + unit + '</div><div class="m-ts-k">' + k + '</div><div class="m-ts-bar"><i style="width:' + pct.toFixed(1) + '%"></i></div></div>';
    };
    return '<div class="card m-trainsum"><div class="m-ts">' + cell(t.cal, tg.cal, "", "Calories today", "cal") + cell(t.p, tg.p, " g", "Protein · " + leftText(t.p, tg.p), "pro") +
      '<button class="btn primary m-ts-go" data-m="mode" data-v="macros" data-tab="diary" data-then="add">Log food</button></div></div>';
  };
  /* "44 left" / "6 over" (rounded the same way as the numbers beside it) */
  function leftText(v, g) { const d = r0(num(g)) - r0(num(v)); return d >= 0 ? d + " left" : -d + " over"; }
  /* From Train (e.g. a check-in card's Update), a tab button switches to Macros first. */
  A.tab = el => {
    const v = el.dataset.v || "diary";
    if (M.mode() !== "macros") { saveScroll(); M.setMode("macros"); lastTab = null; }
    UI.tab = v;
    if (UI.sheetOpen()) UI.close();
    UI.rerender();
  };
  A.close = () => UI.close();
  A["day-prev"] = () => { UI.date = M.addDays(date(), -1); UI.render(); };
  A["day-next"] = () => { UI.date = M.addDays(date(), 1); UI.render(); };
  A["day-today"] = () => { UI.date = today(); UI.render(); };
  const waterMl = oz => Math.round(num(oz) * 29.5735 / 50) * 50;
  const moreLabel = () => (UI.more ? "Hide fiber, sugar, water ▴" : "Fiber, sugar, water ▾");
  A.more = el => {
    UI.more = !UI.more;
    const box = $("m-more"); if (box) box.hidden = !UI.more;
    el.innerHTML = moreLabel(); el.setAttribute("aria-expanded", UI.more ? "true" : "false");
  };
  A.water = el => {
    const d = M.day(date());
    const oz = el.dataset.ml != null ? Math.max(0, waterMl(d.water) + num(el.dataset.ml)) / 29.5735 : Math.max(0, num(d.water) + num(el.dataset.v));
    M.log.setWater(date(), oz); UI.render();
  };

  /* ---------------------------------------------------------------- ring + bars */
  UI.ring = function (cal, target) {
    cal = num(cal); target = num(target);
    const r = 52, Cc = 2 * Math.PI * r;
    const pct = target > 0 ? Math.min(1, cal / target) : 0;
    const over = target > 0 && cal > target;
    const left = r0(target - cal);
    return '<svg class="m-ring' + (over ? " over" : "") + '" viewBox="0 0 120 120" width="120" height="120" role="img" aria-label="' + (over ? Math.abs(left) + " calories over" : left + " calories left") + '">' +
      '<circle class="m-ring-bg" cx="60" cy="60" r="' + r + '"/>' +
      '<circle class="m-ring-fg" cx="60" cy="60" r="' + r + '" stroke-dasharray="' + Cc.toFixed(1) + '" stroke-dashoffset="' + (Cc * (1 - pct)).toFixed(1) + '" transform="rotate(-90 60 60)"/>' +
      '<text class="m-ring-n" x="60" y="60" text-anchor="middle">' + Math.abs(left) + '</text>' +
      '<text class="m-ring-l" x="60" y="80" text-anchor="middle">' + (over ? "over" : "left") + '</text></svg>';
  };
  UI.bars = function (t, tg) {
    t = t || {}; tg = tg || {};
    const row = (k, label, cls) => {
      const v = r0(num(t[k])), g = r0(num(tg[k]));
      const pct = g > 0 ? Math.min(100, v / g * 100) : 0, over = g > 0 && v > g;
      return '<div class="m-bar ' + cls + (over ? " over" : "") + '"><div class="m-bar-h"><span>' + label + '</span><span class="num">' + v + ' / ' + g + ' g' + (k === "p" && g > 0 ? " · " + leftText(v, g) : "") + '</span></div><div class="m-bar-t"><i style="width:' + pct.toFixed(1) + '%"></i></div></div>';
    };
    return '<div class="m-bars">' + row("p", "Protein", "pro") + row("c", "Carbs", "carb") + row("f", "Fat", "fat") + "</div>";
  };

  /* Sheet-scoped state (cleared by UI.cleanup). */
  let add = null, det = null, sug = null, items = null, ff = null, menu = null, mealSheet = null;

  /* ================================================================== DIARY */
  function entryRow(e) {
    const tot = entryTotals(e);
    const sub = amountLabel(e) + " · " + macroLine(tot);
    return '<button class="ex-row m-row" data-m="entry" data-id="' + esc(e.id) + '"><div class="ex-main"><div class="n">' + esc(e.name) + (e.brand ? ' <span class="mut small">' + esc(e.brand) + "</span>" : "") + '</div><div class="t">' + sub + '</div></div><div class="m-kcal num">' + kcal(tot.cal) + '</div></button>';
  }
  function slotCard(slot) {
    const list = M.log.slotEntries(date(), slot);
    const tot = M.foodMath.sum(list);
    return '<div class="card m-slot"><div class="hd"><h3>' + slot + '</h3><div class="m-slot-r"><span class="m-slot-kcal num">' + (list.length ? kcal(tot.cal) + " kcal" : "") + '</span><button class="icon" data-m="slot-menu" data-slot="' + slot + '" aria-label="' + slot + ' menu">…</button></div></div>' +
      (list.length ? '<div class="ex-list">' + list.map(entryRow).join("") + "</div>" : "") +
      '<div class="m-slot-add"><button class="btn ghost block" data-m="add" data-slot="' + slot + '">+ Add</button></div></div>';
  }
  function dayCard() {
    const p = M.person(), tg = p.targets || {}, t = M.log.totals(date());
    const d = M.dayOf(date()); const water = d ? num(d.water) : 0;
    const goalOz = num(tg.water, 64), metric = units() === "metric";
    /* water is stored in whole oz; metric shows ml (to the nearest 50) and steps by 250 ml (a glass) */
    const ml = waterMl(water), glasses = Math.floor((metric ? ml / 250 : water / 8) + 1e-6);
    const wTxt = metric ? ml + ' / ' + waterMl(goalOz) + ' ml' : r0(water) + ' / ' + r0(goalOz) + ' oz';
    const wStep = metric ? "250 ml" : "8 oz", wAttr = v => (metric ? 'data-ml="' + v * 250 + '"' : 'data-v="' + v * 8 + '"');
    const isToday = date() === today();
    return '<div class="card m-day"><div class="m-dayhd"><button class="icon" data-m="day-prev" aria-label="Previous day">‹</button><button class="m-daylbl cond" data-m="day-today" aria-label="' + esc(M.fmtDay(date())) + (isToday ? "" : ". Back to today") + '">' + esc(M.fmtDay(date())) + '</button><button class="icon" data-m="day-next" aria-label="Next day">›</button></div>' +
      (isToday ? "" : '<div class="m-backtoday"><button class="btn" data-m="day-today">Back to today</button></div>') +
      '<div class="m-dayrow">' + UI.ring(t.cal, tg.cal) + '<div class="m-daynums"><div class="m-dn"><span class="v num">' + kcal(t.cal) + '</span><span class="k">eaten</span></div><div class="m-dn"><span class="v num">' + kcal(tg.cal) + '</span><span class="k">target</span></div></div></div>' +
      UI.bars(t, tg) +
      '<div class="m-morebtn"><button class="btn ghost" data-m="more" aria-expanded="' + (UI.more ? "true" : "false") + '" aria-controls="m-more">' + moreLabel() + '</button></div>' +
      '<div id="m-more" class="m-more"' + (UI.more ? "" : " hidden") + '><div class="chips"><span class="chip">Fiber ' + g0(t.fiber) + ' / ' + g0(tg.fiber) + ' g</span><span class="chip">Sugar ' + g0(t.sugar) + ' g</span><span class="chip">Sodium ' + g0(t.sodium) + ' mg</span></div>' +
      '<div class="m-water"><div><div class="l">Water</div><div class="s num">' + wTxt + ' · ' + glasses + ' glass' + (glasses === 1 ? "" : "es") + '</div></div><div class="m-water-b"><button class="btn" data-m="water" ' + wAttr(-1) + ' aria-label="Minus ' + wStep + '">− ' + wStep + '</button><button class="btn" data-m="water" ' + wAttr(1) + ' aria-label="Plus ' + wStep + '">+ ' + wStep + '</button></div></div></div></div>';
  }
  UI.views.diary = function () {
    const id = pid();
    let due = null; try { due = M.checkins.due(id); } catch (e) {}
    if (due === "setup") {
      const card = typeof UI.setupCardHTML === "function" ? UI.setupCardHTML() : "";
      return card || '<div class="card"><div class="hd"><h3>Let\'s set your targets</h3></div><div class="bd"><p class="hint" style="margin-bottom:10px">Open the You tab and enter your numbers (sex, age, height, weight). Your calorie and macro targets come from those.</p><button class="btn primary block" data-m="tab" data-v="you">Open You</button></div></div>';
    }
    let banner = ""; try { banner = typeof UI.bannerHTML === "function" ? (UI.bannerHTML() || "") : ""; } catch (e) { banner = ""; }
    const streak = M.streak(id);
    const full = M.storage && M.storage.ok === false ? '<div class="card m-warn" role="alert"><div class="bd"><b>Phone storage is full.</b> New changes are not saved on this phone yet. Back up in Train → Settings.</div></div>' : "";
    return full + banner + dayCard() + M.SLOTS.map(slotCard).join("") +
      '<div class="m-foot">' + (streak > 0 ? '<span class="chip ok">🔥 ' + streak + '-day streak</span>' : '<span class="chip">Log a day to start a streak</span>') + '<button class="btn" data-m="suggest">Suggest a meal</button></div>';
  };

  /* ---------------------------------------------------------- unit options */
  /* Build the unit choices for a food-like {serving, alts, per, per100g, servingLabel, g}. */
  function unitOptions(src) {
    const opts = [];
    const serving = isObj(src.serving) ? src.serving : M.parseServing(src.servingLabel);
    const base = { key: "serving", label: src.servingLabel || M.fmtServing(serving), g: num(serving && serving.g) > 0 ? num(serving.g) : (num(src.g) > 0 ? num(src.g) : null), per: src.per };
    opts.push(base);
    const per100 = isObj(src.per100g) ? src.per100g : (base.g ? scaleTo100(src.per, base.g) : null);
    (Array.isArray(src.alts) ? src.alts : []).forEach((a, i) => {
      if (!a || !a.label || !(num(a.g) > 0) || !per100) return;
      if (lc(a.label) === lc(base.label)) return;
      opts.push({ key: "alt" + i, label: a.label, g: num(a.g), per: perOfGrams(per100, num(a.g)) });
    });
    /* more units: the food's own serving on an entry edit, the unit a recent was logged in last time */
    (Array.isArray(src.moreUnits) ? src.moreUnits : []).forEach((u, i) => {
      if (!isObj(u) || !u.label || !isObj(u.per) || opts.some(o => lc(o.label) === lc(u.label))) return;
      opts.push({ key: "more" + i, label: u.label, g: num(u.g) > 0 ? num(u.g) : null, per: u.per });
    });
    if (per100) { const per1 = {}; NUT.forEach(k => { per1[k] = num(per100[k]) / 100; }); opts.push({ key: "g", label: "g", g: 1, per: per1, grams: true }); }   /* unrounded per gram so 100 g = per100g exactly */
    return opts;
  }
  /* Stepper size: whole pieces for counted units (eggs, slices, tortillas…), 5 for grams, else ¼. */
  const stepFor = o => (det && det.cookMode ? (o.step || 0.25) : o.grams ? 5 : isCountUnit(unitOfLabel(o.label)) ? 1 : 0.25);

  /* ------------------------------------------------------- detail / entry */
  /* det = { src, opts, unit, servings, grams, slot, mode:"log"|"edit"|"pick", entryId, onPick, date,
             cookMode, cook:{y,word}|null, batch:{cookedG,rawG}|null, fromMeal }
     cookMode (meat, fish, rice, pasta, batch meals): opts come from M.cook.unitsFor
     ("oz raw", "oz cooked", "g raw" …) and `servings` is the amount in that unit. */
  const curOpt = () => det.opts.find(x => x.key === det.unit) || det.opts[0];
  const r4 = v => Math.round(v * 1e4) / 1e4;
  function roundQty(q, o) {
    if (!(q > 0)) return 0;
    if (o.vol) return Math.max(0.25, Math.round(q * 4) / 4);
    return o.unit === "g" ? r0(q) : o.unit === "lb" ? r2(q) : r1(q);
  }
  const batchSrc = m => ({ kind: "meal", id: m.id, name: m.name, brand: "", mealId: m.id, ref: m, batchMeal: true, per: m.per });
  /* The portion last logged from a batch meal (cooked grams), for the default amount. */
  function lastPortion(mealId) {
    try { const rc = M.recents(pid(), 60).find(x => x.mealId === mealId && x.state === "cooked"); const i = rc ? M.cook.entryInfo(rc) : null; return i && i.grams > 0 ? i.grams : null; }
    catch (e) { return null; }
  }
  /* { opts, cook, batch, food } for cook foods, batch meals and their entries; null otherwise. */
  function cookSetup(src) {
    if (!M.cook || !isObj(src)) return null;
    const U = units();
    const meal = src.batchMeal && isObj(src.ref) ? src.ref : null;
    if (meal && isObj(meal.batch) && num(meal.batch.cookedG) > 0) {
      const c100 = {}; NUT.forEach(k => { c100[k] = num(meal.per && meal.per[k]) * 100 / num(meal.batch.cookedG); });
      const opts = M.cook.unitsFor(null, U, { only: "cooked", weights: ["oz", "g"], cooked100: c100, vol: false });
      return opts.length ? { opts, cook: M.cook.batchCook(meal), batch: meal.batch } : null;
    }
    const food = src.foodId ? M.foods.get(src.foodId) : (isObj(src.ref) && M.cook.of(src.ref) ? src.ref : null);
    if (food && M.cook.of(food)) {
      const opts = M.cook.unitsFor(food, U), c = M.cook.of(food);
      if (opts.length) return { opts, cook: { y: c.y, word: c.word }, food };
    }
    if (src.state !== "raw" && src.state !== "cooked") return null;
    /* the food is gone, or this is a portion of a batch meal: work from the entry itself */
    const ug = M.cook.unitGrams(src); if (!(ug > 0)) return null;
    const cl = isObj(src.cook) && num(src.cook.y) > 0 ? { y: num(src.cook.y), word: src.cook.word === "dry" ? "dry" : "raw" } : null;
    const p100 = {}; NUT.forEach(k => { p100[k] = num(src.per && src.per[k]) * 100 / ug; });
    const other = f => { if (!cl) return null; const o = {}; NUT.forEach(k => { o[k] = f(p100[k]); }); return o; };
    const raw100 = src.state === "raw" ? p100 : other(v => v * cl.y);
    const ck100 = src.state === "cooked" ? p100 : other(v => v / cl.y);
    const cookedOnly = !!src.mealId || !cl;   /* batch portions are eaten cooked */
    if (cookedOnly && !ck100) return null;
    const opts = M.cook.unitsFor({ cook: cl }, U, { only: cookedOnly ? "cooked" : null, weights: cookedOnly ? ["oz", "g"] : null, raw100, cooked100: ck100, vol: false });
    let batch = null; if (src.mealId) { const m = M.meals.get(src.mealId); if (m && isObj(m.batch)) batch = m.batch; }
    return opts.length ? { opts, cook: cl, batch } : null;
  }
  function detPer() {
    const o = curOpt();
    if (det.cookMode) return { per: o.per, label: "1 " + o.label, g: o.g, servings: det.servings, state: o.state };
    if (o.grams) return { per: o.per, label: "1 g", g: 1, servings: det.grams };
    return { per: o.per, label: o.label, g: o.g, servings: det.servings };
  }
  /* The amount line under the stepper, for every food: "6 oz raw (4.4 oz cooked)", "3 large · 150 g". */
  function detAmountText() {
    const o = curOpt(), d = detPer();
    if (det.cookMode) return M.cook.label(d.servings * o.g, o.state, det.cook, o.vol ? units() : o.unit, { vol: o.vol ? { unit: o.unit, g: o.g } : null });
    if (o.grams) return g0(det.grams) + " g";
    const a = amountParts(det.servings, o.label, o.g);
    return a.text + (a.grams != null ? " · " + a.grams + " g" : "");
  }
  /* The number in the box: exact amounts stay inside `det`, the box shows them rounded. */
  function shownQty() {
    const o = curOpt();
    if (det.cookMode) return String(roundQty(det.servings, o));
    if (o.grams) return String(r0(det.grams));
    return fmtQty(det.servings);
  }
  function detLive() {
    if (!det) return;
    const d = detPer(); const t = M.foodMath.scale(d.per, d.servings);
    const box = $("m-live"); if (!box) return;
    box.innerHTML = '<div class="stat"><div class="v">' + kcal(t.cal) + '<small>kcal</small></div><div class="k">Calories</div></div><div class="stat pro"><div class="v">' + g0(t.p) + '<small>g</small></div><div class="k">Protein</div></div><div class="stat carb"><div class="v">' + g0(t.c) + '<small>g</small></div><div class="k">Carbs</div></div><div class="stat fat"><div class="v">' + g0(t.f) + '<small>g</small></div><div class="k">Fat</div></div>';
    const amt = $("m-det-amt"); if (amt) amt.textContent = detAmountText();
    if (det.cookMode) {
      const o = curOpt();
      const of = $("m-det-of"); if (of && det.batch) of.textContent = "of " + M.cook.fmtWeight(num(det.batch.cookedG), o.vol ? (units() === "metric" ? "g" : "oz") : o.unit) + " cooked";
    }
    if (d.servings > 0) { const msg = $("m-det-msg"); if (msg && msg.textContent) msg.textContent = ""; }
    const btn = $("m-det-go"); if (btn && det.mode !== "pick") btn.textContent = det.mode === "edit" ? "Save" : "Add to " + det.slot;
  }
  function unitControl() {
    if (det.cookMode && det.opts.length <= 3) return '<div class="seg m-useg" role="group" aria-label="Unit">' + det.opts.map(x => '<button data-m="det-useg" data-v="' + x.key + '" aria-pressed="' + (x.key === det.unit) + '"' + (x.key === det.unit ? ' class="on"' : "") + '>' + esc(x.unit) + '</button>').join("") + '</div>';
    return '<select class="sel" data-m="det-unit" aria-label="Unit">' + det.opts.map(x => '<option value="' + x.key + '"' + (x.key === det.unit ? " selected" : "") + '>' + esc(x.grams ? "grams" : x.label) + (!det.cookMode && x.g && !x.grams && !/\(\s*[\d.]+\s*g\s*\)/i.test(x.label) ? " (" + fmtQty(x.g) + " g)" : "") + '</option>').join("") + '</select>';
  }
  /* "Move to yesterday" for today's entries, "Move to today" for any other day */
  function dayMoveHTML() {
    const t = today(), to = det.date === t ? M.addDays(t, -1) : t;
    return '<button class="btn block" data-m="det-moveday" data-v="' + to + '">Move to ' + (to === t ? "today" : "yesterday") + '</button>';
  }
  function detailHTML() {
    const s = det.src, o = curOpt();
    const g = !det.cookMode && o.grams;
    const qLbl = det.cookMode ? "Amount" : g ? "Grams" : isCountUnit(unitOfLabel(o.label)) ? "How many" : "Servings";
    return '<div class="m-det">' + (det.back ? '<button class="m-back" data-m="det-back">‹ Back</button>' : "") +
      (det.fromMeal ? "" : '<div class="m-det-name">' + esc(s.name) + (s.brand ? ' <span class="mut">' + esc(s.brand) + "</span>" : "") + '</div>') +
      (det.batch ? '<div class="m-howmuch">How much did you eat?</div>' : "") +
      '<div class="m-det-u"><span class="lbl">Unit</span>' + unitControl() + '</div>' +
      '<div class="m-det-q"><span class="lbl">' + qLbl + '</span><div class="stepper"><button data-m="det-step" data-v="-1" aria-label="Less">−</button><input type="number" inputmode="decimal" step="' + stepFor(o) + '" min="0" data-m="det-qty" value="' + shownQty() + '" aria-label="' + qLbl + '"><button data-m="det-step" data-v="1" aria-label="More">+</button></div></div>' +
      (det.batch ? '<div class="m-det-of" id="m-det-of"></div>' : "") + '<div class="m-det-amt num" id="m-det-amt"></div>' +
      '<div class="m-warnline" id="m-det-msg" role="status"></div>' +
      '<div class="stats m-live" id="m-live"></div>' +
      (det.mode === "pick" ? "" : '<div style="margin-top:10px"><span class="lbl">Meal</span><select class="sel" data-m="det-slot" aria-label="Meal">' + M.SLOTS.map(x => '<option' + (x === det.slot ? " selected" : "") + '>' + x + '</option>').join("") + '</select></div>') +
      '<button class="btn primary block" id="m-det-go" data-m="det-go" style="margin-top:12px">' + (det.mode === "pick" ? "Add to meal" : det.mode === "edit" ? "Save" : "Add to " + det.slot) + '</button>' +
      (det.mode === "edit" ? '<div class="m-btnrow"><button class="btn" data-m="det-move" aria-expanded="false" aria-controls="m-move">Move</button>' + (det.canSaveFood ? '<button class="btn" data-m="det-savefood">Save as food</button>' : "") + '<button class="btn danger" data-m="det-del">Delete</button></div><div id="m-move" hidden class="m-move">' + M.SLOTS.filter(x => x !== det.slot).map(x => '<button class="btn block" data-m="det-moveto" data-v="' + x + '">Move to ' + x + '</button>').join("") + dayMoveHTML() + "</div>" : "") +
      "</div>";
  }
  /* Set `det` for a source. opt: mode, slot, date, entryId, onPick, canSaveFood, fromMeal;
     plain foods: unit / unitLabel / servings / grams; cook mode: unitKey, info (M.cook.entryInfo
     of the entry or recent being reopened), grams (cooked grams of a batch portion). */
  function initDet(src, opt) {
    opt = isObj(opt) ? opt : {};
    const base = { src, slot: slotOr(opt.slot || (add && add.slot)), mode: opt.mode || (add && add.onPick ? "pick" : "log"), entryId: opt.entryId || null, onPick: opt.onPick || (add && add.onPick) || null, canSaveFood: !!opt.canSaveFood, date: opt.date || (add && add.date) || date(), fromMeal: !!opt.fromMeal, back: !!(opt.back && add) };
    const ck = cookSetup(src);
    if (ck) {
      det = Object.assign(base, { cookMode: true, opts: ck.opts, cook: ck.cook || null, batch: ck.batch || null, unit: ck.opts[0].key, servings: 1, grams: 0 });
      const has = k => ck.opts.some(o => o.key === k);
      const fam = units() === "metric" ? "g" : "oz";
      let key = opt.unitKey && has(opt.unitKey) ? opt.unitKey : null, amt = null;
      if (opt.info) {
        const u = opt.info.fam || (opt.info.vol && opt.info.vol.unit) || null;
        if (!key && u && has(u + "-" + opt.info.state)) key = u + "-" + opt.info.state;
        amt = { g: opt.info.grams, state: opt.info.state, exact: true };
      } else if (ck.batch) {
        amt = { g: num(opt.grams) > 0 ? num(opt.grams) : (lastPortion(src.mealId) || M.cook.portionG(units())), state: "cooked" };
      } else if (ck.food) {
        const sv = ck.food.serving || {}, u = M.cook.unitWord(sv.unit);
        if (!key && u && !M.cook.UNIT_G[u] && has(u + "-raw")) key = u + "-raw";   /* rice: "1/4 cup dry" */
        amt = { g: num(sv.g) > 0 ? num(sv.g) : M.cook.portionG(units()), state: "raw" };
      }
      if (!key) key = has(fam + "-" + (amt ? amt.state : "raw")) ? fam + "-" + (amt ? amt.state : "raw") : ck.opts[0].key;
      det.unit = key;
      const o = curOpt();
      if (amt) {
        let g = amt.g;
        if (amt.state !== o.state && det.cook) g = amt.state === "raw" ? g * det.cook.y : g / det.cook.y;
        det.servings = amt.exact ? r4(g / o.g) : roundQty(g / o.g, o);
      }
      return det;
    }
    const opts = unitOptions(src);
    det = Object.assign(base, { opts, unit: opt.unit || "serving", servings: num(opt.servings, 1) > 0 ? num(opt.servings, 1) : 1, grams: num(opt.grams) > 0 ? num(opt.grams) : (opts[0].g || 100) });
    if (opt.unitLabel) { const m = opts.find(x => lc(x.label) === lc(opt.unitLabel)); if (m) det.unit = m.key; }
    if (!opts.some(x => x.key === det.unit)) det.unit = opts[0].key;
    if (det.unit === "g" && opt.grams == null && num(src.g) > 0) det.grams = num(src.g);
    return det;
  }
  /* Open the detail sheet for a result-like source (from search, barcode, label, AI…). */
  UI.openDetail = function (src, opt) {
    initDet(src, opt);
    UI.sheet(detTitle(), '<div id="m-det-box">' + detailHTML() + '</div>');
    detLive();
  };
  /* ‹ Back from the servings screen to the Log food list (same search, same tab) */
  A["det-back"] = () => {
    if (!add) return;
    det = null;
    UI.sheet(addTitle(), addHTML());
    paintResults(); searchMode();
  };
  A["det-step"] = el => {
    if (!det) return;
    const o = curOpt(), st = stepFor(o);
    const dir = num(el.dataset.v, 1);
    const next = v => Math.max(0, r4(Math.round((v + dir * st) / st) * st));
    if (!det.cookMode && o.grams) det.grams = next(det.grams); else det.servings = next(det.servings);
    const inp = qs('[data-m="det-qty"]'); if (inp) inp.value = shownQty();
    detLive();
  };
  I["det-qty"] = el => {
    if (!det) return;
    const o = curOpt();
    const v = Math.max(0, num(el.value));
    if (!det.cookMode && o.grams) det.grams = v; else det.servings = v;
    detLive();
  };
  /* Raw ↔ cooked only says how the typed number was weighed: the number stays.
     oz ↔ g ↔ lb (or cups) converts the number to the new unit. Exact inside, rounded on screen. */
  function setDetUnit(key) {
    if (!det || !det.opts.some(x => x.key === key)) return;
    const was = curOpt();
    det.unit = key;
    const now = curOpt();
    if (det.cookMode) {
      if (was.unit !== now.unit && num(was.g) > 0 && num(now.g) > 0) det.servings = r4(det.servings * was.g / now.g);
    }
    else if (now.grams && !was.grams && was.g) det.grams = r4(was.g * det.servings);
    else if (!now.grams && was.grams && now.g) det.servings = r4(det.grams / now.g);
    const box = $("m-det-box"); if (box) box.innerHTML = detailHTML(); else { const body = $("sheetB"); if (body) body.innerHTML = detailHTML(); }
    detLive();
  }
  C["det-unit"] = el => setDetUnit(el.value);
  A["det-useg"] = el => setDetUnit(el.dataset.v);
  C["det-slot"] = el => { det.slot = el.value; const btn = $("m-det-go"); if (btn && det.mode === "log") btn.textContent = "Add to " + det.slot; };
  function detEntry() {
    const d = detPer(); const s = det.src;
    const e = { name: s.name, brand: s.brand || "", servings: Math.max(0, num(d.servings)), servingLabel: d.label, g: d.g, per: d.per };
    if (det.cookMode) { e.state = d.state; if (det.cook) e.cook = { y: det.cook.y, word: det.cook.word }; }
    if (s.foodId) e.foodId = s.foodId;
    else if (s.id && (s.kind === "food" || s.kind === "generic")) e.foodId = s.id;
    if (s.mealId) e.mealId = s.mealId;
    if (s.source && !e.foodId) e.source = s.source;
    return e;
  }
  /* A food from OFF / AI / label that is not in M.foods yet gets saved (generic never is). */
  function ensureFood(src) {
    if (!src || src.kind === "generic" || src.kind === "meal" || src.mealId) return src;
    if (src.foodId && M.foods.get(src.foodId)) return src;
    const ref = isObj(src.ref) ? src.ref : src;
    if (ref.source === "generic") return src;
    if (!ref.per || !ref.name) return src;
    if (ref.id && M.MS.foods[ref.id]) { src.foodId = ref.id; return src; }
    if (ref.barcode) { const have = M.foods.findByBarcode(ref.barcode); if (have) { src.foodId = have.id; return src; } }
    /* the food was deleted (a recent still points at it): log a plain entry, never re-create a half food */
    if (src.foodId && !M.foods.get(src.foodId)) { delete src.foodId; if (ref !== src && ref.foodId && !M.foods.get(ref.foodId)) delete ref.foodId; return src; }
    if (src.kind === "recent") return src;
    const f = M.foods.add({ id: ref.id && String(ref.id).startsWith("off_") ? ref.id : undefined, name: ref.name, brand: ref.brand || "", barcode: ref.barcode || "", source: ref.source || "custom", serving: ref.serving || M.parseServing(src.servingLabel), per: ref.per, per100g: ref.per100g || null, alts: ref.alts || [] });
    src.foodId = f.id;
    return src;
  }
  A["det-go"] = () => {
    if (!det) return;
    /* 0 (or an empty box) is never saved as 1 */
    if (!(detPer().servings > 0)) {
      const msg = $("m-det-msg");
      if (msg) msg.innerHTML = det.mode === "edit" ? 'Enter an amount. Or delete it: <button class="btn danger m-inline" data-m="det-del">Delete</button>' : "Enter an amount.";
      return;
    }
    if (det.mode === "edit") {
      const d = detPer();
      const patch = { servings: d.servings, servingLabel: d.label, g: d.g, per: d.per, slot: det.slot };
      if (det.cookMode) { patch.state = d.state; patch.cook = det.cook ? { y: det.cook.y, word: det.cook.word } : null; }
      M.log.update(det.date, det.entryId, patch);
      UI.close(); UI.toast("Saved"); UI.render(); return;
    }
    if (det.src.kind !== "meal" && !det.src.mealId) ensureFood(det.src);
    const e = detEntry();
    if (det.mode === "pick" && typeof det.onPick === "function") { const cb = det.onPick; UI.close(); cb(e); return; }
    const slot = det.slot, dt = det.date, fromMeal = det.fromMeal;
    e.slot = slot;
    M.log.add(dt, e);
    UI.close(); UI.toast("Added to " + slot + dayTag(dt));
    if (fromMeal) UI.date = dt;   /* logged from Foods → a saved meal: show that day */
    UI.render();
  };
  A["det-move"] = el => { const b = $("m-move"); if (b) b.hidden = !b.hidden; if (el && el.setAttribute && b) el.setAttribute("aria-expanded", b.hidden ? "false" : "true"); };
  A["det-moveto"] = el => { M.log.move(det.date, det.entryId, el.dataset.v); UI.close(); UI.toast("Moved to " + el.dataset.v); UI.render(); };
  /* Move an entry to another day (logged on the wrong day by mistake) */
  A["det-moveday"] = el => {
    const to = el.dataset.v, from = det && det.date, d = from ? M.dayOf(from) : null;
    const e = d && d.entries.find(x => x.id === det.entryId); if (!e || !to || to === from) return;
    const copy = M.cp(e); delete copy.id;
    M.log.remove(from, e.id); M.log.add(to, copy);
    const n = M.fmtDay(to);
    UI.close(); UI.toast("Moved to " + (/^(Today|Yesterday|Tomorrow)$/.test(n) ? n.toLowerCase() : n)); UI.render();
  };
  A["det-del"] = el => { if (!confirmTap(el, "delete")) return; M.log.remove(det.date, det.entryId); UI.close(); UI.toast("Deleted"); UI.render(); };
  A["det-savefood"] = el => {
    const s = det.src; const d = detPer();
    const f = M.foods.add({ name: s.name, brand: s.brand || "", source: s.source || "custom", serving: M.parseServing(s.servingLabel), per: s.per, per100g: s.g ? scaleTo100(s.per, s.g) : null, alts: s.g ? [{ label: "100 g", g: 100 }] : [] });
    M.log.update(det.date, det.entryId, { foodId: f.id });
    el.textContent = "Saved to My foods"; el.disabled = true; UI.toast("Saved to My foods");
  };
  A.entry = el => {
    const d = M.dayOf(date()); const e = d && d.entries.find(x => x.id === el.dataset.id); if (!e) return;
    const info = M.cook ? M.cook.entryInfo(e) : null;
    if (info) {
      const csrc = { name: e.name, brand: e.brand, per: e.per, servingLabel: e.servingLabel, g: e.g, servings: e.servings, foodId: e.foodId, mealId: e.mealId, source: e.source, state: info.state, cook: info.cook };
      if (cookSetup(csrc)) { UI.openDetail(csrc, { mode: "edit", entryId: e.id, slot: e.slot, date: date(), info }); return; }
    }
    const food = e.foodId ? M.foods.get(e.foodId) : null;
    const src = { name: e.name, brand: e.brand, per: e.per, servingLabel: e.servingLabel, g: e.g, foodId: e.foodId, mealId: e.mealId, source: e.source };
    if (food) {
      src.per100g = food.per100g || (num(food.serving && food.serving.g) > 0 ? scaleTo100(food.per, food.serving.g) : null); src.alts = food.alts;   /* per for the chosen unit stays what the entry has */
      if (isObj(food.serving) && isObj(food.per)) src.moreUnits = [{ label: M.fmtServing(food.serving), g: food.serving.g, per: food.per }];   /* and the food's own serving */
    }
    else if (e.g) src.per100g = scaleTo100(e.per, e.g);
    const isG = isGramLabel(e.servingLabel);
    UI.openDetail(src, { mode: "edit", entryId: e.id, slot: e.slot, servings: isG ? 1 : e.servings, unit: isG ? "g" : "serving", grams: isG ? e.servings : null, canSaveFood: !e.foodId && !e.mealId, date: date() });
  };

  /* ------------------------------------------------------------ slot menu */
  A["slot-menu"] = el => {
    const slot = el.dataset.slot; menu = { slot };
    const y = M.addDays(date(), -1); const yn = M.log.slotEntries(y, slot).length; const n = M.log.slotEntries(date(), slot).length;
    const count = k => (k ? k + " item" + (k === 1 ? "" : "s") : "Empty");
    const copyLbl = date() === today() ? "Copy yesterday's " + slot : "Copy " + slot + " from " + M.fmtDay(y);
    UI.sheet(slot + dayTag(date()), '<button class="opt" data-m="slot-copy"' + (yn ? "" : " disabled") + '><span>' + esc(copyLbl) + '</span><span class="m">' + count(yn) + '</span></button>' +
      '<button class="opt" data-m="slot-savemeal"' + (n ? "" : " disabled") + '><span>Save ' + slot + ' as a meal</span><span class="m">' + count(n) + '</span></button>' +
      '<button class="opt m-danger" data-m="slot-clear"' + (n ? "" : " disabled") + '><span>Clear ' + slot + '</span><span class="m">' + count(n) + '</span></button>');
  };
  A["slot-copy"] = () => { const n = M.log.copySlot(M.addDays(date(), -1), date(), menu.slot).length; UI.close(); UI.toast(n ? "Copied " + n + " item" + (n === 1 ? "" : "s") + dayTag(date()) : "Nothing to copy"); UI.render(); };
  A["slot-clear"] = el => { if (!confirmTap(el, "clear")) return; const slot = menu.slot; M.log.clearSlot(date(), slot); UI.close(); UI.toast(slot + " cleared"); UI.render(); };
  A["slot-savemeal"] = () => {
    const slot = menu.slot; const list = M.log.slotEntries(date(), slot);
    UI.draft = { id: null, name: "", desc: "", slot, servingsMade: 1, batch: draftBatch(null), items: list.map(e => Object.assign({ name: e.name, brand: e.brand, servings: e.servings, servingLabel: e.servingLabel, g: e.g, per: e.per, foodId: e.foodId, mealId: e.mealId }, cookOf(e))) };
    UI.openBuilder();
  };

  /* ================================================================ ADD FLOW */
  /* add = { slot, date, onPick, q, seg:"recent"|"meals"|"foods", req, tLocal, tOff, off:[] } */
  function resultRow(r, i) {
    let per = r.per || M.foodMath.blank(), amount = esc(r.sub || "1 serving");
    /* a recent shows the amount logged last time, which is what tapping it pre-fills */
    if (r.kind === "recent" && isObj(r.ref)) {
      const rc = Object.assign({}, r.ref, { foodId: r.foodId, mealId: r.mealId, state: r.state, cook: r.cook });
      per = M.foodMath.scale(r.ref.per || r.per, servingsOf(r.ref)); amount = amountLabel(rc);
    }
    const desc = r.kind === "meal" && r.desc ? '<div class="t m-clamp">' + esc(r.desc) + "</div>" : "";
    const lines = r.batch
      ? '<div class="t">' + esc(r.sub) + '</div><div class="t">' + macroLine(per) + ' ' + esc(r.portion || "") + '</div>'
      : '<div class="t">' + (r.brand ? esc(r.brand) + " · " : "") + amount + ' · ' + macroLine(per) + '</div>';
    return '<button class="ex-row m-row" data-m="pick" data-i="' + i + '"><div class="ex-main"><div class="n">' + esc(r.name) + '</div>' + desc + lines + '</div><div class="m-kcal num">' + kcal(per.cal) + '</div></button>';
  }
  /* A saved meal as a result row; batch meals show their cooked weight and macros per 4 oz / 100 g. */
  function mealRes(m) {
    const r = { kind: "meal", id: m.id, name: m.name, brand: "", desc: m.desc, slot: m.slot, sub: "1 serving", per: m.per, serving: { qty: 1, unit: "serving", g: null }, alts: [], foodId: null, mealId: m.id, ref: m };
    if (isObj(m.batch) && num(m.batch.cookedG) > 0) {
      const U = units(), pg = M.cook.portionG(U);
      Object.assign(r, { batch: true, per: M.cook.batchPer(m, pg), sub: M.cook.batchSub(m, U), portion: "per " + M.cook.fmtWeight(pg, U === "metric" ? "g" : "oz") });
    }
    return r;
  }
  function offFood(f) { return { kind: "off", id: f.id, name: f.name, brand: f.brand || "", sub: M.fmtServing(f.serving), per: f.per, serving: f.serving, alts: f.alts, foodId: null, mealId: null, ref: f }; }
  function resultsHTML() {
    const q = add.q.trim(); let list;
    if (add.seg === "meals") {
      const meals = M.meals.list();
      const toks = lc(q).split(/\s+/).filter(Boolean);
      const hit = m => !toks.length || toks.every(t => (lc(m.name) + " " + lc(m.desc)).includes(t));
      const order = [add.slot].concat(M.SLOTS.filter(s => s !== add.slot), ["Any"]);
      let html = "", n = 0;
      add.list = [];
      order.forEach(s => {
        const g = meals.filter(m => m.slot === s && hit(m)); if (!g.length) return;
        html += '<div class="ex-div">' + s + '</div>' + g.map(m => { const r = mealRes(m); add.list.push(r); n++; return resultRow(r, add.list.length - 1); }).join("");
      });
      if (!n) html = '<div class="empty">' + (meals.length ? "No meals match." : "No saved meals yet. Log a meal, then use the … menu → Save as a meal.") + '</div>';
      return html;
    }
    const foodsOnly = add.seg === "foods";
    list = M.search(q, { pid: pid(), slot: add.slot, limit: 40, recents: !foodsOnly, meals: !foodsOnly });
    /* Recent (default): with no query → recents + meals; with a query → everything, ranked. Foods → foods + generic + OFF. */
    if (add.seg === "recent" && !q) list = list.filter(r => r.kind === "recent" || r.kind === "meal");
    else if (add.seg === "foods") list = list.filter(r => r.kind !== "meal" && r.kind !== "recent");
    add.list = list.slice();
    let html = list.map(resultRow).join("");
    /* Online (Open Food Facts) part: "Searching online…" until it answers, then its rows or a plain
       error line. The add-new button sits right under your own results, so it never jumps when
       the online rows arrive below it. */
    const online = add.seg !== "meals" && q.length >= 3;
    const searching = online && (add.offQ !== q || add.offState === "loading");
    let offHTML = "";
    if (online && !searching) {
      const seen = new Set(list.map(r => lc(r.name) + "|" + lc(r.brand)));
      const off = add.offQ === q ? (add.off || []).filter(f => !seen.has(lc(f.name) + "|" + lc(f.brand))) : [];
      if (off.length) offHTML = '<div class="ex-div">From Open Food Facts</div>' + off.map(f => { const r = offFood(f); add.list.push(r); return resultRow(r, add.list.length - 1); }).join("");
      else if (add.offState === "error") offHTML = '<div class="m-offstate mut small" role="status">' + esc(add.offErr || "Open Food Facts didn't answer. Try again in a minute.") + '</div>';
    } else if (searching) offHTML = '<div class="m-offstate mut small" role="status">Searching online…</div>';
    const addNew = q ? '<button class="m-addnew" data-m="open-form" data-name="' + esc(q) + '"><b>+ Not here?</b> Add <span class="m-keepcase">“' + esc(q) + '”</span> as a new food</button>' : "";
    if (!add.list.length) {
      if (q && searching) return addNew + offHTML;
      return '<div class="empty">' + (q ? "Not in the app yet. Add it once and it's saved for next time." : add.seg === "recent" ? "Nothing logged yet. Search above or try Foods." : "Search for a food, or scan a label.") + '</div>' +
        (q ? '<button class="btn primary block m-keepcase" data-m="open-form" data-name="' + esc(q) + '">+ Add “' + esc(q) + '” as a new food</button>' +
          '<div class="m-btnrow"><button class="btn" data-m="open-scan">Scan barcode</button><button class="btn" data-m="open-label">Scan the label</button>' + (M.ai && M.ai.ready() ? '<button class="btn" data-m="ai-name" data-q="' + esc(q) + '">Ask Claude</button>' : '<button class="btn" data-m="open-describe" data-q="' + esc(q) + '">Describe it</button>') + '</div>' : "") + offHTML;
    }
    return html + (add.seg !== "meals" ? addNew : "") + offHTML;
  }
  /* Repaint only when something changed (typing fast re-runs this a lot). */
  function paintResults() {
    const box = $("m-results"); if (!box || !add) return;
    const html = resultsHTML();
    if (html === add.painted && box.innerHTML) return;
    box.innerHTML = html; add.painted = html;
  }
  const TOOLS = [["open-scan", "▥", "Scan barcode"], ["open-label", "▤", "Scan label"], ["open-form", "＋", "New food"], ["quick", "⚡", "Quick add"], ["open-photo", "◉", "Photo"], ["open-describe", "✎", "Describe"], ["suggest", "✦", "Suggest"]];
  function addHTML() {
    const typing = !!add.q;
    return '<div class="m-add' + (typing ? " m-typing" : "") + '"><div class="m-pills" role="group" aria-label="Meal">' + M.SLOTS.map(s => '<button class="chip' + (s === add.slot ? " on" : "") + '" data-m="add-slot" data-v="' + s + '" aria-pressed="' + (s === add.slot) + '">' + s + '</button>').join("") + '</div>' +
      '<div class="m-searchbox"><input class="m-search" id="m-search" type="search" data-m="search" placeholder="Search foods, meals, brands" aria-label="Search foods" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" value="' + esc(add.q) + '"><button class="m-clear" data-m="search-clear" aria-label="Clear search"' + (add.q ? "" : " hidden") + '>×</button></div>' +
      '<div class="m-tools">' + TOOLS.filter(x => !(x[0] === "quick" && add.onPick)).map(x => '<button data-m="' + x[0] + '"><span aria-hidden="true">' + x[1] + '</span>' + x[2] + '</button>').join("") + '</div>' +
      '<div class="seg scope m-seg" role="group" aria-label="Show">' + [["recent", "Recent"], ["meals", "Meals"], ["foods", "Foods"]].map(s => '<button data-m="add-seg" data-v="' + s[0] + '" aria-pressed="' + (add.seg === s[0]) + '"' + (add.seg === s[0] ? ' class="on"' : "") + '>' + s[1] + '</button>').join("") + '</div>' +
      '<div class="ex-list m-results" id="m-results" aria-live="polite"></div></div>';
  }
  /* The search box is not focused on open (the keyboard would cover the list); tap it to type. */
  UI.openAdd = function (opt) {
    opt = isObj(opt) ? opt : {};
    add = { slot: slotOr(opt.slot), date: opt.date || date(), onPick: typeof opt.onPick === "function" ? opt.onPick : null, q: opt.q || "", seg: opt.seg || "recent", req: 0, off: [], offQ: null, offState: null, list: [] };
    if (add.q) add.seg = "foods";
    UI.sheet(addTitle(), addHTML());
    paintResults();
    if (!add.q) { const inp = $("m-search"); if (inp && opt.focus === true) { try { inp.focus(); } catch (e) {} } }
    else scheduleOFF(add.q);
  };
  A.add = el => { UI.openAdd({ slot: el.dataset.slot || M.defaultSlot(), date: date() }); };
  A["add-slot"] = el => { if (!add) return; add.slot = el.dataset.v; qsa('[data-m="add-slot"]').forEach(b => { b.classList.toggle("on", b.dataset.v === add.slot); b.setAttribute("aria-pressed", b.dataset.v === add.slot ? "true" : "false"); }); if (add.seg === "meals") paintResults(); };
  A["add-seg"] = el => { if (!add) return; add.seg = el.dataset.v; qsa('[data-m="add-seg"]').forEach(b => { b.classList.toggle("on", b.dataset.v === add.seg); b.setAttribute("aria-pressed", b.dataset.v === add.seg ? "true" : "false"); }); paintResults(); scheduleOFF(add.q); };
  A["search-clear"] = () => {
    if (!add) return;
    const inp = $("m-search"); if (inp) inp.value = "";
    add.q = ""; clearTimeout(add.tOff); clearTimeout(add.tLocal);
    const x = qs('[data-m="search-clear"]'); if (x) x.hidden = true;
    paintResults();
    if (inp) { try { inp.focus(); } catch (e) {} }
    searchMode();
  };
  function scheduleOFF(q) {
    if (!add) return; q = String(q || "").trim();
    clearTimeout(add.tOff);
    if (q.length < 3 || add.seg === "meals") return;
    if (add.offQ === q && add.offState !== "error") return;
    add.tOff = setTimeout(() => {
      if (!add) return;
      const my = ++add.req; add.offQ = q; add.offState = "loading"; add.off = [];
      paintResults();
      if (!(M.food && M.food.searchOFF)) { add.offState = "error"; add.offErr = "Open Food Facts search isn't available."; paintResults(); return; }
      M.food.searchOFF(q).then(list => { if (!add || add.req !== my) return; add.off = list || []; add.offState = "done"; paintResults(); },
        e => { if (!add || add.req !== my) return; add.offState = "error"; add.offErr = errMsg(e); paintResults(); });
    }, 500);
  }
  I.search = el => {
    if (!add) return;
    add.q = el.value;
    const x = qs('[data-m="search-clear"]'); if (x) x.hidden = !add.q;
    searchMode(true);
    clearTimeout(add.tLocal);
    add.tLocal = setTimeout(() => { if (!add) return; paintResults(); }, 150);
    scheduleOFF(add.q);
  };
  /* A recent logs again with today's numbers from the live food or meal, in the same unit and
     amount as last time. false when the food / meal is gone (the snapshot is used then). */
  function recentPick(r, ctx) {
    const rc = isObj(r.ref) ? r.ref : {};
    const sv = num(rc.servings, 1) > 0 ? num(rc.servings, 1) : 1;
    const meal = r.mealId ? M.meals.get(r.mealId) : null;
    if (meal && !isObj(meal.batch)) { UI.openDetail(mealRes(meal), Object.assign({ servings: sv }, ctx)); return true; }
    const food = r.foodId ? M.foods.get(r.foodId) : null;
    if (!food || !isObj(food.per) || (M.cook && M.cook.of(food))) return false;
    const src = { kind: food.source === "generic" || String(food.id).indexOf("g_") === 0 ? "generic" : "food", id: food.id, name: food.name, brand: food.brand || "", sub: M.fmtServing(food.serving), per: food.per, serving: food.serving, alts: food.alts, per100g: food.per100g || null, source: food.source, foodId: food.id, ref: food };
    const label = String(rc.servingLabel || "");
    if (isGramLabel(label)) { UI.openDetail(src, Object.assign({ unit: "g", grams: sv, servings: 1 }, ctx)); return true; }
    if (label && !unitOptions(src).some(o => lc(o.label) === lc(label))) {
      /* last time's unit isn't one of the food's units any more: keep it, priced from the food's numbers */
      const gEach = num(rc.g) > 0 ? num(rc.g) : num(M.parseServing(label).g);
      const p100 = isObj(food.per100g) ? food.per100g : (num(food.serving && food.serving.g) > 0 ? scaleTo100(food.per, food.serving.g) : null);
      src.moreUnits = [{ label, g: gEach > 0 ? gEach : null, per: gEach > 0 && p100 ? perOfGrams(p100, gEach) : (rc.per || food.per) }];
    }
    UI.openDetail(src, Object.assign({ unitLabel: label, servings: sv }, ctx));
    return true;
  }
  A.pick = el => {
    if (!add) return;
    const r = add.list[num(el.dataset.i, -1)]; if (!r) return;
    const ctx = { slot: add.slot, date: add.date, mode: add.onPick ? "pick" : "log", onPick: add.onPick, back: true };
    if (r.kind === "meal") { UI.openDetail(r.ref && isObj(r.ref.batch) ? batchSrc(r.ref) : r, ctx); return; }
    if (r.kind === "recent" && !(r.state === "raw" || r.state === "cooked") && recentPick(r, ctx)) return;
    /* a recent of a cook food or a batch portion reopens with the same unit and amount (live numbers) */
    if (r.kind === "recent" && isObj(r.ref) && M.cook) {
      const rc = Object.assign({}, r.ref, { foodId: r.foodId, mealId: r.mealId, state: r.state, cook: r.cook });
      const info = M.cook.entryInfo(rc), meal = r.mealId ? M.meals.get(r.mealId) : null;
      if (info && meal && isObj(meal.batch)) { UI.openDetail(batchSrc(meal), Object.assign({ grams: info.state === "cooked" ? info.grams : null, unitKey: info.fam ? info.fam + "-cooked" : null }, ctx)); return; }
      const csrc = info ? { kind: "recent", name: r.name, brand: r.brand, per: rc.per, servingLabel: rc.servingLabel, g: rc.g, servings: rc.servings, foodId: r.foodId, mealId: r.mealId, state: info.state, cook: info.cook || r.cook } : null;
      if (csrc && cookSetup(csrc)) { UI.openDetail(csrc, Object.assign({ info }, ctx)); return; }
    }
    const src = Object.assign({}, r);
    /* the food or meal is gone: the recent's own numbers (per one of its label) */
    if (r.kind === "recent") { if (r.serving && r.serving.g) src.per100g = scaleTo100(r.per, r.serving.g); src.servings = r.ref && r.ref.servings; }
    else { const f = r.ref || {}; src.per100g = f.per100g || null; src.source = f.source; }
    if (r.kind === "recent" && isGramLabel(r.sub)) { UI.openDetail(src, Object.assign({}, ctx, { unit: "g", grams: src.servings || 100, servings: 1 })); return; }
    UI.openDetail(src, Object.assign({}, ctx, { servings: src.servings || 1 }));
  };
  /* Quick add: just the calories (protein, carbs and fat if you know them). One diary entry,
     not saved as a food. */
  let quick = null;
  A.quick = () => {
    quick = { slot: add ? add.slot : M.defaultSlot(), date: add ? add.date : date() };
    const box = (k, label, unit, ph) => '<label class="m-f"><span>' + label + (unit ? ' <em>' + unit + '</em>' : "") + '</span><input type="number" inputmode="decimal" min="0" step="any" data-m="qa" data-k="' + k + '" placeholder="' + ph + '"></label>';
    UI.sheet("Quick add" + dayTag(quick.date), '<div class="m-form m-quick">' +
      box("cal", "Calories", "", "e.g. 350") +
      '<div class="m-f3">' + box("p", "Protein", "g", "optional") + box("c", "Carbs", "g", "optional") + box("f", "Fat", "g", "optional") + '</div>' +
      '<label class="m-f"><span>Name <em>optional</em></span><input type="text" data-m="qa" data-k="name" maxlength="120" placeholder="e.g. Birthday cake" autocomplete="off"></label>' +
      '<div><span class="lbl">Meal</span><select class="sel" data-m="qa-slot" aria-label="Meal">' + M.SLOTS.map(x => '<option' + (x === quick.slot ? " selected" : "") + '>' + x + '</option>').join("") + '</select></div>' +
      '<div class="m-warnline" id="m-qa-msg" role="status"></div>' +
      '<button class="btn primary block" id="m-qa-go" data-m="qa-go">Add to ' + quick.slot + '</button></div>');
  };
  C["qa-slot"] = el => { if (!quick) return; quick.slot = el.value; const b = $("m-qa-go"); if (b) b.textContent = "Add to " + quick.slot; };
  A["qa-go"] = () => {
    if (!quick) return;
    const val = k => { const el = qs('[data-m="qa"][data-k="' + k + '"]'); return el ? String(el.value || "").trim() : ""; };
    const n = k => (val(k) === "" ? null : num(val(k), NaN));
    const cal0 = n("cal"), p = n("p"), c = n("c"), f = n("f"), msg = $("m-qa-msg");
    const bad = [cal0, p, c, f].some(v => v !== null && !(v >= 0));
    const cal = cal0 != null ? cal0 : (p || c || f ? r0(4 * (p || 0) + 4 * (c || 0) + 9 * (f || 0)) : null);
    if (bad || !(cal > 0) || cal > 10000) { if (msg) msg.textContent = bad ? "Numbers can't be below zero." : cal > 10000 ? "That's more than 10,000 calories. Check the number." : "Enter the calories."; return; }
    const slot = quick.slot, dt = quick.date;
    M.log.add(dt, { slot, name: val("name").slice(0, 120) || "Quick add", brand: "", servings: 1, servingLabel: "1 serving", g: null, per: { cal: r0(cal), p: r1(p || 0), c: r1(c || 0), f: r1(f || 0), fiber: 0, sugar: 0, sodium: 0 }, source: "quick" });
    UI.close(); UI.toast("Added to " + slot + dayTag(dt));
    UI.render();
  };
  A["ai-name"] = el => {
    const q = el.dataset.q || (add && add.q) || ""; if (!q) return;
    if (!(M.ai && M.ai.ready())) { UI.toast("Claude isn't set up. Add your key in You → AI."); return; }
    el.disabled = true; el.textContent = "Asking Claude…";
    const slot = add ? add.slot : M.defaultSlot(), dt = add ? add.date : date(), onPick = add ? add.onPick : null;
    M.food.estimateByName(q).then(f => {
      if (!f) { UI.toast("Claude didn't recognise that as food."); el.disabled = false; el.textContent = "Ask Claude"; return; }
      const saved = M.foods.add(f);
      UI.openDetail(Object.assign({ kind: "food", foodId: saved.id, sub: M.fmtServing(saved.serving), ref: saved }, saved), { slot, date: dt, onPick, mode: onPick ? "pick" : "log" });
    }, e => { UI.toast(errMsg(e)); el.disabled = false; el.textContent = "Ask Claude"; });
  };

  /* --------------------------------------------------------------- barcode */
  function scanCtx() { return { slot: add ? add.slot : M.defaultSlot(), date: add ? add.date : date(), onPick: add ? add.onPick : null }; }
  /* After UI.close() (which clears `add`), keep the Log food / Add item context alive so the
     next sheet's × still knows where to go back to (the meal builder when picking). */
  function keepCtx(ctx) { add = add || Object.assign({ q: "", seg: "recent", req: 0, off: [], list: [] }, ctx); return add; }
  A["open-scan"] = () => {
    const ctx = scanCtx(); keepCtx(ctx);
    UI.sheet("Scan barcode", '<div id="m-scan" class="m-scan"></div><div class="m-status mut small" id="m-scan-status" role="status">Starting camera…</div>' +
      '<div class="m-coderow"><input class="m-search" type="text" inputmode="numeric" pattern="[0-9]*" placeholder="Type the barcode numbers" aria-label="Barcode numbers" enterkeyhint="search" data-m="code-in" id="m-code"><button class="btn" data-m="code-lookup">Look up</button></div>' +
      '<label class="btn block m-file"><input type="file" accept="image/*" capture="environment" data-m="code-photo">Photo of barcode</label>' +
      '<button class="btn ghost block" data-m="close" style="margin-top:8px">Cancel</button>');
    const el = $("m-scan"), st = $("m-scan-status");
    let busy = false, done = false;
    /* camera up but the barcode reader still downloading: say so (engine() stays null until it loads) */
    const poll = setInterval(() => {
      if (done || !UI.sheetOpen() || $("m-scan") !== el) { clearInterval(poll); return; }
      try {
        const v = el && el.querySelector("video"), eng = M.food.scanner.engine ? M.food.scanner.engine() : "x";
        if (v && v.srcObject && !eng && st && /^Starting camera/.test(st.textContent)) st.textContent = "Loading the scanner…";
      } catch (e) {}
    }, 400);
    M.food.scanner.start(el, code => { if (busy) return; busy = true; if (st) st.textContent = "Found " + code + ". Looking it up…"; lookupCode(code, ctx).then(() => { busy = false; }); })
      .then(() => { done = true; if (st) st.textContent = "Point the camera at the barcode"; },
        e => { done = true; if (st) st.textContent = errMsg(e); if (el) el.classList.add("off"); });
  };
  function lookupCode(code, ctx) {
    const st = $("m-scan-status");
    const find = M.food.lookup ? M.food.lookup(code) : M.food.barcode(code).then(f => (f ? { status: "found", food: f } : { status: "not_found" }));
    return find.then(r => {
      if (r.status === "no_nutrition") { noNutrition(code, r.product || {}, ctx); return true; }
      if (r.status !== "found" || !r.food) { notFound(code, ctx); return true; }
      const f = r.food;
      let saved = f;
      if (!M.MS.foods[f.id]) { const have = M.foods.findByBarcode(f.barcode || code); saved = have || M.foods.add(f); }
      UI.close(); keepCtx(ctx);
      UI.openDetail(Object.assign({ kind: "food", foodId: saved.id, sub: M.fmtServing(saved.serving), ref: saved }, saved), { slot: ctx.slot, date: ctx.date, onPick: ctx.onPick, mode: ctx.onPick ? "pick" : "log" });
      return true;
    }, e => { if (st) st.textContent = errMsg(e); else UI.toast(errMsg(e)); return false; });
  }
  /* Open Food Facts knows the product but has no numbers: go straight to the label photo, name kept. */
  function noNutrition(code, product, ctx) {
    UI.close();
    keepCtx(ctx);
    A["open-label"]({ dataset: { code: String(code) } });
    if (ff) { ff.food.name = product.name || ""; ff.food.brand = product.brand || ""; }
    const st = $("m-label-status");
    if (st) st.textContent = (product.name ? product.name + ": " : "") + "Open Food Facts has no nutrition numbers for this. Take a photo of the label.";
  }
  function notFound(code, ctx) {
    UI.close();
    keepCtx(ctx);
    UI.sheet("Not found", '<div class="card m-inner"><div class="bd"><p class="hint" style="font-size:15px">Barcode <b class="num">' + esc(code) + '</b> isn\'t in Open Food Facts yet. Scan the Nutrition Facts label instead, or type it in.</p>' +
      '<div class="m-btnrow"><button class="btn primary" data-m="open-label" data-code="' + esc(code) + '">Scan label</button><button class="btn" data-m="open-form" data-code="' + esc(code) + '">Type it in</button></div></div></div>');
  }
  A["code-lookup"] = () => { const inp = $("m-code"); const code = inp ? inp.value.replace(/\D/g, "") : ""; if (!code) { UI.toast("Type the numbers under the bars"); return; } const st = $("m-scan-status"); if (st) st.textContent = "Looking up " + code + "…"; lookupCode(code, scanCtx()); };
  C["code-photo"] = el => {
    const file = el.files && el.files[0]; if (!file) return;
    const st = $("m-scan-status"); if (st) st.textContent = "Reading the photo…";
    M.food.scanner.fromImage(file).then(code => { if (!code) { if (st) st.textContent = "No barcode found in that photo. Try closer, or type the numbers."; return; } if (st) st.textContent = "Found " + code + ". Looking it up…"; lookupCode(code, scanCtx()); }, e => { if (st) st.textContent = errMsg(e); });
  };

  /* --------------------------------------------------------------- food form (label + my foods) */
  /* ff = { food, id (editing existing), slot, date, onPick, method, code } */
  const FIELDS = [["cal", "Calories", ""], ["p", "Protein", "g"], ["c", "Carbs", "g"], ["f", "Fat", "g"], ["fiber", "Fiber", "g"], ["sugar", "Sugar", "g"], ["sodium", "Sodium", "mg"]];
  /* Grams that can't be right for the unit ("1 tortilla = 459 g", "4 oz = 45 g"). → message | "" */
  const COUNT_UNIT = /^(tortillas?|slices?|pieces?|pcs?|eggs?|bars?|cookies?|crackers?|links?|patt(?:y|ies)|scoops?|wraps?|buns?|bagels?|muffins?|rolls?|biscuits?|pancakes?|waffles?|nuggets?|strips?|sticks?|cakes?|chips?|pretzels?|sausages?|fillets?|pouch(?:es)?|packets?|cans?|bottles?|containers?|cups? of yogurt|small|medium|large)\b/i;
  function gramsWarning(s) {
    s = isObj(s) ? s : {};
    const q = num(s.qty, 1) > 0 ? num(s.qty, 1) : 1, g = num(s.g), unit = String(s.unit || "").trim();
    if (!(g > 0) || !unit) return "";
    const each = g / q, u = M.cook ? M.cook.unitWord(unit) : null, w = u && M.cook.UNIT_G[u];
    let off = false;
    if (w) { const want = q * w; off = Math.abs(g - want) > Math.max(2, want * 0.25); }
    else if (u === "cup") off = each < 15 || each > 450;
    else if (u === "tbsp") off = each < 3 || each > 40;
    else if (u === "tsp") off = each < 1 || each > 15;
    else if (/^(ml|milliliters?)$/i.test(unit)) off = each < 0.4 || each > 2;
    else if (COUNT_UNIT.test(unit)) off = each > 250 || each < 1;
    return off ? "Check the grams: " + fmtQty(q) + " " + unit + " = " + fmtQty(g) + " g?" : "";
  }
  /* Meat, fish, rice and pasta weigh differently cooked: ask them. Others can open the question. */
  const COOK_NAME = /\b(chicken|beef|steak|pork|turkey|lamb|bison|venison|veal|ham|bacon|sausages?|brisket|ribs?|tenderloin|sirloin|ribeye|loin|chops?|thighs?|breasts?|wings?|drumsticks?|ground|mince|meat|fish|salmon|tuna|cod|tilapia|halibut|trout|shrimp|prawns?|scallops?|mahi|rice|pasta|spaghetti|noodles?|macaroni|penne|linguine|fettuccine|rigatoni|orzo|quinoa|couscous|lentils?|barley|farro)\b/i;
  const addBtns = () => '<button class="btn primary block" data-m="ff-save-add">' + (ff.onPick ? "Save &amp; add to meal" : "Save &amp; add to " + esc(ff.slot)) + '</button><button class="btn block" data-m="ff-save">Save to My foods</button>';
  function formHTML(opt) {
    const f = ff.food, s = f.serving || { qty: 1, unit: "serving", g: null }, per = f.per || {};
    const v = (x, d) => (x == null || x === "" ? (d == null ? "" : d) : x);
    const gw = gramsWarning(s);
    return '<div class="m-form">' + (opt.badge || "") +
      '<label class="m-f"><span>Name</span><input type="text" data-m="ff" data-k="name" value="' + esc(v(f.name)) + '" placeholder="e.g. Greek yogurt" autocomplete="off"></label>' +
      '<label class="m-f"><span>Brand</span><input type="text" data-m="ff" data-k="brand" value="' + esc(v(f.brand)) + '" placeholder="optional" autocomplete="off"></label>' +
      '<div class="m-f3"><label class="m-f"><span>Serving</span><input type="number" inputmode="decimal" step="any" min="0" data-m="ff" data-k="qty" value="' + esc(v(s.qty, 1)) + '" aria-label="Serving amount"></label><label class="m-f"><span>Unit</span><input type="text" data-m="ff" data-k="unit" value="' + esc(v(s.unit, "serving")) + '" placeholder="e.g. cup" aria-label="Serving unit" autocomplete="off"></label><label class="m-f"><span>Grams</span><input type="number" inputmode="decimal" step="any" min="0" data-m="ff" data-k="g" value="' + esc(v(s.g)) + '" placeholder="optional" aria-label="Grams in one serving"></label></div>' +
      '<p class="hint m-warnline" id="m-ff-gwarn" role="status"' + (gw ? "" : " hidden") + '>' + esc(gw) + '</p>' +
      '<div class="m-fgrid">' + FIELDS.map(x => '<label class="m-f"><span>' + x[1] + (x[2] ? ' <em>' + x[2] + '</em>' : "") + '</span><input type="number" inputmode="decimal" step="any" min="0" data-m="ff" data-k="' + x[0] + '" value="' + esc(v(per[x[0]], "")) + '" aria-label="' + x[1] + (x[2] ? " in " + (x[2] === "g" ? "grams" : "milligrams") : "") + '"></label>').join("") + '</div>' +
      cookFormHTML() +
      '<label class="m-f"><span>Barcode</span><input type="text" inputmode="numeric" data-m="ff" data-k="barcode" value="' + esc(v(f.barcode)) + '" placeholder="optional" autocomplete="off"></label>' +
      '<p class="hint m-warnline" id="m-ff-msg" role="status" hidden></p>' +
      '<div class="m-btnrow m-col">' + (opt.buttons || "") + '</div></div>';
  }
  I.ff = el => {
    if (!ff) return;
    const k = el.dataset.k, val = el.value;
    const f = ff.food; f.serving = f.serving || { qty: 1, unit: "serving", g: null }; f.per = f.per || {};
    const raw = String(val).trim() === "" ? null : num(val, NaN);
    if (k === "name" || k === "brand" || k === "barcode") f[k] = val;
    else if (k === "unit") f.serving.unit = val;
    else if (k === "qty") f.serving.qty = raw;
    else if (k === "g") f.serving.g = raw;
    else if (k === "cook") ff.cookVal = val;
    else f.per[k] = raw == null ? 0 : raw;
    if (k === "qty" || k === "unit" || k === "g") { const w = $("m-ff-gwarn"), m = gramsWarning(f.serving); if (w) { w.textContent = m; w.hidden = !m; } }
    if (k === "name" && COOK_NAME.test(val)) showCookQ();
  };
  /* "Does the weight change when cooked?" — meat / fish: cooked weight as a % of raw; rice / pasta:
     times the dry weight. Saved as food.cook = {y, word}; the label's one profile is raw, cooked = raw ÷ y. */
  const COOK_DEF = { meat: 75, grain: 2.8 };
  function cookRowHTML(k) {
    const val = esc(ff.cookVal == null ? "" : String(ff.cookVal));
    return k === "grain"
      ? '<span>Cooked weight is about</span><input type="number" inputmode="decimal" step="any" min="1" max="6" data-m="ff" data-k="cook" value="' + val + '" placeholder="e.g. 2.8" aria-label="Cooked weight, times the dry weight"><span>times the dry weight</span>'
      : '<span>Cooked weight is about</span><input type="number" inputmode="decimal" step="any" min="10" max="100" data-m="ff" data-k="cook" value="' + val + '" placeholder="e.g. 75" aria-label="Cooked weight, percent of raw"><span>% of raw</span>';
  }
  function cookFormHTML() {
    const k = ff.cookKind === "meat" || ff.cookKind === "grain" ? ff.cookKind : "none";
    const show = k !== "none" || !!ff.cookOpen || COOK_NAME.test(String(ff.food && ff.food.name || ""));
    return '<div class="m-f m-cookf" id="m-ff-cook"' + (show ? "" : " hidden") + '><span id="m-ff-cookq">Does the weight change when cooked?</span><div class="seg scope m-cookseg" role="group" aria-labelledby="m-ff-cookq">' +
      [["none", "No", ""], ["meat", "Meat or fish", "shrinks"], ["grain", "Rice or pasta", "grows"]].map(x => '<button data-m="ff-cook" data-v="' + x[0] + '" aria-pressed="' + (k === x[0] ? "true" : "false") + '"' + (k === x[0] ? ' class="on"' : "") + '>' + x[1] + (x[2] ? '<small>' + x[2] + '</small>' : "") + '</button>').join("") + '</div>' +
      '<div class="m-cookrow" id="m-ff-cookrow"' + (k === "none" ? " hidden" : "") + '>' + (k === "none" ? "" : cookRowHTML(k)) + '</div></div>' +
      '<button class="btn ghost block m-cookopen" data-m="ff-cookopen" id="m-ff-cookopen"' + (show ? " hidden" : "") + '>Does the weight change when cooked?</button>';
  }
  function showCookQ() {
    if (!ff) return;
    ff.cookOpen = true;
    const box = $("m-ff-cook"), b = $("m-ff-cookopen");
    if (box) box.hidden = false; if (b) b.hidden = true;
  }
  A["ff-cookopen"] = () => showCookQ();
  A["ff-cook"] = el => {
    if (!ff) return;
    const k = el.dataset.v === "meat" || el.dataset.v === "grain" ? el.dataset.v : "none";
    if (k !== ff.cookKind) ff.cookVal = k === "none" ? "" : String(COOK_DEF[k]);   /* the usual number, shown so they can change it */
    ff.cookKind = k;
    qsa('[data-m="ff-cook"]').forEach(b => { b.classList.toggle("on", b.dataset.v === k); b.setAttribute("aria-pressed", b.dataset.v === k ? "true" : "false"); });
    const row = $("m-ff-cookrow"); if (row) { row.hidden = k === "none"; row.innerHTML = k === "none" ? "" : cookRowHTML(k); }
  };
  /* the typed value (blank = the usual number) or NaN when out of range */
  function formCookValue() {
    const k = ff && ff.cookKind; if (k !== "meat" && k !== "grain") return null;
    const v = String(ff.cookVal == null ? "" : ff.cookVal).trim() === "" ? COOK_DEF[k] : num(ff.cookVal, NaN);
    return (k === "meat" ? v >= 10 && v <= 100 : v >= 1 && v <= 6) ? v : NaN;
  }
  const sameNums = (a, b) => NUT.every(k => Math.abs(num(a && a[k]) - num(b && b[k])) < 1e-6);
  const cookUnchanged = () => !!ff && (ff.cookKind || "none") === (ff.cookKind0 || "none") && String(ff.cookVal == null ? "" : ff.cookVal) === String(ff.cookVal0 == null ? "" : ff.cookVal0);
  function formFood() {
    const f = ff.food; const s = f.serving || {};
    const per = {}; NUT.forEach(k => { per[k] = num(f.per && f.per[k]); });
    let g = num(s.g) > 0 ? num(s.g) : null;
    const u = M.cook ? M.cook.unitWord(s.unit) : null;
    if (!g && u && M.cook.UNIT_G[u]) g = r1((num(s.qty, 1) > 0 ? num(s.qty, 1) : 1) * M.cook.UNIT_G[u]);   /* "4 oz" knows its grams */
    const cv = formCookValue();
    let cook = cv > 0 ? (ff.cookKind === "grain" ? { y: r4(cv), word: "dry" } : { y: r4(cv / 100), word: "raw" }) : null;
    const out = { name: String(f.name || "").trim(), brand: String(f.brand || "").trim(), barcode: String(f.barcode || "").replace(/\D/g, ""), source: f.source || "custom", serving: { qty: num(s.qty, 1) > 0 ? num(s.qty, 1) : 1, unit: String(s.unit || "serving").trim() || "serving", g }, per, per100g: g ? scaleTo100(per, g) : null, alts: g ? [{ label: "100 g", g: 100 }] : [], cook };
    /* editing: keep the food's other portions ("1 oz", the package) and, while the grams and
       numbers are unchanged, its exact per-100 g numbers and cooked details */
    const o = ff.orig;
    if (o) {
      const alts = (Array.isArray(o.alts) ? o.alts : []).filter(a => isObj(a) && a.label && num(a.g) > 0).map(a => ({ label: a.label, g: num(a.g) }));
      if (g && !alts.some(a => lc(a.label) === "100 g")) alts.unshift({ label: "100 g", g: 100 });
      if (alts.length) out.alts = alts;
      if (isObj(o.per100g) && sameNums(o.per, per) && num(o.serving && o.serving.g) === num(g)) out.per100g = M.cp(o.per100g);
      if (cook && isObj(o.cook) && cookUnchanged()) out.cook = M.cp(o.cook);
    }
    return out;
  }
  /* true when the form differs from the saved food (always true for a new one) */
  function formChanged() {
    const o = ff && ff.orig; if (!o) return true;
    const n = formFood(), os = o.serving || {};
    if (n.name !== String(o.name || "") || n.brand !== String(o.brand || "") || n.barcode !== String(o.barcode || "").replace(/\D/g, "")) return true;
    if (n.serving.qty !== (num(os.qty, 1) || 1) || lc(n.serving.unit) !== lc(os.unit || "serving") || num(n.serving.g) !== num(os.g)) return true;
    if (!sameNums(n.per, o.per)) return true;
    return !cookUnchanged();
  }
  /* Show a form problem under the fields (toasts can hide behind the keyboard), focus that box. */
  function formMsg(msg, key) {
    const box = $("m-ff-msg"); if (box) { box.textContent = msg || ""; box.hidden = !msg; }
    if (key) { const inp = qs('[data-m="ff"][data-k="' + key + '"]'); if (inp) { try { inp.focus(); } catch (e) {} } }
    return null;
  }
  /* Validate, then add or update the food. el = the tapped button (second-tap confirmations). */
  function saveForm(el) {
    formMsg("");
    const f = formFood(), raw = ff.food, s = raw.serving || {};
    if (!f.name) return formMsg("Give it a name.", "name");
    const neg = ["qty", "g"].find(k => num(s[k]) < 0 || Number.isNaN(s[k])) || NUT.find(k => num(raw.per && raw.per[k]) < 0 || Number.isNaN(raw.per && raw.per[k]));
    if (neg) return formMsg("Numbers can't be below 0.", neg);
    if (s.qty != null && !(num(s.qty) > 0)) return formMsg("The serving must be more than 0.", "qty");
    if (ff.cookKind === "meat" || ff.cookKind === "grain") {
      if (!(formCookValue() > 0)) return formMsg(ff.cookKind === "meat" ? "Cooked weight should be 10 to 100% of raw." : "Cooked weight should be 1 to 6 times the dry weight.", "cook");
      if (!f.serving.g) return formMsg("Add the grams in one serving so the cooked weight works.", "g");
    }
    /* numbers they typed or changed: calories needed, and they should roughly match 4P + 4C + 9F
       (fiber may count as 0); an edit that leaves the numbers alone is never questioned */
    const P = f.per, hi = 4 * P.p + 4 * P.c + 9 * P.f, lo = 4 * P.p + 4 * Math.max(0, P.c - P.fiber) + 9 * P.f;
    const asIs = !!(ff.orig && sameNums(ff.orig.per, P));
    if (asIs) { /* unchanged */ }
    else if (!(P.cal > 0)) { if (!confirmTap(el, hi > 0 ? "save anyway" : "save with 0 calories")) return formMsg("Type the calories from the label.", "cal"); }
    else if (hi > 0 && (P.cal > hi * 1.2 || P.cal < lo * 0.8) && Math.abs(P.cal - (P.cal > hi ? hi : lo)) > 20) {
      if (!confirmTap(el, "save anyway")) return formMsg("Calories don't match protein, carbs and fat (about " + r0(hi) + "). Check the numbers.", null);
    }
    if (ff.id && M.MS.foods[ff.id]) { const before = M.cp(M.MS.foods[ff.id]); const nf = M.foods.update(ff.id, f); ff.mealsUpdated = syncMeals(before, nf); return nf; }
    return M.foods.add(f);
  }
  /* A food's numbers or name changed: saved meals that use it follow (logged days never change). → meals updated */
  function syncMeals(old, f) {
    if (!old || !f) return 0;
    const numsChanged = !sameNums(old.per, f.per) || num(old.serving && old.serving.g) !== num(f.serving && f.serving.g);
    const nameChanged = old.name !== f.name || String(old.brand || "") !== String(f.brand || "");
    if (!numsChanged && !nameChanged) return 0;
    const oldLabel = lc(M.fmtServing(old.serving)), newLabel = lc(M.fmtServing(f.serving));
    const itemPer = it => {
      const g1 = M.cook ? M.cook.unitGrams(it) : num(it.g);
      const p100 = M.cook && M.cook.of(f) ? M.cook.per100(f, it.state === "cooked" ? "cooked" : "raw") : isObj(f.per100g) ? f.per100g : null;
      if (g1 > 0 && p100) return M.foodMath.fromPer100(p100, g1);
      const l = lc(tidyLabel(it.servingLabel));
      if (l === oldLabel || l === newLabel) return M.cp(f.per);
      const o = {}; NUT.forEach(k => { const a = num(old.per && old.per[k]), b = num(f.per && f.per[k]), v = num(it.per && it.per[k]); o[k] = a > 0 ? r1(v * b / a) : v; });
      return o;
    };
    let n = 0;
    M.meals.list().forEach(m => {
      let hit = false;
      const list = (m.items || []).map(it => {
        if (!isObj(it) || it.foodId !== f.id) return it;
        hit = true;
        const o = Object.assign({}, it);
        if (nameChanged && o.name === old.name) { o.name = f.name; o.brand = f.brand || ""; }
        if (numsChanged) o.per = itemPer(o);
        return o;
      });
      if (hit) { M.meals.update(m.id, { items: list }); n++; }
    });
    return n;
  }
  A["open-form"] = el => {
    const ctx = scanCtx();
    const typed = el && el.dataset && el.dataset.name ? String(el.dataset.name).trim() : "";
    const nice = typed ? typed.charAt(0).toUpperCase() + typed.slice(1) : "";
    ff = { food: { name: nice, brand: "", barcode: (el && el.dataset && el.dataset.code) || "", serving: { qty: 1, unit: "serving", g: null }, per: {}, source: "custom" }, id: null, slot: ctx.slot, date: ctx.date, onPick: ctx.onPick };
    UI.sheet("New food", formHTML({ buttons: addBtns() }));
  };
  const dayNote = dt => (dt && dt !== today() ? " · " + M.fmtDay(dt) : "");
  /* one serving of a saved food, as a diary entry / meal item */
  const foodEntry = f => ({ name: f.name, brand: f.brand || "", servings: 1, servingLabel: M.fmtServing(f.serving), g: num(f.serving && f.serving.g) > 0 ? num(f.serving.g) : null, per: M.cp(f.per), foodId: f.id });
  /* picking an item for the meal builder: every way out goes back to it */
  function backToBuilder(msg) { if (UI.draft && !UI.sheetOpen()) UI.openBuilder(); if (msg) UI.toast(msg); }
  A["ff-save"] = el => {
    const editing = !!(ff.id && M.MS.foods[ff.id]), pick = ff.onPick;
    const f = saveForm(el); if (!f) return;
    const n = ff.mealsUpdated || 0;
    UI.close();
    const msg = editing ? "Saved changes" + (n ? ". Updated " + n + " saved meal" + (n === 1 ? "" : "s") + "." : "") : "Saved to My foods";
    if (typeof pick === "function") { backToBuilder(msg); return; }
    UI.toast(msg);
    if (UI.tab === "foods") UI.render();
  };
  /* Save, then log one serving right away (tap the entry to change the amount). */
  A["ff-save-add"] = el => {
    const f = saveForm(el); if (!f) return;
    const ctx = { slot: ff.slot, date: ff.date, onPick: ff.onPick };
    UI.close();
    const e = foodEntry(f);
    if (typeof ctx.onPick === "function") { ctx.onPick(e); return; }
    M.log.add(ctx.date, Object.assign(e, { slot: ctx.slot }));
    UI.toast("Added to " + ctx.slot + dayNote(ctx.date));
    UI.render();
  };
  A["ff-del"] = el => { if (!confirmTap(el, "delete")) return; if (ff.id) M.foods.remove(ff.id); UI.close(); UI.toast("Deleted"); UI.render(); };

  /* ----------------------------------------------------------------- label */
  A["open-label"] = el => {
    const ctx = scanCtx();
    ff = { food: { name: "", brand: "", barcode: (el && el.dataset.code) || "", serving: { qty: 1, unit: "serving", g: null }, per: {}, source: "label" }, id: null, slot: ctx.slot, date: ctx.date, onPick: ctx.onPick };
    UI.sheet("Scan label", '<p class="hint" style="font-size:15px;margin:0 0 10px">Take a clear photo of the Nutrition Facts panel. Fill the frame, good light, no glare.</p>' +
      '<label class="btn primary block m-file"><input type="file" accept="image/*" capture="environment" data-m="label-file">Take a photo</label>' +
      '<label class="btn block m-file" style="margin-top:8px"><input type="file" accept="image/*" data-m="label-file">Choose from photos</label>' +
      '<div class="m-status mut" id="m-label-status" role="status"></div><div id="m-label-form"></div>' +
      '<button class="btn ghost block" id="m-label-type" data-m="open-form" data-code="' + esc(ff.food.barcode) + '" style="margin-top:8px">Type it in instead</button>');
  };
  C["label-file"] = el => {
    const file = el.files && el.files[0]; if (!file || !ff) return;
    const st = $("m-label-status"); if (st) st.textContent = "Reading label…";
    const ctx = ff;
    M.food.label.fromImage(file, { onProgress: m => { if (st) st.textContent = m; } }).then(res => {
      if (ff !== ctx) return;
      const f = res.food || {};
      ff.food = { name: f.name || ff.food.name || "", brand: f.brand || ff.food.brand || "", barcode: ff.food.barcode || "", serving: f.serving || { qty: 1, unit: "serving", g: null }, per: f.per || {}, source: "label" };
      ff.method = res.method;
      const badge = res.method === "ai" ? '<span class="tag ok">Read by Claude. Check the numbers.</span>' : '<span class="tag warn">Read by your phone. Check the numbers.</span>';
      if (st) st.textContent = "";
      /* the numbers are in the form now: one way to type, and it keeps them */
      const tb = $("m-label-type"); if (tb) tb.hidden = true;
      const box = $("m-label-form");
      if (box) box.innerHTML = formHTML({ badge: '<div class="m-badge">' + badge + "</div>" + (res.warning ? '<p class="hint m-warnline">' + esc(res.warning) + '</p>' : ""), buttons: addBtns() });
    }, e => { if (ff !== ctx) return; if (st) st.textContent = errMsg(e); const tb = $("m-label-type"); if (tb) { tb.hidden = false; tb.textContent = "Type it in"; } });
  };

  /* ----------------------------------------------------- items (photo/describe) */
  /* items = { list:[{name, servingLabel, g, per, servings, source}], slot, date, onPick, note } */
  /* The whole amount of an item, servings folded in: "2 slices (100 g)", "1.5 cups (360 g)", "150 g".
     Cook foods read raw first ("6 oz raw (4.4 oz cooked)"). Plain text (escape it). */
  const NOPLURAL = /^(g|grams?|kg|mg|oz|lbs?|ml|l|tbsp|tsp|fl|small|medium|large|each|whole)$/i;
  function plural(unit) {
    const parts = String(unit).split(","), words = parts[0].trim().split(/\s+/), last = words[words.length - 1] || "";
    if (!last || NOPLURAL.test(last) || /[^a-z]/i.test(last) || /s$/i.test(last)) return unit;
    words[words.length - 1] = /(sh|ch|x|z)$/i.test(last) || /(potato|tomato)$/i.test(last) ? last + "es" : /[^aeiou]y$/i.test(last) ? last.slice(0, -1) + "ies" : last + "s";
    parts[0] = words.join(" ");
    return parts.join(",");
  }
  function wholeAmount(it) {
    const c = cookText(it); if (c) return c;
    const s = rawServings(it), sv = M.parseServing(tidyLabel(it && it.servingLabel) || "1 serving");
    const q = (sv.qty || 1) * s, g = num(sv.g) > 0 ? num(sv.g) * s : 0, unit = String(sv.unit || "serving").trim() || "serving";
    if (/^(g|grams?)$/i.test(unit)) return fmtQty(q) + " g";
    return fmtQty(q) + " " + (q > 1 + 1e-9 ? plural(unit) : unit) + (g > 0 ? " (" + (g >= 10 ? r0(g) : r1(g)) + " g)" : "");
  }
  /* eggs, slices, tortillas… step by 1; everything else by ¼ */
  const isCountItem = it => { const u = String(M.parseServing(it && it.servingLabel).unit || "").trim(); return !!u && COUNT_UNIT.test(u) && !(M.cook && M.cook.unitWord(u)); };
  function stepQty(cur, dir, st) {
    cur = Math.max(0, num(cur));
    const next = dir > 0 ? (Math.floor(cur / st + 1e-9) + 1) * st : (Math.ceil(cur / st - 1e-9) - 1) * st;
    return Math.max(0, r2(next));
  }
  /* Hand a list of items to the meal builder in one go (one repaint, one toast). */
  function pickAll(cb, list) { if (typeof cb.many === "function") cb.many(list); else list.forEach(e => cb(e)); }
  function itemsHTML() {
    if (!items.list.length) return '<div class="empty">Nothing to add.</div>';
    const tot = M.foodMath.sum(items.list);
    return '<div class="ex-list m-items">' + items.list.map((it, i) => {
      const t = entryTotals(it), nm = esc(it.name);
      return '<div class="ex-row m-item"><div class="ex-main"><div class="n">' + nm + '</div><div class="t">' + itemLine(it, t) + '</div></div><div class="stepper sm m-istep"><button data-m="item-step" data-i="' + i + '" data-v="-1" aria-label="Less ' + nm + '">−</button><input type="number" inputmode="decimal" step="' + (isCountItem(it) ? 1 : 0.25) + '" min="0" data-m="item-qty" data-i="' + i + '" value="' + fmtQty(rawServings(it)) + '" aria-label="How many: ' + nm + '"><button data-m="item-step" data-i="' + i + '" data-v="1" aria-label="More ' + nm + '">+</button></div><button class="icon" data-m="item-del" data-i="' + i + '" aria-label="Remove ' + nm + '">×</button></div>';
    }).join("") + '</div>' +
      (items.note ? '<p class="hint">' + esc(items.note) + '</p>' : "") +
      '<div class="m-itot num"><span>Total</span><span><b>' + kcal(tot.cal) + '</b> kcal · ' + macroLine(tot) + '</span></div>' +
      '<button class="btn primary block" data-m="items-add" style="margin-top:10px">' + (items.onPick ? "Add to meal" : "Add to " + esc(items.slot)) + '</button>';
  }
  /* "2 slices (100 g) · P …" — the whole amount; an item set to 0 says it is left out */
  const itemLine = (it, t) => (rawServings(it) > 0 ? esc(wholeAmount(it)) + ' · ' + macroLine(t) + ' · <b>' + kcal(t.cal) + '</b> kcal' : '<span class="m-zero">0 · won\'t be added</span>');
  function paintItems() { const box = $("m-items"); if (box && items) box.innerHTML = itemsHTML(); }
  A["item-step"] = el => { const it = items && items.list[num(el.dataset.i)]; if (!it) return; it.servings = stepQty(rawServings(it), num(el.dataset.v), isCountItem(it) ? 1 : 0.25); paintItems(); };
  I["item-qty"] = el => { const it = items && items.list[num(el.dataset.i)]; if (!it) return; it.servings = Math.max(0, num(el.value)); const row = el.closest(".m-item"); if (row) { const tt = row.querySelector(".t"); if (tt) tt.innerHTML = itemLine(it, entryTotals(it)); } const tot = qs("#m-items .m-itot span:last-child"); if (tot) { const s = M.foodMath.sum(items.list); tot.innerHTML = '<b>' + kcal(s.cal) + '</b> kcal · ' + macroLine(s); } };
  A["item-del"] = el => { if (!items) return; items.list.splice(num(el.dataset.i), 1); paintItems(); };
  A["items-add"] = () => {
    if (!items) return;
    const list = items.list.filter(it => rawServings(it) > 0 && it.name);   /* 0 means leave it out */
    if (!list.length) { UI.toast("Nothing to add. Set an amount first."); return; }
    /* g = grams of ONE servingLabel (describe items carry the whole portion in g) */
    const mk = it => Object.assign({ name: it.name, brand: it.brand || "", servings: rawServings(it), servingLabel: it.servingLabel || "1 serving", g: (M.cook ? M.cook.unitGrams(it) : 0) || it.g || null, per: it.per, source: it.source || "ai", foodId: it.foodId || undefined }, cookOf(it));
    if (items.onPick) { const cb = items.onPick; UI.close(); pickAll(cb, list.map(mk)); return; }
    const slot = items.slot, dt = items.date;
    list.forEach(it => M.log.add(dt, Object.assign(mk(it), { slot })));
    UI.close(); UI.toast("Added " + list.length + " item" + (list.length === 1 ? "" : "s") + " to " + slot + dayNote(dt)); UI.render();
  };

  /* ----------------------------------------------------------------- photo */
  A["open-photo"] = () => {
    const ctx = scanCtx();
    items = Object.assign({ list: [], note: "" }, ctx);
    if (M.ai && typeof M.ai.probed === "function" && !M.ai.probed()) {
      const mine = items;
      UI.sheet("Photo", '<div class="empty">Checking for Claude…</div>');
      M.ai.probe().then(() => { if (items === mine && UI.sheetOpen()) { items = null; A["open-photo"](); } }, () => { if (items === mine && UI.sheetOpen()) { items = null; A["open-photo"](); } });
      return;
    }
    const noAI = !(M.ai && M.ai.ready());
    if (noAI) {
      UI.sheet("Photo", '<div class="card m-inner"><div class="bd"><p class="hint" style="font-size:15px">Photo logging needs Claude. Open Chalk inside claude.ai, or add your Anthropic key in You → AI.</p><button class="btn primary block" data-m="tab" data-v="you" style="margin-top:8px">Open You</button><button class="btn ghost block" data-m="open-describe" style="margin-top:8px">Describe it instead</button></div></div>');
      return;
    }
    UI.sheet("Photo", '<p class="hint" style="font-size:15px;margin:0 0 10px">Take a photo of your plate from above. Claude names each food and guesses how much. Check the amounts before you add.</p>' +
      '<label class="btn primary block m-file"><input type="file" accept="image/*" capture="environment" data-m="photo-file">Take a photo</label>' +
      '<label class="btn block m-file" style="margin-top:8px"><input type="file" accept="image/*" data-m="photo-file">Choose from photos</label>' +
      '<div class="m-preview" id="m-photo-prev"></div><div class="m-status mut" id="m-photo-status" role="status"></div><div id="m-items"></div>');
  };
  C["photo-file"] = el => {
    const file = el.files && el.files[0]; if (!file || !items) return;
    const st = $("m-photo-status"), pv = $("m-photo-prev"); const ctx = items;
    if (pv) { const u = objURL(file); pv.innerHTML = u ? '<img src="' + u + '" alt="Your photo">' : ""; }
    if (st) st.textContent = "Looking at your photo…";
    M.food.photo.estimate(file, { slot: items.slot }).then(res => { if (items !== ctx) return; items.list = (res.items || []).map(it => Object.assign({ servings: 1 }, it)); items.note = res.note || ""; if (st) st.textContent = items.list.length ? "" : "No food found. Try another photo or describe it."; paintItems(); },
      e => { if (items !== ctx) return; if (st) st.textContent = errMsg(e); if (isObj(e) && e.code === "no_ai") { const box = $("m-items"); if (box) box.innerHTML = '<button class="btn block" data-m="tab" data-v="you" style="margin-top:8px">Open You</button>'; } });
  };

  /* -------------------------------------------------------------- describe */
  A["open-describe"] = el => {
    const ctx = scanCtx();
    items = Object.assign({ list: [], note: "" }, ctx);
    const q = (el && el.dataset.q) || "";
    UI.sheet("Describe", '<label class="m-f" for="m-desc"><span>What did you eat?</span></label><textarea class="m-ta" id="m-desc" placeholder="e.g. 2 eggs, 2 slices toast, 1 tbsp butter" autocapitalize="off">' + esc(q) + '</textarea>' +
      '<button class="btn primary block" data-m="describe-go" style="margin-top:8px">Find foods</button><div class="m-status mut" id="m-desc-status" role="status">' + (M.ai && M.ai.ready() ? "" : "This matches your words to your foods and the built-in list.") + '</div><div id="m-items"></div>');
    const ta = $("m-desc"); if (ta && !q) { try { ta.focus(); } catch (e) {} }
  };
  A["describe-go"] = el => {
    const ta = $("m-desc"); const text = ta ? ta.value.trim() : ""; if (!text) { UI.toast("Type what you ate"); return; }
    const st = $("m-desc-status"); if (st) st.textContent = M.ai && M.ai.ready() ? "Asking Claude…" : "Matching your words…";
    el.disabled = true; const ctx = items;
    M.food.describe(text, { slot: items.slot }).then(res => {
      if (items !== ctx) return; el.disabled = false;
      items.list = (res.items || []).map(it => Object.assign({ servings: 1 }, it)); items.note = res.note || "";
      const un = Array.isArray(res.unmatched) ? res.unmatched.filter(Boolean) : [];
      if (st) st.textContent = items.list.length ? (un.length ? "Couldn't match: " + un.join(", ") : "") : "Couldn't work that out. Try simpler words like \"2 eggs, 1 cup rice\".";
      paintItems();
    }, e => { if (items !== ctx) return; el.disabled = false; if (st) st.textContent = errMsg(e); });
  };

  /* --------------------------------------------------------------- suggest */
  /* sug = { slot, date, remaining, list, shown:[ids], busy } */
  function remainingFor(dt) {
    const tg = M.person().targets || {}, t = M.log.totals(dt);
    return { cal: r0(num(tg.cal) - num(t.cal)), p: r0(num(tg.p) - num(t.p)), c: r0(num(tg.c) - num(t.c)), f: r0(num(tg.f) - num(t.f)) };
  }
  /* Batch meals (logged by cooked weight) as ideas: a portion sized to the protein that's left
     (3 to 12 oz, or the usual 4 oz / 100 g once protein is met), kept near the calories left. */
  function batchIdeas() {
    if (!sug || sug.onPick || !M.cook) return [];
    const U = units(), fam = U === "metric" ? "g" : "oz", r = sug.remaining;
    let meals = []; try { meals = M.meals.list(sug.slot); } catch (e) { meals = []; }
    return meals.filter(m => isObj(m.batch) && num(m.batch.cookedG) > 0 && sug.shown.indexOf("b:" + m.id) < 0).map(m => {
      const cg = num(m.batch.cookedG), pG = num(m.per && m.per.p) / cg, calG = num(m.per && m.per.cal) / cg;
      let g = pG > 0 && r.p > 0 ? r.p / pG : M.cook.portionG(U);
      if (calG > 0) g = Math.min(g, Math.max(0, r.cal + 150) / calG);
      g = Math.min(Math.max(85, Math.min(340, g)), cg);
      const step = fam === "g" ? 10 : M.cook.UNIT_G.oz / 2;
      g = Math.max(step, Math.round(g / step) * step);
      return { id: "b:" + m.id, batchMeal: true, mealId: m.id, name: m.name, desc: m.desc || "", slot: m.slot, grams: g, unit: fam, per: M.cook.batchPer(m, g), items: [], source: "mine", portion: M.cook.fmtWeight(g, fam) + " cooked" };
    }).filter(s => num(s.per.cal) <= Math.max(0, r.cal) + 150);
  }
  function sugCard(s, i) {
    const per = s.per || M.foodMath.blank(), pick = !!(sug && sug.onPick);
    const src = s.batchMeal ? '<span class="tag ok">Your batch</span>' : s.source === "mine" ? '<span class="tag ok">Your meal</span>' : s.source === "often" ? '<span class="tag ok">You eat this often</span>' : (s.source === "claude" || s.source === "ai") ? '<span class="tag acc">Claude</span>' : "";
    const store = s.store && s.store !== "Either" ? '<span class="tag">' + esc(s.store) + '</span>' : "";
    const time = num(s.prepMin) > 0 ? '<span class="tag">' + r0(num(s.prepMin)) + ' min</span>' : Array.isArray(s.tags) && s.tags.indexOf("no-cook") >= 0 ? '<span class="tag">no cook</span>' : "";
    const body = s.batchMeal
      ? '<div class="mut small num">' + macroLine(per) + ' for ' + esc(s.portion) + '</div>'
      : '<div class="mut small num">' + macroLine(per) + ' per serving</div><ul class="m-sugitems">' + (s.items || []).map(it => '<li><span class="n">' + esc(it.name) + '</span><span class="a num">' + esc(wholeAmount(it)) + '</span></li>').join("") + '</ul>';
    const btns = pick ? '<button class="btn primary" data-m="sug-log" data-i="' + i + '">Add to meal</button>'
      : '<button class="btn primary" data-m="sug-log" data-i="' + i + '">' + (s.batchMeal ? "Log " + esc(s.portion.replace(/ cooked$/, "")) : "Log it") + '</button>' + (s.source === "mine" || s.batchMeal ? "" : '<button class="btn" data-m="sug-save" data-i="' + i + '">Save as meal</button>');
    return '<div class="card m-sug"><div class="hd"><div><h3>' + esc(s.name) + '</h3><div class="m-sugtags">' + src + store + time + '</div></div><div class="m-kcal num">' + kcal(per.cal) + '</div></div>' +
      '<div class="bd">' + (s.desc ? '<p class="m-sugdesc">' + esc(s.desc) + '</p>' : "") + body + '<div class="m-btnrow">' + btns + '</div></div></div>';
  }
  function sugHTML() {
    const r = sug.remaining;
    /* what's left; below zero reads "355 over" */
    const cell = (k, v, unit) => '<div class="stat' + (v < 0 ? " over" : "") + '"><div class="v">' + Math.abs(v) + '<small>' + unit + (v < 0 ? (unit ? " " : "") + "over" : "") + '</small></div><div class="k">' + k + '</div></div>';
    const day = sug.date === today() ? "today" : M.fmtDay(sug.date);
    return '<div class="m-sughd"><div class="mut small">Left for ' + esc(day) + '</div><div class="stats m-stats4">' + cell("Calories", r.cal, "") + cell("Protein", r.p, "g") + cell("Carbs", r.c, "g") + cell("Fat", r.f, "g") + '</div>' +
      '<div class="m-pills" role="group" aria-label="Ideas for">' + M.SLOTS.map(s => '<button class="chip' + (s === sug.slot ? " on" : "") + '" data-m="sug-slot" data-v="' + s + '" aria-pressed="' + (s === sug.slot ? "true" : "false") + '">' + s + '</button>').join("") + '</div></div>' +
      '<div id="m-sug-list" aria-live="polite"></div><button class="btn block" data-m="sug-more" id="m-sug-more" style="margin-top:8px">More ideas</button>';
  }
  function runSuggest() {
    const box = $("m-sug-list"), more = $("m-sug-more"); if (!box || !sug) return;
    const my = ++sug.req;
    box.innerHTML = '<div class="empty">' + (M.ai && M.ai.ready() ? "Thinking…" : "Picking meals…") + '</div>';
    if (more) more.disabled = true;
    M.food.suggest({ pid: pid(), slot: sug.slot, remaining: sug.remaining, exclude: sug.shown.slice() }).then(list => {
      if (!sug || sug.req !== my) return;
      const batches = batchIdeas();
      sug.list = batches.concat(Array.isArray(list) ? list : []);
      sug.list.forEach(s => { if (s.id && !String(s.id).startsWith("ai_")) sug.shown.push(s.id); });
      box.innerHTML = (sug.list.length ? sug.list.map(sugCard).join("") : '<div class="empty">No ideas fit what\'s left. Try another meal.</div>') + (list && list.aiError ? '<p class="hint">Claude: ' + esc(list.aiError) + '</p>' : "");
      if (more) more.disabled = false;
    }, e => { if (!sug || sug.req !== my) return; box.innerHTML = '<div class="empty">' + esc(errMsg(e)) + '</div>'; if (more) more.disabled = false; });
  }
  /* From Add item (building a meal) the ideas go into the meal, not the diary. */
  A.suggest = () => {
    const slot = add ? add.slot : M.defaultSlot(), dt = add ? add.date : date(), onPick = add && typeof add.onPick === "function" ? add.onPick : null;
    sug = { slot, date: dt, remaining: remainingFor(dt), list: [], shown: [], req: 0, onPick };
    UI.sheet(onPick ? "Ideas for your meal" : "Suggest a meal", sugHTML());
    runSuggest();
  };
  A["sug-slot"] = el => { if (!sug) return; sug.slot = el.dataset.v; sug.shown = []; qsa('[data-m="sug-slot"]').forEach(b => { b.classList.toggle("on", b.dataset.v === sug.slot); b.setAttribute("aria-pressed", b.dataset.v === sug.slot ? "true" : "false"); }); runSuggest(); };
  A["sug-more"] = () => runSuggest();
  const sugItems = s => (s.items || []).map(it => Object.assign({ name: it.name, brand: it.brand || "", servings: servingsOf(it), servingLabel: it.servingLabel || "1 serving", g: (M.cook ? M.cook.unitGrams(it) : 0) || it.g || null, per: it.per, foodId: it.foodId && M.foods.get(it.foodId) ? it.foodId : undefined, source: (s.source === "claude" || s.source === "ai") ? "ai" : undefined }, cookOf(it)));
  A["sug-log"] = el => {
    const s = sug && sug.list[num(el.dataset.i)]; if (!s) return;
    const slot = sug.slot, dt = sug.date;
    if (s.batchMeal) {
      if (!M.meals.get(s.mealId)) return;
      M.log.addMeal(dt, s.mealId, 1, slot, { grams: s.grams, unit: s.unit });
      UI.close(); UI.toast("Logged " + s.portion + " to " + slot + dayNote(dt)); UI.render(); return;
    }
    const list = sugItems(s);
    if (typeof sug.onPick === "function") { const cb = sug.onPick; UI.close(); pickAll(cb, list); return; }
    if (s.source === "mine" && s.mealId && M.meals.get(s.mealId)) { M.log.addMeal(dt, s.mealId, 1, slot); UI.close(); UI.toast("Logged " + s.name + " to " + slot + dayNote(dt)); UI.render(); return; }
    if (s.source === "often") {   /* their usual foods, logged the way they log them */
      list.forEach(it => M.log.add(dt, Object.assign(it, { slot })));
      UI.close(); UI.toast("Logged " + list.length + " item" + (list.length === 1 ? "" : "s") + " to " + slot + dayNote(dt)); UI.render(); return;
    }
    /* a meal idea: ONE diary entry named after it (like a saved meal); its items ride along for "Save as a meal" */
    const kept = list.map(it => { const o = Object.assign({}, it); if (o.source === undefined) delete o.source; if (o.foodId === undefined) delete o.foodId; return o; });
    M.log.add(dt, { slot, name: s.name, brand: "", servings: 1, servingLabel: "1 serving", g: null, per: M.foodMath.sum(list), items: kept, source: (s.source === "claude" || s.source === "ai") ? "ai" : "idea" });
    UI.close(); UI.toast("Logged " + s.name + " to " + slot + dayNote(dt)); UI.render();
  };
  A["sug-save"] = el => {
    const s = sug && sug.list[num(el.dataset.i)]; if (!s) return;
    const m = M.meals.add({ name: s.name, desc: s.desc || "", slot: sug.slot, servingsMade: 1, items: sugItems(s) });
    el.textContent = "Saved"; el.disabled = true; UI.toast('Saved "' + m.name + '" to Foods');
  };

  /* ================================================================== FOODS */
  /* "Batch · 51 oz cooked" and "180 kcal · P 30 · C 12 · F 5 per 4 oz cooked" */
  function batchLines(m) {
    const U = units(), pg = M.cook.portionG(U), per = M.cook.batchPer(m, pg);
    return '<div class="t num">' + esc(M.cook.batchSub(m, U)) + '</div><div class="t num">' + kcal(per.cal) + ' kcal · ' + macroLine(per) + ' per ' + esc(M.cook.fmtWeight(pg, U === "metric" ? "g" : "oz")) + ' cooked</div>';
  }
  function mealRow(m) {
    const per = m.per || M.foodMath.blank();
    const lines = isObj(m.batch) && num(m.batch.cookedG) > 0 ? batchLines(m) : '<div class="t num">' + kcal(per.cal) + ' kcal · ' + macroLine(per) + ' per serving</div>';
    return '<button class="ex-row m-row" data-m="meal" data-id="' + esc(m.id) + '"><div class="ex-main"><div class="n">' + esc(m.name) + '</div>' + (m.desc ? '<div class="t m-clamp">' + esc(m.desc) + '</div>' : "") + lines + '</div><span class="icon">›</span></button>';
  }
  function foodRow(f) {
    const sv = (M.cook && M.cook.servingLabel(f, units())) || M.fmtServing(f.serving);
    return '<button class="ex-row m-row" data-m="food" data-id="' + esc(f.id) + '"><div class="ex-main"><div class="n">' + esc(f.name) + '</div><div class="t">' + (f.brand ? esc(f.brand) + " · " : "") + esc(sv) + ' · ' + macroLine(f.per) + '</div></div><div class="m-kcal num">' + kcal(f.per.cal) + '</div></button>';
  }
  const slotName = s => (s === "Any" ? "Any time" : s);
  /* Foods-tab filter: every typed word must be found (plurals, apostrophes and leading
     numbers handled by M.searchTokens when m-core has it). → text => boolean */
  /* the same idea for older m-core: no apostrophes, no leading numbers, simple singulars */
  const localTokens = s => lc(s).replace(/['’]/g, "").split(/[^a-z0-9%]+/).filter(w => w && !/^\d+(\.\d+)?$/.test(w))
    .map(w => (w.length > 3 ? (/ies$/.test(w) ? w.slice(0, -3) + "y" : /oes$/.test(w) ? w.slice(0, -2) : /[^s]s$/.test(w) ? w.slice(0, -1) : w) : w));
  function textMatcher(q) {
    const tok = s => { try { if (typeof M.searchTokens === "function") return M.searchTokens(s) || []; } catch (e) {} return localTokens(s); };
    const toks = tok(q);
    if (!toks.length) return () => true;
    return text => {
      const l = lc(text), words = tok(text);
      return toks.every(t => words.some(w => w.startsWith(t)) || l.includes(t));
    };
  }
  const mealText = m => [m.name, m.desc].concat((m.items || []).map(it => (it && it.name || "") + " " + (it && it.brand || ""))).join(" ");
  function foodsListHTML() {
    const q = String(UI.foodsQ || "").trim(), hit = textMatcher(q);
    if (UI.foodsSeg === "meals") {
      const meals = M.meals.list().filter(m => hit(mealText(m)));
      if (!meals.length) return '<div class="card"><div class="empty">' + (q ? "No meals match." : "No saved meals yet. Tap + New meal. Or log food, then tap … on that meal and pick Save as a meal.") + '</div></div>';
      return M.SLOTS.concat(["Any"]).map(s => { const g = meals.filter(m => m.slot === s); if (!g.length) return ""; return '<h2 class="sec">' + slotName(s) + '</h2><div class="card"><div class="ex-list">' + g.map(mealRow).join("") + '</div></div>'; }).join("");
    }
    const foods = M.foods.list().filter(f => hit(f.name + " " + (f.brand || "")));
    if (!foods.length) return '<div class="card"><div class="empty">' + (q ? "No foods match." : "No saved foods yet. Tap + New food, or scan a barcode or label when you log. Every food you add is saved here.") + '</div></div>';
    return '<div class="card"><div class="ex-list">' + foods.map(foodRow).join("") + '</div></div>';
  }
  UI.views.foods = function () {
    const meals = UI.foodsSeg === "meals";
    return '<div class="seg scope m-seg" role="group" aria-label="Show"><button data-m="foods-seg" data-v="meals" aria-pressed="' + (meals ? "true" : "false") + '"' + (meals ? ' class="on"' : "") + '>Saved meals</button><button data-m="foods-seg" data-v="foods" aria-pressed="' + (meals ? "false" : "true") + '"' + (meals ? "" : ' class="on"') + '>My foods</button></div>' +
      '<div class="m-foodsbar"><input class="m-search" type="search" data-m="foods-q" placeholder="' + (meals ? "Search meals" : "Search my foods") + '" aria-label="' + (meals ? "Search meals" : "Search my foods") + '" value="' + esc(UI.foodsQ) + '" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"><button class="btn" data-m="' + (meals ? "meal-new" : "food-new") + '">' + (meals ? "+ New meal" : "+ New food") + '</button></div>' +
      '<div id="m-foods-list">' + foodsListHTML() + '</div>';
  };
  A["foods-seg"] = el => { UI.foodsSeg = el.dataset.v; UI.foodsQ = ""; UI.render(); };
  I["foods-q"] = el => { UI.foodsQ = el.value; clearTimeout(UI._fq); UI._fq = setTimeout(() => { const box = $("m-foods-list"); if (box) box.innerHTML = foodsListHTML(); }, 120); };
  A["food-new"] = () => { ff = { food: { name: "", brand: "", barcode: "", serving: { qty: 1, unit: "serving", g: null }, per: {}, source: "custom" }, id: null, slot: M.defaultSlot(), date: date(), onPick: null }; UI.sheet("New food", formHTML({ buttons: '<button class="btn primary block" data-m="ff-save">Save</button>' })); };
  A.food = el => {
    const f = M.foods.get(el.dataset.id); if (!f || !M.MS.foods[f.id]) return;
    const c = M.cook && M.cook.of(f), dry = !!(c && c.word === "dry");
    const kind = c ? (dry ? "grain" : "meat") : "none", val = c ? String(dry ? r2(c.y) : r0(c.y * 100)) : "";
    ff = { food: M.cp(f), orig: M.cp(f), id: f.id, slot: M.defaultSlot(), date: date(), onPick: null, cookKind: kind, cookVal: val, cookKind0: kind, cookVal0: val };
    UI.sheet("Edit food", formHTML({ buttons: '<button class="btn primary block" data-m="ff-save">Save</button><button class="btn block" data-m="ff-log">Log to today</button><button class="btn block danger" data-m="ff-del">Delete</button>' }));
  };
  /* Nothing changed: log it without saving the food again. */
  A["ff-log"] = el => {
    let f = ff && ff.id ? M.MS.foods[ff.id] : null;
    if (!f || formChanged()) { f = saveForm(el); if (!f) return; }
    UI.close(); UI.openDetail(Object.assign({ kind: "food", foodId: f.id, sub: M.fmtServing(f.serving), ref: f }, f), { slot: M.defaultSlot(), date: today(), mode: "log" });
  };

  /* ------------------------------------------------------------ meal sheet */
  A.meal = el => {
    const m = M.meals.get(el.dataset.id); if (!m) return;
    mealSheet = { id: m.id, slot: M.isSlot(m.slot) ? m.slot : M.defaultSlot(), servings: 1 };
    const per = m.per || M.foodMath.blank();
    const head = m.desc ? '<p class="m-sugdesc">' + esc(m.desc) + '</p>' : "";
    const list = '<div class="ex-list m-mealitems">' + m.items.map(it => { const t = entryTotals(it); return '<div class="ex-row"><div class="ex-main"><div class="n" style="font-size:15px">' + esc(it.name) + '</div><div class="t">' + esc(wholeAmount(it)) + '</div></div><div class="num mut">' + kcal(t.cal) + '</div></div>'; }).join("") + '</div>';
    const tools = '<div class="m-btnrow"><button class="btn" data-m="meal-edit">Edit</button><button class="btn" data-m="meal-dup">Duplicate</button><button class="btn danger" data-m="meal-del">Delete</button></div>';
    if (isObj(m.batch) && num(m.batch.cookedG) > 0) {
      /* a batch: "How much did you eat?" by cooked weight, logged to today; the amount comes first */
      initDet(batchSrc(m), { slot: mealSheet.slot, date: today(), mode: "log", fromMeal: true });
      UI.sheet(m.name, head + '<div class="m-batchinfo">' + batchLines(m) + '</div><div id="m-det-box" class="m-det-inmeal">' + detailHTML() + '</div>' + '<div class="m-inlbl">What\'s in it</div>' + list + tools);
      detLive();
      return;
    }
    UI.sheet(m.name, head +
      '<div class="mut small num" style="margin-bottom:8px">' + kcal(per.cal) + ' kcal · ' + macroLine(per) + ' per serving · makes ' + fmtQty(m.servingsMade) + '</div>' + list +
      '<div class="m-det-grid" style="margin-top:12px"><div><span class="lbl">How many servings?</span><div class="stepper"><button data-m="meal-step" data-v="-1" aria-label="Less">−</button><input type="number" inputmode="decimal" step="0.25" min="0" data-m="meal-qty" value="1" aria-label="How many servings"><button data-m="meal-step" data-v="1" aria-label="More">+</button></div></div><div><span class="lbl">Add to</span><select class="sel" data-m="meal-slot" aria-label="Add to which meal">' + M.SLOTS.map(s => '<option' + (s === mealSheet.slot ? " selected" : "") + '>' + s + '</option>').join("") + '</select></div></div>' +
      '<p class="hint m-warnline" id="m-meal-msg" role="status" hidden></p>' +
      '<button class="btn primary block" data-m="meal-log" style="margin-top:12px">Log to today</button>' + tools);
  };
  A["meal-step"] = el => { if (!mealSheet) return; const inp = qs('[data-m="meal-qty"]'); mealSheet.servings = qstep(mealSheet.servings, num(el.dataset.v)); if (inp) inp.value = fmtQty(mealSheet.servings); const w = $("m-meal-msg"); if (w) w.hidden = true; };
  I["meal-qty"] = el => { if (!mealSheet) return; mealSheet.servings = Math.max(0, num(el.value)); };
  C["meal-slot"] = el => { if (mealSheet) mealSheet.slot = el.value; };
  /* 0 servings is never logged as 1 */
  A["meal-log"] = () => {
    if (!mealSheet) return;
    if (!(mealSheet.servings > 0)) { const w = $("m-meal-msg"); if (w) { w.textContent = "Enter how many servings."; w.hidden = false; } const inp = qs('[data-m="meal-qty"]'); if (inp) { try { inp.focus(); } catch (e) {} } return; }
    const s = mealSheet.servings, slot = mealSheet.slot;
    M.log.addMeal(today(), mealSheet.id, s, slot); UI.close(); UI.toast("Added to " + slot); UI.date = today(); if (UI.tab === "diary") UI.render();
  };
  A["meal-edit"] = () => { const m = M.meals.get(mealSheet.id); if (!m) return; det = null; UI.draft = { id: m.id, kind: "edit", name: m.name, desc: m.desc, slot: m.slot, servingsMade: m.servingsMade, batch: draftBatch(m), items: M.cp(m.items) }; UI.openBuilder(); };
  A["meal-dup"] = () => { const m = M.meals.get(mealSheet.id); if (!m) return; const c = M.meals.add({ name: m.name + " (copy)", desc: m.desc, slot: m.slot, servingsMade: m.servingsMade, batch: isObj(m.batch) ? { cookedG: m.batch.cookedG } : null, items: M.cp(m.items) }); UI.close(); UI.toast('Duplicated as "' + c.name + '"'); UI.render(); };
  A["meal-del"] = el => { if (!confirmTap(el, "delete")) return; M.meals.remove(mealSheet.id); UI.close(); UI.toast("Deleted"); UI.render(); };

  /* ---------------------------------------------------------- meal builder */
  /* UI.draft = { id|null, name, desc, slot, servingsMade, items:[Entry-like], editIdx,
                  batch:{ on, qty, unit:"oz"|"lb"|"g" } }  — batch = "Cooked as a batch — log by weight" */
  function draftBatch(m) {
    const fam = units() === "metric" ? "g" : "oz";
    if (m && isObj(m.batch) && num(m.batch.cookedG) > 0) { const q = num(m.batch.cookedG) / M.cook.UNIT_G[fam]; return { on: true, unit: fam, qty: fam === "g" ? r0(q) : r1(q) }; }
    return { on: false, unit: fam, qty: null };
  }
  const batchOn = () => !!(UI.draft && isObj(UI.draft.batch) && UI.draft.batch.on);
  const cookedG = () => { const b = UI.draft && UI.draft.batch; return b && b.on ? num(b.qty) * (M.cook.UNIT_G[b.unit] || 0) : 0; };
  function draftTotals() { const n = num(UI.draft.servingsMade, 1) > 0 ? num(UI.draft.servingsMade, 1) : 1; const t = M.foodMath.sum(UI.draft.items); const o = {}; NUT.forEach(k => { o[k] = r1(t[k] / n); }); return o; }
  /* Drafts: "+ New meal" keeps its own draft (kind "new"), saved on this phone across reloads,
     apart from "Save Lunch as a meal" and "Edit" drafts, which never replace it. */
  const draftKey = () => "chalk.macros.draft." + (pid() || "x");
  const draftHasContent = d => !!(d && (String(d.name || "").trim() || (Array.isArray(d.items) && d.items.length)));
  function saveDraft() {
    const d = UI.draft; if (!d || d.kind !== "new") return;
    try { if (typeof localStorage !== "undefined") localStorage.setItem(draftKey(), JSON.stringify({ v: 1, at: Date.now(), name: d.name || "", desc: d.desc || "", slot: d.slot, servingsMade: d.servingsMade, batch: d.batch, items: d.items })); } catch (e) {}
  }
  function loadDraft() {
    try {
      if (typeof localStorage === "undefined") return null;
      const o = JSON.parse(localStorage.getItem(draftKey()) || "null");
      if (!isObj(o) || !Array.isArray(o.items)) return null;
      const d = { id: null, kind: "new", name: String(o.name || ""), desc: String(o.desc || ""), slot: o.slot === "Any" || M.isSlot(o.slot) ? o.slot : M.defaultSlot(), servingsMade: num(o.servingsMade, 1) > 0 ? num(o.servingsMade, 1) : 1, batch: isObj(o.batch) ? o.batch : draftBatch(null), items: o.items.filter(isObj) };
      return draftHasContent(d) ? d : null;
    } catch (e) { return null; }
  }
  function clearDraft() { try { if (typeof localStorage !== "undefined") localStorage.removeItem(draftKey()); } catch (e) {} }
  const freshDraft = () => ({ id: null, kind: "new", name: "", desc: "", slot: M.defaultSlot(), servingsMade: 1, batch: draftBatch(null), items: [] });
  function builderItemsHTML() {
    const d = UI.draft;
    return (d.items.length ? '<div class="ex-list m-mealitems">' + d.items.map((it, i) => {
      const t = entryTotals(it), zero = !(rawServings(it) > 0);
      return '<button class="ex-row m-row" data-m="mb-item" data-i="' + i + '"><div class="ex-main"><div class="n" style="font-size:15px">' + esc(it.name) + '</div><div class="t">' + (zero ? '<span class="m-zero">0 · left out when you save</span>' : esc(wholeAmount(it)) + ' · ' + macroLine(t)) + '</div></div><div class="m-kcal num">' + kcal(t.cal) + '</div></button>';
    }).join("") + '</div>' : '<div class="empty" style="padding:14px">No items yet.</div>') +
      '<button class="btn block" data-m="mb-add" style="margin-top:8px">+ Add item</button>';
  }
  /* "The raw items weigh 70.1 oz." (+ how many items have no weight) */
  function rawHint() {
    const d = UI.draft; if (!batchOn()) return "";
    const list = d.items.filter(it => rawServings(it) > 0);
    const rg = M.cook.rawTotal(list), miss = list.filter(it => !(M.cook.unitGrams(it) > 0)).length;
    let s = rg > 0 ? "The raw items weigh " + M.cook.fmtWeight(rg, units() === "metric" ? "g" : "oz") + "." : "Add items with a weight to see the raw total.";
    if (miss) s += " " + miss + (miss === 1 ? " item has no weight, so it isn't counted." : " items have no weight, so they aren't counted.");
    return s;
  }
  /* Cooked weight far from the raw total (under 40% or over 3.5×) is usually the wrong unit. → message | "" */
  function batchCheck() {
    const d = UI.draft; if (!batchOn()) return "";
    const raw = M.cook.rawTotal(d.items.filter(it => rawServings(it) > 0)), cg = cookedG(), b = d.batch;
    if (!(raw > 0) || !(cg > 0)) return "";
    const ok = g => g / raw >= 0.4 && g / raw <= 3.5;
    if (ok(cg)) return "";
    const alt = ["oz", "lb", "g"].filter(u => u !== b.unit).find(u => ok(num(b.qty) * M.cook.UNIT_G[u]));
    return "That's " + fmtQty(b.qty) + " " + b.unit + " cooked from " + M.cook.fmtWeight(raw, units() === "metric" ? "g" : "oz") + " raw." + (alt ? " Did you mean " + alt + "?" : " Check the cooked weight.");
  }
  function builderLive() {
    const box = $("m-mb-live"); if (!box || !UI.draft) return;
    const raw = $("m-mb-raw"); if (raw) raw.textContent = rawHint();
    const warn = $("m-mb-warn"); if (warn) { const m = batchCheck(); warn.textContent = m; warn.hidden = !m; }
    if (batchOn()) {
      const tot = M.foodMath.sum(UI.draft.items), cg = cookedG();
      if (cg > 0) { const U = units(), pg = M.cook.portionG(U), t = M.foodMath.scale(tot, pg / cg); box.innerHTML = '<span>Per ' + esc(M.cook.fmtWeight(pg, U === "metric" ? "g" : "oz")) + ' cooked</span><span class="num"><b>' + kcal(t.cal) + '</b> kcal · ' + macroLine(t) + '</span>'; }
      else box.innerHTML = '<span>Whole batch</span><span class="num"><b>' + kcal(tot.cal) + '</b> kcal · ' + macroLine(tot) + '</span>';
      return;
    }
    const t = draftTotals();
    box.innerHTML = '<span>Per serving</span><span class="num"><b>' + kcal(t.cal) + '</b> kcal · ' + macroLine(t) + '</span>';
  }
  const PH = { oz: "e.g. 51", lb: "e.g. 3.2", g: "e.g. 1450" };
  function batchHTML() {
    const b = UI.draft.batch;
    return '<div class="m-batch"><button class="m-switch" data-m="mb-batch" role="switch" aria-checked="' + (b.on ? "true" : "false") + '"><span class="m-switch-t">Cooked a big batch? Log it by weight</span><span class="toggle' + (b.on ? " on" : "") + '"><i></i></span></button>' +
      '<div class="m-batchbox" id="m-mb-batch"' + (b.on ? "" : " hidden") + '><p class="hint m-batchtip">After cooking, weigh only the food. Tip: put the empty pot on the scale and press zero first.</p><div class="m-f"><span>Cooked weight of the food</span><div class="m-wrow"><input type="number" inputmode="decimal" step="any" min="0" data-m="mb-cooked" value="' + (num(b.qty) > 0 ? esc(fmtQty(b.qty)) : "") + '" placeholder="' + (PH[b.unit] || "") + '" aria-label="Cooked weight of the food"><div class="seg m-wseg" role="group" aria-label="Unit">' +
      ["oz", "lb", "g"].map(u => '<button data-m="mb-cunit" data-v="' + u + '" aria-pressed="' + (b.unit === u ? "true" : "false") + '"' + (b.unit === u ? ' class="on"' : "") + '>' + u + '</button>').join("") + '</div></div></div>' +
      '<p class="hint m-warnline" id="m-mb-warn" role="status" hidden></p><p class="hint" id="m-mb-raw"></p><p class="hint">Each time you eat, weigh your portion and log that.</p></div></div>';
  }
  UI.openBuilder = function () {
    const d = UI.draft; if (!d) return;
    if (!isObj(d.batch)) d.batch = draftBatch(null);
    const resume = d.kind === "new" && d.resumed ? '<div class="m-resume" role="status"><span>Unsaved meal from before</span><button class="btn ghost" data-m="mb-fresh">Start over</button></div>' : "";
    UI.sheet(d.id ? "Edit meal" : "New meal", '<div class="m-form">' + resume + '<label class="m-f"><span>Name</span><input type="text" data-m="mb" data-k="name" value="' + esc(d.name) + '" placeholder="e.g. Chicken rice bowl" autocomplete="off"></label>' +
      '<label class="m-f"><span>Description</span><input type="text" data-m="mb" data-k="desc" value="' + esc(d.desc) + '" placeholder="optional" autocomplete="off"></label>' +
      '<div class="m-f3 m-mbrow' + (d.batch.on ? " batch" : "") + '" id="m-mb-row"><label class="m-f m-mbslot"><span>When</span><select class="sel" data-m="mb" data-k="slot" aria-label="When you eat it">' + M.SLOTS.concat(["Any"]).map(s => '<option value="' + s + '"' + (s === d.slot ? " selected" : "") + '>' + slotName(s) + '</option>').join("") + '</select></label><label class="m-f m-mbsm"><span>Servings it makes</span><input type="number" inputmode="decimal" step="any" min="0.25" data-m="mb" data-k="servingsMade" value="' + esc(fmtQty(d.servingsMade)) + '" aria-label="Servings it makes"></label></div>' +
      '<div id="m-mb-items">' + builderItemsHTML() + '</div>' + batchHTML() + '<div class="m-itot num" id="m-mb-live"></div>' +
      '<div id="m-mb-edit" hidden class="m-mbedit"></div>' +
      '<p class="hint m-warnline" id="m-mb-msg" role="status" hidden></p>' +
      '<button class="btn primary block" data-m="mb-save" style="margin-top:12px">Save</button><button class="btn ghost block" data-m="mb-cancel" style="margin-top:8px">Cancel</button></div>');
    builderLive();
  };
  function mbMsg(msg) { const box = $("m-mb-msg"); if (box) { box.textContent = msg || ""; box.hidden = !msg; } }
  I.mb = el => { const k = el.dataset.k; if (!UI.draft) return; if (k === "servingsMade") { UI.draft.servingsMade = num(el.value, 1); builderLive(); } else UI.draft[k] = el.value; saveDraft(); };
  C.mb = el => { if (!UI.draft) return; if (el.dataset.k === "slot") UI.draft.slot = el.value; saveDraft(); };
  A["mb-batch"] = el => {
    const d = UI.draft; if (!d) return;
    if (!isObj(d.batch)) d.batch = draftBatch(null);
    d.batch.on = !d.batch.on;
    el.setAttribute("aria-checked", d.batch.on ? "true" : "false");
    const tg = el.querySelector(".toggle"); if (tg) tg.classList.toggle("on", d.batch.on);
    const box = $("m-mb-batch"); if (box) box.hidden = !d.batch.on;
    const row = $("m-mb-row"); if (row) row.classList.toggle("batch", d.batch.on);
    builderLive(); saveDraft();
  };
  I["mb-cooked"] = el => { const d = UI.draft; if (!d || !isObj(d.batch)) return; d.batch.qty = Math.max(0, num(el.value)); builderLive(); saveDraft(); };
  A["mb-cunit"] = el => {
    const d = UI.draft, u = el.dataset.v; if (!d || !isObj(d.batch) || !M.cook.UNIT_G[u] || u === d.batch.unit) return;
    const g = num(d.batch.qty) * M.cook.UNIT_G[d.batch.unit];
    d.batch.unit = u;
    if (g > 0) { const q = g / M.cook.UNIT_G[u]; d.batch.qty = u === "g" ? r0(q) : u === "lb" ? r2(q) : r1(q); }
    const inp = qs('[data-m="mb-cooked"]'); if (inp) { inp.value = num(d.batch.qty) > 0 ? fmtQty(d.batch.qty) : ""; inp.placeholder = PH[u]; }
    qsa('[data-m="mb-cunit"]').forEach(b => { b.classList.toggle("on", b.dataset.v === u); b.setAttribute("aria-pressed", b.dataset.v === u ? "true" : "false"); });
    builderLive(); saveDraft();
  };
  /* + Add item: whatever they pick (search, scan, label, new food, describe, photo, ideas) comes back here */
  A["mb-add"] = () => {
    const d = UI.draft; if (!d) return;
    UI.close();
    const back = list => {
      if (!UI.draft) UI.draft = d;
      list.forEach(e => UI.draft.items.push(e));
      UI.draft.resumed = false;
      saveDraft(); UI.openBuilder();
      UI.toast(list.length === 1 ? "Added " + list[0].name : "Added " + list.length + " items");
    };
    const onPick = e => back([e]);
    onPick.many = list => back((Array.isArray(list) ? list : []).filter(isObj));
    UI.openAdd({ slot: M.isSlot(d.slot) ? d.slot : M.defaultSlot(), date: date(), onPick });
  };
  /* an item logged as "1 oz raw" / "1 g cooked" steps in that unit; others step in servings */
  function itemUnit(it) {
    const sv = M.parseServing(it.servingLabel), u = M.cook ? M.cook.unitWord(sv.unit) : null;
    if (!cookText(it) || !u || Math.abs((sv.qty || 1) - 1) > 1e-9) return null;
    return { name: String(sv.unit || ""), step: M.cook.UNIT_G[u] ? M.cook.stepFor(u) : 0.25 };
  }
  function mbEditAmt(it) { const a = $("m-mbedit-amt"); if (a && it) a.textContent = cookText(it) || it.servingLabel || ""; }
  A["mb-item"] = el => {
    const i = num(el.dataset.i), it = UI.draft.items[i]; if (!it) return;
    UI.draft.editIdx = i;
    const box = $("m-mb-edit"); if (!box) return;
    box.hidden = false;
    const iu = itemUnit(it);
    const nm = esc(it.name);
    box.innerHTML = '<div class="m-mbedit-n">' + nm + ' <span class="mut small" id="m-mbedit-amt"></span></div><div class="m-det-grid"><div><span class="lbl">' + (iu ? "Amount (" + esc(iu.name) + ")" : "Servings") + '</span><div class="stepper sm"><button data-m="mb-step" data-v="-1" aria-label="Less ' + nm + '">−</button><input type="number" inputmode="decimal" step="' + (iu ? iu.step : isCountItem(it) ? 1 : 0.25) + '" min="0" data-m="mb-qty" value="' + fmtQty(rawServings(it)) + '" aria-label="How many: ' + nm + '"><button data-m="mb-step" data-v="1" aria-label="More ' + nm + '">+</button></div></div><div class="m-btnrow" style="margin-top:0"><button class="btn danger" data-m="mb-remove">Remove</button><button class="btn" data-m="mb-done">Done</button></div></div>';
    mbEditAmt(it);
    try { box.scrollIntoView({ block: "nearest" }); } catch (e) {}
  };
  function mbRepaint() { const box = $("m-mb-items"); if (box) box.innerHTML = builderItemsHTML(); builderLive(); if (UI.draft) mbEditAmt(UI.draft.items[UI.draft.editIdx]); saveDraft(); }
  /* steppers never go below one step (Remove takes an item out); typing 0 leaves it out on save */
  A["mb-step"] = el => {
    const it = UI.draft && UI.draft.items[UI.draft.editIdx]; if (!it) return;
    const iu = itemUnit(it), st = iu ? iu.step : isCountItem(it) ? 1 : 0.25;
    it.servings = Math.max(st, stepQty(rawServings(it), num(el.dataset.v), st));
    const inp = qs('[data-m="mb-qty"]'); if (inp) inp.value = fmtQty(it.servings); mbRepaint();
  };
  I["mb-qty"] = el => { const it = UI.draft && UI.draft.items[UI.draft.editIdx]; if (!it) return; it.servings = Math.max(0, num(el.value)); mbRepaint(); };
  A["mb-remove"] = () => { if (!UI.draft) return; UI.draft.items.splice(UI.draft.editIdx, 1); const box = $("m-mb-edit"); if (box) { box.hidden = true; box.innerHTML = ""; } mbRepaint(); };
  A["mb-done"] = () => { const box = $("m-mb-edit"); if (box) { box.hidden = true; box.innerHTML = ""; } };
  A["mb-save"] = el => {
    const d = UI.draft; if (!d) return;
    mbMsg("");
    const name = String(d.name || "").trim();
    if (!name) { mbMsg("Give the meal a name."); const n = qs('[data-m="mb"][data-k="name"]'); if (n) { try { n.focus(); } catch (e) {} } return; }
    const keep = d.items.filter(it => rawServings(it) > 0), dropped = d.items.length - keep.length;   /* items set to 0 are left out */
    if (!keep.length) { mbMsg(d.items.length ? "Every item is at 0. Set an amount." : "Add at least one item."); return; }
    const cg = cookedG();
    if (batchOn() && !(cg > 0)) { mbMsg("Enter the cooked weight of the food."); const c = qs('[data-m="mb-cooked"]'); if (c) { try { c.focus(); } catch (e) {} } return; }
    const odd = batchCheck();
    if (odd && !confirmTap(el, "save anyway")) { mbMsg(odd); return; }
    const patch = { name, desc: String(d.desc || "").trim(), slot: d.slot, servingsMade: batchOn() ? 1 : num(d.servingsMade, 1) > 0 ? num(d.servingsMade, 1) : 1, items: keep, batch: batchOn() ? { cookedG: cg } : null };
    const m = d.id && M.meals.get(d.id) ? M.meals.update(d.id, patch) : M.meals.add(patch);
    if (d.kind === "new") clearDraft();
    UI.draft = null;
    UI.foodsQ = "";   /* so the new meal shows in the list */
    UI.close(); UI.toast('Saved "' + m.name + '"' + (dropped ? ". Left out " + dropped + " item" + (dropped === 1 ? "" : "s") + " at 0." : ""));
    UI.render();
  };
  /* Cancel with items asks for a second tap; a new meal's saved draft goes too */
  A["mb-cancel"] = el => {
    const d = UI.draft;
    if (d && Array.isArray(d.items) && d.items.length && !confirmTap(el, "throw it away")) return;
    if (d && d.kind === "new") clearDraft();
    UI.draft = null; UI.close();
  };
  A["mb-fresh"] = el => {
    if (!UI.draft) return;
    if (draftHasContent(UI.draft) && !confirmTap(el, "start over")) return;
    clearDraft(); UI.draft = freshDraft(); UI.openBuilder();
  };
  /* + New meal resumes only its own draft (in memory, or saved on this phone) */
  A["meal-new"] = () => {
    if (!(UI.draft && UI.draft.kind === "new")) UI.draft = loadDraft() || freshDraft();
    UI.draft.resumed = draftHasContent(UI.draft);
    UI.openBuilder();
  };

  /* Exposed for tests / other modules. */
  UI._ = { unitOptions, remainingFor, ensureFood, confirmTap, cookSetup, amountLabel, typingIn, resultsHTML: () => (add ? resultsHTML() : ""), state: () => ({ add, det, sug, items, ff, menu, mealSheet }) };
  /* F2b: foods, meals, forms, scan, label, describe, suggest */
  Object.assign(UI._, { wholeAmount, gramsWarning, textMatcher, batchIdeas, loadDraft, draftKey, syncMeals, formChanged, isCountItem });
})(window.M);
