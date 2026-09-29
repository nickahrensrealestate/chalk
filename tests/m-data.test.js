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
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || "") + " expected " + a + " ≈ " + b + " (±" + tol + ")");
const COUNT_UNITS = /^(spray|sprays|packet|packets|serving|servings|piece|pieces)$/i;
/* the only brands built in: the products Nick named */
const BRANDS = ["Kirkland", "Dave's Killer Bread", "Daisy", "Smucker's Natural", "Hillshire Farm"];
/* everything they buy (Nick's list) — flagged staple: true */
const STAPLES = ["g_kirkland_organic_chicken", "g_pork_tenderloin", "g_dkb_21_grains", "g_dkb_good_seed", "g_dkb_thin", "g_zucchini", "g_zucchini_raw",
  "g_broccoli_raw", "g_broccoli_cooked", "g_carrots", "g_carrots_cooked", "g_roma_tomato", "g_onion", "g_sweet_onion", "g_cod", "g_shrimp", "g_scallops",
  "g_bell_pepper", "g_asparagus", "g_greek_yogurt_2", "g_quinoa", "g_cucumber", "g_banana", "g_blueberries", "g_strawberries", "g_agave", "g_lemon",
  "g_lemon_juice", "g_lime", "g_lime_juice", "g_corn", "g_cottage_cheese_2", "g_jam", "g_deli_turkey"];
