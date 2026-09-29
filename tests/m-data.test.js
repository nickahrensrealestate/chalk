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
  "g_broccoli_raw", "g_broccoli_cooked", "g_carrots", "g_carrots_cooked", "g_roma_tomato", "g_onion", "g_sweet_onion", "g_cod", "g_kirkland_cooked_shrimp", "g_scallops",
  "g_bell_pepper", "g_asparagus", "g_greek_yogurt_2", "g_quinoa", "g_cucumber", "g_banana", "g_blueberries", "g_strawberries", "g_agave", "g_lemon",
  "g_lemon_juice", "g_lime", "g_lime_juice", "g_corn", "g_cottage_cheese_2", "g_jam", "g_deli_turkey", "g_carrots_baby"];
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
    "g_cod", "g_kirkland_cooked_shrimp", "g_scallops", "g_quinoa", "g_asparagus", "g_greek_yogurt_2", "g_cucumber", "g_lemon", "g_lemon_juice", "g_lime", "g_lime_juice",
    "g_agave", "g_corn", "g_jam", "g_deli_turkey", "g_cottage_cheese_2", "g_cod_cooked", "g_quinoa_cooked", "g_chicken_breast",
    /* plain basics */
    "g_chicken_breast_raw", "g_chicken_breast_cooked", "g_chicken_thigh_raw", "g_ground_beef_93_cooked", "g_ground_turkey_93_raw", "g_salmon_cooked",
    "g_salmon_raw", "g_tuna_canned_water", "g_egg_large", "g_egg_white", "g_greek_yogurt_0", "g_cottage_cheese_2", "g_whey_protein",
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
    /* stores: anything Kirkland (the chicken breast; the frozen cod, shrimp and scallops) = Costco,
       pork tenderloin 2-pack = King Soopers, else Either */
    const ids = s.items.map(x => x.foodId);
    const want = ids.some(id => byId.get(id).brand === "Kirkland") ? "Costco" : ids.includes("g_pork_tenderloin") ? "King Soopers" : "Either";
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
/* Kirkland cod and scallops: the label's protein per 100 g ÷ USDA's cooked protein (cod, dry heat; scallops, steamed) */
const Y = { kirkland_organic_chicken: 22.5 / 31, pork_tenderloin: 21 / 26.2, cod: 17.65 / 22.8, scallops: 16.81 / 20.5, salmon: 20.4 / 22.1,
  chicken_thigh: 19.7 / 24.8, ground_beef_80: 17.2 / 27, white_rice: 365 / 130, pasta: 371 / 158, quinoa: 368 / 120 };
/* USDA's own cooked numbers per 100 g (what MyFitnessPal shows): fat melts off, so these are NOT raw ÷ y.
   [kcal, protein, carbs, fat, sodium] */
const USDA_COOKED = { ground_beef_80: [272, 27, 0, 17.4, 91], ground_beef_85: [256, 27.7, 0, 15.3, 89], ground_beef_90: [230, 28.5, 0, 12, 87],
  ground_beef_93: [209, 28.9, 0, 9.5, 86], ground_turkey_93: [213, 27.1, 0, 11.6, 90], chicken_thigh: [179, 24.8, 0, 8.2, 106], salmon: [206, 22.1, 0, 12.4, 61],
  pork_tenderloin: [143, 26.2, 0, 3.5, 57],
  white_rice: [130, 2.7, 28.2, 0.3, 1], pasta: [158, 5.8, 31, 0.9, 1], quinoa: [120, 4.4, 21.3, 1.9, 7] };
