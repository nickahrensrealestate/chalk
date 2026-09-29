/* node tests/m-core.test.js — plain asserts for m-core.js (no DOM) */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

/* ---- tiny browser shim ---- */
global.window = global;
global.localStorage = {
  store: {},
  getItem(k) { return this.store[k] ?? null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; }
};

vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "m-core.js"), "utf8"), { filename: "m-core.js" });
const M = global.M;

/* ---- fake clock: local noon on a fixed day, advanceable ---- */
const DAY = 864e5;
let NOW = new Date(2026, 8, 28, 12, 0, 0).getTime(); // Sep 28 2026, local
M.now = () => NOW;
const localKey = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || "") + " expected " + a + " ≈ " + b + " (±" + tol + ")");

const tests = [];
function t(name, fn) { tests.push({ name, fn }); }
/* What is on disk (the main key). */
const diskState = () => JSON.parse(localStorage.getItem(M.KEY));
const macroKeys = () => Object.keys(localStorage.store).filter(k => k.indexOf("chalk.macros") === 0).sort();

/* pretend Chalk picked Nick */
global.S = { profile: "nick" };
global.PRESETS = { nick: { name: "Nick" }, kat: { name: "Katerina" } };
M.reset();

console.log("m-core.js");

t("load: state shape + persistence key", () => {
  assert.strictEqual(M.KEY, "chalk.macros.v1");
  assert.deepStrictEqual(M.SLOTS, ["Breakfast", "Lunch", "Dinner", "Snacks"]);
  assert.deepStrictEqual(M.NUT, ["cal", "p", "c", "f", "fiber", "sugar", "sodium"]);
  assert.strictEqual(M.MS.v, 1);
  assert.deepStrictEqual(Object.keys(M.MS).sort(), ["body", "days", "foods", "meals", "profiles", "ui", "updatedAt", "v"]);
  const mainBefore = localStorage.getItem(M.KEY);
  M.setMode("macros");
  const raw = JSON.parse(localStorage.getItem(M.UI_KEY));
  assert.strictEqual(raw.mode, "macros");
  assert.strictEqual(localStorage.getItem(M.KEY), mainBefore, "a mode tap never rewrites the diary");
  M.setMode("train");
  assert.strictEqual(M.mode(), "train");
  M.setMode("bogus"); assert.strictEqual(M.mode(), "train");
  /* load() picks the stored copy back up */
  M.setMode("macros"); M.load(); assert.strictEqual(M.mode(), "macros");
  M.setMode("train");
});

t("dates are local, not UTC", () => {
  assert.strictEqual(M.today(), "2026-09-28");
  /* 11:30pm local on the 28th must still be the 28th even when UTC has rolled over */
  const save = NOW; NOW = new Date(2026, 8, 28, 23, 30).getTime();
  assert.strictEqual(M.today(), "2026-09-28");
  assert.strictEqual(M.today(), localKey(new Date(NOW)));
  NOW = save;
  assert.strictEqual(M.addDays("2026-09-28", 3), "2026-10-01");
  assert.strictEqual(M.addDays("2026-01-01", -1), "2025-12-31");
  assert.strictEqual(M.daysBetween("2026-09-01", "2026-09-28"), 27);
  assert.strictEqual(M.daysBetween("2026-03-07", "2026-03-09"), 2); // across US DST change
  assert.strictEqual(M.fmtDay("2026-09-28"), "Today");
  assert.strictEqual(M.fmtDay("2026-09-27"), "Yesterday");
  assert.strictEqual(M.fmtDay("2026-09-29"), "Tomorrow");
  assert.ok(/Sep/.test(M.fmtDay("2026-09-20")) && /20/.test(M.fmtDay("2026-09-20")));
  assert.strictEqual(M.tsToKey(new Date(2026, 0, 5, 1, 0).getTime()), "2026-01-05");
  assert.strictEqual(M.defaultSlot(new Date(2026, 8, 28, 8, 0)), "Breakfast");
  assert.strictEqual(M.defaultSlot(new Date(2026, 8, 28, 10, 29)), "Breakfast");
  assert.strictEqual(M.defaultSlot(new Date(2026, 8, 28, 10, 30)), "Lunch");
  /* UX2-10: Breakfast < 10:30, Lunch < 14:30, Snacks 14:30–17:00, Dinner 17:00–20:30, Snacks after */
  assert.strictEqual(M.defaultSlot(new Date(2026, 8, 28, 14, 29)), "Lunch");
  assert.strictEqual(M.defaultSlot(new Date(2026, 8, 28, 14, 30)), "Snacks");
  assert.strictEqual(M.defaultSlot(new Date(2026, 8, 28, 16, 59)), "Snacks");
  assert.strictEqual(M.defaultSlot(new Date(2026, 8, 28, 17, 0)), "Dinner");
  assert.strictEqual(M.defaultSlot(new Date(2026, 8, 28, 20, 29)), "Dinner");
  assert.strictEqual(M.defaultSlot(new Date(2026, 8, 28, 20, 30)), "Snacks");
});

t("person: reads S.profile, names from PRESETS, defaults", () => {
  assert.strictEqual(M.pid(), "nick");
  const p = M.person();
  assert.strictEqual(p.id, "nick");
  assert.strictEqual(p.name, "Nick");
  assert.strictEqual(p.split, "highprotein");
  assert.strictEqual(p.units, "us");
  assert.deepStrictEqual(p.snooze, { refresh60: 0, body14: 0 });
  assert.strictEqual(M.person("kat").name, "Katerina");
  const savedPresets = global.PRESETS; delete global.PRESETS;
  delete M.MS.profiles.kat;
  assert.strictEqual(M.person("kat").name, "Katerina");
  global.PRESETS = savedPresets;
  /* falls back to MS.ui.person when S has no profile */
  S.profile = null; M.MS.ui.person = "kat";
  assert.strictEqual(M.pid(), "kat");
  M.MS.ui.person = null; assert.strictEqual(M.pid(), null);
  S.profile = "nick";
});

t("units", () => {
  near(M.units.lb2kg(185), 83.9, 0.05);
  near(M.units.kg2lb(83.9), 185, 0.1);
  near(M.units.in2cm(71), 180.3, 0.1);
  assert.strictEqual(M.units.fmtW(185, "us"), "185 lb");
  assert.strictEqual(M.units.fmtW(185, "metric"), "83.9 kg");
  assert.strictEqual(M.units.fmtH(71, "us"), "5'11\"");
  assert.strictEqual(M.units.fmtH(71, "metric"), "180 cm");
  assert.strictEqual(M.units.parseH("5'11\"", "us"), 71);
  assert.strictEqual(M.units.parseH("5 11", "us"), 71);
  assert.strictEqual(M.units.parseH("6", "us"), 72);
  assert.strictEqual(M.units.parseH("71 in", "us"), 71);
  near(M.units.parseH("180", "metric"), 70.9, 0.1);
  assert.strictEqual(M.units.parseW("185", "us"), 185);
  near(M.units.parseW("83.9", "metric"), 185, 0.1);
});

/* ---- calc ----
   Mifflin-St Jeor, 185 lb / 71 in male: 10*83.91 + 6.25*180.34 + 5 = 1971.3, minus 5*age.
   age 40 → 1771.3 (exact per the spec formula); age 33 → 1806.3 (the ≈1806 / ≈2800 / ≈2300 / f≈64 chain). */
const nick = { sex: "m", age: 40, heightIn: 71, weightLb: 185, activity: "moderate", pace: -1, split: "highprotein" };
const nick33 = { ...nick, age: 33 };

t("calc.bmr Mifflin-St Jeor (age 40 → 1771, age 33 → 1806)", () => {
  near(M.calc.bmr(nick), 1771.3, 0.2);
  near(M.calc.bmr(nick33), 1806, 1);
  /* formula check with metric-clean numbers: 80 kg, 180 cm, 30 y male = 800 + 1125 - 150 + 5 = 1780 */
  near(M.calc.bmr({ sex: "m", age: 30, heightIn: M.units.cm2in(180), weightLb: M.units.kg2lb(80) }), 1780, 0.01);
  near(M.calc.bmr({ sex: "f", age: 30, heightIn: M.units.cm2in(160), weightLb: M.units.kg2lb(60) }), 1289, 0.01);
});

t("calc.tdee moderate (age 40 → 2745, age 33 → ≈2800)", () => {
  near(M.calc.tdee(nick), 1771.3 * 1.55, 0.5);
  near(M.calc.tdee(nick33), 2800, 3);
  assert.strictEqual(M.calc.ACT.moderate, 1.55);
  near(M.calc.tdee({ ...nick, activity: "sedentary" }), 1771.3 * 1.2, 0.5);
  near(M.calc.tdee({ ...nick, activity: "bogus" }), 1771.3 * 1.55, 0.5, "unknown activity → moderate");
});

t("calc.calories + floor", () => {
  const c = M.calc.calories(nick);
  assert.strictEqual(c.cal, Math.round(M.calc.tdee(nick) - 500)); assert.strictEqual(c.floored, false);
  near(M.calc.calories(nick33).cal, 2300, 3);
  assert.strictEqual(M.calc.calories({ ...nick, pace: 0 }).cal, Math.round(M.calc.tdee(nick)));
  const small = { sex: "f", age: 60, heightIn: 60, weightLb: 100, activity: "sedentary", pace: -2 };
  const fc = M.calc.calories(small);
  assert.strictEqual(fc.cal, 1200); assert.strictEqual(fc.floored, true);
  const smallM = { ...small, sex: "m" };
  assert.strictEqual(M.calc.calories(smallM).cal, 1500);
  assert.strictEqual(M.calc.calories(smallM).floored, true);
});

t("calc.targets highprotein at −1 lb/wk: p=185, cal≈2300, f≈64, c from the remainder", () => {
  [nick, nick33].forEach(pr => {
    const tg = M.calc.targets(pr);
    const cal = M.calc.calories(pr).cal;
    assert.strictEqual(tg.cal, cal);
    assert.strictEqual(tg.p, 185);
    assert.strictEqual(tg.f, Math.round(0.25 * cal / 9));
    assert.strictEqual(tg.c, Math.round((cal - 185 * 4 - tg.f * 9) / 4));
    assert.strictEqual(tg.fiber, Math.round(cal / 1000 * 14));
    assert.strictEqual(tg.water, 96); // 185*0.5 = 92.5 oz → nearest 8 = 96
    Object.values(tg).forEach(v => assert.strictEqual(v, Math.round(v), "targets are whole numbers"));
  });
  const tg = M.calc.targets(nick33);
  near(tg.cal, 2300, 3); near(tg.f, 64, 1); near(tg.c, (2300 - 185 * 4 - 64 * 9) / 4, 3);
  /* protein cap at 40% of calories for a heavy person on a big deficit */
  const heavy = { sex: "f", age: 50, heightIn: 62, weightLb: 300, activity: "sedentary", pace: -2, split: "highprotein" };
  const ht = M.calc.targets(heavy);
  assert.ok(ht.p * 4 <= ht.cal * 0.4 + 4, "protein capped at 40%");
  assert.ok(ht.c >= 50, "carbs floor 50");
  /* water minimum */
  assert.strictEqual(M.calc.targets({ ...nick, weightLb: 100 }).water, 64);
});

t("calc.targets percentage splits sum sensibly", () => {
  ["balanced", "lowcarb", "keto"].forEach(split => {
    const tg = M.calc.targets({ ...nick, split });
    const kcal = tg.p * 4 + tg.c * 4 + tg.f * 9;
    near(kcal, tg.cal, 12, split);
    const sp = M.calc.SPLITS[split];
    near(tg.p * 4 / tg.cal * 100, sp.p, 1, split + " p%");
    near(tg.c * 4 / tg.cal * 100, sp.c, 1, split + " c%");
    near(tg.f * 9 / tg.cal * 100, sp.f, 1, split + " f%");
  });
  const cu = M.calc.targets({ ...nick, split: "custom", custom: { p: 50, c: 25, f: 25 } });
  near(cu.p * 4 / cu.cal * 100, 50, 1);
  /* custom that doesn't add to 100 is normalized */
  const cu2 = M.calc.targets({ ...nick, split: "custom", custom: { p: 2, c: 1, f: 1 } });
  near(cu2.p * 4 / cu2.cal * 100, 50, 1);
  assert.strictEqual(M.calc.complete(nick), true);
  assert.strictEqual(M.calc.complete({ ...nick, age: null }), false);
  /* incomplete profile → defaults, never NaN */
  const d = M.calc.targets({ sex: null });
  assert.strictEqual(d.cal, 2000);
});

/* ---- foodMath ---- */
t("foodMath scale / sum / fromPer100 / pct / blank", () => {
  const per = { cal: 100, p: 10, c: 5, f: 3.3, fiber: 1, sugar: 0.5, sodium: 120 };
  const s = M.foodMath.scale(per, 1.5);
  assert.deepStrictEqual(s, { cal: 150, p: 15, c: 7.5, f: 5, fiber: 1.5, sugar: 0.8, sodium: 180 });
  const sum = M.foodMath.sum([{ per, servings: 2 }, { per: { cal: 50, p: 1 }, servings: 1 }, { per, servings: 0.5 }]);
  assert.deepStrictEqual(sum, { cal: 300, p: 26, c: 12.5, f: 8.3, fiber: 2.5, sugar: 1.3, sodium: 300 });
  assert.deepStrictEqual(M.foodMath.sum([]), M.foodMath.blank());
  assert.deepStrictEqual(M.foodMath.blank(), { cal: 0, p: 0, c: 0, f: 0, fiber: 0, sugar: 0, sodium: 0 });
  const p100 = { cal: 165, p: 31, c: 0, f: 3.6, sodium: 74 };
  assert.deepStrictEqual(M.foodMath.fromPer100(p100, 150), { cal: 247.5, p: 46.5, c: 0, f: 5.4, fiber: 0, sugar: 0, sodium: 111 });
  const pct = M.foodMath.pct({ p: 25, c: 25, f: 100 / 9 });
  assert.deepStrictEqual(pct, { p: 33, c: 33, f: 33 });
  assert.deepStrictEqual(M.foodMath.pct({}), { p: 0, c: 0, f: 0 });
});

/* ---- foods ---- */
let chickenId;
t("foods CRUD, barcode, list order, touch", () => {
  const f = M.foods.add({ name: "Kirkland Chicken", brand: "Kirkland", barcode: "0096619123456", source: "custom", serving: { qty: 4, unit: "oz", g: 113 }, per: { cal: 120, p: 26, f: 1.5 } });
  chickenId = f.id;
  assert.ok(f.id && f.createdAt && f.updatedAt);
  assert.strictEqual(f.per.c, 0); assert.strictEqual(f.per.sodium, 0);
  assert.strictEqual(M.foods.get(f.id).name, "Kirkland Chicken");
  assert.strictEqual(M.foods.findByBarcode("96619123456").id, f.id, "leading zero tolerant");
  assert.strictEqual(M.foods.findByBarcode("nope"), null);
  M.foods.update(f.id, { per: { cal: 130, p: 27 } });
  assert.strictEqual(M.foods.get(f.id).per.cal, 130);
  assert.strictEqual(M.foods.get(f.id).createdAt, f.createdAt);
  const g = M.foods.add({ name: "Old food", per: { cal: 1 } });
  M.foods.touch(g.id);
  assert.strictEqual(M.foods.list()[0].id, g.id, "lastUsed desc");
  assert.strictEqual(M.foods.get(g.id).uses, 1);
  assert.strictEqual(M.foods.remove(g.id), true);
  assert.strictEqual(M.foods.get(g.id), null);
  assert.strictEqual(M.foods.remove(g.id), false);
});

/* ---- meals ---- */
let mealId;
t("meals.computePer with servingsMade 4", () => {
  const meal = {
    name: "Chicken rice bowls", desc: "Four bowls of chicken and rice.", slot: "Lunch", servingsMade: 4,
    items: [
      { name: "Chicken", servings: 4, servingLabel: "4 oz (113 g)", per: { cal: 120, p: 26, c: 0, f: 1.5, sodium: 60 } },
      { name: "Rice", servings: 4, servingLabel: "1 cup (158 g)", per: { cal: 205, p: 4.3, c: 44.5, f: 0.4 } },
      { name: "Olive oil", servings: 2, servingLabel: "1 tbsp (14 g)", per: { cal: 120, f: 14 } }
    ]
  };
  const per = M.meals.computePer(meal);
  assert.deepStrictEqual(per, { cal: 385, p: 30.3, c: 44.5, f: 8.9, fiber: 0, sugar: 0, sodium: 60 });
  const m = M.meals.add(meal);
  mealId = m.id;
  assert.deepStrictEqual(m.per, per);
  assert.strictEqual(m.items.length, 3);
  assert.ok(m.items.every(it => it.id && !("slot" in it)));
  M.meals.update(m.id, { servingsMade: 2 });
  assert.strictEqual(M.meals.get(m.id).per.cal, 770, "update recomputes per");
  M.meals.update(m.id, { servingsMade: 4 });
  M.meals.add({ name: "Oats", slot: "Breakfast", items: [{ name: "Oats", per: { cal: 150, p: 5, c: 27, f: 3 } }] });
  M.meals.add({ name: "Any meal", slot: "Any", items: [{ name: "x", per: { cal: 10 } }] });
  assert.strictEqual(M.meals.list().length, 3);
  assert.deepStrictEqual(M.meals.list("Lunch").map(x => x.name).sort(), ["Any meal", "Chicken rice bowls"]);
  assert.strictEqual(M.meals.list("Dinner").length, 1);
});

/* ---- log ---- */
const today = M.today(), yday = M.addDays(today, -1);
t("log add / totals / move / remove / copySlot / clearSlot / water", () => {
  assert.strictEqual(M.dayOf(today), null, "dayOf never creates");
  const e1 = M.log.add(today, { slot: "Breakfast", name: "Eggs", servings: 3, servingLabel: "1 large (50 g)", g: 50, per: { cal: 72, p: 6.3, c: 0.4, f: 4.8 } });
  assert.ok(e1.id && e1.at);
  const e2 = M.log.add(today, { slot: "Breakfast", foodId: chickenId, servings: 2 });
  assert.strictEqual(e2.name, "Kirkland Chicken", "name pulled from food");
  assert.strictEqual(e2.servingLabel, "4 oz (113 g)");
  assert.strictEqual(e2.per.cal, 130);
  assert.strictEqual(M.foods.get(chickenId).uses, 1, "add touches food");
  const tot = M.log.totals(today);
  near(tot.cal, 72 * 3 + 130 * 2, 0.01); near(tot.p, 6.3 * 3 + 27 * 2, 0.01);
  assert.strictEqual(tot.cal, Math.round(tot.cal * 10) / 10);
  assert.deepStrictEqual(M.log.slotTotals(today, "Lunch"), M.foodMath.blank());
  assert.strictEqual(M.log.slotEntries(today, "Breakfast").length, 2);
  M.log.move(today, e2.id, "Lunch");
  assert.strictEqual(M.log.slotEntries(today, "Breakfast").length, 1);
  assert.strictEqual(M.log.slotTotals(today, "Lunch").cal, 260);
  assert.strictEqual(M.log.move(today, e2.id, "Brunch"), null);
  M.log.update(today, e1.id, { servings: 2 });
  assert.strictEqual(M.log.slotTotals(today, "Breakfast").cal, 144);
  /* meal → one entry */
  const ents = M.log.addMeal(today, mealId, 1.5, "Dinner");
  assert.strictEqual(ents.length, 1);
  assert.strictEqual(ents[0].mealId, mealId);
  assert.strictEqual(ents[0].name, "Chicken rice bowls");
  assert.strictEqual(ents[0].servingLabel, "1 serving");
  assert.strictEqual(ents[0].servings, 1.5);
  assert.deepStrictEqual(ents[0].per, M.meals.get(mealId).per);
  assert.strictEqual(M.meals.get(mealId).uses, 1);
  near(M.log.slotTotals(today, "Dinner").cal, 385 * 1.5, 0.01);
  assert.deepStrictEqual(M.log.addMeal(today, "nope", 1, "Dinner"), []);
  /* copy + clear */
  const copied = M.log.copySlot(today, yday, "Breakfast");
  assert.strictEqual(copied.length, 1);
  assert.notStrictEqual(copied[0].id, e1.id);
  assert.strictEqual(M.log.slotTotals(yday, "Breakfast").cal, 144);
  assert.strictEqual(M.log.clearSlot(yday, "Breakfast"), 1);
  assert.strictEqual(M.log.slotEntries(yday, "Breakfast").length, 0);
  assert.strictEqual(M.log.clearSlot(yday, "Breakfast"), 0);
  assert.deepStrictEqual(M.log.copySlot("2000-01-01", today, "Lunch"), []);
  /* remove */
  assert.strictEqual(M.log.remove(today, e2.id), true);
  assert.strictEqual(M.log.remove(today, e2.id), false);
  assert.strictEqual(M.log.slotEntries(today, "Lunch").length, 0);
  /* water */
  assert.strictEqual(M.log.setWater(today, 24), 24);
  assert.strictEqual(M.log.setWater(today, -5), 0);
  assert.strictEqual(M.day(today).water, 0);
  M.log.setWater(today, 16);
  assert.deepStrictEqual(M.log.loggedDays("nick"), [today]);
  /* other person's days are separate */
  assert.deepStrictEqual(M.log.loggedDays("kat"), []);
  assert.strictEqual(M.log.totals(today, "kat").cal, 0);
  assert.strictEqual(diskState().days["nick|" + today].entries.length, 2, "persisted");
});

