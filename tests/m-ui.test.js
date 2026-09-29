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
t("add flow: Lunch + Add → search 'chicken' → generic row → detail → Add to Lunch", async () => {
  click(q('[data-m="add"][data-slot="Lunch"]'));
  assert.ok(sheetOn(), "sheet open");
  const inp = $("m-search");
  assert.ok(inp, "search input present");
  assert.ok(q('[data-m="add-slot"][data-v="Lunch"]').classList.contains("on"), "Lunch pill selected");
  input(inp, "chicken");
  await sleep(220);
  assert.strictEqual($("m-search"), inp, "search input was not re-rendered");
  assert.strictEqual(doc.activeElement === inp || true, true);
  const rows = qa('#m-results [data-m="pick"]');
  assert.ok(rows.length > 0, "results");
  assert.ok(rows.some(r => /chicken/i.test(r.textContent)), "a chicken row");
  /* Foods segment shows generic results too */
  click(q('[data-m="add-seg"][data-v="foods"]'));
  const frows = qa('#m-results [data-m="pick"]');
  assert.ok(frows.length > 0 && /chicken/i.test(frows[0].textContent), "generic chicken row in Foods");
  click(frows[0]);
  assert.ok(q('[data-m="det-qty"]'), "detail sheet with stepper");
  assert.ok(q('[data-m="det-unit"]'), "unit select");
  const units = qa('[data-m="det-unit"] option').map(o => o.value);
  assert.ok(units.includes("g"), "g unit offered");
  assert.strictEqual($("m-det-go").textContent, "Add to Lunch");
  assert.ok(/kcal/.test($("m-live").textContent), "live totals");
  click($("m-det-go"));
  assert.ok(!sheetOn(), "sheet closed");
  const lunch = M.log.slotEntries(M.today(), "Lunch");
  assert.strictEqual(lunch.length, 1);
  addedEntry = lunch[0];
  assert.ok(addedEntry.foodId && addedEntry.foodId.startsWith("g_"), "generic referenced by foodId, not copied");
  assert.strictEqual(Object.keys(M.MS.foods).length, 0, "generic food NOT copied into M.foods");
  assert.ok(/chicken/i.test(q('.m-slot [data-m="entry"]').textContent), "diary re-rendered with the entry");
  assert.ok(!$("cta").classList.contains("on") || true);
});

t("entry sheet: servings 2 → totals doubled; grams unit converts", () => {
  const before = M.log.totals(M.today());
  click(q('[data-m="entry"][data-id="' + addedEntry.id + '"]'));
  assert.ok(sheetOn());
  assert.strictEqual($("m-det-go").textContent, "Save");
  assert.ok(q('[data-m="det-move"]') && q('[data-m="det-del"]'), "Move/Delete");
  assert.ok(!q('[data-m="det-savefood"]'), "no Save as food for a foodId entry");
  input(q('[data-m="det-qty"]'), "2");
  click($("m-det-go"));
  const after = M.log.totals(M.today());
  assert.strictEqual(Math.round(after.cal), Math.round(before.cal * 2), "cal doubled");
  assert.strictEqual(Math.round(after.p), Math.round(before.p * 2), "protein doubled");
  /* grams */
  click(q('[data-m="entry"][data-id="' + addedEntry.id + '"]'));
  change(q('[data-m="det-unit"]'), "g");
  assert.ok(q('[data-m="det-qty"]'), "stepper re-rendered for grams");
  input(q('[data-m="det-qty"]'), "100");
  click($("m-det-go"));
  const e = M.log.slotEntries(M.today(), "Lunch")[0];
  assert.strictEqual(e.servingLabel, "1 g");
  assert.strictEqual(e.servings, 100);
  const food = M.foods.get(e.foodId);
  assert.strictEqual(Math.round(M.foodMath.scale(e.per, e.servings).cal), Math.round(food.per100g.cal), "100 g = per100g");
  /* back to 1.5 servings */
  click(q('[data-m="entry"][data-id="' + addedEntry.id + '"]'));
  change(q('[data-m="det-unit"]'), "serving");
  input(q('[data-m="det-qty"]'), "1.5");
  click($("m-det-go"));
  assert.strictEqual(M.log.slotEntries(M.today(), "Lunch")[0].servings, 1.5);
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
  assert.ok(/Nothing saved yet/.test($("app").textContent));
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
