/* node tests/m-ui.test.js — jsdom smoke test for m-ui.js (Diary, Add flow, entry edit, slot menu, meal builder, Foods tab). */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { JSDOM } = require("jsdom");

/* ---- Chalk shell ---- */
const dom = new JSDOM(`<!doctype html><html><head><title>Chalk</title></head><body>
<div class="top"><h1 id="title">Chalk</h1><div class="sub" id="subtitle"></div></div>
<div class="modebar" id="modebar"><button data-m="mode" data-v="train">Train</button><button data-m="mode" data-v="macros">Macros</button></div>
<div id="scroll"><div class="wrap" id="app"></div></div>
<div class="cta" id="cta"></div>
<nav class="tabs" id="tabs"><button data-tab="today" class="on">Today</button><button data-tab="history">History</button><button data-tab="progress">Progress</button><button data-tab="settings">Settings</button></nav>
<div class="sheet-bg" id="sheetBg"></div>
<div class="sheet" id="sheet"><div class="sh"><h3 id="sheetT"></h3><button class="icon" data-a="sheet-close">×</button></div><div class="sb" id="sheetB"></div></div>
<div class="toast" id="toast"></div>
</body></html>`, { url: "https://example.test/", pretendToBeVisual: true, runScripts: "outside-only" });
const w = dom.window;
const ctx = w; /* run the app files inside the jsdom window as their global */

/* ---- minimal Chalk globals ---- */
ctx.S = { profile: "nick" };
ctx.PRESETS = { nick: { name: "Nick" }, kat: { name: "Katerina" } };
ctx.TRAIN_TABS = ctx.document.getElementById("tabs").innerHTML;
ctx.esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
ctx.uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
ctx.openSheet = (title, body) => { const d = ctx.document; d.getElementById("sheetT").textContent = title; d.getElementById("sheetB").innerHTML = body; d.getElementById("sheetBg").classList.add("on"); d.getElementById("sheet").classList.add("on"); };
ctx.closeSheet = () => { const d = ctx.document; d.getElementById("sheet").classList.remove("on"); d.getElementById("sheetBg").classList.remove("on"); };
ctx.toasts = [];
ctx.toast = m => ctx.toasts.push(m);
let renders = 0;
ctx.render = () => { renders++; const M = ctx.M; if (M.mode() === "macros") { M.ui.render(); return; } M.ui.chrome(); ctx.document.getElementById("title").textContent = "Chalk"; ctx.document.getElementById("app").innerHTML = "<div class='card'>train</div>"; };
/* Chalk's own delegation: the sheet × and the backdrop close the sheet */
ctx.document.addEventListener("click", e => { if (e.target.closest && (e.target.closest('[data-a="sheet-close"]') || e.target.id === "sheetBg")) ctx.closeSheet(); });
ctx.localStorage.clear();
/* URL.createObjectURL does not exist in jsdom */
if (!ctx.URL.createObjectURL) { ctx.URL.createObjectURL = () => "blob:x"; ctx.URL.revokeObjectURL = () => {}; }

["m-core.js", "m-data.js", "m-food.js", "m-ui.js"].forEach(f => {
  const code = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  vm.runInContext(code, dom.getInternalVMContext(), { filename: f });
});
const M = ctx.M;
const doc = ctx.document;
const $ = id => doc.getElementById(id);
const q = (sel, root) => (root || doc).querySelector(sel);
const qa = (sel, root) => Array.from((root || doc).querySelectorAll(sel));
const click = el => { assert.ok(el, "element to click exists"); el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true })); };
const input = (el, v) => { assert.ok(el, "input exists"); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); };
const change = (el, v) => { assert.ok(el, "select exists"); el.value = v; el.dispatchEvent(new w.Event("change", { bubbles: true })); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || "") + " expected " + a + " ≈ " + b);
const sheetOn = () => $("sheet").classList.contains("on");

const tests = [];
function t(name, fn) { tests.push({ name, fn }); }
console.log("m-ui.js");

/* ---- setup ---- */
M.reset();
const P = M.person("nick");
Object.assign(P, { sex: "m", age: 40, heightIn: 71, weightLb: 185, goalWeightLb: 175, activity: "moderate", pace: -0.5, setupAt: Date.now(), lastBody: Date.now() });
M.calc.applyTargets(P);
assert.ok(P.targets.cal > 1500, "targets computed");
M.setMode("macros");
M.ui.bind();
M.ui.bind(); /* idempotent */
M.ui.render();

t("namespace: M.ui surface exists and is extensible", () => {
  ["render", "rerender", "chrome", "tabsHTML", "bind", "sheet", "close", "toast", "ring", "bars", "openAdd", "openDetail", "openBuilder"].forEach(k => assert.strictEqual(typeof M.ui[k], "function", "M.ui." + k));
  ["actions", "inputs", "changes", "views"].forEach(k => assert.ok(M.ui[k] && typeof M.ui[k] === "object", "M.ui." + k));
  assert.strictEqual(typeof M.ui.views.diary, "function");
  assert.strictEqual(typeof M.ui.views.foods, "function");
  assert.strictEqual(M.ui.tab, "diary");
  assert.strictEqual(M.ui.date, M.today());
});

t("diary renders title, subtitle, ring, 4 slot cards, CTA, macro tabs", () => {
  assert.strictEqual($("title").textContent, "Macros");
  assert.ok(/Nick · Today/.test($("subtitle").textContent), $("subtitle").textContent);
  assert.ok(q(".m-ring"), "ring svg");
  assert.strictEqual(qa(".m-slot").length, 4);
  assert.deepStrictEqual(qa(".m-slot h3").map(h => h.textContent), ["Breakfast", "Lunch", "Dinner", "Snacks"]);
  assert.ok($("cta").classList.contains("on"));
  assert.ok(q('#cta [data-m="add"]'));
  assert.strictEqual(qa("#tabs [data-mtab]").length, 4);
  assert.ok(q('#tabs [data-mtab="diary"]').classList.contains("on"));
  assert.ok(q('#modebar [data-v="macros"]').classList.contains("on"));
  assert.ok(!q('#modebar [data-v="train"]').classList.contains("on"));
  assert.ok(q(".m-bar.pro") && q(".m-bar.carb") && q(".m-bar.fat"));
});

t("Loading… card for a tab whose view is not defined yet (trends comes from m-trends.js)", () => {
  M.ui.tab = "trends"; M.ui.render();
  assert.ok(/Loading…/.test($("app").textContent));
  M.ui.tab = "diary"; M.ui.render();
});

t("setup card shows only the fallback when the person has no setupAt", () => {
  const p = M.person("kat"); p.setupAt = null;
  ctx.S.profile = "kat"; M.ui.render();
  assert.strictEqual(qa(".m-slot").length, 0);
  assert.ok(q('[data-m="tab"][data-v="you"]'), "fallback button to You");
  assert.ok(!$("cta").classList.contains("on"), "no CTA during setup");
  ctx.S.profile = "nick"; M.ui.render();
  assert.strictEqual(qa(".m-slot").length, 4);
});

t("person picker when no profile", () => {
  ctx.S.profile = null; M.ui.render();
  assert.strictEqual(qa('[data-a="pick-profile"]').length, 2);
  assert.ok(q('[data-a="pick-profile"][data-v="nick"]') && q('[data-a="pick-profile"][data-v="kat"]'));
  ctx.S.profile = "nick"; M.ui.render();
});