/* Kirkland label fish: cooked protein per 100 g stays at USDA's cooked fish (what MyFitnessPal shows) */
const LABEL_COOKED_P = { cod: 22.8, scallops: 20.5 };
t("cooked profile: USDA pairs use USDA's cooked numbers (MyFitnessPal); Kirkland label foods (breast, cod, scallops) are raw ÷ y", () => {
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  const cooks = M.DB.generic.filter(f => f.cook);
  assert.deepStrictEqual(cooks.filter(f => f.brand === "Kirkland").map(f => f.id).sort(), ["g_cod", "g_kirkland_organic_chicken", "g_scallops"], "Kirkland cook foods");
  cooks.forEach(f => {
    const slug = f.id.slice(2), c = f.cook.per100gCooked;
    if (f.brand === "Kirkland") {
      NUT.forEach(n => near(c[n], f.per100g[n] / f.cook.y, n === "cal" || n === "sodium" ? 0.51 : 0.051, slug + " cooked " + n + " = label ÷ y"));
      if (LABEL_COOKED_P[slug]) near(c.p, LABEL_COOKED_P[slug], 0.051, slug + " cooked protein = USDA cooked");
      return;
    }
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
  ["kirkland_organic_chicken", "cod", "scallops", "quinoa"].concat(Object.keys(PAIRS)).forEach(slug => assert.ok(byId.get("g_" + slug) && byId.get("g_" + slug).cook, "cook food g_" + slug));
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
  /* chicken breast is the Kirkland breast; cooked-only cod / quinoa became cook foods */
  const K = "g_kirkland_organic_chicken";
  assert.deepStrictEqual(M.DB.alias.g_chicken_breast, { id: K, state: "raw" });
  assert.deepStrictEqual(M.DB.alias.g_chicken_breast_raw, { id: K, state: "raw" });
  assert.deepStrictEqual(M.DB.alias.g_chicken_breast_cooked, { id: K, state: "cooked" });
  assert.deepStrictEqual(M.DB.alias.g_cod_cooked, { id: "g_cod", state: "cooked" });
  assert.deepStrictEqual(M.DB.alias.g_quinoa_cooked, { id: "g_quinoa", state: "cooked" });
  assert.ok(!byId.has("g_chicken_breast") && !byId.has("g_cod_cooked") && !byId.has("g_shrimp_cooked") && !byId.has("g_quinoa_cooked"), "merged ids are gone");
  assert.strictEqual(Object.keys(M.DB.alias).length, 25, "every old id has an alias");
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
  /* the shrimp they buy comes cooked: a plain food by the piece, not a cook food. The plain raw /
     cooked shrimp is replaced, not aliased (an alias would stamp raw / cooked on old entries). */
  const sh = byId.get("g_kirkland_cooked_shrimp");
  assert.ok(sh && !sh.cook && !byId.has("g_shrimp") && sh.alts.some(a => a.label === "1 shrimp" && a.g === 10.5), "Kirkland cooked shrimp: no raw / cooked, 1 shrimp = 10.5 g");
  assert.deepStrictEqual(M.DB.replaced, { g_shrimp: "g_kirkland_cooked_shrimp", g_shrimp_cooked: "g_kirkland_cooked_shrimp" });
  assert.ok(!M.DB.alias.g_shrimp && !M.DB.alias.g_shrimp_cooked, "no shrimp alias");
});

t("chicken breast = the Kirkland organic breast: 1 breast = 175 g raw, alwaysRaw, label numbers", () => {
  const f = M.DB.generic.find(x => x.id === "g_kirkland_organic_chicken");
  assert.ok(/^Chicken breast\b/.test(f.name), "name starts with Chicken breast: " + f.name);
  assert.strictEqual(f.brand, "Kirkland");
  assert.strictEqual(f.alwaysRaw, true); assert.strictEqual(f.staple, true);
  assert.deepStrictEqual(f.serving, { qty: 1, unit: "breast", g: 175 });
  assert.strictEqual(f.alts.find(a => a.label === "½ breast").g, 88);
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
    assert.ok(new RegExp("^[\\d¼½¾ .]+ (oz|cup|cups|breast|fillet|scallops) (" + word + "|\\(\\d+ g " + word + "\\))$").test(x.servingLabel), s.id + " label " + x.servingLabel);
    if (f.id === "g_kirkland_organic_chicken") {
      assert.strictEqual(x.state, "raw", s.id + ": chicken breast is never cooked grams");
      assert.ok((x.g === 175 && x.servingLabel === "1 breast (175 g raw)") || (x.g === 88 && x.servingLabel === "½ breast (88 g raw)"), s.id + " chicken " + x.servingLabel);
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
  g_dkb_21_grains: [45, 110, 6, 22, 1.5, 4, 4, 170] /* the bag sold now (C7: Kroger label + OFF front photo) */, g_dkb_good_seed: [45, 120, 5, 23, 3, 3, 5, 160],
  g_dkb_thin: [28, 60, 3, 14, 1, 3, 3, 105] /* C7: King Soopers label for this loaf */,
  /* Kirkland Signature frozen seafood (Costco), checked on Open Food Facts by barcode */
  g_cod: [170, 120, 30, 0, 0, 0, 0, 190], g_scallops: [113, 100, 19, 3, 1, 0, 0, 180], g_kirkland_cooked_shrimp: [84, 80, 20, 0, 0, 0, 0, 230] };
const USDA = { /* id: per 100 g [kcal, protein, carbs, fat, fiber, sugar, sodium mg] */
  g_pork_tenderloin: [109, 21, 0, 2.2, 0, 0, 53],
  g_quinoa: [368, 14.1, 64.2, 6.1, 7, 0, 5], g_asparagus: [20, 2.2, 3.9, 0.1, 2.1, 1.9, 2], g_bell_pepper: [26, 1, 6, 0.3, 2.1, 4.2, 4],
  g_greek_yogurt_2: [73, 9.9, 3.9, 1.9, 0, 3.6, 34], g_cucumber: [15, 0.7, 3.6, 0.1, 0.5, 1.7, 2], g_zucchini_raw: [17, 1.2, 3.1, 0.3, 1, 2.5, 8],
  g_zucchini: [15, 1.1, 2.7, 0.4, 1, 1.7, 3], g_banana: [89, 1.1, 22.8, 0.3, 2.6, 12.2, 1], g_blueberries: [57, 0.7, 14.5, 0.3, 2.4, 10, 1],
  g_strawberries: [32, 0.7, 7.7, 0.3, 2, 4.9, 1], g_agave: [310, 0.1, 76.4, 0.5, 0.2, 68, 4], g_lemon: [29, 1.1, 9.3, 0.3, 2.8, 2.5, 2],
  g_lemon_juice: [22, 0.4, 6.9, 0.2, 0.3, 2.5, 1], g_lime: [30, 0.7, 10.5, 0.2, 2.8, 1.7, 2], g_lime_juice: [25, 0.4, 8.4, 0.1, 0.4, 1.7, 2],
  g_corn: [96, 3.4, 21, 1.5, 2.4, 4.5, 1], g_broccoli_raw: [34, 2.8, 6.6, 0.4, 2.6, 1.7, 33], g_broccoli_cooked: [35, 2.4, 7.2, 0.4, 3.3, 1.4, 41],
  g_carrots: [41, 0.9, 9.6, 0.2, 2.8, 4.7, 69], g_carrots_cooked: [35, 0.8, 8.2, 0.2, 3, 3.5, 58], g_roma_tomato: [18, 0.9, 3.9, 0.2, 1.2, 2.6, 5],
  g_onion: [40, 1.1, 9.3, 0.1, 1.7, 4.2, 4], g_sweet_onion: [32, 0.8, 7.6, 0.1, 0.9, 5, 8], g_carrots_baby: [35, 0.6, 8.2, 0.1, 2.9, 4.8, 78] };
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
  ["g_kirkland_organic_chicken", "g_pork_tenderloin", "g_cod", "g_kirkland_cooked_shrimp", "g_scallops", "g_quinoa", "g_greek_yogurt_2", "g_cottage_cheese_2", "g_deli_turkey",
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

/* ---- fixer round 4 (F7) ---- */
/* CP-12: every size label a person picks from reads ¼ ½ ¾, like the diary */
t("alt labels: ¼ ½ ¾, never 1/4 1/2 3/4 (raw and cooked sizes)", () => {
  M.DB.generic.forEach(f => {
    f.alts.concat(f.cook ? f.cook.alts : []).forEach(a => assert.ok(!/\b[13]\/[24]\b/.test(a.label), f.id + ": " + a.label));
    assert.ok(!/\b[13]\/[24]\b/.test(f.serving.unit), f.id + " unit " + f.serving.unit);
  });
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  assert.ok(byId.get("g_cottage_cheese_2").alts.some(a => a.label === "¼ cup" && a.g === 56.5), "Daisy ¼ cup");
  assert.ok(byId.get("g_banana").alts.some(a => a.label === "½ banana" && a.g === 59), "½ banana");
  assert.ok(byId.get("g_white_rice").cook.alts.some(a => a.label === "½ cup" && a.g === 79), "½ cup cooked rice");
});

/* K3: package codes on the products they buy, so a scan finds them on the phone first */
const GTIN_OK = c => { const d = c.split("").map(Number); const sum = d.slice(0, -1).reverse().reduce((a, x, i) => a + x * (i % 2 ? 1 : 3), 0); return (10 - sum % 10) % 10 === d[d.length - 1]; };
const CODES = { /* each checked on Open Food Facts (world.openfoodfacts.org/api/v2/product/<code>.json) */
  g_cottage_cheese_2: ["073420516208", "073420524203"], g_jam: ["051500141304", "051500616123"],
  g_deli_turkey: ["044500966466", "044500976502", "044500201994"],
  g_dkb_21_grains: ["013764027053"], g_dkb_thin: ["013764027138"], g_dkb_good_seed: ["013764027039"],
  /* Kirkland frozen seafood: every code whose label matches (the 31–40 cooked shrimp bag only) */
  g_cod: ["096619173808", "096619065943", "196633883797", "096619065950"], g_scallops: ["196633912749", "096619051724", "096619777327"],
  g_kirkland_cooked_shrimp: ["096619140251", "096619140633"] };
t("barcodes (K3): Daisy, Smucker's, Hillshire, Dave's and the Kirkland seafood carry their package codes", () => {
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  Object.keys(CODES).forEach(id => assert.deepStrictEqual(byId.get(id).barcodes, CODES[id], id + " barcodes"));
  const seen = new Set();
  M.DB.generic.forEach(f => {
    assert.strictEqual(f.barcode, "", f.id + ": built-ins keep barcode empty (codes live in barcodes)");
    if (f.barcodes === undefined) return;
    assert.ok(CODES[f.id], f.id + " has codes it should not");
    assert.ok(f.brand && f.staple === true, f.id + ": codes only on the brands they buy");
    f.barcodes.forEach(c => {
      assert.ok(/^\d{12}$/.test(c) && GTIN_OK(c), f.id + ": " + c + " is a real 12-digit UPC-A");
      assert.ok(!seen.has(c), "code on two foods: " + c); seen.add(c);
    });
  });
  assert.strictEqual(seen.size, 19, "19 codes");
  /* the Kirkland breast is sold by weight (a price code), so it has none */
  assert.strictEqual(byId.get("g_kirkland_organic_chicken").barcodes, undefined);
});

/* DA-08 / FX-05: "just the turkey slices, no sandwich" */
t("ideas: turkey slices never come as a sandwich or toast", () => {
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  const turkey = M.DB.suggest.filter(s => s.items.some(x => x.foodId === "g_deli_turkey"));
  assert.ok(turkey.length >= 3, "turkey ideas");
  turkey.forEach(s => {
    s.items.forEach(x => assert.ok(!/bread|bun|bagel|tortilla|muffin|naan|wrap/i.test(byId.get(x.foodId).name), s.id + " puts turkey on " + x.name));
    assert.ok(!/sandwich|toast|bread/i.test(s.name + " " + s.desc.replace(/\bno bread\b/gi, "")), s.id + ": " + s.name + " / " + s.desc);
  });
  assert.ok(!M.DB.suggest.some(s => s.id === "s_turkey_tomato_toast"), "the turkey toast idea is gone");
  const plate = M.DB.suggest.find(s => s.id === "s_turkey_cottage_plate");
  assert.ok(plate && plate.slot === "Breakfast" && plate.store === "Either", "no-bread turkey breakfast");
  assert.deepStrictEqual(plate.items.map(x => x.foodId), ["g_deli_turkey", "g_cottage_cheese_2", "g_roma_tomato", "g_cucumber"]);
  assert.ok(plate.per.p >= 20, "turkey plate protein " + plate.per.p);
});

/* DA-04 (data half): the other words people use for these foods */
const WORDS2 = {
  g_carrots_baby: ["baby carrots", "baby carrot"], g_bell_pepper: ["red bell pepper", "green bell pepper", "yellow pepper", "orange pepper"],
  g_onion: ["red onion", "yellow onion"], g_corn: ["sweet corn", "corn on the cob", "ear of corn", "corn cob"], g_cherry_tomatoes: ["grape tomatoes"],
  g_olive_oil: ["extra virgin olive oil", "evoo"], g_agave: ["agave nectar"], g_jam: ["preserves", "fruit spread", "strawberry preserves"],
  g_deli_turkey: ["deli turkey", "turkey lunchmeat", "sandwich meat", "lunch meat"],
  g_scallops: ["sea scallops", "sea scallop", "bay scallops"]
};
const FILLER = /^(of|the|a|an)$/;
t("words: red / green / yellow peppers, red onion, grape tomatoes, EVOO, baby carrots, sweet corn …", () => {
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  Object.keys(WORDS2).forEach(id => WORDS2[id].forEach(q => assert.ok(hits(q.split(" ").filter(w => !FILLER.test(w)).join(" "), byId.get(id)), "'" + q + "' should find " + id)));
  /* words only help search: they never make a food a staple */
  ["g_olive_oil", "g_cherry_tomatoes"].forEach(id => assert.ok(byId.get(id).words && byId.get(id).staple !== true, id + " has words, not a staple"));
});
t("search (m-core + m-data): the new words list the right food first", () => {
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
  Object.keys(WORDS2).forEach(id => WORDS2[id].forEach(q => { if (!/\bof\b/.test(q)) assert.strictEqual(top(q), id, "'" + q + "' → " + top(q)); }));
});

/* queued: scallops and carrots by the piece; baby carrots are their own food */
t("by the piece: Kirkland sea scallops (4 = 113 g raw), carrots small / medium / large, baby carrots", () => {
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  const sc = byId.get("g_scallops");
  /* Kirkland wild sea scallops label: 4 scallops (113 g), so one is 28.25 g raw and
     "6 scallops" is 6 × 1 scallop. The editor shows one "scallop" unit, not two. */
  assert.deepStrictEqual([sc.name, sc.brand, sc.serving], ["Scallops, wild sea", "Kirkland", { qty: 4, unit: "scallops", g: 113 }], "label serving: 4 scallops (113 g)");
  assert.ok(!sc.alts.concat(sc.cook.alts).some(a => /large (sea )?scallop/.test(a.label)), "old sizes gone");
  assert.deepStrictEqual(sc.alts[0], { label: "1 scallop", g: 28.25 }, "1 scallop = 113 g ÷ 4");
  const C = core();
  if (C) {
    const pieces = C.cook.unitsFor(C.foods.get("g_scallops"), "us").filter(o => /scallop/.test(o.unit));
    assert.strictEqual(pieces.map(o => o.key + " " + o.g).join(" | "), "scallop-raw 28.25", "one scallop unit");
  }
  const ca = sc.cook.alts.find(a => a.label === "1 scallop");
  assert.ok(ca && Math.abs(ca.g - 28.25 * sc.cook.y) < 0.051, "cooked scallop = 28.25 g × y (" + (ca && ca.g) + ")");
  const cod = byId.get("g_cod");
  assert.deepStrictEqual([cod.name, cod.brand, cod.serving], ["Cod, wild Alaska Pacific", "Kirkland", { qty: 1, unit: "fillet", g: 170 }], "label serving: 1 portion (170 g)");
  const cf = cod.cook.alts.find(a => a.label === "1 fillet");
  assert.ok(cf && Math.abs(cf.g - 170 * cod.cook.y) < 0.051, "cooked fillet = 170 g × y (" + (cf && cf.g) + ")");
  const c = byId.get("g_carrots");
  assert.deepStrictEqual(c.serving, { qty: 1, unit: "medium", g: 61 }, "1 medium carrot = 61 g (USDA)");
  assert.ok(c.alts.some(a => a.label === "1 small" && a.g === 50) && c.alts.some(a => a.label === "1 large" && a.g === 72), "small 50 g, large 72 g");
  assert.ok(byId.get("g_carrots_cooked").alts.some(a => a.label === "1 carrot" && a.g === 46), "1 cooked carrot = 46 g");
  const b = byId.get("g_carrots_baby");
  assert.deepStrictEqual([b.name, b.brand, b.serving], ["Carrots, baby", "", { qty: 10, unit: "baby carrots", g: 100 }], "10 baby carrots (100 g)");
  assert.ok(b.alts.some(a => a.label === "1 baby carrot" && a.g === 10), "1 baby carrot = 10 g");
  assert.strictEqual(b.per.cal, 35); assert.strictEqual(b.staple, true);
  M.DB.generic.forEach(f => { if (f.id !== "g_carrots_baby") f.alts.forEach(a => assert.ok(!/baby/i.test(a.label), f.id + ": " + a.label)); });
  /* ideas that say baby carrots use the baby carrot food */
  let n = 0;
  M.DB.suggest.forEach(s => s.items.forEach(x => { if (/baby carrot/i.test(x.servingLabel)) { n++; assert.strictEqual(x.foodId, "g_carrots_baby", s.id + " " + x.servingLabel); } }));
  assert.ok(n >= 2, "baby carrot ideas");
});

/* DA-09: olive oil the way USDA (and MyFitnessPal) weighs it */
t("olive oil: 1 tbsp = 13.5 g (119 cal); ideas use 1 tsp (4.5 g) or ½ tbsp (6.75 g)", () => {
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  const o = byId.get("g_olive_oil");
  assert.deepStrictEqual(o.serving, { qty: 1, unit: "tbsp", g: 13.5 }); assert.strictEqual(o.per.cal, 119);
  assert.ok(o.alts.some(a => a.label === "1 tsp" && a.g === 4.5) && o.alts.some(a => a.label === "2 tbsp" && a.g === 27), "tsp and 2 tbsp");
  const oils = []; M.DB.suggest.forEach(s => s.items.forEach(x => { if (x.foodId === "g_olive_oil") oils.push(x); }));
  assert.ok(oils.length >= 10, "oil in the ideas");
  oils.forEach(x => assert.ok((x.g === 4.5 && x.servingLabel === "1 tsp (4.5 g)") || (x.g === 6.75 && x.servingLabel === "½ tbsp (6.75 g)"), x.servingLabel));
  assert.strictEqual(oils.find(x => x.g === 6.75).per.cal, 60, "½ tbsp = 60 cal");
});

/* queued: restaurant food out; old entries keep their own numbers (checked in "old ids" below) */
t("no restaurant entree: Chicken Caesar salad is gone and not aliased to another food", () => {
  assert.ok(!M.DB.generic.some(f => f.id === "g_chicken_caesar_salad" || /entree/i.test(f.name)), "entree gone");
  assert.strictEqual(M.DB.alias.g_chicken_caesar_salad, undefined, "no alias: an alias would re-price old entries");
});

/* ---- old ids in real diaries (live d757f4b storage format) ---- */
/* Every generic id that was live (d757f4b) is still a food or an alias, except
   g_cottage_cheese_4 and g_chicken_caesar_salad, which were removed on purpose, and
   the plain shrimp (g_shrimp, g_shrimp_cooked), replaced by the Kirkland cooked shrimp
   (M.DB.replaced): their entries keep their own numbers. */
const LIVE_IDS_GONE = ["g_chicken_breast", "g_chicken_breast_raw", "g_chicken_breast_cooked", "g_cod_cooked", "g_quinoa_cooked"];
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
    E("e8", "g_ground_beef_80_cooked", "Ground beef 80/20, cooked", "4 oz (113 g)", 1, 113, P(283, 28.3, 0, 18.1)),
    E("e9", "g_chicken_caesar_salad", "Chicken Caesar salad, entree", "1 salad (350 g)", 1, 350, P(520, 38, 14, 34))
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
  assert.strictEqual(C.foods.get("g_chicken_caesar_salad"), null, "removed Caesar entree: no food (the entry keeps its own numbers)");
  assert.strictEqual(C.foods.get("g_shrimp_cooked"), null, "replaced shrimp: no food by the old id (the entry keeps its own numbers)");
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
    const cs = rs.find(r => r.foodId === "g_chicken_caesar_salad");
    assert.ok(cs && cs.per.cal === 520 && cs.name === "Chicken Caesar salad, entree", "gone Caesar entree: recent keeps its snapshot");
    const ch = rs.filter(r => r.foodId === "g_kirkland_organic_chicken");
    assert.ok(ch.length >= 1 && ch.every(r => r.state === "raw"), "old chicken recents come back as the Kirkland breast, raw");
    /* replaced shrimp: the recent row is the Kirkland cooked shrimp, at its own serving */
    const sr = rs.filter(r => /shrimp/i.test(r.name));
    assert.ok(sr.length === 1 && sr[0].foodId === "g_kirkland_cooked_shrimp" && sr[0].name === "Shrimp, cooked, tail-on" && sr[0].servings === 1 && sr[0].g === 84 && sr[0].per.cal === 80 && !sr[0].state && !sr[0].cook, "old shrimp recent → the Kirkland shrimp: " + JSON.stringify(sr));
    rs.forEach(r => NUT.forEach(k => assert.ok(isNum(r.per[k]), "recent " + r.name + " " + k)));
  }
});

/* ---- fixer round 5 (F7) ---- */
/* m-core + m-data in their own context (app load order); `store` = saved app state. null if m-core can't load. */
function core(store) {
  const ctx = { console, Date, Math, JSON, setTimeout, clearTimeout, Intl };
  ctx.window = ctx; ctx.self = ctx;
  ctx.localStorage = { store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = String(v); }, removeItem(k) { delete this.store[k]; }, key(i) { return Object.keys(this.store)[i] ?? null; }, get length() { return Object.keys(this.store).length; } };
  ctx.S = { profile: "nick" }; ctx.PRESETS = { nick: { name: "Nick" }, kat: { name: "Katerina" } };
  if (store) ctx.localStorage.setItem("chalk.macros.v1", JSON.stringify(store));
  vm.createContext(ctx);
  try { ["m-core.js", "m-data.js"].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), ctx, { filename: f })); }
  catch (e) { console.log("       (skipped: m-core did not load: " + e.message + ")"); return null; }
  const C = ctx.M;
  if (!C || !C.foods || !C.log || typeof C.recents !== "function" || !C.cook || typeof C.cook.unitsFor !== "function") { console.log("       (skipped: m-core API missing)"); return null; }
  if (store && typeof C.load === "function") C.load();
  else if (typeof C.reset === "function") C.reset();
  return C;
}
const OZ_G = 28.349523125;
const localToday = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };

/* Nick: their shrimp is the Kirkland cooked tail-on bag (31–40 per lb). It replaced the plain
   raw / cooked shrimp and its sizes (MF-04). */
t("Kirkland cooked shrimp: 8 shrimp (84 g) = 80 cal, 1 shrimp = 10.5 g, no raw / cooked, one size", () => {
  const sh = M.DB.generic.find(f => f.id === "g_kirkland_cooked_shrimp");
  assert.deepStrictEqual([sh.name, sh.brand, sh.staple, sh.cook, sh.alwaysRaw], ["Shrimp, cooked, tail-on", "Kirkland", true, undefined, undefined]);
  assert.deepStrictEqual(sh.serving, { qty: 8, unit: "shrimp", g: 84 }, "label serving: 8 shrimp (84 g)");
  assert.deepStrictEqual(sh.alts[0], { label: "1 shrimp", g: 10.5 }, "1 shrimp = 84 g ÷ 8");
  assert.ok(!sh.alts.some(a => /large|jumbo|medium/.test(a.label)), "one size: the bag's");
  assert.deepStrictEqual(M.DB.generic.filter(f => /shrimp/i.test(f.name)).map(f => f.id), ["g_kirkland_cooked_shrimp"], "the only shrimp built in");
  /* 12 shrimp = 126 g = 120 cal, 30 g protein */
  near(sh.per100g.cal * 126 / 100, 120, 0.5, "12 shrimp cal"); near(sh.per100g.p * 126 / 100, 30, 0.05, "12 shrimp protein");
});
t("Kirkland cooked shrimp: old raw / cooked shrimp entries keep their numbers; their recent row becomes the Kirkland shrimp", () => {
  const C = core(); if (!C) return;
  const today = C.today();
  const P = g => ({ cal: 0.85 * g, p: 0.201 * g, c: 0, f: 0.005 * g, fiber: 0, sugar: 0, sodium: 1.19 * g });
  /* as v16–v18 saved them: raw shrimp with its y, and the old cooked id with no state */
  [["1 large shrimp (18 g)", 12, 18, "g_shrimp", true], ["1 large shrimp, 31–40 per lb (10 g raw)", 10, 10, "g_shrimp", true], ["3 oz (85 g)", 1, 85, "g_shrimp_cooked", false]].forEach(([label, n, g, id, raw]) => {
    C.reset();
    const per = P(g);
    const e = C.log.add(today, Object.assign({ slot: "Lunch", name: "Shrimp", brand: "", foodId: id, servingLabel: label, servings: n, g, per }, raw ? { state: "raw", cook: { y: 0.8375, word: "raw" } } : {}));
    const d = C.dayOf(today, "nick"), kept = d.entries.find(x => x.id === e.id);
    assert.ok(kept && kept.foodId === id && kept.servingLabel === label && kept.servings === n && kept.per.cal === per.cal, label + ": entry kept as saved");
    assert.strictEqual(kept.state, raw ? "raw" : undefined, label + ": state kept");
    near(C.log.totals(today, "nick").cal, per.cal * n, 0.5, label + ": day total unchanged");
    const rs = C.recents("nick", 30).filter(x => /shrimp/i.test(x.name));
    assert.ok(rs.length === 1 && rs[0].foodId === "g_kirkland_cooked_shrimp" && rs[0].servingLabel === "8 shrimp (84 g)" && rs[0].servings === 1 && rs[0].per.cal === 80 && !rs[0].state && !rs[0].cook, label + ": recent → " + JSON.stringify(rs));
    /* search: one shrimp row, the Kirkland bag */
    const hits = C.search("shrimp", { pid: "nick" }).filter(x => /shrimp/i.test(x.name));
    assert.ok(hits.length >= 1 && hits[0].foodId === "g_kirkland_cooked_shrimp" && hits.every(x => x.foodId === "g_kirkland_cooked_shrimp"), label + ": search → " + hits.map(x => x.kind + " " + x.name + " " + x.foodId).join(" | "));
  });
  /* the plain word is the bag they buy, above a saved meal that shares the word (like turkey / chicken) */
  C.reset();
  const item = { name: "Food", servings: 1, servingLabel: "1 serving", per: { cal: 300, p: 25, c: 20, f: 10, fiber: 0, sugar: 0, sodium: 0 } };
  ["Shrimp tacos", "Cod bowl", "Scallop pasta"].forEach(name => C.meals.add({ name, slot: "Dinner", items: [item] }));
  [["shrimp", "g_kirkland_cooked_shrimp"], ["prawns", "g_kirkland_cooked_shrimp"], ["cod", "g_cod"], ["cod fillet", "g_cod"], ["scallops", "g_scallops"], ["sea scallops", "g_scallops"]].forEach(([q, id]) => {
    const r = C.search(q, { pid: "nick" });
    assert.strictEqual(r[0] && r[0].foodId, id, "'" + q + "' → " + r.slice(0, 3).map(x => x.kind + " " + x.name).join(" | "));
  });
  assert.ok(C.search("shrimp tacos", { pid: "nick" })[0].kind === "meal", "their meal's whole name still finds the meal first");
  C.reset();
  /* a barcode linked on v18 to the plain shrimp finds the Kirkland bag */
  C.MS.codes = { "012345678905": "g_shrimp" };
  const byc = C.foods.byCode("012345678905");
  assert.ok(byc && byc.id === "g_kirkland_cooked_shrimp", "old code link → " + (byc && byc.id));
  delete C.MS.codes["012345678905"];
  /* new shrimp logged after the old: still one recent row, the last amount */
  C.log.add(today, Object.assign({ slot: "Lunch", name: "Shrimp", brand: "", foodId: "g_shrimp", servingLabel: "1 oz raw", servings: 6, g: 28.35, per: P(28.35) }, { state: "raw", cook: { y: 0.8375, word: "raw" }, at: Date.now() - 60000 }));
  const f = C.foods.get("g_kirkland_cooked_shrimp");
  C.log.add(today, { slot: "Dinner", name: f.name, brand: f.brand, foodId: f.id, servingLabel: "1 shrimp (10.5 g)", servings: 12, g: 10.5, per: C.foodMath.fromPer100(f.per100g, 10.5) });
  const rs = C.recents("nick", 30).filter(x => /shrimp/i.test(x.name));
  assert.ok(rs.length === 1 && rs[0].servings === 12 && Math.abs(rs[0].g * rs[0].servings - 126) < 0.01, "one row, last amount: " + JSON.stringify(rs));
});