/* ---- body ---- */
t("body add merges by date and updates weightLb; latest/list/series", () => {
  const p = M.person("nick");
  const b1 = M.body.add({ date: "2026-09-27", w: 186.2 });
  assert.strictEqual(b1.id, "nick|2026-09-27");
  assert.strictEqual(b1.rhr, null);
  const b2 = M.body.add({ date: "2026-09-27", rhr: 58 });
  assert.strictEqual(b2, M.MS.body["nick|2026-09-27"]);
  assert.strictEqual(b2.w, 186.2, "merge keeps weight");
  assert.strictEqual(b2.rhr, 58);
  assert.strictEqual(p.weightLb, 186.2);
  assert.strictEqual(p.lastBody, NOW);
  M.body.add({ date: "2026-09-28", w: 185.6, rhr: "57" });
  assert.strictEqual(p.weightLb, 185.6);
  /* older date does not overwrite current weight */
  M.body.add({ date: "2026-09-01", w: 190 });
  assert.strictEqual(p.weightLb, 185.6);
  assert.strictEqual(M.body.add({ date: "2026-09-29" }), null, "nothing given → nothing written");
  assert.deepStrictEqual(M.body.list("nick").map(b => b.date), ["2026-09-01", "2026-09-27", "2026-09-28"]);
  assert.deepStrictEqual(M.body.latest("nick", "w"), { date: "2026-09-28", value: 185.6 });
  assert.deepStrictEqual(M.body.latest("nick", "rhr"), { date: "2026-09-28", value: 57 });
  assert.strictEqual(M.body.latest("kat", "w"), null);
  assert.strictEqual(M.body.series("nick", "w", 7).length, 2);
  assert.strictEqual(M.body.series("nick", "rhr", 0).length, 2);
  assert.strictEqual(M.body.remove("2026-09-01"), true);
  assert.strictEqual(M.body.list("nick").length, 2);
});

t("body avg7 + ratePerWeek on a 28-day series losing ~1 lb/wk ≈ −1", () => {
  M.MS.body = {};
  const start = M.addDays(today, -27);
  for (let i = 0; i < 28; i++) {
    const wobble = [0.4, -0.3, 0.2, -0.5, 0.1, 0.3, -0.2][i % 7];
    M.body.add({ date: M.addDays(start, i), w: Math.round((190 - i / 7 + wobble) * 10) / 10 });
  }
  const s = M.body.series("nick", "w", 28);
  assert.strictEqual(s.length, 28);
  const a = M.body.avg7(s);
  assert.strictEqual(a.length, 28);
  assert.strictEqual(a[0].v, s[0].v, "first point is its own average");
  near(a[6].v, 190 - 3 / 7, 0.05, "7th point = mean of days 0..6 (wobble sums to 0)");
  near(a[27].v, 190 - 24 / 7, 0.05);
  const rate = M.body.ratePerWeek("nick");
  near(rate, -1, 0.1, "rate/wk");
  /* not enough data → null */
  M.MS.body = {};
  M.body.add({ date: today, w: 185 });
  assert.strictEqual(M.body.ratePerWeek("nick"), null);
  assert.deepStrictEqual(M.body.avg7([]), []);
});

/* ---- checkins ---- */
t("checkins.due transitions + snooze", () => {
  const p = M.person("nick");
  p.setupAt = null; p.lastBody = 0; p.snooze = { refresh60: 0, body14: 0 };
  assert.strictEqual(M.checkins.due("nick"), "setup");
  M.checkins.done("nick", "setup");
  assert.strictEqual(p.setupAt, NOW);
  assert.strictEqual(M.checkins.due("nick"), null, "nothing due right after setup");
  const t0 = NOW;
  NOW = t0 + 15 * DAY;
  assert.strictEqual(M.checkins.due("nick"), "body14");
  M.checkins.snooze("nick", "body14", 14);
  assert.strictEqual(M.checkins.due("nick"), null, "snoozed");
  NOW = t0 + 15 * DAY + 14 * DAY + 1;
  assert.strictEqual(M.checkins.due("nick"), "body14", "snooze expired");
  M.body.add({ date: M.today(), w: 184 });
  assert.strictEqual(M.checkins.due("nick"), null, "logging body clears it");
  NOW = t0 + 61 * DAY;
  assert.strictEqual(M.checkins.due("nick"), "refresh60", "refresh60 outranks body14");
  M.checkins.snooze("nick", "refresh60", 7);
  assert.strictEqual(M.checkins.due("nick"), "body14");
  M.checkins.done("nick", "body14");
  assert.strictEqual(M.checkins.due("nick"), null);
  NOW = t0 + 69 * DAY;
  assert.strictEqual(M.checkins.due("nick"), "refresh60");
  M.checkins.done("nick", "refresh60");
  assert.strictEqual(p.setupAt, NOW);
  assert.strictEqual(M.checkins.due("nick"), null);
  assert.strictEqual(M.checkins.due(null), null);
  NOW = t0;
});

/* ---- recents + search ---- */
t("recents dedupes by name, newest first, 60-day window", () => {
  M.MS.days = {};
  M.log.add(M.addDays(today, -70), { slot: "Lunch", name: "Ancient", per: { cal: 1 } });
  M.log.add(M.addDays(today, -3), { slot: "Lunch", name: "Eggs", servings: 2, per: { cal: 72 }, at: NOW - 3 * DAY });
  M.log.add(M.addDays(today, -1), { slot: "Lunch", name: "eggs", servings: 3, per: { cal: 72 }, at: NOW - DAY });
  M.log.add(today, { slot: "Breakfast", name: "Oatmeal", per: { cal: 150 }, at: NOW });
  const r = M.recents("nick");
  assert.deepStrictEqual(r.map(x => x.name), ["Oatmeal", "eggs"]);
  assert.strictEqual(r[1].count, 2);
  assert.strictEqual(r[1].servings, 3, "latest entry's serving wins");
  assert.strictEqual(M.recents("nick", 1).length, 1);
});

t("search: empty query → recents then slot meals then other meals", () => {
  const res = M.search("", { pid: "nick", slot: "Lunch" });
  /* UX2-07: in a slot, what they log most there (last 14 days) comes first, then the newest */
  assert.strictEqual(res[0].kind, "recent"); assert.strictEqual(res[0].name, "eggs");
  /* WK-08: recents eaten in this meal, this meal's saved meals, "Any time" meals, other recents, other meals */
  assert.deepStrictEqual(res.slice(0, 5).map(x => x.kind + ":" + x.name), ["recent:eggs", "meal:Chicken rice bowls", "meal:Any meal", "recent:Oatmeal", "meal:Oats"]);
  assert.deepStrictEqual(M.search("", { pid: "nick", slot: "Breakfast" }).slice(0, 1).map(x => x.name), ["Oatmeal"]);
  const meals = res.filter(x => x.kind === "meal").map(x => x.name);
  assert.deepStrictEqual(meals, ["Chicken rice bowls", "Any meal", "Oats"], "Lunch meal first, then Any, then others");
  assert.ok(res.every(x => x.per && typeof x.per.cal === "number" && x.serving && Array.isArray(x.alts) && "sub" in x));
  assert.strictEqual(res.find(x => x.kind === "meal").sub, "1 serving");
  assert.strictEqual(M.search("", { pid: "nick", slot: "Lunch", limit: 2 }).length, 2);
});

t("search: query 'chick' finds generic 'Chicken breast, cooked' and ranks prefix matches first", () => {
  M.DB = M.DB || {};
  M.DB.generic = [
    { id: "g_chicken_breast_cooked", name: "Chicken breast, cooked", brand: "", source: "generic", serving: { qty: 4, unit: "oz", g: 113 }, per: { cal: 187, p: 35, c: 0, f: 4 }, alts: [{ label: "1 oz", g: 28 }] },
    { id: "g_chickpeas", name: "Chickpeas, canned", brand: "", source: "generic", serving: { qty: 0.5, unit: "cup", g: 120 }, per: { cal: 105, p: 6, c: 18, f: 2 } },
    { id: "g_brown_rice", name: "Brown rice, cooked", brand: "", source: "generic", serving: { qty: 1, unit: "cup", g: 195 }, per: { cal: 216, p: 5, c: 45, f: 1.8 } },
    { id: "g_salad", name: "Salad with chicken", brand: "", source: "generic", serving: { qty: 1, unit: "bowl", g: 300 }, per: { cal: 350, p: 30, c: 10, f: 20 } }
  ];
  const res = M.search("chick", { pid: "nick", slot: "Dinner" });
  const names = res.map(x => x.name);
  assert.ok(names.includes("Chicken breast, cooked"), "generic found: " + names.join(", "));
  assert.ok(!names.includes("Brown rice, cooked"));
  const gen = res.find(x => x.id === "g_chicken_breast_cooked");
  assert.strictEqual(gen.kind, "generic");
  assert.strictEqual(gen.sub, "4 oz (113 g)");
  assert.strictEqual(gen.alts[0].g, 28);
  assert.strictEqual(gen.ref, M.DB.generic[0]);
  /* my food + meal that match come before generic; prefix beats mid-word */
  assert.ok(names.indexOf("Kirkland Chicken") < names.indexOf("Chicken breast, cooked"), "my foods rank above generic");
  assert.ok(names.indexOf("Chicken rice bowls") < names.indexOf("Chicken breast, cooked"), "meals rank above generic");
  assert.ok(names.indexOf("Chicken breast, cooked") < names.indexOf("Salad with chicken"), "prefix beats mid-name");
  /* all tokens must match; case-insensitive; brand counts */
  assert.strictEqual(M.search("CHICKEN kirkland", { pid: "nick" }).map(x => x.name)[0], "Kirkland Chicken");
  assert.strictEqual(M.search("chicken zebra", { pid: "nick" }).length, 0);
  assert.strictEqual(M.search("rice", { pid: "nick" }).some(x => x.name === "Brown rice, cooked"), true);
  /* slot boost: a Lunch meal ranks higher when searching for Lunch than for Dinner */
  const lunchIdx = M.search("chicken", { pid: "nick", slot: "Lunch" }).findIndex(x => x.kind === "meal");
  assert.strictEqual(lunchIdx, 0, "slot-matching meal on top");
  assert.strictEqual(M.search("chick", { pid: "nick", limit: 2 }).length, 2);
  /* generic foods resolvable through M.foods.get */
  assert.strictEqual(M.foods.get("g_chickpeas").name, "Chickpeas, canned");
  /* M.DB absent → still fine */
  const keep = M.DB; delete M.DB;
  assert.ok(M.search("chick", { pid: "nick" }).length >= 1);
  M.DB = keep;
});

/* ---- streak + week ---- */
t("streak counts consecutive days ending today or yesterday", () => {
  M.MS.days = {};
  assert.strictEqual(M.streak("nick"), 0);
  [0, 1, 2, 3, 4].forEach(i => M.log.add(M.addDays(today, -i), { slot: "Lunch", name: "x", per: { cal: 1 } }));
  M.log.add(M.addDays(today, -6), { slot: "Lunch", name: "x", per: { cal: 1 } }); // gap at -5
  assert.strictEqual(M.streak("nick"), 5);
  M.log.clearSlot(today, "Lunch");
  assert.strictEqual(M.streak("nick"), 4, "yesterday still counts");
  M.log.clearSlot(yday, "Lunch");
  assert.strictEqual(M.streak("nick"), 0);
  assert.strictEqual(M.streak("kat"), 0);
});

t("weekSummary", () => {
  M.MS.days = {};
  M.log.add(today, { slot: "Lunch", name: "a", per: { cal: 2000, p: 150, c: 200, f: 60 } });
  M.log.add(yday, { slot: "Lunch", name: "b", per: { cal: 1000, p: 50, c: 100, f: 40 } });
  const w = M.weekSummary("nick");
  assert.strictEqual(w.days, 7); assert.strictEqual(w.logged, 2);
  /* BEC-12: today is still going, so it stays out of the averages; its bar still shows */
  assert.strictEqual(w.avgCal, 1000); assert.strictEqual(w.avgP, 50); assert.strictEqual(w.avgC, 100); assert.strictEqual(w.avgF, 40);
  assert.strictEqual(w.avgDays, 1); assert.strictEqual(w.todayLeftOut, true);
  assert.strictEqual(w.end, today); assert.strictEqual(w.daily.length, 7);
  assert.strictEqual(w.daily[6].date, today); assert.strictEqual(w.daily[6].sofar, true); assert.strictEqual(w.daily[6].cal, 2000);
  assert.ok(!w.daily[5].sofar);
  /* only today logged: its numbers stand in */
  M.MS.days = {};
  M.log.add(today, { slot: "Lunch", name: "a", per: { cal: 2000, p: 150, c: 200, f: 60 } });
  const w1 = M.weekSummary("nick");
  assert.strictEqual(w1.avgCal, 2000); assert.strictEqual(w1.todayLeftOut, false); assert.strictEqual(w1.logged, 1);
  M.log.add(yday, { slot: "Lunch", name: "b", per: { cal: 1000, p: 50, c: 100, f: 40 } });
  assert.ok(w.target && typeof w.target.cal === "number");
  const prev = M.weekSummary("nick", 1);
  assert.strictEqual(prev.logged, 0); assert.strictEqual(prev.avgCal, 0);
  assert.strictEqual(prev.end, M.addDays(today, -7));
});

/* ---- export / import / reset ---- */
t("export / import merge / reset", () => {
  const ex = M.export();
  assert.strictEqual(ex.v, 1);
  assert.notStrictEqual(ex, M.MS, "plain copy");
  assert.strictEqual(M.import({ v: 2 }), false);
  assert.strictEqual(M.import(null), false);
  const foodsBefore = Object.keys(M.MS.foods).length;
  const inc = M.cp(ex);
  inc.foods["zzz"] = { id: "zzz", name: "Imported", per: { cal: 5 }, updatedAt: 1 };
  inc.days["nick|2020-01-01"] = { id: "nick|2020-01-01", pid: "nick", date: "2020-01-01", entries: [{ id: "e", slot: "Lunch", name: "old", servings: 1, per: { cal: 9 } }], water: 0, note: "", updatedAt: 5 };
  assert.strictEqual(M.import(inc), true);
  assert.strictEqual(Object.keys(M.MS.foods).length, foodsBefore + 1);
  assert.ok(M.MS.days["nick|2020-01-01"]);
  assert.strictEqual(M.MS.days["nick|" + today].entries.length, 1, "existing days kept");
  M.reset();
  assert.deepStrictEqual(M.MS.foods, {}); assert.deepStrictEqual(M.MS.days, {});
  assert.strictEqual(M.mode(), "train");
  assert.strictEqual(JSON.parse(localStorage.getItem(M.KEY)).v, 1, "reset re-persists a fresh state");
});

/* ---- raw ↔ cooked ----
   A few built-in foods exactly as m-data.js had them when these numbers were checked
   (USDA chicken breast, rice, pasta, 80/20 beef, banana …). Fixed here so food-list
   changes in m-data.js (tests/m-data.test.js checks those) don't move m-core's tests. */
const FOODS_FIXTURE = {"generic":[{"id":"g_chicken_breast","name":"Chicken breast, boneless skinless","brand":"","barcode":"","source":"generic","serving":{"qty":4,"unit":"oz","g":113},"per":{"cal":136,"p":25.4,"c":0,"f":2.9,"fiber":0,"sugar":0,"sodium":51},"per100g":{"cal":120,"p":22.5,"c":0,"f":2.6,"fiber":0,"sugar":0,"sodium":45},"alts":[{"label":"1 oz","g":28},{"label":"3 oz","g":85},{"label":"6 oz","g":170},{"label":"8 oz","g":227},{"label":"100 g","g":100}],"uses":0,"lastUsed":0,"createdAt":0,"updatedAt":0,"pid":null,"cook":{"y":0.7258,"word":"raw","per100gCooked":{"cal":165,"p":31,"c":0,"f":3.6,"fiber":0,"sugar":0,"sodium":74},"alts":[]}},{"id":"g_kirkland_organic_chicken","name":"Chicken breast, organic frozen (Kirkland)","brand":"Kirkland","barcode":"","source":"generic","serving":{"qty":4,"unit":"oz","g":112},"per":{"cal":134,"p":25.2,"c":0,"f":2.9,"fiber":0,"sugar":0,"sodium":50},"per100g":{"cal":120,"p":22.5,"c":0,"f":2.6,"fiber":0,"sugar":0,"sodium":45},"alts":[{"label":"1 oz","g":28},{"label":"3 oz","g":85},{"label":"6 oz","g":170},{"label":"8 oz","g":227},{"label":"100 g","g":100}],"uses":0,"lastUsed":0,"createdAt":0,"updatedAt":0,"pid":null,"cook":{"y":0.7258,"word":"raw","per100gCooked":{"cal":165,"p":31,"c":0,"f":3.6,"fiber":0,"sugar":0,"sodium":74},"alts":[]}},{"id":"g_chicken_thigh","name":"Chicken thigh, boneless skinless","brand":"","barcode":"","source":"generic","serving":{"qty":4,"unit":"oz","g":113},"per":{"cal":137,"p":22.3,"c":0,"f":4.6,"fiber":0,"sugar":0,"sodium":97},"per100g":{"cal":121,"p":19.7,"c":0,"f":4.1,"fiber":0,"sugar":0,"sodium":86},"alts":[{"label":"1 oz","g":28},{"label":"3 oz","g":85},{"label":"6 oz","g":170},{"label":"8 oz","g":227},{"label":"100 g","g":100}],"uses":0,"lastUsed":0,"createdAt":0,"updatedAt":0,"pid":null,"cook":{"y":0.7944,"word":"raw","per100gCooked":{"cal":179,"p":24.8,"c":0,"f":8.2,"fiber":0,"sugar":0,"sodium":95},"alts":[]}},{"id":"g_ground_beef_80","name":"Ground beef 80/20","brand":"","barcode":"","source":"generic","serving":{"qty":4,"unit":"oz","g":113},"per":{"cal":287,"p":19.4,"c":0,"f":22.6,"fiber":0,"sugar":0,"sodium":75},"per100g":{"cal":254,"p":17.2,"c":0,"f":20,"fiber":0,"sugar":0,"sodium":66},"alts":[{"label":"1 oz","g":28},{"label":"3 oz","g":85},{"label":"6 oz","g":170},{"label":"8 oz","g":227},{"label":"100 g","g":100}],"uses":0,"lastUsed":0,"createdAt":0,"updatedAt":0,"pid":null,"cook":{"y":0.688,"word":"raw","per100gCooked":{"cal":250,"p":25,"c":0,"f":16,"fiber":0,"sugar":0,"sodium":86},"alts":[]}},{"id":"g_chicken_sausage","name":"Chicken sausage link, cooked","brand":"","barcode":"","source":"generic","serving":{"qty":1,"unit":"link","g":85},"per":{"cal":170,"p":13,"c":4,"f":11,"fiber":0,"sugar":3,"sodium":560},"per100g":{"cal":200,"p":15.3,"c":4.7,"f":12.9,"fiber":0,"sugar":3.5,"sodium":659},"alts":[{"label":"1/2 link","g":43},{"label":"100 g","g":100}],"uses":0,"lastUsed":0,"createdAt":0,"updatedAt":0,"pid":null},{"id":"g_white_rice","name":"White rice","brand":"","barcode":"","source":"generic","serving":{"qty":0.25,"unit":"cup","g":46},"per":{"cal":168,"p":3.3,"c":36.8,"f":0.3,"fiber":0.6,"sugar":0,"sodium":2},"per100g":{"cal":365,"p":7.1,"c":80,"f":0.7,"fiber":1.3,"sugar":0.1,"sodium":5},"alts":[{"label":"1/2 cup","g":92},{"label":"1 cup","g":185},{"label":"100 g","g":100}],"uses":0,"lastUsed":0,"createdAt":0,"updatedAt":0,"pid":null,"cook":{"y":2.8077,"word":"dry","per100gCooked":{"cal":130,"p":2.7,"c":28.2,"f":0.3,"fiber":0.4,"sugar":0.1,"sodium":1},"alts":[{"label":"1/2 cup","g":79},{"label":"3/4 cup","g":118},{"label":"1 cup","g":158},{"label":"100 g","g":100}]}},{"id":"g_pasta","name":"Pasta","brand":"","barcode":"","source":"generic","serving":{"qty":2,"unit":"oz","g":56},"per":{"cal":208,"p":7.3,"c":41.8,"f":0.8,"fiber":1.8,"sugar":1.5,"sodium":3},"per100g":{"cal":371,"p":13,"c":74.7,"f":1.5,"fiber":3.2,"sugar":2.7,"sodium":6},"alts":[{"label":"1 oz","g":28},{"label":"100 g","g":100}],"uses":0,"lastUsed":0,"createdAt":0,"updatedAt":0,"pid":null,"cook":{"y":2.3481,"word":"dry","per100gCooked":{"cal":158,"p":5.8,"c":31,"f":0.9,"fiber":1.8,"sugar":0.6,"sodium":1},"alts":[{"label":"1/2 cup","g":70},{"label":"1 cup","g":140},{"label":"2 cups","g":280},{"label":"100 g","g":100}]}},{"id":"g_banana","name":"Banana","brand":"","barcode":"","source":"generic","serving":{"qty":1,"unit":"medium","g":118},"per":{"cal":105,"p":1.3,"c":26.9,"f":0.4,"fiber":3.1,"sugar":14.4,"sodium":1},"per100g":{"cal":89,"p":1.1,"c":22.8,"f":0.3,"fiber":2.6,"sugar":12.2,"sodium":1},"alts":[{"label":"1 small","g":101},{"label":"1 large","g":136},{"label":"1/2 banana","g":59},{"label":"100 g","g":100}],"uses":0,"lastUsed":0,"createdAt":0,"updatedAt":0,"pid":null}],"alias":{"g_chicken_breast_raw":{"id":"g_chicken_breast","state":"raw"},"g_chicken_breast_cooked":{"id":"g_chicken_breast","state":"cooked"},"g_chicken_thigh_raw":{"id":"g_chicken_thigh","state":"raw"},"g_chicken_thigh_cooked":{"id":"g_chicken_thigh","state":"cooked"},"g_ground_beef_80_raw":{"id":"g_ground_beef_80","state":"raw"},"g_ground_beef_80_cooked":{"id":"g_ground_beef_80","state":"cooked"},"g_white_rice_dry":{"id":"g_white_rice","state":"raw"},"g_white_rice_cooked":{"id":"g_white_rice","state":"cooked"},"g_pasta_dry":{"id":"g_pasta","state":"raw"},"g_pasta_cooked":{"id":"g_pasta","state":"cooked"}}};
const loadData = () => { M.DB = JSON.parse(JSON.stringify(FOODS_FIXTURE)); };
const CHK = { y: 0.7258, word: "raw" }, RICE = { y: 2.8077, word: "dry" };

