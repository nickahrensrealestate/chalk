/* node tests/m-food.test.js — plain asserts for the pure parts of m-food.js (no DOM, no network) */
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
try { Object.defineProperty(global, "navigator", { value: { vibrate() { return true; } }, configurable: true }); } catch (e) {}
global.AbortController = class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } };

["m-core.js", "m-data.js", "m-food.js"].forEach(f => {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), { filename: f });
});
const M = global.M;

global.S = { profile: "nick" };
global.PRESETS = { nick: { name: "Nick" }, kat: { name: "Katerina" } };
M.reset();

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || "") + " expected " + a + " ≈ " + b + " (±" + tol + ")");
const tests = [];
function t(name, fn) { tests.push({ name, fn }); }

console.log("m-food.js");

/* ======================================================================= */
t("namespace: M.ai, M.img, M.food with the spec'd surface", () => {
  ["mode", "ready", "getKey", "setKey", "model", "json"].forEach(k => assert.strictEqual(typeof M.ai[k], "function", "M.ai." + k));
  ["downscale", "toBase64"].forEach(k => assert.strictEqual(typeof M.img[k], "function", "M.img." + k));
  ["barcode", "searchOFF", "fromOFF", "describe", "estimateByName", "suggest"].forEach(k => assert.strictEqual(typeof M.food[k], "function", "M.food." + k));
  ["start", "stop", "fromImage"].forEach(k => assert.strictEqual(typeof M.food.scanner[k], "function", "scanner." + k));
  ["parse", "fromImage"].forEach(k => assert.strictEqual(typeof M.food.label[k], "function", "label." + k));
  assert.strictEqual(typeof M.food.photo.estimate, "function");
});

/* ======================================================================= */
t("ai.mode: null with no key, \"key\" after setKey, null after setKey(\"\")", () => {
  M.ai.setKey("");
  assert.strictEqual(M.ai.mode(), null);
  assert.strictEqual(M.ai.ready(), false);
  M.ai.setKey("  sk-ant-test-123  ");
  assert.strictEqual(M.ai.mode(), "key");
  assert.strictEqual(M.ai.ready(), true);
  assert.strictEqual(M.ai.getKey(), "sk-ant-test-123");
  assert.strictEqual(global.localStorage.store["chalk.ai.key"], "sk-ant-test-123");
  M.ai.setKey("");
  assert.strictEqual(M.ai.mode(), null);
  assert.strictEqual(global.localStorage.store["chalk.ai.key"], undefined);
  assert.strictEqual(M.ai.model(), "claude-sonnet-5-5");
  M.person("nick").aiModel = "claude-haiku-4-5-20251001";
  assert.strictEqual(M.ai.model(), "claude-haiku-4-5-20251001");
  M.person("nick").aiModel = "claude-sonnet-5-5";
});

t("ai.json without any provider rejects {code:\"no_ai\"} with a plain message (never throws)", async () => {
  M.ai.setKey("");
  let err = null;
  try { await M.ai.json("Reply with {\"ok\":true}"); } catch (e) { err = e; }
  assert.ok(err && err.code === "no_ai", "code " + (err && err.code));
  assert.ok(/claude/i.test(err.message), "plain message");
  const p = M.food.photo.estimate({}, { slot: "Lunch" });
  await p.then(() => assert.fail("should reject"), e => assert.strictEqual(e.code, "no_ai"));
});

