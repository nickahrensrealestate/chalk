/* node tests/m-data.test.js — data sanity checks for m-data.js (no DOM) */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

/* ---- tiny browser shim ---- */
global.window = global;

vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "m-data.js"), "utf8"), { filename: "m-data.js" });
const M = global.M;

const NUT = ["cal", "p", "c", "f", "fiber", "sugar", "sodium"];
const SLOTS = ["Breakfast", "Lunch", "Dinner", "Snacks"];
const STORES = ["King Soopers", "Costco", "Either"];
const isNum = v => typeof v === "number" && isFinite(v);
const COUNT_UNITS = /^(spray|sprays|packet|packets|serving|servings|piece|pieces)$/i;

const tests = [];
function t(name, fn) { tests.push({ name, fn }); }

console.log("m-data.js");

t("namespace: M.DB.generic and M.DB.suggest are arrays", () => {
  assert.ok(M && M.DB, "M.DB missing");
  assert.ok(Array.isArray(M.DB.generic), "generic not an array");
  assert.ok(Array.isArray(M.DB.suggest), "suggest not an array");
});

t("generic: 150–260 plain basics with unique g_ ids", () => {
  const G = M.DB.generic;
  assert.ok(G.length >= 150 && G.length <= 260, G.length + " foods (keep the list small and plain)");
  const seen = new Set();
  G.forEach(f => {
    assert.ok(/^g_[a-z0-9_]+$/.test(f.id), "bad id " + f.id);
    assert.ok(!seen.has(f.id), "duplicate id " + f.id);
    seen.add(f.id);
  });
});

t("generic: every food has the full Food shape", () => {
  M.DB.generic.forEach(f => {
    assert.strictEqual(typeof f.name, "string", f.id + " name");
    assert.ok(f.name.trim().length > 1, f.id + " empty name");
    assert.strictEqual(typeof f.brand, "string", f.id + " brand");
    assert.strictEqual(f.source, "generic", f.id + " source");
    assert.strictEqual(f.barcode, "", f.id + " barcode");
    assert.ok(f.serving && isNum(f.serving.qty) && f.serving.qty > 0, f.id + " serving.qty");
    assert.strictEqual(typeof f.serving.unit, "string", f.id + " serving.unit");
    assert.ok(f.serving.unit.length > 0, f.id + " serving.unit empty");
    const g = f.serving.g;
    assert.ok((isNum(g) && g > 0) || (g === null && COUNT_UNITS.test(f.serving.unit)), f.id + " serving.g must be positive or a count-based unit");
    assert.ok(f.per && typeof f.per === "object", f.id + " per");
    NUT.forEach(k => assert.ok(isNum(f.per[k]) && f.per[k] >= 0, f.id + " per." + k + " = " + f.per[k]));
    if (f.per100g !== null) {
      NUT.forEach(k => assert.ok(isNum(f.per100g[k]) && f.per100g[k] >= 0, f.id + " per100g." + k));
    }
    assert.ok(Array.isArray(f.alts), f.id + " alts");
    assert.ok(f.alts.length >= 1, f.id + " needs at least one alt serving");
    f.alts.forEach(a => {
      assert.strictEqual(typeof a.label, "string", f.id + " alt label");
      assert.ok(isNum(a.g) && a.g > 0, f.id + " alt '" + a.label + "' needs grams");
    });
    assert.strictEqual(f.uses, 0, f.id + " uses");
    assert.strictEqual(f.lastUsed, 0, f.id + " lastUsed");
    assert.strictEqual(f.createdAt, 0, f.id + " createdAt");
    assert.strictEqual(f.pid, null, f.id + " pid");
  });
});

t("generic: per and per100g agree (within 12% or 8 kcal)", () => {
  M.DB.generic.forEach(f => {
    if (!f.per100g) return;
    assert.ok(isNum(f.serving.g) && f.serving.g > 0, f.id + " has per100g but no serving grams");
    const expect = f.per100g.cal * f.serving.g / 100;
    const tol = Math.max(8, 0.12 * f.per.cal);
    assert.ok(Math.abs(f.per.cal - expect) <= tol, f.id + " per.cal " + f.per.cal + " vs per100g×g " + expect.toFixed(1));
    ["p", "c", "f"].forEach(k => {
      const e = f.per100g[k] * f.serving.g / 100;
      assert.ok(Math.abs(f.per[k] - e) <= Math.max(1, 0.12 * f.per[k]), f.id + " per." + k + " " + f.per[k] + " vs " + e.toFixed(1));
    });
  });
});