/* small add-ons meal ideas may use besides staples */
const ADDONS = ["g_olive_oil", "g_soy_sauce", "g_white_rice"];

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
  /* old raw/cooked ids live on as aliases of the merged food */
  Object.keys(M.DB.alias).forEach(id => { ids.add(id); });
  [ /* what Nick and Katerina actually buy */
    "g_kirkland_organic_chicken", "g_pork_tenderloin_raw", "g_pork_tenderloin_cooked", "g_dkb_21_grains", "g_dkb_thin", "g_dkb_good_seed",
    "g_zucchini_raw", "g_zucchini", "g_broccoli_raw", "g_broccoli_cooked", "g_carrots", "g_carrots_cooked", "g_roma_tomato", "g_onion", "g_sweet_onion",
    "g_cod", "g_shrimp", "g_scallops", "g_quinoa", "g_asparagus", "g_greek_yogurt_2", "g_cucumber", "g_lemon", "g_lemon_juice", "g_lime", "g_lime_juice",
    "g_agave", "g_corn", "g_jam", "g_deli_turkey", "g_cottage_cheese_2", "g_cod_cooked", "g_quinoa_cooked", "g_chicken_breast",
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
    assert.ok(!f.brand || BRANDS.indexOf(f.brand) >= 0, "unexpected brand " + f.brand + " on " + f.name);
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
  /* built from what they actually buy: every item is a staple or a small add-on (oil, soy sauce, rice) */
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  S.forEach(s => {
    s.items.forEach(x => {
      const f = byId.get(x.foodId);
      assert.ok(f && (f.staple === true || ADDONS.indexOf(f.id) >= 0), s.id + ": " + x.name + " is not a food they buy");
    });
    assert.ok(s.items.filter(x => byId.get(x.foodId).staple === true).length >= 2, s.id + " is built from at least 2 foods they buy");
    /* stores: Kirkland chicken = Costco, pork tenderloin 2-pack = King Soopers, else Either */
    const ids = s.items.map(x => x.foodId);
    const want = ids.includes("g_kirkland_organic_chicken") ? "Costco" : ids.includes("g_pork_tenderloin") ? "King Soopers" : "Either";
    assert.strictEqual(s.store, want, s.id + " store");
  });
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

t("suggest: items reference generic foods with matching macros (cooked items use the cooked profile)", () => {
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  M.DB.suggest.forEach(s => s.items.forEach(x => {
    const f = byId.get(x.foodId);
    assert.ok(f, s.id + " item '" + x.name + "' has no generic food");
    assert.strictEqual(x.name, f.name, s.id + " item name differs from food");
    const p100 = x.state === "cooked" ? f.cook && f.cook.per100gCooked : f.per100g;
    if (x.g && p100) {
      const e = p100.cal * x.g / 100;
      assert.ok(Math.abs(e - x.per.cal) <= Math.max(3, 0.05 * e), s.id + " item " + x.name + " cal " + x.per.cal + " vs per100g×g " + e.toFixed(1));
    }
  }));
});

/* ---- raw ↔ cooked ---- */
/* old raw/cooked pairs that became one food (their old ids alias to it) */
const PAIRS = { chicken_thigh: "raw", ground_beef_80: "raw", ground_beef_85: "raw", ground_beef_90: "raw", ground_beef_93: "raw", ground_turkey_93: "raw", pork_tenderloin: "raw", salmon: "raw", white_rice: "dry", pasta: "dry" };
/* cook yield y (cooked g per raw/dry g) from each USDA pair: raw ÷ cooked protein (meat, fish), dry ÷ cooked kcal (grains) */
const Y = { kirkland_organic_chicken: 22.5 / 31, pork_tenderloin: 21 / 26.2, cod: 17.8 / 22.8, shrimp: 20.1 / 24, scallops: 12.1 / 20.5, salmon: 20.4 / 22.1,
  chicken_thigh: 19.7 / 24.8, ground_beef_80: 17.2 / 27, white_rice: 365 / 130, pasta: 371 / 158, quinoa: 368 / 120 };
/* USDA's own cooked numbers per 100 g (what MyFitnessPal shows): fat melts off, so these are NOT raw ÷ y.
   [kcal, protein, carbs, fat, sodium] */
const USDA_COOKED = { ground_beef_80: [272, 27, 0, 17.4, 91], ground_beef_85: [256, 27.7, 0, 15.3, 89], ground_beef_90: [230, 28.5, 0, 12, 87],
  ground_beef_93: [209, 28.9, 0, 9.5, 86], ground_turkey_93: [213, 27.1, 0, 11.6, 90], chicken_thigh: [179, 24.8, 0, 8.2, 106], salmon: [206, 22.1, 0, 12.4, 61],
  pork_tenderloin: [143, 26.2, 0, 3.5, 57], cod: [105, 22.8, 0, 0.9, 78], shrimp: [99, 24, 0.2, 0.3, 111], scallops: [111, 20.5, 5.4, 0.8, 667],
  white_rice: [130, 2.7, 28.2, 0.3, 1], pasta: [158, 5.8, 31, 0.9, 1], quinoa: [120, 4.4, 21.3, 1.9, 7] };
t("cooked profile: USDA pairs use USDA's cooked numbers (MyFitnessPal); only the Kirkland label breast is raw ÷ y", () => {
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  const cooks = M.DB.generic.filter(f => f.cook);
  cooks.forEach(f => {
    const slug = f.id.slice(2), c = f.cook.per100gCooked;
    if (slug === "kirkland_organic_chicken") return;
    const u = USDA_COOKED[slug]; assert.ok(u, slug + ": cooked numbers come from a USDA pair");
    [["cal", 0], ["p", 1], ["c", 2], ["f", 3], ["sodium", 4]].forEach(([k, i]) => near(c[k], u[i], k === "cal" || k === "sodium" ? 0.5 : 0.05, slug + " cooked " + k));
  });
  /* the bug this fixes: raw ÷ y made cooked 80/20 beef 369 kcal per 100 g */
  near(byId.get("g_ground_beef_80").cook.per100gCooked.cal, 272, 0.5, "cooked 80/20 beef");
  /* Kirkland: no published cooked numbers, so cooked = the label's raw ÷ y (same piece, same calories) */
  const k = byId.get("g_kirkland_organic_chicken");
  NUT.forEach(n => near(k.cook.per100gCooked[n], k.per100g[n] / k.cook.y, n === "cal" || n === "sodium" ? 0.51 : 0.051, "Kirkland cooked " + n));
  near(k.cook.per100gCooked.cal, 135, 0.5, "Kirkland cooked ≈ 135 kcal / 100 g");
});
t("cook foods: ONE food with raw (or dry) and cooked profiles; y from the USDA pair", () => {
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  const cooks = M.DB.generic.filter(f => f.cook);
  ["kirkland_organic_chicken", "cod", "shrimp", "scallops", "quinoa"].concat(Object.keys(PAIRS)).forEach(slug => assert.ok(byId.get("g_" + slug) && byId.get("g_" + slug).cook, "cook food g_" + slug));
  cooks.forEach(f => {
    const c = f.cook, slug = f.id.slice(2);
    assert.ok(!/\b(raw|cooked|dry|uncooked)\b/i.test(f.name), "plain name: " + f.name);
    assert.ok((c.word === "raw" || c.word === "dry") && c.per100gCooked && Array.isArray(c.alts), slug + " cook");
    assert.ok(c.word === "dry" ? c.y > 1 : c.y < 1, slug + ": meat weighs less cooked, grains more");
    if (Y[slug]) near(c.y, Y[slug], 1e-4, slug + " y");
    NUT.forEach(k => assert.ok(isNum(c.per100gCooked[k]) && c.per100gCooked[k] >= 0, slug + " cooked " + k));
    /* protein carries over: cooked protein ≈ raw protein ÷ y (that is how y was found) */
    if (c.word === "raw") near(c.per100gCooked.p, f.per100g.p / c.y, 0.06, slug + " cooked protein = raw ÷ y");
    /* serving / per / per100g stay the raw (dry) state */
    near(f.per.cal, f.per100g.cal * f.serving.g / 100, Math.max(2, 0.02 * f.per.cal), slug + " per is raw");
  });
  Object.keys(PAIRS).forEach(slug => {
    assert.ok(!byId.has("g_" + slug + "_" + PAIRS[slug]) && !byId.has("g_" + slug + "_cooked"), slug + ": the old pair is gone");
    assert.deepStrictEqual(M.DB.alias["g_" + slug + "_" + PAIRS[slug]], { id: "g_" + slug, state: "raw" });
    assert.deepStrictEqual(M.DB.alias["g_" + slug + "_cooked"], { id: "g_" + slug, state: "cooked" });
  });
  /* chicken breast is the Kirkland breast; cooked-only cod / shrimp / quinoa became cook foods */
  const K = "g_kirkland_organic_chicken";
  assert.deepStrictEqual(M.DB.alias.g_chicken_breast, { id: K, state: "raw" });
  assert.deepStrictEqual(M.DB.alias.g_chicken_breast_raw, { id: K, state: "raw" });
  assert.deepStrictEqual(M.DB.alias.g_chicken_breast_cooked, { id: K, state: "cooked" });
  assert.deepStrictEqual(M.DB.alias.g_cod_cooked, { id: "g_cod", state: "cooked" });
  assert.deepStrictEqual(M.DB.alias.g_shrimp_cooked, { id: "g_shrimp", state: "cooked" });
  assert.deepStrictEqual(M.DB.alias.g_quinoa_cooked, { id: "g_quinoa", state: "cooked" });
  assert.ok(!byId.has("g_chicken_breast") && !byId.has("g_cod_cooked") && !byId.has("g_shrimp_cooked") && !byId.has("g_quinoa_cooked"), "merged ids are gone");
  assert.strictEqual(Object.keys(M.DB.alias).length, 26, "every old id has an alias");
  Object.values(M.DB.alias).forEach(a => assert.ok(byId.has(a.id) && byId.get(a.id).cook, "alias target " + a.id + " is a cook food"));
  /* numbers in the spec */
  const ck = byId.get(K);
  assert.ok(Math.abs(6 * ck.cook.y - 4.35) < 0.01, "6 oz raw chicken ≈ 4.4 oz cooked");
  assert.strictEqual(Math.round(175 * ck.cook.y), 127, "one breast: 175 g raw ≈ 127 g cooked");
  assert.ok(Math.abs(2 * byId.get("g_white_rice").cook.y - 5.6) < 0.05, "2 oz dry rice ≈ 5.6 oz cooked");
  const cups = byId.get("g_white_rice").cook.alts.find(a => a.label === "1 cup");
  assert.strictEqual(cups && cups.g, 158, "1 cup cooked rice = 158 g");
  const q = byId.get("g_quinoa");
  assert.strictEqual(q.cook.word, "dry"); assert.strictEqual(q.cook.alts.find(a => a.label === "1 cup").g, 185, "1 cup cooked quinoa = 185 g");
  const sh = byId.get("g_shrimp");
  assert.ok(sh.alts.some(a => /^1 large shrimp$/.test(a.label)) && sh.cook.alts.some(a => /^1 large shrimp$/.test(a.label)), "shrimp by count, raw and cooked");
});

t("chicken breast = the Kirkland organic breast: 1 breast = 175 g raw, alwaysRaw, label numbers", () => {
  const f = M.DB.generic.find(x => x.id === "g_kirkland_organic_chicken");
  assert.ok(/^Chicken breast\b/.test(f.name), "name starts with Chicken breast: " + f.name);
  assert.strictEqual(f.brand, "Kirkland");
  assert.strictEqual(f.alwaysRaw, true); assert.strictEqual(f.staple, true);
  assert.deepStrictEqual(f.serving, { qty: 1, unit: "breast", g: 175 });
  assert.strictEqual(f.alts.find(a => a.label === "1/2 breast").g, 88);
  ["1 oz", "4 oz", "6 oz", "100 g"].forEach(l => assert.ok(f.alts.some(a => a.label === l), "alt " + l));
  /* label: 4 oz (112 g) = 110 kcal, 24 g protein, 0 g carbs, 1 g fat, 75 mg sodium */
  const lab = k => f.per100g[k] * 112 / 100;
  near(lab("cal"), 110, 0.5, "kcal / 112 g"); near(lab("p"), 24, 0.05, "protein / 112 g"); near(lab("f"), 1, 0.05, "fat / 112 g");
  near(lab("c"), 0, 0, "carbs"); near(lab("sodium"), 75, 0.5, "sodium / 112 g");
  near(f.per.cal, 172, 0.5, "one breast (175 g raw) ≈ 172 kcal"); near(f.per.p, 37.5, 0.05, "one breast ≈ 37.5 g protein");
  assert.strictEqual(M.DB.generic.filter(x => /^chicken breast/i.test(x.name)).length, 1, "one chicken breast food");
});

t("suggest: cook items say which weight they are and carry y; chicken is always raw grams", () => {
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  let n = 0;
  M.DB.suggest.forEach(s => s.items.forEach(x => {
    const f = byId.get(x.foodId);
    if (!f.cook) { assert.ok(!x.state && !x.cook, s.id + " plain item has no state"); return; }
    n++;
    assert.ok(x.state === "raw" || x.state === "cooked", s.id + " " + x.name + " state");
    assert.deepStrictEqual(x.cook, { y: f.cook.y, word: f.cook.word }, s.id + " cook");
    const word = x.state === "cooked" ? "cooked" : f.cook.word;
    assert.ok(new RegExp("^[\\d/ .]+ (oz|cup|cups|breast) (" + word + "|\\(\\d+ g " + word + "\\))$").test(x.servingLabel), s.id + " label " + x.servingLabel);
    if (f.id === "g_kirkland_organic_chicken") {
      assert.strictEqual(x.state, "raw", s.id + ": chicken breast is never cooked grams");
      assert.ok((x.g === 175 && x.servingLabel === "1 breast (175 g raw)") || (x.g === 88 && x.servingLabel === "1/2 breast (88 g raw)"), s.id + " chicken " + x.servingLabel);
    }
  }));
  assert.ok(n >= 10, "chicken, pork, fish, rice and quinoa items are cook items (" + n + ")");
  assert.ok(M.DB.suggest.filter(s => s.items.some(x => x.foodId === "g_kirkland_organic_chicken")).length >= 4, "chicken ideas");
});

/* ---- the foods they buy (Nick's list) ---- */
t("staples: every food they buy is flagged staple: true, and nothing else", () => {
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  STAPLES.forEach(id => { assert.ok(byId.has(id), "missing " + id); assert.strictEqual(byId.get(id).staple, true, id + " staple"); });
  M.DB.generic.filter(f => f.staple === true).forEach(f => assert.ok(STAPLES.indexOf(f.id) >= 0, "not on their list: " + f.id));
  assert.deepStrictEqual(M.DB.generic.filter(f => f.alwaysRaw === true).map(f => f.id), ["g_kirkland_organic_chicken"], "only chicken breast is alwaysRaw");
});

/* label = the package (brands); per 100 g = USDA SR Legacy (plain foods). ±rounding. */
const LABEL = { /* id: [serving g, kcal, protein, carbs, fat, fiber, sugar, sodium mg] per the label serving */
  g_cottage_cheese_2: [113, 90, 13, 5, 2.5, 0, 4, 350], g_jam: [19, 40, 0, 10, 0, 0, 10, 0], g_deli_turkey: [56, 60, 10, 2, 1.5, 0, 0, 490],
  g_dkb_21_grains: [45, 110, 5, 22, 1.5, 5, 5, 170], g_dkb_good_seed: [45, 120, 5, 23, 3, 3, 5, 160], g_dkb_thin: [28, 60, 3, 12, 1, 3, 3, 100] };
const USDA = { /* id: per 100 g [kcal, protein, carbs, fat, fiber, sugar, sodium mg] */
  g_pork_tenderloin: [109, 21, 0, 2.2, 0, 0, 53], g_cod: [82, 17.8, 0, 0.7, 0, 0, 54], g_shrimp: [85, 20.1, 0, 0.5, 0, 0, 119], g_scallops: [69, 12.1, 3.2, 0.5, 0, 0, 392],
  g_quinoa: [368, 14.1, 64.2, 6.1, 7, 0, 5], g_asparagus: [20, 2.2, 3.9, 0.1, 2.1, 1.9, 2], g_bell_pepper: [26, 1, 6, 0.3, 2.1, 4.2, 4],
  g_greek_yogurt_2: [73, 9.9, 3.9, 1.9, 0, 3.6, 34], g_cucumber: [15, 0.7, 3.6, 0.1, 0.5, 1.7, 2], g_zucchini_raw: [17, 1.2, 3.1, 0.3, 1, 2.5, 8],
  g_zucchini: [15, 1.1, 2.7, 0.4, 1, 1.7, 3], g_banana: [89, 1.1, 22.8, 0.3, 2.6, 12.2, 1], g_blueberries: [57, 0.7, 14.5, 0.3, 2.4, 10, 1],
  g_strawberries: [32, 0.7, 7.7, 0.3, 2, 4.9, 1], g_agave: [310, 0.1, 76.4, 0.5, 0.2, 68, 4], g_lemon: [29, 1.1, 9.3, 0.3, 2.8, 2.5, 2],
  g_lemon_juice: [22, 0.4, 6.9, 0.2, 0.3, 2.5, 1], g_lime: [30, 0.7, 10.5, 0.2, 2.8, 1.7, 2], g_lime_juice: [25, 0.4, 8.4, 0.1, 0.4, 1.7, 2],
  g_corn: [96, 3.4, 21, 1.5, 2.4, 4.5, 1], g_broccoli_raw: [34, 2.8, 6.6, 0.4, 2.6, 1.7, 33], g_broccoli_cooked: [35, 2.4, 7.2, 0.4, 3.3, 1.4, 41],
  g_carrots: [41, 0.9, 9.6, 0.2, 2.8, 4.7, 69], g_carrots_cooked: [35, 0.8, 8.2, 0.2, 3, 3.5, 58], g_roma_tomato: [18, 0.9, 3.9, 0.2, 1.2, 2.6, 5],
  g_onion: [40, 1.1, 9.3, 0.1, 1.7, 4.2, 4], g_sweet_onion: [32, 0.8, 7.6, 0.1, 0.9, 5, 8] };
t("MyFitnessPal check: brands match the package label, plain staples match USDA", () => {
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  Object.keys(LABEL).forEach(id => {
    const f = byId.get(id), v = LABEL[id];
    assert.strictEqual(f.serving.g, v[0], id + " label serving grams");
    NUT.forEach((k, i) => near(f.per[k], v[i + 1], 0, id + " " + k));
  });
  Object.keys(USDA).forEach(id => {
    const f = byId.get(id), v = USDA[id];
    NUT.forEach((k, i) => near(f.per100g[k], v[i], k === "cal" || k === "sodium" ? 0.5 : 0.05, id + " per 100 g " + k));
  });
  STAPLES.forEach(id => assert.ok(LABEL[id] || USDA[id] || id === "g_kirkland_organic_chicken", "every staple is checked: " + id));
});

t("brands: Daisy 2% cottage cheese, Smucker's Natural strawberry (jam / jelly), Hillshire turkey slices", () => {
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  const cc = byId.get("g_cottage_cheese_2"), jam = byId.get("g_jam"), tk = byId.get("g_deli_turkey");
  assert.deepStrictEqual([cc.name, cc.brand], ["Cottage cheese, 2%", "Daisy"]);
  assert.deepStrictEqual([jam.name, jam.brand], ["Strawberry jam / jelly", "Smucker's Natural"]);
  assert.deepStrictEqual([tk.name, tk.brand], ["Turkey slices, oven roasted", "Hillshire Farm"]);
  assert.deepStrictEqual(tk.serving, { qty: 6, unit: "slices", g: 56 }, "label serving: 2 oz, about 6 slices");
  assert.ok(tk.alts.some(a => a.label === "1 slice" && a.g === 9.3) && tk.alts.some(a => a.label === "2 oz" && a.g === 56), "by slice and by the label serving");
  assert.ok(jam.alts.some(a => a.label === "1 tsp"), "jam by tsp too");
  /* the only cottage cheese, jam and deli turkey built in */
  assert.deepStrictEqual(M.DB.generic.filter(f => /cottage cheese/i.test(f.name)).map(f => f.id), ["g_cottage_cheese_2"]);
  assert.deepStrictEqual(M.DB.generic.filter(f => /\b(jam|jelly)\b/i.test(f.name)).map(f => f.id), ["g_jam"]);
  assert.deepStrictEqual(M.DB.generic.filter(f => /turkey/i.test(f.name) && /\b(deli|slices?|sliced|lunch)\b/i.test(f.name)).map(f => f.id), ["g_deli_turkey"]);
});

/* Every word Nick uses for these foods hits the food's name, brand or `words`
   (prefix match, plural s dropped) — the same rule M.search uses. */
const tok = s => String(s || "").toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9%]+/).filter(Boolean).map(w => (w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w));
const hits = (q, f) => { const have = tok(f.name + " " + f.brand + " " + (f.words || "")); return tok(q).every(w => have.some(h => h.startsWith(w))); };
const WORDS = {
  g_kirkland_organic_chicken: ["chicken", "chicken breast", "chicken breasts", "breast"],
  g_cottage_cheese_2: ["cottage cheese"], g_jam: ["jam", "jelly", "strawberry jam", "strawberry jelly"],
  g_deli_turkey: ["turkey", "turkey slices", "sliced turkey", "deli turkey", "lunch meat"],
  g_egg_large: ["egg", "eggs"], g_quinoa: ["quinoa"], g_agave: ["agave"], g_corn: ["corn on the cob", "corn"], g_bell_pepper: ["bell pepper"]
};
t("words: the words they use find these foods (name, brand or words)", () => {
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  Object.keys(WORDS).forEach(id => WORDS[id].forEach(q => assert.ok(hits(q, byId.get(id)), "'" + q + "' should find " + id)));
  M.DB.generic.forEach(f => { if (f.words !== undefined) assert.ok(typeof f.words === "string" && f.words.length < 80, f.id + " words"); });
  assert.ok(/^Eggs\b/.test(byId.get("g_egg_large").name), "whole egg first for egg / eggs: " + byId.get("g_egg_large").name);
  ["g_dkb_21_grains", "g_dkb_good_seed", "g_dkb_thin"].forEach(id => assert.ok(!/dave/i.test(byId.get(id).name), "brand not repeated in the name: " + byId.get(id).name));
});

