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
  assert.ok(/Weight<\/h3>/.test(html) && /Resting heart rate<\/h3>/.test(html) && /This week<\/h3>/.test(html) && /Last 8 weeks<\/h3>/.test(html));
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
  assert.ok(/vs 7-day avg/.test(html));
  assert.ok(/Goal <b>175 lb<\/b>/.test(html) && /<b>10\.5 lb<\/b> to lose/.test(html), "goal + distance");
  assert.strictEqual(count(html, /class="last"/g), 2, "one emphasized point on each chart");
  assert.strictEqual(count(html, /<circle /g), 20, "10 weight + 10 rhr points");
  assert.ok(/Goal 175/.test(html), "goal line on chart");
  assert.ok(/Avg of last 7/.test(html));
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
  assert.ok(/lb\/wk/.test(rh), "rate per week shown");
  assert.ok(/wk at −[\d.]+ lb\/wk/.test(rh), "weeks-to-goal estimate");
  /* log sheet */
  click((() => { const b = document.createElement("button"); b.dataset.m = "t-log-body"; return b; })());
  assert.strictEqual(sheetOpen, "Log weight / heart rate");
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
  assert.ok(!M.MS.body["nick|" + date], "second tap deletes");
  assert.strictEqual(document.getElementById("sheetB").querySelectorAll(".mt-brow").length, 10, "list refreshed (still 10 of the remaining)");
  /* empty save toasts, does not throw */
  toasts.length = 0;
  document.getElementById("sheetB").querySelector("#mt-w").value = ""; document.getElementById("sheetB").querySelector("#mt-rhr").value = "";
  click(document.getElementById("sheetB").querySelector('[data-m="t-save-body"]'));
  assert.ok(toasts.length && /weight or heart rate/i.test(toasts[0]));
});