let addedEntry = null;
const OZ = 28.349523125;
t("add flow (cook food): Lunch + Add → 'chicken' → Chicken breast → units raw/cooked → 6 oz raw → diary reads raw first", async () => {
  click(q('[data-m="add"][data-slot="Lunch"]'));
  assert.ok(sheetOn(), "sheet open");
  const inp = $("m-search");
  assert.ok(inp, "search input present");
  assert.ok(q('[data-m="add-slot"][data-v="Lunch"]').classList.contains("on"), "Lunch pill selected");
  input(inp, "chicken");
  await sleep(220);
  assert.strictEqual($("m-search"), inp, "search input was not re-rendered");
  const rows = qa('#m-results [data-m="pick"]');
  assert.ok(rows.length > 0, "results");
  click(q('[data-m="add-seg"][data-v="foods"]'));
  const row = qa('#m-results [data-m="pick"]').find(r => /Chicken breast, boneless skinless/.test(r.textContent));
  assert.ok(row, "merged chicken breast row");
  assert.ok(/4 oz raw \(2\.9 oz cooked\)/.test(row.textContent), "search row reads raw first: " + row.textContent);
  click(row);
  const units = qa('[data-m="det-unit"] option').map(o => o.value);
  assert.deepStrictEqual(units, ["oz-raw", "oz-cooked", "g-raw", "g-cooked", "lb-raw", "lb-cooked"]);
  assert.deepStrictEqual(qa('[data-m="det-unit"] option').map(o => o.textContent).slice(0, 4), ["oz raw", "oz cooked", "g raw", "g cooked"]);
  assert.strictEqual(q('[data-m="det-unit"]').value, "oz-raw");
  assert.strictEqual(q('[data-m="det-qty"]').value, "4");
  assert.strictEqual($("m-det-amt").textContent, "4 oz raw (2.9 oz cooked)");
  input(q('[data-m="det-qty"]'), "6");
  assert.strictEqual($("m-det-amt").textContent, "6 oz raw (4.4 oz cooked)", "servings screen reads raw first");
  assert.ok(/204kcal/.test($("m-live").textContent.replace(/\s/g, "")), "6 oz raw = 204 kcal: " + $("m-live").textContent);
  click(q('[data-m="det-step"][data-v="1"]'));
  assert.strictEqual(q('[data-m="det-qty"]').value, "6.5", "oz steps by half");
  click(q('[data-m="det-step"][data-v="-1"]'));
  assert.strictEqual($("m-det-go").textContent, "Add to Lunch");
  click($("m-det-go"));
  assert.ok(!sheetOn(), "sheet closed");
  const lunch = M.log.slotEntries(M.today(), "Lunch");
  assert.strictEqual(lunch.length, 1);
  addedEntry = lunch[0];
  assert.deepStrictEqual([addedEntry.foodId, addedEntry.state, addedEntry.servingLabel, addedEntry.servings], ["g_chicken_breast", "raw", "1 oz raw", 6]);
  assert.strictEqual(addedEntry.cook.word, "raw");
  assert.strictEqual(Object.keys(M.MS.foods).length, 0, "generic food NOT copied into M.foods");
  const drow = q('.m-slot [data-m="entry"][data-id="' + addedEntry.id + '"]');
  assert.ok(/6 oz raw \(4\.4 oz cooked\)/.test(drow.textContent), "diary row: " + drow.textContent);
});

t("entry sheet (cook): oz cooked keeps the amount (6 oz raw → 4.4 oz cooked); 5 oz cooked uses the cooked profile; grams read in grams", () => {
  click(q('[data-m="entry"][data-id="' + addedEntry.id + '"]'));
  assert.strictEqual($("m-det-go").textContent, "Save");
  assert.strictEqual(q('[data-m="det-unit"]').value, "oz-raw");
  assert.strictEqual(q('[data-m="det-qty"]').value, "6");
  change(q('[data-m="det-unit"]'), "oz-cooked");
  assert.strictEqual(q('[data-m="det-qty"]').value, "4.4", "same chicken, cooked weight");
  input(q('[data-m="det-qty"]'), "5");
  assert.strictEqual($("m-det-amt").textContent, "6.9 oz raw (5 oz cooked)");
  click($("m-det-go"));
  let e = M.log.slotEntries(M.today(), "Lunch")[0];
  assert.deepStrictEqual([e.state, e.servingLabel, e.servings], ["cooked", "1 oz cooked", 5]);
  assert.strictEqual(Math.round(M.foodMath.scale(e.per, e.servings).cal), Math.round(5 * OZ * 1.65), "cooked profile: 165 kcal / 100 g");
  assert.ok(/6\.9 oz raw \(5 oz cooked\)/.test(q('[data-m="entry"][data-id="' + e.id + '"]').textContent));
  /* by grams */
  click(q('[data-m="entry"][data-id="' + e.id + '"]'));
  change(q('[data-m="det-unit"]'), "g-cooked");
  assert.strictEqual(q('[data-m="det-qty"]').value, "142", "5 oz = 142 g");
  input(q('[data-m="det-qty"]'), "150");
  click($("m-det-go"));
  e = M.log.slotEntries(M.today(), "Lunch")[0];
  assert.ok(/207 g raw \(150 g cooked\)/.test(q('[data-m="entry"][data-id="' + e.id + '"]').textContent), q('[data-m="entry"]').textContent);
  /* back to 6 oz raw for the tests below */
  click(q('[data-m="entry"][data-id="' + e.id + '"]'));
  change(q('[data-m="det-unit"]'), "oz-raw");
  input(q('[data-m="det-qty"]'), "6");
  click($("m-det-go"));
  assert.strictEqual(M.log.slotEntries(M.today(), "Lunch")[0].servingLabel, "1 oz raw");
});

t("plain food: servings 2 → totals doubled; grams unit converts", async () => {
  click(q('[data-m="add"][data-slot="Snacks"]'));
  input($("m-search"), "greek yogurt nonfat");
  await sleep(220);
  click(q('[data-m="add-seg"][data-v="foods"]'));
  const row = qa('#m-results [data-m="pick"]').find(r => /Greek yogurt, plain nonfat/.test(r.textContent));
  click(row);
  assert.ok(qa('[data-m="det-unit"] option').map(o => o.value).includes("g"), "g unit offered");
  assert.ok(!$("m-det-amt"), "no raw/cooked line for plain foods");
  click($("m-det-go"));
  const y = M.log.slotEntries(M.today(), "Snacks")[0];
  const before = M.log.slotTotals(M.today(), "Snacks");
  click(q('[data-m="entry"][data-id="' + y.id + '"]'));
  assert.ok(q('[data-m="det-move"]') && q('[data-m="det-del"]'), "Move/Delete");
  assert.ok(!q('[data-m="det-savefood"]'), "no Save as food for a foodId entry");
  input(q('[data-m="det-qty"]'), "2");
  click($("m-det-go"));
  const after = M.log.slotTotals(M.today(), "Snacks");
  assert.strictEqual(Math.round(after.cal), Math.round(before.cal * 2), "cal doubled");
  assert.strictEqual(Math.round(after.p), Math.round(before.p * 2), "protein doubled");
  click(q('[data-m="entry"][data-id="' + y.id + '"]'));
  change(q('[data-m="det-unit"]'), "g");
  input(q('[data-m="det-qty"]'), "100");
  click($("m-det-go"));
  const e = M.log.slotEntries(M.today(), "Snacks")[0];
  assert.strictEqual(e.servingLabel, "1 g");
  assert.strictEqual(e.servings, 100);
  assert.strictEqual(Math.round(M.foodMath.scale(e.per, e.servings).cal), Math.round(M.foods.get(e.foodId).per100g.cal), "100 g = per100g");
  M.log.remove(M.today(), y.id); M.ui.render();
});