t("cook.label: raw first, cooked in parentheses (US, metric, dry, cups, no y)", () => {
  loadData();
  assert.strictEqual(M.cook.label(6 * M.cook.OZ, "raw", CHK, "us"), "6 oz raw (4.4 oz cooked)");
  assert.strictEqual(M.cook.label(170, "raw", CHK, "metric"), "170 g raw (123 g cooked)");
  assert.strictEqual(M.cook.label(2 * M.cook.OZ, "raw", RICE, "us"), "2 oz dry (5.6 oz cooked)");
  assert.strictEqual(M.cook.label(4.4 * M.cook.OZ, "cooked", CHK, "oz"), "6.1 oz raw (4.4 oz cooked)", "cooked weight converts back to raw");
  assert.strictEqual(M.cook.label(158, "cooked", RICE, "us", { vol: { unit: "cup", g: 158 } }), "2 oz dry (1 cup cooked)");
  assert.strictEqual(M.cook.label(46, "raw", RICE, "us", { vol: { unit: "cup", g: 184 } }), "¼ cup dry (4.6 oz cooked)");
  assert.strictEqual(M.cook.label(237, "cooked", RICE, "metric", { vol: { unit: "cup", g: 158 } }), "84 g dry (1 ½ cups cooked)");
  assert.strictEqual(M.cook.label(12 * M.cook.OZ, "cooked", null, "us"), "12 oz cooked", "no y known: only the weighed side");
  assert.strictEqual(M.cook.label(1.5 * M.cook.LB, "raw", CHK, "lb"), "1.5 lb raw (1.09 lb cooked)");
});

t("merged foods: old raw/cooked ids resolve to one food; y and both profiles kept", () => {
  const f = M.foods.get("g_chicken_breast");
  assert.ok(f && M.cook.of(f), "merged chicken breast has cook");
  assert.strictEqual(M.foods.get("g_chicken_breast_cooked"), f);
  assert.strictEqual(M.foods.get("g_chicken_breast_raw"), f);
  assert.deepStrictEqual(M.cook.alias("g_chicken_breast_cooked"), { id: "g_chicken_breast", state: "cooked" });
  assert.deepStrictEqual(M.cook.alias("g_white_rice_dry"), { id: "g_white_rice", state: "raw" });
  assert.strictEqual(M.cook.alias("g_banana"), null);
  near(f.cook.y, 22.5 / 31, 0.0001, "y = raw protein ÷ cooked protein");
  near(M.foods.get("g_white_rice").cook.y, 365 / 130, 0.0001, "y = dry kcal ÷ cooked kcal");
  assert.strictEqual(M.cook.per100(f, "raw").cal, 120);
  assert.strictEqual(M.cook.per100(f, "cooked").cal, 165);
  assert.deepStrictEqual(M.cook.perFor(f, "cooked", 100), M.foodMath.fromPer100(f.cook.per100gCooked, 100));
  const k = M.foods.get("g_kirkland_organic_chicken");
  assert.deepStrictEqual(k.cook.per100gCooked, f.cook.per100gCooked, "Kirkland gets chicken breast's cooked profile");
  assert.strictEqual(M.cook.servingLabel(f, "us"), "4 oz raw (2.9 oz cooked)");
  assert.strictEqual(M.cook.servingLabel(M.foods.get("g_white_rice"), "us"), "¼ cup dry (4.6 oz cooked)");
  assert.strictEqual(M.cook.servingLabel(M.foods.get("g_banana"), "us"), "", "plain foods have no cook label");
});

t("cook.unitsFor: oz/g/lb raw and cooked; cooked units use the cooked profile (fat that cooks off)", () => {
  const beef = M.foods.get("g_ground_beef_80");
  const u = M.cook.unitsFor(beef, "us");
  assert.deepStrictEqual(u.map(o => o.key), ["oz-raw", "oz-cooked", "g-raw", "g-cooked", "lb-raw", "lb-cooked"]);
  assert.deepStrictEqual(u.map(o => o.label).slice(0, 4), ["oz raw", "oz cooked", "g raw", "g cooked"]);
  const g = k => u.find(o => o.key === k);
  near(g("g-raw").per.cal, 2.54, 1e-6); near(g("g-cooked").per.cal, 2.5, 1e-6);
  near(g("g-raw").per.f, 0.2, 1e-6); near(g("g-cooked").per.f, 0.16, 1e-6);
  /* 100 g raw becomes 68.8 g cooked; logged cooked, that meat has less fat than the raw number */
  const rawF = g("g-raw").per.f * 100, cookedF = g("g-cooked").per.f * 100 * beef.cook.y;
  assert.ok(cookedF < rawF, "fat that cooks off counts: " + cookedF + " < " + rawF);
  assert.strictEqual(g("oz-raw").step, 0.5); assert.strictEqual(g("g-raw").step, 5); assert.strictEqual(g("lb-raw").step, 0.25);
  assert.deepStrictEqual(M.cook.unitsFor(beef, "metric").slice(0, 2).map(o => o.key), ["g-raw", "g-cooked"], "metric lists grams first");
  const rice = M.cook.unitsFor(M.foods.get("g_white_rice"), "us");
  const cup = rice.find(o => o.key === "cup-cooked"), dcup = rice.find(o => o.key === "cup-raw");
  assert.ok(cup && dcup, "rice has cup dry and cup cooked");
  assert.strictEqual(cup.label, "cup cooked"); assert.strictEqual(dcup.label, "cup dry");
  assert.strictEqual(cup.g, 158); near(cup.per.cal, 205.4, 0.01);
  assert.deepStrictEqual(M.cook.unitsFor(M.foods.get("g_banana"), "us"), []);
  /* cooked view for code that only knows plain foods */
  const v = M.cook.view(M.foods.get("g_white_rice"), "cooked");
  assert.deepStrictEqual([v.serving.qty, v.serving.unit, v.serving.g, v.per.cal, v.state], [1, "cup", 158, 205.4, "cooked"]);
  assert.strictEqual(M.cook.view(M.foods.get("g_chicken_breast"), "cooked").per.cal, 186.5);
  assert.strictEqual(M.cook.view(M.foods.get("g_banana"), "cooked"), M.foods.get("g_banana"));
});

t("entries: state + cook stored; old ids canonicalized; labels read raw first everywhere", () => {
  M.MS.days = {};
  const f = M.foods.get("g_chicken_breast"), oz = M.cook.OZ;
  const u = M.cook.unitsFor(f, "us"), ozRaw = u.find(o => o.key === "oz-raw"), ozCk = u.find(o => o.key === "oz-cooked");
  const e1 = M.log.add(today, { slot: "Lunch", name: f.name, foodId: f.id, servings: 6, servingLabel: "1 oz raw", g: ozRaw.g, per: ozRaw.per, state: "raw", cook: { y: f.cook.y, word: "raw" } });
  assert.strictEqual(e1.state, "raw"); assert.deepStrictEqual(e1.cook, { y: f.cook.y, word: "raw" });
  assert.strictEqual(M.cook.entryLabel(e1, "us"), "6 oz raw (4.4 oz cooked)");
  near(M.log.totals(today).cal, 6 * oz * 1.2, 0.1, "raw profile");
  const e2 = M.log.add(today, { slot: "Dinner", name: f.name, foodId: f.id, servings: 4, servingLabel: "1 oz cooked", g: ozCk.g, per: ozCk.per, state: "cooked" });
  assert.deepStrictEqual(e2.cook, { y: f.cook.y, word: "raw" }, "cook filled from the food");
  assert.strictEqual(M.cook.entryLabel(e2, "us"), "5.5 oz raw (4 oz cooked)");
  near(M.log.slotTotals(today, "Dinner").cal, 4 * oz * 1.65, 0.1, "cooked profile");
  /* grams logged in metric read in grams */
  const gRaw = u.find(o => o.key === "g-raw");
  const e3 = M.log.add(today, { slot: "Snacks", foodId: f.id, servings: 170, servingLabel: "1 g raw", g: 1, per: gRaw.per, state: "raw" });
  assert.strictEqual(M.cook.entryLabel(e3, "us"), "170 g raw (123 g cooked)", "the unit weighed wins over the person's units");
  /* an entry saved before the merge */
  const legacy = { id: "old1", slot: "Lunch", name: "Chicken breast, cooked", foodId: "g_chicken_breast_cooked", servings: 1.5, servingLabel: "4 oz (113 g)", g: 113, per: { cal: 186, p: 35, c: 0, f: 4.1 }, at: NOW };
  assert.strictEqual(M.cook.entryLabel(legacy, "us"), "8.2 oz raw (6 oz cooked)");
  const e4 = M.log.add(today, Object.assign({}, legacy, { id: undefined }));
  assert.strictEqual(e4.foodId, "g_chicken_breast", "old id canonicalized"); assert.strictEqual(e4.state, "cooked");
  assert.strictEqual(e4.per.cal, 186, "logged numbers never change");
  const e5 = M.log.add(today, { slot: "Lunch", foodId: "g_white_rice_cooked", servings: 1 });
  assert.strictEqual(e5.state, "cooked"); assert.strictEqual(e5.per.cal, 205.4, "a bare old cooked id fills from the cooked profile");
  assert.strictEqual(M.cook.entryLabel(e5, "us"), "2 oz dry (1 cup cooked)");
  /* describe items carry the whole portion in g; the label's grams win */
  assert.strictEqual(M.cook.entryLabel({ foodId: "g_chicken_breast", state: "raw", servings: 1.5, servingLabel: "4 oz (113 g)", g: 169.5 }, "us"), "6 oz raw (4.3 oz cooked)");
  /* plain foods: nothing */
  assert.strictEqual(M.cook.entryLabel({ foodId: "g_banana", servings: 1, servingLabel: "1 medium (118 g)", g: 118 }, "us"), "");
  /* recents carry state/cook so a recent reopens the same way */
  const rc = M.recents("nick").find(x => x.name === f.name);
  assert.ok(rc && rc.state && rc.cook && rc.cook.y === f.cook.y, JSON.stringify(rc));
  assert.ok(M.search("", { pid: "nick" }).some(r => r.kind === "recent" && r.state), "recent results keep state");
});

t("custom foods: typed cook info saves y + a cooked profile of per100g ÷ y", () => {
  const f = M.foods.add({ name: "Chicken breast (scanned bag)", source: "label", serving: { qty: 4, unit: "oz", g: 112 }, per: { cal: 110, p: 23, c: 0, f: 1.5, sodium: 60 }, per100g: { cal: 98.2, p: 20.5, c: 0, f: 1.3, sodium: 53.6 }, cook: { y: 0.75, word: "raw" } });
  assert.deepStrictEqual([f.cook.y, f.cook.word], [0.75, "raw"]);
  near(f.cook.per100gCooked.cal, 98.2 / 0.75, 0.01); near(f.cook.per100gCooked.p, 20.5 / 0.75, 0.01);
  assert.strictEqual(M.cook.servingLabel(f, "us"), "4 oz raw (3 oz cooked)");
  const up = M.foods.update(f.id, { per100g: { cal: 90, p: 20, c: 0, f: 1 } });
  near(up.cook.per100gCooked.cal, 120, 0.01, "edits re-derive the cooked profile");
  assert.strictEqual(M.foods.update(f.id, { cook: null }).cook, undefined, "turning it off removes cook");
  assert.strictEqual(M.foods.add({ name: "Bad", cook: { y: 0 } }).cook, undefined, "invalid y is dropped");
  const r = M.search("scanned chicken", { pid: "nick" })[0];
  assert.strictEqual(r.sub, "4 oz (112 g)", "cook off → plain serving label");
  M.foods.update(f.id, { cook: { y: 0.75, word: "raw" } });
  const r2 = M.search("cooked scanned chicken", { pid: "nick" })[0];
  assert.ok(r2 && r2.foodId === f.id && r2.sub === "4 oz raw (3 oz cooked)", JSON.stringify(r2 && r2.sub));
  M.foods.remove(f.id);
});

t("search: 'cooked chicken', 'chicken breast cooked', 'dry pasta' still find the merged foods; plain chicken first", () => {
  M.MS.days = {};   /* no recents: they would stand in for the generic rows */
  const top = q => M.search(q, { pid: "nick", limit: 10 }).map(r => r.foodId || r.id);
  const PLAIN = ["g_chicken_breast", "g_chicken_thigh", "g_kirkland_organic_chicken"];
  ["chicken breast cooked", "chicken breast raw", "cooked chicken breast"].forEach(q => assert.strictEqual(top(q)[0], "g_chicken_breast", q + ": " + top(q).join(",")));
  ["cooked chicken", "raw chicken", "chicken"].forEach(q => {
    assert.ok(PLAIN.includes(top(q)[0]), q + " → plain chicken first, not a dish: " + top(q).join(","));
    assert.ok(top(q).slice(0, 3).includes("g_chicken_breast"), q + " has chicken breast near the top");
  });
  assert.ok(top("dry pasta").includes("g_pasta") && top("uncooked rice").includes("g_white_rice") && top("rice cooked").includes("g_white_rice"));
  assert.strictEqual(top("chicken sausage")[0], "g_chicken_sausage", "a named dish still wins its own search");
  /* a logged food folds into its recent in the mixed list, but the Foods list still shows it */
  M.log.add(today, { slot: "Lunch", foodId: "g_chicken_breast", servings: 6, servingLabel: "1 oz raw", g: M.cook.OZ, per: { cal: 34 }, state: "raw" });
  assert.ok(!M.search("chicken breast", { pid: "nick" }).some(r => r.kind === "generic" && r.id === "g_chicken_breast"), "deduped behind the recent");
  const foodsOnly = M.search("chicken breast", { pid: "nick", recents: false, meals: false });
  assert.ok(foodsOnly.some(r => r.kind === "generic" && r.id === "g_chicken_breast"), "recents:false keeps the food");
  assert.ok(foodsOnly.every(r => r.kind !== "recent" && r.kind !== "meal"));
  M.MS.days = {};
  const gen = M.search("chicken breast", { pid: "nick" }).find(r => r.id === "g_chicken_breast");
  assert.strictEqual(gen.sub, "4 oz raw (2.9 oz cooked)"); assert.strictEqual(gen.state, "raw"); assert.ok(gen.cook);
});

t("batch meal: rawG from the items, per = whole batch, logged by cooked weight; later edits never touch logged days", () => {
  M.MS.days = {};
  const oz = M.cook.OZ, chk = M.foods.get("g_chicken_breast"), rice = M.foods.get("g_white_rice");
  const cu = M.cook.unitsFor(chk, "us").find(o => o.key === "oz-raw"), ru = M.cook.unitsFor(rice, "us").find(o => o.key === "oz-raw");
  const items = [
    { name: chk.name, foodId: chk.id, servings: 64, servingLabel: "1 oz raw", g: cu.g, per: cu.per, state: "raw" },
    { name: rice.name, foodId: rice.id, servings: 6, servingLabel: "1 oz dry", g: ru.g, per: ru.per, state: "raw" },
    { name: "Olive oil", servings: 1, servingLabel: "1 tbsp (14 g)", g: 14, per: { cal: 124, f: 14 } },
    { name: "Seasoning", servings: 1, servingLabel: "1 serving", per: { cal: 5 } }
  ];
  const m = M.meals.add({ name: "Chicken and rice prep", slot: "Lunch", servingsMade: 4, items, batch: { cookedG: 51 * oz } });
  assert.strictEqual(m.servingsMade, 1, "a batch is one pot");
  near(m.batch.rawG, 70 * oz + 14, 0.1, "raw grams: 64 oz + 6 oz + 14 g oil (no weight → not counted)");
  near(m.per.cal, M.foodMath.sum(m.items).cal, 0.01, "per = the whole batch");
  near(M.cook.batchCook(m).y, 51 * oz / m.batch.rawG, 0.0001);
  const p4 = M.cook.batchPer(m, 4 * oz); near(p4.cal, m.per.cal * 4 / 51, 0.2);
  assert.strictEqual(M.cook.batchSub(m, "us"), "Batch · 51 oz cooked");
  assert.strictEqual(M.cook.batchSub(m, "metric"), "Batch · 1446 g cooked");
  const sr = M.search("prep", { pid: "nick" }).find(r => r.kind === "meal");
  assert.ok(sr.batch && sr.sub === "Batch · 51 oz cooked" && sr.portion === "per 4 oz" && Math.abs(sr.per.cal - p4.cal) < 0.2);
  const [e] = M.log.addMeal(today, m.id, null, "Lunch", { grams: 12 * oz, unit: "oz" });
  assert.deepStrictEqual([e.servings, e.servingLabel, e.state, e.mealId], [12, "1 oz cooked", "cooked", m.id]);
  near(e.per.cal * 12, m.per.cal * 12 / 51, 0.05, "entry = batch totals × eaten ÷ cookedG");
  const label = M.cook.entryLabel(e, "us");
  assert.strictEqual(label, "12 oz cooked · of 51 oz batch", "BEC-13: a batch portion reads cooked only");
  const dayCal = M.log.totals(today).cal;
  /* change the batch: add an item and a new cooked weight */
  M.meals.update(m.id, { items: m.items.concat([{ name: "Butter", servings: 2, servingLabel: "1 tbsp (14 g)", g: 14, per: { cal: 100, f: 11 } }]), batch: { cookedG: 60 * oz } });
  assert.strictEqual(M.log.totals(today).cal, dayCal, "logged day unchanged");
  assert.strictEqual(M.cook.entryLabel(M.dayOf(today).entries[0], "us"), label, "logged label unchanged");
  /* grams in metric */
  const [e2] = M.log.addMeal(today, m.id, null, "Dinner", { grams: 340, unit: "g" });
  assert.strictEqual(e2.servingLabel, "1 g cooked"); assert.strictEqual(e2.servings, 340);
  /* without opt.grams a batch still logs the old way (fraction of the batch) */
  assert.strictEqual(M.log.addMeal(today, m.id, 0.5, "Snacks")[0].servingLabel, "1 serving");
  /* turning batch off */
  const off = M.meals.update(m.id, { batch: null, servingsMade: 4 });
  assert.strictEqual(off.batch, undefined); assert.strictEqual(off.servingsMade, 4);
  M.meals.remove(m.id);
});