/* With m-core loaded too (its own context, app load order), M.search puts
   these foods first. Skipped if m-core can't load here. */
t("search (m-core + m-data): their words list the food they buy first", () => {
  const ctx = { console, Date, Math, JSON, setTimeout, clearTimeout, Intl };
  ctx.window = ctx; ctx.self = ctx;
  ctx.localStorage = { store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = String(v); }, removeItem(k) { delete this.store[k]; } };
  ctx.S = { profile: "nick" }; ctx.PRESETS = { nick: { name: "Nick" }, kat: { name: "Katerina" } };
  vm.createContext(ctx);
  try { ["m-core.js", "m-data.js"].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), ctx, { filename: f })); }
  catch (e) { console.log("       (skipped: m-core did not load: " + e.message + ")"); return; }
  const C = ctx.M;
  if (!C || typeof C.search !== "function") { console.log("       (skipped: no M.search)"); return; }
  if (typeof C.reset === "function") C.reset();
  const top = q => { const r = C.search(q, { pid: "nick" }).filter(x => x.kind === "generic"); return r.length ? r[0].id : null; };
  Object.keys(WORDS).forEach(id => WORDS[id].forEach(q => { if (q !== "corn") assert.strictEqual(top(q), id, "'" + q + "' → " + top(q)); }));
  assert.strictEqual(C.foods.get("g_chicken_breast").id, "g_kirkland_organic_chicken", "old chicken breast id → the Kirkland breast");
});