t("entry sheet: move to Dinner and back, delete needs two taps", () => {
  click(q('[data-m="entry"][data-id="' + addedEntry.id + '"]'));
  click(q('[data-m="det-move"]'));
  click(q('[data-m="det-moveto"][data-v="Dinner"]'));
  assert.strictEqual(M.log.slotEntries(M.today(), "Dinner").length, 1);
  assert.strictEqual(M.log.slotEntries(M.today(), "Lunch").length, 0);
  M.log.move(M.today(), addedEntry.id, "Lunch"); M.ui.render();
  click(q('[data-m="entry"][data-id="' + addedEntry.id + '"]'));
  click(q('[data-m="det-del"]'));
  assert.ok(sheetOn(), "first tap only arms");
  assert.ok(/Tap again/.test(q('[data-m="det-del"]').textContent));
  assert.strictEqual(M.log.slotEntries(M.today(), "Lunch").length, 1);
  M.ui.close();
});

t("slot menu → Save Lunch as meal → builder prefilled → Save → M.meals.list('Lunch') has 1", () => {
  click(q('[data-m="slot-menu"][data-slot="Lunch"]'));
  assert.ok(sheetOn());
  assert.ok(q('[data-m="slot-copy"]') && q('[data-m="slot-savemeal"]') && q('[data-m="slot-clear"]'));
  click(q('[data-m="slot-savemeal"]'));
  assert.strictEqual($("sheetT").textContent, "New meal");
  assert.ok(M.ui.draft && M.ui.draft.items.length === 1, "draft prefilled");
  assert.strictEqual(M.ui.draft.items[0].state, "raw", "meal item keeps which weight was logged");
  assert.ok(/6 oz raw \(4\.4 oz cooked\)/.test(q('[data-m="mb-item"]').textContent), "builder item reads raw first");
  assert.strictEqual(q('[data-m="mb"][data-k="slot"]').value, "Lunch");
  assert.ok(/kcal/.test($("m-mb-live").textContent), "live per-serving totals");
  click(q('[data-m="mb-save"]'));
  assert.ok(sheetOn(), "needs a name first");
  input(q('[data-m="mb"][data-k="name"]'), "Chicken lunch");
  input(q('[data-m="mb"][data-k="desc"]'), "Just chicken.");
  click(q('[data-m="mb-save"]'));
  assert.ok(!sheetOn());
  const meals = M.meals.list("Lunch");
  assert.strictEqual(meals.length, 1);
  assert.strictEqual(meals[0].name, "Chicken lunch");
  assert.strictEqual(meals[0].slot, "Lunch");
  assert.strictEqual(M.ui.draft, null);
});

t("slot menu: Clear needs two taps, Copy yesterday works", () => {
  click(q('[data-m="slot-menu"][data-slot="Lunch"]'));
  click(q('[data-m="slot-clear"]'));
  assert.strictEqual(M.log.slotEntries(M.today(), "Lunch").length, 1, "armed only");
  click(q('[data-m="slot-clear"]'));
  assert.strictEqual(M.log.slotEntries(M.today(), "Lunch").length, 0, "cleared");
  M.log.add(M.addDays(M.today(), -1), { slot: "Breakfast", name: "Oats", servings: 1, servingLabel: "1 cup", per: { cal: 300, p: 10, c: 54, f: 5 } });
  click(q('[data-m="slot-menu"][data-slot="Breakfast"]'));
  click(q('[data-m="slot-copy"]'));
  assert.strictEqual(M.log.slotEntries(M.today(), "Breakfast").length, 1);
  assert.strictEqual(M.log.slotEntries(M.today(), "Breakfast")[0].name, "Oats");
});

t("Foods tab renders the meal under Lunch; meal sheet logs to today", () => {
  click(q('#tabs [data-mtab="foods"]') /* tabs listener is Chalk's; drive via action */);
  M.ui.tab = "foods"; M.ui.render();
  assert.ok(q('[data-m="foods-seg"][data-v="meals"]').classList.contains("on"));
  const secs = qa("h2.sec").map(h => h.textContent);
  assert.deepStrictEqual(secs, ["Lunch"]);
  const row = q('[data-m="meal"]');
  assert.ok(/Chicken lunch/.test(row.textContent) && /Just chicken\./.test(row.textContent) && /per serving/.test(row.textContent));
  click(row);
  assert.ok(sheetOn());
  assert.ok(q('[data-m="meal-edit"]') && q('[data-m="meal-dup"]') && q('[data-m="meal-del"]'));
  change(q('[data-m="meal-slot"]'), "Dinner");
  click(q('[data-m="meal-step"][data-v="1"]'));
  assert.strictEqual(q('[data-m="meal-qty"]').value, "1.25");
  click(q('[data-m="meal-log"]'));
  const din = M.log.slotEntries(M.today(), "Dinner");
  assert.strictEqual(din.length, 1);
  assert.ok(din[0].mealId, "entry references the meal");
  assert.strictEqual(din[0].servings, 1.25);
  /* search filter */
  input(q('[data-m="foods-q"]'), "zzz");
  return sleep(150).then(() => { assert.ok(/No meals match/.test($("m-foods-list").textContent)); input(q('[data-m="foods-q"]'), ""); return sleep(150); });
});

t("Foods tab: My foods form saves and deletes", () => {
  click(q('[data-m="foods-seg"][data-v="foods"]'));
  assert.ok(/No saved foods yet/.test($("app").textContent));
  click(q('[data-m="food-new"]'));
  assert.ok(sheetOn());
  input(q('[data-m="ff"][data-k="name"]'), "Test bar");
  input(q('[data-m="ff"][data-k="brand"]'), "Kirkland");
  input(q('[data-m="ff"][data-k="qty"]'), "1"); input(q('[data-m="ff"][data-k="unit"]'), "bar"); input(q('[data-m="ff"][data-k="g"]'), "60");
  input(q('[data-m="ff"][data-k="cal"]'), "190"); input(q('[data-m="ff"][data-k="p"]'), "21"); input(q('[data-m="ff"][data-k="c"]'), "22"); input(q('[data-m="ff"][data-k="f"]'), "7");
  input(q('[data-m="ff"][data-k="barcode"]'), "0096619 123456");
  click(q('[data-m="ff-save"]'));
  const f = M.foods.list()[0];
  assert.ok(f && f.name === "Test bar" && f.brand === "Kirkland" && f.per.cal === 190 && f.serving.g === 60 && f.barcode === "0096619123456", JSON.stringify(f));
  assert.ok(f.per100g && Math.round(f.per100g.cal) === 317, "per100g derived");
  assert.ok(q('[data-m="food"]'), "food row rendered");
  click(q('[data-m="food"]'));
  assert.strictEqual(q('[data-m="ff"][data-k="name"]').value, "Test bar");
  click(q('[data-m="ff-del"]')); click(q('[data-m="ff-del"]'));
  assert.strictEqual(M.foods.list().length, 0);
});