t("storage: a failed save keeps data, retries, reports once per streak", () => {
  M.reset(); M.MS.days = {};
  const calls = [];
  M.onStorageError(s => calls.push(s.lastError));
  const orig = localStorage.setItem;
  let full = true;
  localStorage.setItem = function (k, v) { if (full && k === M.KEY) { const e = new Error("The quota has been exceeded."); e.name = "QuotaExceededError"; throw e; } return orig.call(this, k, v); };
  const before = localStorage.getItem(M.KEY);
  M.log.add(today, { slot: "Lunch", name: "Kept in memory", per: { cal: 10 } });
  assert.strictEqual(M.storage.ok, false);
  assert.ok(/QuotaExceededError/.test(M.storage.lastError), M.storage.lastError);
  assert.strictEqual(calls.length, 1, "listener told once");
  assert.strictEqual(localStorage.getItem(M.KEY), before, "old copy untouched");
  assert.ok(M.dayOf(today).entries.some(e => e.name === "Kept in memory"), "data kept in memory");
  M.log.add(today, { slot: "Lunch", name: "Second", per: { cal: 10 } });
  assert.strictEqual(calls.length, 1, "same streak: not told again");
  const late = []; M.onStorageError(() => late.push(1));
  assert.strictEqual(late.length, 1, "a listener that joins mid-streak hears about it");
  full = false;
  M.save();
  assert.strictEqual(M.storage.ok, true); assert.strictEqual(M.storage.lastError, null);
  assert.ok(M.storage.bytes > 100);
  assert.strictEqual(diskState().days["nick|" + today].entries.length, 2, "retry wrote everything");
  full = true; M.save();
  assert.strictEqual(calls.length, 2, "a new streak is reported again");
  full = false; M.save();
  localStorage.setItem = orig;
});

const QUOTA = () => { const e = new Error("The quota has been exceeded."); e.name = "QuotaExceededError"; return e; };
const TRIMMED = /^\{"bak":1,"day":"[^"]*","at":\d+,"trim":1/;