t("ai.json key path: builds the request, strips fences, retries once on 404 with haiku, maps errors", async () => {
  const calls = [];
  let mode = "404-then-ok";
  global.fetch = async (url, o) => {
    const body = JSON.parse(o.body);
    calls.push({ url, headers: o.headers, body });
    if (mode === "404-then-ok" && calls.length === 1) return { ok: false, status: 404, json: async () => ({ error: { type: "not_found_error", message: "model: nope" } }) };
    if (mode === "401") return { ok: false, status: 401, json: async () => ({ error: { type: "authentication_error", message: "bad key" } }) };
    if (mode === "429") return { ok: false, status: 429, json: async () => ({ error: { type: "rate_limit_error", message: "slow" } }) };
    if (mode === "garbage") return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "I can't do JSON today" }] }) };
    if (mode === "neterr") throw new TypeError("Failed to fetch");
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "```json\n{\"ok\":true,\"n\":2}\n```" }] }) };
  };
  M.ai.setKey("sk-ant-test");
  const v = await M.ai.json("Reply with JSON");
  assert.deepStrictEqual(v, { ok: true, n: 2 });
  assert.strictEqual(calls.length, 2, "one retry");
  assert.strictEqual(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.strictEqual(calls[0].headers["x-api-key"], "sk-ant-test");
  assert.strictEqual(calls[0].headers["anthropic-version"], "2023-06-01");
  assert.strictEqual(calls[0].headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.strictEqual(calls[0].body.model, "claude-sonnet-5-5");
  assert.strictEqual(calls[1].body.model, "claude-haiku-4-5-20251001");
  assert.strictEqual(calls[0].body.max_tokens, 1500);
  assert.strictEqual(calls[0].body.messages[0].role, "user");
  assert.deepStrictEqual(calls[0].body.messages[0].content[0], { type: "text", text: "Reply with JSON" });
  mode = "401"; await M.ai.json("x").then(() => assert.fail(), e => { assert.strictEqual(e.code, "auth"); assert.ok(/key/i.test(e.message)); });
  mode = "429"; await M.ai.json("x").then(() => assert.fail(), e => assert.strictEqual(e.code, "rate_limited"));
  mode = "garbage"; await M.ai.json("x").then(() => assert.fail(), e => assert.strictEqual(e.code, "bad_json"));
  mode = "neterr"; await M.ai.json("x").then(() => assert.fail(), e => { assert.strictEqual(e.code, "network"); assert.ok(/connection/i.test(e.message)); });
  M.ai.setKey("");
  delete global.fetch;
});