t("meal builder: + Add item goes through the add flow in pick mode and returns", async () => {
  click(q('[data-m="foods-seg"][data-v="meals"]'));
  click(q('[data-m="meal-new"]'));
  assert.strictEqual($("sheetT").textContent, "New meal");
  input(q('[data-m="mb"][data-k="name"]'), "Egg plate");
  click(q('[data-m="mb-add"]'));
  assert.strictEqual($("sheetT").textContent, "Add item");
  input($("m-search"), "egg");
  await sleep(220);
  click(q('[data-m="add-seg"][data-v="foods"]'));
  const row = qa('#m-results [data-m="pick"]').find(r => /egg/i.test(r.textContent));
  click(row);
  assert.strictEqual($("m-det-go").textContent, "Add to meal");
  assert.ok(!q('[data-m="det-slot"]'), "no slot select in pick mode");
  click(q('[data-m="det-step"][data-v="1"]'));
  click($("m-det-go"));
  assert.strictEqual($("sheetT").textContent, "New meal", "back in builder");
  assert.strictEqual(q('[data-m="mb"][data-k="name"]').value, "Egg plate", "draft name kept");
  assert.strictEqual(M.ui.draft.items.length, 1);
  assert.strictEqual(M.ui.draft.items[0].servings, 1.25);
  /* tap item → edit servings / remove */
  click(q('[data-m="mb-item"]'));
  assert.ok(!$("m-mb-edit").hidden);
  click(q('[data-m="mb-step"][data-v="1"]'));
  assert.strictEqual(M.ui.draft.items[0].servings, 1.5);
  click(q('[data-m="mb-remove"]'));
  assert.strictEqual(M.ui.draft.items.length, 0);
  /* closing the add sheet with × while picking returns to the builder */
  click(q('[data-m="mb-add"]'));
  assert.strictEqual($("sheetT").textContent, "Add item");
  click(q('[data-a="sheet-close"]'));
  await sleep(300);
  assert.strictEqual($("sheetT").textContent, "New meal", "back in builder after ×");
  assert.ok(sheetOn());
  click(q('[data-m="mb-cancel"]'));
  assert.strictEqual(M.ui.draft, null);
  assert.strictEqual(M.meals.list().length, 1, "nothing extra saved");
});

t("day-prev / day-next / day-today change M.ui.date", () => {
  M.ui.tab = "diary"; M.ui.render();
  const t0 = M.today();
  click(q('[data-m="day-prev"]'));
  assert.strictEqual(M.ui.date, M.addDays(t0, -1));
  assert.ok(/Yesterday/.test($("subtitle").textContent));
  click(q('[data-m="day-next"]')); click(q('[data-m="day-next"]'));
  assert.strictEqual(M.ui.date, M.addDays(t0, 1));
  click(q('[data-m="day-today"]'));
  assert.strictEqual(M.ui.date, t0);
});

t("More toggle reveals water row; water +8/-8", () => {
  click(q('[data-m="more"]'));
  assert.ok(!$("m-more").hidden);
  click(q('[data-m="water"][data-v="8"]'));
  assert.strictEqual(M.dayOf(M.today()).water, 8);
  assert.ok(!$("m-more").hidden, "stays open after render");
  click(q('[data-m="water"][data-v="-8"]')); click(q('[data-m="water"][data-v="-8"]'));
  assert.strictEqual(M.dayOf(M.today()).water, 0);
  click(q('[data-m="more"]'));
  assert.ok($("m-more").hidden);
});

t("ring goes .over past target; bars mark over", () => {
  const svg = M.ui.ring(2500, 2000);
  assert.ok(/class="m-ring over"/.test(svg) && />500</.test(svg) && />over</.test(svg));
  const ok = M.ui.ring(500, 2000);
  assert.ok(!/over/.test(ok) && />1500</.test(ok) && />left</.test(ok));
  const bars = M.ui.bars({ p: 200, c: 100, f: 10 }, { p: 150, c: 200, f: 65 });
  assert.ok(/m-bar pro over/.test(bars) && !/m-bar carb over/.test(bars));
});

t("suggest sheet: remaining + built-in suggestions, Log it and Save as meal", async () => {
  click(q('[data-m="suggest"]'));
  assert.ok(sheetOn());
  assert.ok(/Left today/.test($("sheetB").textContent));
  await sleep(50);
  const cards = qa(".m-sug");
  assert.ok(cards.length > 0, "built-in suggestions");
  assert.ok(q('[data-m="sug-log"]') && q('[data-m="sug-save"]'));
  const slot = q('[data-m="sug-slot"].on').dataset.v;
  const before = M.log.slotEntries(M.today(), slot).length;
  click(q('[data-m="sug-save"]'));
  assert.strictEqual(M.meals.list().length, 2, "meal saved from suggestion");
  click(q('[data-m="sug-log"]'));
  assert.ok(M.log.slotEntries(M.today(), slot).length > before, "items logged");
  assert.ok(!sheetOn());
});

t("photo without AI shows the explanation card with a You button", async () => {
  click(q('#cta [data-m="add"]'));
  click(q('[data-m="open-photo"]'));
  await sleep(30);
  assert.ok(/needs Claude/.test($("sheetB").textContent), $("sheetB").textContent);
  assert.ok(q('[data-m="tab"][data-v="you"]'));
  M.ui.close();
});

t("describe (no AI) → local items → Add all", async () => {
  click(q('[data-m="add"][data-slot="Snacks"]'));
  click(q('[data-m="open-describe"]'));
  $("m-desc").value = "2 eggs and 1 banana";
  click(q('[data-m="describe-go"]'));
  await sleep(50);
  const rows = qa("#m-items .m-item");
  assert.ok(rows.length >= 1, "items parsed locally");
  const n = M.log.slotEntries(M.today(), "Snacks").length;
  click(q('[data-m="items-add"]'));
  assert.ok(M.log.slotEntries(M.today(), "Snacks").length > n);
});

t("label sheet has capture + library inputs and a Type-it-in path; barcode sheet has manual lookup", () => {
  click(q('[data-m="add"][data-slot="Snacks"]'));
  click(q('[data-m="open-label"]'));
  const files = qa('[data-m="label-file"]');
  assert.strictEqual(files.length, 2);
  assert.strictEqual(files[0].getAttribute("capture"), "environment");
  assert.strictEqual(files[1].getAttribute("capture"), null);
  click(q('[data-m="open-form"]'));
  assert.ok(q('[data-m="ff-save-add"]'), "Save & add button");
  assert.ok(/Save & add to Snacks/.test(q('[data-m="ff-save-add"]').textContent));
  M.ui.close();
  click(q('[data-m="add"][data-slot="Snacks"]'));
  click(q('[data-m="open-scan"]'));
  assert.ok($("m-scan") && $("m-code") && q('[data-m="code-lookup"]') && q('[data-m="code-photo"]'));
  M.ui.close();
  assert.ok(!sheetOn());
});