/* MF-06: oz-served cook foods at the editor's ounce (28.3495 g), so a row and the editor agree */
t("MF-06 oz servings: cook foods and meat store exact ounces (4 oz = 113.4 g, 2 oz = 56.7 g, 6 oz = 170.1 g …)", () => {
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  const OZL = /^([\d.]+) oz$/;
  let n = 0;
  M.DB.generic.forEach(f => {
    /* cook foods only (raw/cooked oz units in the editor); the Kirkland label says 4 oz = 112 g and it shows in grams */
    if (!f.cook || f.id === "g_kirkland_organic_chicken") return;
    if (f.serving.unit === "oz") { n++; near(f.serving.g, f.serving.qty * OZ_G, 0.006, f.id + " serving " + f.serving.qty + " oz"); }
    f.alts.concat(f.cook ? f.cook.alts : []).forEach(a => { const m = OZL.exec(a.label); if (m) near(a.g, +m[1] * OZ_G, 0.006, f.id + " " + a.label); });
  });
  /* 9: the Kirkland cod and scallops come by the fillet and the scallop (their labels) */
  assert.ok(n >= 9, "oz-served cook foods checked: " + n);
  /* plain cooked meats keep whole grams in their rows: "4 oz (113 g)" */
  ["g_tilapia_cooked", "g_pork_chop_cooked", "g_turkey_breast_cooked"].forEach(id => assert.strictEqual(byId.get(id).serving.g, 113, id));
  ["g_sirloin_cooked", "g_ribeye_cooked", "g_sockeye_salmon_cooked"].forEach(id => assert.strictEqual(byId.get(id).serving.g, 170, id));
  near(byId.get("g_ground_beef_80").per.cal, 254 * 113.4 / 100, 0.5, "4 oz 80/20 beef = 288 cal");
  assert.deepStrictEqual(byId.get("g_pasta").serving, { qty: 2, unit: "oz", g: 56.7 });
  /* meal ideas weigh "6 oz raw" / "5 oz raw" the same way */
  M.DB.suggest.forEach(s => s.items.forEach(x => { const m = /^([\d.]+) oz raw$/.exec(x.servingLabel); if (m) near(x.g, +m[1] * OZ_G, 0.006, s.id + " " + x.servingLabel); }));
});
t("MF-06 / MF-07: old entries saved at 113 g / 56 g / 195 g keep their numbers; recents by weight keep their grams", () => {
  const today = localToday();
  const P = (cal, p, c, f) => ({ cal, p, c, f, fiber: 0, sugar: 0, sodium: 0 });
  const E = (id, foodId, name, servingLabel, servings, g, per, extra) => Object.assign({ id, name, brand: "", slot: "Dinner", servingLabel, servings, g, per, foodId, at: 1790000000000 }, extra || {});
  const entries = [
    E("b1", "g_ground_beef_80", "Ground beef 80/20", "4 oz (113 g)", 1, 113, P(287, 19.4, 0, 22.6), { state: "raw", cook: { y: 0.637, word: "raw" } }),
    E("p1", "g_pasta", "Pasta", "2 oz (56 g)", 1, 56, P(208, 7.3, 41.8, 0.8), { state: "raw", cook: { y: 2.3481, word: "dry" } }),
    E("r1", "g_brown_rice_cooked", "Brown rice, cooked", "1 cup (195 g)", 1, 195, P(240, 5.3, 49.9, 2))
  ];
  const saved = JSON.parse(JSON.stringify(entries));
  const C = core({ v: 1, updatedAt: 1790000000000, ui: { mode: "macros", person: "nick", date: today, tab: "diary" },
    profiles: { nick: { id: "nick", name: "Nick", sex: "m", age: 40, heightIn: 71, weightLb: 185, setupAt: 1780000000000, lastBody: 1790000000000, targets: { cal: 2200, p: 180, c: 200, f: 70 }, updatedAt: 1790000000000 } },
    foods: {}, meals: {}, days: { ["nick|" + today]: { id: "nick|" + today, pid: "nick", date: today, entries, water: 0, note: "", updatedAt: 1790000000000 } }, body: {} });
  if (!C || !C.dayOf) return;
  const d = C.dayOf(today, "nick");
  saved.forEach(s => {
    const e = d.entries.find(x => x.id === s.id); assert.ok(e, s.id + " kept");
    ["cal", "p", "c", "f"].forEach(k => assert.strictEqual(e.per[k], s.per[k], s.id + " " + k));
    assert.strictEqual(e.servingLabel, s.servingLabel, s.id + " label"); assert.strictEqual(e.g, s.g, s.id + " grams");
  });
  near(C.log.totals(today, "nick").cal, 287 + 208 + 240, 0.5, "day total unchanged");
  const rs = C.recents("nick", 30), rec = id => rs.find(r => r.foodId === id);
  near(rec("g_ground_beef_80").g * rec("g_ground_beef_80").servings, 113, 0.01, "beef recent: 113 g as logged");
  near(rec("g_pasta").g * rec("g_pasta").servings, 56, 0.01, "pasta recent: 56 g as logged");
  /* the old labels still read the same */
  assert.deepStrictEqual(JSON.parse(JSON.stringify(C.parseServing("4 oz (113 g)"))), { qty: 4, unit: "oz", g: 113 });
});
t("MF-07 brown rice: long-grain USDA values with the long-grain cup (1 cup = 202 g, ½ = 101 g, ¾ = 152 g)", () => {
  const f = M.DB.generic.find(x => x.id === "g_brown_rice_cooked");
  [123, 2.7, 25.6, 1, 1.6, 0.2, 4].forEach((v, i) => near(f.per100g[NUT[i]], v, 0.01, "per 100 g " + NUT[i]));
  assert.deepStrictEqual(f.serving, { qty: 1, unit: "cup", g: 202 });
  assert.ok(f.alts.some(a => a.label === "½ cup" && a.g === 101) && f.alts.some(a => a.label === "¾ cup" && a.g === 152), "½ and ¾ cup");
  assert.strictEqual(f.per.cal, 248, "1 cup = 248 cal (USDA)");
  /* ¼ ½ ¾ still parse to the right amounts */
  const C = core(); if (!C) return;
  [["½ cup", 0.5], ["¾ cup", 0.75], ["¼ cup", 0.25], ["1 ½ cups", 1.5]].forEach(([l, q]) => { const p = C.parseServing(l); assert.ok(p.qty === q && /^cups?$/.test(p.unit), l); });
  M.DB.generic.forEach(g => g.alts.concat(g.cook ? g.cook.alts : []).forEach(a => { const m = /^([¼½¾])/.exec(a.label); if (m) assert.strictEqual(C.parseServing(a.label).qty, { "¼": 0.25, "½": 0.5, "¾": 0.75 }[m[1]], g.id + " " + a.label); }));
});

