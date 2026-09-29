/* node tests/m-food.test.js — asserts for m-food.js (no network: fetch, camera, Claude and the
   barcode engine are all faked). Three environments: a plain Node shim (most tests), a fresh
   VM context with a fake claude.use("sample"), and jsdom with fake media devices (camera flow). */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const SRC = f => fs.readFileSync(path.join(ROOT, f), "utf8");

/* ---- tiny browser shim ---- */
global.window = global;
global.localStorage = {
  store: {},
  getItem(k) { return this.store[k] ?? null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; }
};
const NAV = { vibrate() { return true; } };
try { Object.defineProperty(global, "navigator", { value: NAV, configurable: true, writable: true }); } catch (e) {}
global.AbortController = class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } };

["m-core.js", "m-data.js", "m-food.js"].forEach(f => vm.runInThisContext(SRC(f), { filename: f }));
const M = global.M;
global.S = { profile: "nick" };
global.PRESETS = { nick: { name: "Nick" }, kat: { name: "Katerina" } };
M.reset();

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || "") + " expected " + a + " ≈ " + b + " (±" + tol + ")");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tests = [];
function t(name, fn) { tests.push({ name, fn }); }
const kcalOf = it => it.per.cal * it.servings;
const reply = obj => ({ ok: true, status: 200, json: async () => obj });
const plain = x => JSON.parse(JSON.stringify(x));   /* objects made in another VM context */
const claudeReply = obj => reply({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }] });

console.log("m-food.js");

/* ======================================================================= */
t("namespace: every public name m-ui / m-trends call, plus the new ones", () => {
  ["mode", "ready", "probe", "probed", "getKey", "setKey", "model", "json", "images", "test", "parseJSONText"].forEach(k => assert.strictEqual(typeof M.ai[k], "function", "M.ai." + k));
  ["downscale", "toBase64", "prepOCR"].forEach(k => assert.strictEqual(typeof M.img[k], "function", "M.img." + k));
  ["barcode", "lookup", "searchOFF", "fromOFF", "describe", "describeLocal", "parseQuantity", "matchLocal", "estimateByName", "suggest", "suggestBuiltin", "suggestMine", "suggestOften", "suggestClaude", "combos", "scoreSuggestion"].forEach(k => assert.strictEqual(typeof M.food[k], "function", "M.food." + k));
  ["start", "stop", "fromImage", "running", "torch", "hasTorch", "zoom", "hasZoom", "engine", "preload"].forEach(k => assert.strictEqual(typeof M.food.scanner[k], "function", "scanner." + k));
  ["parse", "fromImage"].forEach(k => assert.strictEqual(typeof M.food.label[k], "function", "label." + k));
  ["check", "valid", "normalize", "variants", "upceToUpca", "upcaToUpce"].forEach(k => assert.strictEqual(typeof M.food.gtin[k], "function", "gtin." + k));
  assert.strictEqual(typeof M.food.photo.estimate, "function");
});

