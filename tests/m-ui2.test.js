/* node tests/m-ui2.test.js — jsdom regression tests for m-ui.js Foods / Meals / Forms / Scan /
   Label / Describe / Suggest (fixer F2b). Harness copied from tests/m-ui.test.js. */
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
const ctx = w;

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
ctx.render = () => { const M = ctx.M; if (M.mode() === "macros") { M.ui.render(); return; } M.ui.chrome(); ctx.document.getElementById("app").innerHTML = "<div class='card'>train</div>"; };
ctx.document.addEventListener("click", e => { if (e.target.closest && (e.target.closest('[data-a="sheet-close"]') || e.target.id === "sheetBg")) ctx.closeSheet(); });
ctx.localStorage.clear();
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
const same = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || "") + " expected " + a + " ≈ " + b);
const sheetOn = () => $("sheet").classList.contains("on");
const lastToast = () => ctx.toasts[ctx.toasts.length - 1];
const entries = () => { const d = M.dayOf(M.today()); return d ? d.entries : []; };
const OZ = 28.349523125;

const tests = [];
function t(name, fn) { tests.push({ name, fn }); }
console.log("m-ui.js (F2b: foods, meals, forms, scan, label, describe, suggest)");

/* ---- setup ---- */
M.reset();
const P = M.person("nick");
Object.assign(P, { sex: "m", age: 40, heightIn: 71, weightLb: 185, goalWeightLb: 175, activity: "moderate", pace: -0.5, setupAt: Date.now(), lastBody: Date.now() });
M.calc.applyTargets(P);
M.setMode("macros");
M.ui.bind();
M.ui.render();
const reset = () => {
  if (M.ui.sheetOpen()) M.ui.close();
  Object.keys(M.MS.days).forEach(k => delete M.MS.days[k]);
  Object.keys(M.MS.meals).forEach(k => delete M.MS.meals[k]);
  Object.keys(M.MS.foods).forEach(k => delete M.MS.foods[k]);
  M.ui.draft = null; M.ui.foodsQ = ""; M.ui.date = M.today(); M.ui.tab = "diary"; M.ui.mealsSlot = "All"; M.ui.undoDel = null; M.ui.undoDels = [];
  try { ctx.localStorage.removeItem(M.ui._.draftKey()); } catch (e) {}
  ctx.toasts.length = 0;
  M.ui.render();
};
const openFoods = seg => { M.ui.tab = "foods"; M.ui.foodsSeg = seg || "meals"; M.ui.render(); };
/* a draft meal via + New meal with its name set */
const newMeal = name => { openFoods("meals"); click(q('[data-m="meal-new"]')); input(q('[data-m="mb"][data-k="name"]'), name); };
const egg = () => ({ name: "Egg", servings: 2, servingLabel: "1 large egg (50 g)", g: 50, per: { cal: 72, p: 6.3, c: 0.4, f: 4.8 } });

/* ================================================================ P1 */
t("CPY-01 batch tip: weigh only the food, zero the pot; switch reads 'Cooked a big batch? Log it by weight'", () => {
  reset(); newMeal("Chili pot");
  const sw = q('[data-m="mb-batch"]');
  assert.strictEqual(sw.querySelector(".m-switch-t").textContent, "Cooked a big batch? Log it by weight");
  click(sw);
  const txt = $("m-mb-batch").textContent;
  assert.ok(/After cooking, weigh only the food\./.test(txt), txt);
  assert.ok(/put the empty pot on the scale and press zero first/.test(txt), txt);
  assert.ok(!/Weigh the whole pot/.test(txt), "never tells them to weigh the pot");
  assert.strictEqual(q('[data-m="mb-cooked"]').getAttribute("placeholder"), "e.g. 51", "placeholder reads as an example");
});

t("UIF-01/UID-08 Suggest inside the meal builder adds the idea's items to the meal, never the diary", async () => {
  reset(); newMeal("Test bowl");
  click(q('[data-m="mb-add"]'));
  assert.strictEqual($("sheetT").textContent, "Add item");
  click(q('.m-tools [data-m="suggest"]'));
  assert.strictEqual($("sheetT").textContent, "Ideas for your meal");
  await sleep(30);
  const card = qa(".m-sug").find(c => c.querySelector('[data-m="sug-log"]'));
  assert.ok(card, "idea cards");
  assert.strictEqual(card.querySelector('[data-m="sug-log"]').textContent, "Add to meal");
  assert.ok(!q('[data-m="sug-save"]'), "no Save as meal while picking");
  const n = card.querySelectorAll(".m-sugitems li").length;
  click(card.querySelector('[data-m="sug-log"]'));
  assert.ok(sheetOn() && $("sheetT").textContent === "New meal", "back in the builder");
  assert.strictEqual(M.ui.draft.items.length, n, "all the idea's items went into the meal");
  assert.strictEqual(entries().length, 0, "nothing logged to the diary");
  assert.strictEqual(q('[data-m="mb"][data-k="name"]').value, "Test bowl", "draft kept");
});

t("UIF-02 zero stays zero in the builder: row says left out, save drops it, totals ignore it", () => {
  reset(); newMeal("Eggs and oil");
  M.ui.draft.items.push(egg(), { name: "Olive oil", servings: 1, servingLabel: "1 tbsp (13.5 g)", g: 13.5, per: { cal: 119, f: 13.5 } });
  M.ui.openBuilder();
  click(qa('[data-m="mb-item"]')[1]);
  input(q('[data-m="mb-qty"]'), "0");
  assert.ok(/left out/.test(qa('[data-m="mb-item"]')[1].textContent), qa('[data-m="mb-item"]')[1].textContent);
  assert.ok(/144/.test($("m-mb-live").textContent), "live total counts the eggs only: " + $("m-mb-live").textContent);
  /* + from 0 goes to one step, never 1.25 */
  click(q('[data-m="mb-step"][data-v="1"]'));
  assert.strictEqual(M.ui.draft.items[1].servings, 0.25, "+ from 0 → 0.25 for a tbsp");
  input(q('[data-m="mb-qty"]'), "0");
  click(q('[data-m="mb-done"]'));
  click(q('[data-m="mb-save"]'));
  assert.ok(!sheetOn());
  const m = M.meals.list()[0];
  same(m.items.map(i => i.name), ["Egg"], "the 0 item is left out, not saved as 1");
  near(m.per.cal, 144, 0.5);
  assert.ok(/Left out 1 item at 0/.test(lastToast()), lastToast());
});

t("UIF-02 builder: every item at 0 → 'Every item is at 0' and nothing saved", () => {
  reset(); newMeal("Nothing");
  M.ui.draft.items.push(Object.assign(egg(), { servings: 0 }));
  M.ui.openBuilder();
  click(q('[data-m="mb-save"]'));
  assert.ok(sheetOn() && /Every item is at 0/.test($("m-mb-msg").textContent));
  assert.strictEqual(M.meals.list().length, 0);
});

