/* node tests/m-trends.test.js — jsdom-backed tests for m-trends.js (charts, Trends, You, check-ins) */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { JSDOM } = require("jsdom");

/* ---- DOM + browser shim ---- */
const dom = new JSDOM(`<!doctype html><html><body>
  <div class="top"><h1 id="title"></h1><div class="sub" id="subtitle"></div></div>
  <div id="scroll"><div class="wrap" id="app"></div></div>
  <div class="cta" id="cta"></div><nav class="tabs" id="tabs"></nav>
  <div id="sheetBg"></div><div id="sheet"><div class="sh"><h3 id="sheetT"></h3></div><div class="sb" id="sheetB"></div></div>
  <div id="toast"></div>
</body></html>`);
global.window = global;
global.document = dom.window.document;
global.localStorage = {
  store: {},
  getItem(k) { return this.store[k] ?? null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; }
};
try { Object.defineProperty(global, "navigator", { value: { vibrate() { return true; } }, configurable: true }); } catch (e) {}
global.AbortController = class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } };

/* ---- minimal Chalk globals ---- */
global.S = { profile: "nick" };
global.PRESETS = { nick: { name: "Nick" }, kat: { name: "Katerina" } };
const toasts = [];
global.toast = m => toasts.push(m);
global.esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
global.uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
let sheetOpen = null;
global.openSheet = (t, h) => { sheetOpen = t; document.getElementById("sheetT").textContent = t; document.getElementById("sheetB").innerHTML = h; };
global.closeSheet = () => { sheetOpen = null; };

const root = path.join(__dirname, "..");
["m-core.js", "m-data.js", "m-food.js"].forEach(f => vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f }));
const M = global.M;

/* stub M.ui if m-ui.js is not present (it is built by another agent) */
let renders = 0;
if (fs.existsSync(path.join(root, "m-ui.js"))) {
  vm.runInThisContext(fs.readFileSync(path.join(root, "m-ui.js"), "utf8"), { filename: "m-ui.js" });
}
M.ui = M.ui || {};
if (typeof M.ui.render !== "function") {
  M.ui.tab = "diary";
  M.ui.render = () => { renders++; const v = M.ui.views[M.ui.tab]; if (v) document.getElementById("app").innerHTML = v(); };
  M.ui.rerender = () => M.ui.render();
  M.ui.sheet = (t, h) => openSheet(t, h);
  M.ui.close = () => closeSheet();
  M.ui.toast = m => toast(m);
  M.ui.actions = M.ui.actions || {}; M.ui.inputs = M.ui.inputs || {}; M.ui.changes = M.ui.changes || {}; M.ui.views = M.ui.views || {};
} else {
  const orig = M.ui.render; M.ui.render = function () { renders++; return orig.apply(this, arguments); };
}
/* handler names that existed before m-trends.js loaded (m-ui.js owns these) */
const PRE_TRENDS = new Set([].concat(Object.keys(M.ui.actions || {}), Object.keys(M.ui.inputs || {}), Object.keys(M.ui.changes || {})));
vm.runInThisContext(fs.readFileSync(path.join(root, "m-trends.js"), "utf8"), { filename: "m-trends.js" });

/* ---- fake clock ---- */
const DAY = 864e5;
let NOW = new Date(2026, 8, 28, 12, 0, 0).getTime();
M.now = () => NOW;
M.reset();
M.ai.setKey("");

/* ---- DOM helpers (simulate m-ui's delegation) ---- */
const app = () => document.getElementById("app");
const show = html => { app().innerHTML = html; };
const $ = sel => document.querySelector(sel);
function click(sel) {
  const el = typeof sel === "string" ? $(sel) : sel;
  assert.ok(el, "no element for " + sel);
  const name = el.dataset.m; assert.ok(M.ui.actions[name], "no action " + name);
  return M.ui.actions[name](el, { target: el });
}
function change(sel, value) {
  const el = typeof sel === "string" ? $(sel) : sel;
  assert.ok(el, "no element for " + sel);
  el.value = String(value);
  const name = el.dataset.m;
  if (M.ui.inputs[name]) M.ui.inputs[name](el, { target: el });
  assert.ok(M.ui.changes[name], "no change handler " + name);
  return M.ui.changes[name](el, { target: el });
}
const count = (html, re) => (html.match(re) || []).length;
const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const r1t = v => Math.round(v * 10) / 10;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || "") + " expected " + a + " ≈ " + b + " (±" + tol + ")");

const tests = [];
function t(name, fn) { tests.push({ name, fn }); }
console.log("m-trends.js");

/* ======================================================================= */
t("loads without throwing and extends M.ui (never replaces)", () => {
  assert.strictEqual(typeof M.ui.views.trends, "function");
  assert.strictEqual(typeof M.ui.views.you, "function");
  assert.strictEqual(typeof M.ui.setupCardHTML, "function");
  assert.strictEqual(typeof M.ui.bannerHTML, "function");
  assert.strictEqual(typeof M.ui.calculatorHTML, "function");
  assert.strictEqual(typeof M.charts.line, "function");
  assert.strictEqual(typeof M.charts.bars, "function");
  assert.strictEqual(typeof M.ui.render, "function", "stub/real render still there");
  const names = Object.keys(M.ui.actions).concat(Object.keys(M.ui.inputs), Object.keys(M.ui.changes)).filter(n => !PRE_TRENDS.has(n));
  assert.ok(names.length > 0, "m-trends added handlers");
  names.forEach(n => assert.ok(/^t-/.test(n), "action prefixed t-: " + n));
  PRE_TRENDS.forEach(n => assert.ok(M.ui.actions[n] || M.ui.inputs[n] || M.ui.changes[n], "m-ui handler kept: " + n));
  ["t-log-body", "t-range", "t-save-setup", "t-snooze", "t-del-body", "t-reviewed", "t-split", "t-manual", "t-ai-save", "t-ai-remove", "t-ai-test", "t-save-body14", "t-save-body", "t-custom-apply", "t-sex", "t-units", "t-setup-seg", "t-setup-split"].forEach(n => assert.strictEqual(typeof M.ui.actions[n], "function", n));
  ["t-num", "t-target", "t-ai-model", "t-setup", "t-custom"].forEach(n => assert.strictEqual(typeof M.ui.changes[n], "function", n));
});