t("storage: daily .bak copy; damaged data is copied aside, then restored from the backup; reset removes it", () => {
  const BAK = M.KEY + ".bak";
  M.reset();
  assert.strictEqual(localStorage.getItem(BAK), null, "reset clears the backup");
  M.foods.add({ name: "Backed up food", per: { cal: 1 } });
  M.log.add(today, { slot: "Lunch", name: "Day one", per: { cal: 1 } });   /* 2nd save of the day copies the 1st */
  const bak = JSON.parse(localStorage.getItem(BAK));
  assert.strictEqual(bak.bak, 1); assert.strictEqual(bak.day, today); assert.strictEqual(bak.data.v, 1);
  assert.ok(/^\{"bak":1,"day":"\d{4}-\d{2}-\d{2}"/.test(localStorage.getItem(BAK)), "the live build can still read it");
  assert.strictEqual(M.storage.bakDay, today);
  const kept = localStorage.getItem(BAK);
  M.log.add(today, { slot: "Lunch", name: "Later today", per: { cal: 1 } });
  assert.strictEqual(localStorage.getItem(BAK), kept, "one copy a day");
  /* next day: the first save copies the last good save */
  const t0 = NOW; NOW += DAY;
  M.log.add(M.today(), { slot: "Lunch", name: "Day two", per: { cal: 1 } });
  const b2 = JSON.parse(localStorage.getItem(BAK));
  assert.strictEqual(b2.day, M.today());
  assert.strictEqual(b2.data.days["nick|" + today].entries.length, 2, "yesterday's last save");
  /* damage the main copy: a copy is kept aside before anything is saved, then the backup fills the gap */
  const junk = "{\"v\":1,\"days\":";
  localStorage.setItem(M.KEY, junk);
  M.load();
  assert.strictEqual(M.storage.restoredFrom, M.today());
  assert.strictEqual(localStorage.getItem(M.KEY + ".damaged"), junk, "damaged copy kept");
  assert.deepStrictEqual(M.storage.damaged, [M.KEY + ".damaged"]);
  assert.strictEqual(M.MS.days["nick|" + today].entries.length, 2, "days kept");
  assert.ok(Object.values(M.MS.foods).some(f => f.name === "Backed up food"), "foods back from the backup");
  M.load();
  assert.strictEqual(localStorage.getItem(M.KEY + ".damaged.2"), null, "the same damaged copy is not kept twice");
  localStorage.setItem(M.KEY, JSON.stringify({ v: 1, days: "junk" }));
  M.load(); assert.ok(M.storage.restoredFrom, "a bad shape counts as damaged");
  assert.strictEqual(localStorage.getItem(M.KEY + ".damaged"), junk, "an older damaged copy is never overwritten");
  assert.strictEqual(localStorage.getItem(M.KEY + ".damaged.2"), JSON.stringify({ v: 1, days: "junk" }));
  const goodBak = localStorage.getItem(BAK);
  NOW += DAY; M.save();
  assert.strictEqual(localStorage.getItem(BAK), goodBak, "a damaged main copy never replaces the good backup");
  assert.strictEqual(diskState().days["nick|" + today].entries.length, 2, "the restored copy is saved back");
  M.load(); assert.strictEqual(M.storage.restoredFrom, null, "healthy main copy");
  /* no room for the damaged copy yet: it is tried again before the next save */
  const orig = localStorage.setItem;
  localStorage.setItem(M.KEY, "{also broken");
  localStorage.setItem = function (k, v) { if (k.indexOf(".damaged") > 0) throw QUOTA(); return orig.call(this, k, v); };
  M.load();
  M.save();
  assert.strictEqual(M.storage.ok, false, "no room for the copy: the damaged main key is not written over");
  assert.strictEqual(localStorage.getItem(M.KEY), "{also broken");
  localStorage.setItem = orig;
  M.save();
  assert.strictEqual(M.storage.ok, true);
  assert.strictEqual(localStorage.getItem(M.KEY + ".damaged.3"), "{also broken", "kept before the save overwrote it");
  /* an old day, so a trimmed backup is smaller than a full one */
  M.log.add(M.addDays(today, -100), { slot: "Lunch", name: "Long ago", per: { cal: 1 } });
  NOW += DAY; M.save();
  assert.ok(JSON.parse(localStorage.getItem(BAK)).data.days["nick|" + M.addDays(today, -100)], "full copy has the old day");
  /* full phone: the backup is never dropped; it's swapped for a trimmed copy to make room */
  localStorage.setItem = function (k, v) { if (k === M.KEY && !TRIMMED.test(localStorage.getItem(BAK) || "")) throw QUOTA(); return orig.call(this, k, v); };
  M.log.add(M.today(), { slot: "Lunch", name: "Needs room", per: { cal: 1 } });
  assert.strictEqual(M.storage.ok, true, "saved after trimming the backup");
  const tb = JSON.parse(localStorage.getItem(BAK));
  assert.strictEqual(tb.trim, 1); assert.ok(!tb.data.days["nick|" + M.addDays(today, -100)], "old day left out"); assert.ok(tb.data.days["nick|" + today], "recent days kept");
  assert.ok(tb.data.foods && tb.data.profiles && tb.data.body, "profiles, foods, weigh-ins kept");
  /* still full: the save fails, the backup stays */
  localStorage.setItem = function (k, v) { if (k === M.KEY) throw QUOTA(); return orig.call(this, k, v); };
  M.log.add(M.today(), { slot: "Lunch", name: "No room", per: { cal: 1 } });
  assert.strictEqual(M.storage.ok, false);
  assert.ok(localStorage.getItem(BAK), "backup never deleted");
  localStorage.setItem = orig;
  M.save(); assert.strictEqual(M.storage.ok, true);
  assert.ok(diskState().days["nick|" + M.today()].entries.some(e => e.name === "No room"), "the retry saved it");
  /* big data: the daily copy is trimmed, never just dropped */
  const cap = M.storage.bakMax; M.storage.bakMax = 50;
  NOW += DAY; M.save();
  const big = JSON.parse(localStorage.getItem(BAK));
  assert.strictEqual(big.trim, 1, "over the cap: a trimmed copy");
  assert.ok(big.data.foods && big.data.profiles, "profiles, foods and meals kept");
  assert.strictEqual(M.storage.ok, true);
  M.storage.bakMax = cap;
  NOW = t0;
  M.reset();
  assert.deepStrictEqual(macroKeys(), [M.KEY, M.UI_KEY].sort(), "reset leaves only the fresh main key and the ui key");
});

t("storage: one key on disk; mode taps write only the ui key; one save per action; reload gives the same data", () => {
  M.reset();
  M.log.add(M.addDays(today, -40), { slot: "Lunch", name: "Old", per: { cal: 5 } });
  M.body.add({ date: today, w: 185 });
  const writes = [];
  const orig = localStorage.setItem;
  localStorage.setItem = function (k, v) { writes.push(k); return orig.call(this, k, v); };
  M.log.add(today, { slot: "Dinner", name: "Steak", servings: 2, servingLabel: "4 oz (113 g)", g: 113, per: { cal: 280, p: 30, c: 0, f: 17 } });
  assert.deepStrictEqual(writes, [M.KEY], "one write of the main key");
  writes.length = 0;
  M.setMode("macros"); M.setPerson("nick"); M.setMode("macros");
  assert.deepStrictEqual(writes, [M.UI_KEY, M.UI_KEY], "mode / person taps write only the small ui key, and only when it changes");
  writes.length = 0;
  const f = M.foods.add({ name: "Saved", per: { cal: 10 } });
  writes.length = 0;
  let saves = 0; const s0 = M.save; M.save = function () { saves++; return s0.apply(this, arguments); };
  M.log.add(today, { slot: "Lunch", foodId: f.id });
  M.save = s0;
  localStorage.setItem = orig;
  assert.strictEqual(saves, 1, "log.add of a saved food: one save");
  assert.deepStrictEqual(writes, [M.KEY]);
  assert.strictEqual(M.foods.get(f.id).uses, 1, "use counted");
  /* the same format as always: everything in one key */
  const main = JSON.parse(localStorage.getItem(M.KEY));
  assert.strictEqual(main.v, 1); assert.ok(main.days["nick|" + today] && main.body["nick|" + today] && main.foods[f.id]);
  assert.strictEqual(main.ui.mode, "macros", "the main key keeps ui too, for older builds");
  /* reload gives the same data; export / import keep their shape */
  const before = M.export();
  assert.deepStrictEqual(Object.keys(before).sort(), ["body", "days", "foods", "meals", "profiles", "ui", "updatedAt", "v"]);
  M.load();
  assert.deepStrictEqual(M.export(), before, "load gives back exactly what was saved");
  /* a ui key newer than the main copy wins; a bad one is ignored */
  localStorage.setItem(M.UI_KEY, JSON.stringify({ mode: "train", person: "kat", tab: "foods", date: "2026-09-01" }));
  M.load(); assert.strictEqual(M.mode(), "train"); assert.strictEqual(M.MS.ui.person, "kat"); assert.strictEqual(M.MS.ui.tab, "foods");
  localStorage.setItem(M.UI_KEY, "{bad"); M.load(); assert.strictEqual(M.mode(), "macros", "falls back to the main copy's ui");
  /* a profile only looked at (never set up) is not written */
  M.person("kat"); M.save();
  assert.ok(!JSON.parse(localStorage.getItem(M.KEY)).profiles.kat, "blank default profile not stored");
  M.setMode("train");
  M.reset();
});

t("fmtServing / parseServing: fractions, no repeated grams; grams in their own last bracket (BEC-17, C1)", () => {
  const F = M.fmtServing, P = M.parseServing;
  assert.strictEqual(F({ qty: 0.25, unit: "cup", g: 46 }), "¼ cup (46 g)");
  assert.strictEqual(F({ qty: 1.5, unit: "cup", g: 240 }), "1 ½ cup (240 g)");
  assert.strictEqual(F({ qty: 1 / 3, unit: "cup", g: 80 }), "⅓ cup (80 g)");
  assert.strictEqual(F({ qty: 0.3, unit: "cup" }), "0.3 cup", "not near a fraction: the number");
  assert.strictEqual(F({ qty: 100, unit: "g", g: 100 }), "100 g", "no '100 g (100 g)'");
  /* C1: grams stay in a bracket of their own; the diary row strips that last bracket (m-ui amountText),
     so "1 container (6 oz, 170 g)" showed as "1 container (6 oz, 170 g) (170 g)" there */
  assert.strictEqual(F({ qty: 1, unit: "container (6 oz)", g: 170 }), "1 container (6 oz) (170 g)");
  assert.strictEqual(F({ qty: 1, unit: "oz (23 almonds)", g: 28 }), "1 oz (23 almonds) (28 g)");
  assert.strictEqual(F({ qty: 2, unit: "slice", g: null }), "2 slice");
  assert.strictEqual(F({}), "1 serving");
  assert.deepStrictEqual(P("¼ cup (46 g)"), { qty: 0.25, unit: "cup", g: 46 });
  assert.deepStrictEqual(P("1 ½ cups"), { qty: 1.5, unit: "cups", g: null });
  assert.deepStrictEqual(P("1 container (6 oz, 170 g)"), { qty: 1, unit: "container (6 oz)", g: 170 });
  assert.deepStrictEqual(P("0.25 cup (46 g)"), { qty: 0.25, unit: "cup", g: 46 }, "old labels still read");
  assert.deepStrictEqual(P("1 oz (23 almonds) (28 g)"), { qty: 1, unit: "oz (23 almonds)", g: 28 });
  assert.deepStrictEqual(P("1/2 breast"), { qty: 0.5, unit: "breast", g: null });
  assert.deepStrictEqual(P("100 g"), { qty: 100, unit: "g", g: null });
  assert.deepStrictEqual(P(""), { qty: 1, unit: "serving", g: null });
  assert.strictEqual(M.servingText("1 container (6 oz, 170 g)"), "1 container (6 oz)");
  [{ qty: 0.25, unit: "cup", g: 46 }, { qty: 1.5, unit: "tbsp", g: 21 }, { qty: 1, unit: "container (6 oz)", g: 170 }, { qty: 2, unit: "slice", g: 90 }]
    .forEach(x => { const y = P(F(x)); assert.ok(Math.abs(y.qty - x.qty) < 1e-9 && y.unit === x.unit && y.g === x.g, F(x) + " round trip: " + JSON.stringify(y)); });
});

/* ---- F1: search words, ranking, staples, rebuilt recents (small fake foods: no m-data) ---- */
function withFakeDB(generic, alias, fn) {
  const keep = M.DB, days = M.MS.days, foods = M.MS.foods, meals = M.MS.meals;
  M.DB = { generic, alias: alias || {} };
  M.MS.days = {}; M.MS.foods = {}; M.MS.meals = {};
  try { fn(); } finally { M.DB = keep; M.MS.days = days; M.MS.foods = foods; M.MS.meals = meals; }
}
const G = (id, name, extra) => Object.assign({ id, name, brand: "", source: "generic", serving: { qty: 100, unit: "g", g: 100 }, per: { cal: 100, p: 10, c: 10, f: 1 } }, extra || {});

t("searchTokens: plurals, apostrophes, leading amounts", () => {
  const T = M.searchTokens;
  assert.deepStrictEqual(T("2 eggs"), ["egg"]);
  assert.deepStrictEqual(T("Eggs"), ["egg"]);
  assert.deepStrictEqual(T("Dave's"), ["dave"]); assert.deepStrictEqual(T("daves"), ["dave"]); assert.deepStrictEqual(T("Smucker’s"), ["smucker"]);
  assert.deepStrictEqual(T("bananas"), ["banana"]); assert.deepStrictEqual(T("potatoes"), ["potato"]);
  assert.deepStrictEqual(T("strawberries"), ["strawberry"]); assert.deepStrictEqual(T("Strawberry"), ["strawberry"]);
  assert.deepStrictEqual(T("apples"), ["apple"]); assert.deepStrictEqual(T("chicken breasts"), ["chicken", "breast"]);
  assert.deepStrictEqual(T("200 g chicken"), ["chicken"]); assert.deepStrictEqual(T("1/2 cup rice"), ["rice"]); assert.deepStrictEqual(T("1 ½ cups oats"), ["oat"]);
  assert.deepStrictEqual(T("Greek yogurt 2%"), ["greek", "yogurt"]); assert.deepStrictEqual(T("Ground beef 80/20"), ["ground", "beef"]);
  assert.deepStrictEqual(T("hummus"), ["hummus"]); assert.deepStrictEqual(T("asparagus"), ["asparagus"]); assert.deepStrictEqual(T("glasses"), ["glass"]);
  assert.deepStrictEqual(T("zucchinis kiwis delis"), ["zucchini", "kiwi", "deli"]); assert.deepStrictEqual(T("Swiss"), ["swiss"]);
  assert.deepStrictEqual(T(""), []); assert.deepStrictEqual(T(null), []);
});

t("search ranking: whole words and head nouns first; own foods above built-in; staples; named words", () => {
  withFakeDB([
    G("g_rice_cake", "Rice cake"), G("g_white_rice", "White rice", { cook: { y: 2.8, word: "dry" } }),
    G("g_egg_white", "Egg white"), G("g_egg", "Egg (large)"),
    G("g_jerky", "Beef jerky"), G("g_beef", "Ground beef 80/20", { cook: { y: 0.75, word: "raw" } }),
    G("g_strawberries", "Strawberries", { staple: true }), G("g_apple", "Apple"), G("g_potato", "Potato, baked"), G("g_banana", "Banana", { staple: true }),
    G("g_daves", "21 Whole Grains bread", { brand: "Dave's Killer Bread", staple: true }), G("g_bread", "White bread"),
    G("g_thigh", "Chicken thigh", { cook: { y: 0.7, word: "raw" } }), G("g_sausage", "Chicken sausage"),
    G("g_kb", "Chicken breast, organic", { brand: "Kirkland", staple: true, alwaysRaw: true, cook: { y: 0.75, word: "raw" } }),
    G("g_cottage4", "Cottage cheese, 4%"), G("g_daisy", "Cottage cheese 2%", { brand: "Daisy", staple: true }),
    G("g_smuckers", "Strawberry fruit spread, natural", { brand: "Smucker's", staple: true }), G("g_grape_jelly", "Grape jelly"),
    G("g_turkey_bacon", "Turkey bacon"), G("g_ground_turkey", "Ground turkey"), G("g_hillshire", "Turkey breast slices, oven roasted", { brand: "Hillshire Farm", staple: true })
  ], null, () => {
    const top = (q, n) => M.search(q, { pid: "nick", limit: n || 10 }).map(r => r.id);
    assert.strictEqual(top("rice")[0], "g_white_rice", "White rice before Rice cake");
    ["egg", "eggs", "2 eggs"].forEach(q => assert.strictEqual(top(q)[0], "g_egg", q + ": whole egg first"));
    assert.strictEqual(top("beef")[0], "g_beef", "ground beef before jerky");
    assert.strictEqual(top("strawberry")[0], "g_strawberries"); assert.strictEqual(top("apples")[0], "g_apple");
    assert.strictEqual(top("potatoes")[0], "g_potato"); assert.strictEqual(top("bananas")[0], "g_banana");
    assert.strictEqual(top("daves")[0], "g_daves"); assert.strictEqual(top("dave's bread")[0], "g_daves");
    assert.strictEqual(top("bread")[0], "g_daves", "a food they buy before a plain built-in food");
    /* the words Nick named */
    ["chicken", "chicken breast", "chicken breasts", "breast", "Chicken Breasts"].forEach(q => assert.strictEqual(top(q)[0], "g_kb", q + " → the Kirkland breast: " + top(q).join(",")));
    assert.strictEqual(top("chicken thigh")[0], "g_thigh", "a named cut still wins its own search");
    assert.strictEqual(top("cottage cheese")[0], "g_daisy");
    ["jam", "jelly", "strawberry jam", "strawberry jelly"].forEach(q => assert.strictEqual(top(q)[0], "g_smuckers", q));
    assert.ok(top("jelly").indexOf("g_grape_jelly") > 0, "other jelly still listed");
    ["turkey", "turkey slices", "sliced turkey", "deli turkey", "lunch meat", "4 slices turkey"].forEach(q => assert.strictEqual(top(q)[0], "g_hillshire", q + ": " + top(q).join(",")));
    assert.strictEqual(top("turkey bacon")[0], "g_turkey_bacon");
    /* their own saved foods and meals rank above built-in foods with similar names */
    const mine = M.foods.add({ name: "Turkey chili", per: { cal: 300 } });
    const eggBites = M.foods.add({ name: "Egg bites, homemade", per: { cal: 150 } });
    const meal = M.meals.add({ name: "Chicken and rice", slot: "Lunch", items: [{ name: "x", per: { cal: 1 } }] });
    assert.strictEqual(top("turkey")[0], mine.id, "own food above the named built-in food");
    assert.strictEqual(top("egg")[0], eggBites.id, "own food above an exact built-in match");
    assert.strictEqual(top("chicken")[0], meal.id, "own meal above built-in chicken");
    assert.strictEqual(top("chicken")[1], "g_kb");
    /* even against an exact built-in match that has every bonus */
    const pancakes = M.foods.add({ name: "Cottage cheese pancakes", per: { cal: 300 } });
    assert.strictEqual(top("cottage cheese")[0], pancakes.id); assert.strictEqual(top("cottage cheese")[1], "g_daisy");
    /* a letter run inside another word isn't "similar": built-in whole words still win */
    const lic = M.foods.add({ name: "Licorice", per: { cal: 100 } });
    assert.strictEqual(top("rice")[0], meal.id, "their meal 'Chicken and rice' first");
    /* CO-06: letters inside a word only count when no word matches whole or at its start */
    assert.ok(top("rice").indexOf("g_white_rice") >= 0 && top("rice").indexOf(lic.id) < 0, "White rice listed, Licorice left out");
    assert.strictEqual(top("licorice")[0], lic.id);
    /* a name that repeats its brand is matched without it; logging a meal counts its foods as used */
    const ps = M.foods.add({ name: "Dave's Killer Bread Powerseed", brand: "Dave's Killer Bread", per: { cal: 100 } });
    assert.strictEqual(top("powerseed")[0], ps.id);
    const withItem = M.meals.add({ name: "Toast plate", slot: "Breakfast", items: [{ name: ps.name, foodId: ps.id, servings: 2, per: { cal: 100 } }] });
    let saves = 0; const s0 = M.save; M.save = function () { saves++; return s0.apply(this, arguments); };
    M.log.addMeal(today, withItem.id, 1, "Breakfast");
    M.save = s0;
    assert.strictEqual(saves, 1, "one save"); assert.strictEqual(M.foods.get(ps.id).uses, 1, "meal item use counted");
  });
});

t("recents: rebuilt from the live food / meal; same amount and unit; aliases; alwaysRaw rows raw; slot order; tiny last", () => {
  withFakeDB([
    G("g_kb", "Chicken breast, organic", { brand: "Kirkland", staple: true, alwaysRaw: true, serving: { qty: 1, unit: "breast", g: 175 }, per: { cal: 210, p: 40, c: 0, f: 4.5 }, per100g: { cal: 120, p: 22.9, c: 0, f: 2.6, fiber: 0, sugar: 0, sodium: 50 }, cook: { y: 0.75, word: "raw" } }),
    G("g_oil", "Olive oil", { serving: { qty: 1, unit: "tbsp", g: 13.5 }, per: { cal: 119, p: 0, c: 0, f: 13.5 } })
  ], { g_old_breast_cooked: { id: "g_kb", state: "cooked" } }, () => {
    const f = M.foods.add({ name: "Protein bar", serving: { qty: 1, unit: "bar", g: 60 }, per: { cal: 200, p: 20, c: 22, f: 7 } });
    M.log.add(M.addDays(today, -2), { slot: "Snacks", foodId: f.id, servings: 2, servingLabel: "1 bar (60 g)", g: 60, per: { cal: 200, p: 20, c: 22, f: 7 }, at: NOW - 2 * DAY });
    /* the food's numbers change: the recent uses the new ones, same amount */
    M.foods.update(f.id, { per: { cal: 250, p: 25, c: 22, f: 9 } });
    let rc = M.recents("nick").find(r => r.foodId === f.id);
    assert.strictEqual(rc.per.cal, 250, "live numbers"); assert.strictEqual(rc.servings, 2); assert.strictEqual(rc.servingLabel, "1 bar (60 g)");
    M.foods.update(f.id, { name: "Protein bar, chocolate" });
    assert.strictEqual(M.recents("nick").find(r => r.foodId === f.id).name, "Protein bar, chocolate", "live name");
    /* the food is gone: the snapshot */
    M.foods.remove(f.id);
    rc = M.recents("nick").find(r => r.name === "Protein bar");
    assert.ok(rc, "kept as it was logged"); assert.strictEqual(rc.per.cal, 200);
    /* an old merged id (cooked) → the live food; alwaysRaw → raw grams (cooked ÷ y) */
    M.log.add(M.addDays(today, -1), { slot: "Dinner", foodId: "g_old_breast_cooked", name: "Chicken breast, cooked", servings: 6, servingLabel: "1 oz cooked", g: M.cook.OZ, per: { cal: 47 }, at: NOW - DAY });
    rc = M.recents("nick").find(r => r.foodId === "g_kb");
    assert.ok(rc, "resolved through the alias: " + JSON.stringify(M.recents("nick").map(r => r.foodId)));
    assert.strictEqual(rc.name, "Chicken breast, organic"); assert.strictEqual(rc.state, "raw");
    assert.strictEqual(rc.servingLabel, "1 oz raw"); assert.strictEqual(rc.servings, 8, "6 oz cooked ÷ 0.75 = 8 oz raw");
    near(rc.per.cal, 120 * M.cook.OZ / 100, 0.01, "raw numbers per oz");
    assert.deepStrictEqual(rc.cook, { y: 0.75, word: "raw" });
    /* grams typed raw stay as they were */
    M.log.add(today, { slot: "Lunch", foodId: "g_kb", servings: 175, servingLabel: "1 g raw", g: 1, state: "raw", per: { cal: 1.2 }, at: NOW });
    rc = M.recents("nick").find(r => r.foodId === "g_kb");
    assert.strictEqual(rc.servings, 175); assert.strictEqual(rc.state, "raw"); near(rc.per.cal, 1.2, 0.001);
    near(rc.per.p * rc.servings, 22.9 * 1.75, 0.01, "per-gram numbers aren't rounded away (175 g → 40 g protein)");
    /* a meal: live name and numbers */
    const m = M.meals.add({ name: "Wrap", slot: "Lunch", items: [{ name: "Tortilla", servings: 1, servingLabel: "1 tortilla", per: { cal: 150 } }] });
    M.log.addMeal(M.addDays(today, -3), m.id, 1, "Lunch");
    M.meals.update(m.id, { name: "Turkey wrap" });
    rc = M.recents("nick").find(r => r.mealId === m.id);
    assert.ok(rc && rc.name === "Turkey wrap", "live meal name");
    /* tiny add-ons last; slot order */
    M.log.add(today, { slot: "Dinner", foodId: "g_oil", servings: 1, servingLabel: "1 tsp (4.5 g)", g: 4.5, per: { cal: 40, f: 4.5 }, at: NOW + 1 });
    const all = M.recents("nick");
    assert.strictEqual(all[all.length - 1].foodId, "g_oil", "1 tsp oil goes last even though it's the newest");
    for (let i = 0; i < 3; i++) M.log.add(M.addDays(today, -4 - i), { slot: "Breakfast", name: "Greek yogurt", per: { cal: 100 }, at: NOW - (4 + i) * DAY });
    assert.strictEqual(M.recents("nick", 30, "Breakfast")[0].name, "Greek yogurt", "most logged in this slot first");
    assert.notStrictEqual(M.recents("nick")[0].name, "Greek yogurt", "without a slot: newest first");
    assert.strictEqual(M.recents("nick", 2).length, 2);
  });
});

/* ---- F1: body check / refuse / remove reset; check-ins; rate; import; batch labels; hardening ---- */
t("body: check ranges, add refuses out of range, remove resets weight + targets, lastBody only today/yesterday", () => {
  const C = M.body.check;
  assert.deepStrictEqual(C(185, "w", "us"), { ok: true, msg: "" });
  assert.strictEqual(C(49, "w").ok, false); assert.strictEqual(C(701, "w").ok, false); assert.strictEqual(C(50, "w").ok, true); assert.strictEqual(C(700, "w").ok, true);
  assert.strictEqual(C(22, "w", "metric").ok, false); assert.strictEqual(C(84, "w", "metric").ok, true); assert.strictEqual(C(321, "w", "metric").ok, false);
  assert.strictEqual(C(24, "rhr").ok, false); assert.strictEqual(C(25, "rhr").ok, true); assert.strictEqual(C(220, "rhr").ok, true); assert.strictEqual(C(221, "rhr").ok, false);
  assert.strictEqual(C("", "w").ok, false); assert.strictEqual(C("abc", "rhr").ok, false); assert.strictEqual(C(" 180 ", "w").ok, true);
  assert.strictEqual(C(1850, "w").msg, "Weight should be 50 to 700 lb."); assert.strictEqual(C(5, "w", "metric").msg, "Weight should be 23 to 320 kg.");
  assert.strictEqual(C(300, "rhr").msg, "Resting heart rate should be 25 to 220 beats a minute.");
  M.MS.body = {};
  const p = M.person("nick");
  Object.assign(p, { sex: "m", age: 40, heightIn: 71, weightLb: 185, activity: "moderate", pace: -1, split: "highprotein", targetsManual: false, setupAt: NOW - 30 * DAY, lastBody: NOW - 20 * DAY });
  M.calc.applyTargets(p);
  assert.strictEqual(M.body.add({ date: today, w: 1850 }), null, "typo refused");
  assert.strictEqual(M.body.add({ date: today, w: 185, rhr: 600 }), null, "bad heart rate refuses the whole record");
  assert.strictEqual(p.weightLb, 185); assert.strictEqual(Object.keys(M.MS.body).length, 0);
  /* an old weigh-in doesn't move the 2-week clock */
  M.body.add({ date: M.addDays(today, -10), w: 187 });
  assert.strictEqual(p.lastBody, NOW - 20 * DAY, "old date: clock unchanged");
  M.body.add({ date: yday, w: 186 });
  assert.strictEqual(p.lastBody, NOW, "yesterday counts");
  M.calc.applyTargets(p);
  const cal186 = p.targets.cal;
  M.body.add({ date: today, w: 150 });   /* a typo that is in range */
  assert.strictEqual(p.weightLb, 150);
  M.calc.applyTargets(p);
  assert.notStrictEqual(p.targets.cal, cal186);
  /* delete the typo: weight back to the latest weigh-in left, targets follow, one save */
  let saves = 0; const s0 = M.save; M.save = function () { saves++; return s0.apply(this, arguments); };
  assert.strictEqual(M.body.remove(today), true);
  M.save = s0;
  assert.strictEqual(saves, 1, "one save");
  assert.strictEqual(p.weightLb, 186, "latest remaining weigh-in");
  assert.strictEqual(p.targets.cal, cal186, "targets re-applied");
  /* manual targets stay as they are */
  p.targetsManual = true; p.targets.cal = 1234;
  M.body.add({ date: today, w: 150 }); M.body.remove(today);
  assert.strictEqual(p.targets.cal, 1234); assert.strictEqual(p.weightLb, 186);
  p.targetsManual = false; M.calc.applyTargets(p);
  M.MS.body = {};
});

t("check-ins: body14 runs from the last weigh-in only; numbersChanged finishes setup and the 60-day refresh", () => {
  const p = M.person("nick"), t0 = NOW;
  Object.assign(p, { setupAt: null, lastBody: 0, snooze: { refresh60: 0, body14: 0 }, sex: "m", age: 40, heightIn: 71, weightLb: 185 });
  assert.strictEqual(M.checkins.due("nick"), "setup");
  assert.strictEqual(M.checkins.numbersChanged("nick"), null, "complete profile edited in You → set up");
  assert.strictEqual(p.setupAt, NOW); assert.strictEqual(p.lastBody, NOW);
  /* incomplete profile: still setup */
  const kat = M.person("kat"); kat.setupAt = null;
  assert.strictEqual(M.checkins.numbersChanged("kat"), "setup"); assert.strictEqual(kat.setupAt, null);
  /* 61 days on: refresh60 due; editing numbers counts as done; body14 still due (weigh-in clock not reset) */
  NOW += 61 * DAY;
  assert.strictEqual(M.checkins.due("nick"), "refresh60");
  assert.strictEqual(M.checkins.numbersChanged("nick"), "body14", "refresh done; the weigh-in is still due");
  assert.strictEqual(p.setupAt, NOW);
  M.checkins.done("nick", "body14");
  assert.strictEqual(M.checkins.due("nick"), null);
  assert.strictEqual(M.checkins.numbersChanged("zed"), null, "only nick / kat");
  NOW = t0;
});

t("ratePerWeek: least squares over 56 days; works with a weigh-in every 2 weeks", () => {
  M.MS.body = {};
  M.body.add({ date: M.addDays(today, -28), w: 190 });
  M.body.add({ date: M.addDays(today, -14), w: 189 });
  assert.strictEqual(M.body.ratePerWeek("nick"), -0.5, "2 weigh-ins 14 days apart");
  M.body.add({ date: today, w: 188 });
  assert.strictEqual(M.body.ratePerWeek("nick"), -0.5);
  M.MS.body = {};
  M.body.add({ date: M.addDays(today, -10), w: 190 }); M.body.add({ date: today, w: 185 });
  assert.strictEqual(M.body.ratePerWeek("nick"), null, "less than 14 days apart");
  M.MS.body = {};
  M.body.add({ date: M.addDays(today, -200), w: 220 }); M.body.add({ date: M.addDays(today, -21), w: 190 }); M.body.add({ date: today, w: 190 });
  assert.strictEqual(M.body.ratePerWeek("nick"), 0, "only the last 56 days count");
  M.MS.body = {};
});

t("import: profiles merge one by one; a never-set-up profile loses; bad keys and long names", () => {
  const p = M.person("nick"), k = M.person("kat");
  Object.assign(p, { setupAt: NOW - 5 * DAY, updatedAt: NOW - 5 * DAY, weightLb: 185 });
  Object.assign(k, { setupAt: null, updatedAt: NOW, weightLb: null });
  const backup = M.export();
  backup.updatedAt = 1;   /* an old backup overall */
  backup.profiles.nick = Object.assign({}, backup.profiles.nick, { weightLb: 180, updatedAt: NOW - DAY });   /* newer edit to Nick */
  backup.profiles.kat = Object.assign({}, backup.profiles.kat, { setupAt: NOW - 90 * DAY, updatedAt: NOW - 90 * DAY, weightLb: 140 });
  const bad = JSON.parse('{"__proto__":{"polluted":1},"constructor":{"x":1}}');
  backup.foods = Object.assign(bad, { f_long: { id: "f_long", name: "x".repeat(300), brand: "b".repeat(200), per: { cal: 1 }, updatedAt: NOW } });
  backup.profiles.zed = { id: "zed", setupAt: 5 };
  const d = "nick|" + M.addDays(today, -300);
  backup.days[d] = { id: d, pid: "nick", date: M.addDays(today, -300), entries: [null, 5, { id: "e", slot: "Lunch", name: "y".repeat(500), per: { cal: 1 } }], water: 0, note: "", updatedAt: NOW };
  assert.strictEqual(M.import(backup), true);
  assert.strictEqual(M.person("nick").weightLb, 180, "Nick's newer profile wins even though the backup is older overall");
  assert.strictEqual(M.person("kat").weightLb, 140, "a set-up profile beats one never set up");
  assert.ok(!M.MS.profiles.zed, "only nick / kat");
  assert.strictEqual(({}).polluted, undefined); assert.ok(!Object.prototype.hasOwnProperty.call(M.MS.foods, "constructor"));
  assert.strictEqual(M.MS.foods.f_long.name.length, 120); assert.strictEqual(M.MS.foods.f_long.brand.length, 120);
  assert.deepStrictEqual(M.MS.days[d].entries.map(e => e.name.length), [120], "null / non-object entries dropped");
  assert.deepStrictEqual(M.log.slotEntries(M.addDays(today, -300), "Lunch").length, 1);
  M.MS.days[d].entries.push(null);
  assert.strictEqual(M.log.totals(M.addDays(today, -300)).cal, 1, "totals skip null entries");
  assert.strictEqual(M.foods.add({ name: "z".repeat(200) }).name.length, 120);
  delete M.MS.days[d]; delete M.MS.foods.f_long;
  /* the other way: a newer set-up profile on the phone is not replaced by an older backup's */
  const old = M.export(); old.profiles.nick = Object.assign({}, old.profiles.nick, { weightLb: 170, updatedAt: NOW - 30 * DAY, setupAt: NOW - 30 * DAY, lastBody: 0 });
  M.person("nick").updatedAt = NOW;
  M.import(old);
  assert.strictEqual(M.person("nick").weightLb, 180);
});

t("batch portions: cooked-only label with the batch size; normal cook foods keep raw (cooked)", () => {
  const m = M.meals.add({ name: "Chili batch", slot: "Dinner", items: [{ name: "Beef", per: { cal: 2000, p: 150 }, servings: 1 }], batch: { cookedG: 80 * M.cook.OZ, rawG: 100 * M.cook.OZ } });
  const [e] = M.log.addMeal(today, m.id, 1, "Dinner", { grams: 6 * M.cook.OZ, unit: "oz" });
  assert.strictEqual(e.batch, true);
  assert.strictEqual(M.cook.entryLabel(e, "us"), "6 oz cooked · of 80 oz batch");
  const [g] = M.log.addMeal(today, m.id, 1, "Dinner", { grams: 170, unit: "g" });
  assert.strictEqual(M.cook.entryLabel(g, "metric"), "170 g cooked · of 2,268 g batch");
  /* older batch entries (no batchG) read the meal's batch */
  const old = Object.assign({}, e); delete old.batch; delete old.batchG;
  assert.strictEqual(M.cook.entryLabel(old, "us"), "6 oz cooked · of 80 oz batch");
  /* a plain cook food keeps raw first */
  assert.strictEqual(M.cook.entryLabel({ foodId: "x", servingLabel: "1 oz raw", g: M.cook.OZ, servings: 6, state: "raw", cook: { y: 0.75, word: "raw" } }, "us"), "6 oz raw (4.5 oz cooked)");
  M.log.remove(today, e.id); M.log.remove(today, g.id); M.meals.remove(m.id);
});

/* ---- sync ---- */
/* ---- C1 (partner check): live-format data, the ui key both ways, liquids in ml, round once ---- */
/* Made by the LIVE build (d757f4b) itself: old cooked-chicken id, a batch portion, a
   quick add, weigh-ins, water; with the totals the live build showed for each day. */
const LIVE_FIXTURE = {"main":{"v":1,"updatedAt":1790517600000,"ui":{"mode":"macros","person":null,"date":null,"tab":"diary"},"profiles":{"nick":{"id":"nick","name":"Nick","sex":"m","age":40,"heightIn":71,"weightLb":188,"goalWeightLb":175,"activity":"moderate","pace":-1,"units":"us","split":"highprotein","custom":{"p":30,"c":40,"f":30},"targets":{"cal":2281,"p":190,"c":239,"f":63,"fiber":32,"water":96},"targetsManual":false,"setupAt":1790344800000,"snooze":{"refresh60":0,"body14":0},"lastBody":1790517600000,"aiModel":"claude-sonnet-5-5"}},"foods":{"f_bar":{"id":"f_bar","name":"Protein bar crunchy","brand":"Barebells","per":{"cal":200,"p":20,"c":18,"f":8,"fiber":3,"sugar":1,"sodium":150},"serving":{"qty":1,"unit":"bar","g":55},"source":"custom","barcode":"","per100g":null,"alts":[],"createdAt":1790344800000,"updatedAt":1790344800000,"uses":2,"lastUsed":1790517600000,"pid":"nick"}},"meals":{"m_prep":{"id":"m_prep","name":"Sunday chicken prep","slot":"Dinner","batch":{"cookedG":1450,"rawG":678},"items":[{"foodId":"g_chicken_breast","name":"Chicken breast, boneless skinless","servings":6,"servingLabel":"4 oz (113 g)","g":113,"per":{"cal":136,"p":25.4,"c":0,"f":2.9,"fiber":0,"sugar":0,"sodium":51},"state":"raw","cook":{"y":0.7258,"word":"raw"},"id":"muh12gw02a9r","brand":""}],"desc":"","servingsMade":1,"per":{"cal":816,"p":152.4,"c":0,"f":17.4,"fiber":0,"sugar":0,"sodium":306},"createdAt":1790344800000,"updatedAt":1790344800000,"uses":2,"lastUsed":1790517600000,"pid":"nick"}},"days":{"nick|2026-09-26":{"id":"nick|2026-09-26","pid":"nick","date":"2026-09-26","entries":[{"id":"e_ck0","slot":"Dinner","foodId":"g_chicken_breast","name":"Chicken breast, boneless skinless","servings":1,"servingLabel":"6 oz","g":170,"per":{"cal":280.5,"p":52.7,"c":0,"f":6.1,"fiber":0,"sugar":0,"sodium":125.8},"state":"cooked","cook":{"y":0.7258,"word":"raw"},"brand":"","at":1790431200000},{"id":"e_bar0","slot":"Snacks","foodId":"f_bar","servings":1.5,"name":"Protein bar crunchy","brand":"Barebells","servingLabel":"1 bar (55 g)","g":55,"per":{"cal":200,"p":20,"c":18,"f":8,"fiber":3,"sugar":1,"sodium":150},"at":1790431200000},{"slot":"Dinner","name":"Sunday chicken prep","brand":"","servings":5.9966,"servingLabel":"1 oz cooked","g":28.3495,"per":{"cal":15.9539,"p":2.9796,"c":0,"f":0.3402,"fiber":0,"sugar":0,"sodium":5.9827},"mealId":"m_prep","state":"cooked","cook":{"y":2.1386,"word":"raw"},"id":"muigibk066ub","at":1790431200000},{"id":"e_q0","slot":"Lunch","name":"Quick add","servings":1,"servingLabel":"1 serving","per":{"cal":350,"p":20,"c":30,"f":12,"fiber":0,"sugar":0,"sodium":0},"brand":"","g":null,"at":1790431200000}],"water":64,"note":"","updatedAt":1790431200000},"nick|2026-09-27":{"id":"nick|2026-09-27","pid":"nick","date":"2026-09-27","entries":[{"id":"e_ck1","slot":"Dinner","foodId":"g_chicken_breast","name":"Chicken breast, boneless skinless","servings":1,"servingLabel":"6 oz","g":170,"per":{"cal":280.5,"p":52.7,"c":0,"f":6.1,"fiber":0,"sugar":0,"sodium":125.8},"state":"cooked","cook":{"y":0.7258,"word":"raw"},"brand":"","at":1790517600000},{"id":"e_bar1","slot":"Snacks","foodId":"f_bar","servings":1.5,"name":"Protein bar crunchy","brand":"Barebells","servingLabel":"1 bar (55 g)","g":55,"per":{"cal":200,"p":20,"c":18,"f":8,"fiber":3,"sugar":1,"sodium":150},"at":1790517600000},{"slot":"Dinner","name":"Sunday chicken prep","brand":"","servings":5.9966,"servingLabel":"1 oz cooked","g":28.3495,"per":{"cal":15.9539,"p":2.9796,"c":0,"f":0.3402,"fiber":0,"sugar":0,"sodium":5.9827},"mealId":"m_prep","state":"cooked","cook":{"y":2.1386,"word":"raw"},"id":"mujvy680485i","at":1790517600000},{"id":"e_q1","slot":"Lunch","name":"Quick add","servings":1,"servingLabel":"1 serving","per":{"cal":350,"p":20,"c":30,"f":12,"fiber":0,"sugar":0,"sodium":0},"brand":"","g":null,"at":1790517600000}],"water":64,"note":"","updatedAt":1790517600000}},"body":{"nick|2026-09-26":{"id":"nick|2026-09-26","pid":"nick","date":"2026-09-26","w":189,"rhr":55,"at":1790431200000},"nick|2026-09-27":{"id":"nick|2026-09-27","pid":"nick","date":"2026-09-27","w":188,"rhr":55,"at":1790517600000}}},"totals":{"nick|2026-09-26":{"cal":1026.2,"p":120.6,"c":57,"f":32.1,"fiber":4.5,"sugar":1.5,"sodium":386.7},"nick|2026-09-27":{"cal":1026.2,"p":120.6,"c":57,"f":32.1,"fiber":4.5,"sugar":1.5,"sodium":386.7}}};
const canonJ = v => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x));

