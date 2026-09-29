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

t("generic: at least 220 foods with unique g_ ids", () => {
  const G = M.DB.generic;
  assert.ok(G.length >= 220, "only " + G.length + " foods");
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

t("generic: required categories are covered", () => {
  const ids = new Set(M.DB.generic.map(f => f.id));
  ["g_chicken_breast_cooked", "g_chicken_thigh_raw", "g_ground_beef_80_raw", "g_ground_beef_93_cooked", "g_sirloin_cooked", "g_ribeye_cooked",
    "g_pork_chop_cooked", "g_pork_tenderloin_cooked", "g_bacon_cooked", "g_turkey_breast_cooked", "g_ground_turkey_93_raw", "g_salmon_cooked",
    "g_tilapia_cooked", "g_cod_cooked", "g_tuna_canned_water", "g_shrimp_cooked", "g_egg_large", "g_egg_white", "g_fage_0", "g_greek_yogurt_2",
    "g_greek_yogurt_5", "g_cottage_cheese_2", "g_cottage_cheese_4", "g_whey_protein", "g_casein_protein", "g_tofu_firm", "g_tempeh", "g_edamame",
    "g_lentils_cooked", "g_black_beans_cooked", "g_chickpeas_canned", "g_deli_turkey", "g_deli_ham", "g_rotisserie_chicken_breast",
    "g_kirkland_protein_bar", "g_fairlife_2", "g_core_power_26", "g_core_power_42", "g_premier_protein", "g_chobani_plain_nonfat",
    "g_oikos_triple_zero", "g_kodiak_mix", "g_dkb_21_grains", "g_kirkland_peanut_butter", "g_kirkland_almonds", "g_kirkland_eggs",
    "g_kirkland_chicken_breast", "g_kirkland_salmon_raw", "g_costco_muffin", "g_kroger_greek_yogurt",
    "g_white_rice_cooked", "g_brown_rice_cooked", "g_jasmine_rice_cooked", "g_quinoa_cooked", "g_oats_dry", "g_oatmeal_cooked", "g_potato_baked",
    "g_sweet_potato_baked", "g_white_bread", "g_bagel_plain", "g_tortilla_flour", "g_tortilla_corn", "g_pasta_cooked", "g_couscous_cooked",
    "g_rice_cake", "g_cheerios", "g_granola",
    "g_olive_oil", "g_avocado_oil", "g_butter", "g_avocado", "g_almonds", "g_walnuts", "g_cashews", "g_peanuts", "g_peanut_butter",
    "g_almond_butter", "g_cheddar", "g_mozzarella", "g_feta", "g_parmesan", "g_string_cheese", "g_cream_cheese", "g_mayo", "g_ranch", "g_sour_cream",
    "g_banana", "g_apple", "g_orange", "g_strawberries", "g_blueberries", "g_grapes", "g_watermelon", "g_pineapple", "g_mango", "g_dates",
    "g_broccoli_cooked", "g_spinach_raw", "g_kale_raw", "g_lettuce_romaine", "g_tomato", "g_cucumber", "g_bell_pepper", "g_carrots", "g_onion",
    "g_mushrooms", "g_green_beans", "g_asparagus", "g_corn", "g_peas", "g_zucchini", "g_cauliflower",
    "g_milk_whole", "g_milk_2", "g_milk_skim", "g_almond_milk", "g_oat_milk", "g_coffee_black", "g_latte", "g_orange_juice", "g_beer", "g_wine_red",
    "g_whiskey_shot", "g_seltzer",
    "g_ketchup", "g_mustard", "g_hot_sauce", "g_soy_sauce", "g_bbq_sauce", "g_honey", "g_maple_syrup", "g_jam", "g_salsa", "g_guacamole", "g_hummus",
    "g_burrito_chicken", "g_cheeseburger", "g_pizza_slice", "g_chicken_sandwich", "g_chipotle_chicken", "g_chipotle_white_rice", "g_california_roll",
    "g_ramen_restaurant", "g_pho_beef", "g_taco_street", "g_caesar_salad", "g_protein_pancakes",
    "g_quest_chips", "g_tortilla_chips", "g_popcorn_air", "g_pretzels", "g_dark_chocolate", "g_ice_cream", "g_chocolate_chip_cookie", "g_trail_mix",
    "g_beef_jerky"
  ].forEach(id => assert.ok(ids.has(id), "missing " + id));
});

t("generic: no duplicate names (case-insensitive)", () => {
  const seen = new Map();
  M.DB.generic.forEach(f => {
    const k = f.name.toLowerCase();
    assert.ok(!seen.has(k), "duplicate name '" + f.name + "' (" + f.id + " and " + seen.get(k) + ")");
    seen.set(k, f.id);
  });
});

t("suggest: at least 40, ≥9 per slot, valid store and shape", () => {
  const S = M.DB.suggest;
  assert.ok(S.length >= 40, "only " + S.length + " suggestions");
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
  SLOTS.forEach(sl => assert.ok((bySlot[sl] || 0) >= 9, sl + " has only " + (bySlot[sl] || 0)));
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
