window.M = window.M || {}; M.DB = M.DB || {};
/* ============================================================================
   Chalk · Macros — built-in data
   M.DB.generic : plain basics (USDA values) plus the staples Nick and
                  Katerina actually buy. Everything else they eat gets saved
                  the first time they scan its barcode or label. Meat, fish,
                  rice and pasta are ONE food each with a raw (or dry) profile
                  and a cooked profile (`cook`, see CK below).
   M.DB.alias   : old raw/cooked ids → { id of the merged food, state }.
   M.DB.suggest : a small set of high-protein meal ideas built from the foods
                  they buy (`staple`). Their own saved meals rank above these.
                  Two tiny builders keep `per`/`per100g` consistent and sum
                  suggestion macros exactly.
   ========================================================================== */
(function (M) {
  "use strict";

  const NUT = ["cal", "p", "c", "f", "fiber", "sugar", "sodium"];
  const r1 = v => Math.round(v * 10 + 1e-9) / 10;
  const r0 = v => Math.round(v + 1e-9);
  const rnd = (k, v) => (k === "cal" || k === "sodium" ? r0(v) : r1(v));
  const per = a => ({ cal: a[0], p: a[1], c: a[2], f: a[3], fiber: a[4], sugar: a[5], sodium: a[6] });
  const scale = (o, k) => { const r = {}; NUT.forEach(n => { r[n] = rnd(n, o[n] * k); }); return r; };
  function alts(list) {
    const out = [];
    for (let i = 0; i + 1 < (list || []).length; i += 2) out.push({ label: list[i], g: list[i + 1] });
    return out;
  }
  function food(slug, name, brand, qty, unit, g, p, p100, altList, extra) {
    return Object.assign({
      id: "g_" + slug, name, brand: brand || "", barcode: "", source: "generic",
      serving: { qty, unit, g: g || null }, per: p, per100g: p100, alts: alts(altList),
      uses: 0, lastUsed: 0, createdAt: 0, updatedAt: 0, pid: null
    }, extra || {});
  }
  /* W: values given PER 100 g; per-serving is derived from the gram weight. */
  function W(slug, name, brand, qty, unit, g, v100, altList, extra) {
    const p100 = per(v100);
    return food(slug, name, brand, qty, unit, g, scale(p100, g / 100), p100, altList, extra);
  }
  /* L: values given PER SERVING (label); per 100 g derived when grams known. */
  function L(slug, name, brand, qty, unit, g, v, altList, extra) {
    const p = per(v);
    return food(slug, name, brand, qty, unit, g, p, g > 0 ? scale(p, 100 / g) : null, altList, extra);
  }
  /* CK: a food that changes weight when cooked, built from the raw/cooked pair
     this file already had. serving / per / per100g / alts are the RAW (or dry)
     state; cook.per100gCooked is the cooked profile; cook.y = cooked grams per
     raw gram (meat and fish: raw protein ÷ cooked protein per 100 g; rice and
     pasta: dry kcal ÷ cooked kcal per 100 g). cook.alts are cooked-state
     portions (e.g. "1 cup" of cooked rice = 158 g). */
  const r4 = v => Math.round(v * 1e4) / 1e4;
  /* `cooked` is USDA's own cooked profile (per 100 g), or y itself.
     - A USDA pair keeps USDA's cooked numbers, the ones MyFitnessPal shows: fat
       melts off when meat cooks, so cooked 80/20 beef is 272 kcal per 100 g, not
       raw ÷ y. y still comes from the pair (protein, or kcal for dry grains), so
       "raw (cooked)" weights stay right.
     - A label food with no published cooked numbers (the Kirkland breast) gets
       y itself, and its cooked profile is raw ÷ y.
     `extra` adds flags such as staple (a food they buy) or alwaysRaw (grams
     typed are raw grams). */
  function CK(slug, name, brand, qty, unit, g, raw100, cooked, altList, word, cookedAlts, extra) {
    const rp = per(raw100), cp = typeof cooked === "number" ? null : per(cooked);
    const y = cp ? r4(word === "dry" ? rp.cal / cp.cal : rp.p / cp.p) : cooked;
    const c100 = {}; NUT.forEach(k => { c100[k] = rnd(k, cp ? cp[k] : rp[k] / y); });
    return W(slug, name, brand, qty, unit, g, raw100, altList, Object.assign({ cook: { y, word: word === "dry" ? "dry" : "raw", per100gCooked: c100, alts: alts(cookedAlts || []) } }, extra || {}));
  }
  /* staple: a food Nick and Katerina actually buy (search and meal ideas favor
     these). words: other words people use for it, for search only. */
  const ST = { staple: true };
  const STW = words => ({ staple: true, words });
  /* a package label (values per `g` grams) → per 100 g, to 0.01 */
  const lab = (v, g) => v.map(x => Math.round(x * 100 / g * 100) / 100);
  const OZ = ["1 oz", 28, "100 g", 100];
  const MEAT = ["1 oz", 28, "3 oz", 85, "6 oz", 170, "8 oz", 227, "100 g", 100];
  /* Chicken breast cook yield from USDA (raw 22.5 g protein per 100 g, roasted
     31 g): 1 g raw → 0.7258 g cooked, so 175 g raw ≈ 127 g cooked. */
  const CHICKEN_Y = r4(22.5 / 31);
  /* Kirkland Signature organic chicken breast label: 4 oz (112 g) = 110 kcal,
     24 g protein, 0 g carbs, 1 g fat, 75 mg sodium. */
  const KIRKLAND_RAW = lab([110, 24, 0, 1, 0, 0, 75], 112);

  const G = [];
  /* ------------------------------------------------------------ PROTEINS */
  G.push(
    /* Nick: chicken breast is always Kirkland organic, about 175 g raw each, and
       the grams they type are raw grams. One food; old ids alias here. */
    CK("kirkland_organic_chicken", "Chicken breast, organic", "Kirkland", 1, "breast", 175, KIRKLAND_RAW, CHICKEN_Y, ["1/2 breast", 88, "1 oz", 28, "4 oz", 112, "6 oz", 170, "100 g", 100], "raw", [], { staple: true, alwaysRaw: true }),
    CK("chicken_thigh", "Chicken thigh, boneless skinless", "", 4, "oz", 113, [121, 19.7, 0, 4.1, 0, 0, 95], [179, 24.8, 0, 8.2, 0, 0, 106], MEAT, "raw"),
    /* USDA: ground beef raw / crumbles, pan-browned; ground turkey raw / pan-broiled crumbles */
    CK("ground_beef_80", "Ground beef 80/20", "", 4, "oz", 113, [254, 17.2, 0, 20, 0, 0, 66], [272, 27, 0, 17.4, 0, 0, 91], MEAT, "raw"),
    CK("ground_beef_85", "Ground beef 85/15", "", 4, "oz", 113, [215, 18.6, 0, 15, 0, 0, 66], [256, 27.7, 0, 15.3, 0, 0, 89], MEAT, "raw"),
    CK("ground_beef_90", "Ground beef 90/10", "", 4, "oz", 113, [176, 20, 0, 10, 0, 0, 66], [230, 28.5, 0, 12, 0, 0, 87], MEAT, "raw"),
    CK("ground_beef_93", "Ground beef 93/7", "", 4, "oz", 113, [152, 20.9, 0, 7, 0, 0, 66], [209, 28.9, 0, 9.5, 0, 0, 86], MEAT, "raw"),
    W("sirloin_cooked", "Sirloin steak, cooked (trimmed)", "", 6, "oz", 170, [206, 29.5, 0, 9, 0, 0, 60], MEAT),
    W("ribeye_cooked", "Ribeye steak, cooked", "", 6, "oz", 170, [291, 24, 0, 21, 0, 0, 55], MEAT),
    W("pork_chop_cooked", "Pork chop, boneless, cooked", "", 4, "oz", 113, [197, 27.8, 0, 8.9, 0, 0, 58], MEAT),
    CK("pork_tenderloin", "Pork tenderloin", "", 4, "oz", 113, [109, 21, 0, 2.2, 0, 0, 53], [143, 26.2, 0, 3.5, 0, 0, 57], MEAT, "raw", [], ST),
    W("bacon_cooked", "Bacon, cooked", "", 2, "slices", 16, [541, 37, 1.4, 42, 0, 0, 1900], ["1 slice", 8, "3 slices", 24, "1 oz", 28, "100 g", 100]),
    L("turkey_bacon", "Turkey bacon, cooked", "", 2, "slices", 30, [60, 5, 1, 4.5, 0, 0, 340], ["1 slice", 15, "100 g", 100]),
    L("pork_sausage_links", "Breakfast sausage links, pork, cooked", "", 3, "links", 64, [180, 9, 1, 15, 0, 0, 470], ["1 link", 21, "2 links", 43, "100 g", 100]),
    L("chicken_sausage", "Chicken sausage link, cooked", "", 1, "link", 85, [170, 13, 4, 11, 0, 3, 560], ["1/2 link", 43, "100 g", 100]),
    L("hot_dog", "Hot dog, beef (no bun)", "", 1, "frank", 45, [150, 5, 2, 13, 0, 1, 500], ["100 g", 100]),
    W("turkey_breast_cooked", "Turkey breast, roasted, no skin", "", 4, "oz", 113, [145, 30, 0, 2.1, 0, 0, 99], MEAT),
    CK("ground_turkey_93", "Ground turkey 93/7", "", 4, "oz", 113, [150, 18.7, 0, 8.3, 0, 0, 69], [213, 27.1, 0, 11.6, 0, 0, 90], MEAT, "raw"),
    /* Hillshire Farm Ultra Thin oven roasted turkey breast label: 2 oz (56 g,
       about 6 slices) = 60 kcal, 10 g protein, 2 g carbs, 1.5 g fat, 490 mg sodium. */
    L("deli_turkey", "Turkey slices, oven roasted", "Hillshire Farm", 6, "slices", 56, [60, 10, 2, 1.5, 0, 0, 490], ["1 slice", 9.3, "3 slices", 28, "2 oz", 56, "100 g", 100], STW("sliced deli lunch meat lunchmeat sandwich meat thin")),
    L("deli_ham", "Deli ham, sliced", "", 2, "oz", 56, [60, 10, 2, 1.5, 0, 1, 520], ["1 slice", 28, "3 oz", 85, "100 g", 100]),
    CK("salmon", "Salmon, Atlantic", "", 4, "oz", 113, [208, 20.4, 0, 13.4, 0, 0, 59], [206, 22.1, 0, 12.4, 0, 0, 61], MEAT, "raw"),
    W("sockeye_salmon_cooked", "Salmon, wild sockeye, cooked", "", 6, "oz", 170, [156, 26.5, 0, 5.6, 0, 0, 78], MEAT),
    W("tilapia_cooked", "Tilapia, cooked", "", 4, "oz", 113, [128, 26.2, 0, 2.7, 0, 0, 56], MEAT),
    /* USDA: cod, Atlantic, raw / cooked dry heat */
    CK("cod", "Cod", "", 4, "oz", 113, [82, 17.8, 0, 0.7, 0, 0, 54], [105, 22.8, 0, 0.9, 0, 0, 78], MEAT, "raw", [], ST),
    W("tuna_canned_water", "Tuna, canned in water, drained", "", 1, "can (4 oz drained)", 113, [116, 25.5, 0, 0.8, 0, 0, 320], ["1/2 can", 56, "1 oz", 28, "100 g", 100]),
    /* USDA: shrimp, raw / cooked; one large shrimp 15 g cooked, one medium 10 g
       cooked (FNDDS), so about 18 g and 12 g raw */
    CK("shrimp", "Shrimp", "", 4, "oz", 113, [85, 20.1, 0, 0.5, 0, 0, 119], [99, 24, 0.2, 0.3, 0, 0, 111], ["1 large shrimp", 18, "1 medium shrimp", 12, "1 oz", 28, "3 oz", 85, "6 oz", 170, "8 oz", 227, "100 g", 100], "raw", ["1 large shrimp", 15, "1 medium shrimp", 10, "3 oz", 85, "100 g", 100], ST),
    /* USDA: scallops, raw / steamed */
    CK("scallops", "Scallops", "", 4, "oz", 113, [69, 12.1, 3.2, 0.5, 0, 0, 392], [111, 20.5, 5.4, 0.8, 0, 0, 667], MEAT, "raw", [], ST),
    W("egg_large", "Eggs, whole", "", 1, "large egg", 50, [143, 12.6, 0.7, 9.5, 0, 0.4, 142], ["2 eggs", 100, "3 eggs", 150, "100 g", 100]),
    W("egg_hard_boiled", "Egg, hard-boiled", "", 1, "large egg", 50, [155, 12.6, 1.1, 10.6, 0, 1.1, 124], ["2 eggs", 100, "100 g", 100]),
    W("egg_white", "Egg white, large", "", 1, "large egg white", 33, [52, 10.9, 0.7, 0.2, 0, 0.7, 166], ["2 whites", 66, "3 whites", 99, "100 g", 100]),
    L("egg_whites_carton", "Egg whites, liquid carton", "", 3, "tbsp", 46, [25, 5, 0, 0, 0, 0, 75], ["1/2 cup", 122, "1 cup", 243, "100 g", 100]),
    W("greek_yogurt_0", "Greek yogurt, plain nonfat", "", 1, "cup", 227, [59, 10.2, 3.6, 0.4, 0, 3.2, 36], ["1/2 cup", 113, "3/4 cup", 170, "100 g", 100]),
    /* USDA: yogurt, Greek, plain, lowfat (2%) */
    W("greek_yogurt_2", "Greek yogurt, plain 2%", "", 1, "container (6 oz)", 170, [73, 9.9, 3.9, 1.9, 0, 3.6, 34], ["1/2 cup", 113, "3/4 cup", 170, "1 cup", 227, "100 g", 100], ST),
    W("greek_yogurt_5", "Greek yogurt, plain 5% (whole milk)", "", 1, "container (6 oz)", 170, [97, 9, 4, 5, 0, 4, 35], ["1/2 cup", 113, "1 cup", 227, "100 g", 100]),
    /* Daisy 2% (low fat) cottage cheese label: 1/2 cup (113 g) = 90 kcal, 13 g
       protein, 5 g carbs (4 g sugar), 2.5 g fat, 350 mg sodium. The only cottage
       cheese they eat. */
    L("cottage_cheese_2", "Cottage cheese, 2%", "Daisy", 0.5, "cup", 113, [90, 13, 5, 2.5, 0, 4, 350], ["1/4 cup", 56.5, "3/4 cup", 170, "1 cup", 226, "100 g", 100], ST),
    L("whey_protein", "Whey protein powder", "", 1, "scoop", 31, [120, 24, 3, 1.5, 0, 1, 60], ["1/2 scoop", 15.5, "2 scoops", 62, "100 g", 100]),
    W("tofu_firm", "Tofu, firm", "", 3, "oz", 85, [105, 10.5, 2.5, 6, 1, 0.5, 15], ["1/2 block", 170, "1 oz", 28, "100 g", 100]),
    W("tempeh", "Tempeh", "", 3, "oz", 85, [192, 20, 8, 11, 5, 0, 9], ["1/2 package", 113, "1 oz", 28, "100 g", 100]),
    W("edamame", "Edamame, shelled, cooked", "", 1, "cup", 155, [121, 11.9, 8.9, 5.2, 5.2, 2.2, 6], ["1/2 cup", 78, "100 g", 100]),
    W("lentils_cooked", "Lentils, cooked", "", 1, "cup", 198, [116, 9, 20.1, 0.4, 7.9, 1.8, 2], ["1/2 cup", 99, "100 g", 100]),
    W("black_beans_cooked", "Black beans, cooked", "", 0.5, "cup", 86, [132, 8.9, 23.7, 0.5, 8.7, 0.3, 1], ["1 cup", 172, "100 g", 100]),
    L("black_beans_canned", "Black beans, canned, drained", "", 0.5, "cup", 130, [110, 7, 20, 0.5, 7, 0, 350], ["1 cup", 260, "1 can drained", 260, "100 g", 100]),
    L("chickpeas_canned", "Chickpeas, canned, drained", "", 0.5, "cup", 120, [120, 6, 20, 2, 6, 2, 260], ["1 cup", 240, "100 g", 100]),
    W("chickpeas_cooked", "Chickpeas, cooked from dry", "", 1, "cup", 164, [164, 8.9, 27.4, 2.6, 7.6, 4.8, 7], ["1/2 cup", 82, "100 g", 100]),
    W("pinto_beans_cooked", "Pinto beans, cooked", "", 0.5, "cup", 86, [143, 9, 26.2, 0.65, 9, 0.3, 1], ["1 cup", 172, "100 g", 100]),
    L("refried_beans", "Refried beans, canned", "", 0.5, "cup", 130, [130, 7, 20, 2, 6, 1, 500], ["1 cup", 260, "100 g", 100]),
    /* Dave's Killer Bread labels, per slice */
    L("dkb_21_grains", "Bread, 21 Whole Grains", "Dave's Killer Bread", 1, "slice", 45, [110, 5, 22, 1.5, 5, 5, 170], ["2 slices", 90, "100 g", 100], ST),
    L("dkb_good_seed", "Bread, Good Seed", "Dave's Killer Bread", 1, "slice", 45, [120, 5, 23, 3, 3, 5, 160], ["2 slices", 90, "100 g", 100], ST),
    L("dkb_thin", "Bread, 21 Whole Grains, thin", "Dave's Killer Bread", 1, "slice", 28, [60, 3, 12, 1, 3, 3, 100], ["2 slices", 56, "100 g", 100], ST)
  );
  /* --------------------------------------------------------------- CARBS */
  G.push(
    CK("white_rice", "White rice", "", 0.25, "cup", 46, [365, 7.1, 80, 0.7, 1.3, 0.1, 5], [130, 2.7, 28.2, 0.3, 0.4, 0.1, 1], ["1/2 cup", 92, "1 cup", 185, "100 g", 100], "dry", ["1/2 cup", 79, "3/4 cup", 118, "1 cup", 158, "100 g", 100]),
    W("brown_rice_cooked", "Brown rice, cooked", "", 1, "cup", 195, [123, 2.7, 25.6, 1, 1.6, 0.2, 4], ["1/2 cup", 98, "3/4 cup", 146, "100 g", 100]),
    W("jasmine_rice_cooked", "Jasmine rice, cooked", "", 1, "cup", 158, [129, 2.7, 28.6, 0.2, 0.3, 0, 1], ["1/2 cup", 79, "100 g", 100]),
    /* USDA: quinoa, uncooked / cooked (1 cup dry = 170 g, 1 cup cooked = 185 g) */
    CK("quinoa", "Quinoa", "", 0.25, "cup", 42.5, [368, 14.1, 64.2, 6.1, 7, 0, 5], [120, 4.4, 21.3, 1.9, 2.8, 0.9, 7], ["1/2 cup", 85, "1 cup", 170, "100 g", 100], "dry", ["1/2 cup", 92.5, "3/4 cup", 139, "1 cup", 185, "100 g", 100], ST),
    W("potato_baked", "Potato, baked, with skin", "", 1, "medium", 173, [93, 2.5, 21.2, 0.1, 2.2, 1.2, 10], ["1 small", 138, "1 large", 299, "100 g", 100]),
    W("potato_boiled", "Potato, boiled or roasted, no oil", "", 1, "cup", 156, [87, 1.9, 20.1, 0.1, 1.8, 0.9, 4], ["1/2 cup", 78, "100 g", 100]),
    W("sweet_potato_baked", "Sweet potato, baked, with skin", "", 1, "medium", 114, [90, 2, 20.7, 0.2, 3.3, 6.5, 36], ["1 small", 60, "1 large", 180, "1 cup cubes", 200, "100 g", 100]),
    W("hash_browns", "Hash browns, fried", "", 1, "cup", 156, [265, 3, 35, 13, 3, 0.5, 340], ["1 patty", 64, "100 g", 100]),
    W("white_bread", "Bread, white, sandwich slice", "", 1, "slice", 28, [266, 8.9, 49, 3.3, 2.4, 5.3, 490], ["2 slices", 56, "100 g", 100]),
    W("whole_wheat_bread", "Bread, whole wheat, slice", "", 1, "slice", 32, [252, 12.3, 43, 3.4, 6, 4.3, 455], ["2 slices", 64, "100 g", 100]),
    W("sourdough", "Bread, sourdough, slice", "", 1, "slice", 50, [274, 10.7, 52, 2.4, 2.2, 3, 590], ["2 slices", 100, "100 g", 100]),
    W("bagel_plain", "Bagel, plain", "", 1, "bagel", 98, [270, 10.5, 53, 1.4, 2.2, 6, 480], ["1/2 bagel", 49, "1 mini bagel", 26, "100 g", 100]),
    W("english_muffin", "English muffin", "", 1, "muffin", 57, [235, 8.8, 46, 1.8, 3.5, 3.4, 400], ["1/2 muffin", 29, "100 g", 100]),
    L("tortilla_flour", "Tortilla, flour, 8 in", "", 1, "tortilla", 45, [140, 4, 24, 3.5, 1, 1, 330], ["1 burrito size (10 in)", 70, "1 taco size (6 in)", 30, "100 g", 100]),
    L("tortilla_corn", "Tortilla, corn, 6 in", "", 1, "tortilla", 26, [60, 1, 12, 1, 1, 0, 10], ["2 tortillas", 52, "3 tortillas", 78, "100 g", 100]),
    CK("pasta", "Pasta", "", 2, "oz", 56, [371, 13, 74.7, 1.5, 3.2, 2.7, 6], [158, 5.8, 31, 0.9, 1.8, 0.6, 1], ["1 oz", 28, "100 g", 100], "dry", ["1/2 cup", 70, "1 cup", 140, "2 cups", 280, "100 g", 100]),
    W("couscous_cooked", "Couscous, cooked", "", 1, "cup", 157, [112, 3.8, 23.2, 0.2, 1.4, 0.1, 5], ["1/2 cup", 79, "100 g", 100]),
    L("rice_cake", "Rice cake, plain", "", 1, "cake", 9, [35, 0.7, 7.3, 0.3, 0.4, 0, 2], ["2 cakes", 18, "3 cakes", 27, "100 g", 100]),
    L("hamburger_bun", "Hamburger bun", "", 1, "bun", 43, [120, 4, 22, 2, 1, 3, 210], ["100 g", 100]),
    L("naan", "Naan bread", "", 1, "piece", 90, [260, 9, 45, 5, 2, 3, 420], ["1/2 piece", 45, "100 g", 100])
  );
  /* ---------------------------------------------------------------- FATS */
  G.push(
    W("olive_oil", "Olive oil", "", 1, "tbsp", 14, [884, 0, 0, 100, 0, 0, 2], ["1 tsp", 4.5, "2 tbsp", 28, "100 g", 100]),
    W("avocado_oil", "Avocado oil", "", 1, "tbsp", 14, [884, 0, 0, 100, 0, 0, 0], ["1 tsp", 4.5, "2 tbsp", 28, "100 g", 100]),
    W("coconut_oil", "Coconut oil", "", 1, "tbsp", 14, [892, 0, 0, 99, 0, 0, 0], ["1 tsp", 4.5, "100 g", 100]),
    W("cooking_spray", "Cooking spray (1 second)", "", 1, "spray", 0.3, [792, 0, 0, 88, 0, 0, 0], ["3 sprays", 0.9, "100 g", 100]),
    W("butter", "Butter, salted", "", 1, "tbsp", 14, [717, 0.9, 0.1, 81, 0, 0.1, 643], ["1 tsp", 4.7, "1 pat", 5, "100 g", 100]),
    W("avocado", "Avocado", "", 0.5, "medium", 75, [160, 2, 8.5, 14.7, 6.7, 0.7, 7], ["1 whole", 150, "1/4 avocado", 38, "1 cup sliced", 146, "100 g", 100]),
    W("almonds", "Almonds", "", 1, "oz (23 almonds)", 28, [579, 21.2, 21.6, 49.9, 12.5, 4.4, 1], ["1/4 cup", 36, "10 almonds", 12, "100 g", 100]),
    W("walnuts", "Walnuts", "", 1, "oz (14 halves)", 28, [654, 15.2, 13.7, 65.2, 6.7, 2.6, 2], ["1/4 cup", 30, "100 g", 100]),
    W("cashews", "Cashews", "", 1, "oz (18 nuts)", 28, [553, 18.2, 30.2, 43.9, 3.3, 5.9, 12], ["1/4 cup", 32, "100 g", 100]),
    W("peanuts", "Peanuts, dry roasted", "", 1, "oz", 28, [587, 24.4, 21.3, 49.7, 8.4, 4.2, 6], ["1/4 cup", 37, "100 g", 100]),
    W("pistachios", "Pistachios, shelled", "", 1, "oz (49 nuts)", 28, [562, 20.2, 27.5, 45.3, 10.6, 7.7, 1], ["1/4 cup", 31, "100 g", 100]),
    W("peanut_butter", "Peanut butter, creamy", "", 2, "tbsp", 32, [588, 25, 20, 50, 6, 9, 430], ["1 tbsp", 16, "100 g", 100]),
    W("almond_butter", "Almond butter", "", 2, "tbsp", 32, [614, 21, 19, 56, 10, 4.4, 7], ["1 tbsp", 16, "100 g", 100]),
    W("chia_seeds", "Chia seeds", "", 1, "tbsp", 12, [486, 16.5, 42, 30.7, 34.4, 0, 16], ["2 tbsp", 24, "100 g", 100]),
    W("flax_ground", "Flaxseed, ground", "", 1, "tbsp", 7, [534, 18.3, 28.9, 42.2, 27.3, 1.5, 30], ["2 tbsp", 14, "100 g", 100]),
    W("mayo", "Mayonnaise", "", 1, "tbsp", 14, [680, 1, 0.6, 75, 0, 0.6, 635], ["1 tsp", 4.7, "2 tbsp", 28, "100 g", 100]),
    L("ranch", "Ranch dressing", "", 2, "tbsp", 30, [130, 0, 2, 13, 0, 1, 260], ["1 tbsp", 15, "100 g", 100]),
    W("sour_cream", "Sour cream", "", 2, "tbsp", 30, [198, 2.4, 4.6, 19.4, 0, 3.4, 31], ["1 tbsp", 15, "1/4 cup", 60, "100 g", 100]),
    W("heavy_cream", "Heavy cream", "", 1, "tbsp", 15, [340, 2.8, 2.8, 36, 0, 2.9, 27], ["2 tbsp", 30, "1/4 cup", 60, "100 g", 100]),
    W("half_and_half", "Half and half", "", 2, "tbsp", 30, [131, 3.1, 4.3, 11.5, 0, 4, 41], ["1 tbsp", 15, "100 g", 100])
  );
  /* --------------------------------------------------------------- FRUIT */
  G.push(
    W("banana", "Banana", "", 1, "medium", 118, [89, 1.1, 22.8, 0.3, 2.6, 12.2, 1], ["1 small", 101, "1 large", 136, "1/2 banana", 59, "100 g", 100], ST),
    /* USDA: lemon / lime (whole fruit, no peel) and their raw juice */
    W("lemon", "Lemon", "", 1, "lemon", 58, [29, 1.1, 9.3, 0.3, 2.8, 2.5, 2], ["1 wedge", 7, "100 g", 100], ST),
    W("lemon_juice", "Lemon juice", "", 1, "lemon, juiced", 48, [22, 0.4, 6.9, 0.2, 0.3, 2.5, 1], ["1 tbsp", 15, "1 tsp", 5, "100 g", 100], ST),
    W("lime", "Lime", "", 1, "lime", 67, [30, 0.7, 10.5, 0.2, 2.8, 1.7, 2], ["1 wedge", 8, "100 g", 100], ST),
    W("lime_juice", "Lime juice", "", 1, "lime, juiced", 44, [25, 0.4, 8.4, 0.1, 0.4, 1.7, 2], ["1 tbsp", 15, "1 tsp", 5, "100 g", 100], ST),
    W("apple", "Apple, with skin", "", 1, "medium", 182, [52, 0.3, 13.8, 0.2, 2.4, 10.4, 1], ["1 small", 149, "1 large", 223, "1 cup slices", 109, "100 g", 100]),
    W("orange", "Orange", "", 1, "medium", 131, [47, 0.9, 11.8, 0.1, 2.4, 9.4, 0], ["1 small", 96, "1 large", 184, "100 g", 100]),
    W("strawberries", "Strawberries", "", 1, "cup, halves", 152, [32, 0.7, 7.7, 0.3, 2, 4.9, 1], ["1 berry", 12, "1/2 cup", 76, "100 g", 100], ST),
    W("blueberries", "Blueberries", "", 1, "cup", 148, [57, 0.7, 14.5, 0.3, 2.4, 10, 1], ["1/2 cup", 74, "100 g", 100], ST),
    W("raspberries", "Raspberries", "", 1, "cup", 123, [52, 1.2, 11.9, 0.7, 6.5, 4.4, 1], ["1/2 cup", 62, "100 g", 100]),
    W("grapes", "Grapes", "", 1, "cup", 151, [69, 0.7, 18.1, 0.2, 0.9, 15.5, 2], ["10 grapes", 49, "1/2 cup", 76, "100 g", 100]),
    W("watermelon", "Watermelon", "", 1, "cup, diced", 152, [30, 0.6, 7.6, 0.2, 0.4, 6.2, 1], ["1 wedge (1/16 melon)", 286, "100 g", 100]),
    W("pineapple", "Pineapple", "", 1, "cup, chunks", 165, [50, 0.5, 13.1, 0.1, 1.4, 9.9, 1], ["1 slice", 84, "100 g", 100]),
    W("mango", "Mango", "", 1, "cup, pieces", 165, [60, 0.8, 15, 0.4, 1.6, 13.7, 1], ["1 whole", 336, "100 g", 100]),
    W("dates", "Dates, Medjool", "", 1, "date", 24, [277, 1.8, 75, 0.2, 6.7, 66.5, 1], ["2 dates", 48, "3 dates", 72, "100 g", 100]),
    W("peach", "Peach", "", 1, "medium", 150, [39, 0.9, 9.5, 0.3, 1.5, 8.4, 0], ["1 cup slices", 154, "100 g", 100]),
    W("pear", "Pear", "", 1, "medium", 178, [57, 0.4, 15.2, 0.1, 3.1, 9.8, 1], ["100 g", 100]),
    W("cherries", "Cherries, sweet", "", 1, "cup, pitted", 154, [63, 1.1, 16, 0.2, 2.1, 12.8, 0], ["10 cherries", 82, "100 g", 100]),
    W("kiwi", "Kiwi", "", 1, "fruit", 69, [61, 1.1, 14.7, 0.5, 3, 9, 3], ["2 kiwis", 138, "100 g", 100]),
    W("cantaloupe", "Cantaloupe", "", 1, "cup, diced", 156, [34, 0.8, 8.2, 0.2, 0.9, 7.9, 16], ["1 wedge", 69, "100 g", 100]),
    W("raisins", "Raisins", "", 1, "small box", 43, [299, 3.1, 79.2, 0.5, 3.7, 59.2, 11], ["1/4 cup", 41, "1 tbsp", 10, "100 g", 100]),
    W("frozen_berries", "Mixed berries, frozen", "", 1, "cup", 150, [50, 0.9, 11.5, 0.4, 3.2, 6.8, 2], ["1/2 cup", 75, "100 g", 100]),
    W("applesauce", "Applesauce, unsweetened", "", 1, "cup", 244, [42, 0.2, 11.3, 0.1, 1.1, 9.4, 2], ["1 pouch", 90, "1/2 cup", 122, "100 g", 100])
  );
  /* ---------------------------------------------------------- VEGETABLES */
  G.push(
    W("broccoli_cooked", "Broccoli, cooked", "", 1, "cup, chopped", 156, [35, 2.4, 7.2, 0.4, 3.3, 1.4, 41], ["1/2 cup", 78, "100 g", 100], ST),
    W("broccoli_raw", "Broccoli, raw", "", 1, "cup, chopped", 91, [34, 2.8, 6.6, 0.4, 2.6, 1.7, 33], ["1/2 cup", 46, "100 g", 100], ST),
    W("spinach_raw", "Spinach, raw", "", 2, "cups", 60, [23, 2.9, 3.6, 0.4, 2.2, 0.4, 79], ["1 cup", 30, "100 g", 100]),
    W("spinach_cooked", "Spinach, cooked", "", 1, "cup", 180, [23, 3, 3.8, 0.3, 2.4, 0.4, 70], ["1/2 cup", 90, "100 g", 100]),
    W("kale_raw", "Kale, raw", "", 1, "cup, chopped", 21, [49, 4.3, 8.8, 0.9, 3.6, 2.3, 38], ["2 cups", 42, "100 g", 100]),
    W("lettuce_romaine", "Lettuce, romaine", "", 2, "cups, shredded", 94, [17, 1.2, 3.3, 0.3, 2.1, 1.2, 8], ["1 cup", 47, "100 g", 100]),
    W("spring_mix", "Spring mix / mixed greens", "", 2, "cups", 85, [20, 1.8, 3.5, 0.3, 1.8, 0.8, 30], ["1 cup", 42, "100 g", 100]),
    W("tomato", "Tomato, regular", "", 1, "medium", 123, [18, 0.9, 3.9, 0.2, 1.2, 2.6, 5], ["1 cup chopped", 180, "1 slice", 20, "100 g", 100]),
    W("roma_tomato", "Tomato, Roma", "", 1, "tomato", 62, [18, 0.9, 3.9, 0.2, 1.2, 2.6, 5], ["1 cup, chopped", 180, "100 g", 100], ST),
    W("cherry_tomatoes", "Cherry tomatoes", "", 1, "cup", 149, [18, 0.9, 3.9, 0.2, 1.2, 2.6, 5], ["5 tomatoes", 85, "100 g", 100]),
    /* USDA: cucumber with peel, raw (1 cucumber = 301 g) */
    W("cucumber", "Cucumber", "", 1, "cup, sliced", 104, [15, 0.7, 3.6, 0.1, 0.5, 1.7, 2], ["1/2 cucumber", 150, "1 cucumber", 301, "100 g", 100], ST),
    /* USDA: peppers, sweet, red, raw */
    W("bell_pepper", "Bell pepper", "", 1, "medium", 119, [26, 1, 6, 0.3, 2.1, 4.2, 4], ["1 small", 74, "1 large", 164, "1 cup, chopped", 149, "1 cup, sliced", 92, "100 g", 100], ST),
    W("carrots", "Carrots, raw", "", 1, "medium", 61, [41, 0.9, 9.6, 0.2, 2.8, 4.7, 69], ["1 cup chopped", 128, "10 baby carrots", 100, "100 g", 100], ST),
    W("carrots_cooked", "Carrots, cooked", "", 0.5, "cup, sliced", 78, [35, 0.8, 8.2, 0.2, 3, 3.5, 58], ["1 cup, sliced", 156, "100 g", 100], ST),
    W("onion", "Onion, white", "", 0.5, "cup, chopped", 80, [40, 1.1, 9.3, 0.1, 1.7, 4.2, 4], ["1 medium", 110, "1 tbsp", 10, "100 g", 100], ST),
    W("sweet_onion", "Onion, sweet", "", 0.5, "cup, chopped", 80, [32, 0.8, 7.6, 0.1, 0.9, 5, 8], ["1 cup, chopped", 160, "1 slice", 38, "100 g", 100], ST),
    W("mushrooms", "Mushrooms, white, raw", "", 1, "cup, sliced", 70, [22, 3.1, 3.3, 0.3, 1, 2, 5], ["100 g", 100]),
    W("green_beans", "Green beans, cooked", "", 1, "cup", 125, [35, 1.9, 7.9, 0.3, 3.2, 3.6, 1], ["1/2 cup", 63, "100 g", 100]),
    /* USDA: asparagus, raw (1 medium spear = 16 g) */
    W("asparagus", "Asparagus", "", 6, "spears", 96, [20, 2.2, 3.9, 0.1, 2.1, 1.9, 2], ["1 spear", 16, "1 cup", 134, "100 g", 100], ST),
    /* USDA: sweet corn, cooked (1 medium ear = 103 g of corn) */
    W("corn", "Corn on the cob, grilled", "", 1, "ear", 103, [96, 3.4, 21, 1.5, 2.4, 4.5, 1], ["1 small ear", 89, "1 large ear", 118, "1 cup, kernels", 149, "100 g", 100], STW("sweet corn bbq")),
    W("peas", "Peas, green, cooked", "", 1, "cup", 160, [84, 5.4, 15.6, 0.2, 5.5, 5.9, 3], ["1/2 cup", 80, "100 g", 100]),
    W("zucchini", "Zucchini, cooked", "", 1, "cup, sliced", 180, [15, 1.1, 2.7, 0.4, 1, 1.7, 3], ["1 medium", 196, "100 g", 100], ST),
    W("zucchini_raw", "Zucchini, raw", "", 1, "medium", 196, [17, 1.2, 3.1, 0.3, 1, 2.5, 8], ["1 cup, sliced", 113, "1/2 medium", 98, "100 g", 100], ST),
    W("cauliflower", "Cauliflower, cooked", "", 1, "cup", 124, [23, 1.8, 4.1, 0.5, 2.3, 2.1, 15], ["1 cup raw", 107, "100 g", 100]),
    W("cauliflower_rice", "Cauliflower rice", "", 1, "cup", 107, [25, 2, 5, 0.3, 2, 2, 30], ["1/2 cup", 54, "100 g", 100]),
    W("brussels_sprouts", "Brussels sprouts, cooked", "", 1, "cup", 156, [36, 2.6, 7.1, 0.5, 2.6, 1.7, 21], ["100 g", 100]),
    W("celery", "Celery", "", 2, "stalks", 80, [14, 0.7, 3, 0.2, 1.6, 1.3, 80], ["1 cup chopped", 101, "100 g", 100]),
    W("sweet_potato_fries", "Sweet potato fries, baked frozen", "", 3, "oz", 85, [160, 1.5, 24, 6.5, 3, 5, 200], ["100 g", 100]),
    W("frozen_veg_mix", "Mixed vegetables, frozen, steamed", "", 1, "cup", 91, [65, 2.9, 13.1, 0.2, 4, 3.6, 35], ["1/2 cup", 46, "100 g", 100]),
    W("kimchi", "Kimchi", "", 0.5, "cup", 75, [15, 1.1, 2.4, 0.5, 1.6, 1.1, 498], ["100 g", 100]),
    W("pickles", "Pickles, dill", "", 1, "spear", 35, [12, 0.5, 2.3, 0.2, 1.2, 1.1, 800], ["1 whole", 65, "100 g", 100])
  );
  /* ---------------------------------------------------------- DAIRY / DRINKS */
  G.push(
    W("milk_whole", "Milk, whole", "", 1, "cup", 244, [61, 3.2, 4.8, 3.3, 0, 5.1, 43], ["1/2 cup", 122, "100 g", 100]),
    W("milk_2", "Milk, 2%", "", 1, "cup", 244, [50, 3.4, 4.9, 2, 0, 5.1, 44], ["1/2 cup", 122, "100 g", 100]),
    W("milk_skim", "Milk, skim", "", 1, "cup", 245, [34, 3.4, 5, 0.1, 0, 5.1, 42], ["1/2 cup", 122, "100 g", 100]),
    L("almond_milk", "Almond milk, unsweetened", "", 1, "cup", 240, [30, 1, 1, 2.5, 1, 0, 170], ["1/2 cup", 120, "100 g", 100]),
    L("oat_milk", "Oat milk", "", 1, "cup", 240, [120, 3, 16, 5, 2, 7, 100], ["1/2 cup", 120, "100 g", 100]),
    L("kefir", "Kefir, plain low-fat", "", 1, "cup", 240, [110, 11, 12, 2, 0, 12, 125], ["100 g", 100]),
    L("coffee_black", "Coffee, black", "", 12, "oz", 355, [4, 0.4, 0, 0, 0, 0, 7], ["8 oz", 237, "16 oz", 473, "100 g", 100]),
    L("coffee_creamer", "Coffee with 2 tbsp half & half", "", 12, "oz", 385, [45, 1.5, 1.5, 3.5, 0, 1.5, 25], ["100 g", 100]),
    L("cold_brew", "Cold brew, black", "", 16, "oz", 473, [5, 0.5, 0, 0, 0, 0, 15], ["100 g", 100]),
    L("orange_juice", "Orange juice", "", 1, "cup", 248, [110, 2, 26, 0.5, 0.5, 21, 2], ["1/2 cup", 124, "100 g", 100]),
    L("apple_juice", "Apple juice", "", 1, "cup", 248, [114, 0.2, 28, 0.3, 0.5, 24, 10], ["100 g", 100]),
    L("beer", "Beer, regular (5%)", "", 12, "oz", 356, [153, 1.6, 12.6, 0, 0, 0, 14], ["16 oz", 473, "100 g", 100], { alcohol: true }),
    L("beer_light", "Beer, light (4.2%)", "", 12, "oz", 354, [103, 0.9, 5.8, 0, 0, 0.3, 14], ["16 oz", 473, "100 g", 100], { alcohol: true }),
    L("ipa", "Beer, IPA (6.5%)", "", 12, "oz", 356, [200, 2, 16, 0, 0, 0, 15], ["16 oz", 473, "100 g", 100], { alcohol: true }),
    L("wine_red", "Wine, red", "", 5, "oz", 147, [125, 0.1, 3.8, 0, 0, 0.9, 6], ["1 bottle (750 ml)", 750, "100 g", 100], { alcohol: true }),
    L("wine_white", "Wine, white", "", 5, "oz", 147, [121, 0.1, 3.8, 0, 0, 1.4, 7], ["1 bottle (750 ml)", 750, "100 g", 100], { alcohol: true }),
    L("whiskey_shot", "Whiskey / vodka / tequila, 80 proof", "", 1.5, "oz shot", 42, [97, 0, 0, 0, 0, 0, 0], ["1 oz", 28, "2 oz", 56, "100 g", 100], { alcohol: true }),
    L("seltzer", "Seltzer / sparkling water", "", 12, "oz", 355, [0, 0, 0, 0, 0, 0, 0], ["16 oz", 473, "100 g", 100]),
    L("hard_seltzer", "Hard seltzer", "", 12, "oz", 355, [100, 0, 2, 0, 0, 1, 10], ["100 g", 100], { alcohol: true }),
    L("soda", "Soda, regular", "", 12, "oz can", 368, [140, 0, 39, 0, 0, 39, 45], ["20 oz bottle", 613, "100 g", 100]),
    L("diet_soda", "Diet soda", "", 12, "oz can", 355, [0, 0, 0, 0, 0, 0, 40], ["20 oz bottle", 591, "100 g", 100]),
    L("gatorade", "Sports drink", "", 20, "oz", 600, [140, 0, 36, 0, 0, 34, 270], ["12 oz", 360, "100 g", 100]),
    L("energy_drink_zero", "Energy drink, sugar free", "", 12, "oz can", 355, [10, 0, 2, 0, 0, 0, 10], ["16 oz can", 473, "100 g", 100]),
    L("electrolyte_packet", "Electrolyte drink mix", "", 1, "packet", 6, [10, 0, 2, 0, 0, 0, 1000], ["2 packets", 12]),
    L("water", "Water", "", 16, "oz", 473, [0, 0, 0, 0, 0, 0, 0], ["8 oz", 237, "100 g", 100])
  );
  /* ------------------------------------------------------- CONDIMENTS / SAUCES */
  G.push(
    L("ketchup", "Ketchup", "", 1, "tbsp", 17, [20, 0, 5, 0, 0, 4, 160], ["2 tbsp", 34, "100 g", 100]),
    L("mustard", "Mustard, yellow", "", 1, "tsp", 5, [3, 0.2, 0.3, 0.2, 0.1, 0.1, 55], ["1 tbsp", 15, "100 g", 100]),
    L("hot_sauce", "Hot sauce", "", 1, "tsp", 5, [0, 0, 0, 0, 0, 0, 110], ["1 tbsp", 15, "100 g", 100]),
    L("sriracha", "Sriracha", "", 1, "tsp", 5, [5, 0, 1, 0, 0, 1, 80], ["1 tbsp", 15, "100 g", 100]),
    L("soy_sauce", "Soy sauce", "", 1, "tbsp", 16, [10, 1.3, 0.8, 0, 0, 0.1, 880], ["1 tsp", 5, "100 g", 100]),
    L("bbq_sauce", "BBQ sauce", "", 2, "tbsp", 36, [70, 0, 17, 0, 0, 12, 320], ["1 tbsp", 18, "100 g", 100]),
    L("honey", "Honey", "", 1, "tbsp", 21, [64, 0.1, 17.3, 0, 0, 17.2, 1], ["1 tsp", 7, "100 g", 100]),
    L("maple_syrup", "Maple syrup, pure", "", 2, "tbsp", 40, [104, 0, 27, 0, 0, 24, 5], ["1 tbsp", 20, "1/4 cup", 80, "100 g", 100]),
    /* Smucker's Natural strawberry fruit spread label: 1 tbsp (19 g) = 40 kcal,
       10 g carbs, 10 g sugar, 0 g fat, 0 g protein, 0 mg sodium. They call it
       jam or jelly. */
    L("jam", "Strawberry jam / jelly", "Smucker's Natural", 1, "tbsp", 19, [40, 0, 10, 0, 0, 10, 0], ["1 tsp", 6.3, "2 tbsp", 38, "100 g", 100], STW("fruit spread preserves smuckers")),
    /* USDA: agave syrup (1 tsp = 6.9 g) */
    W("agave", "Agave, syrup", "", 1, "tbsp", 21, [310, 0.1, 76.4, 0.5, 0.2, 68, 4], ["1 tsp", 6.9, "2 tbsp", 42, "100 g", 100], STW("nectar sweetener")),
    L("salsa", "Salsa", "", 2, "tbsp", 32, [10, 0.4, 2, 0, 0.5, 1, 190], ["1/4 cup", 64, "100 g", 100]),
    L("guacamole", "Guacamole", "", 2, "tbsp", 30, [50, 0.6, 2.5, 4.5, 2, 0.3, 90], ["1/4 cup", 60, "1 mini cup (2 oz)", 57, "100 g", 100]),
    L("hummus", "Hummus", "", 2, "tbsp", 30, [70, 2, 4, 5, 1, 0, 130], ["1/4 cup", 60, "100 g", 100]),
    L("tzatziki", "Tzatziki", "", 2, "tbsp", 30, [35, 1, 1, 3, 0, 1, 90], ["1/4 cup", 60, "100 g", 100]),
    L("marinara", "Marinara / pasta sauce", "", 0.5, "cup", 125, [70, 2, 10, 2.5, 2, 6, 430], ["1/4 cup", 63, "100 g", 100]),
    L("alfredo", "Alfredo sauce, jarred", "", 0.25, "cup", 62, [100, 2, 3, 9, 0, 1, 360], ["1/2 cup", 124, "100 g", 100]),
    L("pesto", "Pesto", "", 2, "tbsp", 30, [130, 3, 2, 12, 1, 0, 190], ["1 tbsp", 15, "100 g", 100]),
    L("teriyaki", "Teriyaki sauce", "", 1, "tbsp", 18, [16, 1, 3, 0, 0, 2.5, 690], ["2 tbsp", 36, "100 g", 100]),
    L("buffalo_sauce", "Buffalo sauce", "", 1, "tbsp", 15, [0, 0, 0, 0, 0, 0, 460], ["2 tbsp", 30, "100 g", 100]),
    L("italian_dressing", "Italian dressing", "", 2, "tbsp", 30, [70, 0, 3, 6, 0, 2, 300], ["1 tbsp", 15, "100 g", 100]),
    L("caesar_dressing", "Caesar dressing", "", 2, "tbsp", 30, [150, 1, 1, 16, 0, 1, 300], ["1 tbsp", 15, "100 g", 100]),
    L("balsamic_vinaigrette", "Balsamic vinaigrette", "", 2, "tbsp", 30, [90, 0, 4, 8, 0, 3, 250], ["1 tbsp", 15, "100 g", 100]),
    L("light_mayo", "Mayonnaise, light", "", 1, "tbsp", 15, [35, 0, 1, 3.5, 0, 0, 125], ["100 g", 100]),
    L("sugar", "Sugar, white", "", 1, "tsp", 4, [16, 0, 4, 0, 0, 4, 0], ["1 tbsp", 12, "100 g", 100]),
    L("taco_seasoning", "Taco seasoning packet", "", 2, "tsp", 6, [15, 0, 3, 0, 0, 0, 380], ["100 g", 100])
  );
  /* ------------------------------------------------------------ COMMON MEALS */
  G.push(
    L("caesar_salad", "Caesar salad, side, with dressing", "", 1, "side salad", 150, [220, 6, 10, 18, 2, 2, 480], ["entree size", 300, "100 g", 100]),
    L("chicken_caesar_salad", "Chicken Caesar salad, entree", "", 1, "salad", 350, [520, 38, 14, 34, 3, 3, 1100], ["1/2 salad", 175, "100 g", 100])
  );
  /* ----------------------------------------------------------------- SNACKS */
  G.push(
    L("tortilla_chips", "Tortilla chips", "", 1, "oz (about 12 chips)", 28, [140, 2, 19, 7, 1, 0, 110], ["2 oz", 56, "100 g", 100]),
    L("potato_chips", "Potato chips", "", 1, "oz (about 15 chips)", 28, [160, 2, 15, 10, 1, 0, 170], ["2 oz", 56, "1 snack bag", 43, "100 g", 100]),
    L("popcorn_air", "Popcorn, air popped", "", 3, "cups", 24, [93, 3, 18.6, 1.1, 3.5, 0.2, 2], ["1 cup", 8, "5 cups", 40, "100 g", 100]),
    L("popcorn_microwave", "Popcorn, microwave, butter", "", 1, "bag", 85, [420, 6, 40, 27, 7, 0, 600], ["1/2 bag", 43, "3 cups", 24, "100 g", 100]),
    W("pretzels", "Pretzels", "", 1, "oz", 28, [381, 10, 80, 2.6, 3.4, 2.2, 1240], ["10 mini twists", 30, "100 g", 100]),
    W("dark_chocolate", "Dark chocolate, 70%", "", 1, "oz", 28, [598, 7.8, 46, 43, 11, 24, 20], ["1 square", 10, "1/2 bar (50 g)", 50, "100 g", 100]),
    W("milk_chocolate", "Milk chocolate", "", 1, "oz", 28, [535, 7.7, 59, 29.7, 3.4, 52, 79], ["1 fun size bar", 15, "1 bar (1.55 oz)", 44, "100 g", 100]),
    W("ice_cream", "Ice cream, vanilla", "", 0.67, "cup", 88, [207, 3.5, 24, 11, 0.7, 21, 80], ["1/2 cup", 66, "1 cup", 132, "1 scoop", 72, "100 g", 100]),
    L("trail_mix", "Trail mix", "", 0.25, "cup", 38, [180, 5, 16, 12, 2, 10, 60], ["1 oz", 28, "100 g", 100]),
    L("beef_jerky", "Beef jerky", "", 1, "oz", 28, [80, 11, 5, 1.5, 0, 4, 470], ["1 bag (2.85 oz)", 80, "100 g", 100])
  );

  M.DB.generic = G;

  /* Old ids from before each raw/cooked pair became one food. Days already
     logged point at these; M.foods.get() follows them to the merged food and
     `state` says which weight the old entry was. */
  M.DB.alias = {};
  [["chicken_thigh", "raw", "cooked"], ["ground_beef_80", "raw", "cooked"], ["ground_beef_85", "raw", "cooked"],
    ["ground_beef_90", "raw", "cooked"], ["ground_beef_93", "raw", "cooked"], ["ground_turkey_93", "raw", "cooked"], ["pork_tenderloin", "raw", "cooked"],
    ["salmon", "raw", "cooked"], ["white_rice", "dry", "cooked"], ["pasta", "dry", "cooked"]].forEach(a => {
    M.DB.alias["g_" + a[0] + "_" + a[1]] = { id: "g_" + a[0], state: "raw" };
    M.DB.alias["g_" + a[0] + "_" + a[2]] = { id: "g_" + a[0], state: "cooked" };
  });
  /* Chicken breast is always the Kirkland organic breast (Nick's rule): the
     plain breast and its old raw/cooked ids all point at it. */
  M.DB.alias.g_chicken_breast = { id: "g_kirkland_organic_chicken", state: "raw" };
  M.DB.alias.g_chicken_breast_raw = { id: "g_kirkland_organic_chicken", state: "raw" };
  M.DB.alias.g_chicken_breast_cooked = { id: "g_kirkland_organic_chicken", state: "cooked" };
  /* cooked-only foods that became raw (or dry) + cooked foods */
  M.DB.alias.g_cod_cooked = { id: "g_cod", state: "cooked" };
  M.DB.alias.g_shrimp_cooked = { id: "g_shrimp", state: "cooked" };
  M.DB.alias.g_quinoa_cooked = { id: "g_quinoa", state: "cooked" };

  /* ======================================================================
     MEAL SUGGESTIONS — built from the generic foods above so every item's
     macros match what the person sees when they search the same food.
     ====================================================================== */
  const byId = {}; G.forEach(f => { byId[f.id.slice(2)] = f; });
  const r2 = v => Math.round(v * 100 + 1e-9) / 100;
  /* fractions as the diary shows them ("½ cup", not "0.5 cup") */
  const fmtQty = q => { const m = { 0.25: "¼", 0.33: "⅓", 0.5: "½", 0.67: "⅔", 0.75: "¾", 1.5: "1 ½" }; return m[q] || String(q); };
  /* it(slug, servings, label?) — `servings` × the food's own serving. */
  function it(slug, servings, label) {
    const f = byId[slug]; if (!f) throw new Error("m-data: unknown food " + slug);
    const s = servings == null ? 1 : servings;
    const g = f.serving.g ? r1(f.serving.g * s) : null;
    const qty = r2(f.serving.qty * s);
    return { name: f.name, servingLabel: label || (fmtQty(qty) + " " + f.serving.unit + (g ? " (" + g + " g)" : "")), g, per: scale(f.per, s), foodId: f.id };
  }
  /* gr(slug, grams, label) — an exact gram amount of a weight-based food. */
  function gr(slug, grams, label) {
    const f = byId[slug]; if (!f) throw new Error("m-data: unknown food " + slug);
    const p = f.per100g ? scale(f.per100g, grams / 100) : scale(f.per, grams / (f.serving.g || grams));
    return { name: f.name, servingLabel: label || (grams + " g"), g: grams, per: p, foodId: f.id };
  }
  /* ck(slug, state, grams, label) — an amount of a food that changes weight when
     cooked, weighed "raw" (or dry) or "cooked"; macros come from that state's
     profile. label reads like "6 oz raw" or "3/4 cup cooked". */
  function ck(slug, state, grams, label) {
    const f = byId[slug]; if (!f || !f.cook) throw new Error("m-data: not a cook food " + slug);
    const p100 = state === "cooked" ? f.cook.per100gCooked : f.per100g;
    return { name: f.name, servingLabel: label, g: grams, per: scale(p100, grams / 100), foodId: f.id, state: state === "cooked" ? "cooked" : "raw", cook: { y: f.cook.y, word: f.cook.word } };
  }
  function sug(id, name, desc, slot, store, prepMin, items, tags) {
    const per = {}; NUT.forEach(k => { per[k] = 0; });
    items.forEach(x => { NUT.forEach(k => { per[k] += x.per[k]; }); });
    NUT.forEach(k => { per[k] = rnd(k, per[k]); });
    return { id: "s_" + id, name, desc, slot, store, prepMin, items, per, tags };
  }

  const S = [];
  /* Ideas built from what Nick and Katerina actually buy (foods marked staple):
     Kirkland organic chicken breast (Costco), the King Soopers pork tenderloin
     2-pack, cod, shrimp, scallops, quinoa, Greek yogurt 2%, Daisy 2% cottage
     cheese, Smucker's jam, Hillshire turkey slices, Dave's Killer Bread and
     their fruit and vegetables. Olive oil, soy sauce and rice are small add-ons.
     Chicken breast is always weighed raw (one breast = 175 g raw). The app
     ranks these below the person's own saved meals. */
  const BREAST = byId.kirkland_organic_chicken.serving.g;
  const chicken = n => ck("kirkland_organic_chicken", "raw", n === 1 ? BREAST : 88, n === 1 ? "1 breast (" + BREAST + " g raw)" : "1/2 breast (88 g raw)");
  const oil = tsp => tsp === 1 ? gr("olive_oil", 4.5, "1 tsp (4.5 g)") : gr("olive_oil", 7, "½ tbsp (7 g)");
  const agave = () => gr("agave", 6.9, "1 tsp (6.9 g)");
  /* ------------------------------------------------------------ BREAKFAST */
  S.push(
    sug("greek_yogurt_berries", "Greek yogurt with berries",
      "A cup of plain 2% Greek yogurt with blueberries, strawberries and a little agave. No cooking.",
      "Breakfast", "Either", 3, [gr("greek_yogurt_2", 227, "1 cup (227 g)"), it("blueberries", 0.5, "½ cup (74 g)"), gr("strawberries", 76, "½ cup (76 g)"), agave()], ["high-protein", "no-cook", "quick"]),
    sug("cottage_cheese_strawberries", "Cottage cheese and strawberries",
      "A cup of Daisy 2% cottage cheese with sliced strawberries and a little agave. No cooking.",
      "Breakfast", "Either", 3, [it("cottage_cheese_2", 2, "1 cup (226 g)"), it("strawberries"), agave()], ["high-protein", "no-cook", "quick"]),
    sug("dkb_jam_cottage_cheese", "Dave's toast with jam and cottage cheese",
      "Two slices of Dave's Killer Bread with Smucker's strawberry jam, and Daisy cottage cheese on the side.",
      "Breakfast", "Either", 5, [it("dkb_21_grains", 2, "2 slices (90 g)"), it("jam"), it("cottage_cheese_2", 1, "½ cup (113 g)")], ["high-protein", "quick"]),
    sug("turkey_tomato_toast", "Turkey and tomato toast",
      "Hillshire turkey slices, Roma tomato and cucumber on two slices of Dave's Killer Bread.",
      "Breakfast", "Either", 5, [it("dkb_21_grains", 2, "2 slices (90 g)"), it("deli_turkey", 1, "6 slices (56 g)"), it("roma_tomato"), gr("cucumber", 52, "½ cup, sliced (52 g)")], ["high-protein", "quick", "no-cook"]),
    sug("chicken_pepper_hash", "Chicken and pepper hash",
      "Half a chicken breast browned with bell pepper, white onion and zucchini in one pan.",
      "Breakfast", "Costco", 15, [chicken(0.5), it("bell_pepper"), gr("onion", 40, "¼ cup, chopped (40 g)"), gr("zucchini_raw", 98, "½ zucchini (98 g)"), oil(1)], ["high-protein", "low-carb", "one-pan"])
  );
  /* ---------------------------------------------------------------- LUNCH */
  S.push(
    sug("chicken_rice_broccoli", "Chicken, rice and broccoli",
      "One Kirkland chicken breast with rice and broccoli. Easy to cook ahead for the week.",
      "Lunch", "Costco", 25, [chicken(1), ck("white_rice", "cooked", 118.5, "3/4 cup cooked"), it("broccoli_cooked"), oil(1), it("soy_sauce", 0.5, "½ tbsp (8 g)")], ["high-protein", "meal-prep"]),
    sug("chicken_quinoa_bowl", "Chicken quinoa bowl",
      "One chicken breast over quinoa with cucumber, Roma tomato and a squeeze of lemon.",
      "Lunch", "Costco", 25, [chicken(1), ck("quinoa", "dry", 42.5, "1/4 cup dry"), it("cucumber"), it("roma_tomato"), gr("lemon_juice", 15, "1 tbsp (15 g)"), oil(1)], ["high-protein", "meal-prep"]),
    sug("turkey_cucumber_plate", "Turkey slices with cucumber and peppers",
      "Hillshire turkey slices with cucumber, bell pepper and baby carrots. No cooking.",
      "Lunch", "Either", 5, [it("deli_turkey", 2, "12 slices (112 g)"), it("cucumber"), gr("bell_pepper", 92, "1 cup, sliced (92 g)"), gr("carrots", 100, "10 baby carrots (100 g)")], ["high-protein", "no-cook", "quick"]),
    sug("shrimp_quinoa_bowl", "Shrimp quinoa bowl",
      "Shrimp cooked with bell pepper, over quinoa with cucumber and lime juice.",
      "Lunch", "Either", 20, [ck("shrimp", "raw", 170, "6 oz raw"), ck("quinoa", "dry", 42.5, "1/4 cup dry"), gr("bell_pepper", 60, "½ pepper (60 g)"), gr("cucumber", 52, "½ cup, sliced (52 g)"), gr("lime_juice", 15, "1 tbsp (15 g)"), oil(1)], ["high-protein"]),
    sug("pork_corn_carrots", "Pork tenderloin with grilled corn and carrots",
      "Pork tenderloin from the King Soopers 2-pack with an ear of grilled corn and carrots.",
      "Lunch", "King Soopers", 30, [ck("pork_tenderloin", "raw", 142, "5 oz raw"), it("corn"), it("carrots_cooked", 2, "1 cup, sliced (156 g)"), oil(1)], ["high-protein", "meal-prep"])
  );
  /* --------------------------------------------------------------- DINNER */
  S.push(
    sug("sheet_pan_chicken", "Sheet-pan chicken with broccoli and carrots",
      "One Kirkland chicken breast roasted with broccoli and carrots, with rice on the side.",
      "Dinner", "Costco", 30, [chicken(1), gr("broccoli_raw", 137, "1 ½ cups, chopped (137 g)"), gr("carrots", 128, "1 cup, chopped (128 g)"), oil(1.5), ck("white_rice", "cooked", 79, "1/2 cup cooked")], ["high-protein", "sheet-pan"]),
    sug("pork_zucchini_sweet_onion", "Pork tenderloin with zucchini and sweet onion",
      "Roast one pork tenderloin from the King Soopers 2-pack with zucchini and sweet onion on one pan.",
      "Dinner", "King Soopers", 35, [ck("pork_tenderloin", "raw", 170, "6 oz raw"), it("zucchini_raw"), it("sweet_onion"), oil(1.5)], ["high-protein", "sheet-pan", "low-carb"]),
    sug("lemon_cod_asparagus", "Lemon cod with asparagus",
      "Cod baked with lemon juice and olive oil, with asparagus and quinoa.",
      "Dinner", "Either", 25, [ck("cod", "raw", 170, "6 oz raw"), gr("asparagus", 128, "8 spears (128 g)"), gr("lemon_juice", 24, "½ lemon, juiced (24 g)"), oil(1.5), ck("quinoa", "dry", 42.5, "1/4 cup dry")], ["high-protein", "sheet-pan"]),
    sug("scallops_corn_zucchini", "Scallops with grilled corn and zucchini",
      "Seared scallops with an ear of grilled corn and zucchini, finished with lemon.",
      "Dinner", "Either", 20, [ck("scallops", "raw", 170, "6 oz raw"), it("corn"), it("zucchini_raw"), gr("lemon_juice", 15, "1 tbsp (15 g)"), oil(1)], ["high-protein", "quick"]),
    sug("shrimp_stir_fry", "Shrimp and veggie stir-fry",
      "Shrimp stir-fried with bell pepper, broccoli and white onion in soy sauce, over rice.",
      "Dinner", "Either", 20, [ck("shrimp", "raw", 170, "6 oz raw"), it("bell_pepper"), gr("broccoli_raw", 91, "1 cup, chopped (91 g)"), gr("onion", 40, "¼ cup, chopped (40 g)"), it("soy_sauce", 1, "1 tbsp (16 g)"), oil(1.5), ck("white_rice", "cooked", 118.5, "3/4 cup cooked")], ["high-protein", "one-pan"]),
    sug("chicken_tomato_skillet", "Chicken, tomato and zucchini skillet",
      "One chicken breast cooked with Roma tomatoes, white onion and zucchini, served over rice.",
      "Dinner", "Costco", 25, [chicken(1), it("roma_tomato", 2, "2 Roma tomatoes (124 g)"), gr("onion", 55, "½ onion (55 g)"), gr("zucchini_raw", 150, "¾ zucchini (150 g)"), oil(1.5), ck("white_rice", "cooked", 79, "1/2 cup cooked")], ["high-protein", "one-pan"])
  );
  /* --------------------------------------------------------------- SNACKS */
  S.push(
    sug("turkey_rollups", "Turkey roll-ups with cucumber",
      "Hillshire turkey slices rolled up, with sliced cucumber. No cooking.",
      "Snacks", "Either", 3, [it("deli_turkey", 1, "6 slices (56 g)"), it("cucumber")], ["high-protein", "no-cook", "quick"]),
    sug("cottage_cheese_tomato", "Cottage cheese with Roma tomato",
      "Daisy 2% cottage cheese topped with a chopped Roma tomato and black pepper.",
      "Snacks", "Either", 3, [it("cottage_cheese_2", 1, "½ cup (113 g)"), it("roma_tomato")], ["high-protein", "no-cook", "quick"]),
    sug("yogurt_strawberries_agave", "Greek yogurt with strawberries",
      "Plain 2% Greek yogurt with strawberries and a little agave. Cold, sweet and high in protein.",
      "Snacks", "Either", 2, [gr("greek_yogurt_2", 170, "¾ cup (170 g)"), gr("strawberries", 76, "½ cup (76 g)"), agave()], ["high-protein", "no-cook", "quick"]),
    sug("dkb_jam_toast", "Dave's toast with jam",
      "One slice of Dave's Killer Bread with Smucker's strawberry jam.",
      "Snacks", "Either", 3, [it("dkb_21_grains", 1, "1 slice (45 g)"), it("jam")], ["quick"]),
    sug("chicken_snack_plate", "Chicken snack plate",
      "Half a chicken breast, cooked ahead, with cucumber and baby carrots.",
      "Snacks", "Costco", 3, [chicken(0.5), it("cucumber"), gr("carrots", 60, "6 baby carrots (60 g)")], ["high-protein", "meal-prep", "quick"])
  );
  M.DB.suggest = S;
})(window.M);