/* ======================================================================= */
t("charts.line: 30 points → 30 circles, avg path, goal line, y ticks inside the data", () => {
  const pts = [];
  for (let i = 0; i < 30; i++) pts.push({ date: M.addDays("2026-09-28", -29 + i), v: 190 - i * 0.3 + (i % 3) * 0.4 });
  const avg = M.body.avg7(pts);
  const svg = M.charts.line(pts, { avg, goal: 175, unit: "lb", label: "Weight" });
  assert.ok(/^<svg class="mt-chart/.test(svg) && /<\/svg>$/.test(svg));
  assert.strictEqual(count(svg, /<circle /g), 30, "one circle per point");
  assert.strictEqual(count(svg, /class="last"/g), 1, "last point emphasized");
  assert.strictEqual(count(svg, /class="pt"/g), 29);
  assert.strictEqual(count(svg, /<path class="avg"/g), 1, "7-day average line");
  assert.strictEqual(count(svg, /<line class="goal"/g), 1, "goal line");
  assert.ok(/Goal 175/.test(svg));
  assert.ok(/viewBox="0 0 340 180"/.test(svg));
  assert.ok(/stroke-width|class="g"/.test(svg));
  /* y ticks are values the data (plus goal) reaches */
  const ticks = Array.from(svg.matchAll(/text-anchor="end">([\d.,]+)<\/text>/g)).map(m => parseFloat(m[1].replace(/,/g, "")));
  assert.ok(ticks.length >= 2, "at least 2 y ticks");
  ticks.forEach(v => assert.ok(v >= 170 && v <= 195, "tick " + v + " in range"));
  /* x labels */
  assert.ok(/Aug 30/.test(svg) && /Sep 28/.test(svg));
  /* no goal → no goal line; no avg → no avg path */
  const s2 = M.charts.line(pts);
  assert.strictEqual(count(s2, /class="goal"/g), 0);
  assert.strictEqual(count(s2, /class="avg"/g), 0);
  /* single point still renders */
  const s3 = M.charts.line([{ date: "2026-09-28", v: 180 }], { goal: 170 });
  assert.strictEqual(count(s3, /<circle /g), 1);
  /* nothing → "" */
  assert.strictEqual(M.charts.line([]), "");
  assert.strictEqual(M.charts.line(null), "");
  /* far-away goal stays out of the y domain but is still drawn at the edge */
  const s4 = M.charts.line(pts, { goal: 120 });
  assert.ok(/Goal 120 ↓/.test(s4));
  /* titles hold the value for hover */
  assert.ok(/<title>Sep 28: [\d.]+ lb<\/title>/.test(svg));
});

t("charts.bars: 7 values, empties hollow, target line", () => {
  const vals = [{ label: "M", v: 2100 }, { label: "T", v: 0, empty: true }, { label: "W", v: 1800 }, { label: "T", v: 2500 }, { label: "F", v: 0, empty: true }, { label: "S", v: 2200 }, { label: "S", v: 1950 }];
  const svg = M.charts.bars(vals, { target: 2200, unit: "kcal" });
  assert.strictEqual(count(svg, /<path class="bar"/g), 5);
  assert.strictEqual(count(svg, /<rect class="bar-e"/g), 2, "empty days drawn hollow");
  assert.strictEqual(count(svg, /class="tgt"/g), 1);
  assert.ok(/Target 2,200/.test(svg));
  assert.strictEqual(count(svg, /<text x="[\d.]+" y="144" text-anchor="middle">/g), 7, "7 day labels");
  assert.strictEqual(M.charts.bars([]), "");
  /* all-empty week has a sane axis */
  const s2 = M.charts.bars(vals.map(v => ({ label: v.label, v: 0, empty: true })), { target: 2000 });
  assert.strictEqual(count(s2, /bar-e/g), 7);
  assert.ok(/Target 2,000/.test(s2));
});

/* ======================================================================= */
t("views.trends: empty states with no body data", () => {
  M.reset();
  const html = M.ui.views.trends();
  assert.ok(/data-m="t-log-body"/.test(html), "log button");
  assert.ok(/Weight<\/h3>/.test(html) && /Resting heart rate<\/h3>/.test(html) && /Last 7 days<\/h3>/.test(html) && /Last 8 weeks<\/h3>/.test(html));
  assert.ok(/No weigh-ins yet/.test(html), "weight empty state");
  assert.ok(/No resting heart rate yet/.test(html), "rhr empty state");
  assert.strictEqual(count(html, /<circle /g), 0, "no points drawn");
  assert.ok(/data-m="t-range" data-v="30"/.test(html) && /data-m="t-range" data-v="90"/.test(html) && /data-m="t-range" data-v="0"/.test(html));
  assert.ok(/Log a day of food and the bars fill in/.test(html));
  /* week bars: 7 empties + target line */
  assert.ok(count(html, /bar-e/g) >= 7);
  assert.ok(/Target 2,000/.test(html), "default target line");
});

t("views.trends: real numbers after 10 weigh-ins (+ rhr), range chips, delete flow", () => {
  M.reset();
  for (let i = 9; i >= 0; i--) M.body.add({ date: M.addDays(M.today(), -i), w: 190 - (9 - i) * 0.5, rhr: 60 - (i % 3) });
  const p = M.person("nick"); p.goalWeightLb = 175; M.save();
  M.trends.state.range = 90;
  const html = M.ui.views.trends();
  assert.ok(/185\.5<small>lb<\/small>/.test(html), "latest weight 185.5");
  assert.ok(/<div class="k">Latest<\/div><div class="mt-sub">Sep 28<\/div>/.test(html));
  assert.ok(/7-day average/.test(html));
  assert.ok(/Goal <b>175 lb<\/b>/.test(html) && /<b>10\.5 lb<\/b> to lose/.test(html), "goal + distance");
  assert.strictEqual(count(html, /class="last"/g), 2, "one emphasized point on each chart");
  assert.strictEqual(count(html, /<circle /g), 20, "10 weight + 10 rhr points");
  assert.ok(/Goal 175/.test(html), "goal line on chart");
  assert.strictEqual(count(html, /<div class="k">7-day average<\/div>/g), 2, "7-day average on both cards");
  assert.ok(/class="on" data-m="t-range" data-v="90"/.test(html), "90 chip on");
  /* range chip */
  show(html);
  click('[data-m="t-range"][data-v="30"]');
  assert.strictEqual(M.trends.state.range, 30);
  assert.ok(/class="on" data-m="t-range" data-v="30"/.test(M.ui.views.trends()));
  /* metric display */
  p.units = "metric"; M.save();
  const mh = M.ui.views.trends();
  assert.ok(/84\.1<small>kg<\/small>/.test(mh), "latest in kg");
  assert.ok(/Goal <b>79\.4 kg<\/b>/.test(mh));
  p.units = "us"; M.save();
  /* ratePerWeek shows once the window is long enough */
  for (let i = 27; i >= 10; i--) M.body.add({ date: M.addDays(M.today(), -i), w: 195 - (27 - i) * 0.3 });
  const rh = M.ui.views.trends();
  assert.ok(/<div class="k">Per week<\/div>/.test(rh) && !/\/wk/.test(rh), "rate per week shown, in words");
  assert.ok(/about \d+ weeks? at <span class="mt-nb">[\d.]+ lb a week<\/span>/.test(rh), "weeks-to-goal estimate, the rate kept on one line (VI-14)");
  /* log sheet */
  click((() => { const b = document.createElement("button"); b.dataset.m = "t-log-body"; return b; })());
  assert.strictEqual(sheetOpen, "Log weight or heart rate");
  const sb = document.getElementById("sheetB");
  assert.ok(sb.querySelector("#mt-w") && sb.querySelector("#mt-rhr") && sb.querySelector("#mt-date"));
  assert.strictEqual(sb.querySelector("#mt-date").value, M.today());
  assert.strictEqual(sb.querySelector("#mt-date").getAttribute("max"), M.today());
  assert.strictEqual(sb.querySelector("#mt-w").getAttribute("placeholder"), "185.5", "placeholder = latest");
  assert.strictEqual(sb.querySelectorAll(".mt-brow").length, 10, "last 10 entries");
  /* save a new entry for yesterday */
  sb.querySelector("#mt-w").value = "184.8"; sb.querySelector("#mt-rhr").value = "58"; sb.querySelector("#mt-date").value = M.addDays(M.today(), -1);
  click(sb.querySelector('[data-m="t-save-body"]'));
  const y = M.MS.body["nick|" + M.addDays(M.today(), -1)];
  assert.strictEqual(y.w, 184.8); assert.strictEqual(y.rhr, 58);
  assert.strictEqual(sheetOpen, null, "sheet closed");
  /* metric save converts kg → lb */
  p.units = "metric"; M.save();
  click((() => { const b = document.createElement("button"); b.dataset.m = "t-log-body"; return b; })());
  document.getElementById("sheetB").querySelector("#mt-w").value = "80";
  click(document.getElementById("sheetB").querySelector('[data-m="t-save-body"]'));
  near(M.MS.body["nick|" + M.today()].w, 176.4, 0.1, "80 kg → lb");
  p.units = "us"; M.save();
  /* delete: two taps */
  click((() => { const b = document.createElement("button"); b.dataset.m = "t-log-body"; return b; })());
  const row = document.getElementById("sheetB").querySelector('[data-m="t-del-body"]');
  const date = row.dataset.date;
  click(row);
  assert.ok(M.MS.body["nick|" + date], "first tap only arms");
  assert.strictEqual(row.textContent, "Delete?");
  click(row);
  assert.strictEqual(row.dataset.f, "w", "newest item is the weight");
  assert.ok(M.MS.body["nick|" + date] && M.MS.body["nick|" + date].w == null && M.MS.body["nick|" + date].rhr > 0, "second tap deletes the weight only; the heart rate stays");
  assert.strictEqual(document.getElementById("sheetB").querySelectorAll(".mt-brow").length, 10, "list refreshed (still 10 of the remaining)");
  const hr = document.getElementById("sheetB").querySelector('[data-m="t-del-body"][data-f="rhr"][data-date="' + date + '"]');
  assert.ok(hr, "heart rate is its own item");
  click(hr); click(hr);
  assert.ok(!M.MS.body["nick|" + date], "both gone → no record left");
  /* empty save: a message in the sheet, does not throw */
  document.getElementById("sheetB").querySelector("#mt-w").value = ""; document.getElementById("sheetB").querySelector("#mt-rhr").value = "";
  click(document.getElementById("sheetB").querySelector('[data-m="t-save-body"]'));
  assert.ok(/weight or a heart rate/i.test($("#mt-body-msg").textContent) && !$("#mt-body-msg").hidden);
  assert.strictEqual(document.activeElement, $("#mt-w"), "the sheet opened with the weight box ready");
  document.activeElement.blur();
});

t("views.trends: This week + Last 8 weeks use logged food", () => {
  M.reset();
  const today = M.today();
  M.log.add(today, { slot: "Lunch", name: "Chicken", per: { cal: 600, p: 60, c: 10, f: 20 } });
  M.log.add(M.addDays(today, -1), { slot: "Dinner", name: "Beef", per: { cal: 900, p: 70, c: 40, f: 30 } });
  M.log.add(M.addDays(today, -14), { slot: "Dinner", name: "Old", per: { cal: 1500, p: 100, c: 40, f: 30 } });
  const html = M.ui.views.trends();
  const ws = M.weekSummary("nick", 0);   /* m-core decides what counts (today may be left out of the averages) */
  assert.ok(new RegExp(">" + ws.avgDays + '<small>of 7</small></div><div class="k">Days logged</div>').test(html), "days logged = the days in the average (TR-06)");
  if (ws.todayLeftOut) assert.ok(/Today isn't in the average yet\./.test(html), "says today is left out");
  assert.ok(new RegExp(">" + fmt(ws.avgCal) + '</div><div class="k">Calories a day</div><div class="mt-sub">of 2,000</div>').test(html), "avg calories vs 2,000");
  assert.ok(new RegExp(">" + Math.round(ws.avgP) + '<small>g</small></div><div class="k">Protein a day</div><div class="mt-sub">of 150 g</div>').test(html), "avg protein");
  assert.ok(count(html, /<path class="bar"/g) >= 3, "this-week bars + week bars");
  assert.ok(/Sep 28: 600 cal so far · 60 g protein/.test(html), "day title, today marked so far");
  assert.ok(/<path class="bar sofar"/.test(html) && />so far<\/text>/.test(html), "today's bar is lighter and says so far");
  assert.ok(/not logged/.test(html));
  assert.ok(/>Su<\/text>/.test(html) && />Mo<\/text>/.test(html), "two-letter day labels");
  assert.ok(!/kcal/.test(html), "cal, not kcal");
});

/* ======================================================================= */
t("setupCardHTML: friendly form with numbers fields + split options (high protein preselected)", () => {
  M.reset(); M.trends.resetDraft();
  const html = M.ui.setupCardHTML();
  assert.ok(/Let's set your targets/.test(html));
  ["highprotein", "balanced", "lowcarb", "keto"].forEach(k => assert.ok(new RegExp('data-m="t-setup-split" data-v="' + k + '"').test(html), "split " + k));
  assert.ok(!/data-v="custom"/.test(html), "no custom on first day");
  assert.ok(/class="opt mt-opt cur" data-m="t-setup-split" data-v="highprotein"/.test(html), "high protein preselected");
  assert.ok(/1 g protein per lb of bodyweight/.test(html), "descriptions shown");
  ["age", "hft", "hin", "weight", "goal", "activity", "pace"].forEach(f => assert.ok(new RegExp('data-m="t-setup" data-f="' + f + '"').test(html), "field " + f));
  assert.ok(/data-m="t-setup-seg" data-f="sex" data-v="m"/.test(html) && /data-m="t-setup-seg" data-f="units" data-v="metric"/.test(html));
  assert.ok(/data-m="t-save-setup"/.test(html));
  assert.ok(/Fill in sex, age, height and weight/.test(html), "preview placeholder");
  Object.keys(M.calc.ACT).forEach(k => assert.ok(new RegExp('<option value="' + k + '"').test(html), "activity option " + k));
  assert.ok(html.indexOf("Exercise 3 to 5 days a week") > 0 && !/\/wk/.test(html), "activity in plain words");
  assert.ok(html.indexOf("Lose 1 lb a week") > 0 && html.indexOf("Lose ½ lb a week") > 0 && html.indexOf("Keep my weight") > 0, "pace labels");
  assert.strictEqual(M.checkins.due("nick"), "setup");
  M.setMode("macros");
  assert.strictEqual(M.ui.bannerHTML(), "", "Macros: banner is empty while setup is due (Diary renders the card)");
  M.setMode("train");
});

t("C3: first-day setup gives the hand-checked numbers (Mifflin-St Jeor, high protein) and says them in words", () => {
  const cases = [
    /* 40-year-old man, 5 ft 11 in, 185 lb, exercise 3 to 5 days a week, lose 1 lb a week:
       BMR 10×83.91 + 6.25×180.34 − 200 + 5 = 1771.3; × 1.55 = 2745.5; − 500 = 2245 cal.
       Protein 185 g; fat 25% = 62 g; carbs (2245 − 740 − 558) ÷ 4 = 237 g; fiber 31; water 96 oz */
    { sex: "m", age: 40, ft: 5, inch: 11, w: 185, act: "moderate", pace: "-1", t: { cal: 2245, p: 185, c: 237, f: 62, fiber: 31, water: 96 }, words: "Targets set: 2,245 cal a day" },
    /* 35-year-old woman, 5 ft 5 in, 140 lb, light exercise, keep my weight:
       BMR 635.0 + 1031.9 − 175 − 161 = 1330.9; × 1.375 = 1830 cal. Protein 140; fat 51; carbs 203 */
    { sex: "f", age: 35, ft: 5, inch: 5, w: 140, act: "light", pace: "0", t: { cal: 1830, p: 140, c: 203, f: 51, fiber: 26, water: 72 }, words: "Targets set: 1,830 cal a day" }
  ];
  cases.forEach(k => {
    M.reset(); M.trends.resetDraft(); toasts.length = 0; M.ui.tab = "diary";
    show(M.ui.setupCardHTML());
    click(`[data-m="t-setup-seg"][data-f="sex"][data-v="${k.sex}"]`);
    show(M.ui.setupCardHTML());
    change('[data-f="age"]', k.age); change('[data-f="hft"]', k.ft); change('[data-f="hin"]', k.inch); change('[data-f="weight"]', k.w);
    change('[data-f="activity"]', k.act); change('[data-f="pace"]', k.pace);
    const pv = document.getElementById("mt-preview").textContent.replace(/\s+/g, " ");
    assert.ok(pv.indexOf(k.t.cal.toLocaleString("en-US") + "cal a day") >= 0 && pv.indexOf(k.t.p + " gprotein") >= 0 && pv.indexOf(k.t.c + " gcarbs") >= 0 && pv.indexOf(k.t.f + " gfat") >= 0, "preview: " + pv);
    click('[data-m="t-save-setup"]');
    const p = M.person("nick");
    assert.strictEqual(p.split, "highprotein", "high protein is the default");
    assert.deepStrictEqual(p.targets, k.t);
    assert.strictEqual(toasts[toasts.length - 1], k.words);
  });
});

t("t-save-setup: validates, writes the profile, targets (high protein p ≈ weightLb), today's body entry, setupAt", () => {
  M.reset(); M.trends.resetDraft(); toasts.length = 0;
  show(M.ui.setupCardHTML());
  /* missing fields → toast, nothing saved */
  click('[data-m="t-save-setup"]');
  assert.ok(/Fill in/.test(toasts[toasts.length - 1]));
  assert.strictEqual(M.person("nick").setupAt, null);
  /* fill in */
  click('[data-m="t-setup-seg"][data-f="sex"][data-v="m"]');
  show(M.ui.setupCardHTML());
  change('[data-f="age"]', 38);
  change('[data-f="hft"]', 5);
  change('[data-f="hin"]', 11);
  change('[data-f="weight"]', 185);
  change('[data-f="goal"]', 175);
  change('[data-f="activity"]', "active");
  change('[data-f="pace"]', "-1");
  /* live preview updates as numbers change */
  const pv = document.getElementById("mt-preview").innerHTML;
  assert.ok(/cal a day/.test(pv) && /<b>185 g<\/b><span>protein<\/span>/.test(pv), "preview shows protein 185 g: " + pv);
  const before = renders;
  click('[data-m="t-save-setup"]');
  const p = M.person("nick");
  assert.strictEqual(p.sex, "m"); assert.strictEqual(p.age, 38); assert.strictEqual(p.heightIn, 71); assert.strictEqual(p.weightLb, 185); assert.strictEqual(p.goalWeightLb, 175);
  assert.strictEqual(p.activity, "active"); assert.strictEqual(p.pace, -1); assert.strictEqual(p.split, "highprotein");
  assert.strictEqual(p.setupAt, NOW, "setupAt = now");
  assert.strictEqual(p.targets.p, 185, "high protein → p = weightLb");
  const exp = M.calc.targets(p);
  assert.deepStrictEqual(p.targets, exp);
  assert.ok(p.targets.cal > 1500 && p.targets.cal < 3500, "kcal " + p.targets.cal);
  const b = M.MS.body["nick|" + M.today()];
  assert.ok(b && b.w === 185, "today's body entry");
  assert.ok(p.lastBody >= NOW);
  assert.ok(/Targets set/.test(toasts[toasts.length - 1]));
  assert.ok(renders > before, "re-rendered");
  assert.strictEqual(M.checkins.due("nick"), null);
  assert.strictEqual(M.ui.bannerHTML(), "", "no banner right after setup");
});

t("setup in metric: kg/cm inputs convert to lb/in", () => {
  M.reset(); M.trends.resetDraft(); global.S.profile = "kat";
  show(M.ui.setupCardHTML());
  click('[data-m="t-setup-seg"][data-f="units"][data-v="metric"]');
  show(M.ui.setupCardHTML());
  assert.ok($('[data-f="hcm"]'), "cm input in metric");
  assert.ok(!$('[data-f="hft"]'));
  click('[data-m="t-setup-seg"][data-f="sex"][data-v="f"]');
  show(M.ui.setupCardHTML());
  change('[data-f="age"]', 30); change('[data-f="hcm"]', 165); change('[data-f="weight"]', 60); change('[data-f="goal"]', 57);
  click('[data-m="t-save-setup"]');
  const p = M.person("kat");
  assert.strictEqual(p.units, "metric"); assert.strictEqual(p.sex, "f");
  near(p.heightIn, 65, 0.1); near(p.weightLb, 132.3, 0.1); near(p.goalWeightLb, 125.7, 0.1);
  assert.ok(p.setupAt);
  global.S.profile = "nick";
});

/* ======================================================================= */
t("bannerHTML: body14 at 15 days, refresh60 at 61 days, snooze hides, save-body14 clears", () => {
  M.reset(); M.trends.resetDraft(); toasts.length = 0;
  const base = NOW;
  const p = M.person("nick");
  Object.assign(p, { sex: "m", age: 38, heightIn: 71, weightLb: 185, goalWeightLb: 175 });
  M.calc.applyTargets(p);
  M.body.add({ date: M.today(), w: 185 });
  M.checkins.done("nick", "setup");
  assert.strictEqual(M.ui.bannerHTML(), "");
  /* 15 days later → body14 */
  NOW = base + 15 * DAY;
  assert.strictEqual(M.checkins.due("nick"), "body14");
  let h = M.ui.bannerHTML();
  assert.ok(/Time to weigh in/.test(h) && /id="mt-b14-w"/.test(h) && /id="mt-b14-rhr"/.test(h));
  assert.ok(/data-m="t-save-body14"/.test(h) && /data-m="t-snooze" data-kind="body14" data-days="14"/.test(h));
  assert.ok(/class="card mt-card mt-banner"/.test(h), "renders as a Chalk .card (works in Train Today too)");
  /* snooze hides it */
  show(h);
  click('[data-m="t-snooze"]');
  assert.strictEqual(M.ui.bannerHTML(), "", "snoozed");
  NOW = base + 15 * DAY + 14 * DAY + 1000;
  assert.ok(/Time to weigh in/.test(M.ui.bannerHTML()), "back after the snooze");
  /* save body14 with only a weight */
  show(M.ui.bannerHTML());
  $("#mt-b14-w").value = "183.2";
  click('[data-m="t-save-body14"]');
  assert.strictEqual(M.MS.body["nick|" + M.today()].w, 183.2);
  assert.strictEqual(M.person("nick").weightLb, 183.2, "profile weight follows");
  assert.strictEqual(M.ui.bannerHTML(), "");
  /* nothing entered → toast, still due */
  NOW += 15 * DAY;
  show(M.ui.bannerHTML()); toasts.length = 0;
  click('[data-m="t-save-body14"]');
  assert.ok(/Type a weight or a heart rate, or tap Skip for now\./.test($("#mt-b14-msg").textContent) && !$("#mt-b14-msg").hidden, "message in the card");
  assert.ok(/Time to weigh in/.test(M.ui.bannerHTML()));
  $("#mt-b14-rhr").value = "57"; click('[data-m="t-save-body14"]');
  assert.strictEqual(M.MS.body["nick|" + M.today()].rhr, 57);
  /* refresh60 wins at 61 days since setup */
  NOW = base + 61 * DAY;
  M.body.add({ date: M.today(), w: 182 }); // body is fresh, so only refresh60 is due
  assert.strictEqual(M.checkins.due("nick"), "refresh60");
  h = M.ui.bannerHTML();
  assert.ok(/You set your numbers over 60 days ago/.test(h));
  assert.ok(/<button class="btn( primary)?" data-m="mode" data-v="macros" data-tab="you">Update<\/button>/.test(h), "Update switches to Macros → You (works from Train too)");
  assert.ok(!/data-m="tab"/.test(h));
  assert.ok(/data-m="t-reviewed"/.test(h) && /data-m="t-snooze" data-kind="refresh60" data-days="7"/.test(h));
  show(h);
  click('[data-m="t-snooze"]');
  assert.strictEqual(M.ui.bannerHTML(), "", "snoozed 7 days");
  NOW += 7 * DAY + 1000;
  assert.ok(/over 60 days ago/.test(M.ui.bannerHTML()));
  show(M.ui.bannerHTML());
  click('[data-m="t-reviewed"]');
  assert.strictEqual(M.person("nick").setupAt, NOW, "They're the same → setupAt = now");
  assert.strictEqual(M.ui.bannerHTML(), "");
  /* no person → "" */
  global.S.profile = null; M.MS.ui.person = null;
  assert.strictEqual(M.ui.bannerHTML(), "");
  assert.strictEqual(M.ui.setupCardHTML(), "");
  global.S.profile = "nick";
  NOW = base;
});

/* ======================================================================= */
t("views.you: renders all cards; t-num weight change updates profile + targets + body", () => {
  M.ui.tab = "you"; /* the real app re-renders the active tab after each field change */
  M.reset(); M.trends.resetDraft();
  const p = M.person("nick");
  Object.assign(p, { sex: "m", age: 38, heightIn: 71, weightLb: 185, goalWeightLb: 175, activity: "active", pace: -1 });
  M.calc.applyTargets(p);
  M.checkins.done("nick", "setup");
  let html = M.ui.views.you();
  ["Your numbers", "Macro targets", "Check-ins", "AI (Claude)", "Person", "Data"].forEach(h => assert.ok(html.indexOf(h + "</h3>") > 0, "card " + h));
  assert.ok(/Now: Nick/.test(html) && /data-a="switch-profile"/.test(html));
  assert.ok(/backup file of everything, go to Train → Settings/.test(html));
  assert.ok(/Switching also changes the workout plan on this phone\./.test(html));
  assert.ok(/data-m="t-num" data-f="weight" value="185"/.test(html));
  assert.ok(/data-m="t-num" data-f="hft" value="5"/.test(html) && /data-f="hin" value="11"/.test(html));
  assert.ok(/<option value="active" selected>/.test(html) && /<option value="-1" selected>/.test(html));
  assert.ok(/data-m="t-reviewed"/.test(html) && /data-m="t-log-body"/.test(html));
  assert.ok(/Set today\. We'll ask again in 60 days\./.test(html));
  assert.ok(/data-m="t-reviewed">Still right</.test(html));
  assert.ok(/Next one Oct 12\./.test(html), "2-week status with next-due date (no year: it is this year)");
  assert.ok(/work without a key/.test(html) && /id="mt-key"/.test(html) && /data-m="t-ai-save"/.test(html) && !/t-ai-remove/.test(html));
  assert.ok(/href="https:\/\/console\.anthropic\.com\/settings\/keys"/.test(html), "key link");
  assert.ok(/<option value="claude-sonnet-5-5" selected>/.test(html) && /claude-haiku-4-5-20251001/.test(html));
  assert.ok(/data-m="t-ai-test"/.test(html) && /key stays on this phone/.test(html));
  assert.ok(/class="opt mt-opt cur" data-m="t-split" data-v="highprotein"/.test(html));
  Object.keys(M.calc.SPLITS).forEach(k => assert.ok(new RegExp('data-m="t-split" data-v="' + k + '"').test(html), "split option " + k));
  assert.ok(/data-m="t-manual"/.test(html));
  assert.ok(new RegExp('>' + fmt(p.targets.cal) + '</div><div class="k">Calories</div>').test(html), "targets grid shows calories (the label says the unit: it fits at 320 px)");
  /* weight change */
  show(html);
  const oldCal = p.targets.cal;
  change('[data-m="t-num"][data-f="weight"]', 180);
  assert.strictEqual(p.weightLb, 180);
  assert.strictEqual(p.targets.p, 180, "protein follows weight");
  assert.ok(p.targets.cal < oldCal, "kcal recomputed");
  assert.strictEqual(M.MS.body["nick|" + M.today()].w, 180, "logged today's weight");
  /* height in ft+in */
  show(M.ui.views.you());
  $('[data-f="hft"]').value = "6";
  change('[data-f="hin"]', 0);
  assert.strictEqual(p.heightIn, 72);
  change('[data-f="age"]', 40); assert.strictEqual(p.age, 40);
  change('[data-f="activity"]', "light"); assert.strictEqual(p.activity, "light");
  change('[data-f="pace"]', "0.5"); assert.strictEqual(p.pace, 0.5);
  change('[data-f="goal"]', 170); assert.strictEqual(p.goalWeightLb, 170);
  assert.deepStrictEqual(p.targets, M.calc.targets(p), "targets always match the calculator");
  /* sex + units segs */
  show(M.ui.views.you());
  click('[data-m="t-sex"][data-v="f"]'); assert.strictEqual(p.sex, "f");
  assert.deepStrictEqual(p.targets, M.calc.targets(p));
  click('[data-m="t-sex"][data-v="m"]');
  show(M.ui.views.you());
  click('[data-m="t-units"][data-v="metric"]'); assert.strictEqual(p.units, "metric");
  html = M.ui.views.you();
  assert.ok(/data-f="hcm" value="183"/.test(html), "cm shown");
  assert.ok(/data-f="weight" value="81\.6"/.test(html), "kg shown");
  assert.ok(/Lose 0\.5 kg a week/.test(html) && /Lose 1 kg a week/.test(html) && /Lose 0\.25 kg a week/.test(html), "pace labels in round kg");
  show(html);
  change('[data-f="weight"]', 80);
  near(p.weightLb, 176.4, 0.1, "kg converted to lb");
  change('[data-f="hcm"]', 180);
  near(p.heightIn, 70.9, 0.1);
  click('[data-m="t-units"][data-v="us"]');
});

t("t-split balanced recomputes; custom needs 100%; t-manual keeps hand-edited targets", () => {
  M.ui.tab = "you";
  M.reset(); M.trends.resetDraft(); toasts.length = 0;
  const p = M.person("nick");
  Object.assign(p, { sex: "m", age: 38, heightIn: 71, weightLb: 185, activity: "moderate", pace: 0 });
  M.calc.applyTargets(p);
  const hp = Object.assign({}, p.targets);
  show(M.ui.views.you());
  click('[data-m="t-split"][data-v="balanced"]');
  assert.strictEqual(p.split, "balanced");
  assert.strictEqual(p.targets.cal, hp.cal, "same kcal");
  assert.strictEqual(p.targets.p, Math.round(hp.cal * 0.3 / 4), "balanced protein = 30%");
  assert.strictEqual(p.targets.c, Math.round(hp.cal * 0.4 / 4));
  assert.notStrictEqual(p.targets.p, hp.p);
  /* custom */
  show(M.ui.views.you());
  click('[data-m="t-split"][data-v="custom"]');
  assert.strictEqual(p.split, "custom");
  let html = M.ui.views.you();
  assert.ok(/data-m="t-custom" data-f="p" value="30"/.test(html), "custom inputs shown");
  assert.ok(/Adds up to 100%/.test(html));
  show(html);
  $('[data-m="t-custom"][data-f="p"]').value = "50";
  change('[data-m="t-custom"][data-f="c"]', 40);
  assert.strictEqual($("#mt-csum").textContent, "Adds up to 120%. It must be 100%.");
  assert.strictEqual($("#mt-capply").disabled, true, "apply disabled at 120%");
  click("#mt-capply");
  assert.deepStrictEqual(p.custom, { p: 30, c: 40, f: 30 }, "not applied");
  change('[data-m="t-custom"][data-f="f"]', 10);
  assert.strictEqual($("#mt-capply").disabled, false);
  click("#mt-capply");
  assert.deepStrictEqual(p.custom, { p: 50, c: 40, f: 10 });
  assert.strictEqual(p.targets.p, Math.round(hp.cal * 0.5 / 4), "custom 50% protein applied");
  /* manual */
  show(M.ui.views.you());
  assert.ok(!/data-m="t-target"/.test(app().innerHTML), "numbers are plain text before manual");
  click('[data-m="t-manual"]');
  assert.strictEqual(p.targetsManual, true);
  html = M.ui.views.you();
  assert.ok(/class="toggle on" data-m="t-manual"/.test(html));
  assert.ok(/data-m="t-target" data-f="cal"/.test(html), "editable inputs in manual mode");
  show(html);
  change('[data-m="t-target"][data-f="cal"]', 2600);
  assert.strictEqual(p.targets.cal, 2600);
  assert.strictEqual(p.targetsManual, true, "still manual after editing");
  /* numbers change must NOT overwrite manual targets */
  show(M.ui.views.you());
  change('[data-m="t-num"][data-f="weight"]', 190);
  assert.strictEqual(p.weightLb, 190);
  assert.strictEqual(p.targets.cal, 2600, "manual targets survive a weight change");
  /* toggle off → back to the calculator */
  show(M.ui.views.you());
  click('[data-m="t-manual"]');
  assert.strictEqual(p.targetsManual, false);
  assert.deepStrictEqual(p.targets, M.calc.targets(p));
  /* manual on: the split options are hidden (a split would undo the typed numbers) */
  p.targetsManual = true; p.targets.cal = 1;
  html = M.ui.views.you();
  assert.ok(!/data-m="t-split"/.test(html) && /to pick a split again/.test(html), "splits hidden while manual");
  /* a split action still leaves manual mode */
  const sb = document.createElement("button"); sb.dataset.m = "t-split"; sb.dataset.v = "highprotein";
  click(sb);
  assert.strictEqual(p.targetsManual, false);
  assert.strictEqual(p.targets.p, 190);
});

/* ======================================================================= */
t("AI card: save / remove key, model select, Test toasts the result", async () => {
  M.ui.tab = "you";
  M.reset(); toasts.length = 0;
  const p = M.person("nick");
  show(M.ui.views.you());
  click('[data-m="t-ai-save"]');
  assert.ok(/Paste your key first/.test(toasts[toasts.length - 1]));
  $("#mt-key").value = " sk-ant-abc ";
  click('[data-m="t-ai-save"]');
  assert.strictEqual(M.ai.getKey(), "sk-ant-abc");
  let html = M.ui.views.you();
  assert.ok(/Key saved on this phone/.test(html) && /data-m="t-ai-remove"/.test(html));
  show(html);
  change('[data-m="t-ai-model"]', "claude-haiku-4-5-20251001");
  assert.strictEqual(p.aiModel, "claude-haiku-4-5-20251001");
  assert.strictEqual(M.ai.model(), "claude-haiku-4-5-20251001");
  /* test button: stub M.ai.test → ok */
  const realTest = M.ai.test;
  M.ai.test = () => Promise.resolve(true);
  toasts.length = 0;
  await click('[data-m="t-ai-test"]');
  assert.ok(/Claude works/.test(toasts[toasts.length - 1]), toasts.join("|"));
  assert.ok(/You're set/.test($("#mt-ai-msg").textContent));
  M.ai.test = () => Promise.reject({ code: "auth", message: "That key was rejected." });
  await click('[data-m="t-ai-test"]');
  assert.ok(/test failed/.test(toasts[toasts.length - 1]));
  assert.strictEqual($("#mt-ai-msg").textContent, "That key was rejected.");
  M.ai.test = realTest;
  click('[data-m="t-ai-remove"]');
  assert.strictEqual(M.ai.getKey(), "");
  assert.ok(/work without a key/.test(M.ui.views.you()));
});

/* ======================================================================= */
t("You form: a field change never re-renders — values and targets patch in place (iPhone keeps the keyboard)", () => {
  M.ui.tab = "you";
  M.reset(); M.trends.resetDraft();
  const p = M.person("nick");
  Object.assign(p, { sex: "m", age: 38, heightIn: 71, weightLb: 185, goalWeightLb: 175, activity: "active", pace: -1 });
  M.calc.applyTargets(p);
  M.checkins.done("nick", "setup");
  show(M.ui.views.you());
  const q = f => $('[data-m="t-num"][data-f="' + f + '"]');
  const weight = q("weight"), goal = q("goal"), age = q("age"), box = $("#mt-tbox");
  assert.ok(box && box.querySelector(".mt-tgrid"), "targets live in #mt-tbox");
  /* the person typed a weight, then tapped Goal: the change event fires while Goal has focus */
  goal.focus();
  assert.strictEqual(document.activeElement, goal);
  const before = renders, oldCal = p.targets.cal;
  NOW += 1000;
  change(weight, 180);
  assert.strictEqual(renders, before, "no re-render");
  assert.strictEqual(q("weight"), weight, "same weight box");
  assert.strictEqual(q("goal"), goal, "same goal box");
  assert.strictEqual(document.activeElement, goal, "focus stays where the person tapped");
  assert.strictEqual($("#mt-tbox"), box, "same targets box");
  assert.ok(p.targets.cal < oldCal && p.targets.p === 180);
  assert.ok(box.innerHTML.indexOf(">" + fmt(p.targets.cal) + '</div><div class="k">Calories</div>') > 0, "calories patched in place");
  assert.ok(/>180<small>g<\/small>/.test(box.innerHTML), "protein patched in place");
  assert.ok(/Last weigh-in Sep 28/.test($("#mt-ci-body").textContent), "check-in line patched");
  assert.strictEqual(p.updatedAt, NOW, "edit time stamped for sync");
  /* cleaned-up values go back into the boxes */
  const age0 = p.age;
  change(age, 150);
  assert.strictEqual(p.age, age0, "a typo age is not saved"); assert.strictEqual(age.value, "150", "the box keeps what was typed");
  assert.ok(!$("#mt-amsg-you").hidden && /Age should be 5 to 120/.test($("#mt-amsg-you").textContent), "message under Age");
  change(age, 41);
  assert.strictEqual(p.age, 41); assert.ok($("#mt-amsg-you").hidden, "message gone once it's right");
  change(weight, "");
  assert.strictEqual(p.weightLb, 180, "blank weight ignored"); assert.strictEqual(weight.value, "180", "box shows the kept weight");
  q("hft").value = "5"; change(q("hin"), 13);
  assert.strictEqual(p.heightIn, 73); assert.strictEqual(q("hft").value, "6"); assert.strictEqual(q("hin").value, "1");
  p.heightIn = 71.6; M.save(); show(M.ui.views.you());
  assert.strictEqual(q("hft").value, "6"); assert.strictEqual(q("hin").value, "0", "71.6 in shows 6 ft 0 in, not 5 ft 12 in");
  /* selects patch too */
  const sel = $('[data-m="t-num"][data-f="activity"]'), cal1 = p.targets.cal;
  change(sel, "light");
  assert.strictEqual(renders, before); assert.strictEqual($('[data-m="t-num"][data-f="activity"]'), sel);
  assert.ok(p.targets.cal < cal1 && $("#mt-tbox").innerHTML.indexOf(fmt(p.targets.cal)) > 0);
  /* incomplete numbers → the note says so, in place */
  change(q("age"), "");
  assert.strictEqual(p.age, 41, "a blank age box keeps the age"); assert.strictEqual(q("age").value, "41");
  p.age = null; M.save(); show(M.ui.views.you());
  assert.ok(/Fill in sex, age, height and weight/.test($("#mt-tbox").innerHTML));
  change(q("age"), 38);
  /* manual targets: the grid holds inputs, so a numbers change leaves it alone */
  click('[data-m="t-manual"]');
  show(M.ui.views.you());
  const tIn = $('[data-m="t-target"][data-f="cal"]');
  tIn.focus();
  const r2 = renders;
  change(q("weight"), 182);
  assert.strictEqual(renders, r2);
  assert.strictEqual($('[data-m="t-target"][data-f="cal"]'), tIn, "manual input untouched");
  assert.strictEqual(document.activeElement, tIn);
  click('[data-m="t-manual"]');
  tIn.blur();
});

t("Sync & backup card: not set up · off · join · on · sync now · restore (two taps) · turn off (two taps)", async () => {
  M.ui.tab = "you";
  M.reset(); M.trends.resetDraft(); toasts.length = 0;
  const p = M.person("nick");
  Object.assign(p, { sex: "m", age: 38, heightIn: 71, weightLb: 185, activity: "moderate", pace: 0 });
  M.calc.applyTargets(p); M.checkins.done("nick", "setup");
  const had = M.cloud;
  try {
    /* m-sync.js not loaded at all */
    delete M.cloud;
    let html = M.ui.views.you();
    assert.ok(/Sync &amp; backup<\/h3>/.test(html) && /Cloud sync isn't set up yet\./.test(html));
    assert.ok(html.indexOf("Sync &amp; backup") < html.indexOf("Person</h3>"), "sits above Person");
    const calls = [];
    const fake = {
      conf: false, st: { on: false, code: "", lastSync: 0, lastError: "", pending: 0, busy: false }, tr: null, joinResult: null, restoreResult: false,
      configured() { return this.conf; }, status() { return Object.assign({}, this.st); },
      create() { calls.push("create"); Object.assign(this.st, { on: true, code: "ABCDEFGHJKLMNPQRSTUV" }); return this.st.code; },
      join(v) { calls.push("join:" + v); return Promise.resolve(this.joinResult); },
      leave() { calls.push("leave"); Object.assign(this.st, { on: false, code: "" }); return true; },
      syncNow() { calls.push("sync"); this.st.lastSync = NOW; return Promise.resolve({ ok: true }); },
      hasTrainingBackup() { calls.push("has"); return Promise.resolve(!!this.tr); },
      restoreTraining() { calls.push("restore"); return Promise.resolve(this.restoreResult); },
      training() { return this.tr; },
      fmtCode(c) { return String(c).replace(/(.{4})(?=.)/g, "$1-"); }
    };
    M.cloud = fake;
    assert.ok(/Cloud sync isn't set up yet\./.test(M.ui.views.you()), "not configured");
    /* off */
    fake.conf = true;
    html = M.ui.views.you(); show(html);
    assert.ok(/Share foods and meals between your phones\. Food logs, weight and workouts are backed up too\./.test(html));
    assert.ok(/Start on one phone\. Then join on the other phone with the code it shows\./.test(html));
    assert.ok($('[data-m="t-sync-on"]') && $('[data-m="t-sync-joinshow"]'));
    assert.strictEqual($("#mt-join").hidden, true, "join box starts hidden");
    click('[data-m="t-sync-joinshow"]');
    assert.strictEqual($("#mt-join").hidden, false);
    assert.strictEqual($("#mt-join-code").getAttribute("autocapitalize"), "characters");
    assert.strictEqual(document.activeElement, $("#mt-join-code"), "keyboard comes up on the code box");
    await click('[data-m="t-sync-join"]');
    assert.ok(/Type the code from the first phone/.test($("#mt-join-msg").textContent) && !$("#mt-join-msg").hidden);
    assert.ok(!calls.some(c => /^join/.test(c)), "empty code → no call");
    fake.joinResult = { ok: false, error: "No one is using that code yet. Check it on the other phone." };
    $("#mt-join-code").value = "abcd-efgh-jklm-npqr-stuv";
    $("#mt-join-code").focus();
    await click('[data-m="t-sync-join"]');
    assert.notStrictEqual(document.activeElement, $("#mt-join-code"), "Join puts the keyboard away (so the re-render isn't held back)");
    assert.ok(calls.indexOf("join:ABCDEFGHJKLMNPQRSTUV") >= 0, "the code is picked out of what was typed");
    assert.strictEqual($("#mt-join-msg").textContent, fake.joinResult.error);
    assert.strictEqual($('[data-m="t-sync-join"]').disabled, false, "button back");
    assert.strictEqual($('[data-m="t-sync-join"]').textContent, "Join");
    assert.strictEqual($("#mt-join-code").value, "ABCD-EFGH-JKLM-NPQR-STUV", "the box shows the code that was used");
    fake.joinResult = { ok: true };
    let r = renders;
    $("#mt-join-code").focus();
    await click('[data-m="t-sync-join"]');
    assert.ok(renders > r && /Joined/.test(toasts[toasts.length - 1]), "joined → re-render");
    fake.leave(); calls.length = 0;
    /* turn on */
    show(M.ui.views.you());
    r = renders;
    click('[data-m="t-sync-on"]');
    assert.ok(calls.indexOf("create") >= 0 && renders > r && /Sync is on/.test(toasts[toasts.length - 1]));
    html = M.ui.views.you(); show(html);
    assert.ok(/ABCD-EFGH-JKLM-NPQR-STUV/.test($("#mt-code").textContent), "code in groups of 4");
    assert.ok(/Now add the other phone/.test(html) && /Type this code:/.test(html), "the steps for the other phone");
    assert.ok(/Not synced yet/.test($("#mt-sync-status").textContent));
    assert.ok(!$('[data-m="t-sync-restore"]'), "no restore without a backup");
    await new Promise(res => setTimeout(res, 5));
    assert.ok(calls.indexOf("has") >= 0, "asked the cloud about a training backup");
    /* sync now → status patched in place */
    const status = $("#mt-sync-status");
    await click('[data-m="t-sync-now"]');
    assert.ok(calls.indexOf("sync") >= 0);
    assert.strictEqual($("#mt-sync-status"), status, "same node");
    assert.strictEqual(status.textContent, "Synced just now");
    assert.ok(status.classList.contains("ok"));
    NOW += 2 * 60e3; M.trends.patchSync();
    assert.strictEqual(status.textContent, "Synced 2 min ago");
    fake.st.lastError = "Can't reach the internet. We'll try again soon."; fake.st.pending = 3;
    M.trends.patchSync();
    assert.ok(status.classList.contains("warn") && /Can't reach the internet\. We'll try again soon\. 3 changes waiting\./.test(status.textContent));
    fake.st.lastError = ""; fake.st.pending = 0;
    /* copy: no clipboard here → the fallback tells what to do */
    await click('[data-m="t-sync-copy"]');
    assert.ok(/Press and hold the code/.test(toasts[toasts.length - 1]));
    /* the cloud has workouts this phone doesn't → the restore part appears in place */
    fake.tr = { pid: "nick", t: NOW - DAY, n: 150, last: NOW - 2 * DAY, same: false, mine: false, missing: 150, held: true, busy: false };
    M.trends.patchSync();
    let rb = $('[data-m="t-sync-restore"]');
    assert.ok(rb, "restore button added");
    assert.ok(/<b>150 workouts<\/b> in the cloud aren't on this phone\./.test($("#mt-restore").innerHTML));
    assert.ok(/Restore brings back \d+ workouts? from the backup\./.test($("#mt-restore").textContent));
    assert.strictEqual($("#mt-restore").previousElementSibling, $("#mt-restore-at"), "in its place");
    assert.ok($("#mt-restore").nextElementSibling.classList.contains("mt-more"), "above More options");
    fake.restoreResult = false;
    click(rb);
    assert.strictEqual(calls.indexOf("restore"), -1, "first tap only arms");
    assert.ok(/Tap again/.test(rb.textContent) && rb.classList.contains("mt-armed"));
    M.trends.patchSync();
    assert.strictEqual($('[data-m="t-sync-restore"]'), rb, "an armed button survives a status patch");
    await click(rb);
    assert.ok(calls.indexOf("restore") >= 0);
    assert.ok(/Couldn't restore/.test(toasts[toasts.length - 1]));
    rb = $('[data-m="t-sync-restore"]');
    assert.strictEqual(rb.textContent, "Restore training backup");
    assert.strictEqual(rb.disabled, false);
    fake.restoreResult = true;
    click(rb); await click(rb);
    assert.ok(/Training restored/.test(toasts[toasts.length - 1]));
    /* mid-workout: can't restore yet */
    fake.tr = Object.assign({}, fake.tr, { busy: true });
    html = M.ui.views.you();
    assert.ok(/data-m="t-sync-restore" disabled/.test(html) && /Finish today's workout first/.test(html));
    fake.tr = { pid: "nick", t: NOW - DAY, n: 4, last: NOW, same: false, mine: false, missing: 1, held: true, busy: false };
    assert.ok(/<b>1 workout<\/b> in the cloud isn't on this phone\./.test(M.ui.views.you()), "singular reads right");
    /* another phone's copy with nothing this phone lacks: still offered, with its date */
    fake.tr = { pid: "nick", t: NOW - DAY, n: 3, last: NOW - DAY, same: false, mine: false, missing: 0, held: false, busy: false };
    html = M.ui.views.you();
    assert.ok(/Training backup: 3 workouts, saved Sep \d+\./.test(html) && /data-m="t-sync-restore"/.test(html));
    /* nothing to get back → no button: this phone's own backup, a copy equal to this phone, an empty one */
    [{ mine: true, same: false }, { mine: false, same: true }, { mine: false, same: false, n: 0 }].forEach(x => {
      fake.tr = Object.assign({ pid: "nick", t: NOW, n: 3, last: NOW, missing: 0, held: false, busy: false }, x);
      assert.ok(!/data-m="t-sync-restore"/.test(M.ui.views.you()), "no restore for " + JSON.stringify(x));
    });
    fake.tr = null;
    /* turn off: two taps */
    show(M.ui.views.you());
    const off = $('[data-m="t-sync-off"]');
    click(off);
    assert.strictEqual(calls.indexOf("leave"), -1, "first tap only arms");
    assert.strictEqual(off.textContent, "Tap again to turn off");
    r = renders;
    click(off);
    assert.ok(calls.indexOf("leave") >= 0 && renders > r);
    assert.ok(/Sync is off/.test(toasts[toasts.length - 1]));
    assert.ok(/Share foods and meals/.test(M.ui.views.you()), "back to the off state");
  } finally {
    if (had) M.cloud = had; else delete M.cloud;
  }
});

t("no person: views and cards degrade, actions never throw", () => {
  global.S.profile = null; M.MS.ui.person = null;
  assert.ok(/Pick a person first/.test(M.ui.views.trends()));
  assert.ok(/Pick a person first/.test(M.ui.views.you()));
  assert.strictEqual(M.ui.bannerHTML(), "");
  const b = document.createElement("button"); b.dataset.m = "x"; b.dataset.v = "you"; b.dataset.f = "weight"; b.value = "1";
  Object.keys(M.ui.actions).filter(n => /^t-/.test(n)).forEach(n => { if (n === "t-ai-test") return; assert.doesNotThrow(() => M.ui.actions[n](b, {}), n); });
  Object.keys(M.ui.changes).filter(n => /^t-/.test(n)).forEach(n => assert.doesNotThrow(() => M.ui.changes[n](b, {}), n));
  Object.keys(M.ui.inputs).filter(n => /^t-/.test(n)).forEach(n => assert.doesNotThrow(() => M.ui.inputs[n](b, {}), n));
  global.S.profile = "nick";
});

/* ======================================================================= */
/* regression tests for the swarm findings (F3) */
const mkBtn = (m, attrs) => { const b = document.createElement("button"); b.dataset.m = m; Object.assign(b.dataset, attrs || {}); return b; };
function setupNick(extra) {
  const p = M.person("nick");
  Object.assign(p, { sex: "m", age: 40, heightIn: 71, weightLb: 185, goalWeightLb: 175, activity: "moderate", pace: 0 }, extra || {});
  M.calc.applyTargets(p); M.checkins.done("nick", "setup");
  return p;
}

t("UIT-01/UIT-17: deleting a typo weigh-in puts weight and targets back; weight and heart rate delete on their own; Show older", () => {
  M.ui.tab = "trends"; M.reset(); M.trends.resetDraft();
  const p = setupNick();
  for (let i = 20; i >= 1; i--) M.body.add({ date: M.addDays(M.today(), -i), w: r1t(185 - i * 0.1), rhr: 60 });
  M.body.add({ date: M.today(), w: 285, rhr: 58 }); M.calc.applyTargets(p);     /* a typo that got through */
  assert.strictEqual(p.weightLb, 285); assert.ok(p.targets.p > 250);
  click(mkBtn("t-log-body"));
  const sb = document.getElementById("sheetB");
  let rows = sb.querySelectorAll(".mt-brow");
  assert.strictEqual(rows.length, 10, "first 10 items");
  assert.ok(/Weight/.test(rows[0].textContent) && /285 lb/.test(rows[0].textContent), "newest weight first");
  assert.ok(/Heart rate/.test(rows[1].textContent) && /58 bpm/.test(rows[1].textContent), "heart rate is its own item");
  const x = rows[0].querySelector('[data-m="t-del-body"]');
  assert.strictEqual(x.getAttribute("aria-label"), "Delete weight 285 lb, Sep 28");
  click(x); click(x);
  assert.strictEqual(p.weightLb, 184.9, "weight is the latest weigh-in left");
  assert.deepStrictEqual(p.targets, M.calc.targets(p), "targets follow the weight again");
  assert.strictEqual(p.targets.p, 185);
  assert.strictEqual(M.MS.body["nick|" + M.today()].rhr, 58, "today's heart rate kept");
  assert.ok(M.MS.body["nick|" + M.today()].w == null);
  /* Show older */
  const more = sb.querySelector('[data-m="t-body-more"]');
  assert.ok(more && /Show older/.test(more.textContent));
  click(more);
  rows = sb.querySelectorAll(".mt-brow");
  assert.strictEqual(rows.length, 40, "20 weights + 20 heart rates");
  /* manual targets are left alone */
  p.targetsManual = true; p.targets.cal = 3000;
  M.body.add({ date: M.today(), w: 186 });
  M.trends.removeBody("nick", M.today(), "w");
  assert.strictEqual(p.targets.cal, 3000, "hand-typed targets stay");
  p.targetsManual = false;
  try { document.activeElement.blur(); } catch (e) {}
});

t("UIT-04: out-of-range numbers are refused; a big jump needs a second tap (Log sheet, 2-week card, You)", () => {
  const base = NOW;
  M.ui.tab = "trends"; M.reset(); M.trends.resetDraft();
  const p = setupNick();
  M.body.add({ date: M.addDays(M.today(), -1), w: 185 });
  click(mkBtn("t-log-body"));
  const sb = document.getElementById("sheetB"), save = sb.querySelector('[data-m="t-save-body"]'), msg = () => $("#mt-body-msg").textContent;
  const set = (w, r) => { sb.querySelector("#mt-w").value = w; sb.querySelector("#mt-rhr").value = r; };
  set("1850", ""); click(save);
  assert.ok(/50 (to|and) 700 lb/.test(msg()) && !M.MS.body["nick|" + M.today()], "1850 lb refused");
  set("0.4", ""); click(save); assert.ok(/50 (to|and) 700 lb/.test(msg()));
  set("", "999"); click(save); assert.ok(/25 (to|and) 220 beats a minute/.test(msg()));
  set("", "5"); click(save); assert.ok(/25 (to|and) 220/.test(msg()) && !M.MS.body["nick|" + M.today()]);
  set("225", ""); click(save);
  assert.ok(/big change from 185 lb/.test(msg()) && /tap Save again/.test(msg()), msg());
  assert.ok(!M.MS.body["nick|" + M.today()], "first tap saves nothing");
  click(save);
  assert.strictEqual(M.MS.body["nick|" + M.today()].w, 225, "second tap saves");
  assert.strictEqual(p.weightLb, 225); assert.deepStrictEqual(p.targets, M.calc.targets(p), "targets follow");
  /* 2-week card */
  NOW += 15 * DAY;
  assert.strictEqual(M.checkins.due("nick"), "body14");
  show(M.ui.bannerHTML());
  const b14 = () => $("#mt-b14-msg").textContent;
  $("#mt-b14-w").value = "900"; click('[data-m="t-save-body14"]');
  assert.ok(/50 (to|and) 700 lb/.test(b14()) && M.checkins.due("nick") === "body14");
  $("#mt-b14-w").value = "150"; click('[data-m="t-save-body14"]');
  assert.ok(/big change from 225 lb/.test(b14()) && M.checkins.due("nick") === "body14", "first tap only warns");
  click('[data-m="t-save-body14"]');
  assert.strictEqual(M.MS.body["nick|" + M.today()].w, 150); assert.strictEqual(M.checkins.due("nick"), null);
  /* You */
  M.ui.tab = "you"; show(M.ui.views.you());
  const wbox = () => $('[data-m="t-num"][data-f="weight"]');
  change(wbox(), 2000);
  assert.ok(/50 (to|and) 700 lb/.test($("#mt-wmsg").textContent) && !$("#mt-wmsg").hidden);
  assert.strictEqual(p.weightLb, 150); assert.strictEqual(wbox().value, "150", "box shows the kept weight");
  change(wbox(), 190);
  assert.strictEqual(p.weightLb, 150, "big jump waits");
  assert.strictEqual(wbox().value, "190", "the box keeps what they typed");
  const sure = $('#mt-wmsg [data-m="t-wsure"]');
  assert.ok(sure && /Save 190 lb/.test(sure.textContent), "a button to confirm");
  click(sure);
  assert.strictEqual(p.weightLb, 190); assert.strictEqual(M.MS.body["nick|" + M.today()].w, 190);
  assert.ok($("#mt-wmsg").hidden);
  /* metric ranges are in kg */
  p.units = "metric"; M.save(); show(M.ui.views.you());
  change(wbox(), 400);
  assert.ok(/23 (to|and) 320 kg/.test($("#mt-wmsg").textContent));
  p.units = "us"; M.save();
  NOW = base;
});

t("UIT-02/UIT-22/UX1-06/UIT-11: setup reads every box on Save, never keeps a stale weight, names + outlines what's missing, cleans values", () => {
  M.ui.tab = "diary"; M.reset(); M.trends.resetDraft(); toasts.length = 0;
  show(M.ui.setupCardHTML());
  click('[data-m="t-setup-seg"][data-f="sex"][data-v="m"]'); show(M.ui.setupCardHTML());
  /* an age typo says so under the box, stays as typed, and is never saved as 120 */
  change('[data-f="age"]', 150);
  assert.strictEqual($('#mt-setup [data-f="age"]').value, "150", "the typo stays in the box");
  assert.ok(!$("#mt-amsg-setup").hidden && /Age should be 5 to 120\./.test($("#mt-amsg-setup").textContent), "the same message You shows");
  assert.strictEqual(M.trends.draft().age, null, "not kept as 120");
  change('[data-f="age"]', 120);
  assert.ok($("#mt-amsg-setup").hidden, "a good age hides the message");
  change('[data-f="hft"]', 5);
  assert.strictEqual($('#mt-setup [data-f="hin"]').value, "", "an empty inches box stays empty (no '0' to type in front of)");
  change('[data-f="hin"]', 11);
  change('[data-f="weight"]', 185);
  change('[data-f="goal"]', 175);
  assert.strictEqual(M.trends.draft().pace, -0.5, "goal below weight → lose ½ lb a week");
  assert.strictEqual($('#mt-setup select[data-f="pace"]').value, "-0.5");
  /* the weight box is emptied (typing only, no change event yet) */
  const w = $('#mt-setup [data-f="weight"]');
  w.value = ""; M.ui.inputs["t-setup"](w);
  assert.strictEqual(M.trends.draft().weightLb, null, "empty box clears the draft value");
  click('[data-m="t-save-setup"]');
  assert.strictEqual(M.person("nick").setupAt, null, "nothing saved");
  assert.ok(/Still need: weight\./.test($("#mt-preview").textContent), $("#mt-preview").textContent);
  assert.ok($('#mt-setup [data-row="weight"]').classList.contains("mt-need") && !$('#mt-setup [data-row="age"]').classList.contains("mt-need"), "only the missing row is outlined");
  assert.ok(/Fill in weight/.test(toasts[toasts.length - 1]));
  /* a value that arrived with no event at all (autofill) is still read */
  w.value = "186";
  click('[data-m="t-save-setup"]');
  const p = M.person("nick");
  assert.ok(p.setupAt); assert.strictEqual(p.weightLb, 186); assert.strictEqual(p.age, 120); assert.strictEqual(p.heightIn, 71); assert.strictEqual(p.pace, -0.5);
  /* several missing → all named */
  M.reset(); M.trends.resetDraft(); show(M.ui.setupCardHTML());
  click('[data-m="t-save-setup"]');
  assert.ok(/Still need: sex, age, height and weight\./.test($("#mt-preview").textContent));
  /* placeholders are hints, Units first (setup and You) */
  const html = M.ui.setupCardHTML();
  assert.ok(/placeholder="e\.g\. 35"/.test(html) && /placeholder="e\.g\. 180"/.test(html) && !/placeholder="35"/.test(html));
  assert.ok(html.indexOf('data-f="units"') < html.indexOf('data-f="sex"'), "Units first in setup");
  const you = M.ui.views.you();
  assert.ok(you.indexOf('data-m="t-units"') < you.indexOf('data-m="t-sex"'), "Units first in You");
  assert.ok(/aria-pressed="true"[^>]*data-m="t-units" data-v="us"/.test(you), "segments say which one is on");
});

t("UIT-03/UIT-24/TRN-18/UIT-05/UIT-06/UIT-10: check-in cards, You edits finish setup and clear the 60-day card, no Switch mid-workout", () => {
  const base = NOW;
  M.reset(); M.trends.resetDraft(); M.setMode("train");
  let h = M.ui.bannerHTML();
  assert.ok(/Set your food targets/.test(h) && /data-m="mode" data-v="macros" data-tab="diary"/.test(h), "Train before setup: a small card into Macros");
  assert.ok(!/btn primary[^"]*" data-m="mode"/.test(h), "a quiet button: the workout stays the main action on Train");
  /* the person fills You instead of the setup card */
  M.ui.tab = "you"; show(M.ui.views.you());
  click('[data-m="t-sex"][data-v="f"]'); show(M.ui.views.you());
  change('[data-m="t-num"][data-f="age"]', 33);
  $('[data-m="t-num"][data-f="hft"]').value = "5"; change('[data-m="t-num"][data-f="hin"]', 6);
  assert.strictEqual(M.person("nick").setupAt, null, "not complete yet");
  change('[data-m="t-num"][data-f="weight"]', 140);
  assert.strictEqual(M.person("nick").setupAt, NOW, "You edits finish setup");
  assert.strictEqual(M.checkins.due("nick"), null);
  assert.ok(/Set today/.test($("#mt-ci-num").textContent));
  /* 61 days later one You edit clears the 60-day card */
  NOW += 61 * DAY; M.body.add({ date: M.today(), w: 140 });
  assert.strictEqual(M.checkins.due("nick"), "refresh60");
  show(M.ui.views.you());
  change('[data-m="t-num"][data-f="activity"]', "light");
  assert.strictEqual(M.checkins.due("nick"), null, "a You edit clears the 60-day card");
  /* Update in the 60-day card lands on Macros → You, from Train too */
  NOW += 61 * DAY; M.body.add({ date: M.today(), w: 140 });
  assert.strictEqual(M.checkins.due("nick"), "refresh60");
  h = M.ui.bannerHTML();
  assert.ok(/Still right\?/.test(h));
  if (typeof M.ui.actions.mode === "function") {
    M.setMode("train"); M.ui.tab = "diary"; show(h);
    click('[data-m="mode"][data-tab="you"]');
    assert.strictEqual(M.mode(), "macros"); assert.strictEqual(M.ui.tab, "you");
  }
  const q = M.person("nick"); q.setupAt = NOW - 20 * DAY; q.lastBody = NOW - 15 * DAY; q.snooze = { refresh60: 0, body14: 0 }; M.save();
  assert.strictEqual(M.checkins.due("nick"), "body14");
  assert.ok(/Time to weigh in/.test(M.ui.bannerHTML()), "2-week card title");
  /* snoozed → You says until when */
  show(M.ui.bannerHTML()); click('[data-m="t-snooze"]');
  assert.ok(/Skipped until/.test(M.ui.views.you()));
  /* Switch hidden while a workout runs */
  global.S.active = { id: "w1" };
  h = M.ui.views.you();
  assert.ok(!/data-a="switch-profile"/.test(h) && /Finish your workout first/.test(h));
  delete global.S.active;
  assert.ok(/data-a="switch-profile"/.test(M.ui.views.you()));
  M.setMode("train");
  NOW = base;
});

t("UIT-08/UIT-09/UIT-12..16/PRF-11/UIT-28: Steady, no −0.0, far estimates hidden, chart window, goal near/far, gaps, years, single day, weekly points, tap readout", () => {
  M.ui.tab = "trends"; M.reset(); M.trends.resetDraft(); M.trends.state.range = 90;
  const p = setupNick({ goalWeightLb: 180 });
  for (let i = 27; i >= 0; i--) M.body.add({ date: M.addDays(M.today(), -i), w: i % 2 ? 185.02 : 184.98 });
  let html = M.ui.views.trends();
  assert.ok(/>Steady<\/div><div class="k">Per week/.test(html), "under 0.1 lb a week → Steady");
  assert.ok(!/−0\.0|\+0\.0/.test(html), "never −0.0");
  assert.ok(!/about \d+ week/.test(html), "no estimate while steady");
  /* 0.15 lb a week with 50 lb to go → no 300-week estimate */
  M.reset(); setupNick({ goalWeightLb: 180 });
  for (let i = 27; i >= 0; i--) M.body.add({ date: M.addDays(M.today(), -i), w: Math.round((230 - (27 - i) * 0.15 / 7) * 100) / 100 });
  html = M.ui.views.trends();
  assert.ok(!/about \d+ week/.test(html), "estimates beyond 2 years are hidden");
  /* x axis starts at the first point when history is shorter than the range */
  M.reset(); setupNick({ goalWeightLb: 170 });
  for (let i = 9; i >= 0; i--) M.body.add({ date: M.addDays(M.today(), -i), w: 185 - i * 0.2 });
  html = M.ui.views.trends();
  assert.ok(/<text x="40" y="174">Sep 19<\/text>/.test(html), "first x label = first weigh-in");
  assert.ok(/<line class="goal"/.test(html) && /Goal 170</.test(html), "goal 15 lb away is on the chart");
  p.goalWeightLb = 140;
  M.person("nick").goalWeightLb = 140; html = M.ui.views.trends();
  assert.ok(!/<line class="goal"/.test(html) && /Goal 140 ↓/.test(html), "far goal: label only");
  /* ticks: at least 3 even for a tight range */
  const tight = M.charts.line([{ date: "2026-09-22", v: 180.25 }, { date: "2026-09-25", v: 180.5 }, { date: "2026-09-28", v: 180.75 }]);
  assert.ok(Array.from(tight.matchAll(/text-anchor="end">([\d.,]+)<\/text>/g)).length >= 3, "3+ y ticks");
  /* the 7-day line breaks on a gap of more than 10 days */
  const gap = [];
  for (let i = 0; i < 10; i++) gap.push({ date: M.addDays("2026-08-01", i), v: 190 - i * 0.1 });
  for (let i = 0; i < 10; i++) gap.push({ date: M.addDays("2026-08-25", i), v: 188 - i * 0.1 });
  const gs = M.charts.line(gap, { avg: M.body.avg7(gap) });
  const d = /<path class="avg" d="([^"]+)"/.exec(gs)[1];
  assert.strictEqual((d.match(/M/g) || []).length, 2, "two pieces");
  /* years on long charts; a single day sits under its point */
  const yrs = M.charts.line([{ date: "2025-06-01", v: 200 }, { date: "2026-09-28", v: 185 }]);
  assert.ok(/>Jun '25</.test(yrs) && />Sep '26</.test(yrs));
  const one = M.charts.line([{ date: "2026-09-28", v: 180 }], { unit: "lb" });
  assert.ok(/<text x="183\.0" y="174" text-anchor="middle">Sep 28<\/text>/.test(one), "single date centered");
  /* more than 90 days: weekly points (the latest stays real) */
  const long = [];
  for (let i = 0; i < 200; i++) long.push({ date: M.addDays("2026-03-13", i), v: 200 - i * 0.05 });
  const ls = M.charts.line(long, { unit: "lb" });
  const n = count(ls, /<circle /g);
  assert.ok(n >= 28 && n <= 32, "about one point per week: " + n);
  assert.strictEqual(count(ls, /class="last"/g), 1);
  assert.strictEqual(count(ls, /<title>/g), 1, "one tooltip, on the latest point");
  assert.ok(/Week of Mar 13: /.test(ls));
  /* tap: the nearest point's date and value */
  show(one);
  const svg = document.querySelector("svg.mt-chart");
  M.charts.tip(svg, 0);
  assert.strictEqual(svg.querySelector(".mt-tip text").textContent, "Sep 28: 180 lb");
  assert.ok(/Tap the chart/.test(svg.getAttribute("aria-label")));
  /* the goal label sits on a plate at the left; a bar chart names its target above the bars (never on a bar) */
  assert.ok(/class="mt-pill gl"><rect x="44\.0"/.test(M.charts.line([{ date: "2026-09-27", v: 180 }, { date: "2026-09-28", v: 179 }], { goal: 175 })));
  const tb = M.charts.bars([{ label: "Mo", v: 2100 }, { label: "Tu", v: 1800 }], { target: 2000, unit: "cal" });
  assert.ok(/<g class="mt-key"><line class="tgt-k" x1="40" x2="58" y1="8" y2="8"\/><text x="64" y="11\.5">Target 2,000 cal<\/text><\/g>/.test(tb), tb);
  const firstTop = +/<path class="bar" d="M[\d.]+ [\d.]+ L[\d.]+ ([\d.]+)/.exec(tb)[1];
  assert.ok(firstTop > 14, "the tallest bar stays below the key band");
  /* heart rate ticks are whole beats */
  const hr = M.charts.line([{ date: "2026-09-20", v: 52 }, { date: "2026-09-28", v: 60 }], { whole: true });
  const ticks = Array.from(hr.matchAll(/text-anchor="end">([\d.,]+)<\/text>/g)).map(m => +m[1]);
  assert.ok(ticks.length >= 3 && ticks.every(v => v === Math.round(v)), "whole ticks: " + ticks);
});

t("UIT-20/UIT-21: a failed Test warns in place (no 'You → AI'); hand-typed targets that don't add up get a hint", async () => {
  M.ui.tab = "you"; M.reset();
  setupNick();
  M.ai.setKey("sk-ant-x");
  show(M.ui.views.you());
  const real = M.ai.test;
  M.ai.test = () => Promise.reject({ code: "auth", message: "Your Anthropic key is wrong. Check it in You → AI." });
  await click('[data-m="t-ai-test"]');
  const st = $("#mt-ai-status");
  assert.ok(st.classList.contains("warn") && /Key saved, but it didn't work\. Your Anthropic key is wrong\./.test(st.textContent), st.textContent);
  assert.ok(!/You → AI/.test(st.textContent + $("#mt-ai-msg").textContent));
  assert.ok(/Key saved, but it didn't work/.test(M.ui.views.you()), "stays until the key changes");
  M.ai.test = () => Promise.resolve(true);
  await click('[data-m="t-ai-test"]');
  assert.ok($("#mt-ai-status").classList.contains("ok") && /Key saved on this phone/.test($("#mt-ai-status").textContent));
  M.ai.test = real; M.ai.setKey("");
  /* manual targets */
  click('[data-m="t-manual"]'); show(M.ui.views.you());
  change('[data-m="t-target"][data-f="cal"]', 2400); change('[data-m="t-target"][data-f="p"]', 200);
  change('[data-m="t-target"][data-f="c"]', 220); change('[data-m="t-target"][data-f="f"]', 70);
  assert.ok(!$("#mt-tnote").classList.contains("mt-warn"), "2,310 is within 5% of 2,400");
  change('[data-m="t-target"][data-f="f"]', 120);
  assert.ok($("#mt-tnote").classList.contains("mt-warn") && /add up to 2,760 cal\. Your calorie target is 2,400/.test($("#mt-tnote").textContent));
  click('[data-m="t-manual"]');
});

t("BES-16/18/19: the code is picked out of pasted text; first / other phone buttons; next step after Turn on; restore toast once", async () => {
  const pc = M.trends.pickCode;
  assert.strictEqual(pc("abcd-efgh-jklm-npqr-stuv"), "ABCDEFGHJKLMNPQRSTUV");
  assert.strictEqual(pc("Here's our Chalk code: ABCD-EFGH-JKLM-NPQR-STUV (keep it)"), "ABCDEFGHJKLMNPQRSTUV");
  assert.strictEqual(pc("send them ABCD EFGH JKLM NPQR STUV"), "ABCDEFGHJKLMNPQRSTUV");
  assert.strictEqual(pc(" abcdefghjklmnpqrstuv "), "ABCDEFGHJKLMNPQRSTUV");
  M.ui.tab = "you"; M.reset(); setupNick();
  const had = M.cloud;
  try {
    const st = { on: false, code: "", lastSync: 0, lastError: "", pending: 0, busy: false };
    M.cloud = { configured: () => true, status: () => Object.assign({}, st), create() { Object.assign(st, { on: true, code: "ABCDEFGHJKLMNPQRSTUV" }); return st.code; }, join: () => Promise.resolve({ ok: false }), leave() { st.on = false; }, fmtCode: c => String(c).replace(/(.{4})(?=.)/g, "$1-"), training: () => null };
    let html = M.ui.views.you();
    assert.ok(/data-m="t-sync-on">First phone: start sync</.test(html) && /data-m="t-sync-joinshow">Other phone: join with code</.test(html));
    assert.ok(!/maxlength/.test(html) && /never use the letters I or O, or the numbers 0 or 1/.test(html));
    show(html);
    click('[data-m="t-sync-on"]');
    html = M.ui.views.you();
    assert.ok(/On the other phone, open Chalk\. Tap <b>Macros<\/b>, then <b>You<\/b>\./.test(html) && /Scroll down to <b>Sync &amp; backup<\/b>\. Tap <b>Other phone: join with code<\/b>\./.test(html), "steps shown after Start");
    assert.ok(html.indexOf("Sync &amp; backup</h3>") < html.indexOf("AI (Claude)</h3>"), "Sync sits above the AI card");
  } finally { if (had) M.cloud = had; else delete M.cloud; }
  localStorage.setItem("chalk.sync.restored", "42"); toasts.length = 0;
  assert.strictEqual(M.trends.restoredNote(), "Training restored: 42 workouts");
  assert.strictEqual(localStorage.getItem("chalk.sync.restored"), null, "flag cleared");
  assert.strictEqual(M.trends.restoredNote(), null, "only once");
  await new Promise(r => setTimeout(r, 950));
  assert.ok(toasts.indexOf("Training restored: 42 workouts") >= 0);
});

t("UIT-01 with F1's M.body.remove (moves weight + targets itself): deleting a heart rate keeps targets on the kept weight; no stray cloud delete", () => {
  M.ui.tab = "trends"; M.reset(); M.trends.resetDraft();
  const p = setupNick();
  M.body.add({ date: M.addDays(M.today(), -3), w: 180 });
  M.body.add({ date: M.today(), w: 190, rhr: 61 }); M.calc.applyTargets(p);
  assert.strictEqual(p.weightLb, 190);
  const real = M.body.remove;
  /* the contract: remove resets weightLb to the latest weigh-in left and re-applies targets */
  M.body.remove = function (date, id) {
    const ok = real.call(M.body, date, id); if (!ok) return ok;
    const q = M.person(id), lw = M.body.latest(id, "w");
    if (lw) { q.weightLb = lw.value; if (!q.targetsManual) M.calc.applyTargets(q); }
    return ok;
  };
  try {
    M.sync.deleted.body.clear();
    assert.ok(M.trends.removeBody("nick", M.today(), "rhr"));
    const rec = M.MS.body["nick|" + M.today()];
    assert.ok(rec && rec.w === 190 && rec.rhr == null, "weight kept, heart rate gone");
    assert.strictEqual(p.weightLb, 190);
    assert.deepStrictEqual(p.targets, M.calc.targets(p), "targets match the kept weight (not the older one)");
    assert.ok(!M.sync.deleted.body.has("nick|" + M.today()), "the day still exists, so it is not sent as a delete");
    assert.ok(M.trends.removeBody("nick", M.today(), "w"));
    assert.strictEqual(p.weightLb, 180); assert.deepStrictEqual(p.targets, M.calc.targets(p));
    assert.ok(M.sync.deleted.body.has("nick|" + M.today()), "a day with nothing left is a real delete");
  } finally { M.body.remove = real; }
});

t("BES/SEC sync card: code hidden behind Show, stuck items said once, off-state note, Undo restore, Change code, Delete cloud copy, Join sync from setup", async () => {
  M.ui.tab = "you"; M.reset(); M.trends.resetDraft(); toasts.length = 0;
  const had = M.cloud, base = NOW;
  NOW += 11 * 60e3;   /* the code made in the test above is no longer new */
  try {
    const calls = [];
    const st = { on: true, code: "ABCDEFGHJKLMNPQRSTUV", lastSync: NOW, lastError: "", pending: 0, stuck: 0, busy: false, note: "" };
    let undo = null, undoOk = true;
    M.cloud = {
      configured: () => true, status: () => Object.assign({}, st), training: () => null,
      fmtCode: c => String(c).replace(/(.{4})(?=.)/g, "$1-"),
      codeMasked: () => (st.code ? st.code.slice(0, 4) + "-••••-••••-••••-••••" : ""),
      create() { Object.assign(st, { on: true, code: "ZZZZYYYYXXXXWWWWVVVV" }); return st.code; },
      join: () => Promise.resolve({ ok: false }), leave() { st.on = false; st.code = ""; },
      undoInfo: () => undo, undoRestore() { calls.push("undo"); return undoOk; },
      changeCode() { calls.push("change"); st.code = "QQQQRRRRSSSSTTTTUUUU"; return Promise.resolve({ ok: true, code: st.code }); },
      deleteCloud() { calls.push("delete"); Object.assign(st, { on: false, code: "", note: "Your cloud copy is deleted. Everything is still on this phone." }); return Promise.resolve({ ok: true }); }
    };
    setupNick();
    show(M.ui.views.you());
    const code = () => $("#mt-code").textContent;
    assert.strictEqual(code(), "ABCD-••••-••••-••••-••••", "hidden at first");
    const sh = $('[data-m="t-sync-show"]');
    assert.ok(sh && sh.textContent === "Show" && sh.getAttribute("aria-pressed") === "false");
    click(sh);
    assert.strictEqual(code(), "ABCD-EFGH-JKLM-NPQR-STUV"); assert.strictEqual(sh.textContent, "Hide");
    click(sh);
    assert.strictEqual(code(), "ABCD-••••-••••-••••-••••");
    /* copy by hand needs the real code on screen */
    await click('[data-m="t-sync-copy"]');
    assert.strictEqual(code(), "ABCD-EFGH-JKLM-NPQR-STUV", "copy fallback shows the code");
    click('[data-m="t-sync-show"]');
    /* stuck items: m-sync's line already counts them */
    Object.assign(st, { lastError: "1 item isn't backed up yet. We'll keep trying.", pending: 1, stuck: 1 });
    M.trends.patchSync();
    assert.strictEqual($("#mt-sync-status").textContent, "1 item isn't backed up yet. We'll keep trying.");
    Object.assign(st, { lastError: "", pending: 0, stuck: 0 });
    /* Undo restore: two taps, refused mid-workout */
    undo = { at: NOW - DAY, n: 12, pid: "nick" };
    show(M.ui.views.you());
    assert.ok(/Undo puts back the 12 workouts this phone had before\./.test($("#mt-undo").textContent));
    const ub = $('[data-m="t-sync-undo"]');
    click(ub); assert.strictEqual(calls.indexOf("undo"), -1, "first tap only arms"); assert.ok(/Tap again/.test(ub.textContent));
    click(ub); assert.ok(calls.indexOf("undo") >= 0 && /Training put back/.test(toasts[toasts.length - 1]));
    global.S.active = { id: "w" };
    assert.ok(/data-m="t-sync-undo" disabled/.test(M.ui.views.you()) && /Finish today's workout first/.test(M.ui.views.you()));
    delete global.S.active;
    undo = { at: NOW, n: 3, pid: "kat" };
    assert.ok(!/t-sync-undo/.test(M.ui.views.you()), "another person's undo isn't offered");
    undo = null;
    /* Change code: two taps, then the new code in full with the next step */
    show(M.ui.views.you());
    const cc = $('[data-m="t-sync-newcode"]');
    click(cc); assert.strictEqual(calls.indexOf("change"), -1);
    await click(cc);
    assert.ok(calls.indexOf("change") >= 0);
    show(M.ui.views.you());
    assert.strictEqual(code(), "QQQQ-RRRR-SSSS-TTTT-UUUU", "the new code shows in full");
    assert.ok(/Now add the other phone/.test($("#mt-sync").textContent), "the steps again, for the new code");
    /* Delete cloud copy: two taps, then the off card says what happened */
    const del = $('[data-m="t-sync-delete"]');
    click(del); assert.strictEqual(calls.indexOf("delete"), -1);
    await click(del);
    assert.ok(calls.indexOf("delete") >= 0 && /Cloud copy deleted/.test(toasts[toasts.length - 1]));
    const off = M.ui.views.you();
    assert.ok(/Your cloud copy is deleted\. Everything is still on this phone\./.test(off) && /First phone: start sync/.test(off));
    /* the other phone turned sync off: the card is drawn again, not just its status line */
    Object.assign(st, { on: true, code: "ABCDEFGHJKLMNPQRSTUV", note: "" });
    show(M.ui.views.you());
    Object.assign(st, { on: false, code: "", note: "Sync is off. The other phone deleted the cloud copy or changed the code. Everything is still on this phone." });
    let r = renders;
    M.trends.patchSync();
    assert.ok(renders > r, "on → off redraws the card");
    /* setup card on a phone with sync off: Join sync first (no note: the "other phone" note opens the code box by itself) */
    st.note = "";
    M.reset(); M.trends.resetDraft();
    let h = M.ui.setupCardHTML();
    assert.ok(/Used Macros on another phone\? Join sync first\./.test(h) && /data-m="t-setup-join"/.test(h));
    M.ui.tab = "diary"; show(h);
    click('[data-m="t-setup-join"]');
    assert.strictEqual(M.ui.tab, "you");
    assert.strictEqual($("#mt-join").hidden, false, "You opens with the code box open");
    assert.strictEqual($('[data-m="t-sync-joinshow"]').hidden, true);
    show(M.ui.views.you());
    assert.strictEqual($("#mt-join").hidden, true, "only once");
    st.on = true; st.code = "ABCDEFGHJKLMNPQRSTUV";
    assert.ok(!/t-setup-join/.test(M.ui.setupCardHTML()), "sync on: no hint");
    /* no codeMasked (older m-sync): the code shows in full, no Show button */
    delete M.cloud.codeMasked; show(M.ui.views.you());
    assert.strictEqual(code(), "ABCD-EFGH-JKLM-NPQR-STUV"); assert.ok(!$('[data-m="t-sync-show"]'));
  } finally { if (had) M.cloud = had; else delete M.cloud; M.ui.tab = "you"; NOW = base; }
});

t("UX2-21: a daily weigh-in moves the targets only on a change of 2 lb or more; a deleted weigh-in still puts them back exactly", () => {
  M.ui.tab = "trends"; M.reset(); M.trends.resetDraft(); closeSheet();
  const p = setupNick();
  const t185 = Object.assign({}, p.targets);
  assert.deepStrictEqual(t185, M.calc.targets(p));
  const weigh = w => { click(mkBtn("t-log-body")); const sb = document.getElementById("sheetB"); sb.querySelector("#mt-w").value = String(w); sb.querySelector("#mt-rhr").value = ""; click(sb.querySelector('[data-m="t-save-body"]')); };
  weigh(185.8);
  assert.strictEqual(p.weightLb, 185.8, "the weight is today's");
  assert.deepStrictEqual(p.targets, t185, "0.8 lb of wobble: same targets");
  assert.ok(M.trends.targetsHold(p));
  NOW += DAY; weigh(183.4);
  assert.deepStrictEqual(p.targets, t185, "1.6 lb under: still the same");
  NOW += DAY; weigh(182.6);
  assert.deepStrictEqual(p.targets, M.calc.targets(p), "2.4 lb under the weight they were set for: they move");
  assert.ok(p.targets.p < t185.p);
  const t1826 = Object.assign({}, p.targets);
  /* the 2-week card follows the same rule */
  NOW += 15 * DAY; assert.strictEqual(M.checkins.due("nick"), "body14");
  show(M.ui.bannerHTML()); $("#mt-b14-w").value = "183.1"; click('[data-m="t-save-body14"]');
  assert.strictEqual(p.weightLb, 183.1); assert.deepStrictEqual(p.targets, t1826, "card: small change keeps them");
  /* deleting a weigh-in is exact again: back to the weight left, targets worked out for it */
  assert.ok(M.trends.removeBody("nick", M.today(), "w"));
  assert.strictEqual(p.weightLb, 182.6); assert.deepStrictEqual(p.targets, M.calc.targets(p));
  /* anything else that changes the numbers still recomputes right away */
  p.activity = "active"; assert.ok(!M.trends.targetsHold(p), "a different activity is not wobble");
  p.activity = "moderate";
  p.targetsManual = true; assert.ok(!M.trends.targetsHold(p), "hand-typed targets are left to the person");
  p.targetsManual = false;
});

t("C3: the other phone changed the code → this phone's card opens the code box (Join is the next step, not a second Start)", () => {
  M.ui.tab = "you"; M.reset(); setupNick();
  const had = M.cloud;
  try {
    const st = { on: false, code: "", lastSync: 0, lastError: "", pending: 0, busy: false, note: "Sync is off. The other phone deleted the cloud copy or changed the code. Everything is still on this phone." };
    M.cloud = { configured: () => true, status: () => Object.assign({}, st), create() { return ""; }, join: () => Promise.resolve({ ok: false }), leave() {}, fmtCode: c => String(c), training: () => null };
    show(M.ui.views.you());
    assert.ok(/The other phone deleted the cloud copy or changed the code/.test(app().textContent), "says why");
    assert.ok(!$("#mt-join").hidden, "code box open");
    assert.ok(!$('[data-m="t-sync-on"]').classList.contains("primary"), "Start is not the main button");
    assert.ok($('[data-m="t-sync-joinshow"]').hidden, "no second 'join' button");
    assert.ok($('[data-m="t-sync-join"]').classList.contains("primary"), "Join is");
    /* this phone deleted the copy itself: starting again is the next step */
    st.note = "Your cloud copy is deleted. Everything is still on this phone.";
    show(M.ui.views.you());
    const same = () => $('[data-m="t-sync-on"]').className === $('[data-m="t-sync-joinshow"]').className;
    assert.ok($("#mt-join").hidden && same() && !$('[data-m="t-sync-on"]').classList.contains("primary"), "own delete: Start and Join look the same (FX-06)");
    st.note = "";
    show(M.ui.views.you());
    assert.ok($("#mt-join").hidden && same(), "plain off: Start and Join look the same");
  } finally { if (had) M.cloud = had; else delete M.cloud; }
});

t("C3: joining on a phone where this person has no numbers yet says setup is next; the code box hint fits", async () => {
  const had = M.cloud;
  try {
    const st = { on: false, code: "", lastSync: 0, lastError: "", pending: 0, busy: false, note: "" };
    M.cloud = { configured: () => true, status: () => Object.assign({}, st), create() { return ""; }, join() { Object.assign(st, { on: true, code: "ABCDEFGHJKLMNPQRSTUV", lastSync: NOW }); return Promise.resolve({ ok: true }); }, leave() { st.on = false; }, fmtCode: c => String(c).replace(/(.{4})(?=.)/g, "$1-"), training: () => null };
    /* first time in Macros: nothing came over, so setup is still due */
    M.ui.tab = "you"; M.reset(); M.trends.resetDraft(); toasts.length = 0;
    show(M.ui.views.you());
    assert.strictEqual($("#mt-join-code").getAttribute("placeholder"), "Type the code");
    $("#mt-join-code").value = "ABCD-EFGH-JKLM-NPQR-STUV";
    await click('[data-m="t-sync-join"]');
    assert.strictEqual(toasts[toasts.length - 1], "Joined. Now tap Diary to set your targets.");
    /* numbers already here (or they came over): the usual words */
    Object.assign(st, { on: false, code: "" });
    M.reset(); setupNick(); toasts.length = 0;
    show(M.ui.views.you());
    $("#mt-join-code").value = "ABCD-EFGH-JKLM-NPQR-STUV";
    await click('[data-m="t-sync-join"]');
    assert.strictEqual(toasts[toasts.length - 1], "Joined. Your data is syncing.");
  } finally { if (had) M.cloud = had; else delete M.cloud; }
});

t("C3: a weigh-in under 2 lb away never nudges the targets (high-protein carbs round both ways); one reading reads plainly", () => {
  M.ui.tab = "trends"; M.reset(); M.trends.resetDraft(); closeSheet();
  [0, -1, -0.5, 0.5].forEach(pace => {
    M.reset();
    const p = setupNick({ pace });
    const t185 = Object.assign({}, p.targets);
    for (let x = 1831; x <= 1869; x++) assert.ok(M.trends.targetsHold(Object.assign({}, p, { weightLb: x / 10, targets: t185 })), "pace " + pace + ": holds at " + x / 10);
    [182.6, 182.9, 187.1, 187.4].forEach(x => assert.ok(!M.trends.targetsHold(Object.assign({}, p, { weightLb: x, targets: t185 })), "pace " + pace + ": moves at " + x));
  });
  /* the case found in the browser: set up at 185 lb, lose 1 lb a week, first weigh-in 184.6 (used to go 2,245 → 2,243) */
  M.reset();
  const p = setupNick({ pace: -1 });
  const t185 = Object.assign({}, p.targets);
  assert.strictEqual(t185.cal, 2245);
  click(mkBtn("t-log-body"));
  const sb = document.getElementById("sheetB");
  sb.querySelector("#mt-w").value = "184.6"; sb.querySelector("#mt-rhr").value = "58";
  click(sb.querySelector('[data-m="t-save-body"]'));
  assert.strictEqual(p.weightLb, 184.6);
  assert.deepStrictEqual(p.targets, t185, "0.4 lb: same targets");
  /* one weigh-in and one heart rate: no "latest 0.0" and no "0 bpm vs average" */
  show(M.ui.views.trends());
  const text = app().textContent.replace(/\s+/g, " ");
  assert.ok(/1 weigh-in/.test(text), "says 1 weigh-in: " + text.slice(0, 200));
  assert.ok(!/latest 0\.0|latest [+−]0\.0/.test(text), "no latest 0.0");
  assert.ok(/—Vs average/.test(text), "vs average is a dash with one reading");
  /* PL-03: a second weigh-in in the week: the tile counts them ("2 weigh-ins"), no "latest −0.4" */
  M.body.add({ date: M.addDays(M.today(), -2), w: 185.4, pid: "nick" });
  show(M.ui.views.trends());
  const text2 = app().textContent.replace(/\s+/g, " ");
  assert.ok(/7-day average\s*2 weigh-ins/i.test(text2), "2 weigh-ins under the 7-day average: " + text2.slice(0, 240));
  assert.ok(!/latest [+−]/.test(text2), "no latest +/− line");
});

t("the weekly rate reads the same in the tile and the goal line (halves round the same way)", () => {
  M.ui.tab = "trends"; M.reset(); M.trends.resetDraft();
  const p = setupNick();
  for (let i = 20; i >= 0; i--) M.body.add({ date: M.addDays(M.today(), -i), w: r1t(190 - (20 - i) * 0.15) });
  const real = M.body.ratePerWeek;
  try {
    [[-1.05, "−1.1", "1.1 lb a week"], [-0.45, "−0.5", "0.5 lb a week"], [-1.04, "−1.0", "1 lb a week"]].forEach(([r, tileTxt, words]) => {
      M.body.ratePerWeek = () => r;
      show(M.ui.views.trends());
      const tile = Array.from(document.querySelectorAll(".mt-card .stat")).find(s => /Per week/i.test(s.textContent));
      assert.ok(tile && tile.querySelector(".v").textContent.indexOf(tileTxt) === 0, r + " tile: " + (tile && tile.textContent));
      assert.ok(document.querySelector(".mt-goalline").textContent.indexOf(words) >= 0, r + " goal line: " + document.querySelector(".mt-goalline").textContent);
      assert.ok(/last 3 weeks/.test(tile.textContent), "says what the rate is over (21 days of weigh-ins): " + tile.textContent);
    });
  } finally { M.body.ratePerWeek = real; }
});

t("Sync flow reads in order: Start → steps + code → join on the other phone → status first; rare actions under More options; short sentences", async () => {
  M.ui.tab = "you"; M.reset(); M.trends.resetDraft(); toasts.length = 0;
  const had = M.cloud, base = NOW;
  NOW += 30 * 60e3;   /* nothing from earlier tests counts as new */
  try {
    const st = { on: false, code: "", lastSync: 0, lastError: "", pending: 0, stuck: 0, busy: false, note: "" };
    let joinOk = true;
    M.cloud = {
      configured: () => true, status: () => Object.assign({}, st), training: () => null,
      fmtCode: c => String(c).replace(/(.{4})(?=.)/g, "$1-"),
      codeMasked: () => (st.code ? st.code.slice(0, 4) + "-••••-••••-••••-••••" : ""),
      create() { Object.assign(st, { on: true, code: "ABCDEFGHJKLMNPQRSTUV" }); return st.code; },
      join(code) { if (joinOk) Object.assign(st, { on: true, code, lastSync: NOW }); return Promise.resolve(joinOk ? { ok: true } : { ok: false, error: "No one is using that code yet. Check it on the other phone." }); },
      leave() { Object.assign(st, { on: false, code: "" }); },
      syncNow: () => Promise.resolve({ ok: true }),
      changeCode: () => Promise.resolve({ ok: true }), deleteCloud: () => Promise.resolve({ ok: true })
    };
    setupNick();
    const card = () => $("#mt-sync");
    const words = () => card().textContent.replace(/\s+/g, " ").trim();
    const before = (a, b) => { const h = card().innerHTML; assert.ok(h.indexOf(a) >= 0 && h.indexOf(b) >= 0 && h.indexOf(a) < h.indexOf(b), a + " comes before " + b); };
    const short = () => Array.prototype.forEach.call(card().querySelectorAll("p,li,label,.lbl,button,summary,.mt-status span"), el =>
      el.textContent.replace(/\s+/g, " ").trim().split(/(?<=[.!?:])\s+/).forEach(x => assert.ok(x.split(" ").length <= 16, "short sentence: " + x)));
    /* 1. off: what it does, then how (first phone / other phone) */
    show(M.ui.views.you());
    before("Share foods and meals", "First phone: start sync");
    before("First phone: start sync", "Other phone: join with code");
    short();
    /* 2. first phone taps Start: the steps for the other phone, then the code in full, then the status */
    click('[data-m="t-sync-on"]'); show(M.ui.views.you());
    before("Now add the other phone", 'id="mt-code"');
    before('id="mt-code"', 'id="mt-sync-status"');
    assert.strictEqual($("#mt-code").textContent, "ABCD-EFGH-JKLM-NPQR-STUV", "in full while it's new");
    assert.ok(/Keep a copy in Notes too\. A new phone needs it to get your data back\./.test(words()));
    assert.strictEqual(document.querySelectorAll("#mt-sync ol li").length, 3, "three steps");
    short();
    /* rare actions are folded away, closed at first, and stay open across a redraw once opened */
    const det = $("#mt-sync details.mt-more");
    assert.ok(det && !det.open, "More options starts closed");
    ["t-sync-off", "t-sync-newcode", "t-sync-delete"].forEach(m => assert.ok(det.querySelector('[data-m="' + m + '"]'), m + " inside More options"));
    assert.ok(/This phone stops syncing\. Nothing is deleted\./.test(det.textContent));
    click('#mt-sync summary[data-m="t-sync-more"]'); show(M.ui.views.you());
    assert.ok($("#mt-sync details.mt-more").open, "stays open after a redraw");
    click('#mt-sync summary[data-m="t-sync-more"]'); $("#mt-sync details.mt-more").open = false; show(M.ui.views.you());
    assert.ok(!$("#mt-sync details.mt-more").open, "closed again");
    /* 3. later (10 minutes on): status first, the code hidden under a label */
    NOW += 11 * 60e3; st.lastSync = NOW; show(M.ui.views.you());
    before('id="mt-sync-status"', 'id="mt-code"');
    assert.ok(!/Now add the other phone/.test(words()));
    assert.ok(/Your sync code/.test(words()) && /Both phones use this code\./.test(words()));
    assert.strictEqual($("#mt-code").textContent, "ABCD-••••-••••-••••-••••");
    assert.strictEqual($("#mt-sync-status").textContent, "Synced just now");
    short();
    /* Change code: the card waits for the new code; the old one is never shown as the one to type */
    let finish = null;
    M.cloud.changeCode = () => new Promise(res => { finish = () => { st.code = "QQQQRRRRSSSSTTTTUUUU"; res({ ok: true }); }; });
    show(M.ui.views.you());
    const cc = $('[data-m="t-sync-newcode"]'); click(cc); const pending = click(cc);
    assert.strictEqual(cc.textContent, "Changing…");
    assert.strictEqual($("#mt-code").textContent, "ABCD-••••-••••-••••-••••", "still hidden while it changes");
    assert.ok(!/Now add the other phone/.test(words()));
    finish(); await pending; show(M.ui.views.you());
    assert.strictEqual($("#mt-code").textContent, "QQQQ-RRRR-SSSS-TTTT-UUUU", "the new code in full");
    assert.ok(/Now add the other phone/.test(words()), "with the steps");
    /* 4. the other phone: join with the code → "This phone is joined", status first */
    click('[data-m="t-sync-off"]'); click('[data-m="t-sync-off"]');
    show(M.ui.views.you());
    assert.strictEqual($('[data-m="t-sync-on"]').className, $('[data-m="t-sync-joinshow"]').className, "Start never outweighs Join (FX-06)");
    click('[data-m="t-sync-joinshow"]');
    assert.ok($('label[for="mt-join-code"]'), "the code box has a label");
    assert.ok(!$('[data-m="t-sync-on"]').classList.contains("primary"), "Join is the one bold button once the code box is open");
    $("#mt-join-code").value = "Here: abcd-efgh-jklm-npqr-stuv";
    await click('[data-m="t-sync-join"]');
    show(M.ui.views.you());
    assert.ok(/This phone is joined\. It now syncs with your other phone\./.test(words()));
    before("This phone is joined", 'id="mt-sync-status"');
    before('id="mt-sync-status"', 'id="mt-code"');
    assert.strictEqual($("#mt-code").textContent, "ABCD-••••-••••-••••-••••", "the joining phone keeps the code hidden");
    short();
    NOW += 11 * 60e3; show(M.ui.views.you());
    assert.ok(!/This phone is joined/.test(words()), "the note goes away later");
  } finally { if (had) M.cloud = had; else delete M.cloud; M.ui.tab = "you"; NOW = base; }
});

/* ======================================================================= */
/* fixer round 4 (F3): TR-01..06, FX-06, K5, CP-08, CP-11, VI-15 */
t("TR-01: You height — a typo or an emptied box never saves broken targets; message under Height; no '0' written back", () => {
  M.ui.tab = "you"; M.reset(); M.trends.resetDraft();
  const p = setupNick(); const t0 = JSON.stringify(p.targets);
  show(M.ui.views.you());
  const q = f => $('[data-m="t-num"][data-f="' + f + '"]');
  change(q("hft"), 55);
  assert.strictEqual(p.heightIn, 71, "55 ft is not saved"); assert.strictEqual(JSON.stringify(p.targets), t0, "targets untouched");
  assert.ok(!$("#mt-hmsg-you").hidden && /Height should be 3 to 9 feet/.test($("#mt-hmsg-you").textContent), "message under Height");
  assert.strictEqual(q("hft").value, "55", "the typo stays in the box to fix");
  change(q("goal"), 172);
  assert.strictEqual(q("hft").value, "55", "another box's change doesn't hide the typo"); assert.ok(!$("#mt-hmsg-you").hidden);
  assert.strictEqual(M.trends.hasDraft(), true, "a typo not saved yet counts as a draft");
  change(q("hft"), 5);
  assert.ok($("#mt-hmsg-you").hidden, "message gone once it's right"); assert.strictEqual(p.heightIn, 71);
  /* emptied feet box, then the inches box changes: ignored, and the feet box stays empty (no "0") */
  q("hft").value = ""; change(q("hin"), 1);
  assert.strictEqual(p.heightIn, 71, "blank feet: height kept"); assert.strictEqual(JSON.stringify(p.targets), t0);
  assert.strictEqual(q("hft").value, "", "nothing written into the emptied box");
  change(q("hft"), "");
  assert.strictEqual(q("hft").value, "", "still empty"); assert.strictEqual(p.heightIn, 71);
  q("hft").value = "5"; change(q("hin"), 11);
  assert.strictEqual(p.heightIn, 71); change(q("hin"), 10); assert.strictEqual(p.heightIn, 70, "a real change saves");
  /* metric: 1.78 (meters typed as cm) */
  p.units = "metric"; M.save(); show(M.ui.views.you());
  const hBefore = p.heightIn, tB = JSON.stringify(p.targets);
  change($('[data-m="t-num"][data-f="hcm"]'), "1.78");
  assert.strictEqual(p.heightIn, hBefore); assert.strictEqual(JSON.stringify(p.targets), tB);
  assert.ok(/Height should be 92 to 274 cm/.test($("#mt-hmsg-you").textContent));
  change($('[data-m="t-num"][data-f="hcm"]'), "180");
  assert.strictEqual(p.heightIn, r1t(180 / 2.54)); assert.ok($("#mt-hmsg-you").hidden);
});

t("TR-02: typed targets — empty keeps the old value; out of range is clamped with a message; 0 calories warns", () => {
  M.ui.tab = "you"; M.reset(); M.trends.resetDraft();
  const p = setupNick();
  show(M.ui.views.you()); click('[data-m="t-manual"]'); show(M.ui.views.you());
  const q = f => $('[data-m="t-target"][data-f="' + f + '"]');
  const cal0 = p.targets.cal;
  change(q("cal"), "");
  assert.strictEqual(p.targets.cal, cal0, "empty box keeps the calories"); assert.strictEqual(q("cal").value, String(cal0), "and shows them again");
  change(q("cal"), "abc");
  assert.strictEqual(p.targets.cal, cal0, "not a number keeps it");
  change(q("p"), 1850);
  assert.strictEqual(p.targets.p, 600, "protein clamped to 600"); assert.strictEqual(q("p").value, "600");
  assert.ok(!$("#mt-tmsg").hidden && /Protein should be 0 to 600 g\. We saved 600\./.test($("#mt-tmsg").textContent));
  change(q("cal"), 300);
  assert.strictEqual(p.targets.cal, 800, "calories at least 800");
  change(q("cal"), 2200); assert.strictEqual(p.targets.cal, 2200); assert.ok($("#mt-tmsg").hidden, "message clears");
  change(q("water"), 900); assert.strictEqual(p.targets.water, 300);
  change(q("fiber"), 250); assert.strictEqual(p.targets.fiber, 100);
  /* an old saved 0 (from before this check) shows as a warning */
  p.targets.cal = 0; M.save(); show(M.ui.views.you());
  assert.ok(/Your calorie target is 0\./.test($("#mt-tnote").textContent) && $("#mt-tnote").classList.contains("mt-warn"));
});

t("TR-03: goal weight is checked in You and setup; setup Save stops on a goal typo", () => {
  M.ui.tab = "you"; M.reset(); M.trends.resetDraft();
  const p = setupNick();
  show(M.ui.views.you());
  const g = () => $('[data-m="t-num"][data-f="goal"]');
  change(g(), 1750);
  assert.strictEqual(p.goalWeightLb, 175, "1750 not saved"); assert.ok(/Goal weight should be 50 to 700 lb/.test($("#mt-gmsg-you").textContent) && !$("#mt-gmsg-you").hidden);
  assert.strictEqual(g().value, "1750", "typo stays in the box");
  change(g(), 172); assert.strictEqual(p.goalWeightLb, 172); assert.ok($("#mt-gmsg-you").hidden);
  change(g(), ""); assert.strictEqual(p.goalWeightLb, null, "an empty goal box clears the goal");
  /* setup */
  M.reset(); M.trends.resetDraft(); M.ui.tab = "diary";
  show(M.ui.setupCardHTML());
  click('[data-m="t-setup-seg"][data-f="sex"][data-v="f"]'); show(M.ui.setupCardHTML());
  const sf = f => $('#mt-setup [data-f="' + f + '"]');
  change(sf("age"), 35); change(sf("hft"), 5); change(sf("hin"), 6); change(sf("weight"), 140);
  change(sf("goal"), "1300");
  assert.ok(/Goal weight should be 50 to 700 lb/.test($("#mt-gmsg-setup").textContent), "said right away");
  click('[data-m="t-save-setup"]');
  assert.ok(!M.person("nick").setupAt, "not saved with a goal typo");
  assert.ok(/Goal weight should be 50 to 700 lb/.test($("#mt-preview").textContent));
  assert.ok($('#mt-setup [data-row="goal"]').classList.contains("mt-need"), "goal row marked");
  sf("goal").value = "130"; click('[data-m="t-save-setup"]');
  assert.ok(M.person("nick").setupAt, "saved once the goal is right"); assert.strictEqual(M.person("nick").goalWeightLb, 130);
  /* setup height out of range says so (not "Still need: height") */
  M.reset(); M.trends.resetDraft(); show(M.ui.setupCardHTML());
  click('[data-m="t-setup-seg"][data-f="sex"][data-v="m"]'); show(M.ui.setupCardHTML());
  change(sf("age"), 40); change(sf("weight"), 185); change(sf("hft"), 55); change(sf("hin"), 0);
  assert.ok(/Height should be 3 to 9 feet/.test($("#mt-hmsg-setup").textContent), "said right away");
  click('[data-m="t-save-setup"]');
  assert.ok(!M.person("nick").setupAt && /Height should be 3 to 9 feet/.test($("#mt-preview").textContent));
});

t("TR-04: You → Check-ins agrees with the Diary card (same clock, calendar days); the card counts the weeks", () => {
  M.ui.tab = "you"; M.reset(); M.trends.resetDraft();
  const base = NOW;
  NOW = new Date(2026, 8, 28, 12, 0, 0).getTime();
  try {
    const p = setupNick();
    p.setupAt = NOW - 70 * DAY; p.lastBody = NOW - 20 * DAY;
    M.body.add({ date: M.addDays(M.today(), -20), w: 185, pid: "nick" }); p.lastBody = NOW - 20 * DAY; M.save();
    show(M.ui.views.you()); click('[data-m="t-reviewed"]');
    assert.strictEqual(M.checkins.due("nick"), "body14");
    show(M.ui.views.you());
    assert.ok(/Due now/.test($("#mt-ci-body").innerHTML), "You says due now, like the Diary: " + $("#mt-ci-body").textContent);
    /* 6 weeks since the last weigh-in: the card says 6, not 2 */
    p.lastBody = NOW - 42 * DAY; M.save();
    assert.ok(/It's been 6 weeks\./.test(M.ui.bannerHTML()), "weeks counted");
    /* not due yet: the next day by the calendar */
    p.lastBody = new Date(2026, 8, 20, 21, 30).getTime(); p.snooze = { refresh60: 0, body14: 0 }; M.save();
    show(M.ui.views.you());
    assert.ok(/Next one Oct 4\./.test($("#mt-ci-body").textContent), $("#mt-ci-body").textContent);
    /* a snooze lasts until the morning of its day, like the Diary card */
    p.lastBody = NOW - 20 * DAY; p.snooze = { refresh60: 0, body14: new Date(2026, 9, 2, 18, 0).getTime() }; M.save();
    show(M.ui.views.you()); assert.ok(/Skipped until Oct 2\./.test($("#mt-ci-body").textContent), $("#mt-ci-body").textContent);
    NOW = new Date(2026, 9, 2, 8, 0).getTime();
    show(M.ui.views.you());
    if (typeof M.checkins.weeksSince === "function") assert.ok(/Due now/.test($("#mt-ci-body").innerHTML), "snooze over on the morning of Oct 2: " + $("#mt-ci-body").textContent);
    NOW = new Date(2026, 8, 28, 12, 0, 0).getTime();
    /* no weigh-in ever: the clock runs from setup */
    M.reset(); const q = setupNick(); q.lastBody = 0; q.setupAt = NOW - 3 * DAY; M.save();
    show(M.ui.views.you());
    assert.ok(/Next one Oct 9\./.test($("#mt-ci-body").textContent), $("#mt-ci-body").textContent);
  } finally { NOW = base; }
});

t("CP-08 + CP-11: before setup, no 'Still right' button; 'Resting heart rate' on the 2-week card", () => {
  M.ui.tab = "you"; M.reset(); M.trends.resetDraft();
  show(M.ui.views.you());
  assert.ok(/Not set yet\. Fill in Your numbers above\./.test($("#mt-ci-num").textContent));
  assert.ok(!$('[data-m="t-reviewed"]'), "no Still right before setup");
  setupNick(); const p = M.person("nick"); p.lastBody = NOW - 15 * DAY; M.save();
  const b = M.ui.bannerHTML();
  assert.ok(/Resting heart rate/.test(b) && !/Heart rate at rest/.test(b));
});

t("TR-05: 'Per week' names the real span of weigh-ins the rate uses (up to 8 weeks)", () => {
  M.ui.tab = "trends"; M.reset();
  setupNick();
  for (let i = 0; i <= 55; i += 7) M.body.add({ date: M.addDays(M.today(), -55 + i), w: 195 - i * 0.25, pid: "nick" });
  M.body.add({ date: M.today(), w: 181, pid: "nick" });
  const html = M.ui.views.trends();
  assert.ok(/last 8 weeks/.test(html), "8 weeks, not 4");
  M.reset(); setupNick();
  M.body.add({ date: M.addDays(M.today(), -20), w: 186, pid: "nick" }); M.body.add({ date: M.today(), w: 185, pid: "nick" });
  assert.ok(/last 3 weeks/.test(M.ui.views.trends()));
});

t("TR-06/WK-09: 7-day card counts the days in the average; today is lighter and 'so far'; 8-week title too", () => {
  M.ui.tab = "trends"; M.reset(); setupNick();
  const add = (d, cal) => M.log.add(d, { slot: "Lunch", name: "X", servings: 1, per: { cal, p: 100, c: 0, f: 0 } });
  add(M.addDays(M.today(), -2), 2000); add(M.addDays(M.today(), -1), 2200); add(M.today(), 300);
  const ws = M.weekSummary("nick", 0);
  const html = M.ui.views.trends();
  assert.ok(new RegExp(">" + ws.avgDays + '<small>of 7</small></div><div class="k">Days logged</div>').test(html));
  assert.strictEqual(ws.avgDays, 2);
  assert.ok(/Today isn't in the average yet\./.test(html));
  assert.strictEqual(count(html, /class="bar sofar"/g), 1, "one lighter bar: today");
  assert.ok(/: 2,100 cal a day \(2 days, not today yet\)/.test(html), "8-week title uses the days in the average");
  /* no today: no note, no lighter bar */
  M.reset(); setupNick(); add(M.addDays(M.today(), -1), 2200);
  const h2 = M.ui.views.trends();
  assert.ok(!/Today isn't in the average/.test(h2) && !/bar sofar/.test(h2));
});

t("VI-15: heart rate chart keeps at least a 12-bpm axis; the 7-day line only where a week has 2+ readings", () => {
  const pts = [{ date: "2026-09-20", v: 60 }, { date: "2026-09-21", v: 64 }, { date: "2026-09-22", v: 61 }];
  const ys = svg => (svg.match(/<text x="\d+(?:\.\d)?" y="[\d.]+" text-anchor="end">(\d+)<\/text>/g) || []).map(s => +s.replace(/.*>(\d+)<.*/, "$1"));
  const a = ys(M.charts.line(pts, { whole: true, minSpan: 12 })), b = ys(M.charts.line(pts, { whole: true }));
  assert.ok(Math.max.apply(null, a) - Math.min.apply(null, a) >= 10, "wide axis: " + a);
  assert.ok(Math.max.apply(null, b) - Math.min.apply(null, b) < Math.max.apply(null, a) - Math.min.apply(null, a), "narrower without minSpan");
  /* readings 2 weeks apart: each 7-day window holds 1 → no average line */
  const sparse = [{ date: "2026-08-31", v: 190 }, { date: "2026-09-14", v: 188 }, { date: "2026-09-28", v: 186 }];
  const avgN = sparse.map(x => ({ date: x.date, v: x.v, n: 1 }));
  assert.ok(!/class="avg"/.test(M.charts.line(sparse, { avg: avgN })), "no line from lone readings");
  M.ui.tab = "trends"; M.reset(); setupNick();
  sparse.forEach(x => M.body.add({ date: M.addDays(M.today(), -M.daysBetween(x.date, "2026-09-28")), rhr: 60, w: x.v, pid: "nick" }));
  assert.ok(!/class="avg"/.test(M.ui.views.trends()), "Trends: no 7-day line for weigh-ins 2 weeks apart");
});

t("FX-06: Start never outweighs Join; an empty phone shows Join first; 'Join another phone's code instead' under More options", async () => {
  M.ui.tab = "you"; M.reset(); M.trends.resetDraft();
  const had = M.cloud;
  try {
    const st = { on: false, code: "", lastSync: 0, lastError: "", pending: 0, busy: false, note: "" };
    let left = 0;
    M.cloud = { configured: () => true, status: () => Object.assign({}, st), create() { st.on = true; st.code = "ABCDEFGHJKLMNPQRSTUV"; return st.code; },
      join: () => Promise.resolve({ ok: true }), leave() { left++; st.on = false; st.code = ""; }, fmtCode: c => String(c).replace(/(.{4})(?=.)/g, "$1-"), training: () => null };
    /* a phone with nothing on it: Join is first and the main button */
    assert.ok(M.trends.phoneEmpty());
    show(M.ui.views.you());
    const btns = [...document.querySelectorAll("#mt-sync .mt-syncbtns .btn")];
    assert.strictEqual(btns[0].dataset.m, "t-sync-joinshow", "Join first"); assert.ok(btns[0].classList.contains("primary") && !btns[1].classList.contains("primary"));
    assert.ok(/New phone\? Tap Other phone: join with code/.test($("#mt-sync").textContent));
    /* a phone with data: same weight */
    setupNick(); show(M.ui.views.you());
    assert.ok(!M.trends.phoneEmpty());
    assert.strictEqual($('[data-m="t-sync-on"]').className, $('[data-m="t-sync-joinshow"]').className);
    /* started by mistake → More options → Join another phone's code instead (two taps) → join row open */
    click('[data-m="t-sync-on"]'); show(M.ui.views.you());
    const rj = $('[data-m="t-sync-rejoin"]');
    assert.ok(rj && /Join another phone's code instead/.test(rj.textContent));
    click(rj); assert.strictEqual(left, 0, "first tap only arms"); assert.strictEqual(rj.textContent, "Tap again to switch");
    click(rj); assert.strictEqual(left, 1, "second tap leaves this code");
    if (!$("#mt-join")) show(M.ui.views.you());   /* the action redraws You with the code box open */
    assert.ok(!$("#mt-join").hidden, "the code box is open"); assert.ok($('[data-m="t-sync-joinshow"]').hidden);
    assert.ok($('[data-m="t-sync-join"]').classList.contains("primary") && !$('[data-m="t-sync-on"]').classList.contains("primary"));
  } finally { if (had) M.cloud = had; else delete M.cloud; }
});

t("K5: M.trends.hasDraft — setup typed but not saved, or a You box typed but not saved; the setup draft survives a reload", () => {
  M.ui.tab = "diary"; M.reset(); M.trends.resetDraft();
  localStorage.removeItem("chalk.macros.setupDraft.nick");
  show(M.ui.setupCardHTML());
  assert.strictEqual(M.trends.hasDraft(), false, "nothing typed yet");
  const sf = f => $('#mt-setup [data-f="' + f + '"]');
  change(sf("age"), 41);
  assert.strictEqual(M.trends.hasDraft(), true, "setup typed");
  change(sf("hft"), 5); change(sf("hin"), 9);
  click('[data-m="t-setup-seg"][data-f="sex"][data-v="f"]');
  const kept = JSON.parse(localStorage.getItem("chalk.macros.setupDraft.nick"));
  assert.ok(kept && kept.age === 41 && kept.heightIn === 69 && kept.sex === "f", "kept on the phone");
  /* "reload": the page's memory is gone, the kept draft comes back into the boxes */
  M.trends.forget();
  show(M.ui.setupCardHTML());
  assert.strictEqual(sf("age").value, "41"); assert.strictEqual(sf("hft").value, "5"); assert.strictEqual(sf("hin").value, "9");
  assert.ok($('[data-m="t-setup-seg"][data-f="sex"][data-v="f"]').classList.contains("on"));
  assert.strictEqual(M.trends.hasDraft(), true);
  /* junk in the kept copy never gets in */
  localStorage.setItem("chalk.macros.setupDraft.nick", JSON.stringify({ pid: "nick", at: NOW, age: "x", heightIn: -4, sex: "q", activity: "__proto__", split: "nope", pace: 9 }));
  M.trends.forget();
  const d = M.trends.draft();
  assert.ok(d.age === null && d.heightIn === null && d.sex === null && d.activity === "moderate" && d.split === "highprotein" && d.pace === 0);
  /* Save clears it */
  M.trends.forget(); localStorage.removeItem("chalk.macros.setupDraft.nick");
  show(M.ui.setupCardHTML());
  click('[data-m="t-setup-seg"][data-f="sex"][data-v="m"]'); show(M.ui.setupCardHTML());
  sf("age").value = "40"; sf("hft").value = "5"; sf("hin").value = "11"; sf("weight").value = "185";
  click('[data-m="t-save-setup"]');
  assert.ok(M.person("nick").setupAt);
  assert.strictEqual(localStorage.getItem("chalk.macros.setupDraft.nick"), null, "cleared on save");
  assert.strictEqual(M.trends.hasDraft(), false);
  /* You: a typed, unsaved box counts; once saved it doesn't */
  M.ui.tab = "you"; show(M.ui.views.you());
  assert.strictEqual(M.trends.hasDraft(), false);
  const age = $('[data-m="t-num"][data-f="age"]');
  age.value = "42";
  assert.strictEqual(M.trends.hasDraft(), true, "typed, not saved");
  change(age, 42);
  assert.strictEqual(M.person("nick").age, 42); assert.strictEqual(M.trends.hasDraft(), false, "saved");
  age.focus(); assert.strictEqual(M.trends.hasDraft(), true, "typing right now"); age.blur();
  assert.strictEqual(M.trends.hasDraft(), false);
});

/* partner check C3 (round 4) */
t("C3: You height — a blank inches box never puts the saved feet back over a typed number; stale messages hide while retyping", () => {
  M.ui.tab = "you"; M.reset(); M.trends.resetDraft();
  const p = setupNick(); const t0 = JSON.stringify(p.targets);
  show(M.ui.views.you());
  const q = f => $('[data-m="t-num"][data-f="' + f + '"]');
  /* 5'11" → 6'0": clear inches, type 6 in feet, leave the box */
  q("hin").value = ""; change(q("hin"), "");
  change(q("hft"), 6);
  assert.strictEqual(q("hft").value, "6", "the typed 6 stays (was put back to 5)");
  assert.strictEqual(q("hin").value, "", "inches still blank");
  assert.strictEqual(p.heightIn, 71, "nothing saved while inches is blank"); assert.strictEqual(JSON.stringify(p.targets), t0);
  assert.strictEqual(M.trends.hasDraft(), true, "typed, not saved yet");
  change(q("hin"), 0);
  assert.strictEqual(p.heightIn, 72, "6 ft 0 in saved (was 5 ft 0 in)");
  /* feet blank, inches changed: the typed inches stay */
  q("hft").value = ""; change(q("hin"), 10);
  assert.strictEqual(q("hin").value, "10", "typed inches kept"); assert.strictEqual(p.heightIn, 72);
  change(q("hft"), 5); assert.strictEqual(p.heightIn, 70);
  /* a typo's message hides while they type again, and comes back if it's still wrong */
  change(q("hft"), 55); assert.ok(!$("#mt-hmsg-you").hidden);
  q("hft").value = "5"; M.ui.inputs["t-num"](q("hft"));
  assert.ok($("#mt-hmsg-you").hidden, "hidden while retyping");
  change(q("hft"), 55); assert.ok(!$("#mt-hmsg-you").hidden, "back on leaving the box with a typo");
  assert.strictEqual(q("hft").value, "55"); assert.strictEqual(p.heightIn, 70);
  change(q("hft"), 5); assert.ok($("#mt-hmsg-you").hidden); assert.strictEqual(p.heightIn, 70);
  change(q("goal"), 1750); assert.ok(!$("#mt-gmsg-you").hidden);
  q("goal").value = "17"; M.ui.inputs["t-num"](q("goal")); assert.ok($("#mt-gmsg-you").hidden, "goal message hides while typing");
  assert.ok($("#mt-hmsg-you").hidden, "other messages untouched");
  change(q("goal"), 170); assert.strictEqual(p.goalWeightLb, 170);
  /* typed targets: the clamp message hides on the next keystroke */
  click('[data-m="t-manual"]'); show(M.ui.views.you());
  const tq = f => $('[data-m="t-target"][data-f="' + f + '"]');
  change(tq("p"), 1850); assert.ok(!$("#mt-tmsg").hidden);
  tq("p").value = "18"; M.ui.inputs["t-target"](tq("p")); assert.ok($("#mt-tmsg").hidden);
  /* setup: the height message hides while typing */
  M.reset(); M.trends.resetDraft(); M.ui.tab = "diary";
  show(M.ui.setupCardHTML());
  const sf = f => $('#mt-setup [data-f="' + f + '"]');
  sf("hin").value = "11"; change(sf("hft"), 55);
  assert.ok(!$("#mt-hmsg-setup").hidden);
  sf("hft").value = "5"; M.ui.inputs["t-setup"](sf("hft"));
  assert.ok($("#mt-hmsg-setup").hidden, "setup message hides while typing");
  change(sf("hft"), 5); assert.ok($("#mt-hmsg-setup").hidden); assert.strictEqual(M.trends.draft().heightIn, 71);
  M.trends.resetDraft();
});

t("C3: K5 setup draft comes back for the right person only, and never over saved numbers", () => {
  const was = global.S.profile;
  M.reset(); M.trends.resetDraft(); M.ui.tab = "diary";
  ["nick", "kat"].forEach(id => localStorage.removeItem("chalk.macros.setupDraft." + id));
  global.S.profile = "nick";
  show(M.ui.setupCardHTML());
  const sf = f => $('#mt-setup [data-f="' + f + '"]');
  change(sf("age"), 41); change(sf("weight"), 185);
  assert.ok(localStorage.getItem("chalk.macros.setupDraft.nick"), "Nick's draft kept");
  /* Katerina on the same phone: an empty setup, and her own key */
  global.S.profile = "kat";
  show(M.ui.setupCardHTML());
  assert.strictEqual(sf("age").value, "", "Nick's age not shown to Katerina"); assert.strictEqual(sf("weight").value, "");
  assert.strictEqual(M.trends.hasDraft(), false, "nothing typed for Katerina");
  change(sf("age"), 35);
  assert.strictEqual(JSON.parse(localStorage.getItem("chalk.macros.setupDraft.kat")).age, 35);
  /* back to Nick (and a reload): his numbers come back */
  global.S.profile = "nick"; M.trends.forget();
  show(M.ui.setupCardHTML());
  assert.strictEqual(sf("age").value, "41"); assert.strictEqual(sf("weight").value, "185");
  /* a copy whose pid doesn't match its key is dropped */
  localStorage.setItem("chalk.macros.setupDraft.kat", JSON.stringify({ pid: "nick", at: M.now(), age: 99 }));
  global.S.profile = "kat"; M.trends.forget(); show(M.ui.setupCardHTML());
  assert.strictEqual(sf("age").value, "", "a mismatched copy is not used");
  assert.strictEqual(localStorage.getItem("chalk.macros.setupDraft.kat"), null, "and it is removed");
  /* numbers arrive from the other phone (sync): the kept draft never replaces them */
  global.S.profile = "nick"; M.trends.forget();
  const p = setupNick({ age: 50, weightLb: 200 });
  M.trends.draft();
  assert.strictEqual(p.age, 50); assert.strictEqual(p.weightLb, 200);
  assert.strictEqual(localStorage.getItem("chalk.macros.setupDraft.nick"), null, "the old draft goes away");
  assert.strictEqual(M.trends.hasDraft(), false);
  global.S.profile = was; M.trends.resetDraft();
});

t("C3: a heart-rate chart never gets 7 crowded y lines (52, 54 … 64); at most 6", () => {
  const today = M.today(), yl = svg => (svg.match(/<line class="g"/g) || []).length;   /* one grid line per y tick */
  /* 57 and 58 bpm two days apart: the 12-bpm axis lands on 50.1 … 64.9 */
  const pts = [{ date: M.addDays(today, -2), v: 58 }, { date: today, v: 57 }];
  const svg = M.charts.line(pts, { avg: [{ date: today, v: 57.5, n: 2 }], minSpan: 12, from: M.addDays(today, -90), to: today, unit: "bpm", label: "Resting heart rate", tone: "mus", whole: true });
  const n = yl(svg);
  assert.ok(n >= 3 && n <= 6, "y lines: " + n);
  assert.ok(!/NaN/.test(svg));
  /* one reading still gets its 3 lines (55, 60, 65) */
  const one = M.charts.line([{ date: today, v: 58 }], { avg: [], minSpan: 12, from: M.addDays(today, -90), to: today, unit: "bpm", whole: true });
  assert.ok(yl(one) >= 3 && yl(one) <= 6); assert.ok(!/NaN/.test(one));
});

t("R5 LK-01: no m-trends.css rule loses a tie to index.html's inline <style> (it loads later) on Trends, You, check-ins, setup, log body", () => {
  const css = fs.readFileSync(path.join(root, "m-trends.css"), "utf8");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const inline = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || "";
  assert.ok(inline.length > 1000, "found Chalk's inline style");
  /* specificity [ids, classes/attrs/pseudo-classes, types/pseudo-elements] */
  const PE = /::?(before|after|placeholder|marker|-webkit-[a-z-]+)(\([^)]*\))?/g;
  const spec = sel => {
    let a = 0, b = 0, c = 0;
    let x = sel.replace(/:not\(([^)]*)\)/g, (m, y) => { const r = spec(y); a += r[0]; b += r[1]; c += r[2]; return ""; });
    x = x.replace(/\[[^\]]*\]/g, () => { b++; return ""; }).replace(PE, () => { c++; return ""; }).replace(/#[\w-]+/g, () => { a++; return ""; }).replace(/\.[\w-]+/g, () => { b++; return ""; }).replace(/:[\w-]+(\([^)]*\))?/g, () => { b++; return ""; });
    c += (x.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
    return [a, b, c];
  };
  const ge = (x, y) => (x[0] - y[0] || x[1] - y[1] || x[2] - y[2]) >= 0;
  const pe = sel => ((sel.match(/::?(before|after|placeholder|marker|-webkit-[a-z-]+)\s*$/) || [""])[0]).replace(/^:+/, "");
  const strip = sel => sel.replace(/::?(before|after|placeholder|marker|-webkit-[a-z-]+)\s*$/, "") || "*";
  /* rules as [selector, {prop: value}], media blocks flattened (every width counts) */
  const rules = text => {
    const out = [];
    text = text.replace(/\/\*[\s\S]*?\*\//g, "");
    const re = /([^{}]+)\{([^{}]*)\}/g; let m;
    while ((m = re.exec(text))) {
      const sel = m[1].replace(/^[\s\S]*@media[^{]*$/, "").replace(/^\s*@media[^{]*\{/, "").trim();
      if (!sel || /^@/.test(sel) || /^(from|to|\d+%)$/.test(sel)) continue;
      const decl = {};
      m[2].split(";").forEach(d => { const i = d.indexOf(":"); if (i > 0 && !/!important/.test(d)) decl[d.slice(0, i).trim()] = d.slice(i + 1).trim(); });
      sel.split(",").map(z => z.trim()).filter(Boolean).forEach(z => out.push([z, decl]));
    }
    return out;
  };
  const mine = rules(css.replace(/@media[^{]*\{/g, "")), theirs = rules(inline.replace(/@media[^{]*\{/g, ""));
  /* the same property through a shorthand counts (padding vs padding-top …) */
  const fam = p => p.replace(/-(top|right|bottom|left)$/, "").replace(/^(margin|padding|border|background|font)-.*$/, "$1");
  const views = [];
  const was = M.mode();
  M.reset(); M.trends.resetDraft(); views.push(M.ui.setupCardHTML());
  M.setMode("train"); views.push(M.ui.bannerHTML());
  const p = setupNick();
  for (let i = 0; i < 9; i++) M.body.add({ date: M.addDays(M.today(), -i), w: 185 - i * 0.2, rhr: 58 + (i % 3), pid: "nick" });
  views.push(M.ui.views.trends(), M.ui.views.you());
  p.targetsManual = true; views.push(M.ui.views.you()); p.targetsManual = false;
  p.lastBody = NOW - 20 * DAY; M.setMode("train"); views.push(M.ui.bannerHTML()); M.setMode("macros"); views.push(M.ui.bannerHTML());
  M.ui.actions["t-log-body"](); views.push(document.getElementById("sheetB").innerHTML);
  /* food yesterday and today: "Today isn't in the average yet." under the 7-day tiles */
  [M.addDays(M.today(), -1), M.today()].forEach(d => M.log.add(d, { slot: "Lunch", name: "Test", servings: 1, per: { cal: 500, p: 40, c: 50, f: 10 } }));
  views.push(M.ui.views.trends());
  /* the sync card while sync is on (code label, status row, More options) */
  const hadC = M.cloud;
  try {
    M.cloud = { configured: () => true, status: () => ({ on: true, code: "ABCDEFGHJKLMNPQRSTUV", lastSync: NOW - 60e3 }), syncNow: () => Promise.resolve({ ok: true }), fmtCode: c => c, codeMasked: () => "", training: () => null, hasTrainingBackup: () => Promise.resolve(false) };
    views.push(M.ui.views.you());
  } finally { if (hadC) M.cloud = hadC; else delete M.cloud; }
  M.setMode(was);
  const box = document.createElement("div"); box.innerHTML = views.join(""); box.id = "app-r5";
  /* #app rules: the test box stands in for #app */
  const q = sel => { try { return box.querySelectorAll(strip(sel).replace(/#app\b/g, "#app-r5")); } catch (e) { return []; } };
  const lost = [];
  mine.forEach(([sel, decl]) => {
    const els = q(sel); if (!els.length) return;
    const sp = spec(sel);
    theirs.forEach(([ts, td]) => {
      if (pe(ts) !== pe(sel) || !ge(spec(ts), sp)) return;
      const props = Object.keys(decl).filter(k => Object.keys(td).some(t2 => fam(t2) === fam(k) && td[t2] !== decl[k]));
      if (!props.length) return;
      if (Array.prototype.some.call(els, el => { try { return el.matches(strip(ts)); } catch (e) { return false; } })) lost.push(sel + " {" + props.join(",") + "} loses to " + ts);
    });
  });
  assert.ok(box.querySelector(".mt-sofarnote") && box.querySelector(".mt-codelbl") && box.querySelector(".mt-thd") && box.querySelector(".mt-b14") && box.querySelector(".mt-date"), "every part was drawn");
  assert.deepStrictEqual(lost, [], "dead rules:\n" + lost.join("\n"));
  /* the header rule the finder named, by selector */
  assert.ok(/\.card\.mt-card \.hd\{align-items:center\}/.test(css));
  assert.ok(!/(^|\n)\.mt-card \.hd\{/.test(css), "the old tie is gone");
});

t("R5 PL-02/LK-04: Trends tiles never cut words at 320-360 px; one-line labels only at 361-380 px", () => {
  const css = fs.readFileSync(path.join(root, "m-trends.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /* every block with this exact query, joined */
  const media = q => { let out = "", i = -1; while ((i = css.indexOf("@media " + q + "{", i + 1)) >= 0) { let d = 0; const j = css.indexOf("{", i); for (let k = j; k < css.length; k++) { if (css[k] === "{") d++; else if (css[k] === "}" && --d === 0) { out += css.slice(j + 1, k); break; } } } return out; };
  const mid = media("(min-width:361px) and (max-width:380px)"), small = media("(max-width:360px)");
  assert.ok(/\.k\{[^}]*white-space:nowrap/.test(mid), "361-380: labels stay on one line");
  assert.ok(small && !/nowrap/.test(small), "≤360: nothing is held on one line");
  assert.ok(/\.mt-sub\{[^}]*white-space:normal/.test(small), "≤360: the small line under a label wraps too");
  assert.ok(/\.v\{[^}]*font-size:22px/.test(small) && /\.stat\{[^}]*padding:9px 7px/.test(small), "≤360: smaller numbers, tighter tiles");
  assert.ok(!/@media \(max-width:380px\)\{[^}]*nowrap/.test(css), "no nowrap rule reaches 320-360 any more");
  /* the line under the label sits at the bottom, so tiles in a row line up when one label wraps */
  assert.ok(/\.mt-card \.stat\{display:flex;flex-direction:column\}/.test(css) && /\.mt-card \.stat \.mt-sub\{margin-top:auto/.test(css));
  /* PL-08 (the Trends part): "so far" over today's bar is 12 px, not 10 */
  assert.ok(/\.mt-chart \.sofar-t\{[^}]*font-size:12px/.test(css));
});

t("R5 P3: macro colors, targets heading, one gold button in Train, left labels, wording, age typo in setup", async () => {
  M.ui.tab = "you"; M.reset(); M.trends.resetDraft(); toasts.length = 0;
  const p = setupNick();
  const css = fs.readFileSync(path.join(root, "m-trends.css"), "utf8");
  /* LK-07: protein / carbs / fat tiles carry the Diary's macro color classes */
  show(M.ui.views.you());
  const cls = f => $('#mt-tbox .stat:nth-child(' + f + ')').className;
  assert.strictEqual(cls(2), "stat pro"); assert.strictEqual(cls(3), "stat carb"); assert.strictEqual(cls(4), "stat fat");
  assert.strictEqual(cls(1), "stat", "calories stay plain");
  M.log.add(M.today(), { slot: "Lunch", name: "Test", servings: 1, per: { cal: 500, p: 40, c: 50, f: 10 } });
  show(M.ui.views.trends());
  const pro = Array.prototype.find.call(document.querySelectorAll(".mt-card .stat"), s => /Protein a day/.test(s.textContent));
  assert.ok(pro && pro.classList.contains("pro"), "Trends: Protein a day in the protein color");
  /* LK-09: a heading over the targets grid; the chosen split's ✓ in the accent color */
  show(M.ui.views.you());
  const hd = $(".mt-thd");
  assert.ok(hd && hd.textContent === "Your daily targets" && hd.nextElementSibling.id === "mt-tbox", "heading right above the grid");
  assert.ok(/\.opt\.mt-opt\.cur \.m\{color:var\(--acc\)\}/.test(css) && /\.mt-card \.mt-thd\{[^}]*border-top:1px solid var\(--line\)/.test(css));
  /* LK-14: typed targets say "Protein (g)"; check-in labels sit at the left */
  p.targetsManual = true; show(M.ui.views.you());
  assert.ok(/Protein \(g\)/.test($("#mt-tbox").textContent) && /Water \(oz\)/.test($("#mt-tbox").textContent) && !/Protein g/.test($("#mt-tbox").textContent));
  /* PL-14: a 0 calorie target */
  p.targets.cal = 0; show(M.ui.views.you());
  assert.ok(/Your calorie target is 0\. Type how many calories you want each day\./.test($("#mt-tnote").textContent));
  p.targetsManual = false; M.calc.applyTargets(p);
  assert.ok(/\.mt-b14 \.lbl,\.mt-form \.lbl\{text-align:left\}/.test(css));
  /* LK-13 + PL-14: in Train the check-in's Save is not a second gold button; Skip reads "Skip for now" */
  p.lastBody = NOW - 20 * DAY;
  M.setMode("train");
  let h = M.ui.bannerHTML();
  assert.ok(/Time to weigh in/.test(h));
  assert.ok(/<button class="btn" data-m="t-save-body14">Save<\/button>/.test(h), "Train: Save is a plain button");
  assert.ok(/<button class="btn ghost" data-m="t-snooze" data-kind="body14" data-days="14">Skip for now<\/button>/.test(h));
  M.setMode("macros");
  h = M.ui.bannerHTML();
  assert.ok(/<button class="btn primary" data-m="t-save-body14">Save<\/button>/.test(h), "Macros: Save is the main button");
  p.lastBody = NOW; p.setupAt = NOW - 61 * DAY;
  M.setMode("train"); h = M.ui.bannerHTML();
  assert.ok(/<button class="btn" data-m="mode" data-v="macros" data-tab="you">Update<\/button>/.test(h), "Train: Update is a plain button");
  assert.ok(/class="btn ghost"[^>]*>Skip for now</.test(h));
  M.setMode("macros"); p.setupAt = NOW;
  /* PL-09: the switch is 44 px tall itself (the track still draws 52 x 32) */
  assert.ok(/#app \.mt-manrow \.toggle\{width:64px;height:44px;border:6px solid transparent;[^}]*background-clip:padding-box/.test(css));
  /* PL-14: Sync now that fails says what to do */
  const had = M.cloud;
  try {
    M.cloud = { configured: () => true, status: () => ({ on: true, code: "ABCDEFGHJKLMNPQRSTUV", lastSync: 0 }), syncNow: () => Promise.resolve({ ok: false }), fmtCode: c => c, codeMasked: () => "", training: () => null, hasTrainingBackup: () => Promise.resolve(false) };
    toasts.length = 0;
    await M.ui.actions["t-sync-now"]({ dataset: {}, disabled: false, textContent: "" });
    assert.strictEqual(toasts[toasts.length - 1], "Couldn't sync. Check your internet, then tap Sync now again.");
    M.cloud.syncNow = () => Promise.reject(new Error("offline"));
    await M.ui.actions["t-sync-now"]({ dataset: {}, disabled: false, textContent: "" });
    assert.strictEqual(toasts[toasts.length - 1], "Couldn't sync. Check your internet, then tap Sync now again.");
    /* CV: the sync gave a reason (a 503 → "The cloud is having trouble…"): the toast says that, like the status line, not "check your internet" */
    M.cloud.syncNow = () => Promise.resolve({ ok: false, error: "The cloud is having trouble. We'll try again soon." });
    await M.ui.actions["t-sync-now"]({ dataset: {}, disabled: false, textContent: "" });
    assert.strictEqual(toasts[toasts.length - 1], "Couldn't sync. The cloud is having trouble. We'll try again soon.");
    M.cloud.syncNow = () => Promise.resolve({ ok: false, error: "  " });
    await M.ui.actions["t-sync-now"]({ dataset: {}, disabled: false, textContent: "" });
    assert.strictEqual(toasts[toasts.length - 1], "Couldn't sync. Check your internet, then tap Sync now again.", "a blank reason: the plain message");
  } finally { if (had) M.cloud = had; else delete M.cloud; }
  /* setup: an age typo is named on Save, outlined, and nothing is saved */
  M.reset(); M.trends.resetDraft(); M.ui.tab = "diary"; show(M.ui.setupCardHTML());
  click('[data-m="t-setup-seg"][data-f="sex"][data-v="m"]'); show(M.ui.setupCardHTML());
  change('[data-f="age"]', 4);
  assert.strictEqual($('#mt-setup [data-f="age"]').value, "4", "4 stays 4 (not 5)");
  assert.ok(/Age should be 5 to 120\./.test($("#mt-amsg-setup").textContent) && !$("#mt-amsg-setup").hidden);
  change('[data-f="hft"]', 5); change('[data-f="hin"]', 10); change('[data-f="weight"]', 170);
  toasts.length = 0;
  click('[data-m="t-save-setup"]');
  assert.strictEqual(M.person("nick").setupAt, null, "nothing saved");
  assert.ok($('#mt-setup [data-row="age"]').classList.contains("mt-need"), "the age row is outlined");
  assert.ok(/Age should be 5 to 120\./.test($("#mt-preview").textContent) && /Age should be 5 to 120\./.test(toasts[toasts.length - 1]));
  assert.ok(!/Still need: age/.test($("#mt-preview").textContent), "a typo, not a missing age");
  change('[data-f="age"]', 44);
  click('[data-m="t-save-setup"]');
  assert.ok(M.person("nick").setupAt, "saved"); assert.strictEqual(M.person("nick").age, 44);
  M.trends.resetDraft();
});

t("CV final check: weigh-in never splits at its hyphen, units stay lowercase, the switch line fits its state, the date box has no iOS chrome", () => {
  M.ui.tab = "you"; M.reset(); M.trends.resetDraft(); toasts.length = 0;
  const p = setupNick();
  const css = fs.readFileSync(path.join(root, "m-trends.css"), "utf8");
  /* 320 px: "Changing it logs today's weigh-" / "in" → the word is held together */
  show(M.ui.views.you());
  const sub = $('[data-row="weight"] .s');
  assert.strictEqual(sub.textContent, "Changing it logs today's weigh-in");
  assert.ok(sub.querySelector(".mt-nb") && sub.querySelector(".mt-nb").textContent === "weigh-in", "weigh-in in a no-wrap span");
  assert.ok(/\.mt-nb\{white-space:nowrap\}/.test(css));
  /* the check-in line and the log sheet line too */
  M.body.add({ date: M.addDays(M.today(), -1), w: 184.2, pid: "nick" }); M.body.add({ date: M.today(), w: 184.0, pid: "nick" });
  show(M.ui.views.you());
  const ci = $("#mt-ci-body");
  assert.ok(/Last weigh-in /.test(ci.textContent) && /<span class="mt-nb">weigh-in<\/span>/.test(ci.innerHTML), "check-in line: " + ci.innerHTML);
  show(M.ui.views.trends());
  const tileSub = Array.prototype.find.call(document.querySelectorAll(".mt-card .stat"), s => /7-day average/i.test(s.textContent)).querySelector(".mt-sub");
  assert.strictEqual(tileSub.textContent, "2 weigh-ins"); assert.ok(tileSub.querySelector(".mt-nb"));
  click('[data-m="t-log-body"]');
  const last = document.querySelector(".mt-last");
  assert.ok(last && /^Last weigh-in: 184 lb, /.test(last.textContent) && last.querySelector(".mt-nb"), "log sheet: " + (last && last.innerHTML));
  try { closeSheet(); } catch (e) {}
  /* typed targets: the unit is its own lowercase span under the uppercase label */
  p.targetsManual = true; show(M.ui.views.you());
  const k = $('#mt-tbox .stat.pro .k');
  assert.strictEqual(k.textContent, "Protein (g)");
  assert.ok(k.querySelector(".mt-lc") && k.querySelector(".mt-lc").textContent === "(g)");
  assert.strictEqual($('#mt-tbox .stat:nth-child(1) .k').innerHTML, "Calories", "no unit, no span");
  assert.ok(/\.mt-card \.stat \.k \.mt-lc\{text-transform:none/.test(css));
  /* the switch's small line says what a tap does from here */
  assert.strictEqual($(".mt-manrow .s").textContent, "Turn off to go back to the calculator.");
  p.targetsManual = false; show(M.ui.views.you());
  assert.strictEqual($(".mt-manrow .s").textContent, "Turn on to type each number yourself.");
  assert.ok(!/\(g\)/.test($("#mt-tbox").textContent), "calculator tiles: unit after the number only");
  /* no food logged this week: the protein tile's "—" stays plain (no blue dash) */
  M.reset(); setupNick(); show(M.ui.views.trends());
  const pro0 = Array.prototype.find.call(document.querySelectorAll(".mt-card .stat"), s => /Protein a day/.test(s.textContent));
  assert.ok(pro0 && /—/.test(pro0.querySelector(".v").textContent) && !pro0.classList.contains("pro"), "empty protein tile: " + (pro0 && pro0.outerHTML));
  /* v17's date box had no iOS chrome (appearance none); keep it with the stronger selector */
  const rule = (css.match(/input\.mini\.mt-date\{[^}]*\}/) || [""])[0];
  assert.ok(/-webkit-appearance:none/.test(rule) && /(^|;|\{)appearance:none/.test(rule), "date rule: " + rule);
});

/* ======================================================================= */
(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log("  ok  " + name); }
    catch (e) { console.log("  FAIL " + name + "\n" + (e && e.stack || e)); process.exitCode = 1; break; }
  }
  console.log("\n" + passed + "/" + tests.length + " test groups passed");
})();
