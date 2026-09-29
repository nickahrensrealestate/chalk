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
  M.setMode("macros");
  const raw = JSON.parse(localStorage.getItem(M.KEY));
  assert.strictEqual(raw.ui.mode, "macros");
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
  assert.strictEqual(M.defaultSlot(new Date(2026, 8, 28, 14, 30)), "Dinner");
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
  const raw = JSON.parse(localStorage.getItem(M.KEY));
  assert.strictEqual(raw.days["nick|" + today].entries.length, 2, "persisted");
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
  assert.strictEqual(res[0].kind, "recent"); assert.strictEqual(res[0].name, "Oatmeal");
  assert.strictEqual(res[1].kind, "recent"); assert.strictEqual(res[1].name, "eggs");
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
  assert.strictEqual(w.avgCal, 1500); assert.strictEqual(w.avgP, 100); assert.strictEqual(w.avgC, 150); assert.strictEqual(w.avgF, 50);
  assert.strictEqual(w.end, today); assert.strictEqual(w.daily.length, 7);
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

/* ---- raw ↔ cooked (needs the real food list) ---- */
const loadData = () => vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "m-data.js"), "utf8"), { filename: "m-data.js" });
const CHK = { y: 0.7258, word: "raw" }, RICE = { y: 2.8077, word: "dry" };

t("cook.label: raw first, cooked in parentheses (US, metric, dry, cups, no y)", () => {
  loadData();
  assert.strictEqual(M.cook.label(6 * M.cook.OZ, "raw", CHK, "us"), "6 oz raw (4.4 oz cooked)");
  assert.strictEqual(M.cook.label(170, "raw", CHK, "metric"), "170 g raw (123 g cooked)");
  assert.strictEqual(M.cook.label(2 * M.cook.OZ, "raw", RICE, "us"), "2 oz dry (5.6 oz cooked)");
  assert.strictEqual(M.cook.label(4.4 * M.cook.OZ, "cooked", CHK, "oz"), "6.1 oz raw (4.4 oz cooked)", "cooked weight converts back to raw");
  assert.strictEqual(M.cook.label(158, "cooked", RICE, "us", { vol: { unit: "cup", g: 158 } }), "2 oz dry (1 cup cooked)");
  assert.strictEqual(M.cook.label(46, "raw", RICE, "us", { vol: { unit: "cup", g: 184 } }), "1/4 cup dry (4.6 oz cooked)");
  assert.strictEqual(M.cook.label(237, "cooked", RICE, "metric", { vol: { unit: "cup", g: 158 } }), "84 g dry (1 1/2 cups cooked)");
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
  assert.strictEqual(M.cook.servingLabel(M.foods.get("g_white_rice"), "us"), "1/4 cup dry (4.6 oz cooked)");
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
  assert.ok(/^16\.\d oz raw \(12 oz cooked\)$/.test(label), label);
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
  assert.strictEqual(JSON.parse(localStorage.getItem(M.KEY)).days["nick|" + today].entries.length, 2, "retry wrote everything");
  full = true; M.save();
  assert.strictEqual(calls.length, 2, "a new streak is reported again");
  full = false; M.save();
  localStorage.setItem = orig;
});

t("storage: daily .bak copy; load falls back to it when the main copy is damaged; reset removes it", () => {
  const BAK = M.KEY + ".bak";
  M.reset();
  assert.strictEqual(localStorage.getItem(BAK), null, "reset clears the backup");
  M.log.add(today, { slot: "Lunch", name: "Day one", per: { cal: 1 } });   /* 2nd save of the day copies the 1st */
  const bak = JSON.parse(localStorage.getItem(BAK));
  assert.strictEqual(bak.day, today); assert.strictEqual(bak.data.v, 1);
  assert.strictEqual(M.storage.bakDay, today);
  const kept = localStorage.getItem(BAK);
  M.log.add(today, { slot: "Lunch", name: "Later today", per: { cal: 1 } });
  assert.strictEqual(localStorage.getItem(BAK), kept, "one copy a day");
  /* next day: the first save copies the last good main */
  const t0 = NOW; NOW += DAY;
  M.log.add(M.today(), { slot: "Lunch", name: "Day two", per: { cal: 1 } });
  const b2 = JSON.parse(localStorage.getItem(BAK));
  assert.strictEqual(b2.day, M.today());
  assert.strictEqual(b2.data.days["nick|" + today].entries.length, 2, "yesterday's last save");
  /* damage the main copy */
  localStorage.setItem(M.KEY, "{\"v\":1,\"days\":");
  M.load();
  assert.strictEqual(M.storage.restoredFrom, M.today());
  assert.strictEqual(M.MS.days["nick|" + today].entries.length, 2, "restored from the backup");
  localStorage.setItem(M.KEY, JSON.stringify({ v: 1, days: "junk" }));
  M.load(); assert.ok(M.storage.restoredFrom, "a bad shape counts as damaged");
  M.save();
  assert.strictEqual(JSON.parse(localStorage.getItem(M.KEY)).days["nick|" + today].entries.length, 2, "the restored copy is saved back");
  M.load(); assert.strictEqual(M.storage.restoredFrom, null, "healthy main copy");
  /* full phone: the backup is dropped to make room for the main copy */
  const orig = localStorage.setItem; let room = false;
  localStorage.setItem = function (k, v) { if (k === M.KEY && !room && localStorage.getItem(BAK) != null) { const e = new Error("full"); e.name = "QuotaExceededError"; throw e; } return orig.call(this, k, v); };
  M.save();
  assert.strictEqual(M.storage.ok, true, "saved after dropping the backup");
  assert.strictEqual(localStorage.getItem(BAK), null);
  localStorage.setItem = orig;
  /* a big data set gets no copy (like Chalk's own chalk.bak), so it can't crowd out the training log */
  M.save(); NOW += DAY; M.save();
  assert.ok(localStorage.getItem(BAK), "small data: copied");
  const cap = M.storage.bakMax; M.storage.bakMax = 50;
  NOW += DAY; M.save();
  assert.strictEqual(localStorage.getItem(BAK), null, "over the cap: no copy, old copy dropped");
  assert.strictEqual(M.storage.ok, true);
  M.storage.bakMax = cap; NOW -= DAY;
  NOW = t0;
  M.reset();
});

/* ---- sync ---- */
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
