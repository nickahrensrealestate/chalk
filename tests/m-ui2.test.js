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
  M.ui.draft = null; M.ui.foodsQ = ""; M.ui.date = M.today(); M.ui.tab = "diary";
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
  assert.ok(qa("h2.sec").some(h => h.textContent === "Any time"));
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

t("UIF-13 batch cooked weight far off the raw total → 'Did you mean lb?' and a second tap to save", () => {
  reset(); newMeal("Chili pot");
  M.ui.draft.items.push({ name: "Ground beef 90/10", servings: 32, servingLabel: "1 oz raw", g: OZ, per: { cal: 49.9, p: 5.7, c: 0, f: 2.8 }, state: "raw", cook: { y: 0.74, word: "raw" } }, { name: "Beans", servings: 4, servingLabel: "1 cup (172 g)", g: 172, per: { cal: 227, p: 15, c: 41, f: 1 } });
  M.ui.openBuilder();
  click(q('[data-m="mb-batch"]'));
  input(q('[data-m="mb-cooked"]'), "5");
  assert.ok(!$("m-mb-warn").hidden && /Did you mean lb\?/.test($("m-mb-warn").textContent), $("m-mb-warn").textContent);
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

t("UX1-13 'Log it' on a meal idea logs ONE entry named after the idea, items kept on it", async () => {
  reset();
  M.ui.render();
  click(q('[data-m="suggest"]'));
  click(q('[data-m="sug-slot"][data-v="Dinner"]'));
  await sleep(30);
  const card = qa(".m-sug").find(c => c.querySelector('[data-m="sug-save"]'));
  assert.ok(card, "a built-in idea");
  const name = card.querySelector("h3").textContent, n = card.querySelectorAll(".m-sugitems li").length;
  click(card.querySelector('[data-m="sug-log"]'));
  const list = M.log.slotEntries(M.today(), "Dinner");
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, name);
  assert.strictEqual(list[0].items.length, n);
  near(list[0].per.cal, M.foodMath.sum(list[0].items).cal, 0.5);
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
  assert.ok(/^Log \d+(\.\d)? oz$/.test(btn.textContent), btn.textContent);
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

(async () => {
  let pass = 0, fail = 0;
  for (const x of tests) {
    try { await x.fn(); pass++; console.log("  ok   " + x.name); }
    catch (e) { fail++; const st = e && e.stack ? e.stack.split("\n") : [String(e)]; console.log("  FAIL " + x.name + "\n       " + st.slice(0, 3).concat(st.filter(l => /m-ui2\.test\.js/.test(l)).slice(0, 1)).join("\n       ")); }
  }
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