t("C1: a main copy written by the live build loads unchanged, totals match, a new save keeps every old day", () => {
  M.reset();
  const keepNow = NOW;
  localStorage.removeItem(M.UI_KEY);
  localStorage.setItem(M.KEY, JSON.stringify(LIVE_FIXTURE.main));
  M.load();
  ["profiles", "foods", "meals", "days", "body"].forEach(k => assert.strictEqual(canonJ(M.MS[k]), canonJ(LIVE_FIXTURE.main[k]), k + " unchanged in memory"));
  assert.strictEqual(M.mode(), "macros", "mode read from the main key when there is no ui key yet");
  assert.strictEqual(M.storage.restoredFrom, null);
  Object.keys(LIVE_FIXTURE.totals).forEach(id => {
    const d = LIVE_FIXTURE.main.days[id], a = LIVE_FIXTURE.totals[id], b = M.log.totals(d.date, d.pid);
    M.NUT.forEach(n => near(b[n], a[n], 0.01, id + " " + n));
  });
  /* a new save (one more entry today) leaves the old days, body, meals and profiles exactly as they were */
  M.log.add(today, { slot: "Snacks", name: "Apple", per: { cal: 95 } });
  const disk = diskState();
  Object.keys(LIVE_FIXTURE.main.days).forEach(id => assert.strictEqual(canonJ(disk.days[id]), canonJ(LIVE_FIXTURE.main.days[id]), id + " unchanged on disk"));
  ["profiles", "meals", "body", "foods"].forEach(k => assert.strictEqual(canonJ(disk[k]), canonJ(LIVE_FIXTURE.main[k]), k + " unchanged on disk"));
  assert.strictEqual(disk.ui.mode, "macros", "the main key still carries mode for an older build");
  /* the live build reads only v / ui / profiles / foods / meals / days / body: all still there */
  assert.deepStrictEqual(Object.keys(disk).sort(), ["body", "days", "foods", "meals", "profiles", "ui", "updatedAt", "v"]);
  NOW = keepNow;
  M.reset();
});

t("C1: an old '6 oz cooked' chicken entry comes back as a raw recent that is still 170 g cooked", () => {
  withFakeDB([G("g_kb2", "Chicken breast, organic", { alwaysRaw: true, staple: true, serving: { qty: 1, unit: "breast", g: 175 }, cook: { y: 0.7258, word: "raw" } })], { g_chicken_breast_cooked: { id: "g_kb2", state: "cooked" } }, () => {
    M.log.add(M.addDays(today, -1), { slot: "Dinner", foodId: "g_chicken_breast_cooked", servings: 1, servingLabel: "6 oz", g: 170, state: "cooked", cook: { y: 0.7258, word: "raw" }, per: { cal: 281 } });
    const rc = M.recents("nick").find(x => x.foodId === "g_kb2");
    assert.ok(rc && rc.state === "raw", "raw recent");
    near(rc.g * rc.servings * 0.7258, 170, 0.5, "same cooked weight as logged");
  });
});

t("C1: the ui key and the main key: the newer one wins (an older build after a rollback writes only the main key)", () => {
  M.reset();
  const keepNow = NOW;
  M.setMode("macros"); M.setPerson("nick");
  const ui = JSON.parse(localStorage.getItem(M.UI_KEY));
  assert.ok(ui.at > 0, "the ui key is stamped");
  assert.strictEqual(ui.mode, "macros");
  /* an older build saves later: its mode / person live only in the main key */
  NOW += 60e3;
  const main = diskState();
  main.ui = { mode: "train", person: "kat", date: null, tab: "diary" }; main.updatedAt = NOW;
  localStorage.setItem(M.KEY, JSON.stringify(main));
  M.load();
  assert.strictEqual(M.mode(), "train", "the older build's later choice wins");
  assert.strictEqual(M.MS.ui.person, "kat");
  /* a tap in this build after that wins again */
  NOW += 60e3;
  M.setMode("macros"); M.load();
  assert.strictEqual(M.mode(), "macros"); assert.strictEqual(M.MS.ui.person, "kat");
  /* a full save later (ui unchanged) shows the same thing after a reload */
  NOW += 60e3; M.save(); M.load();
  assert.strictEqual(M.mode(), "macros"); assert.strictEqual(M.MS.ui.person, "kat");
  /* a ui key without a stamp (older round-3 copy) still counts */
  localStorage.setItem(M.UI_KEY, JSON.stringify({ mode: "train", person: "nick", tab: "diary", date: null }));
  M.load(); assert.strictEqual(M.mode(), "train"); assert.strictEqual(M.MS.ui.person, "nick");
  /* a taps-only session never rewrites the main key */
  const before = localStorage.getItem(M.KEY);
  M.setMode("macros"); M.setPerson("kat"); M.setMode("train");
  assert.strictEqual(localStorage.getItem(M.KEY), before);
  NOW = keepNow;
  M.setPerson("nick");
  M.reset();
});

t("C1: liquids read in ml when the food is given; grams never as fractions; labels without the food are unchanged", () => {
  const F = M.fmtServing;
  const milk = { name: "Milk, 2%", serving: { qty: 1, unit: "cup", g: 244 } };
  const coffee = { name: "Coffee, black", serving: { qty: 12, unit: "oz", g: 355 } };
  const soda = { name: "Soda, cola", serving: { qty: 12, unit: "oz can", g: 368 } };
  const shot = { name: "Whiskey, 1 shot", serving: { qty: 1.5, unit: "oz shot", g: 42 } };
  const seltzer = { name: "Sparkling water, lime", serving: { qty: 1, unit: "can (355 ml)", g: 355 } };
  assert.strictEqual(F(milk.serving, milk), "1 cup (240 ml)");
  assert.strictEqual(F({ qty: 0.5, unit: "cup", g: 122 }, milk), "½ cup (120 ml)", "fractions stay for cups");
  assert.strictEqual(F(coffee.serving, coffee), "12 oz (355 ml)");
  assert.strictEqual(F(soda.serving, soda), "12 oz can (355 ml)");
  assert.strictEqual(F(shot.serving, shot), "1 ½ oz shot (44 ml)");
  assert.strictEqual(F(seltzer.serving, seltzer), "1 can (355 ml)", "the serving's own volume words, no grams");
  assert.strictEqual(F({ qty: 1, unit: "tbsp", g: 15 }, { name: "Heavy cream" }), "1 tbsp (15 g)", "not a drink: grams");
  /* not liquids, even with liquid-ish words */
  [{ name: "Tuna, canned in water" }, { name: "Milk chocolate" }, { name: "Electrolyte drink mix packet" }, { name: "Greek yogurt, plain 2%" }, { name: "Cottage cheese, 2%" },
    { name: "Greek yogurt, plain 5% (whole milk)" }, { name: "Baking soda" }, { name: "Oats, dry" }, { name: "Peanut butter, creamy" }, { name: "Watermelon" }, { name: "Water chestnuts" }]
    .forEach(f => assert.strictEqual(M.isLiquid(f), false, f.name));
  ["Oat milk", "Almond milk, unsweetened", "Chocolate milk", "Buttermilk", "Orange juice", "Beer, light (4.2%)", "Sports drink", "Seltzer / sparkling water"]
    .forEach(n => assert.strictEqual(M.isLiquid({ name: n }), true, n));
  assert.strictEqual(M.isLiquid({ name: "Kombucha", liquid: false }), false, "the food's own flag wins");
  assert.strictEqual(M.isLiquid({ name: "Bone broth" }), true);
  assert.strictEqual(F({ qty: 1, unit: "bottle", g: 591 }, { name: "Sports drink" }), "1 bottle (591 ml)", "no volume words: about 1 ml a gram");
  assert.strictEqual(F({ qty: 1, unit: "container (6 oz)", g: 170 }, { name: "Greek yogurt, plain 5% (whole milk)" }), "1 container (6 oz) (170 g)");
  /* without the food: the same labels as before (m-ui parses these) */
  assert.strictEqual(F(milk.serving), "1 cup (244 g)");
  assert.strictEqual(F(coffee.serving), "12 oz (355 g)");
  /* grams and ml: decimals, never "12 ½ g" */
  assert.strictEqual(F({ qty: 12.5, unit: "g" }), "12.5 g");
  assert.strictEqual(F({ qty: 2.5, unit: "ml", g: 2.5 }), "2.5 ml", "no '(2.5 g)' after ml either");
  assert.strictEqual(M.servingText("12.5 g"), "12.5 g");
  assert.strictEqual(F({ qty: 2.25, unit: "slices", g: 20 }), "2 ¼ slices (20 g)", "fractions stay for pieces");
  assert.strictEqual(F({ qty: 1.5, unit: "tbsp", g: 21 }), "1 ½ tbsp (21 g)");
  assert.deepStrictEqual(M.parseServing(F({ qty: 12.5, unit: "g" })), { qty: 12.5, unit: "g", g: null }, "reads back");
  assert.strictEqual(M.servingMl(coffee.serving, coffee), 355);
  assert.strictEqual(M.servingMl(milk.serving, { name: "Rice" }), null);
  /* search rows show ml for drinks */
  withFakeDB([G("g_milk_x", "Milk, 2%", { serving: { qty: 1, unit: "cup", g: 244 } }), G("g_rice_x", "White rice", { serving: { qty: 1, unit: "cup", g: 158 } })], {}, () => {
    assert.strictEqual(M.search("milk")[0].sub, "1 cup (240 ml)");
    assert.strictEqual(M.search("rice")[0].sub, "1 cup (158 g)");
  });
});

t("C1: round once: rows show whole numbers and add up to the total; left = round(target) − round(eaten)", () => {
  const items = [{ servings: 1.5, per: { cal: 100.4, p: 10.3 } }, { servings: 1, per: { cal: 0.4, p: 0.4 } }, { servings: 3, per: { cal: 33.3, p: 1.2 } }, null];
  const r = M.foodMath.rows(items);
  assert.deepStrictEqual(r.rows.map(x => x && x.cal), [151, 0, 100, null]);
  assert.strictEqual(r.total.cal, 251, "the total is the sum of the rows as shown");
  assert.strictEqual(r.total.p, 15 + 0 + 4);
  assert.strictEqual(M.foodMath.left(2281.6, 1500.5), 2282 - 1501);
  assert.strictEqual(M.foodMath.left(2000, 2100.4), -100);
  assert.deepStrictEqual(M.foodMath.rows(null), { rows: [], total: M.foodMath.blank() });
});

/* ---- F1 round 4: K2 search, PF-01 / CO-05 storage, FD-02 recents, K1, K4, K8, K3, WK-02, WK-08, cook labels ---- */
const SEARCH_FOODS = () => [
  G("g_egg", "Eggs, whole", { serving: { qty: 1, unit: "large egg", g: 50 } }), G("g_egg_white", "Egg white, large"), G("g_boiled", "Egg, hard-boiled"),
  G("g_kb", "Chicken breast, organic", { brand: "Kirkland", staple: true, alwaysRaw: true, cook: { y: 0.75, word: "raw" } }), G("g_thigh", "Chicken thigh, boneless skinless"),
  G("g_daisy", "Cottage cheese, 2%", { brand: "Daisy", staple: true }),
  G("g_jam", "Strawberry jam / jelly", { brand: "Smucker's Natural", staple: true, words: "fruit spread preserves smuckers" }),
  G("g_turkey", "Turkey slices, oven roasted", { brand: "Hillshire Farm", staple: true, words: "sliced deli lunch meat lunchmeat sandwich meat thin" }), G("g_turkey_bacon", "Turkey bacon"),
  G("g_banana", "Banana", { staple: true }), G("g_milk", "Milk, 2%"), G("g_rice", "White rice"), G("g_pb", "Peanut butter, creamy"), G("g_rasp", "Raspberries"),
  G("g_olive", "Olive oil"), G("g_apple", "Apple"), G("g_pine", "Pineapple"), G("g_hh", "Half and half"), G("g_onion", "Onion, white"),
  G("g_broc", "Broccoli, raw"), G("g_yog", "Greek yogurt, plain 2%"), G("g_corn", "Corn on the cob, grilled", { words: ["sweet corn", "bbq"] })
];
t("K2 search: amounts, counts, size and prep words anywhere; typos; built-in words; meal items (CO-01..04, DA-04, CO-06, FD-04)", () => {
  withFakeDB(SEARCH_FOODS(), null, () => {
    const top = (q, n) => M.search(q, { pid: "nick", limit: n || 10 }).map(r => r.id);
    const first = (qs, id) => qs.forEach(q => assert.strictEqual(top(q)[0], id, q + " → " + top(q).join(",")));
    /* CO-01: size / count / filler words */
    first(["2 large eggs", "large egg", "1 large egg", "eggs x2", "scrambled eggs", "fried egg", "two eggs"], "g_egg");
    first(["1 medium banana", "one banana", "a banana", "bananas"], "g_banana");
    first(["a cup of milk", "1 cup milk", "glass of milk"], "g_milk");
    first(["4 slices of turkey", "turkey deli", "turkey lunchmeat", "deli turkey", "lunchmeat", "lunch meat", "sandwich meat", "sliced turkey"], "g_turkey");
    /* CO-02: prep / package words may be missing from the food */
    first(["grilled chicken", "boneless skinless chicken breast", "kirkland organic boneless skinless chicken breasts", "kirkland signature chicken breast", "chicken tenders", "rotisserie chicken"], "g_kb");
    first(["daisy low fat cottage cheese", "cottage cheese", "low fat cottage cheese"], "g_daisy");
    /* CO-03: amounts after the food or glued */
    first(["6oz chicken", "chicken 6 oz", "175g chicken", "½lb chicken", "chicken 175 g", "200 grams chicken"], "g_kb");
    first(["rice 1 cup", "half cup rice", "1/2 cup rice", "¾ cup rice"], "g_rice");
    /* CO-04: one typo, joined words; the fixed word still gets their product first */
    first(["chiken", "chikcen", "chicken brest", "kirkand", "chike"], "g_kb");
    first(["cotage cheese"], "g_daisy"); first(["brocolli"], "g_broc"); first(["bannana"], "g_banana");
    first(["turky", "hilshire"], "g_turkey"); first(["smukers", "strawbery jam"], "g_jam"); first(["yoghurt"], "g_yog"); first(["peanutbutter"], "g_pb");
    /* DA-04: built-in words (a string or a list) */
    first(["preserves", "fruit spread"], "g_jam"); first(["sweet corn", "bbq corn"], "g_corn");
    /* CO-06: letters inside a word only when nothing matches whole or at a word start */
    first(["pb", "pb&j", "pbj"], "g_pb");
    assert.ok(top("pb").indexOf("g_rasp") < 0, "pb never finds Raspberries");
    assert.ok(top("oil").indexOf("g_boiled") < 0, "oil never finds hard-boiled");
    assert.ok(top("apple").indexOf("g_pine") < 0, "apple leaves Pineapple out: " + top("apple"));
    first(["half and half", "half & half"], "g_hh");
    /* nothing has every word: the last word must match ("red onion" → onion) */
    first(["red onion"], "g_onion");
    assert.deepStrictEqual(top("xqzt"), []);
    /* their own foods still come first, also for a typo; exact hits before typo hits */
    const own = M.foods.add({ name: "Chicken tikka, homemade", per: { cal: 300 } });
    assert.strictEqual(top("chiken")[0], own.id, "own food first for a typo too");
    assert.strictEqual(top("chicken")[0], own.id); assert.strictEqual(top("chicken")[1], "g_kb");
    /* FD-04: a saved meal answers to the names of the foods in it */
    const meal = M.meals.add({ name: "Nick's lunch bowl", slot: "Lunch", items: [{ name: "Chicken breast, organic", foodId: "g_kb", per: { cal: 200 } }, { name: "Blueberries", per: { cal: 40 } }] });
    assert.ok(top("blueberries").indexOf(meal.id) >= 0, "meal found by an item name");
    /* the query words, and the shared tokenizer is unchanged (describe needs size words) */
    assert.deepStrictEqual(M.searchQuery("2 large eggs").req, ["egg"]);
    assert.deepStrictEqual(M.searchQuery("grilled chicken 6oz"), { req: ["chicken"], opt: ["grilled"], all: ["grilled", "chicken"] });
    assert.deepStrictEqual(M.searchQuery("lunch meat").req, ["lunch", "meat"], "only optional words: they count");
    assert.deepStrictEqual(M.searchTokens("1 large egg"), ["large", "egg"]);
  });
});