t("UIF-02/UID-04 describe items: + from 0 → 1 egg (count) / 0.25; an item at 0 is not logged", async () => {
  reset();
  click(q('#cta [data-m="add"]'));
  click(q('[data-m="open-describe"]'));
  $("m-desc").value = "2 eggs, 1 banana";
  click(q('[data-m="describe-go"]'));
  await sleep(40);
  const rows = qa("#m-items .m-item");
  assert.strictEqual(rows.length, 2, $("m-items").textContent);
  const eggI = M.ui._.state().items.list.findIndex(it => /egg/i.test(it.name));
  const banI = 1 - eggI;
  /* banana down to 0, then + */
  for (let i = 0; i < 6; i++) click(q('[data-m="item-step"][data-i="' + banI + '"][data-v="-1"]'));
  assert.strictEqual(q('[data-m="item-qty"][data-i="' + banI + '"]').value, "0");
  assert.ok(/won't be added/.test(qa("#m-items .m-item")[banI].textContent));
  click(q('[data-m="item-step"][data-i="' + banI + '"][data-v="1"]'));
  assert.strictEqual(q('[data-m="item-qty"][data-i="' + banI + '"]').value, "1", "a medium banana counts whole: 0 → 1");
  /* eggs: 2 → 3 by whole eggs */
  click(q('[data-m="item-step"][data-i="' + eggI + '"][data-v="1"]'));
  assert.strictEqual(q('[data-m="item-qty"][data-i="' + eggI + '"]').value, "3");
  input(q('[data-m="item-qty"][data-i="' + banI + '"]'), "0");
  assert.strictEqual(q('[data-m="items-add"]').textContent, "Add to Snacks".replace("Snacks", M.ui._.state().items.slot));
  click(q('[data-m="items-add"]'));
  const names = entries().map(e => e.name);
  assert.strictEqual(names.length, 1, "banana at 0 is not logged: " + names);
  assert.ok(/egg/i.test(names[0]));
  assert.strictEqual(entries()[0].servings, 3);
});

t("UIF-02 meal sheet: 0 servings → 'Enter how many servings.', nothing logged as 1", () => {
  reset();
  const m = M.meals.add({ name: "Toast plate", slot: "Breakfast", servingsMade: 1, items: [egg()] });
  openFoods("meals");
  click(q('[data-m="meal"][data-id="' + m.id + '"]'));
  input(q('[data-m="meal-qty"]'), "0");
  click(q('[data-m="meal-log"]'));
  assert.ok(sheetOn(), "stays open");
  assert.strictEqual($("m-meal-msg").textContent, "Enter how many servings.");
  assert.strictEqual(entries().length, 0);
  input(q('[data-m="meal-qty"]'), "2");
  click(q('[data-m="meal-log"]'));
  assert.strictEqual(entries().length, 1);
  assert.strictEqual(entries()[0].servings, 2);
});

t("UIF-03 a recent whose food was deleted logs as a plain entry and never re-creates a broken food", async () => {
  reset();
  const f = M.foods.add({ name: "Protein bar", brand: "Kirkland", barcode: "012345678905", source: "off", serving: { qty: 1, unit: "bar", g: 60 }, per: { cal: 190, p: 21, c: 23, f: 7 }, per100g: { cal: 316, p: 35, c: 38, f: 12 }, alts: [{ label: "100 g", g: 100 }] });
  M.log.add(M.addDays(M.today(), -1), { slot: "Snacks", name: f.name, brand: f.brand, servings: 1, servingLabel: "1 bar (60 g)", g: 60, per: f.per, foodId: f.id });
  M.foods.remove(f.id);
  M.ui.render();
  click(q('[data-m="add"][data-slot="Snacks"]'));
  await sleep(20);
  const row = qa('#m-results [data-m="pick"]').find(r => /Protein bar/.test(r.textContent));
  assert.ok(row, "still offered as a recent");
  click(row);
  click($("m-det-go"));
  assert.strictEqual(M.foods.list().length, 0, "no food re-created");
  const e = entries().find(x => x.name === "Protein bar");
  assert.ok(e && !e.foodId, "plain entry: " + JSON.stringify(e));
  near(e.per.cal * e.servings, 190, 0.5);
  /* the ensureFood helper itself */
  const src = { kind: "recent", name: "X", per: { cal: 1 }, foodId: "gone_1", ref: { name: "X", per: { cal: 1 }, foodId: "gone_1" } };
  M.ui._.ensureFood(src);
  assert.ok(!src.foodId && !M.MS.foods.gone_1);
});

t("UX1-02 grams that can't be right are flagged beside Grams ('1 tortilla = 459 g?') and clear when fixed", () => {
  reset();
  const gw = M.ui._.gramsWarning;
  assert.strictEqual(gw({ qty: 1, unit: "tortilla", g: 459 }), "Check the grams: 1 tortilla = 459 g?");
  assert.strictEqual(gw({ qty: 1, unit: "tortilla", g: 45 }), "");
  assert.strictEqual(gw({ qty: 4, unit: "oz", g: 45 }), "Check the grams: 4 oz = 45 g?");
  assert.strictEqual(gw({ qty: 4, unit: "oz", g: 113 }), "");
  assert.strictEqual(gw({ qty: 2, unit: "tbsp", g: 32 }), "");
  assert.ok(gw({ qty: 1, unit: "cup", g: 900 }));
  assert.strictEqual(gw({ qty: 1, unit: "serving", g: 900 }), "", "unknown units are never flagged");
  /* real big packages are fine: a 14 oz shake bottle, a can, a tub, a large potato, a fillet */
  [["bottle", 414], ["can", 355], ["container", 907], ["large", 369], ["fillet", 340]].forEach(x => assert.strictEqual(gw({ qty: 1, unit: x[0], g: x[1] }), "", x.join(" ")));
  assert.ok(gw({ qty: 2, unit: "slices", g: 900 }), "2 slices = 900 g is flagged");
  openFoods("foods");
  click(q('[data-m="food-new"]'));
  assert.ok($("m-ff-gwarn").hidden);
  input(q('[data-m="ff"][data-k="unit"]'), "tortilla");
  input(q('[data-m="ff"][data-k="g"]'), "459");
  assert.ok(!$("m-ff-gwarn").hidden && /1 tortilla = 459 g\?/.test($("m-ff-gwarn").textContent));
  input(q('[data-m="ff"][data-k="g"]'), "45");
  assert.ok($("m-ff-gwarn").hidden);
});

/* ================================================================ P2 */
t("UIF-04 New food while picking: 'Save & add to meal' puts it in the meal and returns to the builder", () => {
  reset(); newMeal("Wrap lunch");
  click(q('[data-m="mb-add"]'));
  click(q('.m-tools [data-m="open-form"]'));
  const btn = q('[data-m="ff-save-add"]');
  assert.strictEqual(btn.textContent, "Save & add to meal");
  input(q('[data-m="ff"][data-k="name"]'), "Tortilla wrap"); input(q('[data-m="ff"][data-k="unit"]'), "wrap"); input(q('[data-m="ff"][data-k="g"]'), "70");
  input(q('[data-m="ff"][data-k="cal"]'), "210"); input(q('[data-m="ff"][data-k="p"]'), "6"); input(q('[data-m="ff"][data-k="c"]'), "35"); input(q('[data-m="ff"][data-k="f"]'), "5");
  click(btn);
  assert.ok(sheetOn() && $("sheetT").textContent === "New meal", "back in the builder");
  same(M.ui.draft.items.map(i => [i.name, i.servings]), [["Tortilla wrap", 1]]);
  assert.strictEqual(entries().length, 0, "nothing in the diary");
  assert.ok(M.foods.list().some(f => f.name === "Tortilla wrap"), "saved to My foods");
});

t("UIF-04 'Save to My foods' while picking returns to the builder too", () => {
  reset(); newMeal("Snack box");
  click(q('[data-m="mb-add"]'));
  click(q('.m-tools [data-m="open-form"]'));
  input(q('[data-m="ff"][data-k="name"]'), "Fage 0%"); input(q('[data-m="ff"][data-k="cal"]'), "90"); input(q('[data-m="ff"][data-k="p"]'), "18"); input(q('[data-m="ff"][data-k="c"]'), "5");
  click(q('[data-m="ff-save"]'));
  assert.ok(sheetOn() && $("sheetT").textContent === "New meal");
  assert.strictEqual(lastToast(), "Saved to My foods");
});

t("UIF-04 barcode lookup while picking: × on the amount screen returns to the builder", async () => {
  reset(); newMeal("Bar snack");
  const saved = M.food.lookup;
  M.food.lookup = code => Promise.resolve({ status: "found", food: { id: "off_1", name: "Protein bar", brand: "Kirkland", barcode: code, source: "off", serving: { qty: 1, unit: "bar", g: 60 }, per: { cal: 190, p: 21, c: 23, f: 7 }, per100g: { cal: 316, p: 35, c: 38, f: 12 }, alts: [{ label: "100 g", g: 100 }] } });
  try {
    click(q('[data-m="mb-add"]'));
    const sc = M.food.scanner.start; M.food.scanner.start = () => new Promise(() => {});
    click(q('.m-tools [data-m="open-scan"]'));
    M.food.scanner.start = sc;
    $("m-code").value = "012345678905";
    click(q('[data-m="code-lookup"]'));
    await sleep(20);
    assert.strictEqual($("m-det-go").textContent, "Add to meal");
    click(q('[data-a="sheet-close"]'));
    await sleep(320);
    assert.ok(sheetOn() && $("sheetT").textContent === "New meal", "× went back to the builder");
  } finally { M.food.lookup = saved; }
});

t("UIF-04 Scan barcode while picking: Cancel returns to the builder (and × on Add item too)", async () => {
  reset(); newMeal("Scan snack");
  click(q('[data-m="mb-add"]'));
  const sc = M.food.scanner.start; M.food.scanner.start = () => new Promise(() => {});
  try { click(q('.m-tools [data-m="open-scan"]')); } finally { M.food.scanner.start = sc; }
  assert.strictEqual($("sheetT").textContent, "Scan barcode");
  const cancel = qa("#sheetB button").find(b => b.textContent === "Cancel");
  click(cancel);
  assert.ok(sheetOn() && $("sheetT").textContent === "New meal", "Cancel went back to the builder");
  assert.strictEqual(q('[data-m="mb"][data-k="name"]').value, "Scan snack");
  /* × on Add item itself */
  click(q('[data-m="mb-add"]'));
  click(q('[data-a="sheet-close"]'));
  await sleep(320);
  assert.ok(sheetOn() && $("sheetT").textContent === "New meal", "× on Add item went back to the builder");
  /* outside the builder, Cancel goes back to Log food (DY-12) */
  M.ui.close(); M.ui.draft = null; M.ui.tab = "diary"; M.ui.render();
  click(q('#cta [data-m="add"]'));
  M.food.scanner.start = () => new Promise(() => {});
  try { click(q('.m-tools [data-m="open-scan"]')); } finally { M.food.scanner.start = sc; }
  click(qa("#sheetB button").find(b => b.textContent === "Cancel"));
  assert.ok(sheetOn() && /^Log food/.test($("sheetT").textContent), $("sheetT").textContent);
  M.ui.close();
});

t("CPY-19 meal sheet: the button reads 'Add to <meal>' and follows the Meal picker", () => {
  reset();
  const m = M.meals.add({ name: "Egg plate", slot: "Breakfast", servingsMade: 1, items: [egg()] });
  openFoods("meals");
  click(q('[data-m="meal"][data-id="' + m.id + '"]'));
  assert.strictEqual($("m-meal-go").textContent, "Add to Breakfast");
  change(q('[data-m="meal-slot"]'), "Lunch");
  assert.strictEqual($("m-meal-go").textContent, "Add to Lunch");
  click($("m-meal-go"));
  assert.strictEqual(M.log.slotEntries(M.today(), "Lunch").length, 1);
  assert.strictEqual(lastToast(), "Added to Lunch");
});

t("UIF-02 builder: 'Servings it makes' at 0 → 'Enter how many servings it makes.', never saved as 1; save toasts say where it went", () => {
  reset(); newMeal("Zero servings");
  M.ui.draft.items.push(egg()); M.ui.openBuilder();
  input(q('[data-m="mb"][data-k="servingsMade"]'), "0");
  click(q('[data-m="mb-save"]'));
  assert.ok(sheetOn() && $("m-mb-msg").textContent === "Enter how many servings it makes.", $("m-mb-msg").textContent);
  assert.strictEqual(M.meals.list().length, 0);
  input(q('[data-m="mb"][data-k="servingsMade"]'), "2");
  click(q('[data-m="mb-save"]'));
  const m = M.meals.list()[0];
  assert.strictEqual(m.servingsMade, 2);
  assert.strictEqual(lastToast(), 'Saved "Zero servings" to Saved meals');
  /* editing says "Saved changes" */
  openFoods("meals");
  click(q('[data-m="meal"][data-id="' + m.id + '"]'));
  click(q('[data-m="meal-edit"]'));
  click(q('[data-m="mb-save"]'));
  assert.strictEqual(lastToast(), 'Saved changes to "Zero servings"');
});

t("UIF-05 editing a food keeps its other portions and exact per-100 g; Log to today with no change doesn't save", () => {
  reset();
  const f = M.foods.add({ name: "Protein bar", brand: "Kirkland", barcode: "012345678905", source: "off", serving: { qty: 1, unit: "bar", g: 60 }, per: { cal: 190, p: 21, c: 23, f: 7 }, per100g: { cal: 316, p: 35, c: 38, f: 12 }, alts: [{ label: "100 g", g: 100 }, { label: "1 oz", g: 28.35 }, { label: "1 box", g: 1200 }] });
  const before = M.cp(M.foods.get(f.id));
  openFoods("foods");
  click(q('[data-m="food"][data-id="' + f.id + '"]'));
  click(q('[data-m="ff-log"]'));
  assert.strictEqual(M.foods.get(f.id).updatedAt, before.updatedAt, "not saved again");
  assert.strictEqual($("m-det-go").textContent.indexOf("Add to"), 0, "went straight to logging");
  M.ui.close();
  openFoods("foods");
  click(q('[data-m="food"][data-id="' + f.id + '"]'));
  click(q('[data-m="ff-save"]'));
  const after = M.foods.get(f.id);
  same(after.alts.map(a => a.label), ["100 g", "1 oz", "1 box"], "portions kept");
  same([after.per100g.cal, after.per100g.p], [316, 35], "exact per-100 g kept");
  assert.strictEqual(lastToast(), "Saved changes");
  /* grams changed → per-100 g follows the new grams, portions stay */
  click(q('[data-m="food"][data-id="' + f.id + '"]'));
  input(q('[data-m="ff"][data-k="g"]'), "50");
  click(q('[data-m="ff-save"]'));
  const g2 = M.foods.get(f.id);
  near(g2.per100g.cal, 380, 0.6, "190 kcal in 50 g");
  assert.ok(g2.alts.some(a => a.label === "1 oz"));
});

t("UIF-07/UX1-14 food form checks: no negatives, serving > 0, calories needed (2nd tap saves 0), numbers that don't add up need a 2nd tap", () => {
  reset(); openFoods("foods");
  click(q('[data-m="food-new"]'));
  const save = () => click(q('[data-m="ff-save"]'));
  const msg = () => $("m-ff-msg").textContent;
  save();
  assert.strictEqual(msg(), "Give it a name.");
  input(q('[data-m="ff"][data-k="name"]'), "Negative test");
  input(q('[data-m="ff"][data-k="cal"]'), "-150");
  save();
  assert.strictEqual(msg(), "Numbers can't be below 0.");
  assert.strictEqual(doc.activeElement && doc.activeElement.dataset.k, "cal", "focus on the bad box");
  input(q('[data-m="ff"][data-k="cal"]'), "150");
  input(q('[data-m="ff"][data-k="qty"]'), "0");
  save();
  assert.strictEqual(msg(), "The serving must be more than 0.");
  input(q('[data-m="ff"][data-k="qty"]'), "1");
  /* 150 kcal with 50 P + 50 C (= 400) → second tap */
  input(q('[data-m="ff"][data-k="p"]'), "50"); input(q('[data-m="ff"][data-k="c"]'), "50");
  save();
  assert.ok(/don't match protein, carbs and fat \(about 400\)/.test(msg()), msg());
  assert.ok(/Tap again to save anyway/.test(q('[data-m="ff-save"]').textContent));
  assert.strictEqual(M.foods.list().length, 0);
  save();
  assert.ok(!sheetOn() && M.foods.list().length === 1, "second tap saves");
  /* all blank → 'Type the calories from the label.' */
  click(q('[data-m="food-new"]'));
  input(q('[data-m="ff"][data-k="name"]'), "Mystery bar");
  save();
  assert.strictEqual(msg(), "Type the calories from the label.");
  assert.strictEqual(M.foods.list().length, 1);
  /* calories alone are enough */
  input(q('[data-m="ff"][data-k="cal"]'), "200");
  save();
  assert.ok(!sheetOn() && M.foods.list().length === 2, "calories only saves in one tap: " + msg());
  click(q('[data-m="food-new"]'));
  input(q('[data-m="ff"][data-k="name"]'), "Low-carb tortilla");
  /* fiber-heavy label that really adds up (low-carb tortilla) saves in one tap */
  input(q('[data-m="ff"][data-k="cal"]'), "50"); input(q('[data-m="ff"][data-k="p"]'), "5"); input(q('[data-m="ff"][data-k="c"]'), "19"); input(q('[data-m="ff"][data-k="fiber"]'), "15"); input(q('[data-m="ff"][data-k="f"]'), "2");
  save();
  assert.ok(!sheetOn(), "fiber counted: " + msg());
});

t("UIF-08/09/14/24 drafts: + New meal keeps its own draft apart from 'Save Lunch as a meal', across reloads; Start over; Cancel with items is two taps", () => {
  reset();
  newMeal("My half-built shake");
  M.ui.draft.items.push(egg()); M.ui.openBuilder();
  input(q('[data-m="mb"][data-k="desc"]'), "Draft I will finish later");
  click(q('[data-a="sheet-close"]'));
  /* Diary → Lunch … → Save Lunch as a meal */
  M.log.add(M.today(), { slot: "Lunch", name: "Turkey sandwich", servings: 1, servingLabel: "1 sandwich", per: { cal: 450, p: 30, c: 40, f: 15 } });
  M.ui.tab = "diary"; M.ui.render();
  click(q('[data-m="slot-menu"][data-slot="Lunch"]'));
  click(q('[data-m="slot-savemeal"]'));
  same(M.ui.draft.items.map(i => i.name), ["Turkey sandwich"]);
  click(q('[data-a="sheet-close"]'));
  /* + New meal comes back to the shake, not the Lunch items */
  openFoods("meals");
  click(q('[data-m="meal-new"]'));
  assert.strictEqual(q('[data-m="mb"][data-k="name"]').value, "My half-built shake");
  same(M.ui.draft.items.map(i => i.name), ["Egg"]);
  assert.ok(/Unsaved meal from before/.test($("sheetB").textContent));
  /* "reload": memory gone, the phone still has it */
  click(q('[data-a="sheet-close"]'));
  M.ui.draft = null;
  click(q('[data-m="meal-new"]'));
  assert.strictEqual(q('[data-m="mb"][data-k="name"]').value, "My half-built shake", "restored after a reload");
  assert.strictEqual(M.ui.draft.desc, "Draft I will finish later");
  /* Cancel with items: first tap arms */
  click(q('[data-m="mb-cancel"]'));
  assert.ok(sheetOn() && /Tap again/.test(q('[data-m="mb-cancel"]').textContent));
  /* Start over (two taps with content) */
  click(q('[data-m="mb-fresh"]')); click(q('[data-m="mb-fresh"]'));
  assert.strictEqual(q('[data-m="mb"][data-k="name"]').value, "");
  assert.strictEqual(M.ui.draft.items.length, 0);
  assert.strictEqual(ctx.localStorage.getItem(M.ui._.draftKey()), null, "saved draft cleared");
  click(q('[data-m="mb-cancel"]'));
  assert.ok(!sheetOn() && M.ui.draft === null, "empty draft cancels in one tap");
});

t("UIF-22 new meals start at the time-of-day slot; 'Any' reads 'Any time' in the builder and the Foods list", () => {
  reset(); newMeal("Anytime snack");
  assert.strictEqual(M.ui.draft.slot, M.defaultSlot());
  const sel = q('[data-m="mb"][data-k="slot"]');
  assert.ok(qa("option", sel).some(o => o.value === "Any" && o.textContent === "Any time"));
  assert.strictEqual(sel.closest("label").querySelector("span").textContent, "When");
  change(sel, "Any");
  M.ui.draft.items.push(egg());
  click(q('[data-m="mb-save"]'));
  assert.strictEqual(M.meals.list()[0].slot, "Any");
  assert.ok(qa("h2.sec").some(h => /^Any time · \d+$/.test(h.textContent)), qa("h2.sec").map(h => h.textContent).join("|"));
});

t("UIF-10 fixing a food's numbers updates saved meals that use it ('Updated 1 saved meal')", () => {
  reset();
  const f = M.foods.add({ name: "Fage 0%", brand: "Fage", serving: { qty: 1, unit: "container", g: 170 }, per: { cal: 90, p: 81, c: 5, f: 0 } });
  const m = M.meals.add({ name: "Yogurt bowl", slot: "Breakfast", servingsMade: 1, items: [{ name: f.name, brand: f.brand, servings: 2, servingLabel: "1 container (170 g)", g: 170, per: f.per, foodId: f.id }] });
  const logged = M.log.add(M.today(), { slot: "Breakfast", name: f.name, servings: 1, servingLabel: "1 container (170 g)", g: 170, per: f.per, foodId: f.id });
  openFoods("foods");
  click(q('[data-m="food"][data-id="' + f.id + '"]'));
  input(q('[data-m="ff"][data-k="p"]'), "18");
  click(q('[data-m="ff-save"]'));
  assert.strictEqual(lastToast(), "Saved changes. Updated 1 saved meal.");
  const m2 = M.meals.get(m.id);
  assert.strictEqual(m2.items[0].per.p, 18);
  near(m2.per.p, 36, 0.01, "2 containers");
  assert.strictEqual(entries().find(e => e.id === logged.id).per.p, 81, "logged days never change");
});

t("UIF-11/CPY-02 cook question: 'Does the weight change when cooked?' shows for meat / rice names, opens on request, rows in plain words", () => {
  reset(); openFoods("foods");
  click(q('[data-m="food-new"]'));
  input(q('[data-m="ff"][data-k="name"]'), "Greek yogurt");
  assert.ok($("m-ff-cook").hidden && !$("m-ff-cookopen").hidden, "hidden for yogurt, with an opener");
  click($("m-ff-cookopen"));
  assert.ok(!$("m-ff-cook").hidden && $("m-ff-cookopen").hidden);
  same(qa('[data-m="ff-cook"]').map(b => b.textContent), ["No", "Meat or fishshrinks", "Rice or pastagrows"]);
  M.ui.close();
  click(q('[data-m="food-new"]'));
  input(q('[data-m="ff"][data-k="name"]'), "Jasmine rice");
  assert.ok(!$("m-ff-cook").hidden, "rice asks right away");
  click(q('[data-m="ff-cook"][data-v="grain"]'));
  assert.ok(/Cooked weight is about/.test($("m-ff-cookrow").textContent) && /times the dry weight/.test($("m-ff-cookrow").textContent));
  assert.strictEqual(q('[data-m="ff-cook"][data-v="grain"]').getAttribute("aria-pressed"), "true");
});

t("UIF-13/WK-04 batch cooked weight far off the raw total → a 'Use 5 lb' button, and a second tap to save", () => {
  reset(); newMeal("Chili pot");
  M.ui.draft.items.push({ name: "Ground beef 90/10", servings: 32, servingLabel: "1 oz raw", g: OZ, per: { cal: 49.9, p: 5.7, c: 0, f: 2.8 }, state: "raw", cook: { y: 0.74, word: "raw" } }, { name: "Beans", servings: 4, servingLabel: "1 cup (172 g)", g: 172, per: { cal: 227, p: 15, c: 41, f: 1 } });
  M.ui.openBuilder();
  click(q('[data-m="mb-batch"]'));
  input(q('[data-m="mb-cooked"]'), "5");
  assert.ok(!$("m-mb-warn").hidden && /That's 5 oz cooked from/.test($("m-mb-warn").textContent), $("m-mb-warn").textContent);
  const use = q('#m-mb-warn [data-m="mb-cunit"]');
  assert.ok(use && use.textContent === "Use 5 lb" && use.dataset.v === "lb", use && use.textContent);
  click(q('[data-m="mb-save"]'));
  assert.ok(sheetOn() && M.meals.list().length === 0, "first tap only warns");
  assert.ok(/Did you mean lb\?/.test($("m-mb-msg").textContent));
  click(q('[data-m="mb-save"]'));
  assert.strictEqual(M.meals.list().length, 1, "second tap saves");
  /* a sensible weight never warns */
  newMeal("Chili pot 2");
  M.ui.draft.items.push({ name: "Beans", servings: 4, servingLabel: "1 cup (172 g)", g: 172, per: { cal: 227, p: 15, c: 41, f: 1 } });
  M.ui.openBuilder();
  click(q('[data-m="mb-batch"]'));
  input(q('[data-m="mb-cooked"]'), "24");
  assert.ok($("m-mb-warn").hidden);
  M.ui.close();
  /* WK-04: tapping "Use 5 lb" keeps the 5 (never 5 oz → 0.31 lb), and the warning goes away */
  reset(); newMeal("Chili pot 3");
  M.ui.draft.items.push({ name: "Ground beef 90/10", servings: 32, servingLabel: "1 oz raw", g: OZ, per: { cal: 49.9, p: 5.7, c: 0, f: 2.8 }, state: "raw", cook: { y: 0.74, word: "raw" } }, { name: "Beans", servings: 4, servingLabel: "1 cup (172 g)", g: 172, per: { cal: 227, p: 15, c: 41, f: 1 } });
  M.ui.openBuilder();
  click(q('[data-m="mb-batch"]'));
  input(q('[data-m="mb-cooked"]'), "5");
  click(q('#m-mb-warn [data-m="mb-cunit"]'));
  assert.strictEqual(M.ui.draft.batch.unit, "lb");
  assert.strictEqual(M.ui.draft.batch.qty, 5);
  assert.strictEqual(q('[data-m="mb-cooked"]').value, "5");
  assert.ok($("m-mb-warn").hidden, "no warning at 5 lb");
  M.ui.close();
});

t("WK-03/WK-05 a batch weighed in grams saves batch.unit 'g' and reopens in grams everywhere (decision 6)", () => {
  reset(); newMeal("Rice pot");
  M.ui.draft.items.push({ name: "Rice", servings: 700, servingLabel: "1 g dry", g: 1, per: { cal: 3.65, p: 0.07, c: 0.8, f: 0.006 }, state: "raw", cook: { y: 3, word: "dry" } });
  M.ui.openBuilder();
  click(q('[data-m="mb-batch"]'));
  click(q('#m-mb-batch [data-m="mb-cunit"][data-v="g"]'));
  input(q('[data-m="mb-cooked"]'), "2250");
  assert.ok($("m-mb-warn").hidden, $("m-mb-warn").textContent);
  assert.ok(/The raw items weigh 700 g\./.test($("m-mb-raw").textContent), $("m-mb-raw").textContent);
  assert.ok(/^Per 100 g cooked/.test($("m-mb-live").textContent), $("m-mb-live").textContent);
  click(q('[data-m="mb-save"]'));
  const m = M.meals.list().find(x => x.name === "Rice pot");
  assert.ok(m && m.batch && m.batch.cookedG === 2250 && m.batch.unit === "g", JSON.stringify(m && m.batch));
  /* Foods list and the meal sheet say grams */
  openFoods("meals");
  assert.ok(/Batch · 2250 g cooked/.test($("app").textContent), "Foods list in grams");
  assert.ok(/per 100 g cooked/.test($("app").textContent));
  click(q('[data-m="meal"][data-id="' + m.id + '"]'));
  assert.ok(/Batch · 2250 g cooked/.test($("sheetB").textContent), "meal sheet in grams");
  /* edit: the cooked weight reopens as 2250 g, and saving twice never drifts */
  click(q('[data-m="meal-edit"]'));
  assert.strictEqual(M.ui.draft.batch.unit, "g");
  assert.strictEqual(q('[data-m="mb-cooked"]').value, "2250");
  assert.strictEqual(q('#m-mb-batch [data-m="mb-cunit"].on').dataset.v, "g");
  click(q('[data-m="mb-save"]'));
  click(q('[data-m="meal"][data-id="' + m.id + '"]')); click(q('[data-m="meal-edit"]')); click(q('[data-m="mb-save"]'));
  assert.strictEqual(M.meals.get(m.id).batch.cookedG, 2250, "no drift");
  assert.strictEqual(M.meals.get(m.id).batch.unit, "g");
  /* an oz batch stays in oz */
  M.meals.update(m.id, { batch: { cookedG: 51 * OZ, unit: "oz" } });
  if (M.meals.get(m.id).batch.unit !== "oz") M.meals.get(m.id).batch.unit = "oz";
  M.ui.render();
  assert.ok(/Batch · 51 oz cooked/.test($("app").textContent), $("app").textContent.slice(0, 300));
});

t("UX1-08/OFL-10 after a label read the numbers are in the form: 'Type it in instead' goes away; OCR badge in plain words", async () => {
  reset();
  const saved = M.food.label.fromImage;
  M.food.label.fromImage = () => Promise.resolve({ method: "ocr", food: { name: "Tortillas", serving: { qty: 1, unit: "tortilla", g: 459 }, per: { cal: 110, p: 3, c: 18, f: 3 } }, warning: "" });
  try {
    click(q('[data-m="add"][data-slot="Lunch"]'));
    click(q('[data-m="open-label"]'));
    assert.ok(!$("m-label-type").hidden);
    assert.strictEqual($("m-label-status").getAttribute("role"), "status");
    const inp = q('[data-m="label-file"]');
    Object.defineProperty(inp, "files", { value: [{ name: "x.jpg" }] });
    inp.dispatchEvent(new w.Event("change", { bubbles: true }));
    await sleep(20);
    assert.ok($("m-label-type").hidden, "one way to type, and it keeps the numbers");
    assert.ok(/Read by your phone\. Check the numbers\./.test($("m-label-form").textContent));
    assert.ok(/1 tortilla = 459 g\?/.test($("m-ff-gwarn").textContent), "grams flagged after the read");
    assert.strictEqual(q('[data-m="ff-save-add"]').textContent, "Save & add to Lunch");
    click(q('[data-m="ff-save-add"]'));
    assert.ok(!sheetOn() && entries().some(e => e.name === "Tortillas" && e.slot === "Lunch"), "UX1-07: logged right away");
    assert.strictEqual(lastToast(), "Added to Lunch");
  } finally { M.food.label.fromImage = saved; }
});

t("UX1-13/CPY-19 'Add to Dinner' on a meal idea logs ONE entry named after the idea, items kept on it", async () => {
  reset();
  M.ui.render();
  click(q('[data-m="suggest"]'));
  click(q('[data-m="sug-slot"][data-v="Dinner"]'));
  await sleep(30);
  const card = qa(".m-sug").find(c => c.querySelector('[data-m="sug-save"]'));
  assert.ok(card, "a built-in idea");
  const name = card.querySelector("h3").textContent, n = card.querySelectorAll(".m-sugitems li").length;
  assert.strictEqual(card.querySelector('[data-m="sug-log"]').textContent, "Add to Dinner");
  click(card.querySelector('[data-m="sug-log"]'));
  const list = M.log.slotEntries(M.today(), "Dinner");
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, name);
  assert.strictEqual(list[0].items.length, n);
  near(list[0].per.cal, M.foodMath.sum(list[0].items).cal, 0.5);
  assert.strictEqual(lastToast(), "Added " + name + " to Dinner");
  /* the entry's items survive a save + reload */
  M.save(); M.load();
  const again = M.log.slotEntries(M.today(), "Dinner")[0];
  assert.ok(again && Array.isArray(again.items) && again.items.length === n, "items kept after reload");
});

t("UX2-12 Suggest offers a batch meal sized to the protein left, logged by cooked weight", async () => {
  reset();
  const m = M.meals.add({ name: "Chicken veggie bake", slot: "Dinner", servingsMade: 1, batch: { cookedG: 80 * OZ }, items: [{ name: "Chicken breast", servings: 48, servingLabel: "1 oz raw", g: OZ, per: { cal: 34, p: 6.4, c: 0, f: 0.8 }, state: "raw", cook: { y: 0.73, word: "raw" } }, { name: "Broccoli", servings: 4, servingLabel: "1 cup (91 g)", g: 91, per: { cal: 31, p: 2.5, c: 6, f: 0.3 } }] });
  const t0 = P.targets;
  /* eat most of the day: 40 g protein left */
  M.log.add(M.today(), { slot: "Lunch", name: "Stuff", servings: 1, servingLabel: "1 serving", per: { cal: t0.cal - 700, p: t0.p - 40, c: 50, f: 20 } });
  M.ui.render();
  click(q('[data-m="suggest"]'));
  click(q('[data-m="sug-slot"][data-v="Dinner"]'));
  await sleep(30);
  const card = qa(".m-sug").find(c => /Chicken veggie bake/.test(c.textContent));
  assert.ok(card, "batch meal offered");
  assert.ok(/Your batch/.test(card.textContent));
  const s = M.ui._.state().sug.list.find(x => x.mealId === m.id);
  const pG = m.per.p / m.batch.cookedG;
  near(s.grams * pG, 40, 3.5, "portion covers the protein left");
  const btn = card.querySelector('[data-m="sug-log"]');
  assert.ok(/^Add \d+(\.\d)? oz to Dinner$/.test(btn.textContent), btn.textContent);
  click(btn);
  const e = M.log.slotEntries(M.today(), "Dinner")[0];
  assert.ok(e && e.mealId === m.id && e.state === "cooked" && e.servingLabel === "1 oz cooked", JSON.stringify(e));
  near(e.servings * OZ, s.grams, 0.5);
});

t("UX2-13/CPY-07 idea tags and header: 'no cook' only when tagged no-cook, 'Either' hidden, 'Left for today', negatives read 'over'", async () => {
  reset();
  const t0 = P.targets;
  M.log.add(M.today(), { slot: "Lunch", name: "Big day", servings: 1, servingLabel: "1 serving", per: { cal: t0.cal + 355, p: t0.p + 6, c: 10, f: 10 } });
  M.meals.add({ name: "Pork & rice", slot: "Dinner", servingsMade: 1, items: [{ name: "Pork", servings: 1, servingLabel: "1 serving", per: { cal: 100, p: 20, c: 0, f: 2 } }] });
  M.ui.render();
  click(q('[data-m="suggest"]'));
  await sleep(30);
  const head = q(".m-sughd").textContent;
  assert.ok(/Left for today/.test(head), head);
  const cal = q(".m-sughd .stat"), pro = qa(".m-sughd .stat")[1];
  assert.ok(/^355\s*over/.test(cal.querySelector(".v").textContent), cal.textContent);
  assert.ok(/^6g over/.test(pro.querySelector(".v").textContent), pro.textContent);
  click(q('[data-m="sug-slot"][data-v="Dinner"]'));
  await sleep(30);
  const tags = qa(".m-sug").map(c => Array.from(c.querySelectorAll(".tag")).map(x => x.textContent));
  assert.ok(!tags.some(tg => tg.indexOf("Either") >= 0), JSON.stringify(tags));
  const mine = qa(".m-sug").find(c => /Pork & rice/.test(c.textContent));
  if (mine) assert.ok(!/no cook/.test(mine.textContent), "your own meal isn't 'no cook'");
  const s = M.ui._.state().sug;
  s.list.forEach((x, i) => {
    const has = /no cook/.test(qa(".m-sug")[i].textContent);
    assert.strictEqual(has, !(Number(x.prepMin) > 0) && Array.isArray(x.tags) && x.tags.indexOf("no-cook") >= 0, x.name);
  });
  /* another day names the day */
  M.ui.close(); M.ui.date = M.addDays(M.today(), -1); M.ui.render();
  click(q('[data-m="suggest"]'));
  assert.ok(/Left for Yesterday/.test(q(".m-sughd").textContent));
  M.ui.close(); M.ui.date = M.today();
});

t("CPY-09/UID-27 describe / meal rows show the whole amount ('2 large eggs (100 g)')", () => {
  const wa = M.ui._.wholeAmount;
  assert.strictEqual(wa({ servings: 2, servingLabel: "1 large egg (50 g)" }), "2 large eggs (100 g)");
  assert.strictEqual(wa({ servings: 2, servingLabel: "1 slice (50 g)" }), "2 slices (100 g)");
  assert.strictEqual(wa({ servings: 2, servingLabel: "1/2 cup (74 g)" }), "1 cup (148 g)");
  assert.strictEqual(wa({ servings: 1.5, servingLabel: "1 cup (240 g)" }), "1.5 cups (360 g)");
  assert.strictEqual(wa({ servings: 150, servingLabel: "1 g" }), "150 g");
  assert.strictEqual(wa({ servings: 2, servingLabel: "1 medium (118 g)" }), "2 medium (236 g)");
  assert.strictEqual(wa({ servings: 1, servingLabel: "1 serving" }), "1 serving");
  assert.strictEqual(wa({ servings: 3, servingLabel: "1 patty" }), "3 patties");
  assert.strictEqual(wa({ servings: 2, servingLabel: "1 cup, chopped (160 g)" }), "2 cups, chopped (320 g)");
});

t("describe rows wrap only after a '·' (never 'P 13' / '· C 1' split across lines)", async () => {
  reset();
  click(q('#cta [data-m="add"]'));
  click(q('[data-m="open-describe"]'));
  $("m-desc").value = "2 eggs";
  click(q('[data-m="describe-go"]'));
  await sleep(30);
  const t = q("#m-items .m-item .t").textContent.split(String.fromCharCode(160)).join("_");   /* no-break spaces shown as _ */
  assert.ok(/^2 large eggs \(100 g\)_· P_\d+_· C_\d+_· F_\d+_· [\d,]+_(k?cal)$/.test(t), t);   /* decision 4: "cal" */
  M.ui.close();
});

t("UIF-21 Foods search matches item names; search box has no autocorrect; UIF-16 cleared after saving a meal", () => {
  reset();
  M.meals.add({ name: "Morning bowl", slot: "Breakfast", servingsMade: 1, items: [{ name: "Blueberries", servings: 1, servingLabel: "1 cup (148 g)", per: { cal: 84, p: 1, c: 21, f: 0.5 } }] });
  M.meals.add({ name: "Steak night", slot: "Dinner", servingsMade: 1, items: [{ name: "Ribeye", servings: 1, servingLabel: "12 oz", per: { cal: 880, p: 70, c: 0, f: 66 } }] });
  openFoods("meals");
  const box = q('[data-m="foods-q"]');
  ["autocorrect", "spellcheck", "autocapitalize"].forEach(a => assert.ok(/off|false/.test(box.getAttribute(a)), a));
  assert.strictEqual(box.getAttribute("enterkeyhint"), "search");
  M.ui.foodsQ = "blueberry"; M.ui.render();
  const rows = qa('[data-m="meal"]').map(r => r.querySelector(".n").textContent);
  same(rows, ["Morning bowl"], "found by an item, singular or plural: " + rows);
  /* saving a new meal clears the search so it shows */
  click(q('[data-m="meal-new"]'));
  input(q('[data-m="mb"][data-k="name"]'), "Oat-free plate");
  M.ui.draft.items.push(egg());
  click(q('[data-m="mb-save"]'));
  assert.strictEqual(M.ui.foodsQ, "");
  assert.ok(qa('[data-m="meal"]').some(r => /Oat-free plate/.test(r.textContent)));
});

/* ================================================================ P3 */
t("IOS-06/IOS-12 names and live status lines: scan / label / photo / describe statuses, item steppers named", async () => {
  reset();
  click(q('#cta [data-m="add"]'));
  const sc = M.food.scanner.start; M.food.scanner.start = () => new Promise(() => {});
  click(q('[data-m="open-scan"]'));
  M.food.scanner.start = sc;
  assert.strictEqual($("m-scan-status").getAttribute("role"), "status");
  assert.strictEqual($("m-code").getAttribute("aria-label"), "Barcode numbers");
  M.ui.close();
  click(q('#cta [data-m="add"]'));
  click(q('[data-m="open-describe"]'));
  assert.strictEqual($("m-desc-status").getAttribute("role"), "status");
  assert.ok(/What did you eat\?/.test($("sheetB").textContent) && q('[data-m="describe-go"]').textContent === "Find foods");
  $("m-desc").value = "2 eggs";
  click(q('[data-m="describe-go"]'));
  await sleep(30);
  const row = q("#m-items .m-item");
  assert.ok(/^Less /.test(row.querySelector('[data-m="item-step"][data-v="-1"]').getAttribute("aria-label")));
  assert.ok(/^Remove Egg/i.test(row.querySelector('[data-m="item-del"]').getAttribute("aria-label")));
  assert.ok(/^2 large eggs \(100 g\)/.test(row.querySelector(".t").textContent), row.querySelector(".t").textContent);
  M.ui.close();
});

t("OFL-04 camera up but the reader still loading: 'Loading the scanner…'", async () => {
  reset();
  click(q('#cta [data-m="add"]'));
  const sc = M.food.scanner.start, en = M.food.scanner.engine;
  M.food.scanner.start = el => { const v = doc.createElement("video"); v.srcObject = {}; el.appendChild(v); return new Promise(() => {}); };
  M.food.scanner.engine = () => null;
  try {
    click(q('[data-m="open-scan"]'));
    await sleep(900);
    assert.strictEqual($("m-scan-status").textContent, "Loading the scanner…");
  } finally { M.food.scanner.start = sc; M.food.scanner.engine = en; M.ui.close(); }
});

t("UIF-15 Add item for a meal has no meal pills; Log food keeps them", () => {
  reset(); newMeal("Pill test");
  click(q('[data-m="mb-add"]'));
  assert.strictEqual($("sheetT").textContent, "Add item");
  assert.ok(!q('[data-m="add-slot"]'), "no Breakfast / Lunch pills while picking for a meal");
  M.ui.close(); reset();
  click(q('#cta [data-m="add"]'));
  assert.ok(qa('[data-m="add-slot"]').length >= 4, "Log food still has the meal pills");
  M.ui.close();
});

/* ================================================================ Nick's chicken rule (RESUME2) */
/* The Kirkland breast carries alwaysRaw: true (F7). Until that lands, the test sets it itself. */
const withAlwaysRaw = async fn => {
  const f = M.foods.get("g_kirkland_organic_chicken"); assert.ok(f && M.cook.of(f), "Kirkland chicken is a raw/cooked food");
  const had = Object.prototype.hasOwnProperty.call(f, "alwaysRaw"), was = f.alwaysRaw;
  f.alwaysRaw = true;
  try { await fn(f); } finally { if (had) f.alwaysRaw = was; else delete f.alwaysRaw; }
};
const pickFood = async (f, text) => {
  input($("m-search"), text);
  let i = -1;
  for (let n = 0; n < 40 && i < 0; n++) { await sleep(50); i = M.ui._.state().add.list.findIndex(r => r.id === f.id || r.foodId === f.id); }
  assert.ok(i >= 0, "the chicken is in the results");
  click(q('[data-m="pick"][data-i="' + i + '"]'));
};

t("alwaysRaw: chicken added to a saved meal or a batch opens in raw grams (US units too)", async () => {
  await withAlwaysRaw(async f => {
    for (const batch of [false, true]) {
      reset(); newMeal(batch ? "Chicken prep" : "Chicken bowl");
      if (batch) click(q('[data-m="mb-batch"]'));
      click(q('[data-m="mb-add"]'));
      await pickFood(f, "chicken");
      assert.strictEqual(q('[data-m="det-unit"]').value, "g-raw", "opens in g raw, not oz");
      assert.strictEqual(q('[data-m="det-qty"]').value, String(Math.round(f.serving.g)), "one serving, in raw grams");
      assert.ok(/raw/.test($("m-det-amt").textContent), $("m-det-amt").textContent);
      click($("m-det-go"));
      assert.ok(sheetOn() && $("sheetT").textContent === "New meal", "back in the builder");
      const it = M.ui.draft.items[0];
      assert.strictEqual(it.state, "raw"); assert.strictEqual(it.servingLabel, "1 g raw");
      near(it.servings, f.serving.g, 0.5, "raw grams");
      assert.strictEqual(M.ui.draft.batch && M.ui.draft.batch.on, batch ? true : M.ui.draft.batch && M.ui.draft.batch.on, "batch switch kept");
    }
    /* Log food (not a meal) is F2a's: no change there */
    reset(); click(q('#cta [data-m="add"]'));
    await pickFood(f, "chicken");
    assert.notStrictEqual(M.ui._.state().det.mode, "pick");
    M.ui.close();
  });
});

t("alwaysRaw: cooked or oz chicken from describe / photo / ideas lands in the meal as raw grams; other foods untouched", async () => {
  await withAlwaysRaw(async f => {
    reset(); newMeal("Chicken bowl");
    click(q('[data-m="mb-add"]'));
    const y = M.cook.of(f).y, us = M.cook.unitsFor(f, "us");
    const one = k => us.find(o => o.key === k);
    const rice = M.foods.get("g_white_rice"), rOpt = rice && M.cook.of(rice) ? M.cook.unitsFor(rice, "us").find(o => o.state === "cooked") : null;
    const list = [
      { name: f.name, foodId: f.id, state: "cooked", cook: { y, word: "raw" }, servingLabel: "1 g cooked", g: 1, per: one("g-cooked").per, servings: 150 },
      { name: f.name, foodId: f.id, state: "raw", cook: { y, word: "raw" }, servingLabel: "1 oz raw", g: one("oz-raw").g, per: one("oz-raw").per, servings: 6 }
    ];
    if (rOpt) list.push({ name: rice.name, foodId: rice.id, state: "cooked", cook: { y: M.cook.of(rice).y, word: M.cook.of(rice).word }, servingLabel: "1 " + rOpt.label, g: rOpt.g, per: rOpt.per, servings: 1 });
    M.ui._.state().add.onPick.many(list);
    const its = M.ui.draft.items;
    assert.strictEqual(its[0].servingLabel, "1 g raw"); assert.strictEqual(its[0].state, "raw");
    assert.strictEqual(its[0].servings, Math.round(150 / y), "150 g cooked → raw grams");
    near(M.foodMath.scale(its[0].per, its[0].servings).p, M.foodMath.scale(list[0].per, 150).p, 1, "same protein either way");
    assert.strictEqual(its[1].servingLabel, "1 g raw"); assert.strictEqual(its[1].servings, Math.round(6 * OZ), "6 oz raw → 170 g raw");
    if (rOpt) same(its[2], list[2], "rice (not alwaysRaw) is left as it was");
    assert.ok(/g raw/.test(qa('[data-m="mb-item"]')[0].textContent), qa('[data-m="mb-item"]')[0].textContent);
    M.ui.close();
  });
});

t("batch meal sheet: the portion reads cooked only ('4 oz cooked'), never a raw weight", () => {
  reset();
  const m = M.meals.add({ name: "Chili pot", slot: "Dinner", servingsMade: 1, batch: { cookedG: 80 * OZ }, items: [
    { name: "Ground beef 90/10", servings: 32, servingLabel: "1 oz raw", g: OZ, per: { cal: 49.9, p: 5.7, c: 0, f: 2.8 }, state: "raw", cook: { y: 0.74, word: "raw" } },
    { name: "Black beans", servings: 4, servingLabel: "1 cup (172 g)", g: 172, per: { cal: 227, p: 15, c: 41, f: 1 } }] });
  M.ui.tab = "foods"; M.ui.foodsSeg = "meals"; M.ui.render();
  click(q('[data-m="meal"][data-id="' + m.id + '"]'));
  input(q('[data-m="det-qty"]'), "4");
  assert.strictEqual($("m-det-amt").textContent, "4 oz cooked");
  click(q('[data-m="det-useg"][data-v="g-cooked"]'));
  assert.ok(/^\d+ g cooked$/.test($("m-det-amt").textContent), $("m-det-amt").textContent);
  assert.ok(!/raw/.test($("sheetB").querySelector("#m-det-box").textContent), "no raw weight on a batch portion");
  M.ui.close(); M.meals.remove(m.id);
});

t("alwaysRaw: 'Save as meal' on an idea saves the chicken in raw grams", async () => {
  await withAlwaysRaw(async f => {
    reset();
    click(q('[data-m="suggest"]'));
    click(q('[data-m="sug-slot"][data-v="Dinner"]'));
    await sleep(30);
    const btn = q('[data-m="sug-save"][data-i="0"]'); assert.ok(btn, "first idea has Save as meal");
    const y = M.cook.of(f).y, oz = M.cook.unitsFor(f, "us").find(o => o.key === "oz-raw");
    M.ui._.state().sug.list[0] = { name: "Chicken plate", desc: "", source: "idea", items: [
      { name: f.name, foodId: f.id, state: "raw", cook: { y, word: "raw" }, servingLabel: "1 oz raw", g: oz.g, per: oz.per, servings: 6 },
      { name: "Broccoli", servingLabel: "1 cup (91 g)", g: 91, per: { cal: 31, p: 2.5, c: 6, f: 0.3 }, servings: 1 }] };
    click(btn);
    const m = M.meals.list().find(x => x.name === "Chicken plate"); assert.ok(m, "saved");
    assert.strictEqual(m.items[0].servingLabel, "1 g raw"); assert.strictEqual(m.items[0].servings, Math.round(6 * OZ));
    assert.strictEqual(m.items[1].servingLabel, "1 cup (91 g)", "other foods untouched");
    M.ui.close();
  });
});

t("alwaysRaw: ideas, saved meals and the builder show the chicken in raw grams, even in US units", async () => {
  await withAlwaysRaw(async f => {
    reset();
    const wa = M.ui._.wholeAmount, c = M.cook.of(f), ck = { y: c.y, word: c.word };
    const oz = M.cook.unitsFor(f, "us").find(o => o.key === "oz-raw");
    const it = (label, g, servings, state) => ({ name: f.name, foodId: f.id, servingLabel: label, g, per: { cal: 1, p: 0, c: 0, f: 0 }, state: state || "raw", cook: ck, servings });
    assert.strictEqual(wa(it("1 breast (175 g raw)", 175)), "1 breast (175 g raw)");
    assert.strictEqual(wa(it("1/2 breast (88 g raw)", 88)), "½ breast (88 g raw)");
    assert.strictEqual(wa(it("1 breast (175 g raw)", 175, 2)), "2 breasts (350 g raw)");
    assert.ok(/^170 g raw \(\d+ g cooked\)$/.test(wa(it("1 oz raw", oz.g, 6))), wa(it("1 oz raw", oz.g, 6)));
    assert.ok(/^\d+ g raw \(150 g cooked\)$/.test(wa(it("1 g cooked", 1, 150, "cooked"))), wa(it("1 g cooked", 1, 150, "cooked")));
    /* K8 (F1): chicken labels read in grams whatever the units; before K8 describe rows kept oz */
    assert.ok(/^(6 oz raw|170 g raw)/.test(wa(it("1 oz raw", oz.g, 6), true)), wa(it("1 oz raw", oz.g, 6), true));
    /* a meal saved before tonight with "6 oz raw" chicken reads in raw grams on its sheet */
    const m = M.meals.add({ name: "Old chicken bowl", slot: "Lunch", servingsMade: 1, items: [it("1 oz raw", oz.g, 6)] });
    M.ui.tab = "foods"; M.ui.foodsSeg = "meals"; M.ui.render();
    click(q('[data-m="meal"][data-id="' + m.id + '"]'));
    assert.ok(/170 g raw/.test($("sheetB").textContent), $("sheetB").textContent);
    M.ui.close(); M.meals.remove(m.id);
    /* other cook foods keep the person's units */
    const beef = { name: "Ground beef", servingLabel: "1 oz raw", g: OZ, per: { cal: 50 }, state: "raw", cook: { y: 0.74, word: "raw" }, servings: 6 };
    assert.ok(/^6 oz raw/.test(wa(beef)), wa(beef));
  });
});

/* ================================================================ C2b (partner check) */
t("C2b barcode hit with calories but no protein, carbs or fat: the amount screen says so in plain words", async () => {
  reset();
  const saved = M.food.lookup;
  const WARN = "Open Food Facts has calories but no protein, carbs or fat for this. Check them against the label.";
  M.food.lookup = code => Promise.resolve({ status: "found", code, saved: false, warning: WARN, food: { id: "off_" + code, name: "Sparkling tea", brand: "Acme", barcode: code, source: "off", serving: { qty: 1, unit: "can", g: 355 }, per: { cal: 90, p: 0, c: 0, f: 0 }, per100g: { cal: 25, p: 0, c: 0, f: 0 }, alts: [{ label: "100 g", g: 100 }] } });
  try {
    M.ui.openAdd({ slot: "Lunch", date: M.today() });
    const sc = M.food.scanner.start; M.food.scanner.start = () => new Promise(() => {});
    click(q('.m-tools [data-m="open-scan"]'));
    M.food.scanner.start = sc;
    $("m-code").value = "012345678905";
    click(q('[data-m="code-lookup"]'));
    await sleep(20);
    const w = $("m-off-warn");
    assert.ok(w && w.textContent === WARN, "warning shown: " + (w && w.textContent));
    assert.strictEqual(w.getAttribute("role"), "status");
    assert.ok($("m-det-go"), "still on the amount screen, can log it");
    /* changing the unit re-draws the amount box; the warning stays */
    const sel = q('[data-m="det-unit"]'); if (sel) { change(sel, sel.options[sel.options.length - 1].value); assert.ok($("m-off-warn"), "warning kept after a unit change"); }
    M.ui.close();
    /* a normal hit shows no warning */
    M.food.lookup = code => Promise.resolve({ status: "found", code, saved: true, food: { id: "off_" + code, name: "Yogurt", brand: "", barcode: code, source: "off", serving: { qty: 1, unit: "cup", g: 170 }, per: { cal: 100, p: 17, c: 6, f: 0 }, alts: [] } });
    M.ui.openAdd({ slot: "Lunch", date: M.today() });
    M.food.scanner.start = () => new Promise(() => {});
    click(q('.m-tools [data-m="open-scan"]'));
    M.food.scanner.start = sc;
    $("m-code").value = "036000291452";
    click(q('[data-m="code-lookup"]'));
    await sleep(20);
    assert.ok($("m-det-go") && !$("m-off-warn"), "no warning for a food with protein");
    /* a store price sticker gets its own words, not "isn't in Open Food Facts yet" */
    M.ui.close();
    M.food.lookup = code => Promise.resolve({ status: "not_found", code, store: true, message: "This is a store price sticker. Scan the label or type it in once. After that, this sticker finds it." });
    M.ui.openAdd({ slot: "Lunch", date: M.today() });
    M.food.scanner.start = () => new Promise(() => {});
    click(q('.m-tools [data-m="open-scan"]'));
    M.food.scanner.start = sc;
    $("m-code").value = "212345012345";
    click(q('[data-m="code-lookup"]'));
    await sleep(20);
    assert.strictEqual($("sheetT").textContent, "Not found");
    assert.ok(/store price sticker/.test($("sheetB").textContent) && !/Open Food Facts yet/.test($("sheetB").textContent), $("sheetB").textContent);
    assert.ok(q('#sheetB [data-m="open-label"]') && q('#sheetB [data-m="open-form"]'), "Scan label / Type it in still offered");
  } finally { M.food.lookup = saved; if (M.ui.sheetOpen()) M.ui.close(); }
});

t("C2b deleting a saved meal or a food can be undone from the Foods tab (same id, same items)", () => {
  reset();
  const m = M.meals.add({ name: "Chicken rice bowl", desc: "Meal prep, Sunday", slot: "Lunch", servingsMade: 1, items: [egg()] });
  openFoods("meals");
  click(q('[data-m="meal"][data-id="' + m.id + '"]'));
  const del = q('[data-m="meal-del"]');
  click(del); assert.ok(M.meals.get(m.id), "first tap only arms");
  click(del);
  assert.ok(!M.meals.get(m.id), "deleted");
  assert.ok(!ctx.toasts.some(x => /^Deleted/.test(x)), "no second 'Deleted' message on top of the bar");
  const bar = q(".m-undo");
  assert.ok(bar && /Chicken rice bowl/.test(bar.textContent), "undo bar on Saved meals");
  click(q('[data-m="undo-del"]'));
  const back = M.meals.get(m.id);
  assert.ok(back, "same id back");
  assert.strictEqual(back.desc, "Meal prep, Sunday");
  assert.strictEqual(back.items.length, 1);
  assert.ok(!q(".m-undo"), "bar gone after undo");
  assert.ok(q('[data-m="meal"][data-id="' + m.id + '"]'), "listed again");
  /* foods too; the bar only shows on the list the item came from */
  const f = M.foods.add({ name: "Sparkling tea", brand: "", serving: { qty: 1, unit: "can", g: 355 }, per: { cal: 90, p: 0, c: 22, f: 0 } });
  openFoods("foods");
  click(q('[data-m="food"][data-id="' + f.id + '"]'));
  const fd = q('[data-m="ff-del"]'); click(fd); click(fd);
  assert.ok(!M.MS.foods[f.id], "food deleted");
  assert.ok(q(".m-undo"), "undo bar on My foods");
  openFoods("meals");
  assert.ok(!q(".m-undo"), "no food undo bar on Saved meals");
  openFoods("foods");
  click(q('[data-m="undo-del"]'));
  assert.ok(M.MS.foods[f.id] && M.MS.foods[f.id].name === "Sparkling tea", "food back with its id");
  /* old deletes expire */
  M.ui.undoDel = { kind: "food", data: { id: "x", name: "Old" }, at: Date.now() - 5 * 60000, pid: M.pid() };
  M.ui.render();
  assert.ok(!q(".m-undo"), "no bar for a delete from minutes ago");
  /* another person's delete on this phone never shows here */
  M.ui.undoDel = { kind: "food", data: { id: "y", name: "Hers" }, at: Date.now(), pid: M.pid() === "kat" ? "nick" : "kat" };
  M.ui.render();
  assert.ok(!q(".m-undo"), "no bar for the other person's delete");
  M.ui.undoDel.pid = M.pid(); M.ui.render();
  assert.ok(q(".m-undo"), "bar for this person's delete");
  M.ui.undoDel = null;
});

t("C2b describe rows: '2 chicken breasts' reads '2 breasts (350 g raw)' even in US units (stepper counts breasts)", async () => {
  reset();
  const f = M.foods.get("g_kirkland_organic_chicken");
  assert.ok(f && f.alwaysRaw === true, "Kirkland breast in the data");
  const wa = M.ui._.wholeAmount;
  const c = M.cook.of(f);
  const it = { name: f.name, foodId: f.id, servingLabel: "1 breast (175 g)", g: 350, servings: 2, per: { cal: 172 }, state: "raw", cook: { y: c.y, word: c.word } };
  assert.strictEqual(wa(it, true), "2 breasts (350 g raw)");
  const oz = M.cook.unitsFor(f, "us").find(o => o.key === "oz-raw");
  /* K8 (F1): grams for the chicken whatever the units (before K8: "6 oz raw") */
  assert.ok(/^(6 oz raw|170 g raw)/.test(wa({ name: f.name, foodId: f.id, servingLabel: "1 oz raw", g: oz.g, servings: 6, per: { cal: 1 }, state: "raw", cook: { y: c.y, word: c.word } }, true)), "oz rows: oz, or grams with K8");
  /* "cottage cheese with jam": one ½-cup serving reads like its diary row */
  assert.strictEqual(wa({ name: "Cottage cheese, 2%", servingLabel: "½ cup (113 g)", g: 113, servings: 1, per: { cal: 90 } }, true), "½ cup (113 g)");
  assert.strictEqual(wa({ name: "Cottage cheese, 2%", servingLabel: "½ cup (113 g)", g: 113, servings: 2, per: { cal: 90 } }, true), "1 cup (226 g)");
});

t("C2b meal description is a two-line box (whole text shows), capped at 120, saved with the meal", () => {
  reset(); newMeal("Turkey cucumber plate");
  const d = q('[data-m="mb"][data-k="desc"]');
  assert.strictEqual(d.tagName, "TEXTAREA");
  assert.strictEqual(d.getAttribute("maxlength"), "120");
  input(d, "4 turkey slices, 1 cucumber, cut up. Quick snack.");
  M.ui.draft.items.push(egg());
  click(q('[data-m="mb-save"]'));
  const m = M.meals.list().find(x => x.name === "Turkey cucumber plate");
  assert.ok(m && m.desc === "4 turkey slices, 1 cucumber, cut up. Quick snack.", m && m.desc);
  /* editing shows the saved text in the box */
  openFoods("meals"); click(q('[data-m="meal"][data-id="' + m.id + '"]')); click(q('[data-m="meal-edit"]'));
  assert.strictEqual(q('[data-m="mb"][data-k="desc"]').value, m.desc);
  M.ui.close();
});

t("SC-01 closing the scanner during a lookup: nothing pops up later, the next sheet keeps what was typed", async () => {
  reset();
  const saved = M.food.lookup;
  let release; const gate = new Promise(r => { release = r; });
  M.food.lookup = code => gate.then(() => ({ status: "found", code, food: { id: "off_" + code, name: "Cola", brand: "Fizz", serving: { qty: 1, unit: "can", g: 355 }, per: { cal: 140 }, barcode: code, source: "off" }, saved: false }));
  try {
    click(q('#cta [data-m="add"]'));
    input($("m-search"), "cola");
    click(q('[data-m="open-scan"]'));
    input($("m-code"), "049000028911");
    click(q('[data-m="code-lookup"]'));
    click(q('[data-m="scan-cancel"]'));
    /* DY-12: Cancel goes back to Log food with the same search */
    assert.ok(sheetOn() && /^Log food/.test($("sheetT").textContent), $("sheetT").textContent);
    assert.strictEqual($("m-search").value, "cola");
    click(q('[data-m="open-describe"]'));
    const ta = q("#sheet textarea"); assert.ok(ta, "describe sheet open"); input(ta, "2 eggs and toast");
    const title = $("sheetT").textContent;
    release(); await sleep(20);
    assert.ok(sheetOn(), "describe still open");
    assert.strictEqual($("sheetT").textContent, title, "no sheet replaced it");
    assert.strictEqual(q("#sheet textarea").value, "2 eggs and toast", "typed text kept");
  } finally { M.food.lookup = saved; M.ui.close(); }
});

t("SC-02/OF-01 a failed lookup stops the scanner and offers Try again + Scan label; offline offers Scan label + Type it in with the code", async () => {
  reset();
  const saved = M.food.lookup, stop = M.food.scanner.stop, start = M.food.scanner.start;
  let stops = 0, calls = 0, mode = "down";
  M.food.scanner.stop = () => { stops++; return Promise.resolve(true); };
  M.food.scanner.start = () => new Promise(() => {});   /* camera still starting */
  M.food.lookup = code => { calls++; return Promise.reject(mode === "offline" ? { code: "offline", message: "You're offline." } : { code: "off_down", message: "Open Food Facts isn't answering. Try again in a minute." }); };
  try {
    click(q('#cta [data-m="add"]'));
    click(q('[data-m="open-scan"]'));
    input($("m-code"), "049000028911");
    const s0 = stops;
    click(q('[data-m="code-lookup"]')); await sleep(10);
    assert.ok(stops > s0, "camera stopped after the failed lookup");
    assert.ok(/isn't answering/.test($("m-scan-status").textContent));
    same(qa('#m-scan-act button').map(b => b.textContent), ["Try again", "Scan label"]);
    assert.strictEqual(q('#m-scan-act [data-m="open-label"]').dataset.code, "049000028911");
    click(q('#m-scan-act [data-m="scan-retry"]')); await sleep(10);
    assert.strictEqual(calls, 2, "Try again looks the same code up again");
    mode = "offline";
    click(q('#m-scan-act [data-m="scan-retry"]')); await sleep(10);
    assert.ok(/No internet, so this barcode can't be looked up\. Add it by hand now\. We'll keep the barcode so it scans next time\./.test($("m-scan-status").textContent), $("m-scan-status").textContent);
    same(qa('#m-scan-act button').map(b => b.textContent), ["Scan label", "Type it in"]);
    click(q('#m-scan-act [data-m="open-form"]'));
    assert.strictEqual(M.ui._.state().ff.food.barcode, "049000028911", "the barcode stays on the new food");
  } finally { M.food.lookup = saved; M.food.scanner.stop = stop; M.food.scanner.start = start; M.ui.close(); }
});

t("IO-02 camera blocked: a Try again button restarts the scanner", async () => {
  reset();
  const start = M.food.scanner.start;
  let starts = 0;
  M.food.scanner.start = () => { starts++; return Promise.reject({ code: "camera", message: "Chalk can't use the camera." }); };
  try {
    click(q('#cta [data-m="add"]'));
    click(q('[data-m="open-scan"]')); await sleep(10);
    assert.ok(/can't use the camera/.test($("m-scan-status").textContent));
    const b = q('#m-scan-act [data-m="scan-restart"]');
    assert.ok(b && b.textContent === "Try again");
    click(b); await sleep(10);
    assert.strictEqual(starts, 2, "scanner started again");
    assert.strictEqual(qa('[data-m="scan-restart"]').length, 1, "one Try again button");
  } finally { M.food.scanner.start = start; M.ui.close(); }
});

t("FD-01 editing a food never rounds the per-gram numbers of meals that use it in grams", () => {
  reset();
  const sk = M.foods.add({ name: "Skyr", serving: { qty: 100, unit: "g", g: 100 }, per: { cal: 73, p: 10, c: 7.3, f: 0.3 }, per100g: { cal: 73, p: 10, c: 7.3, f: 0.3 }, source: "custom" });
  const meal = M.meals.add({ name: "Skyr bowl", slot: "Breakfast", items: [{ name: "Skyr", foodId: sk.id, servings: 200, servingLabel: "1 g", g: 1, per: { cal: 0.73, p: 0.1, c: 0.073, f: 0.003 } }] });
  near(meal.per.cal, 146, 0.01); near(meal.per.c, 14.6, 0.01);
  const old = M.cp(sk);
  const nf = M.foods.update(sk.id, { per: { cal: 76.65, p: 10, c: 7.35, f: 0.335 }, per100g: { cal: 76.65, p: 10, c: 7.35, f: 0.335 } });
  assert.strictEqual(M.ui._.syncMeals(old, nf), 1);
  const m = M.meals.get(meal.id);
  near(m.per.cal, 153.3, 0.05, "cal"); near(m.per.p, 20, 0.05, "p"); near(m.per.c, 14.7, 0.05, "c"); near(m.per.f, 0.67, 0.05, "f");
  near(m.items[0].per.c, 0.0735, 1e-6, "per gram kept exact");
});

t("FD-02 fixing a food's grams keeps '1 bar' at the food's own numbers and relabels it", () => {
  reset();
  const bar = M.foods.add({ name: "Protein bar", brand: "Barebells", serving: { qty: 1, unit: "bar", g: 40 }, per: { cal: 200, p: 20, c: 18, f: 8 }, per100g: { cal: 500, p: 50, c: 45, f: 20 }, source: "custom" });
  const meal = M.meals.add({ name: "Bar snack", slot: "Snacks", items: [{ name: "Protein bar", brand: "Barebells", foodId: bar.id, servings: 1, servingLabel: "1 bar (40 g)", g: 40, per: { cal: 200, p: 20, c: 18, f: 8 } }] });
  const old = M.cp(bar);
  const nf = M.foods.update(bar.id, { serving: { qty: 1, unit: "bar", g: 55 }, per100g: { cal: 363.6, p: 36.4, c: 32.7, f: 14.5 } });
  M.ui._.syncMeals(old, nf);
  let m = M.meals.get(meal.id);
  near(m.per.cal, 200, 0.01, "still 200 cal a bar (was 183 by weight)");
  assert.strictEqual(m.items[0].servingLabel, "1 bar (55 g)");
  const old2 = M.cp(nf);
  const nf2 = M.foods.update(bar.id, { per: { cal: 210, p: 20, c: 18, f: 8 } });
  M.ui._.syncMeals(old2, nf2);
  m = M.meals.get(meal.id);
  near(m.per.cal, 210, 0.01, "follows the new calories");
});

t("FD-07 a saved meal from the Foods tab logs to the day the Diary shows and says so", () => {
  reset();
  const meal = M.meals.add({ name: "Eggs plate", slot: "Breakfast", items: [egg()] });
  const y = M.addDays ? M.addDays(M.today(), -1) : (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })();
  M.ui.date = y;
  openFoods("meals");
  click(q('[data-m="meal"][data-id="' + meal.id + '"]'));
  const go = $("m-meal-go");
  assert.ok(/^Add to Breakfast · /.test(go.textContent) && go.textContent.indexOf(M.fmtDay(y)) > 0, go.textContent);
  click(go);
  const d = M.dayOf(y);
  assert.ok(d && d.entries.length === 1, "logged to the Diary's day");
  assert.ok(!(M.dayOf(M.today()) && M.dayOf(M.today()).entries.length), "not today");
  assert.ok(lastToast().indexOf(M.fmtDay(y)) > 0, lastToast());
  assert.strictEqual(M.ui.date, y, "the Diary stays on that day");
  M.ui.date = M.today();
});

t("FD-06 Saved meals: meal-time chips (start at the current meal time, a tap is kept), counts in the headers, typing searches all", () => {
  reset();
  const mk = (name, slot, extra) => M.meals.add(Object.assign({ name, slot, items: [egg()] }, extra || {}));
  const b1 = mk("Eggs plate", "Breakfast"), b2 = mk("Yogurt bowl", "Breakfast"), l1 = mk("Chicken rice bowl", "Lunch"), a1 = mk("Turkey snack plate", "Any");
  M.ui.mealsSlot = undefined;
  openFoods("meals");
  same(qa('.m-mslots [data-m="meals-slot"]').map(b => b.textContent), ["All", "Breakfast", "Lunch", "Dinner", "Snacks", "Any time"]);
  assert.strictEqual(q('.m-mslots .chip.on').dataset.v, "All", "a short list shows all");
  /* a long list (over 10) starts at the current meal time */
  const extra = []; for (let i = 0; i < 8; i++) extra.push(mk("Filler " + i, M.SLOTS[i % 4]));
  M.ui.render();
  const cur = M.defaultSlot();
  assert.strictEqual(q('.m-mslots .chip.on').dataset.v, cur, "starts at the current meal time");
  extra.forEach(m => M.meals.remove(m.id)); M.ui.render();
  click(q('.m-mslots [data-v="Breakfast"]'));
  same(qa("h2.sec").map(h => h.textContent), ["Breakfast · 2", "Any time · 1"]);
  assert.ok(!q('[data-m="meal"][data-id="' + l1.id + '"]'), "lunch meals hidden");
  /* the choice is kept across tabs */
  M.ui.tab = "diary"; M.ui.render(); openFoods("meals");
  assert.strictEqual(q('.m-mslots .chip.on').dataset.v, "Breakfast");
  /* typing finds meals from any time */
  M.ui.foodsQ = "chicken"; M.ui.render();
  assert.ok(q('[data-m="meal"][data-id="' + l1.id + '"]'), "search finds the lunch meal");
  M.ui.foodsQ = ""; click(q('.m-mslots [data-v="Dinner"]'));
  same(qa("h2.sec").map(h => h.textContent), ["Any time · 1"]);
  click(q('.m-mslots [data-v="All"]'));
  assert.strictEqual(qa('[data-m="meal"]').length, 4);
  /* FX-09: the other person's meal is tagged and listed after this person's */
  const hers = mk("Her oats", "Breakfast", { pid: M.pid() === "kat" ? "nick" : "kat" });
  M.ui.render();
  const rows = qa('.card [data-m="meal"]').map(b => b.dataset.id);
  assert.ok(rows.indexOf(hers.id) > rows.indexOf(b1.id) && rows.indexOf(hers.id) > rows.indexOf(b2.id), "own meals first");
  assert.ok(q('[data-m="meal"][data-id="' + hers.id + '"] .m-who'), "name tag on hers");
  assert.ok(!q('[data-m="meal"][data-id="' + b1.id + '"] .m-who'), "no tag on own");
  M.ui.mealsSlot = "All";
});

t("FD-03 'Save Lunch as a meal' keeps a batch portion's own batch weight; its sheet uses it", () => {
  reset();
  const pot = M.meals.add({ name: "Chili pot", slot: "Lunch", batch: { cookedG: 51 * OZ }, items: [{ name: "Beef", servings: 1000, servingLabel: "1 g raw", g: 1, per: { cal: 1.76, p: 0.2, c: 0, f: 0.1 }, state: "raw", cook: { y: 0.74, word: "raw" } }] });
  M.log.addMeal(M.today(), pot.id, 1, "Lunch", { grams: 8 * OZ, unit: "oz" });
  const e = entries().find(x => x.mealId === pot.id);
  assert.ok(e && e.batchG > 0, "the diary entry has its batch weight");
  M.meals.update(pot.id, { batch: { cookedG: 45 * OZ } });
  M.ui.tab = "diary"; M.ui.render();
  const ck = M.ui._.cookSetup(Object.assign({}, e));
  near(ck.batch.cookedG, e.batchG, 0.01, "the entry's own batch weight, not the edited one");
  /* Save Lunch as a meal: the item keeps batchG */
  click(q('[data-m="slot-menu"][data-slot="Lunch"]'));
  click(q('[data-m="slot-savemeal"]'));
  const it = M.ui.draft.items[0];
  assert.strictEqual(it.batch, true);
  near(it.batchG, e.batchG, 0.01, "batchG carried");
  M.ui.close();
});

t("FD-05 chicken from Describe as '150 g raw' × 1 goes into a meal as '1 g raw' × 150 (the stepper moves by grams)", () => {
  reset();
  const f = M.foods.get("g_kirkland_organic_chicken");
  const c = M.cook.of(f);
  newMeal("Chicken plate");
  const draft = M.ui.draft;
  const saved = M.ui.openAdd;
  let pick = null;
  M.ui.openAdd = ctx => { pick = ctx.onPick; };
  try {
    click(q('[data-m="mb-add"]'));
    assert.ok(typeof pick === "function");
    pick({ name: f.name, foodId: f.id, servings: 1, servingLabel: "150 g", g: 150, per: { cal: 147.3, p: 32, c: 0, f: 1.4 }, state: "raw", cook: { y: c.y, word: c.word } });
  } finally { M.ui.openAdd = saved; }
  const it = M.ui.draft.items[M.ui.draft.items.length - 1];
  assert.strictEqual(it.servingLabel.replace(/\s+/g, " "), "1 g raw");
  assert.strictEqual(it.servings, 150);
  near(it.per.cal * it.servings, 147.3, 1.5, "same calories");
  M.ui.close();
});

t("K3 Not found → 'Pick one of my foods' saves the barcode on that food and opens it to log", async () => {
  reset();
  const saved = M.food.lookup, start = M.food.scanner.start;
  M.food.scanner.start = () => new Promise(() => {});
  M.food.lookup = code => Promise.resolve({ status: "not_found", code, message: "Not in Open Food Facts." });
  const mine = M.foods.add({ name: "Cottage cheese, 2%", brand: "Daisy", serving: { qty: 0.5, unit: "cup", g: 113 }, per: { cal: 90, p: 13, c: 5, f: 2.5 }, source: "custom" });
  try {
    click(q('#cta [data-m="add"]'));
    click(q('[data-m="open-scan"]'));
    input($("m-code"), "073420524203");
    click(q('[data-m="code-lookup"]')); await sleep(10);
    assert.strictEqual($("sheetT").textContent, "Not found");
    const pk = q('[data-m="code-pick"]');
    assert.ok(pk && pk.textContent === "Pick one of my foods" && pk.dataset.code === "073420524203");
    click(pk);
    assert.strictEqual($("sheetT").textContent, "Pick a food");
    assert.ok(q('#m-codepick [data-m="code-pick-go"][data-id="' + mine.id + '"]'), "My foods listed");
    input(q('[data-m="code-pick-q"]'), "zzzz");
    assert.ok(/No foods match/.test($("m-codepick").textContent));
    input(q('[data-m="code-pick-q"]'), "cottage");
    click(q('#m-codepick [data-m="code-pick-go"][data-id="' + mine.id + '"]'));
    const code = M.MS.codes && M.MS.codes["073420524203"];
    assert.ok(M.foods.get(mine.id).barcode === "073420524203" || code === mine.id, "code saved on the food");
    assert.ok(sheetOn() && $("sheetB").textContent.indexOf("Cottage cheese") >= 0, "the food opens to log");
    assert.ok(/It scans next time/.test(lastToast()), lastToast());
  } finally { M.food.lookup = saved; M.food.scanner.start = start; M.ui.close(); }
});

t("CP-14/SC-10 barcode without nutrition: the reason first; 'Type it in instead' keeps name and brand", async () => {
  reset();
  const saved = M.food.lookup, start = M.food.scanner.start;
  M.food.scanner.start = () => new Promise(() => {});
  M.food.lookup = code => Promise.resolve({ status: "no_nutrition", code, product: { name: "Coke Zero", brand: "Coca-Cola", barcode: code } });
  try {
    click(q('#cta [data-m="add"]'));
    click(q('[data-m="open-scan"]'));
    input($("m-code"), "049000028911");
    click(q('[data-m="code-lookup"]')); await sleep(10);
    assert.strictEqual($("m-label-status").textContent, "We found Coke Zero, but it has no nutrition numbers. Take a photo of its label to add them.");
    click($("m-label-type"));
    const st = M.ui._.state().ff;
    assert.strictEqual(st.food.name, "Coke Zero"); assert.strictEqual(st.food.brand, "Coca-Cola"); assert.strictEqual(st.food.barcode, "049000028911");
  } finally { M.food.lookup = saved; M.food.scanner.start = start; M.ui.close(); }
});

t("FD-09 Cancel on an unchanged Edit meal closes right away; a changed edit asks 'Tap again to drop changes'", () => {
  reset();
  const m = M.meals.add({ name: "Eggs plate", slot: "Breakfast", items: [egg()] });
  openFoods("meals");
  click(q('[data-m="meal"][data-id="' + m.id + '"]')); click(q('[data-m="meal-edit"]'));
  click(q('[data-m="mb-cancel"]'));
  assert.ok(!sheetOn(), "closed on the first tap");
  click(q('[data-m="meal"][data-id="' + m.id + '"]')); click(q('[data-m="meal-edit"]'));
  input(q('[data-m="mb"][data-k="name"]'), "Eggs plate big");
  const b = q('[data-m="mb-cancel"]'); click(b);
  assert.ok(sheetOn() && b.textContent === "Tap again to drop changes", b.textContent);
  click(b);
  assert.ok(!sheetOn());
  assert.strictEqual(M.meals.get(m.id).name, "Eggs plate", "nothing saved");
});

t("IO-03 unit box: no caps or autocorrect, saved lowercase; brand box: no autocorrect", () => {
  reset();
  openFoods("foods");
  click(q('[data-m="food-new"]'));
  const u = q('[data-m="ff"][data-k="unit"]'), br = q('[data-m="ff"][data-k="brand"]');
  assert.strictEqual(u.getAttribute("autocapitalize"), "none"); assert.strictEqual(u.getAttribute("autocorrect"), "off"); assert.strictEqual(u.getAttribute("spellcheck"), "false");
  assert.strictEqual(br.getAttribute("autocorrect"), "off"); assert.strictEqual(br.getAttribute("spellcheck"), "false");
  input(q('[data-m="ff"][data-k="name"]'), "Rye bread");
  input(q('[data-m="ff"][data-k="qty"]'), "2");
  input(u, "Slice");
  input(q('[data-m="ff"][data-k="g"]'), "64");
  input(q('[data-m="ff"][data-k="cal"]'), "160");
  click(q('[data-m="ff-save"]'));
  const f = M.foods.list().find(x => x.name === "Rye bread");
  assert.ok(f && f.serving.unit === "slice", f && f.serving.unit);
});

t("WK-05 a gram batch: its sheet starts at 100 g, and Meal ideas say 'Add … g'", async () => {
  reset();
  const pot = M.meals.add({ name: "Rice pot", slot: M.defaultSlot(), batch: { cookedG: 2250, unit: "g" }, items: [{ name: "White rice", servings: 700, servingLabel: "1 g dry", g: 1, per: { cal: 3.65, p: 0.07, c: 0.8, f: 0.006 }, state: "raw", cook: { y: 3, word: "dry" } }] });
  if (!pot.batch.unit) { pot.batch.unit = "g"; M.save(); }
  openFoods("meals");
  click(q('[data-m="meal"][data-id="' + pot.id + '"]'));
  const st = M.ui._.state().det;
  assert.ok(st && /^g-/.test(st.unit), st && st.unit);
  near(st.servings * (st.opts.find(o => o.key === st.unit).g), 100, 0.5, "100 g");
  M.ui.close();
  const ideas = (() => { M.ui.tab = "diary"; M.ui.render(); click(q('[data-m="suggest"]')); return M.ui._.batchIdeas(); })();
  const b = ideas.find(x => x.mealId === pot.id);
  assert.ok(b && b.unit === "g" && / g cooked$/.test(b.portion), b && b.portion);
  M.ui.close();
});

t("FD-10 the last 3 deletes from the past 2 minutes can all be undone ('Deleted 2 meals. Undo')", () => {
  reset();
  const ms = ["One", "Two", "Three", "Four"].map(n => M.meals.add({ name: n + " plate", slot: "Lunch", items: [egg()] }));
  openFoods("meals");
  const del = m => { click(q('[data-m="meal"][data-id="' + m.id + '"]')); const b = q('[data-m="meal-del"]'); click(b); click(b); };
  del(ms[0]);
  assert.ok(/Deleted “One plate”\./.test(q(".m-undo").textContent), q(".m-undo").textContent);
  del(ms[1]);
  assert.ok(/Deleted 2 meals\./.test(q(".m-undo").textContent), q(".m-undo").textContent);
  del(ms[2]); del(ms[3]);
  assert.ok(/Deleted 3 meals\./.test(q(".m-undo").textContent), "only the last 3");
  click(q('[data-m="undo-del"]'));
  assert.ok(!M.meals.get(ms[0].id) && M.meals.get(ms[1].id) && M.meals.get(ms[2].id) && M.meals.get(ms[3].id), "the last 3 are back");
  assert.ok(/3 meals are back/.test(lastToast()), lastToast());
  assert.ok(!q(".m-undo"), "bar gone");
});

t("FD-02 '1 slice' of a food served as '2 slices' follows the food's own numbers when its grams are fixed", () => {
  reset();
  const br = M.foods.add({ name: "Rye bread", serving: { qty: 2, unit: "slices", g: 64 }, per: { cal: 160, p: 6, c: 30, f: 2 }, per100g: { cal: 250, p: 9.4, c: 46.9, f: 3.1 }, source: "custom" });
  const meal = M.meals.add({ name: "Toast", slot: "Breakfast", items: [{ name: "Rye bread", foodId: br.id, servings: 1, servingLabel: "1 slice (32 g)", g: 32, per: { cal: 80, p: 3, c: 15, f: 1 } }] });
  const old = M.cp(br);
  const nf = M.foods.update(br.id, { serving: { qty: 2, unit: "slices", g: 76 }, per100g: { cal: 210.5, p: 7.9, c: 39.5, f: 2.6 } });
  M.ui._.syncMeals(old, nf);
  const m = M.meals.get(meal.id);
  near(m.per.cal, 80, 0.01, "still 80 cal a slice");
  assert.strictEqual(m.items[0].servingLabel, "1 slice (38 g)");
});

t("DY-12 × on Scan barcode goes back to Log food with the same search; the backdrop just closes", async () => {
  reset();
  const start = M.food.scanner.start; M.food.scanner.start = () => new Promise(() => {});
  try {
    click(q('#cta [data-m="add"]'));
    input($("m-search"), "yogurt");
    click(q('[data-m="open-scan"]'));
    click(q('[data-a="sheet-close"]'));
    await sleep(320);
    assert.ok(sheetOn() && /^Log food/.test($("sheetT").textContent), $("sheetT").textContent);
    assert.strictEqual($("m-search").value, "yogurt");
    click(q('[data-m="open-scan"]'));
    click($("sheetBg"));
    await sleep(320);
    assert.ok(!sheetOn(), "backdrop closes everything");
  } finally { M.food.scanner.start = start; M.ui.close(); }
});

t("label form: a ⅔ cup serving shows '⅔' (not 0.667); '2/3', '1 1/2' and '1½' are read as numbers", async () => {
  reset();
  const saved = M.food.label.fromImage;
  M.food.label.fromImage = () => Promise.resolve({ method: "ocr", food: { name: "Granola", serving: { qty: 2 / 3, unit: "cup", g: 55 }, per: { cal: 240, p: 5, c: 36, f: 9 } } });
  try {
    click(q('#cta [data-m="add"]'));
    click(q('[data-m="open-label"]'));
    const inp = q('[data-m="label-file"]');
    Object.defineProperty(inp, "files", { value: [new w.Blob(["x"], { type: "image/png" })], configurable: true });
    inp.dispatchEvent(new w.Event("change", { bubbles: true }));
    await sleep(20);
    const qb = q('[data-m="ff"][data-k="qty"]');
    assert.strictEqual(qb.value, "⅔");
    const st = () => M.ui._.state().ff.food.serving.qty;
    input(qb, "2/3"); near(st(), 2 / 3, 1e-9);
    input(qb, "1 1/2"); near(st(), 1.5, 1e-9);
    input(qb, "1½"); near(st(), 1.5, 1e-9);
    input(qb, "0.5"); near(st(), 0.5, 1e-9);
  } finally { M.food.label.fromImage = saved; M.ui.close(); }
});

/* ---- checker C2b (round 4) ---- */
t("FD-03 recent of a deleted batch meal: opens cooked only 'of 1000 g batch', and the new entry keeps its batch weight", () => {
  reset();
  const pot = M.meals.add({ name: "Rice pot", slot: "Lunch", batch: { cookedG: 1000, unit: "g" }, items: [{ name: "Beef", servings: 1000, servingLabel: "1 g raw", g: 1, per: { cal: 1.76, p: 0.2, c: 0, f: 0.1 }, state: "raw", cook: { y: 0.74, word: "raw" } }] });
  M.log.addMeal(M.today(), pot.id, 1, "Lunch", { grams: 100, unit: "g" });
  const e = entries().find(x => x.mealId === pot.id);
  assert.ok(e && e.batchG === 1000, "the portion has its batch weight");
  M.meals.remove(pot.id);
  M.ui.openAdd({ slot: "Dinner", date: M.today() });
  const row = qa('#m-results [data-m="pick"]').find(b => /Rice pot/.test(b.textContent));
  assert.ok(row, "the recent is listed");
  click(row);
  const amt = $("m-det-amt").textContent;
  assert.ok(/^100 g cooked$/.test(amt), "cooked only, never 'raw (cooked)': " + amt);
  assert.ok(/of 1,?000 g batch/.test($("m-det-of").textContent), $("m-det-of").textContent);
  click($("m-det-go"));
  const e2 = entries().filter(x => x.slot === "Dinner");
  assert.strictEqual(e2.length, 1);
  assert.strictEqual(e2[0].batchG, 1000, "the new portion keeps the batch weight");
  near(e2[0].per.cal * e2[0].servings, e.per.cal * e.servings, 0.5, "same calories as last time");
  M.ui.close();
});

t("K3 a built-in barcode (Daisy 073420516208) opens the built-in food with no network, and makes no copy in My foods", async () => {
  reset();
  const start = M.food.scanner.start, fetch0 = ctx.fetch;
  let calls = 0;
  M.food.scanner.start = () => new Promise(() => {});
  ctx.fetch = u => { if (/73420516208/.test(String(u && u.url || u))) calls++; return Promise.reject(new Error("no network in this test")); };
  try {
    click(q('#cta [data-m="add"]'));
    click(q('[data-m="open-scan"]'));
    input($("m-code"), "073420516208");
    click(q('[data-m="code-lookup"]')); await sleep(20);
    assert.strictEqual(calls, 0, "no lookup online for this code");
    assert.ok(/Cottage cheese/.test($("sheetB").textContent), "the built-in Daisy opens");
    same(Object.keys(M.MS.foods), [], "no copy in My foods");
    click($("m-det-go"));
    const e = entries()[0];
    assert.ok(e && M.foods.get(e.foodId) && M.foods.get(e.foodId).brand === "Daisy", "logged as the built-in food");
    same(Object.keys(M.MS.foods), [], "still no copy after logging");
  } finally { M.food.scanner.start = start; ctx.fetch = fetch0; M.ui.close(); }
});

t("typed numbers that can't be a barcode: the message shows, with no 'Try again' (the same wrong numbers)", async () => {
  reset();
  const start = M.food.scanner.start;
  M.food.scanner.start = () => new Promise(() => {});
  try {
    click(q('#cta [data-m="add"]'));
    click(q('[data-m="open-scan"]'));
    input($("m-code"), "0212345009998");
    click(q('[data-m="code-lookup"]')); await sleep(20);
    assert.ok(/don't match a real barcode/.test($("m-scan-status").textContent), $("m-scan-status").textContent);
    assert.ok(!q('[data-m="scan-retry"]'), "no Try again");
    assert.ok($("m-code"), "the number box is still there to fix it");
  } finally { M.food.scanner.start = start; M.ui.close(); }
});

t("Meal ideas: calories left read with a comma ('1,806'), like the Diary", () => {
  reset();
  click(q('[data-m="suggest"]') || q('[data-m="open-suggest"]') || q('#cta [data-m="add"]'));
  if (!/Meal ideas/.test($("sheetT").textContent)) { M.ui.close(); M.ui.openAdd({ slot: "Lunch", date: M.today() }); click(q('[data-m="suggest"]')); }
  assert.ok(/Meal ideas/.test($("sheetT").textContent), $("sheetT").textContent);
  const v = q(".m-sughd .stat .v").textContent;
  assert.ok(/^\d{1,2},\d{3}/.test(v), "calories left with a comma: " + v);
  M.ui.close();
});

t("K3 'Pick one of my foods': when the core can't save the code, it never says 'It scans next time'", async () => {
  reset();
  const saved = M.food.lookup, start = M.food.scanner.start, link = M.foods.linkCode;
  M.food.scanner.start = () => new Promise(() => {});
  M.food.lookup = code => Promise.resolve({ status: "not_found", code, message: "Not in Open Food Facts." });
  M.foods.linkCode = () => null;
  try {
    click(q('#cta [data-m="add"]'));
    click(q('[data-m="open-scan"]'));
    input($("m-code"), "212345009994");
    click(q('[data-m="code-lookup"]')); await sleep(10);
    click(q('[data-m="code-pick"]'));
    click(q('#m-codepick [data-m="code-pick-go"][data-id="g_kirkland_organic_chicken"]'));
    assert.ok(!/scans next time/.test(lastToast()), lastToast());
    assert.ok(/Couldn't save the barcode/.test(lastToast()), lastToast());
    M.foods.linkCode = link;
    M.ui.close();
    /* the real core: a built-in food keeps the sticker in the codes map and the next lookup finds it */
    click(q('#cta [data-m="add"]'));
    click(q('[data-m="open-scan"]'));
    input($("m-code"), "212345009994");
    click(q('[data-m="code-lookup"]')); await sleep(10);
    click(q('[data-m="code-pick"]'));
    click(q('#m-codepick [data-m="code-pick-go"][data-id="g_kirkland_organic_chicken"]'));
    assert.ok(/scans next time/.test(lastToast()), lastToast());
    assert.strictEqual(M.foods.byCode("212345009994").id, "g_kirkland_organic_chicken");
  } finally { M.food.lookup = saved; M.food.scanner.start = start; M.foods.linkCode = link; M.ui.close(); }
});

t("FD-01/FD-02 food fixes flow into saved meals: cup items (½, 1, 2 cups), a count item (breast) and a gram item", () => {
  reset();
  const milk = M.foods.add({ name: "Oat milk", serving: { qty: 1, unit: "cup", g: 240 }, per: { cal: 120, p: 3, c: 16, f: 5 }, source: "custom" });
  const br = M.foods.add({ name: "Chicken breast pack", serving: { qty: 1, unit: "breast", g: 175 }, per: { cal: 180, p: 38, c: 0, f: 3 }, source: "custom" });
  const it = (f, label, g, per, s) => ({ name: f.name, foodId: f.id, servings: s || 1, servingLabel: label, g, per });
  const meal = M.meals.add({ name: "Lunch plate", slot: "Lunch", items: [
    it(milk, "1 cup (240 g)", 240, { cal: 120, p: 3, c: 16, f: 5 }),
    it(milk, "½ cup (120 g)", 120, { cal: 60, p: 1.5, c: 8, f: 2.5 }),
    it(milk, "2 cups (480 g)", 480, { cal: 240, p: 6, c: 32, f: 10 }),
    it(br, "1 breast (175 g)", 175, { cal: 180, p: 38, c: 0, f: 3 }, 2),
    it(milk, "1 g", 1, { cal: 0.5, p: 0.0125, c: 0.0667, f: 0.0208 }, 200)] });
  const oldM = M.cp(milk), oldB = M.cp(br);
  const nm = M.foods.update(milk.id, { serving: { qty: 1, unit: "cup", g: 245 }, per: { cal: 130, p: 3, c: 17, f: 5 }, per100g: { cal: 130 / 2.45, p: 3 / 2.45, c: 17 / 2.45, f: 5 / 2.45 } });   /* as the food form saves it */
  M.ui._.syncMeals(oldM, nm);
  const nb = M.foods.update(br.id, { serving: { qty: 1, unit: "breast", g: 170 }, per: { cal: 175, p: 37, c: 0, f: 3 } });
  M.ui._.syncMeals(oldB, nb);
  const its = M.meals.get(meal.id).items;
  near(its[0].per.cal, 130, 0.01, "1 cup follows the food");
  near(its[1].per.cal, 65, 0.01, "½ cup is half");
  near(its[2].per.cal, 260, 0.01, "2 cups is double");
  assert.ok(/^1 cup \(245 g\)$/.test(its[0].servingLabel), its[0].servingLabel);
  assert.ok(/^2 cups \(490 g\)$/.test(its[2].servingLabel), its[2].servingLabel);
  near(its[3].per.cal, 175, 0.01, "a breast is the food's breast");
  assert.strictEqual(its[3].servings, 2, "2 breasts stay 2");
  assert.ok(/^1 breast \(170 g\)$/.test(its[3].servingLabel), its[3].servingLabel);
  near(its[4].per.cal * its[4].servings, 200 * 130 / 245, 0.2, "200 g priced by the new grams, not rounded per gram");
  M.ui.close();
});

t("FX-09 editing a meal from before owners were kept (or a food in it, or Undo) never tags it with the editor's name", () => {
  reset();
  const f = M.foods.add({ name: "Skyr", serving: { qty: 100, unit: "g", g: 100 }, per: { cal: 63, p: 11, c: 4, f: 0.2 }, per100g: { cal: 63, p: 11, c: 4, f: 0.2 }, source: "custom" });
  const mk = name => { const m = M.meals.add({ name, slot: "Breakfast", items: [{ name: "Skyr", foodId: f.id, servings: 200, servingLabel: "1 g", g: 1, per: { cal: 0.63, p: 0.11, c: 0.04, f: 0.002 } }] }); delete M.MS.meals[m.id].pid; return m.id; };
  const a = mk("Old bowl"), b = mk("Old bowl 2"), c = mk("Old bowl 3");
  /* a food edit flows into the meal */
  const old = M.cp(f);
  M.ui._.syncMeals(old, M.foods.update(f.id, { per: { cal: 70, p: 11, c: 4, f: 0.2 }, per100g: { cal: 70, p: 11, c: 4, f: 0.2 } }));
  assert.ok(!M.meals.get(a).pid, "a food edit doesn't claim the meal");
  /* the builder: Edit → rename → Save */
  openFoods("meals");
  click(q('[data-m="meal"][data-id="' + b + '"]'));
  click(q('[data-m="meal-edit"]'));
  input(q('[data-m="mb"][data-k="name"]'), "Old bowl, renamed");
  click(q('[data-m="mb-save"]'));
  assert.strictEqual(M.meals.get(b).name, "Old bowl, renamed");
  assert.ok(!M.meals.get(b).pid, "an edit doesn't claim the meal");
  /* delete + Undo */
  openFoods("meals");
  click(q('[data-m="meal"][data-id="' + c + '"]'));
  click(q('[data-m="meal-del"]')); click(q('[data-m="meal-del"]'));
  click(q('[data-m="undo-del"]'));
  assert.ok(M.meals.get(c) && !M.meals.get(c).pid, "Undo brings it back as it was");
  /* a new meal is the maker's */
  assert.strictEqual(M.meals.add({ name: "New bowl", items: [] }).pid, M.pid());
  M.ui.close();
});

t("WK-05 a gram batch picked in Log food opens in grams (100 g cooked of 2250 g), like from Foods", () => {
  reset();
  const pot = M.meals.add({ name: "Rice pot", slot: "Lunch", batch: { cookedG: 2250, unit: "g" }, items: [{ name: "White rice", servings: 700, servingLabel: "1 g dry", g: 1, per: { cal: 3.65, p: 0.07, c: 0.8, f: 0.006 }, state: "raw", cook: { y: 3, word: "dry" } }] });
  if (M.meals.get(pot.id).batch.unit !== "g") { M.meals.get(pot.id).batch.unit = "g"; }
  M.ui.openAdd({ slot: "Lunch", date: M.today() });
  click(q('[data-m="add-seg"][data-v="meals"]'));
  const row = qa('#m-results [data-m="pick"]').find(b => /Rice pot/.test(b.textContent));
  assert.ok(row, "the batch is listed");
  click(row);
  assert.strictEqual($("m-det-amt").textContent, "100 g cooked");
  assert.ok(/of 2,?250 g batch/.test($("m-det-of").textContent), $("m-det-of").textContent);
  M.ui.close();
});

(async () => {
  let pass = 0, fail = 0;
  for (const x of tests) {
    try { await x.fn(); pass++; console.log("  ok   " + x.name); }
    catch (e) { fail++; const st = e && e.stack ? e.stack.split("\n") : [String(e)]; console.log("  FAIL " + x.name + "\n       " + st.slice(0, 3).concat(st.filter(l => /m-ui2\.test\.js/.test(l)).slice(0, 1)).join("\n       ")); }
  }
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