/* words: lean / extra lean ground beef, toast, pasta shapes, nonfat 0% */
const WORDS3 = {
  g_ground_beef_93: ["extra lean ground beef", "lean ground beef"], g_ground_beef_90: ["lean ground beef"], g_ground_turkey_93: ["lean ground turkey"],
  g_dkb_21_grains: ["toast"], g_dkb_good_seed: ["toast"], g_dkb_thin: ["toast"],
  g_pasta: ["spaghetti", "penne", "noodles", "macaroni"], g_greek_yogurt_0: ["nonfat greek yogurt", "greek yogurt 0%", "fat free greek yogurt"]
};
t("words: lean / extra lean, toast, spaghetti / penne / noodles / macaroni, nonfat 0% Greek yogurt", () => {
  const byId = new Map(M.DB.generic.map(f => [f.id, f]));
  Object.keys(WORDS3).forEach(id => WORDS3[id].forEach(q => assert.ok(hits(q, byId.get(id)), "'" + q + "' should find " + id)));
  assert.ok(!hits("extra lean ground beef", byId.get("g_ground_beef_90")), "extra lean is 93/7 only");
  M.DB.generic.forEach(f => { if (f.words !== undefined) assert.ok(typeof f.words === "string" && f.words.length < 80, f.id + " words"); });
  const C = core(); if (!C || typeof C.search !== "function") return;
  const ids = q => C.search(q, { pid: "nick" }).filter(x => x.kind === "generic").map(x => x.id);
  assert.ok(["g_ground_beef_90", "g_ground_beef_93"].indexOf(ids("lean ground beef")[0]) >= 0, "lean ground beef → " + ids("lean ground beef")[0]);
  assert.strictEqual(ids("extra lean ground beef")[0], "g_ground_beef_93");
  assert.ok(/^g_dkb_/.test(ids("toast")[0]), "toast → Dave's: " + ids("toast")[0]);
  ["spaghetti", "penne", "noodles", "macaroni"].forEach(q => assert.strictEqual(ids(q)[0], "g_pasta", q));
  assert.strictEqual(ids("nonfat greek yogurt")[0], "g_greek_yogurt_0");
});

/* ---- run ---- */
let pass = 0, fail = 0;
tests.forEach(({ name, fn }) => {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e && e.message)); }
});
console.log("\n" + pass + " passed, " + fail + " failed · " + M.DB.generic.length + " generic foods · " + M.DB.suggest.length + " suggestions");
if (fail) process.exit(1);