/* US labels may leave fiber out of the calorie count, so a food passes when
   its calories sit between 4p + 4(c − fiber) + 9f and 4p + 4c + 9f (± tol). */
function macroRange(p) { return { hi: 4 * p.p + 4 * p.c + 9 * p.f, lo: 4 * p.p + 4 * Math.max(0, p.c - p.fiber) + 9 * p.f }; }
t("generic: calories match 4p + 4c + 9f (±20% + 10 kcal, fiber may be excluded), alcohol excluded", () => {
  M.DB.generic.forEach(f => {
    if (f.alcohol === true) return;
    const p = f.per, r = macroRange(p), tol = 0.2 * p.cal + 10;
    assert.ok(p.cal >= r.lo - tol && p.cal <= r.hi + tol, f.id + " cal " + p.cal + " but macros give " + r.lo.toFixed(0) + "–" + r.hi.toFixed(0));
  });
});

t("generic: alcohol items are flagged and plausible (kcal ≥ macro kcal)", () => {
  const alc = M.DB.generic.filter(f => f.alcohol === true);
  assert.ok(alc.length >= 5, "expected beer/wine/spirits flagged alcohol:true");
  alc.forEach(f => {
    const p = f.per;
    assert.ok(p.cal >= 4 * p.p + 4 * p.c + 9 * p.f - 5, f.id + " alcohol calories below macro calories");
  });
});

t("generic: their staples and plain basics are covered", () => {
  const ids = new Set(M.DB.generic.map(f => f.id));
  [ /* what Nick and Katerina actually buy */
    "g_kirkland_organic_chicken", "g_pork_tenderloin_raw", "g_pork_tenderloin_cooked", "g_dkb_21_grains", "g_dkb_thin", "g_dkb_good_seed",
    "g_zucchini_raw", "g_zucchini", "g_broccoli_raw", "g_broccoli_cooked", "g_carrots", "g_carrots_cooked", "g_roma_tomato", "g_onion", "g_sweet_onion",
    /* plain basics */
    "g_chicken_breast_raw", "g_chicken_breast_cooked", "g_chicken_thigh_raw", "g_ground_beef_93_cooked", "g_ground_turkey_93_raw", "g_salmon_cooked",
    "g_salmon_raw", "g_tuna_canned_water", "g_shrimp_cooked", "g_egg_large", "g_egg_white", "g_greek_yogurt_0", "g_cottage_cheese_2", "g_whey_protein",
    "g_white_rice_cooked", "g_brown_rice_cooked", "g_jasmine_rice_cooked", "g_potato_baked", "g_sweet_potato_baked", "g_white_bread", "g_pasta_cooked",
    "g_tortilla_flour", "g_olive_oil", "g_butter", "g_avocado", "g_almonds", "g_peanut_butter", "g_banana", "g_apple", "g_strawberries", "g_blueberries",
    "g_spinach_raw", "g_lettuce_romaine", "g_tomato", "g_bell_pepper", "g_mushrooms", "g_green_beans", "g_milk_2", "g_coffee_black", "g_water",
    "g_mustard", "g_soy_sauce", "g_salsa", "g_hummus", "g_honey"
  ].forEach(id => assert.ok(ids.has(id), "missing " + id));
});

t("generic: nothing they said they never eat (cereal, oats, cheese, shakes, bars, restaurants, other brands)", () => {
  const bad = /cereal|cheerios|granola|\boats\b|oatmeal|\bcheese\b(?!,? ?\d)|cheddar|mozzarella|parmesan|shake|\bbar\b|protein bar|restaurant|fast food|chipotle|food court|mcdonald|panda|starbucks|latte/i;
  M.DB.generic.forEach(f => {
    const n = f.name.replace(/^Cottage cheese/i, "Cottage");
    assert.ok(!bad.test(n), "should not be built in: " + f.name);
    assert.ok(!f.brand || f.brand === "Kirkland" || f.brand === "Dave's Killer Bread", "unexpected brand " + f.brand + " on " + f.name);
  });
  const casein = M.DB.generic.filter(f => /protein powder/i.test(f.name));
  assert.strictEqual(casein.length, 1, "one plain whey scoop only");
});

t("generic: no duplicate names (case-insensitive)", () => {
  const seen = new Map();
  M.DB.generic.forEach(f => {
    const k = f.name.toLowerCase();
    assert.ok(!seen.has(k), "duplicate name '" + f.name + "' (" + f.id + " and " + seen.get(k) + ")");
    seen.set(k, f.id);
  });
});