t("pinned CDN files: barcode engine and Tesseract load from cdn.jsdelivr.net at exact versions", () => {
  const { SCAN, TESS } = M.food._;
  assert.strictEqual(SCAN.bd, "https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/iife/ponyfill.js");
  assert.strictEqual(SCAN.wasm, "https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.3/dist/reader/zxing_reader.wasm");
  assert.deepStrictEqual(SCAN.formats, ["ean_13", "upc_a", "upc_e", "ean_8"]);
  assert.ok(SCAN.frameMs >= 66 && SCAN.frameMs <= 100, "10–15 frames a second");
  assert.strictEqual(TESS.script, "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js");
  assert.strictEqual(TESS.workerPath, "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js");
  assert.strictEqual(TESS.corePath, "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1");
  assert.strictEqual(TESS.langPath, "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int");
  const cam = M.food._.CAM.video;
  assert.deepStrictEqual(cam.facingMode, { ideal: "environment" });
  assert.deepStrictEqual([cam.width, cam.height], [{ ideal: 1920 }, { ideal: 1080 }]);
  assert.ok(!/\(\?<[=!]/.test(SRC("m-food.js")), "no regex lookbehind (iOS Safari 16.0–16.3 can't parse it)");
});

/* ======================================================================= */
/* M.ai — API key path                                                      */
t("ai.mode: null with no key, \"key\" after setKey, null after setKey(\"\"); model from the profile", () => {
  M.ai.setKey("");
  assert.strictEqual(M.ai.mode(), null);
  assert.strictEqual(M.ai.ready(), false);
  M.ai.setKey("  sk-ant-test-123  ");
  assert.strictEqual(M.ai.mode(), "key");
  assert.strictEqual(M.ai.getKey(), "sk-ant-test-123");
  assert.strictEqual(global.localStorage.store["chalk.ai.key"], "sk-ant-test-123");
  M.ai.setKey("");
  assert.strictEqual(M.ai.mode(), null);
  assert.strictEqual(global.localStorage.store["chalk.ai.key"], undefined);
  assert.strictEqual(M.ai.model(), "claude-sonnet-5-5");
  M.person("nick").aiModel = "claude-haiku-4-5-20251001";
  assert.strictEqual(M.ai.model(), "claude-haiku-4-5-20251001");
  M.person("nick").aiModel = "claude-sonnet-5-5";
  assert.strictEqual(M.ai.timeoutMs, 30000);
});

t("ai.json without any provider rejects {code:\"no_ai\"} with a plain message (never throws)", async () => {
  M.ai.setKey("");
  let err = null;
  try { await M.ai.json("Reply with {\"ok\":true}"); } catch (e) { err = e; }
  assert.ok(err && err.code === "no_ai", "code " + (err && err.code));
  assert.ok(/claude/i.test(err.message), "plain message");
  await M.food.photo.estimate({}, { slot: "Lunch" }).then(() => assert.fail("should reject"), e => assert.strictEqual(e.code, "no_ai"));
});

t("ai.json key path: headers, body, fences stripped, one retry on 404 with haiku", async () => {
  const calls = [];
  global.fetch = async (url, o) => {
    calls.push({ url, headers: o.headers, body: JSON.parse(o.body) });
    if (calls.length === 1) return { ok: false, status: 404, json: async () => ({ type: "error", error: { type: "not_found_error", message: "model: nope" } }) };
    return claudeReply("```json\n{\"ok\":true,\"n\":2}\n```");
  };
  M.ai.setKey("sk-ant-test");
  const v = await M.ai.json("Reply with JSON");
  assert.deepStrictEqual(v, { ok: true, n: 2 });
  assert.strictEqual(calls.length, 2, "one retry");
  assert.strictEqual(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.strictEqual(calls[0].headers["x-api-key"], "sk-ant-test");
  assert.strictEqual(calls[0].headers["anthropic-version"], "2023-06-01");
  assert.strictEqual(calls[0].headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.strictEqual(calls[0].headers["content-type"], "application/json");
  assert.strictEqual(calls[0].body.model, "claude-sonnet-5-5");
  assert.strictEqual(calls[1].body.model, "claude-haiku-4-5-20251001");
  assert.strictEqual(calls[0].body.max_tokens, 1500);
  assert.deepStrictEqual(calls[0].body.messages, [{ role: "user", content: [{ type: "text", text: "Reply with JSON" }] }]);
  M.ai.setKey(""); delete global.fetch;
});

t("ai.json key path: plain-English errors for 401, 403, 429, 529, 500, 400 credit, garbage, network, offline, both models 404", async () => {
  M.ai.setKey("sk-ant-test");
  const cases = [
    [401, { type: "authentication_error", message: "invalid x-api-key" }, "auth", /key is wrong/i],
    [403, { type: "permission_error", message: "no" }, "forbidden", /isn't allowed/i],
    [429, { type: "rate_limit_error", message: "slow down" }, "rate_limited", /too many requests.*minute/i],
    [529, { type: "overloaded_error", message: "Overloaded" }, "overloaded", /overloaded.*minute/i],
    [500, { type: "api_error", message: "boom" }, "server", /problem/i],
    [400, { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." }, "billing", /credits/i],
    [404, { type: "not_found_error", message: "model" }, "model", /model/i]
  ];
  for (const [status, error, code, re] of cases) {
    global.fetch = async () => ({ ok: false, status, json: async () => ({ type: "error", error }) });
    await M.ai.json("x").then(() => assert.fail("should reject " + status), e => { assert.strictEqual(e.code, code, "status " + status); assert.ok(re.test(e.message), status + ": " + e.message); });
  }
  global.fetch = async () => claudeReply("I can't do JSON today");
  await M.ai.json("x").then(() => assert.fail(), e => assert.strictEqual(e.code, "bad_json"));
  global.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await M.ai.json("x").then(() => assert.fail(), e => { assert.strictEqual(e.code, "network"); assert.ok(/connection/i.test(e.message)); });
  NAV.onLine = false;
  await M.ai.json("x").then(() => assert.fail(), e => { assert.strictEqual(e.code, "offline"); assert.ok(/offline/i.test(e.message)); });
  delete NAV.onLine;
  M.ai.setKey(""); delete global.fetch;
});

t("ai.json key path: times out (default 30 s; here opt.timeout 60 ms) with a plain message", async () => {
  M.ai.setKey("sk-ant-test");
  global.fetch = () => new Promise(() => {});           /* never answers */
  const t0 = Date.now();
  await M.ai.json("x", { timeout: 60 }).then(() => assert.fail(), e => { assert.strictEqual(e.code, "timeout"); assert.ok(/too long/i.test(e.message)); });
  assert.ok(Date.now() - t0 < 1500, "stopped on time");
  M.ai.setKey(""); delete global.fetch;
});

t("ai.parseJSONText: whole / fenced / chatty / braces in prose / trailing commas / cut-off fence; else bad_json", () => {
  const p = M.ai.parseJSONText;
  assert.deepStrictEqual(p('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(p('```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
  assert.deepStrictEqual(p('Here you go: {"a":"b"} hope that helps'), { a: "b" });
  assert.deepStrictEqual(p('I used {curly} notes first.\n{"items":[{"n":"x {y}"}]}\nDone {ok}.'), { items: [{ n: "x {y}" }] });
  assert.deepStrictEqual(p('```\nnot json\n```\n```json\n{"b":2,}\n```'), { b: 2 });
  assert.deepStrictEqual(p('```json\n{"cut": {"x": 1}} and then the reply stops'), { cut: { x: 1 } });
  assert.deepStrictEqual(p("[1,2,3]"), [1, 2, 3]);
  assert.deepStrictEqual(p("{“q”: 1}"), { q: 1 });
  assert.throws(() => p("nothing here"), e => e.code === "bad_json");
  assert.throws(() => p(""), e => e.code === "bad_json");
});

/* ======================================================================= */
/* M.ai — inside claude.ai: claude.use("sample"), exactly as sample.d.ts says */
function freshContext(setup) {
  const store = {};
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, Blob, TextEncoder, URL, Buffer,
    AbortController: global.AbortController,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    navigator: { vibrate() { return true; } }
  });
  vm.runInContext("var window = this;", ctx);
  if (setup) setup(ctx);
  ["m-core.js", "m-data.js", "m-food.js"].forEach(f => vm.runInContext(SRC(f), ctx, { filename: f }));
  vm.runInContext("var S = { profile: 'nick' }; var PRESETS = { nick: { name: 'Nick' } }; M.reset();", ctx);
  return ctx;
}
function fakeSample(behave) {
  const calls = [];
  const fn = async (input, opt) => ({ text: "ok", truncated: false });
  fn.json = (input, opt) => { calls.push({ input, opt }); return behave(input, opt, calls.length); };
  fn.limits = async () => fn.lim;
  fn.lim = { maxPromptBytes: 65536, images: { maxCount: 1, maxInputBytes: 20e6, mediaTypes: ["image/jpeg", "image/png"] } };
  fn.calls = calls;
  return fn;
}

t("sample path: claude.use(\"sample\") → sample.json(prompt, {modelTier}); cache off for Test; no page-side timer", async () => {
  const s = fakeSample(async (input, opt, n) => { await sleep(40); return { ok: true, n }; });
  const ctx = freshContext(c => { c.claude = { use: async name => (name === "sample" ? s : null) }; });
  const ai = ctx.M.ai;
  assert.strictEqual(await ai.probe(), "sample");
  assert.strictEqual(ai.mode(), "sample");
  const v = await ai.json("Reply", { tier: "quick", timeout: 5 });      /* timeout is for the key path only */
  assert.deepStrictEqual(plain(v), { ok: true, n: 1 });
  assert.strictEqual(s.calls[0].input, "Reply");
  assert.deepStrictEqual(plain(s.calls[0].opt), { modelTier: "quick" });
  assert.strictEqual(await ai.test(), true);
  assert.strictEqual(s.calls[1].opt.cache, false, "Test always asks Claude");
  assert.strictEqual(await ai.images(), true);
  const img = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
  await ai.json("Look", { images: [img] });
  assert.strictEqual(s.calls[2].opt.images.length, 1, "images passed when limits().images");
});

t("sample path: errors map by code; not_granted turns claude.ai off and falls back to a saved key", async () => {
  let code = "rate_limited";
  const s = fakeSample(async () => { throw { code, message: "dev text" }; });
  const ctx = freshContext(c => { c.claude = { use: async () => s }; });
  const ai = ctx.M.ai;
  await ai.probe();
  const expect = { rate_limited: ["rate_limited", /minute/], refused: ["refused", /couldn't help/], invalid_json: ["bad_json", /couldn't be read/], upstream_error: ["network", /problem/], session_expired: ["auth", /sign in/i], image_rejected: ["image", /photo/], weird_new_code: ["network", /problem/] };
  for (const k of Object.keys(expect)) {
    code = k;
    await ai.json("x").then(() => assert.fail(), e => { assert.strictEqual(e.code, expect[k][0], k); assert.ok(expect[k][1].test(e.message), k + ": " + e.message); });
  }
  assert.strictEqual(ai.mode(), "sample", "transient errors keep claude.ai on");
  code = "not_granted";
  await ai.json("x").then(() => assert.fail(), e => assert.strictEqual(e.code, "no_ai"));
  assert.strictEqual(ai.mode(), null, "declined → hidden for this view");
  ai.setKey("sk-ant-x");
  assert.strictEqual(ai.mode(), "key");
  ctx.fetch = async () => claudeReply({ via: "key" });
  assert.deepStrictEqual(plain(await ai.json("x")), { via: "key" });
});

t("sample path: no images in this view → photo calls use the saved key, or say plainly they can't", async () => {
  const s = fakeSample(async () => ({ ok: 1 }));
  s.lim = { maxPromptBytes: 65536 };                      /* no images member */
  const ctx = freshContext(c => { c.claude = { use: async () => s }; });
  const ai = ctx.M.ai;
  await ai.probe();
  assert.strictEqual(await ai.images(), false);
  const img = new Blob([new Uint8Array([1])], { type: "image/jpeg" });
  await ai.json("Look", { images: [img] }).then(() => assert.fail(), e => { assert.strictEqual(e.code, "no_ai"); assert.ok(/photos/i.test(e.message)); });
  ai.setKey("sk-ant-x");
  let sent = null;
  ctx.fetch = async (u, o) => { sent = JSON.parse(o.body); return claudeReply({ seen: true }); };
  assert.deepStrictEqual(plain(await ai.json("Look", { images: [img] })), { seen: true });
  assert.strictEqual(sent.messages[0].content[0].type, "image");
  assert.strictEqual(s.calls.length, 0, "never sent to sample without images support");
});

t("sample path: claude.use resolving null (not a Claude viewer) → key or no_ai", async () => {
  const ctx = freshContext(c => { c.claude = { use: async () => null }; });
  assert.strictEqual(await ctx.M.ai.probe(), null);
  await ctx.M.ai.json("x").then(() => assert.fail(), e => assert.strictEqual(e.code, "no_ai"));
});

/* ======================================================================= */
/* Barcodes: GTIN                                                           */
t("gtin: check digits, UPC-E ↔ UPC-A (all four zero-suppression rules), validity", () => {
  const G = M.food.gtin;
  assert.ok(G.valid("036000291452"), "UPC-A");
  assert.ok(G.valid("4006381333931"), "EAN-13");
  assert.ok(G.valid("96385074"), "EAN-8");
  assert.ok(!G.valid("036000291453"), "bad check digit");
  /* rule by last digit: 0-2, 3, 4, 5-9 */
  assert.strictEqual(G.upceToUpca("01234505"), "012000003455");
  assert.strictEqual(G.upceToUpca("01234531"), "012300000451");
  assert.strictEqual(G.upceToUpca("01234543"), "012340000053");
  assert.strictEqual(G.upceToUpca("01234565"), "012345000065");
  ["012000003455", "012300000451", "012340000053", "012345000065"].forEach(a => assert.strictEqual(G.upceToUpca(G.upcaToUpce(a)), a, "round trip " + a));
  assert.strictEqual(G.upceToUpca("01234566"), "", "UPC-E with a wrong check digit");
  assert.strictEqual(G.upcaToUpce("036000291452"), "", "not compressible");
  assert.strictEqual(G.upceToUpca("06420680"), "064206000080".slice(0, 11) + G.check("06420600008"));
});

t("gtin.normalize: scanner outputs → digits as printed; bad check digits → \"\"", () => {
  const N = M.food.gtin.normalize;
  assert.strictEqual(N("0036000291452", "ean_13"), "036000291452", "UPC-A reported as EAN-13");
  assert.strictEqual(N("036000291452", "upc_a"), "036000291452");
  assert.strictEqual(N("4006381333931", "ean_13"), "4006381333931");
  assert.strictEqual(N("0012345000065", "upc_e"), "01234565", "zxing expands UPC-E to 13 digits");
  assert.strictEqual(N("012345000065", "upc_e"), "01234565");
  assert.strictEqual(N("01234565", "upc_e"), "01234565");
  assert.strictEqual(N("96385074", "ean_8"), "96385074");
  assert.strictEqual(N("0036000291453", "ean_13"), "", "checksum fails");
  assert.strictEqual(N("12345", ""), "");
  assert.strictEqual(N("36000291452", ""), "036000291452", "typed without the leading 0");
  assert.strictEqual(N(" 0 36000 29145 2 ", ""), "036000291452", "spaces typed");
});

t("gtin.variants: lookup order (13-digit GTIN first; UPC-E as printed first, then expanded)", () => {
  const V = M.food.gtin.variants;
  assert.deepStrictEqual(V("036000291452"), ["0036000291452", "036000291452"]);
  assert.deepStrictEqual(V("0036000291452"), ["0036000291452", "036000291452"]);
  assert.deepStrictEqual(V("01234565"), ["01234565", "0012345000065", "012345000065", "0000001234565"].filter(v => v !== "0000001234565" || M.food.gtin.valid("01234565")));
  assert.deepStrictEqual(V("012345000065"), ["0012345000065", "012345000065", "01234565"]);
  assert.deepStrictEqual(V("96385074"), ["96385074", "0000096385074"]);
});

/* ======================================================================= */
/* Open Food Facts — REAL responses saved from world.openfoodfacts.org (api/v2, the app's fields) */
const OFF_KIRKLAND_BAR = JSON.parse('{"code":"0096619193738","product":{"brands":"Kirkland Signature","code":"0096619193738","nutriments":{"added-sugars":3.33333333333333,"added-sugars_100g":3.33333333333333,"added-sugars_serving":2,"added-sugars_unit":"g","added-sugars_value":3.33333333333333,"calcium":0.153333333333333,"calcium_100g":0.153333333333333,"calcium_serving":0.092,"calcium_unit":"g","calcium_value":0.153333333333333,"carbohydrates":40,"carbohydrates_100g":40,"carbohydrates_serving":24,"carbohydrates_unit":"g","carbohydrates_value":40,"cholesterol":0.00833333333333333,"cholesterol_100g":0.00833333333333333,"cholesterol_serving":0.005,"cholesterol_unit":"g","cholesterol_value":0.00833333333333333,"energy":1611.66666666667,"energy-kcal":283.333333333333,"energy-kcal_100g":283.333333333333,"energy-kcal_serving":170,"energy-kcal_unit":"kcal","energy-kcal_value":283.333333333333,"energy-kj":1611.66666666667,"energy-kj_100g":1611.66666666667,"energy-kj_modifier":"~","energy-kj_serving":967,"energy-kj_unit":"kJ","energy-kj_value":1611.66666666667,"energy_100g":1611.66666666667,"energy_modifier":"~","energy_serving":967,"energy_unit":"kJ","energy_value":1611.66666666667,"fat":8.3333333333333,"fat_100g":8.3333333333333,"fat_serving":5,"fat_unit":"g","fat_value":8.3333333333333,"fiber":18.3333333333333,"fiber_100g":18.3333333333333,"fiber_serving":11,"fiber_unit":"g","fiber_value":18.3333333333333,"fruits-vegetables-legumes-estimate-from-ingredients_100g":0,"fruits-vegetables-nuts-estimate-from-ingredients_100g":0,"iron":0.00133333333333333,"iron_100g":0.00133333333333333,"iron_serving":0.0008,"iron_unit":"g","iron_value":0.00133333333333333,"nova-group":4,"nova-group_100g":4,"nova-group_serving":4,"nova-group_unit":"","nova-group_value":4,"potassium":0.0916666666666667,"potassium_100g":0.0916666666666667,"potassium_serving":0.055,"potassium_unit":"g","potassium_value":0.0916666666666667,"proteins":36.666666666667,"proteins_100g":36.666666666667,"proteins_serving":22,"proteins_unit":"g","proteins_value":36.666666666667,"salt":0.75,"salt_100g":0.75,"salt_serving":0.45,"salt_unit":"g","salt_value":0.75,"saturated-fat":3.3333333333333,"saturated-fat_100g":3.3333333333333,"saturated-fat_serving":2,"saturated-fat_unit":"g","saturated-fat_value":3.3333333333333,"sodium":0.3,"sodium_100g":0.3,"sodium_serving":0.18,"sodium_unit":"g","sodium_value":0.3,"sugars":3.3333333333333,"sugars_100g":3.3333333333333,"sugars_serving":2,"sugars_unit":"g","sugars_value":3.3333333333333},"nutrition_data":"on","nutrition_data_per":"100g","nutrition_data_prepared_per":"100g","product_name":"Protein Bar Cookies and Cream","product_name_en":"Protein Bar Cookies and Cream","serving_quantity":60,"serving_quantity_unit":"g","serving_size":"1 bar (60 g)"},"status":1,"status_verbose":"product found"}');
const OFF_FAGE_UPCE = JSON.parse('{"code":"06420680","product":{"brands":"Fage","code":"06420680","ecoscore_tags":["unknown"],"nutriments":{"carbohydrates":3,"carbohydrates_100g":3,"carbohydrates_serving":3,"carbohydrates_unit":"g","carbohydrates_value":3,"energy":225,"energy-kcal":54,"energy-kcal_100g":54,"energy-kcal_serving":54,"energy-kcal_unit":"kcal","energy-kcal_value":54,"energy_100g":225,"energy_serving":225,"energy_unit":"kJ","energy_value":225,"proteins":10.3000001907349,"proteins_100g":10.3000001907349,"proteins_serving":10.3,"proteins_unit":"g","proteins_value":10.3000001907349,"sugars":3,"sugars_100g":3,"sugars_serving":3,"sugars_unit":"g","sugars_value":3},"nutrition_data":"on","nutrition_data_per":"100g","nutrition_data_prepared_per":"100g","product_name":"Fage Total 0%","product_name_en":"Fage Total 0%","serving_quantity":100,"serving_quantity_unit":"g","serving_size":"100.0g"},"status":1,"status_verbose":"product found"}');
const OFF_OIKOS = JSON.parse('{"code":"0036632042583","product":{"brands":"Oikos","code":"0036632042583","nutriments":{"added-sugars":0,"added-sugars_100g":0,"added-sugars_serving":0,"added-sugars_unit":"g","added-sugars_value":0.0,"calcium":0.13,"calcium_100g":0.13,"calcium_serving":0.195,"calcium_unit":"g","calcium_value":0.13,"carbohydrates":4,"carbohydrates_100g":4,"carbohydrates_serving":6,"carbohydrates_unit":"g","carbohydrates_value":4.0,"cholesterol":0.0166666666666667,"cholesterol_100g":0.0166666666666667,"cholesterol_serving":0.025,"cholesterol_unit":"g","cholesterol_value":0.0166666666666667,"choline":0,"choline_100g":0,"choline_serving":0,"choline_unit":"g","choline_value":0.0,"energy":368.666666666667,"energy-kcal":86.6666666666667,"energy-kcal_100g":86.6666666666667,"energy-kcal_serving":130,"energy-kcal_unit":"kcal","energy-kcal_value":86.6666666666667,"energy-kj":368.666666666667,"energy-kj_100g":368.666666666667,"energy-kj_modifier":"~","energy-kj_serving":553,"energy-kj_unit":"kJ","energy-kj_value":368.666666666667,"energy_100g":368.666666666667,"energy_modifier":"~","energy_serving":553,"energy_unit":"kJ","energy_value":368.666666666667,"fat":2,"fat_100g":2,"fat_serving":3,"fat_unit":"g","fat_value":2.0,"fiber":0,"fiber_100g":0,"fiber_serving":0,"fiber_unit":"g","fiber_value":0.0,"proteins":13.3333333333333,"proteins_100g":13.3333333333333,"proteins_serving":20,"proteins_unit":"g","proteins_value":13.3333333333333,"salt":0.075,"salt_100g":0.075,"salt_serving":0.113,"salt_unit":"g","salt_value":0.075,"saturated-fat":1.66666666666667,"saturated-fat_100g":1.66666666666667,"saturated-fat_serving":2.5,"saturated-fat_unit":"g","saturated-fat_value":1.66666666666667,"sodium":0.03,"sodium_100g":0.03,"sodium_serving":0.045,"sodium_unit":"g","sodium_value":0.03,"sugars":2,"sugars_100g":2,"sugars_serving":3,"sugars_unit":"g","sugars_value":2.0},"nutrition_data":"on","nutrition_data_per":"100g","nutrition_data_prepared_per":"100g","product_name":"Oikos Pro Mixed Berry","product_name_en":"Oikos Pro Mixed Berry","product_quantity":150.2524725625,"product_quantity_unit":"g","quantity":"5.3oz","serving_quantity":150,"serving_quantity_unit":"ml","serving_size":"1 cup (150 g)"},"status":1,"status_verbose":"product found"}');
const OFF_NO_NUTRITION = JSON.parse('{"code":"6111099005488","product":{"brands":"Lilia","code":"6111099005488","product_name":"Tartine & Cuisine"},"status":1,"status_verbose":"product found"}');
const OFF_NOT_FOUND = { code: "4006381333932", status: 0, status_verbose: "product not found" };

t("fromOFF (real: Kirkland protein bar): the label's own per-serving numbers, per100g, sodium mg, tidy serving", () => {
  const f = M.food.fromOFF(OFF_KIRKLAND_BAR.product);
  assert.strictEqual(f.source, "off");
  assert.strictEqual(f.barcode, "0096619193738");
  assert.strictEqual(f.id, "off_0096619193738");
  assert.strictEqual(f.name, "Protein Bar Cookies and Cream");
  assert.strictEqual(f.brand, "Kirkland Signature");
  assert.deepStrictEqual(f.serving, { qty: 1, unit: "bar", g: 60 });
  assert.deepStrictEqual(f.per, { cal: 170, p: 22, c: 24, f: 5, fiber: 11, sugar: 2, sodium: 180 });
  assert.deepStrictEqual(f.per100g, { cal: 283, p: 36.7, c: 40, f: 8.3, fiber: 18.3, sugar: 3.3, sodium: 300 });
  assert.ok(f.alts.some(a => a.label === "100 g" && a.g === 100) && f.alts.some(a => a.label === "1 oz"));
});

t("fromOFF (real: Fage under its 8-digit code, per 100 g only, no fat/sodium given): zeros, 100 g serving", () => {
  const f = M.food.fromOFF(OFF_FAGE_UPCE.product);
  assert.strictEqual(f.barcode, "06420680");
  assert.strictEqual(f.name, "Fage Total 0%");
  assert.deepStrictEqual(f.serving, { qty: 100, unit: "g", g: 100 });
  assert.deepStrictEqual(f.per, { cal: 54, p: 10.3, c: 3, f: 0, fiber: 0, sugar: 3, sodium: 0 });
});

t("fromOFF (real: Oikos, serving_quantity_unit \"ml\" vs \"1 cup (150 g)\", single cup): g 150, no duplicate package alt", () => {
  const f = M.food.fromOFF(OFF_OIKOS.product);
  assert.deepStrictEqual(f.serving, { qty: 1, unit: "cup", g: 150 });
  assert.deepStrictEqual(f.per, { cal: 130, p: 20, c: 6, f: 3, fiber: 0, sugar: 3, sodium: 45 });
  assert.ok(!f.alts.some(a => a.label === "1 package"), "the 5.3 oz cup IS the serving");
  assert.strictEqual(f.quantity, "5.3oz");
});

t("fromOFF (real: product with no nutrition) → null; edge cases: kJ-only, salt-only, 0 kcal, macros-only, names", () => {
  assert.strictEqual(M.food.fromOFF(OFF_NO_NUTRITION.product), null);
  assert.strictEqual(M.food.fromOFF(null), null);
  assert.strictEqual(M.food.fromOFF({ product_name: "No numbers", nutriments: {} }), null);
  assert.strictEqual(M.food.fromOFF({ nutriments: { "energy-kcal_100g": 100 } }), null, "nothing to call it → null");
  /* kJ only (Australian / EU style) + salt only */
  const kj = M.food.fromOFF({ code: "9300000000001", product_name: "", product_name_en: "Total 0% Greek Yogurt", brands: "Fage", nutriments: { "energy-kj_100g": 238, energy_100g: 238, proteins_100g: 10.3, carbohydrates_100g: 3.8, fat_100g: 0, sugars_100g: 3.8, salt_100g: 0.09 } });
  assert.strictEqual(kj.name, "Total 0% Greek Yogurt", "falls back to product_name_en");
  assert.strictEqual(kj.per100g.cal, 57, "238 kJ / 4.184");
  assert.strictEqual(kj.per100g.sodium, 36, "0.09 g salt / 2.5 → 36 mg sodium");
  assert.deepStrictEqual(kj.serving, { qty: 100, unit: "g", g: 100 });
  /* kcal stored as 0 but kJ present (bad entry) → kJ wins; a real 0 kcal stays 0 */
  assert.strictEqual(M.food.fromOFF({ code: "1", product_name: "Oops", nutriments: { "energy-kcal_100g": 0, "energy-kj_100g": 418.4 } }).per100g.cal, 100);
  const water = M.food.fromOFF({ code: "2", product_name: "Sparkling water", nutriments: { "energy-kcal_100g": 0, energy_100g: 0 } });
  assert.ok(water && water.per.cal === 0, "0 kcal product kept");
  /* no energy at all but macros → 4/4/9 estimate */
  assert.strictEqual(M.food.fromOFF({ code: "3", product_name: "Beans", nutriments: { proteins_100g: 7, carbohydrates_100g: 20, fat_100g: 1 } }).per100g.cal, 117);
  /* ALL CAPS name + brand, name that is only the brand */
  const caps = M.food.fromOFF({ code: "4", product_name: "KIRKLAND SIGNATURE ORGANIC CHICKEN BREAST 6.3 LB", brands: "KIRKLAND SIGNATURE,Kirkland", nutriments: { "energy-kcal_100g": 120, proteins_100g: 22 } });
  assert.strictEqual(caps.name, "Kirkland Signature Organic Chicken Breast 6.3 lb");
  assert.strictEqual(caps.brand, "Kirkland Signature");
  const brandOnly = M.food.fromOFF({ code: "5", product_name: "Chobani", generic_name: "Greek yogurt, vanilla", brands: "Chobani", nutriments: { "energy-kcal_100g": 76 } });
  assert.strictEqual(brandOnly.name, "Greek yogurt, vanilla");
  assert.strictEqual(M.food.fromOFF({ code: "6", product_name: "  greek   yogurt  ", nutriments: { "energy-kcal_100g": 59 } }).name, "Greek yogurt");
});

t("fromOFF serving sizes: ml, Tbsp, BAR, grams + ounces, fractions in parentheses, package alt, per-serving only", () => {
  const ranch = M.food.fromOFF({ code: "12345678", product_name: "Ranch", serving_size: "2 Tbsp (30mL)", nutriments: { "energy-kcal_100g": 433, fat_100g: 46.7, sodium_100g: 0.867 } });
  assert.deepStrictEqual(ranch.serving, { qty: 2, unit: "Tbsp", g: 30 });
  assert.strictEqual(ranch.per.cal, 130);
  assert.strictEqual(ranch.per.f, 14);
  assert.strictEqual(ranch.per.sodium, 260);
  const PS = M.food._.parseServingSize;
  assert.deepStrictEqual(PS("2/3 cup (55g/1.9 oz)"), { qty: 0.667, unit: "cup", g: 55 });
  assert.deepStrictEqual(PS("30 g (1/4 cup)"), { qty: 0.25, unit: "cup", g: 30 });
  assert.deepStrictEqual(PS("1 BAR (60 g)"), { qty: 1, unit: "bar", g: 60 });
  assert.deepStrictEqual(PS("4 oz (112g)"), { qty: 4, unit: "oz", g: 112 });
  assert.deepStrictEqual(PS("1 1/2 cups (360 ml)"), { qty: 1.5, unit: "cups", g: 360 });
  assert.deepStrictEqual(PS("55g"), { qty: 55, unit: "g", g: 55 });
  assert.strictEqual(M.food._.packageGrams("14 fl oz (414 mL)"), 14 * 29.57);
  assert.strictEqual(M.food._.packageGrams("12 x 330 ml"), null, "multipack");
  const tub = M.food.fromOFF({ code: "7", product_name: "Plain yogurt", serving_size: "3/4 cup (170 g)", quantity: "32 oz", nutriments: { "energy-kcal_100g": 59 } });
  assert.ok(tub.alts.some(a => a.label === "1 package" && Math.abs(a.g - 907.2) < 0.5), JSON.stringify(tub.alts));
  const soda = M.food.fromOFF({ code: "8", product_name: "Diet soda", serving_size: "1 can", nutriments: { "energy-kcal_serving": 0, sodium_serving: 0.04 } });
  assert.deepStrictEqual(soda.serving, { qty: 1, unit: "can", g: null });
  assert.strictEqual(soda.per.sodium, 40);
});

/* ======================================================================= */
/* lookup / barcode                                                         */
t("lookup: found → saved to My foods (source off, barcode); second scan instant, offline, any code form", async () => {
  M.reset();
  const urls = [];
  global.fetch = async url => { urls.push(url); return reply(OFF_KIRKLAND_BAR); };
  const r = await M.food.lookup("096619193738");
  assert.strictEqual(r.status, "found");
  assert.strictEqual(r.saved, false);
  assert.ok(/\/api\/v2\/product\/0096619193738\.json\?fields=code,product_name/.test(urls[0]), urls[0]);
  assert.strictEqual(urls.length, 1);
  const saved = M.foods.findByBarcode("0096619193738");
  assert.ok(saved && saved.source === "off" && saved.barcode === "0096619193738" && saved.name === "Protein Bar Cookies and Cream");
  assert.strictEqual(M.MS.foods[r.food.id], r.food, "returned food IS the saved one");
  global.fetch = async () => { throw new Error("must not touch the network"); };
  NAV.onLine = false;
  const again = await M.food.lookup("0096619193738");
  assert.strictEqual(again.status, "found");
  assert.strictEqual(again.saved, true);
  assert.strictEqual(again.food.id, saved.id);
  assert.strictEqual((await M.food.barcode("96619193738")).id, saved.id, "typed without the leading zero");
  delete NAV.onLine;
  delete global.fetch;
});

t("lookup: UPC-E tried as printed first (Fage is stored under 8 digits), then matched as UPC-A later", async () => {
  M.reset();
  const urls = [];
  global.fetch = async url => { urls.push(url); return /06420680\.json/.test(url) ? reply(OFF_FAGE_UPCE) : { ok: false, status: 404, json: async () => OFF_NOT_FOUND }; };
  const f = await M.food.barcode("06420680");
  assert.ok(f && f.name === "Fage Total 0%");
  assert.ok(/product\/06420680\.json/.test(urls[0]), "8 digits first: " + urls[0]);
  global.fetch = async () => { throw new Error("offline"); };
  const up = M.food.gtin.upceToUpca("06420680");
  assert.ok(up, "06420680 is a valid UPC-E");
  assert.strictEqual((await M.food.barcode(up)).id, f.id, "same product when the UPC-A form is scanned");
  delete global.fetch;
});

t("lookup: 404 on the first form then found; no nutrition → clear result (name/brand) and barcode() → null", async () => {
  M.reset();
  const urls = [];
  global.fetch = async url => { urls.push(url); return urls.length === 1 ? { ok: false, status: 404, json: async () => OFF_NOT_FOUND } : reply(OFF_OIKOS); };
  const f = await M.food.barcode("036632042583");
  assert.ok(f && f.name === "Oikos Pro Mixed Berry");
  assert.ok(/0036632042583\.json/.test(urls[0]) && /\/036632042583\.json/.test(urls[1]), urls.join(" "));
  global.fetch = async () => reply(OFF_NO_NUTRITION);
  const r = await M.food.lookup("6111099005488");
  assert.strictEqual(r.status, "no_nutrition");
  assert.deepStrictEqual(r.product, { name: "Tartine & Cuisine", brand: "Lilia", barcode: "6111099005488", quantity: "" });
  assert.ok(/no nutrition/i.test(r.message) && /scan the label/i.test(r.message));
  assert.strictEqual(await M.food.barcode("6111099005488"), null);
  assert.strictEqual(M.food.lastLookup.status, "no_nutrition", "the UI can tell 'no nutrition' from 'not found'");
  assert.strictEqual(Object.keys(M.MS.foods).length, 1, "nothing saved without nutrition");
  delete global.fetch;
});

t("lookup: not found / bad codes / OFF busy (429 HTML) / OFF down (503) / offline / timeout", async () => {
  M.reset();
  global.fetch = async () => ({ ok: false, status: 404, json: async () => OFF_NOT_FOUND });
  const nf = await M.food.lookup("4006381333931");
  assert.strictEqual(nf.status, "not_found");
  assert.ok(/isn't in Open Food Facts/i.test(nf.message));
  assert.strictEqual(await M.food.barcode("4006381333931"), null);
  await M.food.lookup("12").then(() => assert.fail(), e => { assert.strictEqual(e.code, "barcode"); assert.ok(/numbers under the bars/.test(e.message)); });
  await M.food.lookup("4006381333932").then(() => assert.fail(), e => { assert.strictEqual(e.code, "barcode"); assert.ok(/don't match/.test(e.message)); });
  global.fetch = async () => ({ ok: false, status: 429, json: async () => { throw new SyntaxError("<html>"); } });
  await M.food.lookup("4006381333931").then(() => assert.fail(), e => { assert.strictEqual(e.code, "busy"); assert.ok(/busy.*minute/i.test(e.message)); });
  global.fetch = async () => ({ ok: false, status: 503, json: async () => { throw new SyntaxError("<html>"); } });
  await M.food.lookup("4006381333931").then(() => assert.fail(), e => assert.strictEqual(e.code, "off_down"));
  global.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await M.food.lookup("4006381333931").then(() => assert.fail(), e => { assert.strictEqual(e.code, "network"); assert.ok(/connection/i.test(e.message)); });
  NAV.onLine = false;
  await M.food.lookup("4006381333931").then(() => assert.fail(), e => assert.strictEqual(e.code, "offline"));
  delete NAV.onLine;
  let n = 0;
  global.fetch = () => { n++; return new Promise(() => {}); };
  const t0 = Date.now();
  await M.food.lookup("4006381333931", { timeout: 50 }).then(() => assert.fail(), e => { assert.strictEqual(e.code, "timeout"); assert.ok(/too long/.test(e.message)); });
  assert.ok(Date.now() - t0 < 1000 && n === 1, "gives up after one slow request");
  delete global.fetch;
});

t("searchOFF: US-biased query, skips items without calories, dedupes, tidy names; busy / down errors", async () => {
  let seenUrl = "";
  global.fetch = async url => { seenUrl = url; return reply({ products: [OFF_KIRKLAND_BAR.product, OFF_KIRKLAND_BAR.product, OFF_NO_NUTRITION.product, OFF_OIKOS.product] }); };
  const list = await M.food.searchOFF("protein bar");
  assert.deepStrictEqual(list.map(f => f.name), ["Protein Bar Cookies and Cream", "Oikos Pro Mixed Berry"]);
  assert.ok(/search_terms=protein%20bar/.test(seenUrl) && /tag_0=united-states/.test(seenUrl) && /page_size=15/.test(seenUrl) && /json=1/.test(seenUrl));
  assert.deepStrictEqual(await M.food.searchOFF("a"), []);
  global.fetch = async () => ({ ok: false, status: 503, json: async () => null });
  await M.food.searchOFF("yogurt").then(() => assert.fail(), e => assert.strictEqual(e.code, "off_down"));
  global.fetch = async () => ({ ok: false, status: 429, json: async () => null });
  await M.food.searchOFF("yogurt").then(() => assert.fail(), e => assert.strictEqual(e.code, "busy"));
  delete global.fetch;
});

/* ======================================================================= */
/* Scanner — pure parts                                                     */
t("scanner.bandRect: decodes what the person sees (object-fit cover), middle band, ≤1280 px wide", () => {
  const B = M.food._.bandRect;
  /* iPhone portrait 1080x1920 in a 358 x 268.5 box: visible 1080 x 810, band 1080 x 486 */
  assert.deepStrictEqual(B(1080, 1920, 358, 268.5), { sx: 0, sy: 717, sw: 1080, sh: 486, dw: 1080, dh: 486 });
  /* landscape 1920x1080: visible 1440 x 1080, band 1440 x 648 scaled to 1280 x 576 */
  assert.deepStrictEqual(B(1920, 1080, 358, 268.5), { sx: 240, sy: 216, sw: 1440, sh: 648, dw: 1280, dh: 576 });
  assert.deepStrictEqual(B(640, 480, 0, 0), { sx: 0, sy: 96, sw: 640, sh: 288, dw: 640, dh: 288 }, "no box: 60% of the frame height");
  assert.strictEqual(B(0, 0, 100, 100), null);
});

t("scanner accept rule: same code on two decoded frames in a row (≤1.5 s), 3 s dedupe, other codes reset", () => {
  const acc = M.food._.makeAcceptor();
  assert.deepStrictEqual(acc.frame(["036000291452"], 0), [], "first sighting waits");
  assert.deepStrictEqual(acc.frame(["036000291452"], 80), ["036000291452"], "second agreeing frame accepts");
  assert.deepStrictEqual(acc.frame(["036000291452"], 160), []);
  assert.deepStrictEqual(acc.frame(["036000291452"], 240), [], "within 3 s: deduped");
  assert.deepStrictEqual(acc.frame(["036000291452"], 3100), []);
  assert.deepStrictEqual(acc.frame(["036000291452"], 3180), ["036000291452"], "after 3 s it may fire again");
  const b = M.food._.makeAcceptor();
  b.frame(["A1"], 0); b.frame(["B2"], 80);
  assert.deepStrictEqual(b.frame(["A1"], 160), [], "a different code in between resets");
  assert.deepStrictEqual(b.frame(["A1"], 240), ["A1"]);
  const c = M.food._.makeAcceptor();
  c.frame(["X"], 0); c.frame([], 80); c.frame([], 160);
  assert.deepStrictEqual(c.frame(["X"], 240), ["X"], "frames with no read don't reset");
  const d = M.food._.makeAcceptor();
  d.frame(["Y"], 0);
  assert.deepStrictEqual(d.frame(["Y"], 1600), [], "too far apart");
  assert.deepStrictEqual(d.frame(["Y"], 1680), ["Y"]);
  const e = M.food._.makeAcceptor();
  e.frame(["P", "Q"], 0);
  assert.deepStrictEqual(e.frame(["Q"], 80), ["Q"], "two codes in view");
});

t("scanner camera errors: plain words, always {code:\"camera\"}", () => {
  const C = M.food._.cameraErr;
  const blocked = C({ name: "NotAllowedError", message: "Permission denied" });
  assert.strictEqual(blocked.code, "camera");
  assert.ok(/blocked/i.test(blocked.message) && /photo of the barcode/i.test(blocked.message));
  assert.ok(/No camera/.test(C({ name: "NotFoundError" }).message));
  assert.ok(/busy/.test(C({ name: "NotReadableError" }).message));
  assert.ok(/didn't start/.test(C(new Error("weird")).message));
  assert.ok(/photo of the barcode/i.test(C(null).message));
});

t("scanner engine: native BarcodeDetector when it reads all four retail formats, else not", async () => {
  global.BarcodeDetector = class { static async getSupportedFormats() { return ["qr_code", "ean_13", "ean_8", "upc_a", "upc_e"]; } constructor(o) { this.o = o; } async detect() { return [{ rawValue: "0036000291452", format: "ean_13" }]; } };
  M.food.scanner._setEngine(null);
  assert.strictEqual(await M.food.scanner.preload(), "native");
  assert.strictEqual(M.food.scanner.engine(), "native");
  global.BarcodeDetector = class { static async getSupportedFormats() { return ["qr_code", "ean_13"]; } };
  M.food.scanner._setEngine(null);
  assert.strictEqual(await M.food.scanner.preload(), null, "no Worker / no DOM here → the wasm engine can't load → null, no throw");
  delete global.BarcodeDetector;
  M.food.scanner._setEngine(null);
});

t("scanner.stop is safe with nothing running; start without a container rejects plainly; fromImage(null) → null", async () => {
  assert.strictEqual(await M.food.scanner.stop(), true);
  assert.strictEqual(await M.food.scanner.stop(), true);
  await M.food.scanner.start(null, () => {}).then(() => assert.fail(), e => assert.ok(e.code && e.message));
  assert.strictEqual(await M.food.scanner.fromImage(null), null);
  assert.strictEqual(M.food.scanner.running(), false);
});

/* ======================================================================= */
/* Scanner — camera flow in jsdom with fake media devices + a scripted engine */
function scanDom(opt) {
  opt = opt || {};
  const { JSDOM, VirtualConsole } = require("jsdom");
  const vc = new VirtualConsole();
  const dom = new JSDOM('<!doctype html><html><body><div id="m-scan" class="m-scan" style="min-height:200px"></div></body></html>', { url: "https://chalk.test/", pretendToBeVisual: true, runScripts: "outside-only", virtualConsole: vc });
  const w = dom.window;
  w.S = { profile: "nick" };
  w.PRESETS = { nick: { name: "Nick" } };
  const log = { vib: [], gum: [] };
  Object.defineProperty(w.navigator, "vibrate", { value: ms => { log.vib.push(ms); return true; }, configurable: true });
  if (opt.gum !== null) Object.defineProperty(w.navigator, "mediaDevices", { value: { getUserMedia: c => { log.gum.push(c); return opt.gum ? opt.gum(c) : Promise.resolve(fakeStream(opt.caps)); } }, configurable: true });
  if (opt.insecure) Object.defineProperty(w, "isSecureContext", { value: false, configurable: true });
  log.beeps = 0;
  const node = () => ({ connect() {}, start() {}, stop() {}, frequency: {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } });
  w.AudioContext = class { constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; } resume() { return Promise.resolve(); } createBuffer() { return {}; } createBufferSource() { return node(); } createGain() { return node(); } createOscillator() { const o = node(); o.start = () => { log.beeps++; }; return o; } };
  if (opt.soundOff) w.S = { profile: "nick", settings: { sound: false } };
  ["m-core.js", "m-data.js", "m-food.js"].forEach(f => vm.runInContext(SRC(f), dom.getInternalVMContext(), { filename: f }));
  return { dom, w, M: w.M, el: w.document.getElementById("m-scan"), log };
}
function fakeStream(caps) {
  const track = { readyState: "live", stops: 0, applied: [], stop() { this.stops++; this.readyState = "ended"; }, getCapabilities() { return caps || {}; }, applyConstraints(c) { this.applied.push(c); return Promise.resolve(); }, addEventListener() {}, removeEventListener() {} };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}
function scriptedEngine(frames) {
  let i = 0;
  return { kind: "wasm", calls: 0, detect() { this.calls++; const f = frames[Math.min(i, frames.length - 1)]; i++; return Promise.resolve(f); }, close() {} };
}

t("scanner flow: camera + engine → onCode once, after two agreeing frames, as printed digits; vibrate; torch; auto 2× zoom; clean stop", async () => {
  const caps = { torch: true, zoom: { min: 1, max: 10, step: 0.1 } };
  let stream = null;
  const env = scanDom({ caps, gum: () => { stream = fakeStream(caps); return Promise.resolve(stream); } });
  const { M: MM, el, log } = env;
  const eng = scriptedEngine([[], [{ rawValue: "0036000291453", format: "ean_13" }], [{ rawValue: "0036000291452", format: "ean_13" }], [{ rawValue: "0036000291452", format: "ean_13" }], [{ rawValue: "0036000291452", format: "ean_13" }]]);
  MM.food.scanner._setEngine(eng);
  MM.food.scanner._grab = () => ({ width: 4, height: 4, data: new Uint8ClampedArray(64) });
  const codes = [];
  el.setAttribute("style", "min-height:200px");
  const ok = await MM.food.scanner.start(el, c => codes.push(c));
  assert.strictEqual(ok, true);
  assert.strictEqual(MM.food.scanner.running(), true);
  assert.deepStrictEqual(plain(log.gum[0]), { audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  const video = el.querySelector("video");
  assert.ok(video && video.hasAttribute("playsinline") && video.hasAttribute("muted") && video.muted === true, "playsinline + muted");
  assert.strictEqual(video.srcObject, stream);
  assert.ok(/aspect-ratio/.test(el.getAttribute("style")), "camera area sized");
  assert.deepStrictEqual(plain(stream.track.applied[0]), { advanced: [{ zoom: 2 }] }, "2× zoom when supported");
  assert.strictEqual(MM.food.scanner.hasTorch(), true);
  assert.strictEqual(MM.food.scanner.hasZoom(), true);
  assert.ok(el.querySelectorAll("button").length === 2, "Light + 2× buttons");
  await sleep(450);
  assert.deepStrictEqual(codes, ["036000291452"], "bad check digit ignored; then two agreeing reads; then deduped");
  assert.deepStrictEqual(log.vib, [60]);
  assert.strictEqual(log.beeps, 1, "one short beep on a hit");
  assert.ok(eng.calls >= 4, "decoding keeps going (" + eng.calls + " frames)");
  assert.strictEqual(await MM.food.scanner.torch(true), true);
  assert.deepStrictEqual(plain(stream.track.applied.slice(-1)[0]), { advanced: [{ torch: true }] });
  assert.strictEqual(el.querySelector("button").getAttribute("aria-pressed"), "true");
  await MM.food.scanner.stop();
  assert.strictEqual(stream.track.stops, 1, "every track stopped");
  assert.strictEqual(el.innerHTML, "");
  assert.strictEqual(el.getAttribute("style"), "min-height:200px", "container style restored");
  assert.strictEqual(MM.food.scanner.running(), false);
  const calls = eng.calls; await sleep(200);
  assert.strictEqual(eng.calls, calls, "no decoding after stop");
  env.dom.window.close();
});

t("scanner flow: camera blocked / insecure page / no camera API → {code:\"camera\"}, container untouched or restored", async () => {
  const denied = scanDom({ gum: () => Promise.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" })) });
  denied.M.food.scanner._setEngine(scriptedEngine([[]]));
  await denied.M.food.scanner.start(denied.el, () => {}).then(() => assert.fail(), e => { assert.strictEqual(e.code, "camera"); assert.ok(/photo of the barcode/i.test(e.message)); });
  assert.strictEqual(denied.el.innerHTML, "");
  assert.strictEqual(denied.el.getAttribute("style"), "min-height:200px");
  const insecure = scanDom({ insecure: true });
  await insecure.M.food.scanner.start(insecure.el, () => {}).then(() => assert.fail(), e => { assert.strictEqual(e.code, "camera"); assert.ok(/secure/.test(e.message)); });
  assert.strictEqual(insecure.log.gum.length, 0, "never asks for the camera on an insecure page");
  const none = scanDom({ gum: null });
  await none.M.food.scanner.start(none.el, () => {}).then(() => assert.fail(), e => { assert.strictEqual(e.code, "camera"); assert.ok(/can't open the camera/.test(e.message)); });
  [denied, insecure, none].forEach(x => x.dom.window.close());
});

t("scanner flow: overconstrained camera retries with simpler settings; engine that can't load → scanner_load + camera released", async () => {
  let n = 0, last = null;
  const env = scanDom({ gum: () => { n++; if (n === 1) return Promise.reject(Object.assign(new Error("no 1080p"), { name: "OverconstrainedError" })); last = fakeStream({}); return Promise.resolve(last); } });
  env.M.food.scanner._setEngine(scriptedEngine([[]]));
  assert.strictEqual(await env.M.food.scanner.start(env.el, () => {}), true);
  assert.deepStrictEqual(plain(env.log.gum[1]), { audio: false, video: { facingMode: { ideal: "environment" } } });
  await env.M.food.scanner.stop();
  const fail = Promise.reject({ code: "scanner_load", message: "The scanner couldn't load. Check your connection, or type the numbers under the bars." });
  fail.catch(() => {});
  env.M.food.scanner._setEngine(fail);
  await env.M.food.scanner.start(env.el, () => {}).then(() => assert.fail(), e => { assert.strictEqual(e.code, "scanner_load"); assert.ok(/type the numbers/.test(e.message)); });
  assert.strictEqual(last.track.stops, 1, "camera released when the engine fails");
  assert.strictEqual(env.el.innerHTML, "");
  env.dom.window.close();
});

t("scanner flow: stop() while the permission prompt is up → start resolves false and the late camera is closed", async () => {
  let resolveGum = null;
  const env = scanDom({ gum: () => new Promise(r => { resolveGum = r; }) });
  env.M.food.scanner._setEngine(scriptedEngine([[]]));
  const p = env.M.food.scanner.start(env.el, () => {});
  await sleep(10);
  await env.M.food.scanner.stop();
  const late = fakeStream({});
  resolveGum(late);
  assert.strictEqual(await p, false);
  assert.strictEqual(late.track.stops, 1, "late stream stopped");
  assert.strictEqual(env.el.innerHTML, "");
  assert.strictEqual(env.M.food.scanner.running(), false);
  env.dom.window.close();
});

t("scanner flow: no beep when Chalk's Sound setting is off (vibrate still fires)", async () => {
  const env = scanDom({ soundOff: true });
  env.M.food.scanner._setEngine(scriptedEngine([[{ rawValue: "4006381333931", format: "ean_13" }]]));
  env.M.food.scanner._grab = () => ({ width: 4, height: 4, data: new Uint8ClampedArray(64) });
  const codes = [];
  await env.M.food.scanner.start(env.el, c => codes.push(c));
  await sleep(300);
  await env.M.food.scanner.stop();
  assert.deepStrictEqual(codes, ["4006381333931"]);
  assert.strictEqual(env.log.beeps, 0);
  assert.deepStrictEqual(env.log.vib, [60]);
  env.dom.window.close();
});

/* ======================================================================= */
/* Nutrition Facts parser                                                   */
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
  assert.strictEqual(r.servingsPerContainer, 8);
  ["cal", "p", "c", "f", "fiber", "sugar", "sodium", "serving"].forEach(k => assert.ok(r.fields.includes(k), "field " + k));
});

t("label.parse: noisy dairy label (O→0, l→1, 89→8g, 39→3g, Total Carb., Calories … from Fat on one line)", () => {
  const r = M.food.label.parse(OCR_2);
  assert.deepStrictEqual(r.per, { cal: 150, p: 3, c: 12, f: 8, fiber: 0, sugar: 12, sodium: 120 });
  assert.deepStrictEqual(r.serving, { qty: 1, unit: "cup", g: 240 });
});

t("label.parse: new-style bar label (serving above 'Serving size', calories on next line, added sugars ignored)", () => {
  const r = M.food.label.parse(OCR_3);
  assert.deepStrictEqual(r.per, { cal: 190, p: 21, c: 23, f: 7, fiber: 10, sugar: 2, sodium: 210 });
  assert.deepStrictEqual(r.serving, { qty: 1, unit: "bar", g: 60 });
  assert.ok(r.name && /kirkland/i.test(r.name), "name from the lines above Nutrition Facts");
});

/* 13 more realistic Tesseract outputs with the errors OCR actually makes */
const OCR_CASES = [
  { name: "protein bar — Calories 2l0, Sodium 16Omg, Protein 3O g", per: { cal: 210, p: 30, c: 22, f: 7, fiber: 14, sugar: 1, sodium: 160 }, serving: { qty: 1, unit: "bar", g: 60 }, spc: 12,
    text: "Nutrition Facts\n12 servings per container\nServing size 1 bar (60g)\nAmount per serving\nCalories 2l0\n% Daily Value*\nTotal Fat 7g 9%\nSaturated Fat 3g 15%\nTrans Fat 0g\nCholesterol 5mg 2%\nSodium 16Omg 7%\nTotal Carbohydrate 22g 8%\nDietary Fiber 14g 50%\nTotal Sugars 1g\nIncludes 0g Added Sugars 0%\nProtein 3O g 60%" },
  { name: "dual columns per serving / per container", per: { cal: 250, p: 5, c: 31, f: 12, fiber: 0, sugar: 5, sodium: 470 }, serving: { qty: 1, unit: "cup", g: 228 }, spc: 2,
    text: "Nutrition Facts\n2 servings per container\nServing size 1 cup (228g)\n                     Per serving    Per container\nCalories             250            500\n                     % DV*          % DV*\nTotal Fat            12g    15%     24g    31%\n  Saturated Fat      2g     10%     4g     20%\n  Trans Fat          0g             0g\nCholesterol          30mg   10%     60mg   20%\nSodium               470mg  20%     940mg  41%\nTotal Carb.          31g    11%     62g    23%\n  Dietary Fiber      0g     0%      0g     0%\n  Total Sugars       5g             10g\n    Incl. 0g Added Sugars 0%        0g     0%\nProtein              5g             10g" },
  { name: "bilingual Canadian (Fat / Lipides, Glucides, Fibre, Per 1 cup (55 g) / pour …)", per: { cal: 220, p: 6, c: 45, f: 2, fiber: 6, sugar: 9, sodium: 270 }, serving: { qty: 1, unit: "cup", g: 55 },
    text: "Nutrition Facts\nValeur nutritive\nPer 1 cup (55 g) / pour 1 tasse (55 g)\nAmount              % Daily Value\nTeneur          % valeur quotidienne\nCalories / Calories 220\nFat / Lipides 2 g 3 %\nSaturated / saturés 0.3 g\n+ Trans / trans 0 g 2 %\nCarbohydrate / Glucides 45 g\nFibre / Fibres 6 g 24 %\nSugars / Sucres 9 g 9 %\nProtein / Protéines 6 g\nCholesterol / Cholestérol 0 mg\nSodium 270 mg 12 %\nPotassium 250 mg 7 %" },
  { name: "meat — Serving size 4 oz (112g), about 8 servings per container", per: { cal: 120, p: 22, c: 0, f: 3, fiber: 0, sugar: 0, sodium: 55 }, serving: { qty: 4, unit: "oz", g: 112 }, spc: 8,
    text: "Nutrition Facts\nabout 8 servings per container\nServing size 4 oz (112g)\nAmount per serving\nCalories 120\n% Daily Value*\nTotal Fat 3g 4%\nSaturated Fat 1g 5%\nTrans Fat 0g\nCholesterol 65mg 22%\nSodium 55mg 2%\nTotal Carbohydrate 0g 0%\nDietary Fiber 0g 0%\nTotal Sugars 0g\nIncludes 0g Added Sugars 0%\nProtein 22g 44%" },
  { name: "OCR dropped the spaces (TotalFat8g, Sodium160mg, Serving Size2/3cup(55g))", per: { cal: 230, p: 3, c: 37, f: 8, fiber: 4, sugar: 1, sodium: 160 }, serving: { qty: 0.667, unit: "cup", g: 55 }, spc: 8,
    text: "NutritionFacts\nServing Size2/3cup(55g)\nServings Per Container About 8\nCalories230\nTotalFat8g\nSodium160mg\nTotalCarbohydrate37g\nDietaryFiber4g\nSugars1g\nProtein3g" },
  { name: "every g read as 9 (Total Fat 09, Carbohydrate 69, Sugars 49, Protein 159)", per: { cal: 90, p: 15, c: 6, f: 0, fiber: 0, sugar: 4, sodium: 60 }, serving: { qty: 1, unit: "container", g: 150 },
    text: "Nutrition Facts\nServing size 1 container (150g)\nCalories 90\nTotal Fat 09 0%\nSodium 60mg 3%\nTotal Carbohydrate 69 2%\nTotal Sugars 49\nProtein 159 30%" },
  { name: "frozen meal — Sodium 1,020mg", per: { cal: 380, p: 21, c: 42, f: 14, fiber: 5, sugar: 7, sodium: 1020 }, serving: { qty: 1, unit: "meal", g: 283 }, spc: 1,
    text: "Nutrition Facts\nServing Size 1 meal (283g)\nServings Per Container 1\nCalories 380\nTotal Fat 14g 18%\nSodium 1,020mg 44%\nTotal Carbohydrate 42g 15%\nDietary Fiber 5g 18%\nTotal Sugars 7g\nProtein 21g 42%" },
  { name: "<1g and less than 1g", per: { cal: 10, p: 1, c: 0.5, f: 0, fiber: 0, sugar: 0.5, sodium: 290 }, serving: { qty: 1, unit: "tbsp", g: 15 },
    text: "Nutrition Facts\nServing size 1 tbsp (15mL)\nCalories 10\nTotal Fat 0g 0%\nSodium 290mg 13%\nTotal Carbohydrate <1g 0%\nTotal Sugars less than 1g\nProtein 1g" },
  { name: "name above; Calories / 190 on two lines; 1/2 cup (53g)", per: { cal: 190, p: 14, c: 30, f: 2.5, fiber: 5, sugar: 3, sodium: 350 }, serving: { qty: 0.5, unit: "cup", g: 53 }, spc: 10, labelName: "Kodiak Cakes",
    text: "Kodiak Cakes\nNutrition Facts\n10 servings per container\nServing size          1/2 cup (53g)\nAmount per serving\nCalories\n190\n% Daily Value*\nTotal Fat 2.5g 3%\nSaturated Fat 0.5g 3%\nSodium 350mg 15%\nTotal Carbohydrate 30g 11%\nDietary Fiber 5g 18%\nTotal Sugars 3g\nProtein 14g 28%" },
  { name: "letter-for-digit misreads (11O, lg, 4Omg, Og, 2Sg)", per: { cal: 110, p: 25, c: 0, f: 1, fiber: 0, sugar: 0, sodium: 40 }, serving: { qty: 3, unit: "oz", g: 85 },
    text: "Nutrition Facts\nServing Size 3 oz (85g)\nCalories 11O\nTotal Fat lg 2%\nCholesterol 55mg 18%\nSodium 4Omg 2%\nTotal Carbohydrate Og 0%\nProtein 2Sg" },
  { name: "misspelled labels (Calorles, TotaI Fat, Sodlum, Proteln); footnote numbers ignored", per: { cal: 130, p: 16, c: 12, f: 2.5, fiber: 0, sugar: 12, sodium: 125 }, serving: { qty: 1, unit: "cup", g: 240 },
    text: "Nutrition Facts\nServing Size 1 cup (240mL)\nCalorles 130\nTotaI Fat 2.5g 3%\nSodlum 125mg 5%\nTotaI Carbohydrate 12g 4%\nTotal Sugars 12g\nProteln 16g 32%\n* The % Daily Value (DV) tells you how much a nutrient in a serving of food contributes to a daily diet. 2,000 calories a day is used for general nutrition advice.\nCalories per gram: Fat 9 • Carbohydrate 4 • Protein 4" },
  { name: "Sugars + Added Sugars (no Total), value on the next line, (55g/1.9 oz), Calories … from Fat", per: { cal: 200, p: 4, c: 35, f: 5, fiber: 0, sugar: 12, sodium: 140 }, serving: { qty: 0.667, unit: "cup", g: 55 },
    text: "Nutrition Facts\nServing Size 2/3 cup (55g/1.9 oz)\nCalories 200 Calories from Fat 45\nTotal Fat 5g 8%\nSodium 140mg 6%\nTotal Carbohydrate 35g 12%\nSugars 12g\nAdded Sugars 10g\nProtein\n4g" },
  { name: "Serving size on the line below, 1 bottle (414mL), Sodium 0.2g", per: { cal: 230, p: 42, c: 8, f: 4.5, fiber: 0, sugar: 6, sodium: 200 }, serving: { qty: 1, unit: "bottle", g: 414 }, spc: 1,
    text: "Nutrition Facts\n1 servings per container\nServing size\n1 bottle (414mL)\nCalories 230\nTotal Fat 4.5g 6%\nSodium 0.2g 9%\nTotal Carbohydrate 8g 3%\nTotal Sugars 6g\nProtein 42g 84%" }
];
OCR_CASES.forEach(c => t("label.parse OCR: " + c.name, () => {
  const r = M.food.label.parse(c.text);
  assert.deepStrictEqual(r.per, c.per);
  assert.strictEqual(r.serving.unit, c.serving.unit);
  assert.strictEqual(r.serving.g, c.serving.g);
  near(r.serving.qty, c.serving.qty, 0.01, "qty");
  if (c.spc) assert.strictEqual(r.servingsPerContainer, c.spc);
  if (c.labelName) assert.strictEqual(r.name, c.labelName);
}));

t("label.parse: empty / junk text returns zeros and no fields, never throws", () => {
  const r = M.food.label.parse("");
  assert.deepStrictEqual(r.fields, []);
  assert.deepStrictEqual(r.per, { cal: 0, p: 0, c: 0, f: 0, fiber: 0, sugar: 0, sodium: 0 });
  assert.doesNotThrow(() => M.food.label.parse(null));
  assert.doesNotThrow(() => M.food.label.parse("asdf qwer 12 34 %"));
  assert.doesNotThrow(() => M.food.label.parse("Calories\nTotal Fat\nProtein"));
});

t("label with Claude: exact numbers + serving text; per-100 g labels converted; no label → plain error; mismatch warning", async () => {
  M.ai.setKey("sk-ant-test");
  let answer = null, sent = null;
  global.fetch = async (u, o) => { sent = JSON.parse(o.body); return claudeReply(answer); };
  const photo = { type: "image/jpeg", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  answer = { found: true, name: "Honey Nut Cheerios", brand: "General Mills", servingSize: "2/3 cup (55g)", serving: { qty: 1, unit: "serving", g: null }, servingsPerContainer: 8, per: { cal: 230, p: 3, c: 37, f: 8, fiber: 4, sugar: 12, sodium_mg: 160 }, basis: "serving" };
  const r = await M.food.label.fromImage(photo);
  assert.strictEqual(r.method, "ai");
  assert.strictEqual(sent.messages[0].content[0].type, "image");
  assert.ok(/exactly as printed/i.test(sent.messages[0].content[1].text) && /per-serving column/i.test(sent.messages[0].content[1].text));
  assert.deepStrictEqual(r.food.per, { cal: 230, p: 3, c: 37, f: 8, fiber: 4, sugar: 12, sodium: 160 });
  assert.strictEqual(r.food.serving.unit, "cup");
  near(r.food.serving.qty, 0.667, 0.01);
  assert.strictEqual(r.food.serving.g, 55);
  assert.strictEqual(r.food.servingsPerContainer, 8);
  assert.strictEqual(r.food.per100g.cal, 418);
  assert.ok(!r.warning);
  answer = { found: true, name: "", brand: "", servingSize: "30 g", serving: { qty: 30, unit: "g", g: 30 }, per: { cal: 400, p: 10, c: 60, f: 12, fiber: 5, sugar: 20, sodium_mg: 300 }, basis: "100g" };
  const eu = await M.food.label.fromImage(photo);
  assert.deepStrictEqual(eu.food.per, { cal: 120, p: 3, c: 18, f: 3.6, fiber: 1.5, sugar: 6, sodium: 90 }, "per 100 g → per 30 g serving");
  assert.strictEqual(eu.food.per100g.cal, 400);
  answer = { found: true, servingSize: "1 bar (60g)", per: { cal: 90, p: 21, c: 23, f: 7, fiber: 10, sugar: 2, sodium_mg: 210 } };
  assert.ok(/don't match/.test((await M.food.label.fromImage(photo)).warning), "calories vs macros check");
  answer = { found: false };
  await M.food.label.fromImage(photo).then(() => assert.fail(), e => { assert.strictEqual(e.code, "no_label"); assert.ok(/Nutrition Facts/.test(e.message)); });
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { type: "authentication_error" } }) });
  await M.food.label.fromImage(photo).then(() => assert.fail(), e => assert.strictEqual(e.code, "auth", "a wrong key is shown, not hidden behind OCR"));
  M.ai.setKey(""); delete global.fetch;
});

/* ======================================================================= */
/* describe without Claude                                                  */
const cookOf = id => (M.cook && typeof M.cook.of === "function" ? M.cook.of(M.foods.get(id)) : null);
t("describe (no Claude): the six everyday phrases", async () => {
  M.reset(); M.ai.setKey("");
  const d = async s => { const r = await M.food.describe(s, { slot: "Lunch" }); assert.strictEqual(r.method, "local"); assert.deepStrictEqual(r.unmatched, [], s + " unmatched " + JSON.stringify(r.unmatched)); return r.items; };
  let it = await d("2 eggs, 2 slices dave's bread, 1 tbsp butter");
  assert.strictEqual(it.length, 3);
  assert.ok(/^egg/i.test(it[0].name) && it[0].servings === 2, JSON.stringify(it[0]));
  near(kcalOf(it[0]), 144, 12, "2 eggs");
  assert.ok(/dave/i.test(it[1].name + it[1].brand) && /21 whole grains/i.test(it[1].name), "Dave's Killer Bread, the 21 grain loaf: " + it[1].name);
  assert.strictEqual(it[1].servings, 2);
  assert.ok(/slice/.test(it[1].servingLabel));
  assert.ok(/^butter/i.test(it[2].name) && it[2].servings === 1 && /tbsp/.test(it[2].servingLabel));
  near(kcalOf(it[2]), 100, 5, "1 tbsp butter");
  it = await d("6 oz chicken breast");
  assert.strictEqual(it.length, 1);
  assert.ok(/chicken breast/i.test(it[0].name));
  near(it[0].g * it[0].servings, 170, 1.5, "6 oz grams");
  assert.ok(/^6 oz/.test(it[0].servingLabel), it[0].servingLabel);
  near(kcalOf(it[0]), 281, 30, "6 oz cooked chicken breast");
  if (cookOf(it[0].foodId)) { assert.strictEqual(it[0].state, "cooked"); assert.ok(it[0].cook && it[0].cook.y > 0); }
  it = await d("1.5 cups rice");
  assert.ok(/white rice/i.test(it[0].name), it[0].name);
  assert.strictEqual(it[0].servings, 1.5);
  assert.ok(/^1 cup/.test(it[0].servingLabel), it[0].servingLabel);
  near(kcalOf(it[0]), 308, 30, "1.5 cups cooked rice");
  if (cookOf(it[0].foodId)) assert.strictEqual(it[0].state, "cooked");
  it = await d("a banana");
  assert.ok(/^banana/i.test(it[0].name) && it[0].servings === 1);
  near(kcalOf(it[0]), 105, 10, "a banana");
  it = await d("pork tenderloin 5 oz with broccoli");
  assert.strictEqual(it.length, 2);
  assert.ok(/pork tenderloin/i.test(it[0].name) && /^5 oz \(142 g\)/.test(it[0].servingLabel) && it[0].servings === 1, JSON.stringify(it[0]));
  near(kcalOf(it[0]), 203, 25, "5 oz pork tenderloin");
  assert.ok(/broccoli/i.test(it[1].name) && it[1].servings === 1);
  it = await d("zucchini and onions");
  assert.strictEqual(it.length, 2);
  assert.ok(/zucchini/i.test(it[0].name) && it[0].servings === 1);
  assert.ok(/onion/i.test(it[1].name) && !/sweet/i.test(it[1].name) && it[1].servings === 1, "plain onion, one serving: " + it[1].name + " × " + it[1].servings);
  it.concat().forEach(x => { assert.ok(x.foodId && x.servingLabel); M.NUT.forEach(k => assert.strictEqual(typeof x.per[k], "number")); });
});

t("describe (no Claude): the person's own saved foods win by name; raw when they say raw; unmatched listed", async () => {
  M.reset(); M.ai.setKey("");
  const mine = M.foods.add({ name: "Organic Chicken Breast", brand: "Kirkland Signature", source: "off", barcode: "0096619000001", serving: { qty: 4, unit: "oz", g: 112 }, per: { cal: 130, p: 25, c: 0, f: 3, fiber: 0, sugar: 0, sodium: 60 }, per100g: { cal: 116, p: 22.3, c: 0, f: 2.7, fiber: 0, sugar: 0, sodium: 54 }, alts: [{ label: "1 oz", g: 28.35 }] });
  const r = await M.food.describe("6 oz chicken breast", {});
  assert.strictEqual(r.items[0].foodId, mine.id, "saved food first: " + r.items[0].name);
  near(r.items[0].g, 170.1, 1);
  near(kcalOf(r.items[0]), 197, 3, "from the saved food's per 100 g");
  const bread = M.foods.add({ name: "Good Seed Thin-Sliced", brand: "Dave's Killer Bread", source: "off", serving: { qty: 1, unit: "slice", g: 28 }, per: { cal: 70, p: 3, c: 13, f: 1.5, fiber: 2, sugar: 2, sodium: 105 } });
  const b = await M.food.describe("2 slices dave's bread", {});
  assert.strictEqual(b.items[0].foodId, bread.id, "their own Dave's loaf beats the built-in one");
  M.foods.remove(mine.id);
  const raw = await M.food.describe("8 oz raw chicken breast", {});
  assert.ok(/chicken breast/i.test(raw.items[0].name));
  if (cookOf(raw.items[0].foodId)) { assert.strictEqual(raw.items[0].state, "raw"); near(kcalOf(raw.items[0]), 272, 30, "8 oz raw"); }
  const un = await M.food.describe("1 cup rice\nxyzzy plumbus", {});
  assert.deepStrictEqual(un.unmatched, ["xyzzy plumbus"]);
  assert.deepStrictEqual((await M.food.describe("", {})).items, []);
});

t("describe quantity parsing (fractions, words, glued and trailing amounts, hyphens)", () => {
  const q = M.food.parseQuantity;
  const pick = s => { const r = q(s); return [r.qty, r.unit, r.words]; };
  assert.deepStrictEqual(pick("1.5 cups rice"), [1.5, "cup", "rice"]);
  assert.deepStrictEqual(pick("half an avocado"), [0.5, null, "avocado"]);
  assert.deepStrictEqual(pick("3 oz chicken"), [3, "oz", "chicken"]);
  assert.deepStrictEqual(pick("100g greek yogurt"), [100, "g", "greek yogurt"]);
  assert.deepStrictEqual(pick("chicken thigh 8 oz"), [8, "oz", "chicken thigh"]);
  assert.deepStrictEqual(pick("a banana"), [1, null, "banana"]);
  assert.deepStrictEqual(pick("1 1/2 cups brown rice"), [1.5, "cup", "brown rice"]);
  assert.deepStrictEqual(pick("1½ cups rice"), [1.5, "cup", "rice"]);
  assert.deepStrictEqual(pick("two eggs"), [2, null, "eggs"]);
  assert.deepStrictEqual(pick("5-oz pork tenderloin"), [5, "oz", "pork tenderloin"]);
  assert.deepStrictEqual(pick("2 slices dave's bread"), [2, "slice", "dave's bread"]);
  assert.deepStrictEqual(pick("rice (1 cup)"), [1, "cup", "rice"]);
  assert.strictEqual(q("broccoli").explicitQty, false);
});

t("describe with Claude: items from the reply; Claude failing falls back to local with a note", async () => {
  M.ai.setKey("sk-ant-test");
  global.fetch = async () => claudeReply({ items: [{ name: "Egg, scrambled", servingLabel: "2 large (100 g)", g: 100, per: { cal: 180, p: 12, c: 2, f: 13, fiber: 0, sugar: 1, sodium_mg: 340 } }], note: "" });
  const d = await M.food.describe("2 scrambled eggs", { slot: "Breakfast" });
  assert.strictEqual(d.method, "ai");
  assert.strictEqual(d.items[0].source, "ai");
  assert.strictEqual(d.items[0].per.sodium, 340);
  global.fetch = async () => ({ ok: false, status: 529, json: async () => ({ error: { type: "overloaded_error" } }) });
  const f = await M.food.describe("2 eggs", {});
  assert.strictEqual(f.method, "local");
  assert.ok(f.items.length === 1 && /overloaded/i.test(f.note), f.note);
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { type: "authentication_error" } }) });
  await M.food.describe("2 eggs", {}).then(() => assert.fail(), e => assert.strictEqual(e.code, "auth", "a wrong key is surfaced"));
  M.ai.setKey(""); delete global.fetch;
});

/* ======================================================================= */
/* photo + estimateByName                                                   */
t("photo.estimate / estimateByName (Claude): item shapes, base64 image block, sodium mapping, sources", async () => {
  M.ai.setKey("sk-ant-test");
  let last = null;
  global.fetch = async (url, o) => {
    last = JSON.parse(o.body);
    const txt = last.messages[0].content.map(b => b.text || "").join(" ");
    if (/photo of food/i.test(txt)) return claudeReply({ items: [{ name: "Grilled chicken breast", servingLabel: "6 oz (170 g)", g: 170, per: { cal: 280, p: 52, c: 0, f: 6, fiber: 0, sugar: 0, sodium_mg: 125 } }, { name: "Steamed broccoli", servingLabel: "1 cup (156 g)", g: 156, per: { cal: 55, p: 4, c: 11, f: 0.5, fiber: 5, sugar: 2, sodium_mg: 64 } }], note: "Portions look like a standard dinner plate." });
    return claudeReply({ name: "Costco chicken bake", brand: "Kirkland", serving: { qty: 1, unit: "bake", g: 300 }, per: { cal: 770, p: 46, c: 70, f: 30, fiber: 3, sugar: 4, sodium_mg: 1790 }, alts: [{ label: "1/2 bake", g: 150 }] });
  };
  const fakeFile = { type: "image/jpeg", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  const ph = await M.food.photo.estimate(fakeFile, { slot: "Dinner" });
  assert.strictEqual(ph.items.length, 2);
  assert.strictEqual(ph.items[0].source, "photo");
  assert.strictEqual(ph.items[0].servings, 1);
  assert.strictEqual(ph.items[0].per.sodium, 125);
  assert.strictEqual(ph.items[0].per.sodium_mg, undefined);
  assert.strictEqual(ph.items[0].g, 170);
  assert.ok(/plate/.test(ph.note));
  assert.deepStrictEqual(last.messages[0].content[0], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AQID" } });
  assert.strictEqual(last.messages[0].content[1].type, "text");
  const f = await M.food.estimateByName("costco chicken bake");
  assert.strictEqual(f.source, "ai");
  assert.deepStrictEqual(f.serving, { qty: 1, unit: "bake", g: 300 });
  assert.strictEqual(f.per.sodium, 1790);
  assert.strictEqual(f.per100g.cal, 257);
  assert.ok(f.alts.some(a => a.label === "1/2 bake" && a.g === 150) && f.alts.some(a => a.g === 100));
  M.ai.setKey(""); delete global.fetch;
});

/* ======================================================================= */
/* suggest: mine → often → idea → claude                                   */
function logDay(daysAgo, slot, entries) {
  const key = M.addDays(M.today(), -daysAgo);
  entries.forEach((e, i) => M.log.add(key, Object.assign({ slot, servings: 1, at: Date.now() - daysAgo * 864e5 + i }, e)));
}
const EGG = { name: "Egg, whole, large", servingLabel: "1 large egg (50 g)", servings: 2, per: { cal: 72, p: 6.3, c: 0.4, f: 4.8, fiber: 0, sugar: 0.2, sodium: 71 } };
const TOAST = { name: "Bread, 21 Whole Grains & Seeds (Dave's Killer Bread)", servingLabel: "1 slice (45 g)", servings: 2, per: { cal: 110, p: 5, c: 22, f: 1.5, fiber: 5, sugar: 5, sodium: 170 } };
const BUTTER = { name: "Butter, salted", servingLabel: "1 tbsp (14 g)", per: { cal: 100, p: 0.1, c: 0, f: 11.4, fiber: 0, sugar: 0, sodium: 90 } };

t("combos: foods logged together in a slot over 60 days; a saved meal counts as one; stale days and other slots ignored", () => {
  M.reset();
  const oats = M.meals.add({ name: "Protein oats", desc: "", slot: "Breakfast", items: [{ name: "Oats", servingLabel: "1/2 cup", per: { cal: 150, p: 5, c: 27, f: 3 } }] });
  [1, 2, 3].forEach(d => logDay(d, "Breakfast", [EGG, TOAST, BUTTER]));
  [4, 5].forEach(d => logDay(d, "Breakfast", [EGG, TOAST]));
  [6, 7].forEach(d => { logDay(d, "Breakfast", [{ name: "Banana", servingLabel: "1 medium (118 g)", per: { cal: 105, p: 1.3, c: 27, f: 0.4 } }]); M.log.addMeal(M.addDays(M.today(), -d), oats.id, 1, "Breakfast"); });
  logDay(8, "Lunch", [EGG, TOAST]);
  logDay(70, "Breakfast", [EGG, TOAST]);
  const c = M.food.combos("nick", "Breakfast");
  const names = c.map(x => x.items.map(i => i.name.split(",")[0]).sort().join(" + ") + " ×" + x.count);
  assert.deepStrictEqual(names, ["Bread + Egg ×5", "Bread + Butter + Egg ×3", "Banana + Protein oats ×2"]);
  const oatsCombo = c[2].items.find(i => i.mealId === oats.id);
  assert.ok(oatsCombo && oatsCombo.servingLabel === "1 serving", "the saved meal is one item");
  assert.ok(c[0].items.every(i => !i.id && !i.slot && !i.at), "entry ids/slots/times not copied");
  assert.deepStrictEqual(M.food.combos("nick", "Dinner"), []);
});

t("suggest: order is mine → often → idea → claude, each tagged; mine and often fit what's left", async () => {
  M.reset(); M.ai.setKey("");
  const fits = M.meals.add({ name: "Eggs and toast", desc: "The usual.", slot: "Breakfast", items: [EGG, TOAST] });
  M.meals.add({ name: "Huge brunch", desc: "", slot: "Breakfast", items: [{ name: "Pancakes", servings: 1, servingLabel: "stack", per: { cal: 1600, p: 20, c: 250, f: 50 } }] });
  const any = M.meals.add({ name: "Tuna plate", desc: "", slot: "Any", items: [{ name: "Tuna", servingLabel: "1 can", per: { cal: 120, p: 26, c: 0, f: 1 } }] });
  M.meals.add({ name: "Dinner plate", desc: "", slot: "Dinner", items: [{ name: "Steak", servingLabel: "6 oz", per: { cal: 400, p: 45, c: 0, f: 24 } }] });
  const batch = M.meals.add({ name: "Chili batch", desc: "", slot: "Breakfast", batch: { cookedG: 2000 }, items: [{ name: "Beans", servingLabel: "1 cup", per: { cal: 200, p: 12, c: 36, f: 1 } }] });
  [1, 2].forEach(d => logDay(d, "Breakfast", [EGG, TOAST, BUTTER]));
  const list = await M.food.suggest({ pid: "nick", slot: "Breakfast", remaining: { cal: 700, p: 50, c: 70, f: 25 } });
  const src = list.map(s => s.source);
  assert.deepStrictEqual(src.slice(0, 3), ["mine", "mine", "often"], JSON.stringify(list.map(s => [s.source, s.name])));
  assert.ok(src.slice(3).every(s => s === "idea") && src.length >= 6, "built-in ideas fill the rest");
  assert.deepStrictEqual(list.filter(s => s.source === "mine").map(s => s.id).sort(), [fits.id, any.id].sort(), "slot + Any, fits, no batch, no dinner, not the 1600 kcal brunch");
  assert.ok(!list.some(s => s.id === batch.id));
  const mine = list.find(s => s.id === fits.id);
  assert.strictEqual(mine.mealId, fits.id);
  assert.deepStrictEqual(mine.per, fits.per);
  const often = list.find(s => s.source === "often");
  assert.ok(/Egg \+ Bread \+ Butter|Bread \+ Egg|Egg \+ Bread/.test(often.name), often.name);
  assert.ok(/2 times/.test(often.desc));
  near(often.per.cal, 2 * 72 + 2 * 110 + 100, 1);
  list.forEach(s => { assert.ok(s.per && typeof s.per.cal === "number"); assert.ok(Array.isArray(s.items) && s.items.length); });
  const more = await M.food.suggest({ pid: "nick", slot: "Breakfast", remaining: { cal: 700, p: 50, c: 70, f: 25 }, exclude: list.map(s => s.id) });
  assert.ok(!more.some(s => list.some(x => x.id === s.id)), "More ideas: nothing repeats");
  const tight = await M.food.suggest({ pid: "nick", slot: "Breakfast", remaining: { cal: 100, p: 10, c: 10, f: 5 } });
  assert.ok(!tight.some(s => s.source === "mine" && s.per.cal > 250), "mine must fit what's left");
});

t("suggest with Claude: 3 ideas last (source claude, ids ai_…), prompt uses their foods as the pantry; failures never throw", async () => {
  M.reset();
  M.foods.add({ name: "Pork tenderloin 2-pack", brand: "King Soopers", source: "off", serving: { qty: 4, unit: "oz", g: 112 }, per: { cal: 120, p: 22, c: 0, f: 3 } });
  M.ai.setKey("sk-ant-test");
  let prompt = "";
  global.fetch = async (u, o) => {
    prompt = JSON.parse(o.body).messages[0].content[0].text;
    return claudeReply({ suggestions: [
      { name: "Cottage cheese and pineapple", desc: "Easy.", store: "Costco", prepMin: 2, items: [{ name: "Cottage cheese 2%", servingLabel: "1 cup (226 g)", g: 226, per: { cal: 180, p: 24, c: 8, f: 5, fiber: 0, sugar: 8, sodium_mg: 700 } }, { name: "Pineapple", servingLabel: "1/2 cup (80 g)", g: 80, per: { cal: 40, p: 0, c: 10, f: 0, fiber: 1, sugar: 8, sodium_mg: 1 } }] },
      { name: "Two", desc: "d", store: "King Soopers", prepMin: 5, items: [{ name: "A", servingLabel: "1 serving", g: null, per: { cal: 300, p: 30, c: 20, f: 10, fiber: 2, sugar: 3, sodium_mg: 400 } }] },
      { name: "Three", desc: "d", store: "wherever", prepMin: 5, items: [{ name: "B", servingLabel: "1 serving", g: null, per: { cal: 250, p: 25, c: 20, f: 8, fiber: 2, sugar: 3, sodium_mg: 300 } }] },
      { name: "Four (dropped)", desc: "d", store: "Costco", prepMin: 5, items: [{ name: "C", servingLabel: "1 serving", g: null, per: { cal: 250, p: 25, c: 20, f: 8, fiber: 2, sugar: 3, sodium_mg: 300 } }] }
    ] });
  };
  const list = await M.food.suggest({ slot: "Breakfast", remaining: { cal: 600, p: 40, c: 60, f: 20 } });
  const claude = list.filter(s => s.source === "claude");
  assert.strictEqual(claude.length, 3);
  assert.deepStrictEqual(list.slice(-3).map(s => s.source), ["claude", "claude", "claude"], "Claude ideas come last");
  assert.ok(claude.every(s => /^ai_/.test(s.id)));
  assert.deepStrictEqual(claude[0].per, { cal: 220, p: 24, c: 18, f: 5, fiber: 1, sugar: 16, sodium: 701 });
  assert.strictEqual(claude[0].items[0].per.sodium, 700, "sodium_mg mapped to sodium");
  assert.deepStrictEqual(claude.map(s => s.store), ["Costco", "King Soopers", "Either"]);
  assert.ok(/King Soopers and Costco/.test(prompt) && /Denver/.test(prompt) && /high in protein/i.test(prompt) && /600 kcal, 40 g protein/.test(prompt));
  assert.ok(/Pork tenderloin 2-pack \(King Soopers\)/.test(prompt), "saved foods are the pantry");
  global.fetch = async () => { throw new TypeError("Failed to fetch"); };
  const off = await M.food.suggest({ slot: "Breakfast", remaining: { cal: 600, p: 40, c: 60, f: 20 } });
  assert.ok(off.length >= 6 && off.every(s => s.source === "idea"));
  assert.ok(/connection/i.test(off.aiError), "why Claude is missing, in plain words");
  const realList = M.meals.list; M.meals.list = () => { throw new Error("boom"); };
  const safe = await M.food.suggest({ slot: "Lunch", remaining: { cal: 600, p: 40, c: 60, f: 20 }, ai: false });
  assert.ok(Array.isArray(safe) && safe.length >= 3, "never throws");
  M.meals.list = realList;
  M.ai.setKey(""); delete global.fetch;
});

t("suggest built-ins: tight budget prefers small meals; protein weighted; jitter varies order; over-budget penalty", async () => {
  const snack = M.food.suggestBuiltin({ slot: "Snacks", remaining: { cal: 250, p: 30, c: 15, f: 8 }, jitter: 0 });
  assert.ok(snack.length >= 3);
  snack.forEach(s => { assert.strictEqual(s.source, "idea"); assert.ok(s.per.cal <= 400, s.name + " too big for a 250 kcal budget: " + s.per.cal); });
  const a = M.food.suggestBuiltin({ slot: "Dinner", remaining: { cal: 800, p: 60, c: 80, f: 30 }, jitter: 0 }).map(s => s.id);
  const b = M.food.suggestBuiltin({ slot: "Dinner", remaining: { cal: 800, p: 60, c: 80, f: 30 }, jitter: 0 }).map(s => s.id);
  assert.deepStrictEqual(a, b);
  const orders = new Set();
  for (let i = 0; i < 12; i++) orders.add(M.food.suggestBuiltin({ slot: "Dinner", remaining: { cal: 800, p: 60, c: 80, f: 30 } }).map(s => s.id).join(","));
  assert.ok(orders.size > 1, "More ideas should vary");
  const big = { id: "x", slot: "Dinner", per: { cal: 900, p: 60, c: 80, f: 40 }, items: [] };
  const small = { id: "y", slot: "Dinner", per: { cal: 400, p: 35, c: 30, f: 12 }, items: [] };
  assert.ok(M.food.scoreSuggestion(small, "Dinner", { cal: 300, p: 40, c: 30, f: 10 }, null, 0) > M.food.scoreSuggestion(big, "Dinner", { cal: 300, p: 40, c: 30, f: 10 }, null, 0) + 40);
});

/* ---- run ---- */
(async () => {
  let pass = 0, fail = 0;
  for (const { name, fn } of tests) {
    try { await fn(); pass++; console.log("  ok   " + name); }
    catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n       ") : JSON.stringify(e))); }
  }
  console.log("\n" + pass + " passed, " + fail + " failed");
  if (fail) process.exit(1);
})();