t("new food not in the app: search → '+ Add as a new food' (name prefilled) → Save & add → logged, saved, found next time", async () => {
  if (M.ui.sheetOpen()) M.ui.close();
  M.ui.tab = "diary"; M.ui.date = M.today(); M.ui.render();
  click(q('[data-m="add"][data-slot="Dinner"]'));
  /* the Add sheet offers New food next to the scanners */
  const tools = qa(".m-tools button").map(b => Array.from(b.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim());
  assert.deepStrictEqual(tools.slice(0, 3), ["Scan barcode", "Scan label", "New food"], JSON.stringify(tools));
  input($("m-search"), "green chile stew");
  await sleep(750);
  const btn = q('#m-results [data-m="open-form"][data-name]');
  assert.ok(btn && /Add “green chile stew” as a new food/.test(btn.textContent), $("m-results").textContent);
  click(btn);
  assert.strictEqual(q('[data-m="ff"][data-k="name"]').value, "Green chile stew", "name prefilled from the search");
  input(q('[data-m="ff"][data-k="unit"]'), "bowl");
  input(q('[data-m="ff"][data-k="cal"]'), "320"); input(q('[data-m="ff"][data-k="p"]'), "24"); input(q('[data-m="ff"][data-k="c"]'), "30"); input(q('[data-m="ff"][data-k="f"]'), "10");
  assert.ok(/Save & add to Dinner/.test(q('[data-m="ff-save-add"]').textContent));
  click(q('[data-m="ff-save-add"]'));
  assert.strictEqual($("m-det-go").textContent, "Add to Dinner");
  click($("m-det-go"));
  const saved = M.foods.list().find(f => f.name === "Green chile stew");
  assert.ok(saved && saved.source === "custom" && saved.per.cal === 320 && saved.serving.unit === "bowl", JSON.stringify(saved));
  assert.ok(M.log.slotEntries(M.today(), "Dinner").some(e => e.name === "Green chile stew"), "logged to Dinner");
  /* next time: it comes up first, and a partial search still shows the add-new row at the end */
  click(q('[data-m="add"][data-slot="Lunch"]'));
  input($("m-search"), "green chile");
  await sleep(750);
  const rows = qa('#m-results [data-m="pick"]');
  assert.ok(rows.length && /Green chile stew/.test(rows[0].textContent), "saved food is the top result");
  const tail = q("#m-results .m-addnew");
  assert.ok(tail && /Add “green chile” as a new food/.test(tail.textContent), "add-new row after results");
  /* and it lives in Foods → My foods */
  M.ui.close(); M.ui.tab = "foods"; M.ui.foodsSeg = "foods"; M.ui.render();
  assert.ok(qa('[data-m="food"]').some(r => /Green chile stew/.test(r.textContent)), "listed in My foods");
  M.ui.tab = "diary"; M.ui.render();
});

t("rice: 1/4 cup dry by default; log by cooked cups, then by cooked grams", async () => {
  M.ui.tab = "diary"; M.ui.date = M.today(); M.ui.render();
  click(q('[data-m="add"][data-slot="Dinner"]'));
  input($("m-search"), "white rice");
  await sleep(220);
  click(q('[data-m="add-seg"][data-v="foods"]'));
  const row = qa('#m-results [data-m="pick"]').find(r => /^White rice/.test(r.querySelector(".n").textContent));
  assert.ok(/1\/4 cup dry \(4\.6 oz cooked\)/.test(row.textContent), row.textContent);
  click(row);
  const keys = qa('[data-m="det-unit"] option').map(o => o.value);
  assert.ok(keys.includes("cup-raw") && keys.includes("cup-cooked") && keys.includes("oz-raw") && keys.includes("g-cooked"), keys.join(","));
  assert.deepStrictEqual([q('[data-m="det-unit"]').value, q('[data-m="det-qty"]').value], ["cup-raw", "0.25"]);
  change(q('[data-m="det-unit"]'), "cup-cooked");
  assert.strictEqual(q('[data-m="det-qty"]').value, "0.75", "same rice, cooked cups (to the nearest 1/4)");
  input(q('[data-m="det-qty"]'), "1");
  assert.strictEqual($("m-det-amt").textContent, "2 oz dry (1 cup cooked)");
  assert.ok(/205kcal/.test($("m-live").textContent.replace(/\s/g, "")), $("m-live").textContent);
  click($("m-det-go"));
  const e = M.log.slotEntries(M.today(), "Dinner").find(x => x.foodId === "g_white_rice");
  assert.deepStrictEqual([e.state, e.servingLabel, e.servings, e.g], ["cooked", "1 cup cooked", 1, 158]);
  assert.ok(/2 oz dry \(1 cup cooked\)/.test(q('[data-m="entry"][data-id="' + e.id + '"]').textContent));
  click(q('[data-m="entry"][data-id="' + e.id + '"]'));
  assert.strictEqual(q('[data-m="det-unit"]').value, "cup-cooked", "reopens in the unit it was logged in");
  change(q('[data-m="det-unit"]'), "g-cooked");
  assert.strictEqual(q('[data-m="det-qty"]').value, "158");
  input(q('[data-m="det-qty"]'), "200");
  click($("m-det-go"));
  const e2 = M.log.slotEntries(M.today(), "Dinner").find(x => x.id === e.id);
  assert.strictEqual(Math.round(M.foodMath.scale(e2.per, e2.servings).cal), 260, "200 g cooked rice");
  assert.ok(/71 g dry \(200 g cooked\)/.test(q('[data-m="entry"][data-id="' + e.id + '"]').textContent), q('[data-m="entry"][data-id="' + e.id + '"]').textContent);
  M.log.remove(M.today(), e.id); M.ui.render();
});

t("entries saved before the merge read raw first and reopen in their old weight", () => {
  const d = M.day(M.today());
  d.entries.push({ id: "legacy1", slot: "Snacks", name: "Chicken breast, cooked", brand: "", foodId: "g_chicken_breast_cooked", servings: 1.5, servingLabel: "4 oz (113 g)", g: 113, per: { cal: 186, p: 35, c: 0, f: 4.1, fiber: 0, sugar: 0, sodium: 84 }, at: Date.now() });
  M.ui.render();
  const row = q('[data-m="entry"][data-id="legacy1"]');
  assert.ok(/8\.2 oz raw \(6 oz cooked\)/.test(row.textContent), row.textContent);
  const before = M.log.totals(M.today()).cal;
  click(row);
  assert.strictEqual(q('[data-m="det-unit"]').value, "oz-cooked");
  assert.strictEqual(q('[data-m="det-qty"]').value, "5.98");
  click($("m-det-go"));
  const e = M.log.slotEntries(M.today(), "Snacks").find(x => x.id === "legacy1");
  assert.deepStrictEqual([e.foodId, e.state], ["g_chicken_breast", "cooked"]);
  assert.ok(Math.abs(M.log.totals(M.today()).cal - before) < 2, "same food, same calories");
  M.log.remove(M.today(), "legacy1"); M.ui.render();
});

t("recents: the row shows last time's raw (cooked) amount and reopens with it; My foods reads raw first", async () => {
  const rc = M.recents("nick").find(x => x.name === "Chicken breast, boneless skinless");
  const info = M.cook.entryInfo(rc), label = M.cook.entryLabel(rc, "us");
  assert.ok(rc && info && /oz raw \(/.test(label), label);
  click(q('[data-m="add"][data-slot="Lunch"]'));
  try {
    await sleep(30);
    const row = qa('#m-results [data-m="pick"]').find(r => /Chicken breast, boneless skinless/.test(r.textContent));
    assert.ok(row && row.textContent.includes(label), (row && row.textContent) + " should show " + label);
    click(row);
    assert.strictEqual(q('[data-m="det-unit"]').value, info.fam + "-" + info.state, "same unit as last time");
    assert.strictEqual($("m-det-amt").textContent, label, "same amount as last time");
  } finally { M.ui.close(); }
  /* the Foods list still offers a food that is already a recent */
  click(q('[data-m="add"][data-slot="Lunch"]'));
  try {
    input($("m-search"), "chicken breast"); await sleep(220);
    click(q('[data-m="add-seg"][data-v="foods"]'));
    assert.ok(qa('#m-results [data-m="pick"]').some(r => /^Chicken breast, boneless skinless$/.test(r.querySelector(".n").textContent)), "logged food still listed under Foods");
  } finally { M.ui.close(); }
  const f = M.foods.add({ name: "Ground bison", source: "custom", serving: { qty: 4, unit: "oz", g: 113 }, per: { cal: 200, p: 22, c: 0, f: 12 }, per100g: { cal: 177, p: 19.5, c: 0, f: 10.6 }, cook: { y: 0.75, word: "raw" } });
  M.ui.tab = "foods"; M.ui.foodsSeg = "foods"; M.ui.render();
  const fr = qa('[data-m="food"]').find(r => /Ground bison/.test(r.textContent));
  assert.ok(/4 oz raw \(3 oz cooked\)/.test(fr.textContent), fr.textContent);
  M.foods.remove(f.id);
  M.ui.tab = "diary"; M.ui.render();
});

t("new / edit food form: 'Weighs less after cooking?' → cook units; rice × dry; needs grams", () => {
  M.ui.tab = "foods"; M.ui.foodsSeg = "foods"; M.ui.render();
  click(q('[data-m="food-new"]'));
  assert.ok(/Weighs less after cooking\?/.test($("sheetB").textContent));
  assert.ok(q('[data-m="ff-cook"][data-v="none"]').classList.contains("on"));
  assert.ok($("m-ff-cookrow").hidden);
  input(q('[data-m="ff"][data-k="name"]'), "Chicken breast (Costco bag)");
  input(q('[data-m="ff"][data-k="qty"]'), "4"); input(q('[data-m="ff"][data-k="unit"]'), "oz");
  input(q('[data-m="ff"][data-k="cal"]'), "110"); input(q('[data-m="ff"][data-k="p"]'), "23"); input(q('[data-m="ff"][data-k="f"]'), "1.5");
  click(q('[data-m="ff-cook"][data-v="meat"]'));
  assert.ok(!$("m-ff-cookrow").hidden);
  const ci = q('[data-m="ff"][data-k="cook"]');
  assert.strictEqual(ci.getAttribute("placeholder"), "75");
  assert.ok(/Cooked weight is about/.test($("m-ff-cookrow").textContent) && /% of raw/.test($("m-ff-cookrow").textContent));
  input(ci, "250");
  click(q('[data-m="ff-save"]'));
  assert.ok(sheetOn() && /10 to 100%/.test(ctx.toasts[ctx.toasts.length - 1]), "out of range is refused");
  input(q('[data-m="ff"][data-k="cook"]'), "");
  click(q('[data-m="ff-save"]'));
  const f = M.foods.list().find(x => x.name === "Chicken breast (Costco bag)");
  assert.ok(f && f.serving.g > 113 && f.serving.g < 114, "4 oz knows its grams: " + (f && f.serving.g));
  assert.deepStrictEqual([f.cook.y, f.cook.word], [0.75, "raw"], "blank = the 75% placeholder");
  near(f.cook.per100gCooked.cal, f.per100g.cal / 0.75, 0.01);
  /* edit: the section is prefilled; switch to rice-style */
  click(qa('[data-m="food"]').find(r => /Costco bag/.test(r.textContent)));
  assert.ok(q('[data-m="ff-cook"][data-v="meat"]').classList.contains("on"));
  assert.strictEqual(q('[data-m="ff"][data-k="cook"]').value, "75");
  click(q('[data-m="ff-cook"][data-v="grain"]'));
  assert.strictEqual(q('[data-m="ff"][data-k="cook"]').getAttribute("placeholder"), "2.8");
  assert.ok(/× dry/.test($("m-ff-cookrow").textContent));
  input(q('[data-m="ff"][data-k="cook"]'), "3");
  click(q('[data-m="ff-log"]'));
  assert.ok(qa('[data-m="det-unit"] option').some(o => o.value === "oz-cooked" && o.textContent === "oz cooked"), "saved and logging offers cooked units");
  assert.ok(qa('[data-m="det-unit"] option').some(o => o.textContent === "oz dry"), "word follows the kind");
  M.ui.close();
  const f2 = M.foods.get(f.id);
  assert.deepStrictEqual([f2.cook.y, f2.cook.word], [3, "dry"]);
  /* no grams → asks for them */
  click(q('[data-m="food-new"]'));
  input(q('[data-m="ff"][data-k="name"]'), "Mystery meat"); input(q('[data-m="ff"][data-k="unit"]'), "piece");
  click(q('[data-m="ff-cook"][data-v="meat"]'));
  click(q('[data-m="ff-save"]'));
  assert.ok(sheetOn() && /grams per serving/.test(ctx.toasts[ctx.toasts.length - 1]));
  click(q('[data-m="ff-cook"][data-v="none"]'));
  click(q('[data-m="ff-save"]'));
  assert.ok(!sheetOn(), "without cooking info it saves as before");
  M.foods.list().forEach(x => { if (/Mystery|Costco bag/.test(x.name)) M.foods.remove(x.id); });
  M.ui.tab = "diary"; M.ui.render();
});

let batchId = null;
t("batch meal: switch on, total cooked weight, raw total, per 4 oz; saved row says 'Batch · 51 oz cooked'", async () => {
  M.ui.tab = "foods"; M.ui.foodsSeg = "meals"; M.ui.render();
  click(q('[data-m="meal-new"]'));
  input(q('[data-m="mb"][data-k="name"]'), "Chicken and rice prep");
  const addItem = async (qtext, rowRe, unit, qty) => {
    click(q('[data-m="mb-add"]'));
    input($("m-search"), qtext); await sleep(220);
    click(q('[data-m="add-seg"][data-v="foods"]'));
    click(qa('#m-results [data-m="pick"]').find(r => rowRe.test(r.querySelector(".n").textContent)));
    if (unit) change(q('[data-m="det-unit"]'), unit);
    input(q('[data-m="det-qty"]'), String(qty));
    assert.strictEqual($("m-det-go").textContent, "Add to meal");
    click($("m-det-go"));
    assert.strictEqual($("sheetT").textContent, "New meal");
  };
  await addItem("chicken breast", /^Chicken breast, boneless/, "oz-raw", 64);
  await addItem("white rice", /^White rice/, "oz-raw", 6);
  assert.ok(/64 oz raw \(46\.5 oz cooked\)/.test($("m-mb-items").textContent), $("m-mb-items").textContent);
  assert.ok(/6 oz dry \(16\.8 oz cooked\)/.test($("m-mb-items").textContent));
  const sw = q('[data-m="mb-batch"]');
  assert.ok(/Cooked as a batch — log by weight/.test(sw.textContent));
  assert.ok($("m-mb-batch").hidden);
  click(sw);
  assert.ok(!$("m-mb-batch").hidden && sw.getAttribute("aria-checked") === "true");
  assert.ok($("m-mb-row").classList.contains("batch"), "servings made hides");
  assert.strictEqual($("m-mb-raw").textContent, "The raw items weigh 70 oz.");
  assert.ok(/Whole batch/.test($("m-mb-live").textContent));
  click(q('[data-m="mb-save"]'));
  assert.ok(sheetOn() && /total cooked weight/.test(ctx.toasts[ctx.toasts.length - 1]), "cooked weight required");
  input(q('[data-m="mb-cooked"]'), "51");
  assert.ok(/Per 4 oz cooked/.test($("m-mb-live").textContent), $("m-mb-live").textContent);
  click(q('[data-m="mb-cunit"][data-v="g"]'));
  assert.strictEqual(q('[data-m="mb-cooked"]').value, "1446", "unit switch keeps the weight");
  click(q('[data-m="mb-cunit"][data-v="oz"]'));
  assert.strictEqual(q('[data-m="mb-cooked"]').value, "51");
  click(q('[data-m="mb-save"]'));
  assert.ok(!sheetOn());
  const m = M.meals.list().find(x => x.name === "Chicken and rice prep");
  batchId = m.id;
  assert.ok(m.batch && Math.abs(m.batch.cookedG - 51 * OZ) < 1 && Math.abs(m.batch.rawG - 70 * OZ) < 1, JSON.stringify(m.batch));
  assert.strictEqual(m.servingsMade, 1);
  const rowEl = q('[data-m="meal"][data-id="' + m.id + '"]');
  assert.ok(/Batch · 51 oz cooked/.test(rowEl.textContent) && /per 4 oz cooked/.test(rowEl.textContent), rowEl.textContent);
});

t("batch meal: 'How much did you eat?' of 51 oz cooked → 12 oz → '16.5 oz raw (12 oz cooked)'; editing the meal never changes the day", () => {
  const m = M.meals.get(batchId);
  click(q('[data-m="meal"][data-id="' + batchId + '"]'));
  assert.ok(/How much did you eat\?/.test($("sheetB").textContent));
  assert.strictEqual($("m-det-of").textContent, "of 51 oz cooked");
  assert.deepStrictEqual(qa('[data-m="det-useg"]').map(b => b.textContent), ["oz", "g"], "oz or g");
  assert.ok(q('[data-m="meal-edit"]') && q('[data-m="meal-del"]'), "meal tools still there");
  input(q('[data-m="det-qty"]'), "12");
  assert.strictEqual($("m-det-amt").textContent, "16.5 oz raw (12 oz cooked)");
  click(q('[data-m="det-useg"][data-v="g-cooked"]'));
  assert.strictEqual(q('[data-m="det-qty"]').value, "340");
  assert.strictEqual($("m-det-of").textContent, "of 1446 g cooked");
  click(q('[data-m="det-useg"][data-v="oz-cooked"]'));
  assert.strictEqual(q('[data-m="det-qty"]').value, "12");
  const go = $("m-det-go"); assert.ok(/^Add to /.test(go.textContent));
  click(go);
  assert.ok(!sheetOn());
  const e = Object.values(M.MS.days).flatMap(d => d.entries).find(x => x.mealId === batchId);
  assert.deepStrictEqual([e.servings, e.servingLabel, e.state], [12, "1 oz cooked", "cooked"]);
  const want = m.per.cal * 12 / 51;
  assert.ok(Math.abs(M.foodMath.scale(e.per, e.servings).cal - want) < 1, "batch totals × eaten ÷ cooked");
  M.ui.tab = "diary"; M.ui.render();
  const row = q('[data-m="entry"][data-id="' + e.id + '"]');
  assert.ok(/16\.5 oz raw \(12 oz cooked\)/.test(row.textContent), row.textContent);
  const dayCal = M.log.totals(M.today()).cal;
  /* change the saved meal: more rice, new cooked weight */
  M.meals.update(batchId, { items: m.items.concat([{ name: "Olive oil", servings: 2, servingLabel: "1 tbsp (14 g)", g: 14, per: { cal: 124, f: 14 } }]), batch: { cookedG: 55 * OZ } });
  M.ui.render();
  assert.strictEqual(M.log.totals(M.today()).cal, dayCal, "day unchanged");
  assert.ok(/16\.5 oz raw \(12 oz cooked\)/.test(q('[data-m="entry"][data-id="' + e.id + '"]').textContent));
  /* reopen the logged portion: cooked units only, same amount */
  click(q('[data-m="entry"][data-id="' + e.id + '"]'));
  assert.deepStrictEqual(qa('[data-m="det-useg"]').map(b => b.dataset.v), ["oz-cooked", "g-cooked"]);
  assert.strictEqual(q('[data-m="det-qty"]').value, "12");
  M.ui.close();
  /* the add sheet: Meals row and the recent both lead to the weight screen */
  click(q('[data-m="add"][data-slot="Dinner"]'));
  click(q('[data-m="add-seg"][data-v="meals"]'));
  const mr = qa('#m-results [data-m="pick"]').find(r => /Chicken and rice prep/.test(r.textContent));
  assert.ok(/Batch · 55 oz cooked/.test(mr.textContent) && /per 4 oz/.test(mr.textContent), mr.textContent);
  click(mr);
  assert.ok(/How much did you eat\?/.test($("sheetB").textContent));
  assert.strictEqual(q('[data-m="det-qty"]').value, "12", "defaults to the last portion");
  M.ui.close();
  M.log.remove(M.today(), e.id); M.meals.remove(batchId); M.ui.render();
});

t("suggestion cards list items with amounts, cook items raw first; Log it keeps state", async () => {
  M.ui.tab = "diary"; M.ui.render();
  click(q('[data-m="suggest"]'));
  click(q('[data-m="sug-slot"][data-v="Dinner"]'));
  await sleep(50);
  const txt = $("m-sug-list").textContent;
  assert.ok(/oz raw \(\d+(\.\d)? oz cooked\)/.test(txt), "suggestion items read raw first");
  const cards = qa(".m-sug");
  /* a built-in idea card (saved meals of your own log as one entry and have no "Save as meal") */
  const i = cards.findIndex(c => c.querySelector('[data-m="sug-save"]') && /Kirkland|Chicken breast|Pork tenderloin/.test(c.textContent));
  assert.ok(i >= 0);
  const n = M.log.slotEntries(M.today(), "Dinner").length;
  click(cards[i].querySelector('[data-m="sug-log"]'));
  const added = M.log.slotEntries(M.today(), "Dinner").slice(n);
  assert.ok(added.some(e => e.state && e.cook), "cook items logged with their state");
  added.forEach(e => M.log.remove(M.today(), e.id)); M.ui.render();
});

t("suggest: your own saved meal shows 'Your meal', has no 'Save as meal', and logs as one meal entry", async () => {
  M.ui.tab = "diary"; M.ui.render();
  const m = M.meals.add({ name: "Pork and zucchini night", desc: "Our Tuesday dinner.", slot: "Dinner", servingsMade: 1, items: [{ name: "Zucchini, raw", servings: 1, servingLabel: "1 medium (196 g)", g: 196, per: { cal: 33, p: 2.4, c: 6.1, f: 0.6, fiber: 2, sugar: 4.9, sodium: 16 } }] });
  click(q('[data-m="suggest"]'));
  click(q('[data-m="sug-slot"][data-v="Dinner"]'));
  await sleep(50);
  const card = qa(".m-sug").find(c => /Pork and zucchini night/.test(c.textContent));
  assert.ok(card, "saved meal offered first-class");
  assert.ok(/Your meal/.test(card.textContent), "tagged Your meal");
  assert.ok(!card.querySelector('[data-m="sug-save"]'), "no Save as meal on your own meal");
  const n = M.log.slotEntries(M.today(), "Dinner").length;
  click(card.querySelector('[data-m="sug-log"]'));
  const added = M.log.slotEntries(M.today(), "Dinner").slice(n);
  assert.strictEqual(added.length, 1, "one entry");
  assert.strictEqual(added[0].mealId, m.id, "linked to the saved meal");
  added.forEach(e => M.log.remove(M.today(), e.id)); M.meals.remove(m.id); M.ui.render();
});

t("barcode known but no nutrition → straight to the label photo with the product name shown", async () => {
  M.ui.tab = "diary"; M.ui.render();
  const real = M.food.lookup;
  M.food.lookup = () => Promise.resolve({ status: "no_nutrition", code: "012345678905", product: { name: "Green chile salsa", brand: "Good Co" } });
  try {
    click(q('[data-m="add"][data-slot="Lunch"]'));
    click(q('[data-m="open-scan"]'));
    input($("m-code"), "012345678905");
    click(q('[data-m="code-lookup"]'));
    await sleep(30);
    assert.strictEqual($("sheetT").textContent, "Scan label");
    assert.ok(/Green chile salsa: Open Food Facts has no nutrition numbers for this\. Take a photo of the label\./.test($("m-label-status").textContent), $("m-label-status").textContent);
  } finally { M.food.lookup = real; M.ui.close(); M.ui.render(); }
});

t("focus-safe render: typing across fields defers, renders once when focus leaves; a button tap flushes", async () => {
  M.ui.tab = "diary"; M.ui.render();
  const app = $("app");
  app.insertAdjacentHTML("afterbegin", '<div id="ff-test"><input id="fa" type="text"><input id="fb" type="number"><select id="fc"><option>1</option></select><button id="fbtn">Go</button></div>');
  const n0 = renders;
  $("fa").focus();
  M.ui.rerender(); M.ui.render(); M.ui.rerender();
  assert.ok($("ff-test"), "nothing rebuilt while typing");
  assert.strictEqual(M.ui.pendingRender(), "rerender");
  $("fb").focus(); await sleep(20);
  assert.ok($("ff-test") && doc.activeElement === $("fb"), "moving to the next field keeps the form and focus");
  $("fc").focus(); await sleep(20);
  assert.ok($("ff-test"), "selects count as fields");
  $("fc").blur(); await sleep(20);
  assert.ok(!$("ff-test"), "rendered after focus left the fields");
  assert.strictEqual(renders - n0, 1, "rendered once");
  assert.strictEqual(M.ui.pendingRender(), null);
  /* a tap on a button flushes right away */
  app.insertAdjacentHTML("afterbegin", '<div id="ff-test2"><input id="fd" type="text"><button id="fbtn2">Go</button></div>');
  $("fd").focus(); M.ui.render();
  assert.ok($("ff-test2"));
  click($("fbtn2"));
  assert.ok(!$("ff-test2"), "button tap flushed the waiting render");
  /* renders during a tap are never held back */
  app.insertAdjacentHTML("afterbegin", '<div id="ff-test3"><input id="fe" type="text"><button id="fbtn3" data-m="day-today">Today</button></div>');
  $("fe").focus();
  click($("fbtn3"));
  assert.ok(!$("ff-test3"), "action render ran");
  /* a sheet form: typing in the meal builder while something re-renders */
  M.ui.render();
  M.ui.tab = "foods"; M.ui.foodsSeg = "meals"; M.ui.render();
  click(q('[data-m="meal-new"]'));
  const nameIn = q('[data-m="mb"][data-k="name"]'), descIn = q('[data-m="mb"][data-k="desc"]');
  const appKid = app.firstElementChild;
  nameIn.focus(); input(nameIn, "Tacos");
  M.ui.rerender();
  descIn.focus(); input(descIn, "Beef and peppers"); await sleep(20);
  assert.strictEqual(app.firstElementChild, appKid, "screen behind the sheet waits too");
  assert.strictEqual(doc.activeElement, descIn, "focus stays in the form");
  assert.strictEqual(M.ui.draft.name, "Tacos");
  click(q('[data-m="mb-cancel"]'));
  await sleep(20);
  assert.strictEqual(M.ui.pendingRender(), null, "closing the sheet let the render through");
  M.ui.tab = "diary"; M.ui.render();
});

t("trainSummaryHTML: '' with no person or before setup; kcal + protein today and a Log food button into Macros", async () => {
  const saveP = ctx.S.profile;
  ctx.S.profile = null; assert.strictEqual(M.ui.trainSummaryHTML(), "");
  ctx.S.profile = "kat"; assert.strictEqual(M.ui.trainSummaryHTML(), "", "setup not done");
  ctx.S.profile = saveP;
  const t = M.log.totals(M.today()), tg = M.person().targets;
  const h = M.ui.trainSummaryHTML();
  assert.ok(h.includes("<b>" + Math.round(t.cal) + "</b> / " + Math.round(tg.cal)) && h.includes("<b>" + Math.round(t.p) + "</b> / " + Math.round(tg.p) + " g"), h);
  assert.ok(/data-m="mode" data-v="macros"/.test(h) && />Log food</.test(h));
  M.setMode("train"); M.ui.chrome();
  $("app").innerHTML = h;
  click(q('#app [data-m="mode"][data-v="macros"]'));
  assert.strictEqual(M.mode(), "macros");
  assert.strictEqual(M.ui.tab, "diary");
  assert.ok(sheetOn() && $("m-search"), "Log food opens the add sheet");
  M.ui.close(); M.ui.render();
});

t("storage full: toast once per streak, warning card on the Diary, gone after a good save", () => {
  const P = ctx.Storage.prototype, orig = P.setItem;
  P.setItem = function (k, v) { if (k === M.KEY) throw new ctx.DOMException("full", "QuotaExceededError"); return orig.call(this, k, v); };
  const n = ctx.toasts.length;
  M.log.setWater(M.today(), 8); M.ui.render();
  M.log.setWater(M.today(), 16);
  const msgs = ctx.toasts.slice(n).filter(m => /storage is full/.test(m));
  assert.deepStrictEqual(msgs, ["Phone storage is full. Back up in Train → Settings."]);
  assert.ok(q(".m-warn") && /Phone storage is full/.test(q(".m-warn").textContent));
  P.setItem = orig;
  M.log.setWater(M.today(), 0); M.ui.render();
  assert.strictEqual(M.storage.ok, true);
  assert.ok(!q(".m-warn"));
});

t("chrome() swaps #tabs in both modes and marks the mode bar", () => {
  M.setMode("train"); M.ui.chrome();
  assert.ok(q('#tabs [data-tab="today"]'), "train tabs restored");
  assert.strictEqual(qa("#tabs [data-mtab]").length, 0);
  assert.ok(q('#modebar [data-v="train"]').classList.contains("on"));
  M.setMode("macros"); M.ui.chrome();
  assert.strictEqual(qa("#tabs [data-mtab]").length, 4);
  assert.ok(q('#modebar [data-v="macros"]').classList.contains("on"));
  /* mode action via click delegation */
  click(q('#modebar [data-v="train"]'));
  assert.strictEqual(M.mode(), "train");
  assert.ok(renders > 0, "Chalk render() called through rerender");
  click(q('#modebar [data-v="macros"]'));
  assert.strictEqual(M.mode(), "macros");
  assert.strictEqual($("title").textContent, "Macros");
});

t("tab action switches views and resets scroll", () => {
  $("scroll").scrollTop = 40;
  click(q('[data-m="add"][data-slot="Snacks"]'));
  click(q('[data-m="open-photo"]'));
  click(q('[data-m="tab"][data-v="you"]'));
  assert.strictEqual(M.ui.tab, "you");
  assert.ok(!sheetOn(), "sheet closed when changing tab");
  M.ui.tab = "diary"; M.ui.render();
});

t("all user strings escaped", () => {
  M.log.add(M.today(), { slot: "Snacks", name: '<img src=x onerror="1">', servings: 1, servingLabel: "1 <b>", per: { cal: 1 } });
  M.ui.render();
  assert.ok(!q("#app img[src='x']"), "no injected element");
  assert.ok(/&lt;img/.test($("app").innerHTML));
});

(async () => {
  let pass = 0, fail = 0;
  for (const x of tests) {
    try { await x.fn(); pass++; console.log("  ok   " + x.name); }
    catch (e) { fail++; console.log("  FAIL " + x.name + "\n       " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n       ") : e)); }
  }
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