t("K2 search speed: a keystroke stays fast with a year of diary, 300 foods and 80 meals", () => {
  withFakeDB(SEARCH_FOODS(), null, () => {
    for (let i = 0; i < 300; i++) M.MS.foods["f" + i] = { id: "f" + i, name: "Food number " + i + (i % 7 ? " crunchy" : " with chicken"), brand: "Brand " + (i % 13), per: { cal: 100 }, serving: { qty: 1, unit: "serving", g: 50 }, alts: [], uses: i % 5, lastUsed: i };
    for (let i = 0; i < 80; i++) M.MS.meals["m" + i] = { id: "m" + i, name: "Meal " + i, slot: M.SLOTS[i % 4], items: [{ name: "Item " + i, per: { cal: 10 } }], per: { cal: 10 }, uses: 1, lastUsed: i };
    for (let d = 0; d < 365; d++) { const date = M.addDays(today, -d); M.MS.days["nick|" + date] = { id: "nick|" + date, pid: "nick", date, entries: [0, 1, 2, 3, 4, 5].map(k => ({ id: "e" + d + "_" + k, slot: M.SLOTS[k % 4], name: "Food number " + ((d * 7 + k) % 300), foodId: "f" + ((d * 7 + k) % 300), servings: 1, servingLabel: "1 serving", per: { cal: 100 }, at: NOW - d * DAY })), water: 0, note: "", updatedAt: 1 }; }
    const words = ["chicken", "chiken", "2 large eggs", "cottage cheese", "xqzt"];
    words.forEach(w => { for (let i = 1; i <= w.length; i++) M.search(w.slice(0, i), { pid: "nick", slot: "Lunch" }); });   /* warm up */
    let worst = 0;
    /* best of 3 per keystroke (other work on the machine can pause any one run) */
    words.forEach(w => { for (let i = 1; i <= w.length; i++) { let best = Infinity; for (let k = 0; k < 3; k++) { const t0 = process.hrtime.bigint(); M.search(w.slice(0, i), { pid: "nick", slot: "Lunch" }); best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6); } worst = Math.max(worst, best); } });
    assert.ok(worst < 40, "slowest keystroke " + worst.toFixed(1) + " ms");
  });
});

t("PF-01 / CO-05: storage writes 1 byte a character; live-format data loads unchanged; older builds read it; a full phone saves today first", () => {
  M.reset();
  const odd = "Dave’s toast — ⅔ cup ½ “jam” 🍓 café";
  M.log.add(today, { slot: "Breakfast", name: odd, brand: "Smucker’s", servingLabel: "⅔ cup", per: { cal: 150 } });
  const main = localStorage.getItem(M.KEY);
  assert.ok(!/[\u0100-\uffff]/.test(main), "no character past U+00FF on disk");
  assert.ok(/caf\u00e9/.test(main), "Latin-1 letters stay as they are");
  assert.strictEqual(diskState().days["nick|" + today].entries[0].name, odd, "JSON.parse reads the escapes back");
  const inMem = canonJ(M.MS.days);
  M.load(); assert.strictEqual(canonJ(M.MS.days), inMem, "reload gives the same data");
  /* a main copy written by the live build (raw ’ — ⅔ characters) loads unchanged and is written back narrow */
  const live = JSON.parse(JSON.stringify(LIVE_FIXTURE.main));
  live.foods.f_bar.name = "Protein bar ’crunchy’ — ⅔"; live.days["nick|2026-09-26"].entries[0].name = "Chicken – grilled ½";
  localStorage.setItem(M.KEY, JSON.stringify(live));
  M.load();
  ["profiles", "foods", "meals", "days", "body"].forEach(k => assert.strictEqual(canonJ(M.MS[k]), canonJ(live[k]), k + " unchanged"));
  M.save();
  const disk = localStorage.getItem(M.KEY);
  assert.ok(!/[\u0100-\uffff]/.test(disk));
  ["profiles", "foods", "meals", "days", "body"].forEach(k => assert.strictEqual(canonJ(JSON.parse(disk)[k]), canonJ(live[k]), k + " unchanged on disk"));
  /* the previous builds (live b01144d and d757f4b) read what this build writes */
  let olds = [];
  try { const cp = require("child_process"); olds = ["b01144d", "d757f4b"].map(c => [c, cp.execSync("git show " + c + ":m-core.js", { cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "ignore"] }).toString()]); } catch (e) { olds = []; }
  if (!olds.length) console.log("       (git not available: older builds not checked)");
  olds.forEach(([c, src]) => {
    const ctx = { localStorage: { getItem: k => (k in localStorage.store ? localStorage.store[k] : null), setItem() {}, removeItem() {} }, S: { profile: "nick" }, PRESETS: global.PRESETS, Date, Math, JSON, Object, Array, String, Number, Set, Map, RegExp, isFinite, parseFloat, setTimeout, clearTimeout, console };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: "m-core." + c + ".js" });
    ["profiles", "foods", "meals", "days", "body"].forEach(k => assert.strictEqual(canonJ(ctx.M.MS[k]), canonJ(live[k]), c + " reads " + k));
    assert.strictEqual(ctx.M.MS.foods.f_bar.name, "Protein bar ’crunchy’ — ⅔");
  });
  /* CO-05: nearly full. The backup is cut, then dropped, so today's save lands; a write that
     fails even then puts the backup back as it was. */
  M.reset();
  for (let d = 90; d >= 1; d--) { const date = M.addDays(today, -d), day = M.day(date, "nick"); for (let k = 0; k < 6; k++) day.entries.push({ id: "q" + d + "_" + k, slot: M.SLOTS[k % 4], name: "Food " + k + " long name here", servings: 1, per: { cal: 100 }, at: NOW - d * DAY }); }
  NOW -= DAY; M.save(); NOW += DAY; M.storage.bakDay = null; M.save();
  const bak = localStorage.getItem(M.KEY + ".bak");
  assert.ok(bak && bak.length > 1000, "daily backup written");
  const orig = localStorage.setItem, room = localStorage.getItem(M.KEY).length + 6000;
  const size = () => Object.keys(localStorage.store).reduce((n, k) => n + k.length + localStorage.store[k].length, 0);
  localStorage.setItem = function (k, v) { const cur = k in this.store ? k.length + this.store[k].length : 0; if (size() - cur + k.length + String(v).length > room + 200) throw QUOTA(); return orig.call(this, k, v); };
  for (let i = 0; i < 10; i++) M.log.add(today, { slot: "Lunch", name: "Today " + i + " " + "x".repeat(40), per: { cal: 50 } });
  assert.strictEqual(M.storage.ok, true, "today saved: " + M.storage.lastError);
  assert.strictEqual(diskState().days["nick|" + today].entries.length, 10, "all 10 on disk");
  const nb = localStorage.getItem(M.KEY + ".bak");
  assert.ok(nb == null || nb.length < bak.length, "backup cut or dropped");
  /* nothing helps: the save fails and the backup stays */
  localStorage.setItem = orig;
  M.storage.bakDay = null; NOW += DAY; M.save(); const bak2 = localStorage.getItem(M.KEY + ".bak");
  localStorage.setItem = function (k, v) { if (k === M.KEY) throw QUOTA(); return orig.call(this, k, v); };
  M.log.add(M.today(), { slot: "Lunch", name: "No room", per: { cal: 1 } });
  assert.strictEqual(M.storage.ok, false);
  assert.strictEqual(localStorage.getItem(M.KEY + ".bak"), bak2, "backup put back exactly");
  localStorage.setItem = orig;
  M.save(); assert.strictEqual(M.storage.ok, true);
  NOW -= DAY;
  M.reset();
});

t("FD-02 / WK-07: a recent in a count or cup unit uses the food's numbers for that unit, not its grams", () => {
  M.reset();
  const bar = M.foods.add({ name: "Protein bar", serving: { qty: 1, unit: "bar", g: 60 }, per: { cal: 200, p: 20, c: 22, f: 8 }, per100g: { cal: 333.3, p: 33.3, c: 36.7, f: 13.3 } });
  M.log.add(today, { foodId: bar.id, servings: 2, servingLabel: "1 bar (60 g)", g: 60, per: bar.per, slot: "Snacks" });
  M.foods.update(bar.id, { serving: { qty: 1, unit: "bar", g: 44 } });   /* the grams fixed; 1 bar is still 200 */
  let r = M.recents("nick").find(x => x.foodId === bar.id);
  assert.strictEqual(r.per.cal, 200); assert.strictEqual(r.servingLabel, "1 bar (44 g)"); assert.strictEqual(r.g, 44);
  M.foods.update(bar.id, { per: { cal: 190, p: 20, c: 21, f: 7 } });
  r = M.recents("nick").find(x => x.foodId === bar.id);
  assert.strictEqual(r.per.cal * r.servings, 380, "the food's new numbers for 2 bars");
  /* an alt unit: the food's per scaled by that portion's grams */
  const egg = M.foods.add({ name: "Eggs", serving: { qty: 1, unit: "large egg", g: 50 }, per: { cal: 72, p: 6.3 }, per100g: { cal: 143, p: 12.6 }, alts: [{ label: "1 cup, scrambled", g: 220 }] });
  M.log.add(today, { foodId: egg.id, servings: 3, servingLabel: "1 large egg (50 g)", g: 50, per: { cal: 71.5 }, slot: "Breakfast" });
  r = M.recents("nick").find(x => x.foodId === egg.id);
  assert.strictEqual(r.per.cal, 72, "the food's own 1 large egg (216 for 3, like Log food), not per100g (214.5)");
  /* the same amount is its own portion ("½ breast" = 88 g, not half of 175); a cook food counts by raw grams */
  const br = M.foods.add({ name: "Chicken breast test", serving: { qty: 1, unit: "breast", g: 175 }, per: { cal: 172 }, per100g: { cal: 98.2 }, alts: [{ label: "½ breast", g: 88 }], cook: { y: 0.7258, word: "raw" } });
  M.log.add(today, { foodId: br.id, servings: 3, servingLabel: "½ breast (88 g)", g: 88, per: { cal: 86.42 }, state: "raw", slot: "Dinner" });
  r = M.recents("nick").find(x => x.foodId === br.id);
  assert.strictEqual(r.g, 88); assert.strictEqual(r.servingLabel, "½ breast (88 g)"); near(r.per.cal, 86.42, 0.01);
  /* grams stay grams */
  M.log.add(today, { foodId: egg.id, servings: 100, servingLabel: "1 g", g: 1, per: { cal: 1.43 }, slot: "Lunch", at: NOW + 1000 });
  r = M.recents("nick").find(x => x.foodId === egg.id);
  near(r.per.cal * r.servings, 143, 0.01);
  M.reset();
});

t("K1: M.log.shown adds the rows as the Diary shows them; the week summary uses the same numbers", () => {
  M.reset();
  M.log.add(today, { slot: "Lunch", name: "A", servings: 1, per: { cal: 100.45, p: 10.26, c: 0.04, f: 1.25, fiber: 0, sugar: 0, sodium: 5.5 } });
  M.log.add(today, { slot: "Dinner", name: "B", servings: 3, per: { cal: 33.35, p: 0.49 } });
  M.log.setWater(today, 24);
  const s = M.log.shown(today, "nick");
  /* rows as the Diary rounds them (to 0.1, then to 1): cal 100.45 → 100.5 → 101 and 100.05 → 100.1 → 100;
     protein 10.26 → 10 and 3 × 0.49 = 1.47 → 1.5 → 2 */
  assert.deepStrictEqual(s, { cal: 201, p: 12, c: 0, f: 1, fiber: 0, sugar: 0, sodium: 6, water: 24 });
  assert.deepStrictEqual(M.log.shown(M.addDays(today, -5), "nick"), { cal: 0, p: 0, c: 0, f: 0, fiber: 0, sugar: 0, sodium: 0, water: 0 });
  M.log.add(yday, { slot: "Lunch", name: "C", servings: 1, per: { cal: 10.5 } });
  const ws = M.weekSummary("nick", 0), row = ws.daily.find(d => d.date === yday);
  assert.strictEqual(row.cal, M.log.shown(yday, "nick").cal, "one number for the day everywhere");
  assert.strictEqual(ws.daily.find(d => d.date === today).cal, 201);
  M.reset();
});

t("K4: M.clean repairs or refuses records; M.import uses it; own-key lookups (CO-07, SE-01, SE-02)", () => {
  M.reset();
  const id = "nick|" + today;
  const good = { id, pid: "nick", date: today, entries: [{ id: "a", slot: "Lunch", name: "Rice", brand: "", servings: 1.5, servingLabel: "1 cup", g: 158, per: { cal: 205, p: 4.3, c: 44.5, f: 0.4, fiber: 0.6, sugar: 0.1, sodium: 2 }, at: NOW }], water: 8, note: "", updatedAt: NOW };
  assert.deepStrictEqual(M.clean("day", id, good), good, "clean data comes back the same");
  assert.strictEqual(M.clean("day", "bob|" + today, good), null);
  assert.strictEqual(M.clean("food", "__proto__", { name: "x" }), null);
  assert.strictEqual(M.clean("nope", "x", {}), null);
  const bad = M.clean("day", id, { entries: [null, 5, { name: "Neg", servings: -5, per: { cal: 100 }, slot: "Lunch" }, { name: "Big", per: { cal: 1e308, p: "12" }, slot: "Brunch", at: new Date(2026, 8, 28, 19, 0).getTime() }, { id: "a", name: "Dup", per: {}, slot: "Snacks", foodId: "__proto__", mealId: "constructor" }, { id: "a", name: "Dup2", per: { cal: -4 }, slot: "Snacks" }] });
  assert.strictEqual(bad.entries.length, 4);
  assert.ok(!("servings" in bad.entries[0]), "servings −5 dropped (reads as 1)");
  assert.strictEqual(bad.entries[1].per.cal, 0); assert.strictEqual(bad.entries[1].per.p, 12);
  assert.strictEqual(bad.entries[1].slot, "Dinner", "a bogus slot becomes the meal of its time");
  assert.ok(bad.entries.every(e => typeof e.id === "string" && e.id), "every entry has an id");
  assert.strictEqual(new Set(bad.entries.map(e => e.id)).size, 4, "ids are unique");
  assert.ok(!("foodId" in bad.entries[2]) && !("mealId" in bad.entries[2]), "bad foodId / mealId dropped");
  assert.strictEqual(bad.entries[3].per.cal, 0, "negative numbers → 0");
  assert.deepStrictEqual(M.clean("meal", "m1", { name: "Weird", items: null }).items, []);
  assert.deepStrictEqual(M.clean("meal", "m2", { name: "Weird2", items: [null, 5, "x", { name: "ok", per: { cal: 5 } }] }).items.map(i => i.name), ["ok"]);
  assert.strictEqual(M.clean("body", "nick|2026-09-26", { w: 5000, at: 1 }), null, "a 5000 lb weigh-in is refused");
  assert.strictEqual(M.clean("body", "nick|2026-09-26", { w: 5000, rhr: 55, at: 1 }).w, null);
  assert.strictEqual(M.clean("profile", "kat", { targets: { cal: "abc", p: 150 } }).targets.cal, undefined);
  /* import uses it */
  M.log.add(today, { slot: "Lunch", name: "Mine", per: { cal: 500, p: 40 } });
  assert.strictEqual(M.import({ v: 1, days: { [id]: { id, pid: "nick", date: today, updatedAt: NOW + 1e9, entries: [{ id: "n", name: "Neg", servings: -5, per: { cal: 100, p: 10 }, slot: "Brunch" }, { name: "NoId1", per: { cal: 1 }, slot: "Lunch" }, { name: "NoId2", per: { cal: 1 }, slot: "Lunch" }] } }, meals: { m1: { id: "m1", name: "Weird", items: null, per: { cal: 100 }, updatedAt: 1 } }, body: { "nick|2026-09-26": { w: 5000, at: 1 } } }), true);
  const d = M.dayOf(today, "nick");
  assert.strictEqual(M.log.totals(today, "nick").cal, 102);
  assert.ok(d.entries.every(e => M.isSlot(e.slot) && e.id), "every entry in a real meal with an id");
  const ids = d.entries.map(e => e.id); M.log.remove(today, ids[1]); assert.strictEqual(M.dayOf(today, "nick").entries.length, 2, "removing one removes one");
  assert.ok(Array.isArray(M.meals.get("m1").items));
  assert.strictEqual(M.body.list("nick").length, 0);
  /* own keys only */
  assert.strictEqual(M.foods.get("__proto__"), null); assert.strictEqual(M.foods.get("constructor"), null); assert.strictEqual(M.foods.get("toString"), null);
  assert.strictEqual(M.meals.get("__proto__"), null); assert.strictEqual(M.meals.get("hasOwnProperty"), null);
  assert.strictEqual(M.foods.update("__proto__", { name: "x" }), null); assert.strictEqual(M.meals.remove("constructor"), false);
  const e = M.log.add(today, { slot: "Lunch", name: "P", foodId: "__proto__", mealId: "constructor", per: { cal: 1 } });
  assert.ok(!("foodId" in e) && !("mealId" in e));
  const f = M.foods.add({ id: "__proto__", name: "Sneaky", per: { cal: 1 } });
  assert.notStrictEqual(f.id, "__proto__");
  assert.strictEqual(({}).name, undefined, "nothing reached Object.prototype");
  assert.ok(M.search("sneaky").length >= 1);
  M.reset();
});