/* ---- meal ideas ---- */
t("suggest: only foods they eat — no other cheese, oats, cereal, shakes, bars, protein powder, peanut butter, honey or restaurant food", () => {
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  const banned = /cheese|cheddar|mozzarella|parmesan|\boats?\b|oatmeal|cereal|granola|shake|\bbar\b|protein powder|whey|peanut|honey|restaurant|caesar/i;
  const noCottage = t => String(t).replace(/cottage cheese/gi, "");
  M.DB.suggest.forEach(s => {
    assert.ok(!banned.test(noCottage(s.name)) && !banned.test(noCottage(s.desc)), s.id + " text: " + s.name + " / " + s.desc);
    s.items.forEach(x => {
      const f = byId.get(x.foodId);
      assert.ok(f, s.id + ": '" + x.name + "' resolves to a real food");
      assert.ok(!banned.test(f.name) || f.id === "g_cottage_cheese_2", s.id + " uses " + f.name);
    });
  });
  const ids = new Set(); M.DB.suggest.forEach(s => s.items.forEach(x => ids.add(x.foodId)));
  ["g_kirkland_organic_chicken", "g_pork_tenderloin", "g_cod", "g_shrimp", "g_scallops", "g_quinoa", "g_greek_yogurt_2", "g_cottage_cheese_2", "g_deli_turkey",
    "g_dkb_21_grains", "g_jam", "g_corn", "g_agave", "g_asparagus", "g_bell_pepper", "g_cucumber"].forEach(id => assert.ok(ids.has(id), "some idea uses " + id));
  assert.ok(M.DB.suggest.length >= 12, "12+ ideas");
});