t("views.trends: This week + Last 8 weeks use logged food", () => {
  M.reset();
  const today = M.today();
  M.log.add(today, { slot: "Lunch", name: "Chicken", per: { cal: 600, p: 60, c: 10, f: 20 } });
  M.log.add(M.addDays(today, -1), { slot: "Dinner", name: "Beef", per: { cal: 900, p: 70, c: 40, f: 30 } });
  M.log.add(M.addDays(today, -14), { slot: "Dinner", name: "Old", per: { cal: 1500, p: 100, c: 40, f: 30 } });
  const html = M.ui.views.trends();
  assert.ok(/>2<small>\/ 7<\/small><\/div><div class="k">Logged<\/div><div class="mt-sub">days<\/div>/.test(html), "2 days logged");
  assert.ok(/>750<\/div><div class="k">Avg kcal<\/div><div class="mt-sub">of 2,000<\/div>/.test(html), "avg kcal 750 vs 2000");
  assert.ok(/>65<small>g<\/small><\/div><div class="k">Protein<\/div><div class="mt-sub">of 150 g<\/div>/.test(html), "avg protein");
  assert.ok(count(html, /<path class="bar"/g) >= 3, "this-week bars + week bars");
  assert.ok(/Sep 28: 600 kcal · P 60 g/.test(html), "day title");
  assert.ok(/not logged/.test(html));
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
  Object.keys(M.calc.ACT_LABEL).forEach(k => assert.ok(html.indexOf(M.calc.ACT_LABEL[k]) > 0, "activity label " + k));
  assert.ok(html.indexOf("Lose 1 lb/wk") > 0 && html.indexOf("Maintain") > 0, "pace labels");
  assert.strictEqual(M.checkins.due("nick"), "setup");
  assert.strictEqual(M.ui.bannerHTML(), "", "banner is empty while setup is due (Diary renders the card)");
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
  assert.ok(/kcal \/ day/.test(pv) && /<b>185<\/b>/.test(pv), "preview shows protein 185 g: " + pv);
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
  assert.ok(/Quick check-in/.test(h) && /id="mt-b14-w"/.test(h) && /id="mt-b14-rhr"/.test(h));
  assert.ok(/data-m="t-save-body14"/.test(h) && /data-m="t-snooze" data-kind="body14" data-days="14"/.test(h));
  assert.ok(/class="card mt-card mt-banner"/.test(h), "renders as a Chalk .card (works in Train Today too)");
  /* snooze hides it */
  show(h);
  click('[data-m="t-snooze"]');
  assert.strictEqual(M.ui.bannerHTML(), "", "snoozed");
  NOW = base + 15 * DAY + 14 * DAY + 1000;
  assert.ok(/Quick check-in/.test(M.ui.bannerHTML()), "back after the snooze");
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
  assert.ok(/Enter a weight/.test(toasts[0]));
  assert.ok(/Quick check-in/.test(M.ui.bannerHTML()));
  $("#mt-b14-rhr").value = "57"; click('[data-m="t-save-body14"]');
  assert.strictEqual(M.MS.body["nick|" + M.today()].rhr, 57);
  /* refresh60 wins at 61 days since setup */
  NOW = base + 61 * DAY;
  M.body.add({ date: M.today(), w: 182 }); // body is fresh, so only refresh60 is due
  assert.strictEqual(M.checkins.due("nick"), "refresh60");
  h = M.ui.bannerHTML();
  assert.ok(/60\+ days since you set your numbers/.test(h));
  assert.ok(/data-m="tab" data-v="you"/.test(h), "Update opens You");
  assert.ok(/data-m="t-reviewed"/.test(h) && /data-m="t-snooze" data-kind="refresh60" data-days="7"/.test(h));
  show(h);
  click('[data-m="t-snooze"]');
  assert.strictEqual(M.ui.bannerHTML(), "", "snoozed 7 days");
  NOW += 7 * DAY + 1000;
  assert.ok(/60\+ days/.test(M.ui.bannerHTML()));
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
  assert.ok(/Backup lives in Train → Settings and now includes Macros/.test(html));
  assert.ok(/data-m="t-num" data-f="weight" value="185"/.test(html));
  assert.ok(/data-m="t-num" data-f="hft" value="5"/.test(html) && /data-f="hin" value="11"/.test(html));
  assert.ok(/<option value="active" selected>/.test(html) && /<option value="-1" selected>/.test(html));
  assert.ok(/data-m="t-reviewed"/.test(html) && /data-m="t-log-body"/.test(html));
  assert.ok(/Set Sep 28, 2026 \(0 days ago\)/.test(html));
  assert.ok(/next Oct 12, 2026/.test(html), "2-week status with next-due date");
  assert.ok(/No Claude yet/.test(html) && /id="mt-key"/.test(html) && /data-m="t-ai-save"/.test(html) && !/t-ai-remove/.test(html));
  assert.ok(/<option value="claude-sonnet-5-5" selected>/.test(html) && /claude-haiku-4-5-20251001/.test(html));
  assert.ok(/data-m="t-ai-test"/.test(html) && /key stays on this phone/.test(html));
  assert.ok(/class="opt mt-opt cur" data-m="t-split" data-v="highprotein"/.test(html));
  Object.keys(M.calc.SPLITS).forEach(k => assert.ok(new RegExp('data-m="t-split" data-v="' + k + '"').test(html), "split option " + k));
  assert.ok(/data-m="t-manual"/.test(html));
  assert.ok(new RegExp('>' + p.targets.cal.toLocaleString("en-US") + '<small>kcal</small>').test(html) || new RegExp('>' + p.targets.cal + '<small>kcal</small>').test(html), "targets grid shows cal");
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
  assert.ok(/Lose 0\.45 kg\/wk/.test(html), "pace labels in kg");
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
  assert.strictEqual($("#mt-csum").textContent, "Adds up to 120% — must be 100%");
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
  /* picking a split leaves manual mode too */
  p.targetsManual = true; p.targets.cal = 1;
  show(M.ui.views.you());
  click('[data-m="t-split"][data-v="highprotein"]');
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
  assert.ok(/No Claude yet/.test(M.ui.views.you()));
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
  assert.ok(box.innerHTML.indexOf(">" + fmt(p.targets.cal) + "<small>kcal</small>") > 0, "kcal patched in place");
  assert.ok(/>180<small>g<\/small>/.test(box.innerHTML), "protein patched in place");
  assert.ok(/Last weigh-in Sep 28/.test($("#mt-ci-body").innerHTML), "check-in line patched");
  assert.strictEqual(p.updatedAt, NOW, "edit time stamped for sync");
  /* cleaned-up values go back into the boxes */
  change(age, 150);
  assert.strictEqual(p.age, 120); assert.strictEqual(age.value, "120");
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
  assert.strictEqual(p.age, null);
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
    assert.ok(/Share foods and meals between your phones and keep a backup\./.test(html));
    assert.ok($('[data-m="t-sync-on"]') && $('[data-m="t-sync-joinshow"]'));
    assert.strictEqual($("#mt-join").hidden, true, "join box starts hidden");
    click('[data-m="t-sync-joinshow"]');
    assert.strictEqual($("#mt-join").hidden, false);
    assert.strictEqual($("#mt-join-code").getAttribute("autocapitalize"), "characters");
    assert.strictEqual(document.activeElement, $("#mt-join-code"), "keyboard comes up on the code box");
    await click('[data-m="t-sync-join"]');
    assert.ok(/Type the code from the other phone/.test($("#mt-join-msg").textContent) && !$("#mt-join-msg").hidden);
    assert.ok(!calls.some(c => /^join/.test(c)), "empty code → no call");
    fake.joinResult = { ok: false, error: "No one is using that code yet. Check it on the other phone." };
    $("#mt-join-code").value = "abcd-efgh-jklm-npqr-stuv";
    $("#mt-join-code").focus();
    await click('[data-m="t-sync-join"]');
    assert.notStrictEqual(document.activeElement, $("#mt-join-code"), "Join puts the keyboard away (so the re-render isn't held back)");
    assert.ok(calls.indexOf("join:abcd-efgh-jklm-npqr-stuv") >= 0, "typed code handed over as typed");
    assert.strictEqual($("#mt-join-msg").textContent, fake.joinResult.error);
    assert.strictEqual($('[data-m="t-sync-join"]').disabled, false, "button back");
    assert.strictEqual($('[data-m="t-sync-join"]').textContent, "Join");
    assert.strictEqual($("#mt-join-code").value, "abcd-efgh-jklm-npqr-stuv", "typed code kept");
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
    assert.ok(/Type this code on the other phone/.test(html));
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
    assert.ok(/replaces the training history on this phone/.test($("#mt-restore").textContent));
    assert.strictEqual($("#mt-restore").nextElementSibling, $('[data-m="t-sync-off"]'), "above Turn off");
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
    assert.ok(/Training backup: 3 workouts, saved Sep \d+, 2026\./.test(html) && /data-m="t-sync-restore"/.test(html));
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
(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log("  ok  " + name); }
    catch (e) { console.log("  FAIL " + name + "\n" + (e && e.stack || e)); process.exitCode = 1; break; }
  }
  console.log("\n" + passed + "/" + tests.length + " test groups passed");
})();
