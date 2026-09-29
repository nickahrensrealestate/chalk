window.M = window.M || {}; M.DB = M.DB || {};
/* ============================================================================
   Chalk · Macros — built-in data
   M.DB.generic : generic + common branded foods (USDA-style values, label
                  values for branded items). Every entry is a full Food.
   M.DB.suggest : built-in high-protein meal suggestions from King Soopers /
                  Costco staples. Pure data — two tiny builders keep `per`
                  and `per100g` consistent and sum suggestion macros exactly.
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
  const OZ = ["1 oz", 28, "100 g", 100];
  const MEAT = ["1 oz", 28, "3 oz", 85, "6 oz", 170, "8 oz", 227, "100 g", 100];

  const G = [];
  /* ------------------------------------------------------------ PROTEINS */
  G.push(
    W("chicken_breast_raw", "Chicken breast, raw", "", 4, "oz", 113, [120, 22.5, 0, 2.6, 0, 0, 45], MEAT),
    W("chicken_breast_cooked", "Chicken breast, cooked", "", 4, "oz", 113, [165, 31, 0, 3.6, 0, 0, 74], MEAT),
    W("chicken_thigh_raw", "Chicken thigh, boneless skinless, raw", "", 4, "oz", 113, [121, 19.7, 0, 4.1, 0, 0, 86], MEAT),
    W("chicken_thigh_cooked", "Chicken thigh, boneless skinless, cooked", "", 4, "oz", 113, [179, 24.8, 0, 8.2, 0, 0, 95], MEAT),
    L("kirkland_chicken_breast", "Chicken breast, boneless skinless (Kirkland)", "Kirkland", 4, "oz", 112, [110, 24, 0, 1.5, 0, 0, 220], MEAT),
    L("just_bare_chicken_breast", "Chicken breast, boneless skinless (Just Bare)", "Just Bare", 4, "oz", 112, [120, 25, 0, 2, 0, 0, 70], MEAT),
    L("just_bare_chicken_chunks", "Chicken breast chunks, lightly breaded (Just Bare)", "Just Bare", 3, "oz", 84, [190, 15, 13, 9, 0, 0, 470], ["1 oz", 28, "100 g", 100, "5 oz", 140]),
    L("rotisserie_chicken_breast", "Rotisserie chicken, breast meat, no skin (Kirkland)", "Kirkland", 3, "oz", 85, [120, 23, 0, 3, 0, 0, 400], MEAT),
    L("rotisserie_chicken_mixed", "Rotisserie chicken, mixed meat with skin (Kirkland)", "Kirkland", 3, "oz", 85, [140, 19, 0, 7, 0, 0, 460], MEAT),
    L("kirkland_canned_chicken", "Chicken breast, canned, drained (Kirkland)", "Kirkland", 2, "oz", 56, [60, 13, 0, 1, 0, 0, 250], ["1 oz", 28, "1 can drained (7 oz)", 198, "100 g", 100]),
    W("ground_beef_80_raw", "Ground beef 80/20, raw", "", 4, "oz", 113, [254, 17.2, 0, 20, 0, 0, 66], MEAT),
    W("ground_beef_80_cooked", "Ground beef 80/20, cooked", "", 3, "oz", 85, [250, 25, 0, 16, 0, 0, 86], MEAT),
    W("ground_beef_85_raw", "Ground beef 85/15, raw", "", 4, "oz", 113, [215, 18.6, 0, 15, 0, 0, 66], MEAT),
    W("ground_beef_85_cooked", "Ground beef 85/15, cooked", "", 3, "oz", 85, [230, 26, 0, 13.5, 0, 0, 80], MEAT),
    L("kirkland_ground_beef_88", "Ground beef 88/12, raw (Kirkland)", "Kirkland", 4, "oz", 112, [220, 21, 0, 15, 0, 0, 75], MEAT),
    W("ground_beef_90_raw", "Ground beef 90/10, raw", "", 4, "oz", 113, [176, 20, 0, 10, 0, 0, 66], MEAT),
    W("ground_beef_90_cooked", "Ground beef 90/10, cooked", "", 3, "oz", 85, [200, 27, 0, 10, 0, 0, 76], MEAT),
    W("ground_beef_93_raw", "Ground beef 93/7, raw", "", 4, "oz", 113, [152, 21, 0, 7, 0, 0, 70], MEAT),
    W("ground_beef_93_cooked", "Ground beef 93/7, cooked", "", 3, "oz", 85, [175, 26, 0, 8, 0, 0, 75], MEAT),
    W("sirloin_cooked", "Sirloin steak, cooked (trimmed)", "", 6, "oz", 170, [206, 29.5, 0, 9, 0, 0, 60], MEAT),
    W("ribeye_cooked", "Ribeye steak, cooked", "", 6, "oz", 170, [291, 24, 0, 21, 0, 0, 55], MEAT),
    W("pork_chop_cooked", "Pork chop, boneless, cooked", "", 4, "oz", 113, [197, 27.8, 0, 8.9, 0, 0, 58], MEAT),
    W("pork_tenderloin_cooked", "Pork tenderloin, cooked", "", 4, "oz", 113, [143, 26, 0, 3.5, 0, 0, 55], MEAT),
    W("bacon_cooked", "Bacon, cooked", "", 2, "slices", 16, [541, 37, 1.4, 42, 0, 0, 1900], ["1 slice", 8, "3 slices", 24, "1 oz", 28, "100 g", 100]),
    L("turkey_bacon", "Turkey bacon, cooked", "", 2, "slices", 30, [60, 5, 1, 4.5, 0, 0, 340], ["1 slice", 15, "100 g", 100]),
    L("pork_sausage_links", "Breakfast sausage links, pork, cooked (Johnsonville-style)", "", 3, "links", 64, [180, 9, 1, 15, 0, 0, 470], ["1 link", 21, "2 links", 43, "100 g", 100]),
    L("chicken_sausage", "Chicken sausage link (Aidells-style)", "", 1, "link", 85, [170, 13, 4, 11, 0, 3, 560], ["1/2 link", 43, "100 g", 100]),
    L("hot_dog", "Hot dog, beef (no bun)", "", 1, "frank", 45, [150, 5, 2, 13, 0, 1, 500], ["100 g", 100]),
    W("turkey_breast_cooked", "Turkey breast, roasted, no skin", "", 4, "oz", 113, [145, 30, 0, 2.1, 0, 0, 99], MEAT),
    W("ground_turkey_93_raw", "Ground turkey 93/7, raw", "", 4, "oz", 113, [150, 18.7, 0, 8.3, 0, 0, 70], MEAT),
    W("ground_turkey_93_cooked", "Ground turkey 93/7, cooked", "", 3, "oz", 85, [200, 26, 0, 10.5, 0, 0, 90], MEAT),
    L("deli_turkey", "Deli turkey breast, sliced", "", 2, "oz", 56, [60, 12, 1, 0.5, 0, 1, 450], ["1 slice", 28, "3 oz", 85, "100 g", 100]),
    L("kroger_deli_turkey", "Oven roasted turkey breast, deli sliced (Kroger)", "Kroger", 2, "oz", 56, [50, 11, 1, 0.5, 0, 1, 470], ["1 slice", 28, "3 oz", 85, "100 g", 100]),
    L("deli_ham", "Deli ham, sliced", "", 2, "oz", 56, [60, 10, 2, 1.5, 0, 1, 520], ["1 slice", 28, "3 oz", 85, "100 g", 100]),
    W("salmon_cooked", "Salmon, Atlantic, cooked", "", 6, "oz", 170, [206, 22.1, 0, 12.4, 0, 0, 61], MEAT),
    W("kirkland_salmon_raw", "Salmon, Atlantic, raw (Kirkland fresh)", "Kirkland", 6, "oz", 170, [208, 20.4, 0, 13.4, 0, 0, 59], MEAT),
    W("sockeye_salmon_cooked", "Salmon, wild sockeye, cooked", "", 6, "oz", 170, [156, 26.5, 0, 5.6, 0, 0, 78], MEAT),
    W("tilapia_cooked", "Tilapia, cooked", "", 4, "oz", 113, [128, 26.2, 0, 2.7, 0, 0, 56], MEAT),
    W("cod_cooked", "Cod, cooked", "", 4, "oz", 113, [105, 22.8, 0, 0.9, 0, 0, 78], MEAT),
    W("tuna_canned_water", "Tuna, canned in water, drained", "", 1, "can (4 oz drained)", 113, [116, 25.5, 0, 0.8, 0, 0, 320], ["1/2 can", 56, "1 oz", 28, "100 g", 100]),
    W("shrimp_cooked", "Shrimp, cooked", "", 4, "oz", 113, [99, 24, 0.2, 0.3, 0, 0, 111], ["1 large shrimp", 7, "6 large shrimp", 42, "3 oz", 85, "100 g", 100]),
    W("egg_large", "Egg, whole, large", "", 1, "large egg", 50, [143, 12.6, 0.7, 9.5, 0, 0.4, 142], ["2 eggs", 100, "3 eggs", 150, "100 g", 100]),
    L("kirkland_eggs", "Eggs, large (Kirkland)", "Kirkland", 1, "large egg", 50, [70, 6, 0, 5, 0, 0, 70], ["2 eggs", 100, "3 eggs", 150, "100 g", 100]),
    W("egg_hard_boiled", "Egg, hard-boiled", "", 1, "large egg", 50, [155, 12.6, 1.1, 10.6, 0, 1.1, 124], ["2 eggs", 100, "100 g", 100]),
    W("egg_white", "Egg white, large", "", 1, "large egg white", 33, [52, 10.9, 0.7, 0.2, 0, 0.7, 166], ["2 whites", 66, "3 whites", 99, "100 g", 100]),
    L("egg_whites_carton", "Egg whites, liquid carton", "", 3, "tbsp", 46, [25, 5, 0, 0, 0, 0, 75], ["1/2 cup", 122, "1 cup", 243, "100 g", 100]),
    L("fage_0", "Greek yogurt, plain 0% (Fage)", "Fage", 1, "container (7 oz)", 170, [90, 18, 5, 0, 0, 5, 55], ["1/2 cup", 113, "1 cup", 227, "100 g", 100]),
    W("greek_yogurt_0", "Greek yogurt, plain nonfat", "", 1, "cup", 227, [59, 10.2, 3.6, 0.4, 0, 3.2, 36], ["1/2 cup", 113, "3/4 cup", 170, "100 g", 100]),
    W("greek_yogurt_2", "Greek yogurt, plain 2%", "", 1, "container (6 oz)", 170, [73, 9.9, 3.9, 1.9, 0, 3.6, 34], ["1/2 cup", 113, "1 cup", 227, "100 g", 100]),
    W("greek_yogurt_5", "Greek yogurt, plain 5% (whole milk)", "", 1, "container (6 oz)", 170, [97, 9, 4, 5, 0, 4, 35], ["1/2 cup", 113, "1 cup", 227, "100 g", 100]),
    L("kroger_greek_yogurt", "Greek yogurt, plain nonfat (Kroger)", "Kroger", 0.75, "cup", 170, [100, 17, 7, 0, 0, 5, 65], ["1/2 cup", 113, "1 cup", 227, "100 g", 100]),
    L("chobani_plain_nonfat", "Greek yogurt, plain nonfat (Chobani)", "Chobani", 1, "container (5.3 oz)", 150, [80, 14, 6, 0, 0, 4, 60], ["1/2 cup", 113, "1 cup", 227, "100 g", 100]),
    L("chobani_strawberry", "Greek yogurt, strawberry, nonfat (Chobani)", "Chobani", 1, "container (5.3 oz)", 150, [130, 12, 19, 0, 0, 15, 60], ["100 g", 100]),
    L("oikos_triple_zero", "Greek yogurt, Triple Zero (Oikos)", "Oikos", 1, "container (5.3 oz)", 150, [100, 15, 8, 0, 3, 4, 65], ["100 g", 100]),
    L("oikos_pro", "Greek yogurt, Oikos Pro 20g", "Oikos", 1, "container (5.3 oz)", 150, [130, 20, 9, 1.5, 0, 7, 75], ["100 g", 100]),
    W("cottage_cheese_2", "Cottage cheese, 2%", "", 0.5, "cup", 113, [84, 11, 4.3, 2.3, 0, 4, 330], ["1 cup", 226, "3/4 cup", 170, "100 g", 100]),
    W("cottage_cheese_4", "Cottage cheese, 4%", "", 0.5, "cup", 113, [98, 11.1, 3.4, 4.3, 0, 2.7, 364], ["1 cup", 226, "3/4 cup", 170, "100 g", 100]),
    L("kroger_cottage_cheese", "Cottage cheese, 2% (Kroger)", "Kroger", 0.5, "cup", 113, [90, 12, 5, 2.5, 0, 4, 400], ["1 cup", 226, "100 g", 100]),
    L("whey_protein", "Whey protein powder", "", 1, "scoop", 31, [120, 24, 3, 1.5, 0, 1, 60], ["1/2 scoop", 15.5, "2 scoops", 62, "100 g", 100]),
    L("casein_protein", "Casein protein powder", "", 1, "scoop", 33, [120, 24, 3, 1, 0, 1, 200], ["1/2 scoop", 16.5, "2 scoops", 66, "100 g", 100]),
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
    L("kirkland_protein_bar", "Protein bar, chocolate chip cookie dough (Kirkland)", "Kirkland", 1, "bar", 60, [190, 21, 22, 7, 10, 2, 220], ["1/2 bar", 30, "100 g", 100]),
    L("fairlife_2", "Milk, 2% ultra-filtered (Fairlife)", "Fairlife", 1, "cup", 245, [120, 13, 6, 4.5, 0, 6, 120], ["1/2 cup", 122, "12 oz", 367, "100 g", 100]),
    L("core_power_26", "Core Power 26g protein shake (Fairlife)", "Fairlife", 1, "bottle (14 oz)", 414, [170, 26, 8, 3.5, 0, 7, 240], ["1/2 bottle", 207, "100 g", 100]),
    L("core_power_42", "Core Power Elite 42g protein shake (Fairlife)", "Fairlife", 1, "bottle (14 oz)", 414, [230, 42, 9, 3.5, 0, 7, 290], ["1/2 bottle", 207, "100 g", 100]),
    L("premier_protein", "Premier Protein shake, 30g", "Premier Protein", 1, "shake (11 oz)", 325, [160, 30, 4, 3, 1, 1, 230], ["1/2 shake", 163, "100 g", 100]),
    L("kodiak_mix", "Kodiak Power Cakes pancake mix, dry", "Kodiak", 0.5, "cup", 53, [190, 14, 30, 2, 3, 3, 380], ["1/4 cup", 27, "1 cup", 106, "100 g", 100]),
    L("kodiak_pancakes", "Protein pancakes (Kodiak, 3 pancakes made with water)", "Kodiak", 3, "pancakes", 120, [190, 14, 30, 2, 3, 3, 380], ["1 pancake", 40, "2 pancakes", 80, "100 g", 100]),
    L("dkb_21_grains", "Bread, 21 Whole Grains & Seeds (Dave's Killer Bread)", "Dave's Killer Bread", 1, "slice", 45, [110, 5, 22, 1.5, 5, 5, 170], ["2 slices", 90, "100 g", 100]),
    L("dkb_good_seed", "Bread, Good Seed (Dave's Killer Bread)", "Dave's Killer Bread", 1, "slice", 45, [120, 5, 22, 2, 5, 5, 170], ["2 slices", 90, "100 g", 100]),
    L("dkb_thin", "Bread, 21 Whole Grains thin-sliced (Dave's Killer Bread)", "Dave's Killer Bread", 1, "slice", 28, [60, 3, 12, 1, 3, 3, 90], ["2 slices", 56, "100 g", 100]),
    L("kirkland_peanut_butter", "Peanut butter, organic creamy (Kirkland)", "Kirkland", 2, "tbsp", 32, [190, 8, 6, 16, 3, 1, 90], ["1 tbsp", 16, "100 g", 100]),
    W("kirkland_almonds", "Almonds, whole (Kirkland)", "Kirkland", 1, "oz (23 almonds)", 28, [579, 21.2, 21.6, 49.9, 12.5, 4.4, 1], ["1/4 cup", 35, "10 almonds", 12, "100 g", 100]),
    L("kroger_frozen_chicken", "Chicken breast, frozen boneless skinless (Kroger)", "Kroger", 4, "oz", 112, [110, 23, 0, 1.5, 0, 0, 300], MEAT)
  );
  /* --------------------------------------------------------------- CARBS */
  G.push(
    W("white_rice_cooked", "White rice, cooked", "", 1, "cup", 158, [130, 2.7, 28.2, 0.3, 0.4, 0.1, 1], ["1/2 cup", 79, "3/4 cup", 118, "100 g", 100]),
    W("brown_rice_cooked", "Brown rice, cooked", "", 1, "cup", 195, [123, 2.7, 25.6, 1, 1.6, 0.2, 4], ["1/2 cup", 98, "3/4 cup", 146, "100 g", 100]),
    W("jasmine_rice_cooked", "Jasmine rice, cooked", "", 1, "cup", 158, [129, 2.7, 28.6, 0.2, 0.3, 0, 1], ["1/2 cup", 79, "100 g", 100]),
    W("white_rice_dry", "White rice, dry (uncooked)", "", 0.25, "cup", 46, [365, 7.1, 80, 0.7, 1.3, 0.1, 5], ["1/2 cup", 92, "1 cup", 185, "100 g", 100]),
    W("quinoa_cooked", "Quinoa, cooked", "", 1, "cup", 185, [120, 4.4, 21.3, 1.9, 2.8, 0.9, 7], ["1/2 cup", 93, "100 g", 100]),
    W("oats_dry", "Oats, old fashioned, dry", "", 0.5, "cup", 40, [379, 13.2, 67.7, 6.5, 10.1, 1, 6], ["1/4 cup", 20, "1 cup", 80, "100 g", 100]),
    W("oatmeal_cooked", "Oatmeal, cooked with water", "", 1, "cup", 234, [71, 2.5, 12, 1.5, 1.7, 0.3, 4], ["1/2 cup", 117, "100 g", 100]),
    W("potato_baked", "Potato, baked, with skin", "", 1, "medium", 173, [93, 2.5, 21.2, 0.1, 2.2, 1.2, 10], ["1 small", 138, "1 large", 299, "100 g", 100]),
    W("potato_boiled", "Potato, boiled or roasted, no oil", "", 1, "cup", 156, [87, 1.9, 20.1, 0.1, 1.8, 0.9, 4], ["1/2 cup", 78, "100 g", 100]),
    W("sweet_potato_baked", "Sweet potato, baked, with skin", "", 1, "medium", 114, [90, 2, 20.7, 0.2, 3.3, 6.5, 36], ["1 small", 60, "1 large", 180, "1 cup cubes", 200, "100 g", 100]),
    W("french_fries", "French fries, fast food", "", 1, "medium serving", 117, [312, 3.4, 41, 15, 3.8, 0.3, 210], ["small", 71, "large", 154, "100 g", 100]),
    W("hash_browns", "Hash browns, fried", "", 1, "cup", 156, [265, 3, 35, 13, 3, 0.5, 340], ["1 patty", 64, "100 g", 100]),
    W("white_bread", "Bread, white, sandwich slice", "", 1, "slice", 28, [266, 8.9, 49, 3.3, 2.4, 5.3, 490], ["2 slices", 56, "100 g", 100]),
    W("whole_wheat_bread", "Bread, whole wheat, slice", "", 1, "slice", 32, [252, 12.3, 43, 3.4, 6, 4.3, 455], ["2 slices", 64, "100 g", 100]),
    W("sourdough", "Bread, sourdough, slice", "", 1, "slice", 50, [274, 10.7, 52, 2.4, 2.2, 3, 590], ["2 slices", 100, "100 g", 100]),
    W("bagel_plain", "Bagel, plain", "", 1, "bagel", 98, [270, 10.5, 53, 1.4, 2.2, 6, 480], ["1/2 bagel", 49, "1 mini bagel", 26, "100 g", 100]),
    W("english_muffin", "English muffin", "", 1, "muffin", 57, [235, 8.8, 46, 1.8, 3.5, 3.4, 400], ["1/2 muffin", 29, "100 g", 100]),
    L("tortilla_flour", "Tortilla, flour, 8 in", "", 1, "tortilla", 45, [140, 4, 24, 3.5, 1, 1, 330], ["1 burrito size (10 in)", 70, "1 taco size (6 in)", 30, "100 g", 100]),
    L("tortilla_corn", "Tortilla, corn, 6 in", "", 1, "tortilla", 26, [60, 1, 12, 1, 1, 0, 10], ["2 tortillas", 52, "3 tortillas", 78, "100 g", 100]),
    L("low_carb_tortilla", "Tortilla, low carb (Mission Carb Balance)", "Mission", 1, "tortilla", 43, [70, 5, 19, 2, 15, 1, 330], ["100 g", 100]),
    W("pasta_cooked", "Pasta, cooked", "", 1, "cup", 140, [158, 5.8, 31, 0.9, 1.8, 0.6, 1], ["1/2 cup", 70, "2 cups", 280, "100 g", 100]),
    W("pasta_dry", "Pasta, dry (uncooked)", "", 2, "oz", 56, [371, 13, 74.7, 1.5, 3.2, 2.7, 6], ["1 oz", 28, "100 g", 100]),
    L("banza_pasta", "Chickpea pasta, dry (Banza)", "Banza", 2, "oz", 56, [190, 11, 32, 3.5, 5, 2, 60], ["1 oz", 28, "100 g", 100]),
    W("couscous_cooked", "Couscous, cooked", "", 1, "cup", 157, [112, 3.8, 23.2, 0.2, 1.4, 0.1, 5], ["1/2 cup", 79, "100 g", 100]),
    L("rice_cake", "Rice cake, plain", "", 1, "cake", 9, [35, 0.7, 7.3, 0.3, 0.4, 0, 2], ["2 cakes", 18, "3 cakes", 27, "100 g", 100]),
    L("cheerios", "Cheerios cereal", "General Mills", 1.5, "cups", 39, [140, 5, 29, 2.5, 4, 2, 190], ["1 cup", 26, "2 cups", 52, "100 g", 100]),
    L("honey_nut_cheerios", "Honey Nut Cheerios cereal", "General Mills", 1, "cup", 37, [140, 3, 30, 2, 3, 12, 190], ["1.5 cups", 56, "100 g", 100]),
    L("granola", "Granola", "", 0.5, "cup", 55, [250, 6, 36, 10, 4, 12, 60], ["1/4 cup", 28, "1 cup", 110, "100 g", 100]),
    L("cream_of_rice", "Cream of rice, dry", "", 0.25, "cup", 45, [160, 3, 36, 0, 0, 0, 0], ["1/2 cup", 90, "100 g", 100]),
    L("frozen_waffle", "Waffle, frozen, toasted (Eggo-style)", "", 2, "waffles", 70, [190, 4, 29, 6, 1, 4, 380], ["1 waffle", 35, "100 g", 100]),
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
    W("cheddar", "Cheese, cheddar", "", 1, "oz", 28, [403, 22.9, 3.1, 33.3, 0, 0.5, 653], ["1 slice", 21, "1/4 cup shredded", 28, "100 g", 100]),
    W("mozzarella", "Cheese, mozzarella, part skim", "", 1, "oz", 28, [254, 24.3, 2.8, 15.9, 0, 1, 619], ["1/4 cup shredded", 28, "100 g", 100]),
    W("feta", "Cheese, feta", "", 1, "oz", 28, [264, 14.2, 4.1, 21.3, 0, 0.5, 917], ["1/4 cup crumbled", 38, "100 g", 100]),
    W("parmesan", "Cheese, parmesan, grated", "", 1, "tbsp", 5, [431, 38.5, 4.1, 28.6, 0, 0.9, 1529], ["1/4 cup", 20, "1 oz", 28, "100 g", 100]),
    L("string_cheese", "String cheese, mozzarella", "", 1, "stick", 28, [80, 7, 1, 6, 0, 0, 200], ["2 sticks", 56, "100 g", 100]),
    W("swiss_cheese", "Cheese, Swiss", "", 1, "slice", 28, [393, 27, 1.4, 31, 0, 1.3, 187], ["1 oz", 28, "100 g", 100]),
    W("pepper_jack", "Cheese, pepper jack", "", 1, "oz", 28, [375, 23, 2, 30, 0, 0.5, 620], ["1 slice", 21, "100 g", 100]),
    W("american_cheese", "Cheese, American, slice", "", 1, "slice", 21, [340, 18, 5, 27, 0, 3, 1300], ["2 slices", 42, "100 g", 100]),
    W("cream_cheese", "Cream cheese", "", 2, "tbsp", 29, [342, 6.2, 5.5, 34, 0, 3.8, 314], ["1 tbsp", 14.5, "1 oz", 28, "100 g", 100]),
    W("mayo", "Mayonnaise", "", 1, "tbsp", 14, [680, 1, 0.6, 75, 0, 0.6, 635], ["1 tsp", 4.7, "2 tbsp", 28, "100 g", 100]),
    L("ranch", "Ranch dressing", "", 2, "tbsp", 30, [130, 0, 2, 13, 0, 1, 260], ["1 tbsp", 15, "100 g", 100]),
    W("sour_cream", "Sour cream", "", 2, "tbsp", 30, [198, 2.4, 4.6, 19.4, 0, 3.4, 31], ["1 tbsp", 15, "1/4 cup", 60, "100 g", 100]),
    W("heavy_cream", "Heavy cream", "", 1, "tbsp", 15, [340, 2.8, 2.8, 36, 0, 2.9, 27], ["2 tbsp", 30, "1/4 cup", 60, "100 g", 100]),
    W("half_and_half", "Half and half", "", 2, "tbsp", 30, [131, 3.1, 4.3, 11.5, 0, 4, 41], ["1 tbsp", 15, "100 g", 100])
  );
  /* --------------------------------------------------------------- FRUIT */
  G.push(
    W("banana", "Banana", "", 1, "medium", 118, [89, 1.1, 22.8, 0.3, 2.6, 12.2, 1], ["1 small", 101, "1 large", 136, "1/2 banana", 59, "100 g", 100]),
    W("apple", "Apple, with skin", "", 1, "medium", 182, [52, 0.3, 13.8, 0.2, 2.4, 10.4, 1], ["1 small", 149, "1 large", 223, "1 cup slices", 109, "100 g", 100]),
    W("orange", "Orange", "", 1, "medium", 131, [47, 0.9, 11.8, 0.1, 2.4, 9.4, 0], ["1 small", 96, "1 large", 184, "100 g", 100]),
    W("strawberries", "Strawberries", "", 1, "cup, halves", 152, [32, 0.7, 7.7, 0.3, 2, 4.9, 1], ["1 berry", 12, "1/2 cup", 76, "100 g", 100]),
    W("blueberries", "Blueberries", "", 1, "cup", 148, [57, 0.7, 14.5, 0.3, 2.4, 10, 1], ["1/2 cup", 74, "100 g", 100]),
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
    W("broccoli_cooked", "Broccoli, cooked", "", 1, "cup, chopped", 156, [35, 2.4, 7.2, 0.4, 3.3, 1.4, 41], ["1/2 cup", 78, "100 g", 100]),
    W("broccoli_raw", "Broccoli, raw", "", 1, "cup, chopped", 91, [34, 2.8, 6.6, 0.4, 2.6, 1.7, 33], ["100 g", 100]),
    W("spinach_raw", "Spinach, raw", "", 2, "cups", 60, [23, 2.9, 3.6, 0.4, 2.2, 0.4, 79], ["1 cup", 30, "100 g", 100]),
    W("spinach_cooked", "Spinach, cooked", "", 1, "cup", 180, [23, 3, 3.8, 0.3, 2.4, 0.4, 70], ["1/2 cup", 90, "100 g", 100]),
    W("kale_raw", "Kale, raw", "", 1, "cup, chopped", 21, [49, 4.3, 8.8, 0.9, 3.6, 2.3, 38], ["2 cups", 42, "100 g", 100]),
    W("lettuce_romaine", "Lettuce, romaine", "", 2, "cups, shredded", 94, [17, 1.2, 3.3, 0.3, 2.1, 1.2, 8], ["1 cup", 47, "100 g", 100]),
    W("spring_mix", "Spring mix / mixed greens", "", 2, "cups", 85, [20, 1.8, 3.5, 0.3, 1.8, 0.8, 30], ["1 cup", 42, "100 g", 100]),
    W("tomato", "Tomato", "", 1, "medium", 123, [18, 0.9, 3.9, 0.2, 1.2, 2.6, 5], ["1 cup chopped", 180, "1 slice", 20, "100 g", 100]),
    W("cherry_tomatoes", "Cherry tomatoes", "", 1, "cup", 149, [18, 0.9, 3.9, 0.2, 1.2, 2.6, 5], ["5 tomatoes", 85, "100 g", 100]),
    W("cucumber", "Cucumber, with peel", "", 1, "cup, sliced", 104, [15, 0.7, 3.6, 0.1, 0.5, 1.7, 2], ["1/2 cucumber", 150, "100 g", 100]),
    W("bell_pepper", "Bell pepper, red", "", 1, "medium", 119, [31, 1, 6, 0.3, 2.1, 4.2, 4], ["1 cup chopped", 149, "100 g", 100]),
    W("carrots", "Carrots, raw", "", 1, "medium", 61, [41, 0.9, 9.6, 0.2, 2.8, 4.7, 69], ["1 cup chopped", 128, "10 baby carrots", 100, "100 g", 100]),
    W("onion", "Onion, raw", "", 0.5, "cup, chopped", 80, [40, 1.1, 9.3, 0.1, 1.7, 4.2, 4], ["1 medium", 110, "1 tbsp", 10, "100 g", 100]),
    W("mushrooms", "Mushrooms, white, raw", "", 1, "cup, sliced", 70, [22, 3.1, 3.3, 0.3, 1, 2, 5], ["100 g", 100]),
    W("green_beans", "Green beans, cooked", "", 1, "cup", 125, [35, 1.9, 7.9, 0.3, 3.2, 3.6, 1], ["1/2 cup", 63, "100 g", 100]),
    W("asparagus", "Asparagus, cooked", "", 6, "spears", 90, [22, 2.4, 4.1, 0.2, 2, 1.3, 14], ["1 cup", 180, "100 g", 100]),
    W("corn", "Corn, sweet, cooked", "", 1, "cup", 164, [96, 3.4, 21, 1.5, 2.4, 4.5, 1], ["1 ear", 103, "1/2 cup", 82, "100 g", 100]),
    W("peas", "Peas, green, cooked", "", 1, "cup", 160, [84, 5.4, 15.6, 0.2, 5.5, 5.9, 3], ["1/2 cup", 80, "100 g", 100]),
    W("zucchini", "Zucchini, cooked", "", 1, "cup, sliced", 180, [15, 1.1, 2.7, 0.4, 1, 1.7, 3], ["1 medium", 196, "100 g", 100]),
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
    L("oat_milk", "Oat milk (Oatly-style)", "", 1, "cup", 240, [120, 3, 16, 5, 2, 7, 100], ["1/2 cup", 120, "100 g", 100]),
    L("chocolate_milk_fairlife", "Chocolate milk, 2% ultra-filtered (Fairlife)", "Fairlife", 1, "cup", 245, [140, 13, 13, 4.5, 0, 12, 140], ["100 g", 100]),
    L("kefir", "Kefir, plain low-fat", "", 1, "cup", 240, [110, 11, 12, 2, 0, 12, 125], ["100 g", 100]),
    L("coffee_black", "Coffee, black", "", 12, "oz", 355, [4, 0.4, 0, 0, 0, 0, 7], ["8 oz", 237, "16 oz", 473, "100 g", 100]),
    L("coffee_creamer", "Coffee with 2 tbsp half & half", "", 12, "oz", 385, [45, 1.5, 1.5, 3.5, 0, 1.5, 25], ["100 g", 100]),
    L("latte", "Latte, 2% milk, 16 oz", "", 16, "oz", 473, [190, 13, 19, 7, 0, 18, 170], ["12 oz", 355, "100 g", 100]),
    L("latte_oat", "Latte, oat milk, 16 oz", "", 16, "oz", 473, [220, 6, 30, 9, 3, 15, 200], ["12 oz", 355, "100 g", 100]),
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
    L("hard_seltzer", "Hard seltzer (White Claw-style)", "", 12, "oz", 355, [100, 0, 2, 0, 0, 1, 10], ["100 g", 100], { alcohol: true }),
    L("soda", "Soda, regular (Coke)", "", 12, "oz can", 368, [140, 0, 39, 0, 0, 39, 45], ["20 oz bottle", 613, "100 g", 100]),
    L("diet_soda", "Diet soda / Coke Zero", "", 12, "oz can", 355, [0, 0, 0, 0, 0, 0, 40], ["20 oz bottle", 591, "100 g", 100]),
    L("gatorade", "Gatorade", "", 20, "oz", 600, [140, 0, 36, 0, 0, 34, 270], ["12 oz", 360, "100 g", 100]),
    L("energy_drink_zero", "Energy drink, sugar free (Celsius / Monster Zero)", "", 12, "oz can", 355, [10, 0, 2, 0, 0, 0, 10], ["16 oz can", 473, "100 g", 100]),
    L("electrolyte_packet", "Electrolyte drink mix (LMNT-style)", "", 1, "packet", 6, [10, 0, 2, 0, 0, 0, 1000], ["2 packets", 12]),
    L("water", "Water", "", 16, "oz", 473, [0, 0, 0, 0, 0, 0, 0], ["8 oz", 237, "100 g", 100])
  );
  /* ------------------------------------------------------- CONDIMENTS / SAUCES */
  G.push(
    L("ketchup", "Ketchup", "", 1, "tbsp", 17, [20, 0, 5, 0, 0, 4, 160], ["2 tbsp", 34, "100 g", 100]),
    L("mustard", "Mustard, yellow", "", 1, "tsp", 5, [3, 0.2, 0.3, 0.2, 0.1, 0.1, 55], ["1 tbsp", 15, "100 g", 100]),
    L("hot_sauce", "Hot sauce (Cholula / Tapatio)", "", 1, "tsp", 5, [0, 0, 0, 0, 0, 0, 110], ["1 tbsp", 15, "100 g", 100]),
    L("sriracha", "Sriracha", "", 1, "tsp", 5, [5, 0, 1, 0, 0, 1, 80], ["1 tbsp", 15, "100 g", 100]),
    L("soy_sauce", "Soy sauce", "", 1, "tbsp", 16, [10, 1.3, 0.8, 0, 0, 0.1, 880], ["1 tsp", 5, "100 g", 100]),
    L("bbq_sauce", "BBQ sauce", "", 2, "tbsp", 36, [70, 0, 17, 0, 0, 12, 320], ["1 tbsp", 18, "100 g", 100]),
    L("honey", "Honey", "", 1, "tbsp", 21, [64, 0.1, 17.3, 0, 0, 17.2, 1], ["1 tsp", 7, "100 g", 100]),
    L("maple_syrup", "Maple syrup, pure", "", 2, "tbsp", 40, [104, 0, 27, 0, 0, 24, 5], ["1 tbsp", 20, "1/4 cup", 80, "100 g", 100]),
    L("jam", "Jam / jelly", "", 1, "tbsp", 20, [56, 0.1, 13.8, 0, 0.2, 9.7, 6], ["2 tbsp", 40, "100 g", 100]),
    L("salsa", "Salsa", "", 2, "tbsp", 32, [10, 0.4, 2, 0, 0.5, 1, 190], ["1/4 cup", 64, "100 g", 100]),
    L("guacamole", "Guacamole", "", 2, "tbsp", 30, [50, 0.6, 2.5, 4.5, 2, 0.3, 90], ["1/4 cup", 60, "1 mini cup (2 oz)", 57, "100 g", 100]),
    L("hummus", "Hummus", "", 2, "tbsp", 30, [70, 2, 4, 5, 1, 0, 130], ["1/4 cup", 60, "100 g", 100]),
    L("tzatziki", "Tzatziki", "", 2, "tbsp", 30, [35, 1, 1, 3, 0, 1, 90], ["1/4 cup", 60, "100 g", 100]),
    L("marinara", "Marinara / pasta sauce", "", 0.5, "cup", 125, [70, 2, 10, 2.5, 2, 6, 430], ["1/4 cup", 63, "100 g", 100]),
    L("alfredo", "Alfredo sauce, jarred", "", 0.25, "cup", 62, [100, 2, 3, 9, 0, 1, 360], ["1/2 cup", 124, "100 g", 100]),
    L("pesto", "Pesto", "", 2, "tbsp", 30, [130, 3, 2, 12, 1, 0, 190], ["1 tbsp", 15, "100 g", 100]),
    L("teriyaki", "Teriyaki sauce", "", 1, "tbsp", 18, [16, 1, 3, 0, 0, 2.5, 690], ["2 tbsp", 36, "100 g", 100]),
    L("buffalo_sauce", "Buffalo wing sauce (Frank's)", "", 1, "tbsp", 15, [0, 0, 0, 0, 0, 0, 460], ["2 tbsp", 30, "100 g", 100]),
    L("italian_dressing", "Italian dressing", "", 2, "tbsp", 30, [70, 0, 3, 6, 0, 2, 300], ["1 tbsp", 15, "100 g", 100]),
    L("caesar_dressing", "Caesar dressing", "", 2, "tbsp", 30, [150, 1, 1, 16, 0, 1, 300], ["1 tbsp", 15, "100 g", 100]),
    L("balsamic_vinaigrette", "Balsamic vinaigrette", "", 2, "tbsp", 30, [90, 0, 4, 8, 0, 3, 250], ["1 tbsp", 15, "100 g", 100]),
    L("light_mayo", "Mayonnaise, light", "", 1, "tbsp", 15, [35, 0, 1, 3.5, 0, 0, 125], ["100 g", 100]),
    L("sugar", "Sugar, white", "", 1, "tsp", 4, [16, 0, 4, 0, 0, 4, 0], ["1 tbsp", 12, "100 g", 100]),
    L("taco_seasoning", "Taco seasoning packet", "", 2, "tsp", 6, [15, 0, 3, 0, 0, 0, 380], ["100 g", 100])
  );
  /* ------------------------------------------------------------ COMMON MEALS */
  G.push(
    L("burrito_chicken", "Burrito, chicken (restaurant, with rice, beans, cheese)", "", 1, "burrito", 450, [980, 50, 105, 38, 12, 5, 2100], ["1/2 burrito", 225, "100 g", 100]),
    L("breakfast_burrito", "Breakfast burrito (egg, cheese, sausage)", "", 1, "burrito", 250, [560, 24, 42, 32, 3, 3, 1150], ["1/2 burrito", 125, "100 g", 100]),
    L("cheeseburger", "Cheeseburger, single (fast food)", "", 1, "burger", 150, [400, 22, 33, 20, 1, 7, 900], ["100 g", 100]),
    L("cheeseburger_double", "Double cheeseburger (fast food)", "", 1, "burger", 210, [560, 32, 34, 32, 1, 7, 1200], ["100 g", 100]),
    L("pizza_slice", "Pizza, cheese, 1 slice of large (14 in)", "", 1, "slice", 107, [285, 12, 36, 10, 2.5, 4, 640], ["2 slices", 214, "100 g", 100]),
    L("pizza_slice_pepperoni", "Pizza, pepperoni, 1 slice of large (14 in)", "", 1, "slice", 113, [313, 13, 36, 13, 2.5, 4, 760], ["2 slices", 226, "100 g", 100]),
    L("costco_pizza_slice", "Pizza, cheese slice (Costco food court)", "Costco", 1, "slice", 300, [700, 44, 70, 28, 3, 6, 1370], ["1/2 slice", 150, "100 g", 100]),
    L("costco_hot_dog", "Hot dog with bun (Costco food court)", "Costco", 1, "hot dog", 200, [570, 24, 46, 32, 2, 8, 1750], ["100 g", 100]),
    L("chicken_sandwich", "Chicken sandwich, crispy (fast food)", "", 1, "sandwich", 190, [500, 28, 46, 22, 2, 6, 1350], ["100 g", 100]),
    L("chicken_sandwich_grilled", "Chicken sandwich, grilled (fast food)", "", 1, "sandwich", 200, [380, 30, 42, 10, 3, 8, 900], ["100 g", 100]),
    L("chipotle_chicken", "Chicken (Chipotle)", "Chipotle", 1, "serving", 113, [180, 32, 0, 7, 0, 0, 310], ["double", 226, "100 g", 100]),
    L("chipotle_steak", "Steak (Chipotle)", "Chipotle", 1, "serving", 113, [150, 21, 1, 6, 0, 0, 330], ["double", 226, "100 g", 100]),
    L("chipotle_white_rice", "White rice (Chipotle)", "Chipotle", 1, "serving", 113, [210, 4, 40, 4, 1, 0, 350], ["1/2 serving", 57, "100 g", 100]),
    L("chipotle_brown_rice", "Brown rice (Chipotle)", "Chipotle", 1, "serving", 113, [210, 4, 36, 6, 2, 0, 190], ["1/2 serving", 57, "100 g", 100]),
    L("chipotle_black_beans", "Black beans (Chipotle)", "Chipotle", 1, "serving", 113, [130, 8, 22, 1.5, 7, 2, 210], ["100 g", 100]),
    L("chipotle_pinto_beans", "Pinto beans (Chipotle)", "Chipotle", 1, "serving", 113, [130, 8, 21, 1.5, 8, 1, 210], ["100 g", 100]),
    L("chipotle_fajita_veg", "Fajita veggies (Chipotle)", "Chipotle", 1, "serving", 57, [20, 1, 5, 0, 1, 2, 150], ["100 g", 100]),
    L("chipotle_salsa_tomato", "Fresh tomato salsa (Chipotle)", "Chipotle", 1, "serving", 113, [25, 0, 4, 0, 1, 1, 550], ["100 g", 100]),
    L("chipotle_corn_salsa", "Roasted chili-corn salsa (Chipotle)", "Chipotle", 1, "serving", 113, [80, 3, 16, 1.5, 3, 4, 330], ["100 g", 100]),
    L("chipotle_cheese", "Cheese (Chipotle)", "Chipotle", 1, "serving", 28, [110, 6, 1, 8, 0, 0, 190], ["100 g", 100]),
    L("chipotle_sour_cream", "Sour cream (Chipotle)", "Chipotle", 1, "serving", 57, [110, 2, 2, 9, 0, 2, 30], ["100 g", 100]),
    L("chipotle_guac", "Guacamole (Chipotle)", "Chipotle", 1, "serving", 113, [230, 2, 8, 22, 6, 1, 370], ["100 g", 100]),
    L("chipotle_tortilla", "Flour tortilla, burrito (Chipotle)", "Chipotle", 1, "tortilla", 113, [320, 8, 50, 9, 3, 0, 600], ["100 g", 100]),
    L("chipotle_chips", "Chips (Chipotle)", "Chipotle", 1, "bag", 113, [540, 7, 73, 25, 7, 1, 390], ["1/2 bag", 57, "100 g", 100]),
    L("california_roll", "Sushi, California roll (8 pieces)", "", 1, "roll", 190, [300, 9, 40, 10, 3, 6, 600], ["1 piece", 24, "100 g", 100]),
    L("spicy_tuna_roll", "Sushi, spicy tuna roll (8 pieces)", "", 1, "roll", 200, [330, 16, 40, 11, 2, 5, 650], ["1 piece", 25, "100 g", 100]),
    L("salmon_nigiri", "Sushi, salmon nigiri (2 pieces)", "", 2, "pieces", 70, [110, 7, 15, 2.5, 0, 2, 150], ["1 piece", 35, "100 g", 100]),
    L("ramen_restaurant", "Ramen, tonkotsu (restaurant bowl)", "", 1, "bowl", 700, [850, 40, 85, 38, 4, 5, 2300], ["1/2 bowl", 350, "100 g", 100]),
    L("ramen_instant", "Ramen, instant (1 package with seasoning)", "", 1, "package", 85, [380, 8, 52, 14, 2, 1, 1600], ["1/2 package", 43, "100 g", 100]),
    L("pho_beef", "Pho, beef (restaurant bowl)", "", 1, "bowl", 800, [520, 35, 65, 12, 3, 5, 1900], ["1/2 bowl", 400, "100 g", 100]),
    L("taco_street", "Taco, street style (carne asada, corn tortilla)", "", 1, "taco", 80, [150, 10, 12, 7, 1, 0, 250], ["2 tacos", 160, "3 tacos", 240, "100 g", 100]),
    L("taco_ground_beef", "Taco, hard shell, ground beef and cheese", "", 1, "taco", 100, [210, 10, 14, 13, 2, 1, 380], ["2 tacos", 200, "3 tacos", 300, "100 g", 100]),
    L("caesar_salad", "Caesar salad, side, with dressing", "", 1, "side salad", 150, [220, 6, 10, 18, 2, 2, 480], ["entree size", 300, "100 g", 100]),
    L("chicken_caesar_salad", "Chicken Caesar salad, entree", "", 1, "salad", 350, [520, 38, 14, 34, 3, 3, 1100], ["1/2 salad", 175, "100 g", 100]),
    L("protein_pancakes", "Protein pancakes, homemade (3 medium)", "", 3, "pancakes", 180, [330, 28, 36, 8, 4, 6, 500], ["1 pancake", 60, "100 g", 100]),
    L("pancakes_regular", "Pancakes, plain (3 medium, no syrup)", "", 3, "pancakes", 114, [260, 7, 44, 6, 2, 8, 550], ["1 pancake", 38, "100 g", 100]),
    L("grilled_cheese", "Grilled cheese sandwich", "", 1, "sandwich", 120, [400, 14, 32, 24, 1, 4, 800], ["100 g", 100]),
    L("pbj", "PB&J sandwich", "", 1, "sandwich", 100, [380, 12, 46, 17, 4, 15, 400], ["100 g", 100]),
    L("turkey_sandwich", "Turkey sandwich, deli (bread, turkey, cheese, mayo)", "", 1, "sandwich", 200, [420, 26, 40, 17, 4, 6, 1200], ["100 g", 100]),
    L("chicken_nuggets", "Chicken nuggets (fast food, 10 pc)", "", 10, "pieces", 160, [410, 23, 25, 24, 1, 0, 800], ["6 pieces", 96, "4 pieces", 64, "100 g", 100]),
    L("chicken_wings", "Chicken wings, fried (6 wings)", "", 6, "wings", 180, [480, 40, 8, 32, 0, 0, 900], ["1 wing", 30, "10 wings", 300, "100 g", 100]),
    L("chili", "Chili with beef and beans", "", 1, "cup", 250, [280, 20, 24, 12, 7, 5, 900], ["1/2 cup", 125, "100 g", 100]),
    L("chicken_noodle_soup", "Chicken noodle soup", "", 1, "cup", 245, [90, 6, 10, 2.5, 1, 1, 750], ["1 can", 490, "100 g", 100]),
    L("mac_and_cheese", "Macaroni and cheese, boxed, prepared", "", 1, "cup", 200, [350, 10, 48, 13, 2, 7, 700], ["1/2 cup", 100, "100 g", 100]),
    L("spaghetti_meat_sauce", "Spaghetti with meat sauce", "", 1.5, "cups", 375, [500, 25, 62, 16, 6, 10, 900], ["1 cup", 250, "100 g", 100]),
    L("fried_rice_chicken", "Fried rice with chicken (takeout)", "", 1, "cup", 200, [330, 14, 42, 12, 2, 2, 700], ["1/2 cup", 100, "100 g", 100]),
    L("orange_chicken", "Orange chicken (Panda Express)", "Panda Express", 1, "serving", 155, [490, 25, 51, 23, 2, 19, 820], ["1/2 serving", 78, "100 g", 100]),
    L("costco_chicken_bake", "Chicken bake (Costco food court)", "Costco", 1, "chicken bake", 340, [770, 46, 80, 25, 3, 5, 1800], ["1/2 chicken bake", 170, "100 g", 100]),
    L("quesadilla_chicken", "Quesadilla, chicken and cheese", "", 1, "quesadilla", 200, [520, 30, 40, 26, 2, 2, 1100], ["1/2 quesadilla", 100, "100 g", 100]),
    L("egg_mcmuffin", "Egg McMuffin (McDonald's)", "McDonald's", 1, "sandwich", 135, [310, 17, 30, 13, 2, 3, 770], ["100 g", 100]),
    L("omelet_cheese", "Omelet, 3 eggs with cheese", "", 1, "omelet", 200, [400, 27, 3, 31, 0, 2, 600], ["100 g", 100])
  );
  /* ----------------------------------------------------------------- SNACKS */
  G.push(
    L("quest_chips", "Protein chips (Quest, 1 bag)", "Quest", 1, "bag", 32, [140, 19, 5, 4.5, 1, 1, 290], ["1/2 bag", 16, "100 g", 100]),
    L("quest_bar", "Protein bar (Quest, 1 bar)", "Quest", 1, "bar", 60, [190, 21, 22, 8, 12, 1, 300], ["1/2 bar", 30, "100 g", 100]),
    L("built_bar", "Protein bar (Built Puff)", "Built", 1, "bar", 40, [130, 17, 17, 4, 4, 6, 40], ["100 g", 100]),
    L("rxbar", "RXBAR", "RXBAR", 1, "bar", 52, [210, 12, 23, 9, 5, 13, 140], ["100 g", 100]),
    L("clif_bar", "Clif Bar", "Clif", 1, "bar", 68, [250, 9, 43, 6, 4, 20, 150], ["100 g", 100]),
    L("tortilla_chips", "Tortilla chips", "", 1, "oz (about 12 chips)", 28, [140, 2, 19, 7, 1, 0, 110], ["2 oz", 56, "100 g", 100]),
    L("potato_chips", "Potato chips", "", 1, "oz (about 15 chips)", 28, [160, 2, 15, 10, 1, 0, 170], ["2 oz", 56, "1 snack bag", 43, "100 g", 100]),
    L("popcorn_air", "Popcorn, air popped", "", 3, "cups", 24, [93, 3, 18.6, 1.1, 3.5, 0.2, 2], ["1 cup", 8, "5 cups", 40, "100 g", 100]),
    L("popcorn_microwave", "Popcorn, microwave, butter", "", 1, "bag", 85, [420, 6, 40, 27, 7, 0, 600], ["1/2 bag", 43, "3 cups", 24, "100 g", 100]),
    L("skinny_pop", "SkinnyPop popcorn", "SkinnyPop", 3.75, "cups", 28, [150, 2, 15, 10, 3, 0, 75], ["1 cup", 7.5, "100 g", 100]),
    W("pretzels", "Pretzels", "", 1, "oz", 28, [381, 10, 80, 2.6, 3.4, 2.2, 1240], ["10 mini twists", 30, "100 g", 100]),
    W("dark_chocolate", "Dark chocolate, 70%", "", 1, "oz", 28, [598, 7.8, 46, 43, 11, 24, 20], ["1 square", 10, "1/2 bar (50 g)", 50, "100 g", 100]),
    W("milk_chocolate", "Milk chocolate", "", 1, "oz", 28, [535, 7.7, 59, 29.7, 3.4, 52, 79], ["1 fun size bar", 15, "1 bar (1.55 oz)", 44, "100 g", 100]),
    W("ice_cream", "Ice cream, vanilla", "", 0.67, "cup", 88, [207, 3.5, 24, 11, 0.7, 21, 80], ["1/2 cup", 66, "1 cup", 132, "1 scoop", 72, "100 g", 100]),
    L("halo_top", "Ice cream, light (Halo Top / Kroger Simple Truth)", "Halo Top", 0.67, "cup", 88, [100, 6, 20, 2.5, 3, 7, 110], ["1 pint", 264, "100 g", 100]),
    L("chocolate_chip_cookie", "Cookie, chocolate chip, homemade", "", 1, "cookie", 30, [140, 1.5, 19, 7, 0.5, 11, 100], ["2 cookies", 60, "100 g", 100]),
    L("oreo", "Oreo cookies", "Nabisco", 3, "cookies", 34, [160, 1, 25, 7, 1, 13, 135], ["1 cookie", 11, "100 g", 100]),
    L("costco_cookie", "Chocolate chunk cookie (Costco food court)", "Costco", 1, "cookie", 113, [750, 10, 92, 38, 3, 55, 400], ["1/2 cookie", 57, "100 g", 100]),
    L("trail_mix", "Trail mix, nuts, seeds and chocolate", "", 0.25, "cup", 38, [180, 5, 16, 12, 2, 10, 60], ["1 oz", 28, "100 g", 100]),
    L("beef_jerky", "Beef jerky", "", 1, "oz", 28, [80, 11, 5, 1.5, 0, 4, 470], ["1 bag (2.85 oz)", 80, "100 g", 100]),
    L("kirkland_turkey_jerky", "Turkey jerky (Kirkland)", "Kirkland", 1, "oz", 28, [80, 11, 6, 0.5, 0, 5, 380], ["100 g", 100]),
    L("chomps", "Beef stick (Chomps)", "Chomps", 1, "stick", 32, [100, 10, 0, 6, 0, 0, 390], ["100 g", 100]),
    L("graham_crackers", "Graham crackers", "", 2, "full sheets", 31, [130, 2, 24, 3, 1, 8, 160], ["1 sheet", 15.5, "100 g", 100]),
    L("crackers_wheat_thins", "Wheat Thins", "Nabisco", 16, "crackers", 31, [140, 2, 22, 5, 3, 4, 200], ["100 g", 100]),
    L("goldfish", "Goldfish crackers", "Pepperidge Farm", 55, "pieces", 30, [140, 3, 20, 5, 1, 0, 250], ["100 g", 100]),
    L("fruit_snacks", "Fruit snacks (1 pouch)", "", 1, "pouch", 26, [80, 0, 19, 0, 0, 11, 40], ["100 g", 100]),
    L("granola_bar", "Granola bar, chewy (Nature Valley / Quaker)", "", 1, "bar", 24, [100, 1, 17, 3.5, 1, 7, 80], ["100 g", 100]),
    L("costco_muffin", "Muffin, blueberry (Costco bakery)", "Costco", 1, "muffin", 170, [610, 8, 78, 31, 2, 40, 490], ["1/2 muffin", 85, "100 g", 100]),
    L("costco_croissant", "Croissant, butter (Costco bakery)", "Costco", 1, "croissant", 95, [330, 7, 34, 18, 1, 5, 380], ["1/2 croissant", 48, "100 g", 100]),
    L("kirkland_dinner_roll", "Dinner roll (Costco bakery)", "Costco", 1, "roll", 45, [130, 4, 22, 3, 1, 2, 220], ["2 rolls", 90, "100 g", 100]),
    L("kirkland_tortilla_chips", "Tortilla chips, organic (Kirkland)", "Kirkland", 1, "oz (about 9 chips)", 28, [140, 2, 19, 6, 2, 0, 90], ["2 oz", 56, "100 g", 100]),
    L("kirkland_protein_bar_pb", "Protein bar, chocolate peanut butter chunk (Kirkland)", "Kirkland", 1, "bar", 60, [190, 21, 22, 7, 10, 2, 200], ["1/2 bar", 30, "100 g", 100]),
    L("kirkland_trail_mix", "Trail mix (Kirkland)", "Kirkland", 0.25, "cup", 30, [150, 4, 13, 10, 2, 9, 50], ["1 oz", 28, "100 g", 100]),
    L("kroger_string_cheese", "String cheese, mozzarella (Kroger)", "Kroger", 1, "stick", 28, [80, 7, 1, 6, 0, 0, 200], ["2 sticks", 56, "100 g", 100]),
    L("babybel", "Babybel cheese, original", "Babybel", 1, "round", 21, [70, 5, 0, 6, 0, 0, 160], ["2 rounds", 42, "100 g", 100]),
    L("frozen_yogurt_bar", "Yasso frozen Greek yogurt bar", "Yasso", 1, "bar", 65, [100, 5, 17, 0.5, 0, 12, 40], ["100 g", 100]),
    L("protein_pudding", "Protein pudding (Kroger CARBmaster / Kirkland)", "", 1, "cup", 113, [80, 10, 8, 1.5, 1, 4, 130], ["100 g", 100]),
    L("protein_shake_kirkland", "Protein shake, chocolate (Kirkland)", "Kirkland", 1, "shake (11 oz)", 325, [160, 30, 5, 3, 3, 1, 250], ["100 g", 100]),
    L("cottage_cheese_pineapple", "Cottage cheese with pineapple (Kroger)", "Kroger", 1, "container (5.3 oz)", 150, [140, 11, 15, 4, 0, 13, 400], ["100 g", 100]),
    L("nutella", "Nutella", "Nutella", 2, "tbsp", 37, [200, 2, 23, 12, 1, 21, 15], ["1 tbsp", 18.5, "100 g", 100]),
    L("banana_chips", "Banana chips", "", 1, "oz", 28, [147, 0.7, 16.6, 9.5, 2.2, 10, 2], ["100 g", 100])
  );

  M.DB.generic = G;

  /* ======================================================================
     MEAL SUGGESTIONS — built from the generic foods above so every item's
     macros match what the person sees when they search the same food.
     ====================================================================== */
  const byId = {}; G.forEach(f => { byId[f.id.slice(2)] = f; });
  const r2 = v => Math.round(v * 100 + 1e-9) / 100;
  const fmtQty = q => { const m = { 0.25: "1/4", 0.33: "1/3", 0.5: "1/2", 0.67: "2/3", 0.75: "3/4", 1.5: "1 1/2" }; return m[q] || String(q); };
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
  function sug(id, name, desc, slot, store, prepMin, items, tags) {
    const per = {}; NUT.forEach(k => { per[k] = 0; });
    items.forEach(x => { NUT.forEach(k => { per[k] += x.per[k]; }); });
    NUT.forEach(k => { per[k] = rnd(k, per[k]); });
    return { id: "s_" + id, name, desc, slot, store, prepMin, items, per, tags };
  }

  const S = [];
  /* ------------------------------------------------------------ BREAKFAST */
  S.push(
    sug("fage_berry_almond", "Fage yogurt with berries and almonds",
      "Thick Greek yogurt with blueberries and a handful of Kirkland almonds gives you a lot of protein with no cooking.",
      "Breakfast", "Costco", 2, [it("fage_0"), it("blueberries", 0.5), gr("kirkland_almonds", 28, "1 oz (28 g)")], ["high-protein", "quick", "no-cook"]),
    sug("kodiak_pancakes_eggs", "Kodiak protein pancakes with eggs",
      "Kodiak pancakes have double the protein of normal pancakes, and two eggs on the side make it a full meal.",
      "Breakfast", "Either", 15, [it("kodiak_pancakes"), it("egg_large", 2), it("maple_syrup", 0.5)], ["high-protein", "weekend"]),
    sug("egg_white_scramble", "Egg white scramble with spinach and toast",
      "A carton of egg whites plus one whole egg gives you lots of protein for very few calories, and the toast fills you up.",
      "Breakfast", "Either", 10, [gr("egg_whites_carton", 184, "3/4 cup (184 g)"), it("egg_large"), it("spinach_raw", 0.5, "1 cup (30 g)"), gr("cheddar", 28, "1 oz (28 g)"), it("dkb_21_grains")], ["high-protein", "low-calorie"]),
    sug("core_power_banana", "Core Power shake and a banana",
      "Grab a Fairlife Core Power from the fridge and a banana on your way out; 26 grams of protein in under a minute.",
      "Breakfast", "Costco", 1, [it("core_power_26"), it("banana")], ["high-protein", "quick", "no-cook", "grab-and-go"]),
    sug("cottage_cheese_pineapple_chia", "Cottage cheese bowl with pineapple",
      "Cottage cheese is one of the cheapest high-protein foods, and pineapple makes it taste like dessert.",
      "Breakfast", "Either", 3, [it("cottage_cheese_2", 2, "1 cup (226 g)"), it("pineapple", 0.5), it("chia_seeds")], ["high-protein", "quick", "no-cook"]),
    sug("overnight_protein_oats", "Overnight protein oats",
      "Mix oats, Fairlife milk, a scoop of whey and berries the night before, and breakfast is waiting in the fridge.",
      "Breakfast", "Either", 5, [it("oats_dry"), it("fairlife_2", 0.5), it("whey_protein"), it("blueberries", 0.5)], ["high-protein", "make-ahead", "no-cook"]),
    sug("homemade_breakfast_burrito", "Homemade breakfast burrito",
      "Eggs, turkey bacon, cheese and salsa in a flour tortilla; it has way more protein and less grease than a drive-through burrito.",
      "Breakfast", "Either", 12, [it("tortilla_flour"), it("egg_large", 2), it("egg_white", 2), gr("cheddar", 28, "1 oz (28 g)"), it("turkey_bacon"), it("salsa")], ["high-protein"]),
    sug("dkb_avocado_eggs", "Eggs and avocado on Dave's Killer Bread",
      "Three eggs and a quarter of an avocado on two slices of seedy whole-grain bread; solid protein, good fats and fiber.",
      "Breakfast", "Either", 10, [it("dkb_21_grains", 2), it("egg_large", 3), it("avocado", 0.5, "1/4 avocado (38 g)")], ["high-protein", "fiber"]),
    sug("oikos_parfait", "Oikos Triple Zero parfait",
      "Layer an Oikos Triple Zero with strawberries and a little granola for a sweet breakfast that still has 17 grams of protein.",
      "Breakfast", "King Soopers", 3, [it("oikos_triple_zero"), it("strawberries"), it("granola", 0.5)], ["high-protein", "quick", "no-cook"]),
    sug("premier_shake_bar", "Premier Protein shake and a Kirkland bar",
      "The fastest breakfast on the list: a shake and a protein bar give you 51 grams of protein with zero prep.",
      "Breakfast", "Costco", 1, [it("premier_protein"), it("kirkland_protein_bar")], ["high-protein", "quick", "no-cook", "grab-and-go"]),
    sug("cheerios_fairlife_eggs", "Cheerios with Fairlife milk and two boiled eggs",
      "Fairlife milk has twice the protein of regular milk, and two hard-boiled eggs turn a bowl of cereal into a real breakfast.",
      "Breakfast", "Either", 3, [it("cheerios"), it("fairlife_2"), it("egg_hard_boiled", 2)], ["high-protein", "quick", "no-cook"])
  );
  /* ---------------------------------------------------------------- LUNCH */
  S.push(
    sug("rotisserie_rice_bowl", "Kirkland rotisserie chicken rice bowl",
      "Pull the breast meat off a Costco rotisserie chicken, add rice and broccoli, and drizzle teriyaki; done in five minutes.",
      "Lunch", "Costco", 5, [it("rotisserie_chicken_breast", 2, "6 oz (170 g)"), it("white_rice_cooked"), it("broccoli_cooked"), it("teriyaki")], ["high-protein", "quick", "meal-prep"]),
    sug("dkb_turkey_sandwich", "Turkey and Swiss on Dave's Killer Bread",
      "A double stack of deli turkey with Swiss on 21-grain bread, plus an apple; a classic lunch with 35 grams of protein.",
      "Lunch", "King Soopers", 5, [it("dkb_21_grains", 2), it("kroger_deli_turkey", 2, "4 oz (112 g)"), it("swiss_cheese"), it("light_mayo"), it("mustard"), it("apple")], ["high-protein", "quick", "no-cook"]),
    sug("tuna_wrap", "Tuna wrap on a low-carb tortilla",
      "A can of tuna with light mayo in a Carb Balance tortilla with lettuce; big protein for very few calories.",
      "Lunch", "Either", 5, [it("tuna_canned_water"), it("light_mayo"), it("low_carb_tortilla"), it("lettuce_romaine", 0.5, "1 cup (47 g)"), it("pickles")], ["high-protein", "quick", "no-cook", "low-calorie"]),
    sug("chicken_caesar_wrap", "Chicken Caesar wrap",
      "Rotisserie chicken, romaine, parmesan and a little Caesar dressing rolled in a tortilla; tastes like takeout, half the calories.",
      "Lunch", "Costco", 7, [gr("rotisserie_chicken_breast", 113, "4 oz (113 g)"), it("lettuce_romaine"), it("caesar_dressing", 0.5), it("parmesan"), it("tortilla_flour")], ["high-protein", "quick"]),
    sug("just_bare_tacos", "Just Bare chicken tacos",
      "Cook Just Bare chicken with taco seasoning and fill three corn tortillas with salsa and cheese; simple and high protein.",
      "Lunch", "Costco", 15, [gr("just_bare_chicken_breast", 140, "5 oz (140 g)"), it("taco_seasoning"), it("tortilla_corn", 3), it("salsa"), gr("cheddar", 14, "1/2 oz (14 g)"), it("guacamole")], ["high-protein"]),
    sug("homemade_chipotle_bowl", "Homemade Chipotle-style chicken bowl",
      "Chicken breast, brown rice, black beans, corn, salsa and guac at home; the same bowl for a third of the price.",
      "Lunch", "Either", 10, [gr("chicken_breast_cooked", 140, "5 oz (140 g)"), it("brown_rice_cooked"), it("black_beans_canned"), it("corn", 0.5), it("salsa", 2, "1/4 cup (64 g)"), it("guacamole")], ["high-protein", "meal-prep"]),
    sug("turkey_rollups", "Turkey roll-ups with string cheese and hummus",
      "No-cook lunch box: deli turkey rolled around string cheese, with hummus, baby carrots and an apple.",
      "Lunch", "King Soopers", 5, [it("kroger_deli_turkey", 2, "4 oz (112 g)"), it("kroger_string_cheese", 2), it("hummus"), gr("carrots", 100, "10 baby carrots (100 g)"), it("apple")], ["high-protein", "quick", "no-cook"]),
    sug("salmon_salad", "Salmon and chickpea salad",
      "Leftover salmon on spring mix with chickpeas, tomatoes and cucumber; protein, fiber and healthy fat in one bowl.",
      "Lunch", "Either", 8, [gr("salmon_cooked", 113, "4 oz (113 g)"), it("spring_mix"), it("chickpeas_canned"), it("cherry_tomatoes", 0.5), it("cucumber", 0.5), it("balsamic_vinaigrette")], ["high-protein", "fiber"]),
    sug("chicken_quesadilla_lowcarb", "Rotisserie chicken quesadilla",
      "Rotisserie chicken and mozzarella melted in a low-carb tortilla, dipped in salsa and Greek yogurt instead of sour cream.",
      "Lunch", "Costco", 8, [it("low_carb_tortilla"), it("rotisserie_chicken_breast"), gr("mozzarella", 28, "1 oz (28 g)"), it("salsa"), gr("fage_0", 30, "2 tbsp (30 g)")], ["high-protein", "quick"]),
    sug("lentil_quinoa_bowl", "Lentil and quinoa power bowl",
      "A vegetarian bowl of lentils, quinoa, feta, cucumber and hummus with lots of fiber and a good amount of protein.",
      "Lunch", "Either", 10, [it("lentils_cooked"), it("quinoa_cooked", 0.5), gr("feta", 28, "1 oz (28 g)"), it("cucumber", 0.5), it("hummus"), it("olive_oil", 0.33, "1 tsp (4.7 g)")], ["vegetarian", "fiber", "meal-prep"]),
    sug("turkey_rice_bowl", "Ground turkey teriyaki rice bowl",
      "Meal-prep classic: 93% ground turkey, jasmine rice and green beans with soy sauce and a squeeze of sriracha.",
      "Lunch", "Either", 20, [gr("ground_turkey_93_cooked", 113, "4 oz (113 g)"), it("jasmine_rice_cooked"), it("green_beans"), it("soy_sauce"), it("sriracha")], ["high-protein", "meal-prep"])
  );
  /* --------------------------------------------------------------- DINNER */
  S.push(
    sug("costco_salmon_rice", "Costco salmon with rice and asparagus",
      "A 6-ounce piece of Kirkland salmon baked with olive oil, served with white rice and asparagus; simple, filling and full of protein.",
      "Dinner", "Costco", 20, [gr("kirkland_salmon_raw", 170, "6 oz raw (170 g)"), it("white_rice_cooked"), it("asparagus"), it("olive_oil", 0.5, "1/2 tbsp (7 g)")], ["high-protein", "omega-3"]),
    sug("beef_93_burrito_bowl", "93% ground beef burrito bowl",
      "Lean ground beef with taco seasoning over rice, with black beans, cheese, salsa and a spoon of Greek yogurt instead of sour cream.",
      "Dinner", "Either", 20, [gr("ground_beef_93_cooked", 140, "5 oz (140 g)"), it("taco_seasoning"), it("white_rice_cooked"), it("black_beans_canned"), gr("cheddar", 28, "1 oz (28 g)"), it("salsa", 2, "1/4 cup (64 g)"), gr("fage_0", 30, "2 tbsp (30 g)")], ["high-protein", "meal-prep"]),
    sug("chicken_thigh_sweet_potato", "Roasted chicken thighs with sweet potato and broccoli",
      "Sheet-pan dinner: boneless chicken thighs, a sweet potato and broccoli roasted together, then a little BBQ sauce on top.",
      "Dinner", "Either", 35, [gr("chicken_thigh_cooked", 170, "6 oz (170 g)"), it("sweet_potato_baked"), it("broccoli_cooked"), it("olive_oil", 0.5, "1/2 tbsp (7 g)"), it("bbq_sauce", 0.5)], ["high-protein", "sheet-pan"]),
    sug("sirloin_potato", "Sirloin steak with baked potato and green beans",
      "A lean 6-ounce sirloin, a baked potato with a pat of butter and green beans; a steakhouse plate for about 550 calories.",
      "Dinner", "Either", 25, [it("sirloin_cooked"), it("potato_baked"), it("butter", 0.5, "1/2 tbsp (7 g)"), it("green_beans")], ["high-protein"]),
    sug("shrimp_stir_fry", "Shrimp and veggie stir fry over rice",
      "Frozen shrimp, a bag of mixed vegetables and soy sauce cooked in one pan over jasmine rice; ready in 15 minutes.",
      "Dinner", "Costco", 15, [gr("shrimp_cooked", 170, "6 oz (170 g)"), it("frozen_veg_mix", 1.5, "1 1/2 cups (137 g)"), it("jasmine_rice_cooked"), it("soy_sauce", 2, "2 tbsp (32 g)"), it("avocado_oil", 0.5, "1/2 tbsp (7 g)")], ["high-protein", "quick", "one-pan"]),
    sug("turkey_spaghetti", "Turkey spaghetti with marinara",
      "Ground turkey browned into jarred marinara over Banza chickpea pasta gives you more protein and fiber than normal spaghetti.",
      "Dinner", "Either", 25, [gr("ground_turkey_93_cooked", 140, "5 oz (140 g)"), it("banza_pasta"), it("marinara"), it("parmesan", 2, "2 tbsp (10 g)")], ["high-protein", "fiber"]),
    sug("pork_tenderloin_quinoa", "Pork tenderloin with quinoa and roasted Brussels sprouts",
      "Pork tenderloin is as lean as chicken breast; roast it with Brussels sprouts and serve over quinoa.",
      "Dinner", "Either", 35, [gr("pork_tenderloin_cooked", 170, "6 oz (170 g)"), it("quinoa_cooked"), it("brussels_sprouts"), it("olive_oil", 0.5, "1/2 tbsp (7 g)")], ["high-protein", "fiber"]),
    sug("rotisserie_chicken_dinner_plate", "Rotisserie chicken plate with mashed potatoes",
      "Costco rotisserie chicken with boiled potatoes, butter and steamed cauliflower; a fast comfort dinner with no real cooking.",
      "Dinner", "Costco", 12, [it("rotisserie_chicken_mixed", 2, "6 oz (170 g)"), it("potato_boiled", 1.5, "1 1/2 cups (234 g)"), it("butter", 0.5, "1/2 tbsp (7 g)"), it("cauliflower")], ["high-protein", "quick"]),
    sug("just_bare_chicken_fried_rice", "Chicken fried rice with Just Bare chicken",
      "Leftover rice fried with Just Bare chicken, two eggs, peas and carrots and soy sauce; way better macros than takeout.",
      "Dinner", "Costco", 20, [gr("just_bare_chicken_breast", 140, "5 oz (140 g)"), it("white_rice_cooked", 1.5, "1 1/2 cups (237 g)"), it("egg_large", 2), it("peas", 0.5), it("carrots", 0.5, "1/2 cup chopped (64 g)"), it("soy_sauce", 2, "2 tbsp (32 g)"), it("avocado_oil", 0.5, "1/2 tbsp (7 g)")], ["high-protein", "one-pan"]),
    sug("cod_tacos", "Baked cod tacos",
      "Baked cod in corn tortillas with cabbage-style slaw from spring mix, salsa and Greek yogurt sauce; light and high in protein.",
      "Dinner", "King Soopers", 20, [gr("cod_cooked", 170, "6 oz (170 g)"), it("tortilla_corn", 3), it("spring_mix", 0.5, "1 cup (42 g)"), it("salsa", 2, "1/4 cup (64 g)"), gr("fage_0", 45, "3 tbsp (45 g)"), it("avocado", 0.5, "1/4 avocado (38 g)")], ["high-protein", "low-calorie"]),
    sug("chicken_alfredo_lite", "Lighter chicken Alfredo",
      "Chicken breast over Banza pasta with a quarter cup of Alfredo and broccoli mixed in; creamy pasta that still hits 55 grams of protein.",
      "Dinner", "Either", 25, [gr("chicken_breast_cooked", 140, "5 oz (140 g)"), it("banza_pasta"), it("alfredo"), it("broccoli_cooked"), it("parmesan")], ["high-protein"])
  );
  /* --------------------------------------------------------------- SNACKS */
  S.push(
    sug("kirkland_bar_snack", "Kirkland protein bar",
      "One bar from the Costco box: 21 grams of protein and 10 grams of fiber for 190 calories, and it fits in a pocket.",
      "Snacks", "Costco", 0, [it("kirkland_protein_bar")], ["high-protein", "grab-and-go", "no-cook"]),
    sug("fairlife_shake_snack", "Core Power shake",
      "A cold Fairlife Core Power from the fridge is the easiest 26 grams of protein you will find all day.",
      "Snacks", "Costco", 0, [it("core_power_26")], ["high-protein", "grab-and-go", "no-cook"]),
    sug("cottage_cheese_berries", "Cottage cheese with berries",
      "Half a cup of cottage cheese with a handful of strawberries; filling, sweet and only about 120 calories.",
      "Snacks", "Either", 2, [it("cottage_cheese_2"), it("strawberries", 0.5)], ["high-protein", "quick", "no-cook", "low-calorie"]),
    sug("greek_yogurt_pb", "Greek yogurt with peanut butter",
      "Stir a tablespoon of Kirkland peanut butter into a Fage; it tastes like a peanut butter cup with 22 grams of protein.",
      "Snacks", "Costco", 2, [it("fage_0"), it("kirkland_peanut_butter", 0.5)], ["high-protein", "quick", "no-cook"]),
    sug("jerky_string_cheese", "Beef jerky and string cheese",
      "Two things from the snack drawer that add up to 18 grams of protein with barely any carbs.",
      "Snacks", "Either", 0, [it("beef_jerky"), it("string_cheese")], ["high-protein", "grab-and-go", "no-cook", "low-carb"]),
    sug("hard_boiled_eggs_snack", "Two hard-boiled eggs with hot sauce",
      "Boil a batch of Kirkland eggs on Sunday and grab two whenever you are hungry; cheap and 12 grams of protein.",
      "Snacks", "Costco", 1, [it("egg_hard_boiled", 2), it("hot_sauce")], ["high-protein", "make-ahead", "low-carb"]),
    sug("apple_peanut_butter", "Apple with peanut butter",
      "An apple sliced up with a tablespoon of peanut butter; fiber and healthy fat that keep you full for hours.",
      "Snacks", "Either", 2, [it("apple"), it("kirkland_peanut_butter", 0.5)], ["quick", "no-cook", "fiber"]),
    sug("turkey_cheese_rollups", "Turkey and cheese roll-ups",
      "Three slices of deli turkey rolled around a slice of pepper jack; 20 grams of protein and no bread.",
      "Snacks", "King Soopers", 2, [gr("kroger_deli_turkey", 84, "3 oz (84 g)"), it("pepper_jack")], ["high-protein", "quick", "no-cook", "low-carb"]),
    sug("quest_chips_snack", "Quest protein chips",
      "A bag of Quest chips is crunchy like real chips but has 19 grams of protein and only 5 grams of carbs.",
      "Snacks", "Either", 0, [it("quest_chips")], ["high-protein", "grab-and-go", "low-carb"]),
    sug("hummus_veggies", "Hummus with carrots and cucumber",
      "Crunchy veggies and hummus; low calorie, lots of fiber, and good for evenings when you just want to munch.",
      "Snacks", "Either", 3, [it("hummus", 2, "1/4 cup (60 g)"), gr("carrots", 100, "10 baby carrots (100 g)"), it("cucumber")], ["low-calorie", "fiber", "no-cook"]),
    sug("whey_shake_almonds", "Whey shake with almonds",
      "A scoop of whey in water and a small handful of Kirkland almonds; 30 grams of protein before or after the gym.",
      "Snacks", "Costco", 2, [it("whey_protein"), gr("kirkland_almonds", 20, "small handful (20 g)")], ["high-protein", "quick", "post-workout"]),
    sug("rice_cakes_pb_banana", "Rice cakes with peanut butter and banana",
      "Two rice cakes with peanut butter and banana slices; a quick carb-and-fat snack that works well before a workout.",
      "Snacks", "Either", 3, [it("rice_cake", 2), it("kirkland_peanut_butter", 0.5), it("banana", 0.5)], ["quick", "no-cook", "pre-workout"])
  );

  M.DB.suggest = S;
})(window.M);