t("suggest: 20+ ideas, ≥5 per slot, valid store and shape", () => {
  const S = M.DB.suggest;
  assert.ok(S.length >= 20, "only " + S.length + " suggestions");
  const bySlot = {};
  const ids = new Set();
  S.forEach(s => {
    assert.ok(/^s_[a-z0-9_]+$/.test(s.id), "bad id " + s.id);
    assert.ok(!ids.has(s.id), "duplicate id " + s.id); ids.add(s.id);
    assert.ok(typeof s.name === "string" && s.name.length > 2, s.id + " name");
    assert.ok(typeof s.desc === "string" && s.desc.length > 20, s.id + " desc");
    assert.ok(SLOTS.indexOf(s.slot) >= 0, s.id + " slot " + s.slot);
    assert.ok(STORES.indexOf(s.store) >= 0, s.id + " store " + s.store);
    assert.ok(isNum(s.prepMin) && s.prepMin >= 0, s.id + " prepMin");
    assert.ok(Array.isArray(s.items) && s.items.length >= 1, s.id + " items");
    assert.ok(Array.isArray(s.tags) && s.tags.length >= 1, s.id + " tags");
    s.items.forEach(x => {
      assert.ok(typeof x.name === "string" && x.name.length > 0, s.id + " item name");
      assert.ok(typeof x.servingLabel === "string" && x.servingLabel.length > 0, s.id + " item servingLabel");
      assert.ok(x.g === null || (isNum(x.g) && x.g > 0), s.id + " item g");
      NUT.forEach(k => assert.ok(isNum(x.per[k]) && x.per[k] >= 0, s.id + " item " + x.name + " per." + k));
    });
    bySlot[s.slot] = (bySlot[s.slot] || 0) + 1;
  });
  SLOTS.forEach(sl => assert.ok((bySlot[sl] || 0) >= 5, sl + " has only " + (bySlot[sl] || 0)));
  /* built from what they actually buy */
  const staple = /Kirkland organic|Pork tenderloin|Dave's Killer Bread|Zucchini|Broccoli|Carrots|Roma|Onion/i;
  const usesStaple = S.filter(s => s.items.some(i => staple.test(i.name))).length;
  assert.ok(usesStaple >= Math.ceil(S.length * 0.7), "most ideas use their staples (" + usesStaple + "/" + S.length + ")");
});

t("suggest: per equals the sum of items (1 kcal / 0.5 g)", () => {
  M.DB.suggest.forEach(s => {
    const sum = {}; NUT.forEach(k => { sum[k] = 0; });
    s.items.forEach(x => NUT.forEach(k => { sum[k] += x.per[k]; }));
    assert.ok(Math.abs(sum.cal - s.per.cal) <= 1, s.id + " cal " + s.per.cal + " vs items " + sum.cal);
    ["p", "c", "f", "fiber", "sugar"].forEach(k => assert.ok(Math.abs(sum[k] - s.per[k]) <= 0.5, s.id + " " + k + " " + s.per[k] + " vs items " + sum[k]));
    assert.ok(Math.abs(sum.sodium - s.per.sodium) <= 1, s.id + " sodium");
  });
});

t("suggest: calories match macros (±15% + 10 kcal) and meals are high-protein", () => {
  M.DB.suggest.forEach(s => {
    const p = s.per, r = macroRange(p), tol = 0.15 * p.cal + 10;
    assert.ok(p.cal >= r.lo - tol && p.cal <= r.hi + tol, s.id + " cal " + p.cal + " vs macros " + r.lo.toFixed(0) + "–" + r.hi.toFixed(0));
    const minP = s.slot === "Snacks" ? 4 : 19;
    assert.ok(p.p >= minP, s.id + " protein only " + p.p);
  });
});

t("suggest: items reference generic foods with matching macros", () => {
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  M.DB.suggest.forEach(s => s.items.forEach(x => {
    const f = byId.get(x.foodId);
    assert.ok(f, s.id + " item '" + x.name + "' has no generic food");
    assert.strictEqual(x.name, f.name, s.id + " item name differs from food");
    if (x.g && f.per100g) {
      const e = f.per100g.cal * x.g / 100;
      assert.ok(Math.abs(e - x.per.cal) <= Math.max(3, 0.05 * e), s.id + " item " + x.name + " cal " + x.per.cal + " vs per100g×g " + e.toFixed(1));
    }
  }));
});

/* ---- run ---- */
let pass = 0, fail = 0;
tests.forEach(({ name, fn }) => {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e && e.message)); }
});
console.log("\n" + pass + " passed, " + fail + " failed · " + M.DB.generic.length + " generic foods · " + M.DB.suggest.length + " suggestions");
if (fail) process.exit(1);