t("ai.parseJSONText: whole / fenced / embedded JSON, else {code:\"bad_json\"}", () => {
  assert.deepStrictEqual(M.ai.parseJSONText('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(M.ai.parseJSONText('```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
  assert.deepStrictEqual(M.ai.parseJSONText('Here you go: {"a":"b"} hope that helps'), { a: "b" });
  assert.throws(() => M.ai.parseJSONText("nothing here"), e => e.code === "bad_json");
});

/* ======================================================================= */
/* Open Food Facts fixtures (v2 shape: fields=code,product_name,brands,serving_size,serving_quantity,quantity,nutriments) */
const OFF_WITH_SERVING = {
  code: "0038000199103",
  product_name: "Cheez-It Original",
  brands: "Kellogg's,Cheez-It,Sunshine",
  quantity: "12.4 oz",
  serving_size: "27 crackers (30 g)",
  serving_quantity: 30,
  serving_quantity_unit: "g",
  nutriments: {
    "energy-kcal": 500, "energy-kcal_100g": 500, "energy-kcal_serving": 150, "energy-kcal_unit": "kcal",
    energy: 2092, energy_100g: 2092, energy_serving: 628, energy_unit: "kcal",
    proteins: 10, proteins_100g: 10, proteins_serving: 3,
    carbohydrates: 56.7, carbohydrates_100g: 56.7, carbohydrates_serving: 17,
    fat: 26.7, fat_100g: 26.7, fat_serving: 8,
    "saturated-fat_100g": 6.67, "saturated-fat_serving": 2,
    fiber: 3.33, fiber_100g: 3.33, fiber_serving: 1,
    sugars: 0, sugars_100g: 0, sugars_serving: 0,
    sodium: 0.767, sodium_100g: 0.767, sodium_serving: 0.23, sodium_unit: "g",
    salt: 1.917, salt_100g: 1.917, salt_serving: 0.575
  }
};
const OFF_PER100_ONLY = {
  code: "5201054009093",
  product_name: "",
  product_name_en: "Total 0% Greek Yogurt",
  brands: "Fage",
  quantity: "500 g",
  serving_size: "",
  serving_quantity: "",
  nutriments: {
    energy: 238, energy_100g: 238, energy_unit: "kJ",
    proteins_100g: 10.3, carbohydrates_100g: 3.8, fat_100g: 0, sugars_100g: 3.8,
    salt_100g: 0.09
  }
};

t("fromOFF: product with serving_quantity + _serving values → per from serving, per100g, sodium mg, serving label", () => {
  const f = M.food.fromOFF(OFF_WITH_SERVING);
  assert.ok(f, "returns a food");
  assert.strictEqual(f.source, "off");
  assert.strictEqual(f.barcode, "0038000199103");
  assert.strictEqual(f.name, "Cheez-It Original");
  assert.strictEqual(f.brand, "Kellogg's", "first brand only");
  assert.deepStrictEqual(f.serving, { qty: 27, unit: "crackers", g: 30 });
  assert.strictEqual(f.per.cal, 150);
  assert.strictEqual(f.per.p, 3);
  assert.strictEqual(f.per.c, 17);
  assert.strictEqual(f.per.f, 8);
  assert.strictEqual(f.per.fiber, 1);
  assert.strictEqual(f.per.sugar, 0);
  assert.strictEqual(f.per.sodium, 230, "sodium_serving g → mg");
  assert.strictEqual(f.per100g.cal, 500);
  assert.strictEqual(f.per100g.p, 10);
  assert.strictEqual(f.per100g.c, 56.7);
  assert.strictEqual(f.per100g.f, 26.7);
  assert.strictEqual(f.per100g.fiber, 3.3);
  assert.strictEqual(f.per100g.sodium, 767, "sodium_100g g → mg");
  assert.ok(f.alts.some(a => a.label === "100 g" && a.g === 100), "alts has 100 g");
  M.NUT.forEach(k => { assert.strictEqual(typeof f.per[k], "number", "per." + k); assert.strictEqual(typeof f.per100g[k], "number", "per100g." + k); });
});

t("fromOFF: per100g-only product with kJ + salt → serving 100 g, kcal from kJ, sodium from salt", () => {
  const f = M.food.fromOFF(OFF_PER100_ONLY);
  assert.ok(f, "returns a food");
  assert.strictEqual(f.name, "Total 0% Greek Yogurt", "falls back to product_name_en");
  assert.strictEqual(f.brand, "Fage");
  assert.strictEqual(f.barcode, "5201054009093");
  assert.deepStrictEqual(f.serving, { qty: 100, unit: "g", g: 100 });
  assert.strictEqual(f.per100g.cal, 57, "238 kJ / 4.184");
  assert.strictEqual(f.per100g.p, 10.3);
  assert.strictEqual(f.per100g.c, 3.8);
  assert.strictEqual(f.per100g.sugar, 3.8);
  assert.strictEqual(f.per100g.f, 0);
  assert.strictEqual(f.per100g.sodium, 36, "0.09 g salt / 2.5 → 0.036 g sodium → 36 mg");
  assert.deepStrictEqual(f.per, f.per100g);
  assert.ok(f.alts.some(a => a.label === "100 g"));
});

t("fromOFF: serving_size only (no serving_quantity) scales per100g to the serving grams; nulls for junk", () => {
  const f = M.food.fromOFF({ code: "12345678", product_name: "Ranch", serving_size: "2 Tbsp (30mL)", nutriments: { "energy-kcal_100g": 433, fat_100g: 46.7, sodium_100g: 0.867 } });
  assert.ok(f);
  assert.deepStrictEqual(f.serving, { qty: 2, unit: "Tbsp", g: 30 });
  assert.strictEqual(f.per.cal, 130);
  assert.strictEqual(f.per.f, 14);
  assert.strictEqual(f.per.sodium, 260);
  assert.strictEqual(M.food.fromOFF(null), null);
  assert.strictEqual(M.food.fromOFF({ product_name: "No numbers", nutriments: {} }), null);
  assert.strictEqual(M.food.fromOFF({ nutriments: { "energy-kcal_100g": 100 } }), null, "no name → null");
});

/* ======================================================================= */
const OCR_1 = `Nutrition Facts
8 servings per container
Serving size 2/3 cup (55g)

Amount per serving
Calories 230
% Daily Value*
Total Fat 8g 10%
Saturated Fat 1g 5%
Trans Fat 0g
Cholesterol 0mg 0%
Sodium 160mg 7%
Total Carbohydrate 37g 13%
Dietary Fiber 4g 14%
Total Sugars 12g
Includes 10g Added Sugars 20%
Protein 3g

Vitamin D 2mcg 10%
Calcium 260mg 20%
Iron 8mg 45%
Potassium 240mg 6%`;

/* old-style dairy label with classic OCR damage: l→1, O→0, "89" for "8g", "39" for "3g" */
const OCR_2 = `Nutrltion Facts
Serving Size 1 cup (240mL)
Servings Per Container 8

Amount Per Serving
Calories 15O   Calories from Fat 70
% Daily Value*
Total Fat 89 12%
  Saturated Fat 5g 25%
  Trans Fat Og
Cholesterol 35mg 12%
Sodium 12Omg 5%
Total Carb. l2g 4%
  Dietary Fiber Og 0%
  Sugars 12g
Protein 39
Vitamin A 6% • Vitamin C 4%
Calcium 30% • Iron 0%`;

/* new-style label where the serving line sits above "Serving size" and Calories is on its own line */
const OCR_3 = `KIRKLAND SIGNATURE
Protein Bar
Nutrition Facts
1 bar (60g)
Serving size
Calories
190
% Daily Value*
Total Fat 7g 9%
Saturated Fat 4g 20%
Sodium 210mg 9%
Total Carbohydrate 23g 8%
Dietary Fiber 10g 36%
Total Sugars 2g
Includes 0g Added Sugars 0%
Erythritol 8g
Protein 21g 42%
Calcium 150mg 10%`;

t("label.parse: clean 2/3 cup cereal label", () => {
  const r = M.food.label.parse(OCR_1);
  assert.deepStrictEqual(r.per, { cal: 230, p: 3, c: 37, f: 8, fiber: 4, sugar: 12, sodium: 160 });
  assert.strictEqual(r.serving.unit, "cup");
  near(r.serving.qty, 2 / 3, 0.01, "qty");
  assert.strictEqual(r.serving.g, 55);
  ["cal", "p", "c", "f", "fiber", "sugar", "sodium", "serving"].forEach(k => assert.ok(r.fields.includes(k), "field " + k));
});

t("label.parse: noisy dairy label (O→0, l→1, 89→8g, 39→3g, Total Carb., Sugars, % ignored)", () => {
  const r = M.food.label.parse(OCR_2);
  assert.deepStrictEqual(r.per, { cal: 150, p: 3, c: 12, f: 8, fiber: 0, sugar: 12, sodium: 120 });
  assert.deepStrictEqual(r.serving, { qty: 1, unit: "cup", g: 240 });
  assert.ok(r.fields.includes("p") && r.fields.includes("c") && r.fields.includes("serving"));
});

t("label.parse: new-style bar label (serving above 'Serving size', calories on next line, added sugars ignored)", () => {
  const r = M.food.label.parse(OCR_3);
  assert.deepStrictEqual(r.per, { cal: 190, p: 21, c: 23, f: 7, fiber: 10, sugar: 2, sodium: 210 });
  assert.deepStrictEqual(r.serving, { qty: 1, unit: "bar", g: 60 });
  assert.ok(r.name && /kirkland/i.test(r.name), "name from the lines above Nutrition Facts");
});

t("label.parse: empty / junk text returns zeros and no fields, never throws", () => {
  const r = M.food.label.parse("");
  assert.deepStrictEqual(r.fields, []);
  assert.deepStrictEqual(r.per, { cal: 0, p: 0, c: 0, f: 0, fiber: 0, sugar: 0, sodium: 0 });
  assert.doesNotThrow(() => M.food.label.parse(null));
  assert.doesNotThrow(() => M.food.label.parse("asdf qwer 12 34 %"));
});

/* ======================================================================= */
t("describe fallback: \"2 eggs, 1 cup white rice, 4 oz chicken breast\" → 3 matched items with sane calories", async () => {
  M.ai.setKey("");
  const r = await M.food.describe("2 eggs, 1 cup white rice, 4 oz chicken breast", { slot: "Lunch" });
  assert.strictEqual(r.method, "local");
  assert.strictEqual(r.items.length, 3, "3 items");
  assert.deepStrictEqual(r.unmatched, []);
  const [egg, rice, chk] = r.items;
  assert.ok(/^egg/i.test(egg.name), "egg matched: " + egg.name);
  assert.strictEqual(egg.servings, 2);
  near(egg.per.cal * egg.servings, 144, 20, "2 eggs kcal");
  assert.ok(/white rice/i.test(rice.name), "rice matched: " + rice.name);
  assert.strictEqual(rice.servings, 1);
  near(rice.per.cal * rice.servings, 205, 25, "1 cup rice kcal");
  assert.ok(/chicken breast/i.test(chk.name), "chicken matched: " + chk.name);
  near(chk.per.cal * chk.servings, 186, 25, "4 oz chicken kcal");
  near(chk.g, 113, 2, "4 oz grams");
  r.items.forEach(it => {
    assert.ok(it.foodId, "foodId");
    assert.ok(it.servingLabel, "servingLabel");
    M.NUT.forEach(k => assert.strictEqual(typeof it.per[k], "number", it.name + " per." + k));
  });
});

t("describe fallback: quantity parsing (fractions, words, weight/volume units, trailing amounts, unmatched)", async () => {
  const q = M.food.parseQuantity;
  assert.deepStrictEqual([q("1.5 cups rice").qty, q("1.5 cups rice").unit, q("1.5 cups rice").words], [1.5, "cup", "rice"]);
  assert.deepStrictEqual([q("half an avocado").qty, q("half an avocado").words], [0.5, "avocado"]);
  assert.deepStrictEqual([q("3 oz chicken").qty, q("3 oz chicken").unit], [3, "oz"]);
  assert.deepStrictEqual([q("100g greek yogurt").qty, q("100g greek yogurt").unit, q("100g greek yogurt").words], [100, "g", "greek yogurt"]);
  assert.deepStrictEqual([q("chicken thigh 8 oz").qty, q("chicken thigh 8 oz").unit, q("chicken thigh 8 oz").words], [8, "oz", "chicken thigh"]);
  assert.deepStrictEqual([q("a banana").qty, q("a banana").words], [1, "banana"]);
  const r = await M.food.describe("6 oz salmon and 1/2 cup brown rice\nxyzzy plumbus", {});
  assert.strictEqual(r.items.length, 2);
  assert.deepStrictEqual(r.unmatched, ["xyzzy plumbus"]);
  const salmon = r.items[0];
  near(salmon.g, 170, 2, "6 oz grams");
  const rice = r.items[1];
  assert.strictEqual(rice.servings, 0.5);
  const g = await M.food.describe("100g greek yogurt", {});
  assert.strictEqual(g.items.length, 1);
  near(g.items[0].per.cal * g.items[0].servings, 59, 10, "100 g yogurt ≈ per100g");
  const e = await M.food.describe("", {});
  assert.deepStrictEqual(e.items, []);
});

/* ======================================================================= */
t("suggest: ≥6 built-ins, slot matches first, none over remaining.cal+150 when enough fit, source builtin", async () => {
  M.ai.setKey("");
  const remaining = { cal: 700, p: 50, c: 70, f: 25 };
  const list = await M.food.suggest({ pid: "nick", slot: "Lunch", remaining });
  assert.ok(list.length >= 6, "got " + list.length);
  list.forEach(s => {
    assert.strictEqual(s.source, "builtin");
    assert.ok(s.per && typeof s.per.cal === "number", "per");
    assert.ok(Array.isArray(s.items) && s.items.length, "items");
    assert.ok(s.per.cal <= remaining.cal + 150, s.name + " is " + s.per.cal + " kcal > " + (remaining.cal + 150));
  });
  /* slot matches come first (all six should be Lunch since there are 10+ lunch ideas) */
  const firstOther = list.findIndex(s => s.slot !== "Lunch");
  const lastLunch = list.map(s => s.slot).lastIndexOf("Lunch");
  assert.ok(firstOther === -1 || firstOther > lastLunch, "lunch ideas before other slots");
  assert.ok(list.filter(s => s.slot === "Lunch").length >= 4, "mostly lunch");
});

t("suggest: tight budget prefers small meals; protein weighted; jitter varies order across runs", async () => {
  const snack = await M.food.suggest({ slot: "Snacks", remaining: { cal: 250, p: 30, c: 15, f: 8 } });
  assert.ok(snack.length >= 6);
  snack.forEach(s => assert.ok(s.per.cal <= 400, s.name + " too big for a 250 kcal budget: " + s.per.cal));
  assert.ok(snack.slice(0, 3).every(s => s.per.p >= 15), "top snacks are high protein");
  /* deterministic scorer: with jitter 0 the same input gives the same order */
  const a = M.food.suggestBuiltin({ slot: "Dinner", remaining: { cal: 800, p: 60, c: 80, f: 30 }, jitter: 0 }).map(s => s.id);
  const b = M.food.suggestBuiltin({ slot: "Dinner", remaining: { cal: 800, p: 60, c: 80, f: 30 }, jitter: 0 }).map(s => s.id);
  assert.deepStrictEqual(a, b);
  /* random jitter changes something over a handful of runs */
  const orders = new Set();
  for (let i = 0; i < 12; i++) orders.add(M.food.suggestBuiltin({ slot: "Dinner", remaining: { cal: 800, p: 60, c: 80, f: 30 } }).map(s => s.id).join(","));
  assert.ok(orders.size > 1, "More ideas should vary");
  /* over-budget penalty: a 900 kcal meal scores far below a 400 kcal one when only 300 kcal are left */
  const big = { id: "x", slot: "Dinner", per: { cal: 900, p: 60, c: 80, f: 40 }, items: [] };
  const small = { id: "y", slot: "Dinner", per: { cal: 400, p: 35, c: 30, f: 12 }, items: [] };
  assert.ok(M.food.scoreSuggestion(small, "Dinner", { cal: 300, p: 40, c: 30, f: 10 }, null, 0) > M.food.scoreSuggestion(big, "Dinner", { cal: 300, p: 40, c: 30, f: 10 }, null, 0) + 40);
});

t("suggest: never throws when the AI provider fails — falls back to built-ins only", async () => {
  M.ai.setKey("sk-ant-test");
  global.fetch = async () => { throw new TypeError("Failed to fetch"); };
  const list = await M.food.suggest({ slot: "Breakfast", remaining: { cal: 600, p: 40, c: 60, f: 20 } });
  assert.ok(list.length >= 6);
  assert.ok(list.every(s => s.source === "builtin"));
  /* and when the AI answers, its 3 ideas are prepended with source "ai" and per = sum(items) */
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ suggestions: [
    { name: "Cottage cheese and pineapple", desc: "Easy.", store: "Costco", prepMin: 2, items: [{ name: "Cottage cheese 2%", servingLabel: "1 cup (226 g)", g: 226, per: { cal: 180, p: 24, c: 8, f: 5, fiber: 0, sugar: 8, sodium_mg: 700 } }, { name: "Pineapple", servingLabel: "1/2 cup (80 g)", g: 80, per: { cal: 40, p: 0, c: 10, f: 0, fiber: 1, sugar: 8, sodium_mg: 1 } }] },
    { name: "Two", desc: "d", store: "King Soopers", prepMin: 5, items: [{ name: "A", servingLabel: "1 serving", g: null, per: { cal: 300, p: 30, c: 20, f: 10, fiber: 2, sugar: 3, sodium_mg: 400 } }] },
    { name: "Three", desc: "d", store: "wherever", prepMin: 5, items: [{ name: "B", servingLabel: "1 serving", g: null, per: { cal: 250, p: 25, c: 20, f: 8, fiber: 2, sugar: 3, sodium_mg: 300 } }] },
    { name: "Four (dropped)", desc: "d", store: "Costco", prepMin: 5, items: [{ name: "C", servingLabel: "1 serving", g: null, per: { cal: 250, p: 25, c: 20, f: 8, fiber: 2, sugar: 3, sodium_mg: 300 } }] }
  ] }) }] }) });
  const withAI = await M.food.suggest({ slot: "Breakfast", remaining: { cal: 600, p: 40, c: 60, f: 20 } });
  assert.strictEqual(withAI.filter(s => s.source === "ai").length, 3, "3 AI ideas");
  assert.strictEqual(withAI[0].source, "ai");
  assert.deepStrictEqual(withAI[0].per, { cal: 220, p: 24, c: 18, f: 5, fiber: 1, sugar: 16, sodium: 701 });
  assert.strictEqual(withAI[0].items[0].per.sodium, 700, "sodium_mg mapped to sodium");
  assert.strictEqual(withAI[0].store, "Costco");
  assert.strictEqual(withAI[2].store, "Either");
  assert.ok(withAI.slice(3).every(s => s.source === "builtin"));
  M.ai.setKey("");
  delete global.fetch;
});

/* ======================================================================= */
t("photo.estimate / estimateByName / describe (AI): item shapes, sodium mapping, sources", async () => {
  M.ai.setKey("sk-ant-test");
  let last = null;
  global.fetch = async (url, o) => {
    last = JSON.parse(o.body);
    const txt = last.messages[0].content.map(b => b.text || "").join(" ");
    let reply;
    if (/photo of food/i.test(txt)) reply = { items: [{ name: "Grilled chicken breast", servingLabel: "6 oz (170 g)", g: 170, per: { cal: 280, p: 52, c: 0, f: 6, fiber: 0, sugar: 0, sodium_mg: 125 } }, { name: "Steamed broccoli", servingLabel: "1 cup (156 g)", g: 156, per: { cal: 55, p: 4, c: 11, f: 0.5, fiber: 5, sugar: 2, sodium_mg: 64 } }], note: "Portions look like a standard dinner plate." };
    else if (/Estimate the nutrition of this food/i.test(txt)) reply = { name: "Costco chicken bake", brand: "Kirkland", serving: { qty: 1, unit: "bake", g: 300 }, per: { cal: 770, p: 46, c: 70, f: 30, fiber: 3, sugar: 4, sodium_mg: 1790 }, alts: [{ label: "1/2 bake", g: 150 }] };
    else reply = { items: [{ name: "Egg, scrambled", servingLabel: "2 large (100 g)", g: 100, per: { cal: 180, p: 12, c: 2, f: 13, fiber: 0, sugar: 1, sodium_mg: 340 } }], note: "" };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify(reply) }] }) };
  };
  /* photo: images are base64 blocks before the text block (downscale falls back to the raw blob without a canvas) */
  const fakeFile = { type: "image/jpeg", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  const ph = await M.food.photo.estimate(fakeFile, { slot: "Dinner" });
  assert.strictEqual(ph.items.length, 2);
  assert.strictEqual(ph.items[0].source, "photo");
  assert.strictEqual(ph.items[0].servings, 1);
  assert.strictEqual(ph.items[0].per.sodium, 125);
  assert.strictEqual(ph.items[0].per.sodium_mg, undefined);
  assert.strictEqual(ph.items[0].g, 170);
  assert.ok(/plate/.test(ph.note));
  assert.strictEqual(last.messages[0].content[0].type, "image");
  assert.strictEqual(last.messages[0].content[0].source.type, "base64");
  assert.strictEqual(last.messages[0].content[0].source.data, "AQID");
  assert.strictEqual(last.messages[0].content[1].type, "text");
  /* estimateByName */
  const f = await M.food.estimateByName("costco chicken bake");
  assert.strictEqual(f.source, "ai");
  assert.strictEqual(f.name, "Costco chicken bake");
  assert.strictEqual(f.brand, "Kirkland");
  assert.deepStrictEqual(f.serving, { qty: 1, unit: "bake", g: 300 });
  assert.strictEqual(f.per.sodium, 1790);
  assert.strictEqual(f.per100g.cal, 257);
  assert.ok(f.alts.some(a => a.label === "1/2 bake" && a.g === 150) && f.alts.some(a => a.g === 100));
  /* describe via AI */
  const d = await M.food.describe("2 scrambled eggs", { slot: "Breakfast" });
  assert.strictEqual(d.method, "ai");
  assert.strictEqual(d.items[0].source, "ai");
  assert.strictEqual(d.items[0].per.sodium, 340);
  M.ai.setKey("");
  delete global.fetch;
});

t("scanner.stop is safe with nothing running; start without a container rejects plainly", async () => {
  assert.strictEqual(await M.food.scanner.stop(), true);
  assert.strictEqual(await M.food.scanner.stop(), true);
  await M.food.scanner.start(null, () => {}).then(() => assert.fail(), e => assert.ok(e.code && e.message));
  assert.strictEqual(await M.food.scanner.fromImage(null), null);
});

t("barcode: bad code rejects {code:\"barcode\"}; local library hit returns without network; 12→13 digit retry", async () => {
  await M.food.barcode("12").then(() => assert.fail(), e => assert.strictEqual(e.code, "barcode"));
  const mine = M.foods.add({ name: "My bar", barcode: "0038000199103", serving: { qty: 1, unit: "bar", g: 60 }, per: { cal: 190, p: 21, c: 23, f: 7, fiber: 10, sugar: 2, sodium: 210 }, source: "off" });
  global.fetch = async () => { throw new Error("should not be called"); };
  const hit = await M.food.barcode("038000199103");
  assert.strictEqual(hit.id, mine.id, "matches ignoring leading zeros");
  M.foods.remove(mine.id);
  const urls = [];
  global.fetch = async url => { urls.push(url); return urls.length === 1 ? { ok: false, status: 404, json: async () => ({ status: 0 }) } : { ok: true, status: 200, json: async () => ({ status: 1, product: OFF_WITH_SERVING }) }; };
  const f = await M.food.barcode("038000199103");
  assert.ok(f && f.name === "Cheez-It Original");
  assert.ok(/product\/038000199103\.json/.test(urls[0]) && /product\/0038000199103\.json/.test(urls[1]), "tries code then 0+code");
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 0 }) });
  assert.strictEqual(await M.food.barcode("4006381333931"), null, "not found → null");
  global.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await M.food.barcode("4006381333931").then(() => assert.fail(), e => { assert.strictEqual(e.code, "network"); assert.ok(/connection/i.test(e.message)); });
  delete global.fetch;
});

t("searchOFF: builds the US-biased query, skips items without calories, dedupes", async () => {
  let seenUrl = "";
  global.fetch = async url => { seenUrl = url; return { ok: true, status: 200, json: async () => ({ products: [OFF_WITH_SERVING, OFF_WITH_SERVING, { product_name: "Nothing", nutriments: {} }, OFF_PER100_ONLY] }) }; };
  const list = await M.food.searchOFF("cheez it");
  assert.strictEqual(list.length, 2);
  assert.ok(/search_terms=cheez%20it/.test(seenUrl) && /tag_0=united-states/.test(seenUrl) && /page_size=15/.test(seenUrl) && /json=1/.test(seenUrl));
  assert.deepStrictEqual(await M.food.searchOFF("a"), []);
  delete global.fetch;
});

/* ---- run ---- */
(async () => {
  let pass = 0, fail = 0;
  for (const { name, fn } of tests) {
    try { await fn(); pass++; console.log("  ok   " + name); }
    catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n       ") : e)); }
  }
  console.log("\n" + pass + " passed, " + fail + " failed");
  if (fail) process.exit(1);
})();