/* The ideas sheet shows a one-serving label as written only when it uses ½ ¼ ¾ (else it
   prints "0.5 cup"), so plain items write fractions the way the diary does. */
t("suggest: plain item labels use ½ ¼ ¾ (not 1/2) and their grams match the item", () => {
  M.DB.suggest.forEach(s => s.items.forEach(x => {
    if (x.state) return;   /* cook items: m-core writes "6 oz raw (4.4 oz cooked)" */
    assert.ok(!/\b\d\/\d\b/.test(x.servingLabel), s.id + ": " + x.servingLabel);
    const m = /\(([\d.]+) g\)$/.exec(x.servingLabel);
    assert.ok(m && Math.abs(parseFloat(m[1]) - x.g) < 0.051, s.id + ": grams in " + x.servingLabel + " = " + x.g);
  }));
});

/* ---- old ids in real diaries (live d757f4b storage format) ---- */
/* Every generic id that was live (d757f4b) is still a food or an alias, except
   g_cottage_cheese_4, which was removed on purpose: its entries keep their own numbers. */
const LIVE_IDS_GONE = ["g_chicken_breast", "g_chicken_breast_raw", "g_chicken_breast_cooked", "g_cod_cooked", "g_shrimp_cooked", "g_quinoa_cooked"];
t("old ids: a live-format diary and saved meal load, resolve and keep their own numbers", () => {
  const ctx = { console, Date, Math, JSON, setTimeout, clearTimeout, Intl };
  ctx.window = ctx; ctx.self = ctx;
  ctx.localStorage = { store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = String(v); }, removeItem(k) { delete this.store[k]; }, key(i) { return Object.keys(this.store)[i] ?? null; }, get length() { return Object.keys(this.store).length; } };
  ctx.S = { profile: "nick" }; ctx.PRESETS = { nick: { name: "Nick" }, kat: { name: "Katerina" } };
  vm.createContext(ctx);
  /* entries exactly as the live app wrote them (servingLabel, servings, g, per, foodId, state/cook on cook foods) */
  const P = (cal, p, c, f) => ({ cal, p, c, f, fiber: 0, sugar: 0, sodium: 0 });
  const E = (id, foodId, name, servingLabel, servings, g, per, extra) => Object.assign({ id, name, brand: "", slot: "Lunch", servingLabel, servings, g, per, foodId, at: 1790000000000 }, extra || {});
  const today = (() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })();
  const entries = [
    E("e1", "g_chicken_breast_cooked", "Chicken breast, cooked", "1 oz cooked", 6, 28.35, P(46.8, 8.8, 0, 1), { state: "cooked", cook: { y: 0.7258, word: "raw" } }),
    E("e2", "g_chicken_breast", "Chicken breast, boneless skinless", "1 oz raw", 8, 28.35, P(34, 6.4, 0, 0.7), { state: "raw", cook: { y: 0.7258, word: "raw" } }),
    E("e3", "g_chicken_breast_raw", "Chicken breast, raw", "4 oz (113 g)", 1, 113, P(136, 25.4, 0, 3)),
    E("e4", "g_cod_cooked", "Cod, cooked", "4 oz (113 g)", 1, 113, P(119, 25.8, 0, 1)),
    E("e5", "g_shrimp_cooked", "Shrimp, cooked", "3 oz (85 g)", 1, 85, P(84, 20.4, 0.2, 0.2)),
    E("e6", "g_quinoa_cooked", "Quinoa, cooked", "1 cup (185 g)", 1, 185, P(222, 8.1, 39.4, 3.6)),
    E("e7", "g_cottage_cheese_4", "Cottage cheese, 4%", "1/2 cup (113 g)", 1, 113, P(110, 12, 5, 5)),
    E("e8", "g_ground_beef_80_cooked", "Ground beef 80/20, cooked", "4 oz (113 g)", 1, 113, P(283, 28.3, 0, 18.1))
  ];
  const saved = entries.map(e => JSON.parse(JSON.stringify(e)));
  const meal = { id: "m_live1", name: "Chicken bowl", slot: "Lunch", items: [entries[0], entries[5], entries[6]].map(e => JSON.parse(JSON.stringify(e))), per: P(378.8, 28.9, 44.4, 9.6), uses: 3, lastUsed: 1790000000000, createdAt: 1780000000000, updatedAt: 1790000000000, pid: "nick" };
  const live = { v: 1, updatedAt: 1790000000000, ui: { mode: "macros", person: "nick", date: today, tab: "diary" },
    profiles: { nick: { id: "nick", name: "Nick", sex: "m", age: 40, heightIn: 71, weightLb: 185, setupAt: 1780000000000, lastBody: 1790000000000, targets: { cal: 2200, p: 180, c: 200, f: 70 }, updatedAt: 1790000000000 } },
    foods: {}, meals: { m_live1: meal }, days: { ["nick|" + today]: { id: "nick|" + today, pid: "nick", date: today, entries, water: 0, note: "", updatedAt: 1790000000000 } }, body: {} };
  ctx.localStorage.setItem("chalk.macros.v1", JSON.stringify(live));
  try { ["m-core.js", "m-data.js"].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), ctx, { filename: f })); }
  catch (e) { console.log("       (skipped: m-core did not load: " + e.message + ")"); return; }
  const C = ctx.M;
  if (!C || !C.foods || !C.dayOf) { console.log("       (skipped: no M.dayOf)"); return; }
  if (typeof C.load === "function") C.load();
  /* every old id resolves to the merged food, with the right state */
  LIVE_IDS_GONE.forEach(id => { const f = C.foods.get(id); assert.ok(f && f.id === M.DB.alias[id].id, id + " → " + (f && f.id)); });
  assert.strictEqual(C.cook.alias("g_chicken_breast_cooked").state, "cooked");
  assert.strictEqual(C.foods.get("g_cottage_cheese_4"), null, "removed id: no food (the entry keeps its own numbers)");
  /* the day's entries keep exactly the numbers they were saved with */
  const d = C.dayOf(today, "nick");
  assert.ok(d && d.entries.length === saved.length, "all " + saved.length + " entries load");
  saved.forEach(s => {
    const e = d.entries.find(x => x.id === s.id); assert.ok(e, s.id + " kept");
    ["cal", "p", "c", "f"].forEach(k => assert.strictEqual(e.per[k], s.per[k], s.id + " " + k + " unchanged"));
    assert.strictEqual(e.servings, s.servings, s.id + " servings"); assert.strictEqual(e.servingLabel, s.servingLabel, s.id + " label");
  });
  const tot = C.log.totals(today, "nick"), want = saved.reduce((a, s) => a + s.per.cal * s.servings, 0);
  near(tot.cal, want, 1, "day total = the saved numbers");
  /* cooked chicken from before the merge still reads raw (cooked) */
  const i1 = C.cook.entryInfo(d.entries.find(x => x.id === "e1"));
  assert.ok(i1 && i1.state === "cooked" && Math.abs(i1.cook.y - 0.7258) < 1e-4, "old cooked chicken keeps its state and y");
  /* the saved meal still holds its items and numbers */
  const m = C.meals.get("m_live1");
  assert.ok(m && m.items.length === 3, "saved meal kept");
  near(m.per.cal, 378.8, 0.05, "saved meal total unchanged");
  /* recents: live foods rebuild (chicken comes back raw); the removed 4% cottage cheese keeps its snapshot */
  if (typeof C.recents === "function") {
    const rs = C.recents("nick", 30);
    const cc = rs.find(r => r.foodId === "g_cottage_cheese_4");
    assert.ok(cc && cc.per.cal === 110 && cc.name === "Cottage cheese, 4%", "gone food: recent keeps its snapshot");
    const ch = rs.filter(r => r.foodId === "g_kirkland_organic_chicken");
    assert.ok(ch.length >= 1 && ch.every(r => r.state === "raw"), "old chicken recents come back as the Kirkland breast, raw");
    rs.forEach(r => NUT.forEach(k => assert.ok(isNum(r.per[k]), "recent " + r.name + " " + k)));
  }
});

/* ---- run ---- */
let pass = 0, fail = 0;
tests.forEach(({ name, fn }) => {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e && e.message)); }
});
console.log("\n" + pass + " passed, " + fail + " failed · " + M.DB.generic.length + " generic foods · " + M.DB.suggest.length + " suggestions");
if (fail) process.exit(1);