t("K8 / queued: the chicken breast reads in grams in any units; cook labels use ¼ ½ ¾; unitsFor has the food's count servings", () => {
  withFakeDB([G("g_kb", "Chicken breast, organic", { brand: "Kirkland", staple: true, alwaysRaw: true, serving: { qty: 1, unit: "breast", g: 175 }, per: { cal: 210, p: 39 }, per100g: { cal: 120, p: 22.3 }, alts: [{ label: "½ breast", g: 87.5 }, { label: "4 oz", g: 113 }], cook: { y: 0.7258, word: "raw" } }),
    G("g_rice", "White rice", { serving: { qty: 0.25, unit: "cup", g: 46 }, cook: { y: 2.8, word: "dry" } })], null, () => {
    const p = M.person("nick"), keep = p.units;
    p.units = "us";
    const e1 = { foodId: "g_kb", servings: 1, servingLabel: "1 breast (175 g)", g: 175, state: "raw" };
    assert.strictEqual(M.cook.entryLabel(e1, "us"), "175 g raw (127 g cooked)");
    assert.strictEqual(M.cook.entryLabel({ foodId: "g_kb", servings: 6.2, servingLabel: "1 oz raw", g: 28.35, state: "raw" }, "us"), "176 g raw (128 g cooked)");
    assert.strictEqual(M.cook.entryLabel({ foodId: "g_kb", servings: 1, servingLabel: "150 g", g: 150, state: "raw" }), "150 g raw (109 g cooked)");
    p.units = keep;
    /* ASCII fractions are gone from cook labels */
    assert.strictEqual(M.cook.label(56.7, "raw", { y: 2.8, word: "dry" }, "us", { vol: { unit: "cup", g: 113.4 } }), "½ cup dry (5.6 oz cooked)");
    assert.strictEqual(M.cook.fmtVolume(0.75, "cup"), "¾ cup"); assert.strictEqual(M.cook.fmtVolume(1.5, "cup"), "1 ½ cups");
    /* the breast's own count serving as a raw unit */
    const opts = M.cook.unitsFor(M.foods.get("g_kb"), "us");
    const br = opts.find(o => o.key === "breast-raw");
    assert.ok(br, "breast unit: " + opts.map(o => o.key).join(","));
    assert.strictEqual(br.label, "breast (175 g raw)"); assert.strictEqual(br.g, 175); assert.strictEqual(br.step, 0.5);
    near(br.per.cal, 120 * 1.75, 0.01, "grams × the raw profile, like its oz and g units");
    assert.ok(opts.find(o => o.key === "oz-raw") && opts.find(o => o.key === "g-cooked"), "weights still there");
    assert.ok(!M.cook.unitsFor(M.foods.get("g_rice"), "us").some(o => o.key === "cup-raw" && /\(/.test(o.label)), "cups stay volume units");
    /* WK-07: the cup takes the food's own serving grams (¼ cup = 46 g, so 184 g a cup), not another portion's 185 g */
    const rc = M.cook.unitsFor(Object.assign({}, M.foods.get("g_rice"), { alts: [{ label: "1 cup", g: 185 }], per100g: { cal: 367 } }), "us").find(o => o.key === "cup-raw");
    assert.strictEqual(rc.g, 184); near(rc.per.cal * 0.25, 367 * 0.46, 0.01);
  });
});

t("K3: barcodes: My foods, then linked codes, then built-in barcodes; linkCode saves the link", () => {
  M.reset();
  withFakeDB([G("g_daisy", "Cottage cheese, 2%", { brand: "Daisy", barcodes: ["073420516208"] }), G("g_jam", "Strawberry jam", { brand: "Smucker's" })], null, () => {
    assert.strictEqual(M.foods.byCode("073420516208").id, "g_daisy");
    assert.strictEqual(M.foods.byCode("0073420516208").id, "g_daisy", "EAN-13 with a leading zero");
    assert.strictEqual(M.foods.byCode("051500141304"), null);
    assert.strictEqual(M.foods.linkCode("051500141304", "g_jam").id, "g_jam");
    assert.strictEqual(M.MS.codes["051500141304"], "g_jam");
    assert.strictEqual(M.foods.byCode("51500141304").id, "g_jam");
    const mine = M.foods.add({ name: "Kodiak cakes", per: { cal: 190 } });
    M.foods.linkCode("705599012345", mine.id);
    assert.strictEqual(M.MS.foods[mine.id].barcode, "705599012345");
    assert.strictEqual(M.foods.byCode("0705599012345").id, mine.id);
    M.foods.linkCode("705599099999", mine.id);   /* a second code for the same food */
    assert.strictEqual(M.foods.byCode("705599099999").id, mine.id); assert.strictEqual(M.MS.foods[mine.id].barcode, "705599012345");
    assert.strictEqual(M.foods.linkCode("12", "g_jam"), null); assert.strictEqual(M.foods.linkCode("051500141304", "__proto__"), null); assert.strictEqual(M.foods.linkCode("051500141304", "nope"), null);
    /* kept across a reload */
    M.load(); assert.strictEqual(M.MS.codes["051500141304"], "g_jam");
  });
  M.reset();
  assert.ok(!("codes" in M.MS), "no codes key until a code is linked");
});

t("WK-02: check-ins come due on the morning of the day (calendar days); weeks since the last weigh-in", () => {
  M.reset();
  const keep = NOW;
  const p = M.person("nick");
  Object.assign(p, { sex: "m", age: 40, heightIn: 71, weightLb: 185, setupAt: new Date(2026, 8, 20, 21, 30).getTime(), lastBody: new Date(2026, 8, 14, 21, 30).getTime(), snooze: { refresh60: 0, body14: 0 } });
  NOW = new Date(2026, 8, 28, 7, 0).getTime();   /* 14 days later, but 7 am: before the clock time of the last one */
  assert.strictEqual(M.checkins.due("nick"), "body14");
  assert.strictEqual(M.checkins.weeksSince("nick"), 2); assert.strictEqual(M.checkins.daysSince("nick"), 14);
  NOW = new Date(2026, 8, 27, 23, 0).getTime();
  assert.strictEqual(M.checkins.due("nick"), null, "13 days: not yet");
  NOW = new Date(2026, 9, 26, 8, 0).getTime();
  assert.strictEqual(M.checkins.weeksSince("nick"), 6, "6 weeks, not 'It's been 2 weeks'");
  /* snoozed 7 days at 9 pm: due again in the morning 7 days later */
  NOW = new Date(2026, 8, 28, 21, 0).getTime();
  M.checkins.snooze("nick", "body14", 7);
  NOW = new Date(2026, 9, 4, 22, 0).getTime(); assert.strictEqual(M.checkins.due("nick"), null);
  NOW = new Date(2026, 9, 5, 6, 0).getTime(); assert.strictEqual(M.checkins.due("nick"), "body14");
  /* the 60-day refresh too */
  Object.assign(p, { setupAt: new Date(2026, 6, 30, 22, 0).getTime(), lastBody: new Date(2026, 9, 5, 6, 0).getTime(), snooze: { refresh60: 0, body14: 0 } });
  NOW = new Date(2026, 8, 28, 6, 0).getTime();
  assert.strictEqual(M.checkins.due("nick"), "refresh60");
  NOW = keep;
  M.reset();
});

t("C1 r4: search never offers a look-alike food for a real word it doesn't have; real typos, count words and numbers still work", () => {
  const foods = [
    G("g_asp", "Asparagus", { staple: true }), G("g_pear", "Pear"), G("g_ricecake", "Rice cake, plain"), G("g_rice", "White rice"),
    G("g_bell", "Bell pepper", { staple: true, words: "red green yellow orange" }), G("g_daisy", "Cottage cheese, 2%", { brand: "Daisy", staple: true }),
    G("g_sour", "Sour cream"), G("g_wine", "Wine, red"), G("g_gb93", "Ground beef 93/7"), G("g_gb90", "Ground beef 90/10"),
    G("g_yog2", "Greek yogurt, plain 2%", { staple: true }), G("g_yog5", "Greek yogurt, plain 5% (whole milk)"),
    G("g_apple", "Apple, with skin"), G("g_maple", "Maple syrup, pure"), G("g_hash", "Hash browns, fried"), G("g_pb", "Peanut butter, creamy"),
    G("g_turkey", "Turkey slices, oven roasted", { brand: "Hillshire Farm", staple: true }), G("g_bread", "Bread, 21 Whole Grains", { brand: "Dave's Killer Bread", staple: true }),
    G("g_onion", "Onion, white", { staple: true }), G("g_milk", "Milk, 2%"), G("g_milk0", "Milk, skim"), G("g_tuna", "Tuna, canned in water, drained"),
    G("g_kb", "Chicken breast, organic", { brand: "Kirkland", staple: true, alwaysRaw: true, cook: { y: 0.75, word: "raw" } }), G("g_sausage", "Chicken sausage link, cooked"),
    G("g_cooking", "Cooking spray (1 second)"), G("g_beans", "Black beans, cooked"), G("g_seltzer", "Seltzer / sparkling water"), G("g_trail", "Trail mix"), G("g_tomato", "Tomato, Roma", { staple: true })
  ];
  withFakeDB(foods, null, () => {
    const top = q => M.search(q, { pid: "nick", limit: 10 }).map(r => r.id);
    /* a count word after the food is not a food ("spears" never becomes Pear) */
    assert.deepStrictEqual(top("6 asparagus spears").slice(0, 1), ["g_asp"]);
    assert.strictEqual(top("asparagus spears").indexOf("g_pear"), -1);
    assert.strictEqual(top("2 links chicken sausage")[0], "g_sausage");
    /* real foods the app doesn't have find nothing, so "+ Add … as a new food" is the answer */
    ["toast", "coke", "diet coke", "red bull", "soup", "wings", "beets", "bran", "brownie", "creamer", "cookie", "mint", "spam", "wrap", "pita", "lamb", "pad thai", "mahi mahi",
      "string cheese", "cream cheese", "garlic bread", "grapefruit", "snickers", "jello", "roast beef"].forEach(q => assert.deepStrictEqual(top(q), [], q + " → " + top(q)));
    /* one typo still finds the food */
    const first = (q, id) => assert.strictEqual(top(q)[0], id, q + " → " + top(q));
    [["chiken", "g_kb"], ["chike", "g_kb"], ["brest", "g_kb"], ["turky", "g_turkey"], ["hilshire", "g_turkey"], ["rcie", "g_rice"], ["mlik", "g_milk"], ["bred", "g_bread"],
      ["aple", "g_apple"], ["tuan", "g_tuna"], ["cotage cheese", "g_daisy"], ["asparagas", "g_asp"], ["onoin", "g_onion"]].forEach(([q, id]) => first(q, id));
    assert.strictEqual(top("aple").indexOf("g_maple"), -1, "a typo fix beats letters inside another word");
    /* describing words may be missing; a word that names another food may not */
    first("red onion", "g_onion"); first("chopped onion", "g_onion"); first("diced tomato", "g_tomato");
    /* numbers in the name count ("90/10", "5%") */
    first("ground beef 90/10", "g_gb90"); first("93/7 ground beef", "g_gb93"); first("5% greek yogurt", "g_yog5"); first("2% greek yogurt", "g_yog2"); first("greek yogurt", "g_yog2");
    first("1 cup 2% milk", "g_milk"); first("2 cups milk", "g_milk");
  });
});

t("C1 r4: a snooze lasts whole calendar days across a clock change (Nov 1 fall back, Mar 14 spring forward)", () => {
  const keepTZ = process.env.TZ, keep = NOW;
  process.env.TZ = "America/Denver";
  try {
    M.reset();
    const p = M.person("nick");
    Object.assign(p, { sex: "m", age: 40, heightIn: 71, weightLb: 185, setupAt: new Date(2026, 9, 1, 9, 0).getTime(), lastBody: new Date(2026, 9, 1, 9, 0).getTime(), snooze: { refresh60: 0, body14: 0 } });
    NOW = new Date(2026, 9, 29, 0, 30).getTime();   /* 12:30 am, 3 days before the clocks go back */
    M.checkins.snooze("nick", "body14", 7);
    NOW = new Date(2026, 10, 4, 12, 0).getTime(); assert.strictEqual(M.checkins.due("nick"), null, "still skipped on day 6");
    NOW = new Date(2026, 10, 4, 23, 59).getTime(); assert.strictEqual(M.checkins.due("nick"), null, "still skipped late on day 6");
    NOW = new Date(2026, 10, 5, 0, 5).getTime(); assert.strictEqual(M.checkins.due("nick"), "body14", "back on day 7");
    Object.assign(p, { setupAt: new Date(2027, 1, 1, 9, 0).getTime(), lastBody: new Date(2027, 1, 20, 9, 0).getTime(), snooze: { refresh60: 0, body14: 0 } });
    NOW = new Date(2027, 2, 10, 23, 30).getTime();  /* 11:30 pm, 4 days before the clocks go forward */
    M.checkins.snooze("nick", "body14", 7);
    NOW = new Date(2027, 2, 16, 23, 0).getTime(); assert.strictEqual(M.checkins.due("nick"), null);
    NOW = new Date(2027, 2, 17, 0, 5).getTime(); assert.strictEqual(M.checkins.due("nick"), "body14", "back on day 7, not day 8");
    /* the 14-day weigh-in clock over the fall back: calendar days */
    Object.assign(p, { setupAt: new Date(2026, 9, 1, 9, 0).getTime(), lastBody: new Date(2026, 9, 18, 23, 59).getTime(), snooze: { refresh60: 0, body14: 0 } });
    NOW = new Date(2026, 10, 1, 0, 1).getTime(); assert.strictEqual(M.checkins.due("nick"), "body14");
    assert.strictEqual(M.checkins.daysSince("nick"), 14);
    NOW = new Date(2026, 9, 31, 23, 59).getTime(); assert.strictEqual(M.checkins.due("nick"), null);
  } finally {
    if (keepTZ === undefined) delete process.env.TZ; else process.env.TZ = keepTZ;
    NOW = keep;
    M.reset();
  }
});

t("WK-06: a batch reads in whole grams up to 10 kg", () => {
  const e = { mealId: "mx", name: "Prep", state: "cooked", cook: { y: 1.2, word: "raw" }, batch: true, batchG: 1950, servingLabel: "1 g cooked", g: 1, servings: 170 };
  assert.strictEqual(M.cook.entryLabel(e, "metric"), "170 g cooked · of 1,950 g batch");
  assert.strictEqual(M.cook.entryLabel(Object.assign({}, e, { batchG: 12500 }), "metric"), "170 g cooked · of 12.5 kg batch");
});

t("CO-08: another tab's save is read back and redrawn (never written over); waits while a box has focus", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "m-core.js"), "utf8");
  const store = {}, on = {}, docOn = {};
  const ctx = { localStorage: { getItem: k => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    S: { profile: "nick" }, PRESETS: global.PRESETS, setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {}, console,
    addEventListener(n, fn) { on[n] = fn; }, document: { activeElement: null, addEventListener(n, fn) { docOn[n] = fn; } } };
  ctx.window = ctx;
  vm.createContext(ctx); vm.runInContext(src, ctx, { filename: "m-core.js" });
  const T = ctx.M; T.now = () => NOW;
  let redraws = 0; T.ui = { rerender() { redraws++; } };
  T.log.add(today, { slot: "Lunch", name: "Mine", per: { cal: 100 } });
  assert.ok(typeof on.storage === "function", "listens for other tabs");
  /* the other tab adds an entry and saves */
  const other = JSON.parse(store[T.KEY]);
  other.days["nick|" + today].entries.push({ id: "o1", slot: "Dinner", name: "From the other tab", servings: 1, servingLabel: "1 serving", per: { cal: 50 }, at: NOW });
  store[T.KEY] = JSON.stringify(other);
  on.storage({ key: T.KEY });
  assert.strictEqual(T.dayOf(today, "nick").entries.length, 2); assert.strictEqual(redraws, 1);
  T.log.add(today, { slot: "Snacks", name: "Mine again", per: { cal: 10 } });
  assert.strictEqual(JSON.parse(store[T.KEY]).days["nick|" + today].entries.length, 3, "the other tab's entry is kept");
  /* typing here: wait for the box to lose focus */
  const o2 = JSON.parse(store[T.KEY]); o2.days["nick|" + today].entries.push({ id: "o2", slot: "Dinner", name: "Later", per: { cal: 5 }, at: NOW }); store[T.KEY] = JSON.stringify(o2);
  ctx.document.activeElement = { tagName: "INPUT" };
  on.storage({ key: T.KEY });
  assert.strictEqual(T.dayOf(today, "nick").entries.length, 3, "not while typing");
  ctx.document.activeElement = null; docOn.focusout();
  assert.strictEqual(T.dayOf(today, "nick").entries.length, 4); assert.strictEqual(redraws, 2);
  on.storage({ key: "chalk.v1" }); assert.strictEqual(redraws, 2, "other keys are ignored");
  /* C1 r4: this tab's last save failed (phone full): its unsaved entry is never dropped for the other tab's copy */
  const realSet = ctx.localStorage.setItem;
  ctx.localStorage.setItem = () => { const e = new Error("The quota has been exceeded."); e.name = "QuotaExceededError"; e.code = 22; throw e; };
  T.log.add(today, { slot: "Snacks", name: "Only in memory", per: { cal: 20 } });
  assert.strictEqual(T.storage.ok, false);
  const o3 = JSON.parse(store[T.KEY]); o3.days["nick|" + today].entries.push({ id: "o3", slot: "Dinner", name: "Other tab", per: { cal: 5 }, at: NOW }); store[T.KEY] = JSON.stringify(o3);
  on.storage({ key: T.KEY });
  assert.ok(T.dayOf(today, "nick").entries.some(e => e.name === "Only in memory"), "the unsaved entry stays");
  ctx.localStorage.setItem = realSet;
  T.save();
  assert.ok(T.storage.ok && JSON.parse(store[T.KEY]).days["nick|" + today].entries.some(e => e.name === "Only in memory"), "and is saved on the next try");
});

t("FD-03: a batch portion's recent carries its batch: today's batch while the meal exists, its own after it's gone", () => {
  M.reset();
  const m = M.meals.add({ name: "Sunday prep", slot: "Dinner", items: [{ name: "Chicken", servings: 1, servingLabel: "1 g raw", g: 1, per: { cal: 1.2 }, state: "raw", cook: { y: 0.75, word: "raw" } }], batch: { cookedG: 1275 } });
  M.log.addMeal(today, m.id, 1, "Dinner", { grams: 8 * M.cook.OZ, unit: "oz" });
  let r = M.recents("nick").find(x => x.mealId === m.id);
  assert.strictEqual(r.batch, true); assert.strictEqual(r.batchG, 1275);
  M.meals.update(m.id, { batch: { cookedG: 1450 } });
  r = M.recents("nick").find(x => x.mealId === m.id);
  assert.strictEqual(r.batchG, 1450, "label and math use the batch as it is now");
  M.meals.remove(m.id);
  r = M.recents("nick").find(x => x.name === "Sunday prep");
  assert.strictEqual(r.batchG, 1275, "the logged batch once the meal is deleted");
  assert.strictEqual(M.cook.entryLabel(r, "us"), "8 oz cooked · of 45 oz batch");
  M.reset();
});

t("sync is a silent no-op without window.claude", () => {
  assert.strictEqual(typeof window.claude, "undefined");
  M.sync.push(); M.sync.pushNow(); M.sync.pushDay("x"); M.sync.pushBody("x");
  assert.strictEqual(M.sync.on, false);
});

t("sync.init merges the artifact db (mock) and pushes local-only docs", async () => {
  const docs = {}, cols = { mdays: {}, mbody: {} };
  const sets = [];
  docs["macros/state"] = { v: 1, updatedAt: NOW + 5000, ui: { person: "nick" }, profiles: { kat: { id: "kat", name: "Katerina", weightLb: 140 } }, foods: { cloudfood: { id: "cloudfood", name: "Cloud food", per: { cal: 3 }, updatedAt: 9 } }, meals: {} };
  cols.mdays["nick|2026-09-20"] = { id: "nick|2026-09-20", pid: "nick", date: "2026-09-20", entries: [{ id: "c1", slot: "Lunch", name: "cloud", servings: 1, per: { cal: 1 } }], water: 0, note: "", updatedAt: 50 };
  cols.mbody["nick|2026-09-20"] = { id: "nick|2026-09-20", pid: "nick", date: "2026-09-20", w: 188, rhr: null, at: 50 };
  const fakeDb = {
    doc(p) {
      return {
        get: async () => ({ exists: !!docs[p], data: () => docs[p] }),
        set: async v => { sets.push(p); docs[p] = v; },
        delete: async () => { delete docs[p]; }
      };
    },
    collection(c) { return { limit: () => ({ get: async () => ({ docs: Object.values(cols[c]).map(v => ({ id: v.id, data: () => v })) }) }) }; }
  };
  window.claude = { use: async () => fakeDb };
  M.log.add(today, { slot: "Lunch", name: "local", per: { cal: 2 } });
  M.body.add({ date: today, w: 184 });
  const ok = await M.sync.init();
  assert.strictEqual(ok, true); assert.strictEqual(M.sync.on, true);
  assert.ok(M.MS.foods.cloudfood, "cloud food merged");
  assert.strictEqual(M.MS.profiles.kat.weightLb, 140, "cloud profile merged (newer)");
  assert.ok(M.MS.days["nick|2026-09-20"], "cloud day merged");
  assert.ok(M.MS.body["nick|2026-09-20"], "cloud body merged");
  assert.ok(M.MS.days["nick|" + today], "local day kept");
  assert.ok(sets.includes("macros/state"));
  assert.ok(sets.includes("mdays/nick_" + today), "local-only day pushed");
  assert.ok(sets.includes("mbody/nick_" + today), "local-only body pushed");
  /* later mutations push (debounced) */
  sets.length = 0;
  M.log.add(today, { slot: "Dinner", name: "more", per: { cal: 2 } });
  assert.strictEqual(sets.length, 0, "debounced, nothing yet");
  await new Promise(r => setTimeout(r, 900));
  assert.ok(sets.includes("mdays/nick_" + today) && sets.includes("macros/state"));
  delete window.claude;
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log("  ok  " + name); }
    catch (e) { console.log("  FAIL " + name + "\n" + (e && e.stack || e)); process.exitCode = 1; break; }
  }
  console.log("\n" + passed + "/" + tests.length + " test groups passed");
})();
