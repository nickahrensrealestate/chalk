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
/* like the browser's: abort() sets .aborted and calls "abort" listeners once */
global.AbortController = class {
  constructor() {
    const fns = new Set();
    this.signal = { aborted: false, addEventListener(type, fn) { if (type === "abort") fns.add(fn); }, removeEventListener(type, fn) { fns.delete(fn); }, _fns: fns };
  }
  abort() { if (this.signal.aborted) return; this.signal.aborted = true; Array.from(this.signal._fns).forEach(fn => { try { fn(); } catch (e) {} }); }
};

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
const isObjT = v => !!v && typeof v === "object" && !Array.isArray(v);
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
    [529, { type: "overloaded_error", message: "Overloaded" }, "overloaded", /busy.*minute/i],
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
  await M.ai.json("x").then(() => assert.fail(), e => { assert.strictEqual(e.code, "network"); assert.ok(/isn't answering/i.test(e.message) && !/connection/i.test(e.message), "online: never blame their connection: " + e.message); });
  global.fetch = async () => ({ ok: false, status: 418, json: async () => ({ type: "error", error: { type: "weird_error", message: "raw API words" } }) });
  await M.ai.json("x").then(() => assert.fail(), e => { assert.ok(!/418|raw API/.test(e.message), "no raw codes or API text: " + e.message); });
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ type: "error", error: { type: "invalid_request_error", message: "messages.0.content: raw API words" } }) });
  await M.ai.json("x").then(() => assert.fail(), e => { assert.strictEqual(e.code, "bad_request"); assert.ok(!/raw API|messages\.0/.test(e.message), e.message); });
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
  let tries = 0;
  global.fetch = async () => { tries++; throw new TypeError("Failed to fetch"); };
  await M.food.lookup("4006381333931").then(() => assert.fail(), e => { assert.strictEqual(e.code, "off_down"); assert.ok(/isn't answering right now.*minute.*scan the label/i.test(e.message) && !/connection/i.test(e.message), e.message); });
  assert.strictEqual(tries, 2, "a CORS-blocked 503 (network error while online) is tried once more");
  NAV.onLine = false;
  await M.food.lookup("4006381333931").then(() => assert.fail(), e => assert.strictEqual(e.code, "offline"));
  delete NAV.onLine;
  let n = 0;
  global.fetch = () => { n++; return new Promise(() => {}); };
  const t0 = Date.now();
  await M.food.lookup("4006381333931", { timeout: 50 }).then(() => assert.fail(), e => { assert.strictEqual(e.code, "timeout"); assert.ok(/slow right now/.test(e.message) && !/connection/i.test(e.message), e.message); });
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
  /* IO-02: how to turn the camera back on, in plain words */
  assert.strictEqual(blocked.message, "Chalk can't use the camera. Swipe Chalk closed, open it again, and tap Allow. Or turn on Camera in Settings → Apps → Safari → Camera.");
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
  await denied.M.food.scanner.start(denied.el, () => {}).then(() => assert.fail(), e => { assert.strictEqual(e.code, "camera"); assert.ok(/can't use the camera/i.test(e.message)); });
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
/* kcal per gram of a built-in food, raw or cooked, from its own numbers (m-data owns them) */
const kcalPerG = (id, state) => {
  const f = M.foods.get(id), c = cookOf(id) || (f && f.cook);
  if (state === "cooked" && c) return (c.per100gCooked ? c.per100gCooked.cal : f.per100g.cal / c.y) / 100;
  return f.per100g.cal / 100;
};
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
  /* Nick's rule: chicken breast grams are RAW grams unless they say "cooked" */
  it = await d("6 oz chicken breast");
  assert.strictEqual(it.length, 1);
  assert.ok(/chicken breast/i.test(it[0].name));
  near(it[0].g * it[0].servings, 170, 1.5, "6 oz grams");
  assert.ok(/^6 oz/.test(it[0].servingLabel), it[0].servingLabel);
  near(kcalOf(it[0]), 170.1 * kcalPerG(it[0].foodId, "raw"), 3, "6 oz raw chicken breast");
  near(kcalOf(it[0]), 190, 45, "6 oz raw chicken breast (USDA 204, the Kirkland label a bit lower)");
  if (cookOf(it[0].foodId)) { assert.strictEqual(it[0].state, "raw"); assert.ok(it[0].cook && it[0].cook.y > 0 && it[0].cook.word === "raw"); }
  it = await d("6 oz cooked chicken breast");
  near(it[0].g * it[0].servings, 170, 1.5, "6 oz cooked grams");
  if (cookOf(it[0].foodId)) { assert.strictEqual(it[0].state, "cooked"); near(kcalOf(it[0]), 170.1 * kcalPerG(it[0].foodId, "cooked"), 4, "6 oz cooked chicken breast"); }
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
  /* decision 1: typed meat is a raw weight unless they say cooked (5 oz raw ≈ 155 kcal) */
  near(kcalOf(it[0]), 155, 20, "5 oz raw pork tenderloin");
  if (cookOf(it[0].foodId)) assert.strictEqual(it[0].state, "raw");
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
  /* a scanned raw chicken saved before cook info existed borrows the built-in chicken's y.
     Nick's rule: chicken breast grams are RAW unless they say cooked → 170 g × 1.16 */
  assert.strictEqual(r.items[0].state, "raw");
  assert.ok(r.items[0].cook && Math.abs(r.items[0].cook.y - 0.7258) < 0.001, JSON.stringify(r.items[0].cook));
  near(kcalOf(r.items[0]), 197, 4, "from the saved food's per 100 g, raw");
  const rc = await M.food.describe("6 oz cooked chicken breast", {});
  assert.strictEqual(rc.items[0].foodId, mine.id);
  assert.strictEqual(rc.items[0].state, "cooked");
  near(kcalOf(rc.items[0]), 272, 4, "6 oz COOKED: 170 g ÷ 0.7258 raw × 1.16");
  const bread = M.foods.add({ name: "Good Seed Thin-Sliced", brand: "Dave's Killer Bread", source: "off", serving: { qty: 1, unit: "slice", g: 28 }, per: { cal: 70, p: 3, c: 13, f: 1.5, fiber: 2, sugar: 2, sodium: 105 } });
  const b = await M.food.describe("2 slices dave's bread", {});
  assert.strictEqual(b.items[0].foodId, bread.id, "their own Dave's loaf beats the built-in one");
  M.foods.remove(mine.id);
  const raw = await M.food.describe("8 oz raw chicken breast", {});
  assert.ok(/chicken breast/i.test(raw.items[0].name));
  if (cookOf(raw.items[0].foodId)) { assert.strictEqual(raw.items[0].state, "raw"); near(kcalOf(raw.items[0]), 226.8 * kcalPerG(raw.items[0].foodId, "raw"), 4, "8 oz raw"); }
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
  assert.ok(f.items.length === 1 && f.note === "Claude is busy right now, so this matched your words to your foods.", f.note);
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
    if (/photo of food/i.test(txt)) return claudeReply({ items: [{ name: "Grilled salmon", servingLabel: "6 oz (170 g)", g: 170, per: { cal: 280, p: 52, c: 0, f: 6, fiber: 0, sugar: 0, sodium_mg: 125 } }, { name: "Steamed broccoli", servingLabel: "1 cup (156 g)", g: 156, per: { cal: 55, p: 4, c: 11, f: 0.5, fiber: 5, sugar: 2, sodium_mg: 64 } }], note: "Portions look like a standard dinner plate." });
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
  [6, 7].forEach(d => {
    const key = M.addDays(M.today(), -d);
    logDay(d, "Breakfast", [{ name: "Banana", servingLabel: "1 medium (118 g)", per: { cal: 105, p: 1.3, c: 27, f: 0.4 } }]);
    const e = M.log.addMeal(key, oats.id, 1, "Breakfast")[0];
    M.log.update(key, e.id, { at: Date.now() - d * 864e5 + 5 * 60000 });   /* logged 5 minutes after the banana */
  });
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

t("combos: the plain shrimp (replaced by the Kirkland cooked shrimp) comes back as the Kirkland bag at its own serving", () => {
  M.reset();
  const to = M.DB && M.DB.replaced ? M.DB.replaced.g_shrimp : null, f = to ? M.foods.get(to) : null;
  if (!f) { console.log("       (skipped: no replaced shrimp)"); return; }
  const OLD = { name: "Shrimp", foodId: "g_shrimp", servingLabel: "1 oz raw", servings: 6, g: 28.35, state: "raw", cook: { y: 0.8375, word: "raw" }, per: { cal: 24.1, p: 5.7, c: 0, f: 0.1, fiber: 0, sugar: 0, sodium: 34 } };
  const QUIN = { name: "Quinoa", servingLabel: "1 cup (185 g)", per: { cal: 222, p: 8.1, c: 39.4, f: 3.6, fiber: 5.2, sugar: 1.6, sodium: 13 } };
  [2, 3].forEach(d => logDay(d, "Lunch", [OLD, QUIN]));
  const NEW = { name: f.name, brand: f.brand, foodId: f.id, servingLabel: "1 shrimp (10.5 g)", servings: 12, g: 10.5, per: M.foodMath.fromPer100(f.per100g, 10.5) };
  logDay(1, "Lunch", [NEW, QUIN]);
  const c = M.food.combos("nick", "Lunch");
  assert.strictEqual(c.length, 1, "old and new shrimp are one food: " + JSON.stringify(c.map(x => x.id)));
  assert.strictEqual(c[0].count, 3);
  const it = c[0].items.find(i => /shrimp/i.test(i.name));
  assert.ok(it && it.foodId === f.id && it.name === f.name && !it.state && !it.cook, "the Kirkland bag: " + JSON.stringify(it));
  /* the newest sitting was already the Kirkland shrimp: its own amount (12 shrimp) */
  near(it.per.cal * it.servings, 120, 0.5);
  /* only old sittings: the bag's own serving (8 shrimp, 84 g) with its numbers, never the old raw numbers */
  M.reset();
  [1, 2].forEach(d => logDay(d, "Lunch", [OLD, QUIN]));
  const o = M.food.combos("nick", "Lunch")[0].items.find(i => /shrimp/i.test(i.name));
  assert.ok(o && o.foodId === f.id && o.servings === 1 && o.g === 84 && o.per.cal === 80 && !o.state, JSON.stringify(o));
  /* a saved meal of the old shrimp + quinoa is that same idea: not offered twice */
  const rem = { cal: 2000, p: 150, c: 200, f: 70 };
  assert.strictEqual(M.food.suggestOften({ pid: "nick", slot: "Lunch", remaining: rem }).length, 1);
  M.meals.add({ name: "Shrimp bowl", slot: "Lunch", items: [OLD, QUIN] });
  assert.strictEqual(M.food.suggestOften({ pid: "nick", slot: "Lunch", remaining: rem }).length, 0, "the saved meal already covers it");
});

t("UX2-25 combos: only foods logged within an hour of each other count as eaten together", () => {
  M.reset();
  const APPLE = { name: "Apple", servingLabel: "1 medium (182 g)", per: { cal: 95, p: 0.5, c: 25, f: 0.3 } };
  const YOG = { name: "Greek yogurt", servingLabel: "1 cup (227 g)", per: { cal: 150, p: 20, c: 8, f: 4 } };
  const at = (d, h, m) => { const x = new Date(); x.setDate(x.getDate() - d); x.setHours(h, m || 0, 0, 0); return x.getTime(); };
  /* 3 pm apple, 5 pm yogurt: two snacks, three days running */
  [1, 2, 3].forEach(d => { const key = M.addDays(M.today(), -d); M.log.add(key, Object.assign({ slot: "Snacks", servings: 1, at: at(d, 15) }, APPLE)); M.log.add(key, Object.assign({ slot: "Snacks", servings: 1, at: at(d, 17) }, YOG)); });
  assert.deepStrictEqual(M.food.combos("nick", "Snacks"), [], "2 hours apart: not a combo");
  /* the same two within 20 minutes on two days: a combo */
  [4, 5].forEach(d => { const key = M.addDays(M.today(), -d); M.log.add(key, Object.assign({ slot: "Snacks", servings: 1, at: at(d, 15) }, APPLE)); M.log.add(key, Object.assign({ slot: "Snacks", servings: 1, at: at(d, 15, 20) }, YOG)); });
  const c = M.food.combos("nick", "Snacks");
  assert.deepStrictEqual(c.map(x => x.items.map(i => i.name).join(" + ") + " ×" + x.count), ["Apple + Greek yogurt ×2"]);
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
      { name: "Cottage cheese and pineapple", desc: "Easy.", store: "Costco", prepMin: 2, items: [{ name: "Greek yogurt, plain", servingLabel: "1 cup (226 g)", g: 226, per: { cal: 180, p: 24, c: 8, f: 5, fiber: 0, sugar: 8, sodium_mg: 700 } }, { name: "Pineapple", servingLabel: "1/2 cup (80 g)", g: 80, per: { cal: 40, p: 0, c: 10, f: 0, fiber: 1, sugar: 8, sodium_mg: 1 } }] },
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
  assert.ok(/isn't answering/i.test(off.aiError) && !/connection/i.test(off.aiError), "why Claude is missing, in plain words: " + off.aiError);
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

/* ======================================================================= */
/* F4 fixes (swarm triage): label reader, Open Food Facts retries, describe, cook info on scan */
t("BEF-01 label.parse: glued units pick the ÷10 reading closest to calories; >300 tries ÷10; sugar/fiber ≤ carbs; flagged in check + warning", () => {
  const P = s => M.food.label.parse("Nutrition Facts\nServing size 1 bar (40g)\n" + s);
  let r = P("Calories 120\nTotal Fat 30g\nSodium 100mg\nTotal Carbohydrate 20g\nDietary Fiber 2g\nTotal Sugars 5g\nProtein 3g");
  assert.strictEqual(r.per.f, 3, "'30g' for 3 g fat: only the ÷10 reading matches 120 kcal");
  assert.strictEqual(r.per.c, 20, "a right 20 g is left alone");
  assert.deepStrictEqual(r.check, ["f"]);
  assert.ok(/Check fat\. It may be wrong\./.test(r.warning), r.warning);
  r = P("Calories 230\nTotal Fat 8g\nSodium 160mg\nTotal Carbohydrate 379g\nDietary Fiber 4g\nTotal Sugars 12g\nProtein 3g");
  assert.strictEqual(r.per.c, 37, "379 (> 300 g) read as 37, not dropped");
  assert.ok(r.check.includes("c") && r.fields.includes("c"));
  r = P("Calories 110\nTotal Fat 2g\nSodium 200mg\nTotal Carbohydrate 12g\nDietary Fiber 3g\nTotal Sugars 90g\nProtein 4g");
  assert.strictEqual(r.per.sugar, 9, "sugar 90 > carbs 12 → the ÷10 reading");
  r = P("Calories 110\nTotal Fat 2g\nSodium 200mg\nTotal Carbohydrate 12g\nDietary Fiber 3g\nTotal Sugars 45g\nProtein 4g");
  assert.strictEqual(r.per.sugar, 12, "no ÷10 reading fits → capped at the carbs");
  assert.deepStrictEqual(r.check, ["sugar"]);
  r = P("Calories 150\nTotal Fat 5g\nSodium 180mg\nTotal Carbohydrate 30g\nDietary Fiber 5g\nTotal Sugars 1g\nSugar Alcohol 20g\nProtein 20g");
  assert.deepStrictEqual([r.per.c, r.per.p, r.check.length], [30, 20, 0], "sugar alcohol bars really don't add up: carbs are not 'fixed'");
  r = P("Calories 250\nTotal Fat 10g\nSodium 400mg\nTotal Carbohydrate 20g\nDietary Fiber 0g\nTotal Sugars 10g\nProtein 20g");
  assert.deepStrictEqual([r.per.f, r.per.c, r.per.p, r.per.sugar, r.check.length, r.warning], [10, 20, 20, 10, 0, undefined], "right numbers ending in 0 are never touched");
});

t("BEF-01/UX1-02 label.parse: serving grams sanity ('1 tortilla (459g)' → 45 g, flagged), serving found anywhere in the text, fields not found listed", () => {
  const body = "\nCalories 110\nTotal Fat 3g\nSodium 290mg\nTotal Carbohydrate 19g\nDietary Fiber 11g\nTotal Sugars 0g\nProtein 8g";
  let r = M.food.label.parse("Nutrition Facts\n8 servings per container\nServing size 1 tortilla (459g)" + body);
  assert.deepStrictEqual(r.serving, { qty: 1, unit: "tortilla", g: 45 });
  assert.deepStrictEqual(r.check, ["g"]);
  assert.ok(/Check the grams\. We read 459 g for 1 tortilla and used 45 g\./.test(r.warning), r.warning);
  r = M.food.label.parse("Nutrition Facts\nServing size 1 tortilla (450g)" + body);
  assert.strictEqual(r.serving.g, 450, "no misread to undo: kept");
  assert.ok(r.check.includes("g") && /Check the grams: 1 tortilla = 450 g\?/.test(r.warning), r.warning);
  r = M.food.label.parse("Nutrition Facts\n8 servings per container\nServing size\nAmount per serving" + body + "\n1 tortilla (45g)");
  assert.deepStrictEqual(r.serving, { qty: 1, unit: "tortilla", g: 45 }, "'1 tortilla (45g)' found away from 'Serving size'");
  r = M.food.label.parse("Nutrition Facts\nServing size 1 cup (240mL)\nCalories 130\nTotal Fat 2.5g\nSodium 125mg\nTotal Carbohydrate 12g\nProtein 16g");
  assert.deepStrictEqual(r.missing, ["fiber", "sugar"]);
  assert.strictEqual(r.warning, "Couldn't read fiber and sugar. Type them in.");
  assert.deepStrictEqual(r.check, []);
});

/* the be-food finder's 20 OCR edge cases (linear labels, rn→m, mq, 05g, "4 5g", split columns, Sg / Smg, EU, package words, "1 9 0", servlngs) */
const BEF_LABELS = [
  { t: "Nutrition Facts Serv. size: 1 pouch (43g), Amount per serving: Calories 150, Total Fat 2.5g (3% DV), Sat. Fat 0g (0% DV),\nTrans Fat 0g, Cholest. 0mg (0% DV), Sodium 90mg (4% DV), Total Carb. 32g (12% DV), Fiber 1g (4% DV), Total Sugars 19g\n(Incl. 19g Added Sugars, 38% DV), Protein 1g. Not a significant source of vitamin D. *The % Daily Value (DV) tells you how much a nutrient contributes to a daily diet.", exp: { cal: 150, f: 2.5, sodium: 90, c: 32, fiber: 1, sugar: 19, p: 1 }, sv: { qty: 1, unit: "pouch", g: 43 } },
  { t: "Nutrition Facts\nServing size 1 slice (28g)\nCalories 70\nTotal Fat 1g\nSodiurn 140mg 6%\nTotal Carbohydrate 13g\nProtein 3g", exp: { sodium: 140 } },
  { t: "Nutrition Facts\nServing size 2/3 cup (55g)\nCalories 230\nTotal Fat 8g\nSodium 160mq 7%\nTotal Carbohydrate 37g\nProtein 3g", exp: { sodium: 160 } },
  { t: "Nutrition Facts\nServing size 1 cup (240mL)\nCalories 80\nTotal Fat 05g 1%\nSodium 125mg 5%\nTotal Carbohydrate 12g 4%\nTotal Sugars 12g\nProtein 8g", exp: { f: 0.5 } },
  { t: "Nutrition Facts\nServing size 1 bar (40g)\nCalories 190\nTotal Fat 4 5g 6%\nSodium 150mg\nTotal Carbohydrate 28g\nProtein 10g", exp: { f: 4.5 } },
  { t: "Nutrition Facts\nServing size 2/3 cup (55g)\nCalories 230\nTotal Fat\nSodium\nTotal Carbohydrate\nProtein\n8g\n160mg\n37g\n3g", exp: { cal: 230, f: 8, sodium: 160, c: 37, p: 3 } },
  { t: "Nutrition Facts\nServing size 1 cup (30g)\nCalories 110\nTotal Fat 2g\nSodium 200mg\nTotal Carbohydrate 20g\nProtein Sg 10%", exp: { p: 5 } },
  { t: "Nutrition Facts\nServing size 1 piece (15g)\nCalories 60\nTotal Fat 3g\nSodium Smg 0%\nTotal Carbohydrate 8g\nProtein 1g", exp: { sodium: 5 } },
  { t: "Nutrition declaration\nper 100g\nEnergy 1570kJ / 375kcal\nFat 8.1g\nof which saturates 1.2g\nCarbohydrate 62g\nof which sugars 21g\nFibre 6.5g\nProtein 9.7g\nSalt 0.55g", exp: { cal: 375, f: 8.1, c: 62, sugar: 21, fiber: 6.5, p: 9.7, sodium: 220 }, sv: { qty: 100, unit: "g", g: 100 } },
  { t: "KEEP REFRIGERATED\nNutrition Facts\nServing size 1 container (150g)\nCalories 100\nTotal Fat 0g\nSodium 60mg\nTotal Carbohydrate 6g\nTotal Sugars 4g\nProtein 18g", exp: { cal: 100 }, name: "" },
  { t: "Nutrition Facts\nServing size 1 bar (60g)\nCalories 1 9 0\nTotal Fat 7g\nSodium 210mg\nTotal Carbohydrate 23g\nProtein 21g", exp: { cal: 190 } },
  { t: "Nutrition Facts\nabout 2.5 servlngs per contalner\nServing size 3 oz (85g)\nCalories 120\nTotal Fat 1g\nSodium 300mg\nTotal Carbohydrate 0g\nProtein 26g", exp: { cal: 120 }, spc: 2.5 },
  { t: "Nutrition Facts\nServing size 1 can (355 mL)\nCalories 0\nTotal Fat 0g 0%\nSodium 40mg 2%\nTotal Carbohydrate 0g 0%\nTotal Sugars 0g\nProtein 0g", exp: { cal: 0, sodium: 40, c: 0, p: 0 } }
];
t("BEF-07/08/14/15/16 label.parse: the finder's OCR edge cases all read right", () => {
  BEF_LABELS.forEach(c => {
    const r = M.food.label.parse(c.t);
    Object.keys(c.exp).forEach(k => near(r.per[k], c.exp[k], 0.051, c.t.slice(0, 40) + " → " + k));
    if (c.sv) assert.deepStrictEqual(r.serving, c.sv, c.t.slice(0, 40));
    if (c.spc) assert.strictEqual(r.servingsPerContainer, c.spc);
    if (c.name !== undefined) assert.strictEqual(r.name || "", c.name, "package words are not the name");
  });
});

t("label.fromImage (built-in reader): fields not found come back empty (null), with check / missing / warning", async () => {
  M.ai.setKey("");
  const realPrep = M.img.prepOCR;
  M.img.prepOCR = async () => ({ canvas: {}, blob: {}, width: 10, height: 10 });
  const text = "Nutrition Facts\nServing size 1 tortilla (459g)\nCalories 110\nTotal Fat 3g\nSodium 290mg\nTotal Carbohydrate 19g\nProtein 8g";
  global.Tesseract = { createWorker: async () => ({ setParameters: async () => {}, recognize: async () => ({ data: { text } }), terminate: async () => {} }) };
  try {
    const r = await M.food.label.fromImage({ type: "image/jpeg", size: 10 }, { method: "ocr" });
    assert.strictEqual(r.method, "ocr");
    assert.strictEqual(r.food.per.fiber, null, "not read → empty box, not 0");
    assert.strictEqual(r.food.per.sugar, null);
    assert.strictEqual(r.food.per.cal, 110);
    assert.strictEqual(r.food.serving.g, 45);
    assert.deepStrictEqual(r.check, ["g"]);
    assert.deepStrictEqual(r.missing, ["fiber", "sugar"]);
    assert.ok(/Check the grams/.test(r.warning) && /Couldn't read fiber and sugar/.test(r.warning), r.warning);
  } finally { M.img.prepOCR = realPrep; delete global.Tesseract; }
});

t("BEF-02/OFL-09 Open Food Facts: a CORS-blocked 503 is retried (once for a lookup, twice for search); online it's never blamed on their connection", async () => {
  M.reset();
  let n = 0;
  global.fetch = async () => { n++; if (n === 1) throw new TypeError("Load failed"); return reply(OFF_KIRKLAND_BAR); };
  const r = await M.food.lookup("096619193738");
  assert.strictEqual(r.status, "found");
  assert.strictEqual(n, 2, "second try worked");
  n = 0;
  global.fetch = async () => { n++; if (n <= 2) return { ok: false, status: 503, json: async () => null }; return reply({ products: [OFF_OIKOS.product] }); };
  const list = await M.food.searchOFF("oikos");
  assert.deepStrictEqual([n, list.length], [3, 1], "search: two retries");
  n = 0;
  global.fetch = async () => { n++; throw new TypeError("Failed to fetch"); };
  await M.food.searchOFF("oikos").then(() => assert.fail(), e => { assert.strictEqual(e.code, "off_down"); assert.strictEqual(e.message, "Open Food Facts isn't answering right now. Try again in a minute, or scan the label."); });
  assert.strictEqual(n, 3);
  NAV.onLine = false; n = 0;
  await M.food.searchOFF("oikos").then(() => assert.fail(), e => { assert.strictEqual(e.code, "offline"); assert.ok(/offline/i.test(e.message)); });
  assert.strictEqual(n, 0, "offline: no request at all");
  delete NAV.onLine; delete global.fetch;
});

t("BEF-06 store price stickers (UPC-A starting with 2): matched on the first 6 digits, Open Food Facts never asked", async () => {
  M.reset();
  const gt = M.food.gtin;
  const code = p => { const b = "20123450" + p; return b + gt.check(b); };      /* item 01234, price digits p */
  const first = code("599"), later = code("749");
  assert.ok(gt.valid(first) && gt.valid(later) && first !== later);
  let calls = 0;
  global.fetch = async () => { calls++; return reply(OFF_KIRKLAND_BAR); };
  const miss = await M.food.lookup(first);
  assert.deepStrictEqual([miss.status, miss.store, calls], ["not_found", true, 0]);
  assert.ok(/price sticker/.test(miss.message), miss.message);
  const f = M.foods.add({ name: "Pork tenderloin 2-pack", brand: "King Soopers", source: "label", barcode: first, serving: { qty: 4, unit: "oz", g: 113 }, per: { cal: 120, p: 22, c: 0, f: 3, fiber: 0, sugar: 0, sodium: 50 } });
  const hit = await M.food.lookup(later);
  assert.deepStrictEqual([hit.status, hit.saved, hit.food.id, calls], ["found", true, f.id, 0], "another price, same item");
  assert.strictEqual((await M.food.lookup("0" + later)).food.id, f.id, "EAN-13 form too");
  delete global.fetch;
});

t("UX2-03 scanned raw meat / dry rice / pasta get the built-in food's cook info when saved; cooked products don't", async () => {
  M.reset();
  const off = (code, name, kcal100, p100, c100) => ({ code, product: { code, product_name: name, brands: "Kroger", serving_size: "4 oz (112 g)", serving_quantity: 112, nutriments: { "energy-kcal_100g": kcal100, proteins_100g: p100, carbohydrates_100g: c100, fat_100g: 2 } }, status: 1 });
  const upc = b => b + M.food.gtin.check(b);
  const C = [["Boneless Skinless Chicken Breasts", 110, 23, 0], ["Jasmine Rice", 356, 7, 79], ["Ready Rice Jasmine", 150, 3, 32], ["Penne Rigate", 357, 13, 71], ["Grilled Chicken Breast Strips", 150, 26, 2], ["93% Lean Ground Beef", 152, 21, 0]];
  const codes = C.map((c, i) => upc("0111100000" + i));
  const cases = {}; codes.forEach((k, i) => { cases[k] = off("0" + k, C[i][0], C[i][1], C[i][2], C[i][3]); });
  global.fetch = async url => { const k = codes.find(c => url.indexOf("/0" + c + ".json") >= 0); return k ? reply(cases[k]) : { ok: false, status: 404, json: async () => OFF_NOT_FOUND }; };
  /* the plain chicken breast may be merged into the Kirkland breast (m-data, Nick's rule): resolve like the app does */
  const gen = id => M.DB.generic.find(f => f.id === id) || (M.DB.alias && M.DB.alias[id] ? M.DB.generic.find(f => f.id === M.DB.alias[id].id) : null) ||
    (id === "g_chicken_breast" ? M.DB.generic.find(f => f.alwaysRaw === true && /chicken/i.test(f.name)) : null);
  const y = id => gen(id).cook.y;
  const ch = (await M.food.lookup(codes[0])).food;
  assert.ok(ch.cook, "raw chicken breast gets cook info");
  assert.strictEqual(ch.cook.word, "raw");
  near(ch.cook.y, y("g_chicken_breast"), 1e-6);
  near(ch.cook.per100gCooked.cal, 110 / y("g_chicken_breast"), 0.6, "cooked = this label's raw ÷ y");
  assert.strictEqual(M.foods.get(ch.id).cook.word, "raw", "saved with it");
  assert.strictEqual(M.foods.get(ch.id).alwaysRaw, true, "Nick's rule: a scanned raw chicken breast is weighed raw, like the built-in one");
  const rice = (await M.food.lookup(codes[1])).food;
  assert.ok(rice.cook && rice.cook.word === "dry" && Math.abs(rice.cook.y - y("g_white_rice")) < 1e-6);
  assert.ok(!(await M.food.lookup(codes[2])).food.cook, "ready rice is already cooked");
  const pasta = (await M.food.lookup(codes[3])).food;
  assert.ok(pasta.cook && pasta.cook.word === "dry");
  const strips = (await M.food.lookup(codes[4])).food;
  assert.ok(!strips.cook, "grilled strips are already cooked");
  assert.ok(!strips.alwaysRaw, "and aren't weighed raw");
  near((await M.food.lookup(codes[5])).food.cook.y, y("g_ground_beef_93"), 1e-6, "93% lean → the 93/7 beef");
  if (M.cook && typeof M.cook.unitsFor === "function") assert.ok(M.cook.unitsFor(M.foods.get(ch.id), "us").some(o => o.state === "cooked"), "raw and cooked units offered");
  delete global.fetch;
});

t("BEF-03/UX2-18 describe (no Claude): the thing they ate must be in the name; 'Avocado oil' isn't an avocado; saved meals by name first (batch by cooked weight); unknown dishes unmatched", async () => {
  M.reset(); M.ai.setKey("");
  const d = s => M.food.describeLocal(s);
  const name = s => { const r = d(s); return r.items.length ? r.items[0].name : "(none) " + r.unmatched.join(","); };
  assert.ok(/^avocado$/i.test(name("avocado").split(",")[0]) || !/oil/i.test(name("avocado")), "avocado → " + name("avocado"));
  assert.ok(!/oil/i.test(name("half an avocado")));
  /* Nick's rule: plain "turkey" is their sliced turkey (Hillshire Farm), not ground turkey or turkey bacon */
  assert.ok(/turkey/i.test(name("turkey")) && !/ground|bacon/i.test(name("turkey")) && !/bacon/i.test(name("4 oz turkey")), name("turkey"));
  assert.deepStrictEqual(d("two tacos").unmatched, ["two tacos"], "not the taco seasoning");
  assert.deepStrictEqual(d("9 oz chicken veggie bake").unmatched, ["9 oz chicken veggie bake"], "an unknown dish isn't plain chicken");
  assert.deepStrictEqual(d("a turkey sandwich").unmatched, ["turkey sandwich"], "PL-01: said back without the filler word");
  assert.ok(/^Egg/.test(name("2 eggs over easy")) && d("2 eggs over easy").items[0].servings === 2);
  assert.ok(/white rice/i.test(name("rice")) && /chicken breast/i.test(name("chicken")) && /ground beef/i.test(name("beef")));
  const ch = M.foods.list().find(f => /chicken breast/i.test(f.name));
  const bake = M.meals.add({ name: "Chicken veggie bake", slot: "Dinner", items: [{ name: "Chicken", servings: 1, servingLabel: "32 oz raw", g: 907, per: { cal: 1090, p: 204, c: 0, f: 24, fiber: 0, sugar: 0, sodium: 400 }, foodId: ch ? ch.id : undefined }, { name: "Zucchini", servings: 1, servingLabel: "500 g", g: 500, per: { cal: 85, p: 6, c: 15, f: 1, fiber: 5, sugar: 12, sodium: 40 } }], batch: { rawG: 1407, cookedG: 1100 } });
  let r = d("9 oz chicken veggie bake");
  assert.deepStrictEqual(r.unmatched, []);
  assert.strictEqual(r.items[0].mealId, bake.id);
  assert.deepStrictEqual([r.items[0].servings, r.items[0].servingLabel, r.items[0].state], [9, "1 oz cooked", "cooked"]);
  near(r.items[0].per.cal * r.items[0].servings, 1175 * 9 * 28.35 / 1100, 2, "9 oz of the cooked batch");
  assert.strictEqual(d("chicken bake").items[0].mealId, bake.id, "two of its words");
  const eggs = M.meals.add({ name: "Eggs and toast", slot: "Breakfast", items: [{ name: "Egg", servings: 3, servingLabel: "1 large egg (50 g)", g: 50, per: { cal: 72, p: 6, c: 0, f: 5, fiber: 0, sugar: 0, sodium: 70 } }] });
  r = d("eggs and toast, 1 cup rice");
  assert.deepStrictEqual(r.items.map(x => x.mealId || x.name), [eggs.id, "White rice"], "the meal's name spans the 'and'");
  assert.strictEqual(r.items[0].servings, 1);
});

t("BEF-03 describe uses M.searchTokens when m-core has it", () => {
  const had = M.searchTokens;
  const seen = [];
  M.searchTokens = s => { seen.push(s); return String(s).toLowerCase().replace(/['’]/g, "").split(/[^a-z]+/).filter(Boolean).map(w => (w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.replace(/ies$/, "y").replace(/oes$/, "o").replace(/s$/, "") : w)); };
  try {
    const r = M.food.describeLocal("2 slices daves bread");
    assert.ok(seen.length > 0, "called");
    assert.ok(/dave/i.test(r.items[0].name + r.items[0].brand), r.items[0].name);
  } finally { if (had) M.searchTokens = had; else delete M.searchTokens; }
});

t("BEF-04/OFL-04 scanner engine: no offline gate (a cached engine starts offline); load capped (~10 s) with a state the UI can show", async () => {
  const S0 = M.food._.SCAN;
  assert.ok(S0.loadMs <= 10000 && S0.pageAfterMs <= 4000);
  /* the page engine's script is already there (cached / loaded before): offline must not stop it */
  global.BarcodeDetectionAPI = { setZXingModuleOverrides() {}, BarcodeDetector: class { async detect() { return []; } }, prepareZXingModule: async () => true };
  global.document = { head: { appendChild() {} }, createElement: () => ({}) };
  NAV.onLine = false;
  M.food.scanner._setEngine(null);
  assert.strictEqual(M.food.scanner.state(), "none");
  const p = M.food.scanner.preload();
  assert.strictEqual(M.food.scanner.state(), "loading");
  assert.strictEqual(await p, "wasm", "offline, but the engine is on the phone");
  assert.strictEqual(M.food.scanner.state(), "ready");
  delete global.BarcodeDetectionAPI;
  M.food.scanner._setEngine(null);
  await M.food.scanner.preload();
  assert.strictEqual(M.food.scanner.state(), "failed");
  delete global.document; delete NAV.onLine;
  M.food.scanner._setEngine(null);
});

/* Built-in `staple` flags (the foods they buy) set just for one test, then put back. */
function withStaples(ids, fn) {
  const G = M.DB.generic, had = G.map(f => f.staple);
  G.forEach(f => { delete f.staple; });
  ids.forEach(id => { const f = G.find(x => x.id === id); assert.ok(f, "built-in food " + id); f.staple = true; });
  const done = () => G.forEach((f, i) => { if (had[i] === undefined) delete f.staple; else f.staple = had[i]; });
  let out;
  try { out = fn(); } catch (e) { done(); throw e; }
  if (out && typeof out.then === "function") return out.then(v => { done(); return v; }, e => { done(); throw e; });
  done(); return out;
}

t("staples: describe picks the food they buy on near-ties (never over the food they named, never over their own saved food); 'toast' is bread", () => {
  M.reset(); M.ai.setKey("");
  const pick = s => { const r = M.food.describeLocal(s); return r.items.length ? r.items[0].foodId : "(none) " + r.unmatched.join(","); };
  withStaples(["g_dkb_21_grains", "g_kirkland_organic_chicken", "g_greek_yogurt_2", "g_roma_tomato"], () => {
    assert.deepStrictEqual(["2 slices bread", "6 oz chicken breast", "greek yogurt", "tomato"].map(pick), ["g_dkb_21_grains", "g_kirkland_organic_chicken", "g_greek_yogurt_2", "g_roma_tomato"]);
    assert.strictEqual(pick("chicken thigh"), "g_chicken_thigh", "a staple never beats the food they named");
    assert.strictEqual(pick("white bread"), "g_white_bread");
    assert.strictEqual(pick("greek yogurt nonfat"), "g_greek_yogurt_0");
    assert.strictEqual(pick("2 slices of toast"), "g_dkb_21_grains", "toast → bread");
    const mine = M.foods.add({ name: "Greek yogurt 2%", brand: "Fage", source: "off", serving: { qty: 1, unit: "container", g: 150 }, per: { cal: 120, p: 15, c: 6, f: 3, fiber: 0, sugar: 6, sodium: 60 } });
    assert.strictEqual(pick("greek yogurt"), mine.id, "their own saved food still first");
  });
  withStaples([], () => { assert.ok(/^g_/.test(pick("sourdough toast")), "toast → bread without staples too: " + pick("sourdough toast")); });
});

t("staples: built-in meal ideas made of foods they buy score higher", () => {
  const rem = { cal: 700, p: 50, c: 70, f: 25 };
  const builtInIds = s => s.items.map(it => it.foodId).filter(id => M.DB.generic.some(f => f.id === id));
  const idea = M.DB.suggest.find(s => s.id === "s_eggs_dkb_toast") || M.DB.suggest.find(s => /breakfast/i.test(s.slot) && new Set(builtInIds(s)).size >= 2);
  const ids = Array.from(new Set(builtInIds(idea)));
  const score = () => M.food.suggestBuiltin({ slot: "Breakfast", remaining: rem, jitter: 0, n: 99 }).find(s => s.id === idea.id).score;
  const plain = withStaples([], score);
  const all = withStaples(ids, score);
  const some = withStaples(ids.slice(0, 1), score);
  near(all - plain, 8 * idea.items.filter(it => ids.indexOf(it.foodId) >= 0).length / idea.items.length, 0.11, "all its built-in foods are staples");
  assert.ok(some > plain && some < all, [plain, some, all].join(" "));
});

t("BEF-09/BEF-10 suggest: a usual combo that is one of their saved meals isn't shown twice; nothing left → only light ideas, lightest first, list.over", async () => {
  M.reset(); M.ai.setKey("");
  const meal = M.meals.add({ name: "Eggs and toast", desc: "The usual.", slot: "Breakfast", items: [EGG, TOAST] });
  [1, 2, 3].forEach(d => logDay(d, "Breakfast", [EGG, TOAST]));
  let list = await M.food.suggest({ pid: "nick", slot: "Breakfast", remaining: { cal: 700, p: 50, c: 70, f: 25 }, ai: false });
  assert.ok(list.some(s => s.mealId === meal.id));
  assert.ok(!list.some(s => s.source === "often"), "Egg + Bread = their 'Eggs and toast': " + list.map(s => s.source + ":" + s.name).join(", "));
  assert.ok(!list.over);
  [1, 2].forEach(d => logDay(d, "Breakfast", [BUTTER]));
  list = await M.food.suggest({ pid: "nick", slot: "Breakfast", remaining: { cal: 700, p: 50, c: 70, f: 25 }, ai: false });
  assert.ok(list.some(s => s.source === "often"), "Egg + Bread + Butter is not the saved meal");
  for (const cal of [0, -300]) {
    list = await M.food.suggest({ pid: "nick", slot: "Breakfast", remaining: { cal, p: 0, c: 0, f: 0 }, ai: false });
    assert.strictEqual(list.over, true, "flag for the screen");
    assert.ok(list.length >= 1 && list.every(s => s.per.cal <= 150), list.map(s => s.name + " " + s.per.cal).join(", "));
    const kc = list.filter(s => s.source === "idea").map(s => s.per.cal);
    assert.deepStrictEqual(kc, kc.slice().sort((a, b) => a - b), "lightest first");
  }
  list = await M.food.suggest({ pid: "nick", slot: "Breakfast", remaining: { cal: null }, ai: false });
  assert.ok(!list.over && list.length >= 6, "calories left not known is not 'none left'");
});

t("UX2-03 scanned cod / shrimp / scallops / quinoa take the cook info of a matching built-in raw or dry food (when the built-in list has one)", async () => {
  M.reset();
  const G = M.DB.generic, n0 = G.length;
  const add = (id, name, word, y, per100g) => G.push({ id, name, brand: "", barcode: "", source: "generic", serving: { qty: 4, unit: "oz", g: 113 }, per: per100g, per100g, alts: [], cook: { y, word, per100gCooked: Object.keys(per100g).reduce((o, k) => (o[k] = per100g[k] / y, o), {}) }, uses: 0, lastUsed: 0, createdAt: 0, updatedAt: 0, pid: null });
  /* m-data's own cod / shrimp / scallops / quinoa when it has them (F7 adds them), else stand-ins */
  /* the plain built-ins, and the Kirkland cod and scallops they buy (a staple with a brand) */
  const real = re => G.find(f => (!f.brand || f.staple === true) && isObjT(f.cook) && f.cook.y > 0 && re.test(f.name));
  const ensure = (re, id, name, word, y, per100g) => real(re) || (add(id, name, word, y, per100g), G[G.length - 1]);
  const cod = ensure(/^cod\b/i, "g_t_cod", "Cod, raw", "raw", 0.8, { cal: 82, p: 18, c: 0, f: 0.7, fiber: 0, sugar: 0, sodium: 54 });
  /* their shrimp (the Kirkland bag) is sold cooked, so raw shrimp from another bag takes USDA's raw / cooked pair */
  const shrimp = real(/^shrimp\b/i) || (G.some(f => f.id === "g_kirkland_cooked_shrimp") ? { cook: { y: 0.8375, word: "raw" } } : ensure(/^shrimp\b/i, "g_t_shrimp", "Shrimp, raw", "raw", 0.85, { cal: 85, p: 20, c: 0, f: 0.5, fiber: 0, sugar: 0, sodium: 119 }));
  const scal = ensure(/^scallops?\b/i, "g_t_scallops", "Scallops, raw", "raw", 0.8, { cal: 69, p: 12, c: 3, f: 0.5, fiber: 0, sugar: 0, sodium: 392 });
  const quin = ensure(/^quinoa\b/i, "g_t_quinoa", "Quinoa, dry", "dry", 2.6, { cal: 368, p: 14, c: 64, f: 6, fiber: 7, sugar: 0, sodium: 5 });
  try {
    const cf = (name, kcal) => M.food.cookFor({ name, per100g: { cal: kcal, p: 15, c: 1, f: 1, fiber: 0, sugar: 0, sodium: 100 } });
    const want = f => (f.cook.word === "dry" ? "dry" : "raw") + " " + f.cook.y;
    assert.deepStrictEqual([cf("Wild Caught Cod Fillets", 80), cf("Raw Shrimp 31-40 Count", 90), cf("Sea Scallops", 70), cf("Organic Tri-Color Quinoa", 370)].map(c => c && c.word + " " + c.y), [want(cod), want(shrimp), want(scal), want(quin)]);
    assert.strictEqual(quin.cook.word, "dry");
    near(cf("Wild Caught Cod Fillets", 80).per100gCooked.cal, 80 / cod.cook.y, 0.01, "this label's raw ÷ y");
    assert.deepStrictEqual([cf("Cooked Shrimp", 99), cf("Shrimp Cocktail", 99), cf("Breaded Cod Fillets", 200), cf("Quinoa Chips", 450)], [null, null, null, null], "already cooked or not the plain food");
    /* a Kirkland bag the phone doesn't know by its code yet: the Kirkland cod / scallops' y; their shrimp comes cooked */
    const kc = G.find(f => f.id === "g_cod"), ks = G.find(f => f.id === "g_scallops");
    if (kc && kc.brand === "Kirkland" && ks) {
      assert.strictEqual(cf("Wild Caught Alaska Pacific Cod", 71).y, kc.cook.y, "Kirkland cod y");
      assert.strictEqual(cf("Wild Caught Sea Scallops", 88).y, ks.cook.y, "Kirkland scallops y");
      assert.strictEqual(cf("Farm Raised Cooked Tail On Shrimp", 95), null, "cooked shrimp stays plain");
      /* another brand's raw cod (USDA raw 82, cooked 105 per 100 g decide "already cooked", not the lean Kirkland label) */
      assert.strictEqual((cf("Rock Cod", 85) || {}).y, kc.cook.y, "a raw cod label at 85 kcal is raw");
      assert.strictEqual(cf("Cod Fillets", 100), null, "100 kcal per 100 g reads cooked");
      assert.strictEqual((cf("Jumbo Prawns", 90) || {}).y, 0.8375, "raw prawns: USDA's shrimp pair");
    }
  } finally { G.length = n0; }
});

/* A fake Tesseract: counts workers, reports download progress, answers with `text`. */
function fakeTess(text, opt) {
  opt = opt || {};
  const T = { made: 0, ended: 0, createWorker: async (lang, oem, o) => {
    T.made++;
    if (opt.startDelay) await new Promise(r => setTimeout(r, opt.startDelay));
    if (o && o.logger) { o.logger({ status: "loading tesseract core", progress: 0 }); o.logger({ status: "loading tesseract core", progress: 1 }); o.logger({ status: "loading language traineddata", progress: 0.5 }); o.logger({ status: "loading language traineddata", progress: 1 }); }
    return { setParameters: async () => {}, terminate: async () => { T.ended++; },
      recognize: async () => { if (opt.readDelay) await new Promise(r => setTimeout(r, opt.readDelay)); if (o && o.logger) o.logger({ status: "recognizing text", progress: 0.5 }); return { data: { text } }; } };
  } };
  return T;
}
const LABEL_TXT = "Nutrition Facts\nServing size 1 bar (40g)\nCalories 190\nTotal Fat 7g\nSodium 210mg\nTotal Carbohydrate 23g\nDietary Fiber 3g\nTotal Sugars 8g\nProtein 10g";

t("OFL-06/PRF-10/BEF-20 label reader: download progress in plain words; one reader kept for the next photo, closed by release(); a reader that starts too late is closed; only reading has a short timer", async () => {
  M.ai.setKey("");
  const realPrep = M.img.prepOCR, { TESS } = M.food._, keep = Object.assign({}, TESS);
  M.img.prepOCR = async () => ({ canvas: {}, blob: {}, width: 10, height: 10 });
  const photo = { type: "image/jpeg", size: 10 };
  try {
    M.food.label.release();
    localStorage.removeItem("chalk.ocr.loaded");       /* first time on this phone */
    let T = global.Tesseract = fakeTess(LABEL_TXT);
    const said = [];
    const r = await M.food.label.fromImage(photo, { onProgress: m => said.push(m) });
    assert.strictEqual(r.food.per.cal, 190);
    assert.ok(said.includes("Downloading the label reader… One time only, about 7 MB."), said.join(" | "));
    assert.ok(said.includes("Downloading the label reader… 57%. One time only, about 7 MB.") && said.includes("Downloading the label reader… 78%. One time only, about 7 MB."), said.join(" | "));
    assert.ok(said.includes("Reading label… 50%"), said.join(" | "));
    await M.food.label.fromImage(photo);
    assert.deepStrictEqual([T.made, T.ended], [1, 0], "the second photo uses the same reader");
    M.food.label.release();
    assert.strictEqual(T.ended, 1, "release() closes it");
    await M.food.label.fromImage(photo);
    assert.strictEqual(T.made, 2, "a new one after release");
    M.food.label.release();
    /* starts after the time limit: we give up with plain words, and the late reader is closed */
    TESS.startMs = 30;
    T = global.Tesseract = fakeTess(LABEL_TXT, { startDelay: 80 });
    await M.food.label.fromImage(photo).then(() => assert.fail(), e => { assert.strictEqual(e.code, "ocr_load"); assert.ok(/took too long to download.*Wi-Fi/.test(e.message), e.message); });
    await new Promise(r => setTimeout(r, 120));
    assert.deepStrictEqual([T.made, T.ended], [1, 1], "the late reader is closed at once");
    Object.assign(TESS, keep);
    /* a slow download is fine; a stuck read is not (and that reader is dropped) */
    TESS.readMs = 30;
    T = global.Tesseract = fakeTess(LABEL_TXT, { startDelay: 60, readDelay: 200 });
    await M.food.label.fromImage(photo).then(() => assert.fail(), e => { assert.ok(/took too long.*closer, brighter photo/.test(e.message), e.message); });
    assert.strictEqual(T.ended, 1, "the stuck reader is closed");
  } finally { Object.assign(TESS, keep); M.food.label.release(); M.img.prepOCR = realPrep; delete global.Tesseract; }
});

t("OFL-07/OFL-08 label offline or reader not loading: Claude isn't asked offline; plain words that fit (offline / key saved / no key); the script is hash-checked (SRI)", async () => {
  const { TESS } = M.food._;
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 500, json: async () => ({ error: { type: "api_error" } }) }; };
  const photo = { type: "image/jpeg", size: 10 };
  const scripts = [];
  global.document = { head: { appendChild(s) { scripts.push(s); setTimeout(() => s.onerror && s.onerror(), 0); } }, createElement: () => ({ remove() {} }) };
  try {
    M.food.label.release();
    M.ai.setKey("sk-ant-test");
    NAV.onLine = false;
    const said = [];
    await M.food.label.fromImage(photo, { onProgress: m => said.push(m) }).then(() => assert.fail(), e => { assert.strictEqual(e.message, "You're offline. Type the numbers in, or try again when you're online."); });
    assert.strictEqual(calls, 0, "offline: Claude isn't asked");
    assert.ok(said[0] === "You're offline. Reading it on your phone…" && !said.some(m => /Claude/.test(m)), said.join(" | "));
    delete NAV.onLine;
    const said2 = [];
    await M.food.label.fromImage(photo, { onProgress: m => said2.push(m) }).then(() => assert.fail(), e => { assert.strictEqual(e.message, "The label reader couldn't load. Try again, or type the numbers in."); });
    assert.deepStrictEqual(said2.slice(0, 2), ["Reading label with Claude…", "Claude couldn't read it. Reading it on your phone…"], "online with a key: Claude first");
    M.ai.setKey("");
    await M.food.label.fromImage(photo).then(() => assert.fail(), e => { assert.ok(/couldn't load.*Anthropic key \(You → AI\), Claude can read labels too/.test(e.message), e.message); });
    const s = scripts.find(x => x.src === TESS.script);
    assert.ok(s, "tesseract.min.js requested");
    assert.strictEqual(s.integrity, "sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F");
    assert.strictEqual(s.crossOrigin, "anonymous");
  } finally { delete NAV.onLine; delete global.document; delete global.fetch; M.ai.setKey(""); }
});

t("OFL-11/BEF-17 suggest never waits long for Claude: onClaude gets Claude's ideas later; without it a slow Claude is cut off (and aborted); offline skips Claude; short fixed notes", async () => {
  M.reset(); M.ai.setKey("sk-ant-test");
  const rem = { cal: 700, p: 50, c: 70, f: 25 };
  const reply = { suggestions: [{ name: "Chicken rice bowl", desc: "Chicken over rice.", store: "Costco", prepMin: 10, items: [{ name: "Chicken breast", servingLabel: "6 oz (170 g)", g: 170, per: { cal: 280, p: 52, c: 0, f: 6, fiber: 0, sugar: 0, sodium_mg: 120 } }] }] };
  let release = null, calls = 0, aborted = false;
  global.fetch = (u, o) => { calls++; if (o && o.signal) o.signal.addEventListener("abort", () => { aborted = true; }); return new Promise(r => { release = () => r(claudeReply(reply)); }); };
  try {
    let got = null;
    const t0 = Date.now();
    const list = await M.food.suggest({ slot: "Lunch", remaining: rem, onClaude: (l, note) => { got = { l, note }; } });
    assert.ok(Date.now() - t0 < 1000 && list.length >= 3 && list.every(s => s.source !== "claude"), "the phone's ideas at once");
    assert.strictEqual(list.claudePending, true);
    assert.strictEqual(got, null);
    for (let i = 0; i < 50 && !release; i++) await new Promise(r => setTimeout(r, 10));
    release();
    for (let i = 0; i < 50 && !got; i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(got && got.l.length === 1 && got.l[0].source === "claude" && got.note === "", JSON.stringify(got));
    /* no callback: a Claude that doesn't answer in time is cut off with a plain note */
    aborted = false;
    const slow = await M.food.suggest({ slot: "Lunch", remaining: rem, claudeMs: 60 });
    assert.ok(slow.length >= 3 && !slow.some(s => s.source === "claude"));
    assert.strictEqual(slow.aiError, "Claude was slow, so there are no ideas from Claude this time.");
    assert.ok(aborted, "the slow request is stopped");
    release();
    /* offline: Claude isn't asked */
    calls = 0; NAV.onLine = false;
    const off = await M.food.suggest({ slot: "Lunch", remaining: rem });
    assert.deepStrictEqual([calls, off.aiError], [0, "You're offline, so there are no ideas from Claude."]);
    delete NAV.onLine;
    /* fixed notes, never raw API text */
    global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { type: "rate_limit_error", message: "raw words" } }) });
    assert.strictEqual((await M.food.suggest({ slot: "Lunch", remaining: rem })).aiError, "Claude is busy right now. Try again in a minute.");
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { type: "authentication_error", message: "raw words" } }) });
    assert.ok(/key is wrong/.test((await M.food.suggest({ slot: "Lunch", remaining: rem })).aiError), "a problem they must fix keeps its own message");
    let late = null;
    await M.food.suggest({ slot: "Lunch", remaining: rem, onClaude: (l, note) => { late = note; } });
    for (let i = 0; i < 50 && late === null; i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(/key is wrong/.test(late), "onClaude gets the note too: " + late);
  } finally { delete NAV.onLine; delete global.fetch; M.ai.setKey(""); }
});

/* ======================================================================= */
/* Nick's food rules (22:20–22:34): Kirkland chicken breast raw, and the three products they buy */
/* m-data (F7) adds the branded foods; until it does, test copies with the same words / flags
   stand in (found by words and flags, never by id). Removed again at the end. */
function namedFixtures() {
  const G = M.DB.generic, added = [];
  const has = re => G.find(f => re.test(f.name + " " + (f.brand || "")));
  const add = (re, f) => { const got = has(re); if (got) return got; const food = Object.assign({ barcode: "", source: "generic", staple: true, uses: 0, lastUsed: 0, createdAt: 0, updatedAt: 0, pid: null }, f); G.push(food); added.push(food); return food; };
  const hill = add(/hillshire/i, { id: "g_test_hillshire", name: "Turkey slices, oven roasted", brand: "Hillshire Farm", serving: { qty: 2, unit: "oz", g: 56 }, per: { cal: 50, p: 10, c: 1, f: 0.5, fiber: 0, sugar: 1, sodium: 470 }, per100g: { cal: 89, p: 17.9, c: 1.8, f: 0.9, fiber: 0, sugar: 1.8, sodium: 839 }, alts: [{ label: "1 slice", g: 9.3 }, { label: "100 g", g: 100 }] });
  const jam = add(/smucker/i, { id: "g_test_smuckers", name: "Strawberry fruit spread, natural", brand: "Smucker's", serving: { qty: 1, unit: "tbsp", g: 19 }, per: { cal: 50, p: 0, c: 13, f: 0, fiber: 0, sugar: 12, sodium: 0 }, per100g: { cal: 263, p: 0, c: 68.4, f: 0, fiber: 0, sugar: 63.2, sodium: 0 }, alts: [{ label: "100 g", g: 100 }] });
  const daisy = add(/daisy/i, { id: "g_test_daisy", name: "Cottage cheese, 2% low fat", brand: "Daisy", serving: { qty: 0.5, unit: "cup", g: 113 }, per: { cal: 90, p: 13, c: 5, f: 2.5, fiber: 0, sugar: 4, sodium: 390 }, per100g: { cal: 80, p: 11.5, c: 4.4, f: 2.2, fiber: 0, sugar: 3.5, sodium: 345 }, alts: [{ label: "1 cup", g: 226 }, { label: "100 g", g: 100 }] });
  return { hill, jam, daisy, done: () => added.forEach(f => { const i = G.indexOf(f); if (i >= 0) G.splice(i, 1); }) };
}
t("Nick's rules, describe (no Claude): chicken = the Kirkland breast, RAW, 175 g per breast; typed grams raw unless 'cooked'", async () => {
  M.reset(); M.ai.setKey("");
  const d = async s => { const r = await M.food.describe(s, { slot: "Dinner" }); assert.strictEqual(r.method, "local"); assert.deepStrictEqual(r.unmatched, [], s); assert.strictEqual(r.items.length, 1, s); return r.items[0]; };
  const G = M.DB.generic;
  const alias = M.DB.alias && M.DB.alias.g_chicken_breast;
  const breast = G.find(f => f.alwaysRaw === true && /chicken/i.test(f.name)) || (alias && G.find(f => f.id === alias.id)) || G.find(f => f.id === "g_kirkland_organic_chicken");
  assert.ok(breast && /chicken breast/i.test(breast.name) && /kirkland/i.test(breast.name + breast.brand), "one Kirkland breast food");
  const kcalG = breast.per100g.cal / 100;
  for (const s of ["chicken", "chicken breast", "grilled chicken", "a chicken breast", "1 breast"]) {
    const it = await d(s);
    assert.strictEqual(it.foodId, breast.id, s + " → " + it.name);
    near(it.g, 175, 1, s + ": one breast is 175 g raw");
    assert.ok(/breast/.test(it.servingLabel) && /175 g/.test(it.servingLabel), s + ": " + it.servingLabel);
    if (cookOf(breast.id)) assert.strictEqual(it.state, "raw", s);
    near(kcalOf(it), 175 * kcalG, 2, s);
  }
  let it = await d("2 chicken breasts");
  assert.strictEqual(it.foodId, breast.id);
  assert.strictEqual(it.servings, 2);
  near(it.g, 350, 1, "2 breasts (item g = the whole portion)");
  near(kcalOf(it), 350 * kcalG, 3, "2 breasts raw");
  it = await d("200 g chicken");
  assert.strictEqual(it.foodId, breast.id);
  near(it.g, 200, 1, "200 g");
  near(kcalOf(it), 200 * kcalG, 2, "200 g raw");
  if (cookOf(breast.id)) assert.strictEqual(it.state, "raw");
  it = await d("200 g cooked chicken breast");
  if (cookOf(breast.id)) { assert.strictEqual(it.state, "cooked"); near(kcalOf(it), 200 * kcalPerG(breast.id, "cooked"), 3, "200 g cooked"); }
  it = await d("200 g raw chicken");
  if (cookOf(breast.id)) assert.strictEqual(it.state, "raw");
  /* other chicken stays itself */
  assert.ok(/thigh/i.test((await d("chicken thigh")).name));
  /* their own saved chicken breast still wins, weighed raw */
  const mine = M.foods.add({ name: "Chicken breast", brand: "Kirkland Signature", source: "off", serving: { qty: 4, unit: "oz", g: 112 }, per: { cal: 110, p: 23, c: 0, f: 2, fiber: 0, sugar: 0, sodium: 65 }, per100g: { cal: 98, p: 20.5, c: 0, f: 1.8, fiber: 0, sugar: 0, sodium: 58 } });
  it = await d("200 g chicken breast");
  assert.strictEqual(it.foodId, mine.id);
  if (cookOf(breast.id)) assert.strictEqual(it.state, "raw");
  near(kcalOf(it), 196, 3, "their own label, raw");
  M.foods.remove(mine.id);
});
t("Nick's rules, describe (no Claude): turkey slices → Hillshire Farm, jam / jelly → Smucker's, cottage cheese → Daisy 2%", async () => {
  M.reset(); M.ai.setKey("");
  const fx = namedFixtures();
  try {
    const d = async s => { const r = await M.food.describe(s, { slot: "Lunch" }); assert.deepStrictEqual(r.unmatched, [], s); assert.strictEqual(r.items.length, 1, s); return r.items[0]; };
    for (const s of ["turkey slices", "turkey", "sliced turkey", "deli turkey", "lunch meat", "turkey breast slices", "Hillshire turkey"]) assert.strictEqual((await d(s)).foodId, fx.hill.id, s);
    let it = await d("4 slices turkey");
    assert.strictEqual(it.foodId, fx.hill.id);
    const slice = (fx.hill.alts || []).find(a => /^1 slice/.test(a.label));
    if (slice) { near(it.g, 4 * slice.g, 0.6, "4 slices"); assert.ok(it.servings === 4 && /^1 slice/.test(it.servingLabel), "4 × 1 slice: " + it.servings + " × " + it.servingLabel); }
    assert.deepStrictEqual(M.food.describeLocal("a turkey sandwich").unmatched, ["turkey sandwich"], "a sandwich is more than the slices");
    for (const s of ["ground turkey", "turkey bacon"]) assert.notStrictEqual((await d(s)).foodId, fx.hill.id, s + " is its own food");
    for (const s of ["jam", "jelly", "strawberry jam", "strawberry jelly", "1 tbsp jam", "Smucker's jam"]) assert.strictEqual((await d(s)).foodId, fx.jam.id, s);
    it = await d("2 tbsp jelly");
    assert.strictEqual(it.foodId, fx.jam.id);
    near(kcalOf(it), 2 * fx.jam.per.cal / (fx.jam.serving.qty || 1), 3, "2 tbsp");
    for (const s of ["cottage cheese", "1 cup cottage cheese", "2% cottage cheese", "daisy cottage cheese"]) assert.strictEqual((await d(s)).foodId, fx.daisy.id, s);
    /* a size that reads right: "1 cup" is 1 × 1 cup (not 2 × 1/2 cup) when the food has a 1 cup size */
    if ((fx.daisy.alts || []).some(a => /^1 cup\b/.test(a.label))) { it = await d("1 cup cottage cheese"); assert.ok(it.servings === 1 && /^1 cup/.test(it.servingLabel), it.servings + " × " + it.servingLabel); near(it.g, 226, 1); }
    it = await d("4% cottage cheese");
    if (M.DB.generic.some(f => /cottage cheese/i.test(f.name) && /4%/.test(f.name))) assert.notStrictEqual(it.foodId, fx.daisy.id, "they said 4%");
    assert.strictEqual(it.servings, 1, "'4%' is part of the name, not 4 servings");
    /* "peanut butter and jelly": the jelly is theirs */
    const pbj = await M.food.describe("peanut butter and jelly", {});
    assert.ok(pbj.items.some(x => x.foodId === fx.jam.id), "the jelly is theirs");
    /* their own saved turkey still wins */
    const mine = M.foods.add({ name: "Turkey slices", brand: "Kroger", source: "off", serving: { qty: 2, unit: "oz", g: 56 }, per: { cal: 60, p: 11, c: 1, f: 1, fiber: 0, sugar: 1, sodium: 500 } });
    assert.strictEqual((await d("turkey slices")).foodId, mine.id);
    M.foods.remove(mine.id);
  } finally { fx.done(); }
});
t("Nick's rules in every Claude prompt (photo, label, describe, name estimate, suggest): Kirkland chicken in raw grams, Daisy 2%, Smucker's, Hillshire; suggest lists staples and what they never eat", async () => {
  M.reset(); M.ai.setKey("sk-ant-test");
  const seen = {};
  let kind = "";
  global.fetch = async (u, o) => {
    const c = JSON.parse(o.body).messages[0].content;
    seen[kind] = (Array.isArray(c) ? c : [{ type: "text", text: c }]).filter(x => x.type === "text").map(x => x.text).join("\n");
    if (kind === "label") return claudeReply({ found: true, name: "Cottage cheese", brand: "Daisy", servingText: "1/2 cup (113g)", servingQty: 0.5, servingUnit: "cup", servingG: 113, basis: "serving", cal: 90, f: 2.5, sodium_mg: 390, c: 5, fiber: 0, sugar: 4, p: 13 });
    if (kind === "name") return claudeReply({ name: "Cottage cheese", brand: "Daisy", serving: { qty: 0.5, unit: "cup", g: 113 }, per: { cal: 90, p: 13, c: 5, f: 2.5, fiber: 0, sugar: 4, sodium_mg: 390 }, alts: [] });
    if (kind === "suggest") return claudeReply({ suggestions: [] });
    return claudeReply({ items: [{ name: "Chicken breast", servingLabel: "1 breast (175 g raw)", g: 175, per: { cal: 210, p: 39, c: 0, f: 4.6, fiber: 0, sugar: 0, sodium_mg: 79 } }], note: "Sure." });
  };
  const photo = { type: "image/jpeg", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  try {
    kind = "photo"; await M.food.photo.estimate(photo, { slot: "Dinner" });
    kind = "label"; await M.food.label.fromImage(photo);
    kind = "describe"; await M.food.describe("chicken and rice", { slot: "Dinner" });
    kind = "name"; await M.food.estimateByName("cottage cheese");
    kind = "suggest"; await M.food.suggest({ slot: "Dinner", remaining: { cal: 700, p: 50, c: 70, f: 25 } });
    for (const k of ["photo", "label", "describe", "name", "suggest"]) {
      const p = seen[k] || "";
      assert.ok(p, k + " asked Claude");
      assert.ok(/Kirkland organic chicken breast/i.test(p), k + ": Kirkland chicken");
      assert.ok(/175 g raw/i.test(p) && /raw/i.test(p), k + ": raw chicken grams, one breast ≈ 175 g");
      assert.ok(/Daisy 2% cottage cheese/.test(p) && /Smucker's Natural strawberry/.test(p) && /Hillshire Farm oven roasted turkey/.test(p), k + ": the three products");
    }
    const sp = seen.suggest;
    ["pork tenderloin", "Dave's Killer Bread", "cod", "shrimp", "scallops", "quinoa", "Greek yogurt 2%", "asparagus", "bell pepper", "cucumber", "corn on the cob", "agave"].forEach(w => assert.ok(sp.indexOf(w) >= 0, "staple listed: " + w));
    const never = /never eat:([^\n]*)/i.exec(sp);
    assert.ok(never, "the never-eat line");
    ["other cheese", "oats", "cereal", "shakes", "bars", "protein powder", "restaurant"].forEach(w => assert.ok(never[1].indexOf(w) >= 0, "never: " + w));
    assert.ok(!/cottage cheese too/i.test(sp) && /cottage cheese is fine/i.test(never[1]), "cottage cheese is NOT banned (Daisy 2% is theirs)");
    assert.ok(/agave, not honey/i.test(sp));
  } finally { delete global.fetch; M.ai.setKey(""); }
});

t("BEF-11 Open Food Facts entries with calories but no protein, carbs or fat: a plain warning on the lookup (not saved on the food); last in search", async () => {
  M.reset();
  const upc = b => b + M.food.gtin.check(b);
  const prod = (code, name, n) => ({ code, product_name: name, brands: "Kroger", serving_size: "1 cup (240 ml)", serving_quantity: 240, nutriments: n });
  const bad = prod("0111200000001", "Sparkling Juice", { "energy-kcal_100g": 45 });
  const ok = prod("0111200000002", "Orange Juice", { "energy-kcal_100g": 45, carbohydrates_100g: 10.4, proteins_100g: 0.7, fat_100g: 0.2 });
  const water = prod("0111200000003", "Seltzer water", { "energy-kcal_100g": 0, proteins_100g: 0, carbohydrates_100g: 0, fat_100g: 0 });
  assert.ok(/no protein, carbs or fat/.test(M.food.fromOFF(bad).warning || ""), "flagged");
  assert.strictEqual(M.food.fromOFF(ok).warning, undefined);
  assert.strictEqual(M.food.fromOFF(water).warning, undefined, "0 kcal water isn't flagged");
  const code = upc("01112000000");
  global.fetch = async url => (url.indexOf("/api/v2/product/") >= 0 ? reply({ code, product: Object.assign({}, bad, { code }), status: 1 }) : reply({ products: [bad, ok] }));
  try {
    const r = await M.food.lookup(code);
    assert.strictEqual(r.status, "found");
    assert.ok(/Check them against the label/.test(r.warning || ""), JSON.stringify(r.warning));
    assert.strictEqual(r.food.warning, undefined);
    assert.strictEqual(M.foods.get(r.food.id).warning, undefined, "the flag isn't saved on the food");
    const list = await M.food.searchOFF("juice");
    assert.deepStrictEqual(list.map(f => f.name), ["Orange Juice", "Sparkling Juice"]);
    assert.ok(list.every(f => f.warning === undefined));
  } finally { delete global.fetch; }
});

t("Nick's rules on Claude's answers: chicken breast and the named products take the app's own numbers for their grams (raw unless 'cooked'); other items stay as Claude gave them", async () => {
  M.reset(); M.ai.setKey("sk-ant-test");
  const fx = namedFixtures();
  const G = M.DB.generic;
  const breast = G.find(f => f.alwaysRaw === true && /chicken/i.test(f.name)) || G.find(f => f.id === "g_kirkland_organic_chicken");
  const P = (cal, p, c, f, na) => ({ cal, p, c, f, fiber: 0, sugar: 0, sodium_mg: na });
  const items = [
    { name: "Grilled chicken breast", servingLabel: "1 breast (175 g raw)", g: 175, per: P(300, 50, 0, 8, 150) },
    { name: "Chicken breast", servingLabel: "5 oz cooked (142 g)", g: 142, per: P(300, 50, 0, 8, 150) },
    { name: "Daisy 2% cottage cheese", servingLabel: "1 cup (226 g)", g: 226, per: P(250, 20, 10, 10, 900) },
    { name: "Smucker's Natural strawberry jam", servingLabel: "1 tbsp (19 g)", g: 19, per: P(60, 0, 15, 0, 5) },
    { name: "Hillshire Farm oven roasted turkey breast slices", servingLabel: "3 slices (28 g)", g: 28, per: P(40, 6, 1, 1, 300) },
    { name: "White rice", servingLabel: "1 cup (158 g)", g: 158, per: P(205, 4, 45, 0.4, 2) },
    { name: "Chicken breast", servingLabel: "1 serving", g: null, per: P(300, 50, 0, 8, 150) }
  ];
  global.fetch = async (u, o) => {
    const txt = JSON.stringify(JSON.parse(o.body).messages);
    if (/Suggest 3/.test(txt)) return claudeReply({ suggestions: [{ name: "Chicken and rice", desc: "d", store: "Costco", prepMin: 20, items: [items[0], items[5]] }] });
    return claudeReply({ items, note: "ok" });
  };
  try {
    const kc = (id, state) => kcalPerG(id, state);
    const check = (out, label) => {
      const [ch, ck, cc, jam, tur, rice, nog] = out;
      assert.strictEqual(ch.foodId, breast.id, label + ": chicken → the Kirkland breast");
      near(ch.per.cal, 175 * kc(breast.id, "raw"), 1.5, label + ": raw numbers");
      if (cookOf(breast.id)) { assert.strictEqual(ch.state, "raw"); assert.strictEqual(ch.cook.word, "raw"); }
      assert.strictEqual(ch.servingLabel, "1 breast (175 g raw)");
      if (cookOf(breast.id)) { assert.strictEqual(ck.state, "cooked"); near(ck.per.cal, 142 * kc(breast.id, "cooked"), 1.5, label + ": 'cooked' said"); }
      assert.strictEqual(cc.foodId, fx.daisy.id); near(cc.per.cal, 226 * fx.daisy.per100g.cal / 100, 1.5, label + ": Daisy's numbers");
      assert.strictEqual(jam.foodId, fx.jam.id); near(jam.per.cal, 19 * fx.jam.per100g.cal / 100, 1, label + ": Smucker's numbers");
      assert.strictEqual(tur.foodId, fx.hill.id); near(tur.per.cal, 28 * fx.hill.per100g.cal / 100, 1, label + ": Hillshire's numbers");
      assert.strictEqual(rice.per.cal, 205, label + ": other foods stay as Claude gave them"); assert.strictEqual(rice.foodId, undefined);
      assert.strictEqual(nog.per.cal, 300, label + ": no grams → left alone");
    };
    check((await M.food.photo.estimate({ type: "image/jpeg", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }, {})).items, "photo");
    const dsc = await M.food.describe("a chicken breast, rice and some other stuff I made", {});
    assert.strictEqual(dsc.method, "ai");
    check(dsc.items, "describe");
    const sug = (await M.food.suggest({ slot: "Dinner", remaining: { cal: 800, p: 60, c: 80, f: 25 } })).filter(s => s.source === "claude");
    assert.strictEqual(sug.length, 1);
    assert.strictEqual(sug[0].items[0].foodId, breast.id);
    near(sug[0].per.cal, Math.round(175 * kc(breast.id, "raw")) + 205, 2, "the idea's total uses the Kirkland numbers");
  } finally { fx.done(); delete global.fetch; M.ai.setKey(""); }
});

/* Nick: "Shrimp, cod and scallops are all Kirkland Signature as well" / "We buy the frozen versions"
   (cooked tail-on shrimp; wild Alaska Pacific cod; wild sea scallops) */
t("Kirkland seafood: describe (no Claude) counts shrimp, fillets and scallops by the bag's own pieces", () => {
  M.reset();
  const G = M.DB.generic, sh = G.find(f => f.id === "g_kirkland_cooked_shrimp"), cod = G.find(f => f.id === "g_cod"), sc = G.find(f => f.id === "g_scallops");
  if (!sh || !cod || cod.brand !== "Kirkland" || !sc) { console.log("       (skipped: no Kirkland seafood in m-data)"); return; }
  const tot = it => it.per.cal * it.servings;
  for (const [s, n] of [["12 shrimp", 12], ["10 jumbo shrimp", 10], ["12 prawns", 12], ["10 cooked shrimp", 10]]) {
    const it = r4one(s);
    assert.strictEqual(it.foodId, sh.id, s); assert.strictEqual(it.servings, n, s); assert.ok(/^1 shrimp\b/.test(it.servingLabel), s + ": " + it.servingLabel);
    near(it.g, 10.5 * n, 0.05, s + " grams"); near(tot(it), 80 * n / 8, 0.5, s + " cal"); assert.ok(!it.state && !it.cook, s + ": sold cooked, no raw / cooked");
  }
  near(tot(r4one("shrimp")), 80, 0.5, "plain shrimp = the label serving (8 shrimp)");
  const f1 = r4one("1 cod fillet");
  assert.strictEqual(f1.foodId, cod.id); assert.strictEqual(f1.state, "raw"); near(f1.g, 170, 0.05); near(tot(f1), 120, 0.5, "1 fillet = 120 cal");
  const bk = r4one("baked cod");
  assert.strictEqual(bk.state, "cooked"); near(tot(bk), 120, 0.6, "a baked fillet is the same fillet: 120 cal");
  near(tot(r4one("2 cod fillets")), 240, 1);
  const s6 = r4one("6 scallops");
  assert.strictEqual(s6.foodId, sc.id); assert.strictEqual(s6.servings, 6, "6 × 1 scallop: " + s6.servingLabel); assert.strictEqual(s6.state, "raw");
  near(s6.g, 169.5, 0.1, "6 scallops = 169.5 g raw"); near(tot(s6), 150, 0.6, "6 scallops = 150 cal");
  near(tot(r4one("6 seared scallops")), 150, 1, "seared: the same 6 scallops");
  near(tot(r4one("scallops")), 100, 0.5, "plain scallops = the label serving (4 scallops)");
  /* no count said, cooked: the label's 4 scallops cooked (a count doesn't change with cooking), not 1 */
  for (const s of ["seared scallops", "grilled scallops", "cooked scallops", "pan seared scallops"]) { const it = r4one(s); assert.strictEqual(it.state, "cooked", s); near(tot(it), 100, 0.6, s); }
  /* one bag, one size: "large" doesn't make more of them */
  near(tot(r4one("12 large shrimp")), 120, 0.5, "12 large shrimp = 12 of the bag's shrimp");
  near(tot(r4one("2 large scallops")), 50, 0.5); near(tot(r4one("1 large cod fillet")), 120, 0.5);
  near(tot(r4one("large shrimp")), 80, 0.5, "no count: the bag's serving, like plain 'shrimp'");
});
t("Kirkland seafood: Claude's shrimp, cod and scallops take the bag's numbers for their grams; dishes stay as Claude gave them; every prompt names them", async () => {
  M.reset(); M.ai.setKey("sk-ant-test");
  const G = M.DB.generic, sh = G.find(f => f.id === "g_kirkland_cooked_shrimp"), cod = G.find(f => f.id === "g_cod"), sc = G.find(f => f.id === "g_scallops");
  if (!sh || !cod || cod.brand !== "Kirkland" || !sc) { console.log("       (skipped: no Kirkland seafood in m-data)"); M.ai.setKey(""); return; }
  const P = (cal, p, c, f, na) => ({ cal, p, c, f, fiber: 0, sugar: 0, sodium_mg: na });
  const items = [
    { name: "Shrimp", servingLabel: "12 shrimp (126 g)", g: 126, per: P(150, 28, 1, 2, 400) },
    { name: "Baked cod fillet", servingLabel: "1 fillet (132 g)", g: 132, per: P(140, 30, 0, 1, 100) },
    { name: "Raw sea scallops", servingLabel: "6 scallops (170 g)", g: 170, per: P(120, 20, 5, 1, 600) },
    { name: "Shrimp scampi", servingLabel: "1 cup (200 g)", g: 200, per: P(420, 30, 8, 30, 900) }
  ];
  const seen = [];
  global.fetch = async (u, o) => { seen.push(JSON.stringify(JSON.parse(o.body))); return claudeReply({ items, note: "ok" }); };
  try {
    const d = await M.food.describe("shrimp, a baked cod fillet, raw scallops and shrimp scampi from a restaurant", {});
    assert.strictEqual(d.method, "ai");
    const [s, c, q, sp] = d.items;
    assert.strictEqual(s.foodId, sh.id); near(s.per.cal, 120, 0.5, "126 g of the Kirkland cooked shrimp = 120 cal"); assert.ok(!s.state, "no raw / cooked");
    assert.strictEqual(c.foodId, cod.id); assert.strictEqual(c.state, "cooked"); near(c.per.cal, 132 * cod.cook.per100gCooked.cal / 100, 0.5, "cooked cod grams use the cooked profile");
    assert.strictEqual(q.foodId, sc.id); assert.strictEqual(q.state, "raw"); near(q.per.cal, 170 * sc.per100g.cal / 100, 0.5, "raw scallop grams use the label");
    assert.strictEqual(sp.per.cal, 420, "a dish stays as Claude gave it"); assert.strictEqual(sp.foodId, undefined);
    /* fish said without raw or cooked is raw (like Describe without Claude); counts with no grams use the bag's pieces */
    items.length = 0;
    items.push({ name: "Cod fillet", servingLabel: "1 fillet (170 g)", g: 170, per: P(139, 30, 0, 1, 90) },
      { name: "Wild-caught Alaska Pacific cod", servingLabel: "6 oz (170 g)", g: 170, per: P(139, 30, 0, 1, 90) },
      { name: "Kirkland shrimp", servingLabel: "12 shrimp", g: null, per: P(150, 28, 1, 2, 400) },
      { name: "Sea scallops", servingLabel: "6 scallops", g: null, per: P(120, 20, 5, 1, 600) },
      { name: "Cooked shrimp", servingLabel: "12 cooked shrimp", g: null, per: P(150, 28, 1, 2, 400) },
      { name: "Shrimp", servingLabel: "6 oz shrimp", g: null, per: P(170, 36, 1, 2, 400) },
      { name: "Scallops", servingLabel: "1 cup scallops", g: null, per: P(130, 24, 6, 1, 600) });
    const d2 = (await M.food.describe("a cod fillet, some wild caught pacific cod, 12 kirkland shrimp and 6 sea scallops", {})).items;
    assert.strictEqual(d2[4].foodId, sh.id); near(d2[4].per.cal, 120, 0.5, "12 cooked shrimp: a count is a count");
    assert.ok(d2[5].foodId === undefined && d2[5].per.cal === 170 && d2[6].foodId === undefined && d2[6].per.cal === 130, "a weight or a cup with no grams is not a count of pieces: left as Claude gave it");
    assert.strictEqual(d2[0].state, "raw"); near(d2[0].per.cal, 120, 0.5, "1 cod fillet, no raw / cooked said = the raw fillet");
    assert.strictEqual(d2[1].foodId, cod.id); near(d2[1].per.cal, 120, 0.5, "wild-caught Pacific cod is their cod");
    assert.strictEqual(d2[2].foodId, sh.id); near(d2[2].g, 126, 0.05); near(d2[2].per.cal, 120, 0.5, "12 shrimp = 12 × 10.5 g");
    assert.strictEqual(d2[3].foodId, sc.id); assert.strictEqual(d2[3].state, "raw"); near(d2[3].g, 169.5, 0.1); near(d2[3].per.cal, 150, 0.6, "6 scallops = 6 × 28.25 g raw");
    const p = seen.join(" ");
    assert.ok(/Kirkland Signature frozen/.test(p) && /8 shrimp \(84 g\) = 80 cal/.test(p) && /1 cod fillet = 170 g raw/.test(p) && /4 scallops = 113 g raw/.test(p), "the prompt has the bags' numbers");
  } finally { delete global.fetch; M.ai.setKey(""); }
});

t("C4 describe (no Claude): '10 shrimp' is 10 shrimp (not 10 × 4 oz); amounts after the food with raw/dry/cooked; ears of corn and fish fillets", () => {
  M.reset();
  const G = M.DB.generic;
  const one = s => { const r = M.food.describeLocal(s); assert.strictEqual(r.unmatched.length, 0, s + " unmatched"); assert.strictEqual(r.items.length, 1, s); return r.items[0]; };
  const shrimp = G.find(f => f.id === "g_shrimp");
  if (shrimp && (shrimp.alts || []).some(a => /large shrimp/i.test(a.label))) {
    const s10 = one("10 shrimp");
    assert.strictEqual(s10.foodId, "g_shrimp");
    assert.ok(/large shrimp/.test(s10.servingLabel), "a count uses the per-shrimp size: " + s10.servingLabel);
    assert.strictEqual(s10.servings, 10);
    assert.ok(s10.g > 80 && s10.g < 250, "10 shrimp weigh about 150 g, got " + s10.g);
    /* decision 1: shrimp are raw unless they say cooked */
    assert.strictEqual(s10.state, "raw");
    const c10 = one("10 cooked shrimp");
    assert.strictEqual(c10.state, "cooked"); assert.ok(c10.g < s10.g, "cooked shrimp weigh less than raw");
  }
  const qn = G.find(f => f.id === "g_quinoa");
  if (qn && qn.cook) {
    for (const s of ["quinoa 1/4 cup dry", "1/4 cup dry quinoa"]) {
      const it = one(s);
      assert.strictEqual(it.foodId, "g_quinoa", s); assert.strictEqual(it.state, "raw", s); assert.strictEqual(it.cook.word, "dry", s);
      near(it.g, 42.5, 1, s);
    }
    assert.strictEqual(one("quinoa 1 cup cooked").state, "cooked");
  }
  const ch = one("chicken 200g raw");
  assert.ok(/chicken breast/i.test(ch.name)); assert.strictEqual(ch.g, 200); if (ch.cook) assert.strictEqual(ch.state, "raw");
  const ck = one("chicken breast 200 g cooked");
  assert.strictEqual(ck.g, 200); if (ck.cook) assert.strictEqual(ck.state, "cooked");
  const corn = G.find(f => f.id === "g_corn");
  if (corn) {
    const c1 = one("1 ear corn"); assert.strictEqual(c1.foodId, "g_corn"); assert.strictEqual(c1.servings, 1); near(c1.g, corn.serving.g, 0.5);
    const c2 = one("2 ears of corn"); assert.strictEqual(c2.foodId, "g_corn"); near(c2.g, 2 * corn.serving.g, 0.5);
    assert.strictEqual(one("1 large ear of corn").foodId, "g_corn");
  }
  if (G.find(f => f.id === "g_cod")) { assert.strictEqual(one("1 cod fillet").foodId, "g_cod"); assert.strictEqual(one("a fillet of cod").foodId, "g_cod"); }
  /* how it was made isn't the food: "toasted" bread, a lemon "juiced" */
  const toasted = one("2 slices of daves killer bread toasted");
  assert.ok(/dave/i.test(toasted.brand + " " + toasted.name), "Dave's bread: " + toasted.name); assert.strictEqual(toasted.servings, 2);
  const lj = G.find(f => f.id === "g_lemon_juice");
  if (lj) { const it = one("1 lemon juiced"); assert.strictEqual(it.foodId, "g_lemon_juice"); assert.strictEqual(it.servings, 1); }
  /* "2x chicken breast" is two breasts */
  const two = one("2x chicken breast");
  assert.ok(/chicken breast/i.test(two.name)); near(two.g, 2 * ch.g / 200 * 175, 1, "2x = two breasts");
  /* "2 turkey slices" on a "6 slices" serving → 2 × 1 slice (the stepper counts slices, not 0.33 servings) */
  const tk = G.find(f => f.id === "g_deli_turkey");
  if (tk && (tk.alts || []).some(a => /^1 slice\b/.test(a.label)) && tk.serving && tk.serving.qty > 1) {
    const it = one("2 turkey slices");
    assert.strictEqual(it.servings, 2); assert.ok(/^1 slice\b/.test(it.servingLabel), it.servingLabel);
    near(it.g, 2 * tk.alts.find(a => /^1 slice\b/.test(a.label)).g, 0.2);
  }
});

t("C4 Claude's chicken breast with a count but no grams ('2 breasts') gets 175 g raw per breast; '1 serving' stays as Claude gave it", async () => {
  M.reset(); M.ai.setKey("sk-ant-test");
  const P = cal => ({ cal, p: 50, c: 0, f: 6, fiber: 0, sugar: 0, sodium_mg: 100 });
  global.fetch = async () => claudeReply({ items: [
    { name: "Chicken breast", servingLabel: "2 breasts", g: null, per: P(600) },
    { name: "Chicken breast", servingLabel: "½ breast", per: P(150) },
    { name: "Chicken breast", servingLabel: "1 serving", per: P(300) },
    { name: "Chicken thigh", servingLabel: "2 thighs", per: P(300) }
  ] });
  try {
    const out = await M.food.describe("chicken and more", {});
    assert.strictEqual(out.method, "ai");
    const [two, half, srv, thigh] = out.items;
    const breast = M.DB.generic.find(f => f.alwaysRaw === true && /chicken/i.test(f.name)) || M.DB.generic.find(f => f.id === "g_kirkland_organic_chicken");
    const one = (breast.serving && /breast/.test(breast.serving.unit)) ? breast.serving.g : 175;
    assert.strictEqual(two.foodId, breast.id); near(two.g, 2 * one, 0.5); assert.strictEqual(two.servings, 1);
    near(two.per.cal, 2 * one * breast.per100g.cal / 100, 1.5, "raw Kirkland numbers, counted once");
    if (breast.cook) assert.strictEqual(two.state, "raw");
    assert.strictEqual(half.foodId, breast.id); near(half.g, one / 2, 0.5);
    assert.strictEqual(srv.foodId, undefined); assert.strictEqual(srv.per.cal, 300);
    assert.strictEqual(thigh.foodId, undefined); assert.strictEqual(thigh.per.cal, 300);
  } finally { delete global.fetch; M.ai.setKey(""); }
});

/* ======================================================================= */
/* Fixer round 4 (F4): describe amounts, raw / cooked, missing words, two foods, PB&J, codes */
const r4one = s => { const r = M.food.describeLocal(s); assert.deepStrictEqual(r.unmatched, [], s + " unmatched"); assert.strictEqual(r.items.length, 1, s + " → " + r.items.map(i => i.name).join(" + ")); return r.items[0]; };
const r4g = it => it.g;   /* a describe item's g is the grams of the whole portion */
t("DA-01 a size word the food's own portion already has isn't applied again ('1 large egg' is 1 egg); sizes scale only when no sized portion exists", () => {
  M.reset();
  const egg = M.DB.generic.find(f => f.id === "g_egg_large");
  if (egg && /large/i.test(egg.serving.unit)) {
    let it = r4one("1 large egg");
    assert.strictEqual(it.foodId, egg.id); assert.strictEqual(it.servings, 1, "1 large egg is one egg"); near(r4g(it), egg.serving.g, 0.5);
    it = r4one("2 large eggs");
    assert.strictEqual(it.servings, 2); near(r4g(it), 2 * egg.serving.g, 0.5);
    it = r4one("3 large eggs"); near(r4g(it), 3 * egg.serving.g, 0.5);
  }
  const ban = M.DB.generic.find(f => f.id === "g_banana");
  if (ban && (ban.alts || []).some(a => /^1 large\b/.test(a.label))) { const it = r4one("1 large banana"); near(r4g(it), ban.alts.find(a => /^1 large\b/.test(a.label)).g, 0.5, "the banana's own large size"); }
  const cu = M.DB.generic.find(f => f.id === "g_cucumber");
  const whole = cu && (cu.alts || []).find(a => /^1 cucumber\b/.test(a.label));
  if (whole) { const it = r4one("1 small cucumber"); near(r4g(it), 0.75 * whole.g, 1, "¾ of a whole cucumber, not ¾ cup"); }
});
t("DA-02 raw / cooked twins: the state they typed wins; plain vegetables default to raw; '10 baby carrots' is 10 baby carrots", () => {
  M.reset();
  const G = M.DB.generic, has = id => G.some(f => f.id === id);
  if (has("g_broccoli_raw") && has("g_broccoli_cooked")) {
    for (const s of ["raw broccoli", "1 cup raw broccoli", "broccoli", "1 cup broccoli"]) assert.strictEqual(r4one(s).foodId, "g_broccoli_raw", s);
    for (const s of ["cooked broccoli", "roasted broccoli", "1 cup steamed broccoli"]) assert.strictEqual(r4one(s).foodId, "g_broccoli_cooked", s);
  }
  if (has("g_zucchini_raw") && has("g_zucchini")) { assert.strictEqual(r4one("1 zucchini").foodId, "g_zucchini_raw"); assert.strictEqual(r4one("grilled zucchini").foodId, "g_zucchini"); }
  if (has("g_carrots")) {
    const it = r4one("10 baby carrots");
    assert.ok(/carrot/i.test(it.name) && !/cooked/i.test(it.name), it.name);
    near(r4g(it), 100, 15, "10 baby carrots ≈ 100 g");
    assert.ok(kcalOf(it) < 60, "10 baby carrots are ~35 cal, got " + kcalOf(it));
    assert.ok(!/cooked/i.test(r4one("2 carrots").name));
  }
});
t("DA-03 a whole item is the item, not a cup: '1 cucumber', '½ cucumber'; asparagus spears (DA-05)", () => {
  M.reset();
  const cu = M.DB.generic.find(f => f.id === "g_cucumber");
  const whole = cu && (cu.alts || []).find(a => /^1 cucumber\b/.test(a.label));
  if (whole) {
    let it = r4one("1 cucumber");
    near(r4g(it), whole.g, 0.5, "one whole cucumber"); near(kcalOf(it), whole.g * cu.per100g.cal / 100, 1.5);
    it = r4one("½ cucumber"); near(r4g(it), whole.g / 2, 2, "half a cucumber");
    it = r4one("half a cucumber"); near(r4g(it), whole.g / 2, 2);
  }
  const as = M.DB.generic.find(f => f.id === "g_asparagus");
  if (as && /spear/.test(as.serving.unit)) {
    const per = as.serving.g / as.serving.qty;
    for (const [s, n] of [["6 asparagus spears", 6], ["3 asparagus spears", 3], ["6 spears asparagus", 6], ["4 spears of asparagus", 4]]) { const it = r4one(s); assert.strictEqual(it.foodId, as.id, s); near(r4g(it), n * per, 0.6, s); }
  }
  assert.deepStrictEqual(M.food.parseQuantity("6 asparagus spears"), { qty: 6, unit: "spear", words: "asparagus", raw: "6 asparagus spears", explicitQty: true });
  assert.strictEqual(M.food.parseQuantity("1 cup broccoli florets").words, "broccoli");
  assert.strictEqual(M.food.parseQuantity("3 chicken strips").unit, null, "chicken strips aren't breasts");
});
t("decision 1: typed meat and fish are raw weights unless they say cooked; rice stays cooked unless dry", () => {
  M.reset();
  for (const s of ["4 oz cod", "8 oz shrimp", "scallops", "6 oz pork tenderloin"]) { const it = r4one(s); if (it.cook) assert.strictEqual(it.state, "raw", s); }
  for (const s of ["4 oz cooked cod", "8 oz grilled shrimp", "6 oz baked pork tenderloin"]) { const it = r4one(s); if (it.cook) assert.strictEqual(it.state, "cooked", s); }
  const rice = r4one("1 cup rice"); if (rice.cook) assert.strictEqual(rice.state, "cooked");
  assert.strictEqual(r4one("3/4 cup cooked rice").foodId, rice.foodId, "cooked rice is the rice that has raw and cooked, not brown rice");
  const dry = r4one("1/4 cup dry quinoa"); if (dry.cook) assert.strictEqual(dry.state, "raw");
  const ch = r4one("200 g chicken"); if (ch.cook) assert.strictEqual(ch.state, "raw");
  const gc = r4one("2 grilled chicken breasts"); if (gc.cook) assert.strictEqual(gc.state, "raw", "Nick: chicken breast is always raw grams");
});
t("SC-04 a word they said that isn't in the food means it's not that food: string / cheddar / feta cheese, whipped cream; 'cream' is cream, not sour cream", () => {
  M.reset();
  for (const s of ["string cheese", "cheddar cheese", "feta cheese", "whipped cream", "2 cheese sticks"]) assert.deepStrictEqual(M.food.describeLocal(s).unmatched, [s], s);
  const c = r4one("cream"); assert.ok(!/sour/i.test(c.name), "cream → " + c.name);
  assert.ok(/sour/i.test(r4one("sour cream").name));
  assert.ok(!/peanut/i.test((M.food.describeLocal("butter").items[0] || { name: "" }).name), "butter isn't peanut butter");
  const r = M.food.describeLocal("coffee with cream");
  assert.strictEqual(r.items.length, 2); assert.ok(!r.items.some(i => /sour/i.test(i.name)));
  /* colors, sizes and "baby" may be missing; a food's search words count */
  assert.ok(/bell pepper/i.test(r4one("1 red bell pepper").name));
  const jam = M.DB.generic.find(f => f.words && /preserves/.test(f.words));
  if (jam) assert.strictEqual(r4one("1 tbsp preserves").foodId, jam.id);
  assert.deepStrictEqual(M.food.describeLocal("a turkey sandwich").unmatched, ["turkey sandwich"], "search words don't make a sandwich");
});
t("SC-05 two foods said together are both logged; a word that makes it another food isn't split off; unknown dishes stay unmatched", () => {
  M.reset();
  const names = s => M.food.describeLocal(s).items.map(i => i.name);
  let n = names("chicken rice"); assert.strictEqual(n.length, 2); assert.ok(/chicken breast/i.test(n[0]) && /rice/i.test(n[1]), n.join(" + "));
  n = names("avocado toast"); assert.ok(n.length === 2 && /avocado/i.test(n[0]) && /bread/i.test(n[1]), n.join(" + "));
  n = names("egg toast"); assert.ok(n.length === 2 && /^egg/i.test(n[0]) && /bread/i.test(n[1]), n.join(" + "));
  const bowl = M.food.describeLocal("burrito bowl with chicken rice and beans");
  assert.ok(bowl.items.some(i => /chicken breast/i.test(i.name)) && bowl.items.some(i => /rice/i.test(i.name)) && bowl.items.some(i => /beans/i.test(i.name)), bowl.items.map(i => i.name).join(" + "));
  assert.deepStrictEqual(bowl.unmatched, ["burrito bowl"]);
  const bagel = M.food.describeLocal("cream cheese on a bagel");
  assert.deepStrictEqual(bagel.items.map(i => i.name), [M.DB.generic.find(f => f.id === "g_bagel_plain").name]);
  assert.deepStrictEqual(bagel.unmatched, ["cream cheese"], "cream cheese isn't cream + cheese");
  assert.ok(/corn on the cob/i.test(r4one("corn on the cob").name), "'on the cob' isn't a split");
  assert.ok(/rice/i.test(r4one("rice on the side").name));
  assert.deepStrictEqual(M.food.describeLocal("teriyaki chicken").unmatched, ["teriyaki chicken"]);
  assert.deepStrictEqual(M.food.describeLocal("chicken salad").unmatched, ["chicken salad"], "a dish isn't split into its parts");
});
t("SC-06 PB&J in any spelling is 2 slices of bread + 2 tbsp peanut butter + 1 tbsp jam; 'half and half' stays one food", () => {
  M.reset();
  const pb = M.DB.generic.find(f => f.id === "g_peanut_butter");
  for (const s of ["PB&J", "pb and j", "pbj sandwich", "peanut butter jelly", "peanut butter and jelly sandwich", "a pb&j", "pb & j"]) {
    const r = M.food.describeLocal(s);
    assert.deepStrictEqual(r.unmatched, [], s);
    assert.strictEqual(r.items.length, 3, s + " → " + r.items.map(i => i.name).join(" + "));
    const [bread, butter, jam] = r.items;
    assert.ok(/bread/i.test(bread.name), s); near(r4g(bread), 2 * M.DB.generic.find(f => f.id === bread.foodId).serving.g, 0.5, s + " bread");
    assert.strictEqual(butter.foodId, pb.id, s); near(r4g(butter), 32, 0.5, s + " 2 tbsp");
    assert.ok(/jam|jelly/i.test(jam.name), s); assert.ok(r4g(jam) > 10 && r4g(jam) < 25, s + " 1 tbsp jam");
  }
  const two = M.food.describeLocal("2 pb&j");
  near(r4g(two.items[1]), 64, 0.5, "2 sandwiches → 4 tbsp");
  const js = M.food.describeLocal("jelly sandwich");
  assert.strictEqual(js.items.length, 2); assert.ok(!js.items.some(i => /peanut/i.test(i.name)));
  const hh = M.food.describeLocal("coffee with half and half");
  assert.deepStrictEqual(hh.unmatched, []); assert.strictEqual(hh.items.length, 2);
  assert.ok(/^half and half/i.test(hh.items[1].name), hh.items[1].name);
  assert.deepStrictEqual(M.food.describeLocal("2 tbsp half and half").items.map(i => i.servingLabel.replace(/ \(.*/, "") + "|" + i.servings), ["2 tbsp|1"]);
});
t("SC-03 Claude's chicken weight: a photo is cooked unless Claude says raw; describe goes by raw / cooked words, else calories per gram", async () => {
  M.reset(); M.ai.setKey("sk-ant-test");
  const breast = M.DB.generic.find(f => f.alwaysRaw === true && /chicken/i.test(f.name));
  const ck = breast && M.cook && M.cook.of ? M.cook.of(breast) : null;
  if (!breast || !ck || !ck.per100gCooked) { M.ai.setKey(""); return; }
  const P = cal => ({ cal, p: 50, c: 0, f: 6, fiber: 0, sugar: 0, sodium_mg: 120 });
  let items = [];
  global.fetch = async () => claudeReply({ items });
  try {
    const file = { type: "image/jpeg", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    items = [{ name: "Chicken breast", servingLabel: "6 oz (170 g)", g: 170, per: P(280) }, { name: "Chicken breast", servingLabel: "6 oz (170 g raw)", g: 170, per: P(190) }];
    let out = await M.food.photo.estimate(file, {});
    assert.strictEqual(out.items[0].state, "cooked", "a photo shows cooked chicken");
    near(out.items[0].per.cal, 170 * ck.per100gCooked.cal / 100, 1.5, "cooked Kirkland numbers");
    assert.strictEqual(out.items[1].state, "raw", "Claude said raw");
    items = [{ name: "Grilled chicken breast", servingLabel: "6 oz (170 g)", g: 170, per: P(280) }, { name: "Chicken breast", servingLabel: "6 oz (170 g)", g: 170, per: P(280) }, { name: "Chicken breast", servingLabel: "6 oz (170 g)", g: 170, per: P(190) }, { name: "Chicken breast", servingLabel: "1 breast", g: null, per: P(300) }];
    out = await M.food.describe("chicken", {});
    assert.strictEqual(out.method, "ai");
    assert.deepStrictEqual(out.items.map(i => i.state), ["cooked", "cooked", "raw", "raw"], "grilled → cooked; 1.65 cal/g → cooked; 1.1 cal/g → raw; a breast count is raw");
  } finally { delete global.fetch; M.ai.setKey(""); }
});
t("K3 lookup: built-in foods' package codes (UPC-A or EAN-13) and linked codes are found before going online, offline too", async () => {
  const byCode = M.foods.byCode;
  for (const withCore of [true, false]) {
  if (!withCore) delete M.foods.byCode;              /* before m-core has M.foods.byCode */
  try { await k3Case(); } finally { if (byCode) M.foods.byCode = byCode; }
  }
});
async function k3Case() {
  M.reset();
  const g = M.DB.generic.find(f => f.id === "g_cottage_cheese_2") || M.DB.generic[0];
  const had = g.barcodes;
  let asked = 0;
  global.fetch = async () => { asked++; return reply({ status: 0 }); };
  try {
    g.barcodes = ["073420516208"];
    for (const code of ["073420516208", "0073420516208"]) {
      const r = await M.food.lookup(code);
      assert.strictEqual(r.status, "found", code); assert.strictEqual(r.food.id, g.id); assert.strictEqual(r.saved, true); assert.strictEqual(r.builtIn, true);
    }
    NAV.onLine = false;
    assert.strictEqual((await M.food.lookup("073420516208")).food.id, g.id, "works offline");
    NAV.onLine = true;
    assert.strictEqual(asked, 0, "Open Food Facts never asked");
    /* a code they linked to a food ("Pick one of my foods") */
    const other = M.DB.generic.find(f => f.id === "g_banana");
    M.MS.codes = { "0012345678905": other.id };
    const r = await M.food.lookup("012345678905");
    assert.strictEqual(r.status, "found"); assert.strictEqual(r.food.id, other.id);
    assert.strictEqual(asked, 0);
    /* their own saved food with the code still comes first */
    const mine = M.foods.add({ name: "Cottage cheese", brand: "Daisy", source: "off", barcode: "073420516208", serving: { qty: 0.5, unit: "cup", g: 113 }, per: { cal: 90, p: 13, c: 5, f: 2.5, fiber: 0, sugar: 4, sodium: 390 } });
    assert.strictEqual((await M.food.lookup("073420516208")).food.id, mine.id);
  } finally { if (had === undefined) delete g.barcodes; else g.barcodes = had; delete M.MS.codes; NAV.onLine = true; delete global.fetch; M.reset(); }
}
t("OF-01 offline barcode lookup: code 'offline' with the barcode, plain words, Open Food Facts not tried; scanner offline text", async () => {
  M.reset();
  let asked = 0;
  global.fetch = async () => { asked++; return reply({ status: 0 }); };
  NAV.onLine = false;
  try {
    await M.food.lookup("049000028904").then(() => assert.fail("should reject"), e => {
      assert.strictEqual(e.code, "offline");
      assert.strictEqual(e.message, "No internet, so this barcode can't be looked up. Add it by hand now.");
      assert.strictEqual(e.detail && e.detail.barcode, "049000028904");
    });
    assert.strictEqual(asked, 0);
  } finally { NAV.onLine = true; delete global.fetch; }
  assert.ok(/needs internet the first time\. Add the food by hand for now\./.test(SRC("m-food.js")), "scanner load text offline");
});

t("OF-03 label reader loaded before on this phone (cached) or offline: 'Starting the label reader…', no download talk", async () => {
  M.ai.setKey("");
  const realPrep = M.img.prepOCR;
  M.img.prepOCR = async () => ({ canvas: {}, blob: {}, width: 10, height: 10 });
  try {
    M.food.label.release();
    localStorage.setItem("chalk.ocr.loaded", "1");
    global.Tesseract = fakeTess(LABEL_TXT);
    const said = [];
    const r = await M.food.label.fromImage({ type: "image/jpeg", size: 10 }, { onProgress: m => said.push(m) });
    assert.strictEqual(r.food.per.cal, 190);
    assert.ok(said.includes("Starting the label reader…"), said.join(" | "));
    assert.ok(!said.some(m => /Downloading/.test(m)), said.join(" | "));
    M.food.label.release();
    localStorage.removeItem("chalk.ocr.loaded");
    await M.food.label.fromImage({ type: "image/jpeg", size: 10 });
    assert.strictEqual(localStorage.getItem("chalk.ocr.loaded"), "1", "remembered after the first load");
  } finally { M.food.label.release(); M.img.prepOCR = realPrep; delete global.Tesseract; }
});
t("SC-08 shouting words in a normal name read like the rest; BBQ / USDA stay; SC-11 no '1 package' smaller than a serving", () => {
  const f = M.food.fromOFF({ code: "0000000000017", product_name: "Organic GREEK YOGURT plain", brands: "KIRKLAND Signature", serving_size: "170 g", serving_quantity: 170, nutriments: { "energy-kcal_100g": 73, proteins_100g: 10, carbohydrates_100g: 4, fat_100g: 2 } });
  assert.strictEqual(f.name, "Organic Greek Yogurt plain");
  assert.strictEqual(f.brand, "Kirkland Signature");
  const b = M.food.fromOFF({ code: "0000000000024", product_name: "Sweet BBQ sauce USDA organic", brands: "Stubb's", serving_size: "2 tbsp (36 g)", serving_quantity: 36, nutriments: { "energy-kcal_100g": 150, proteins_100g: 0, carbohydrates_100g: 36, fat_100g: 0 } });
  assert.strictEqual(b.name, "Sweet BBQ sauce USDA organic");
  const can = M.food.fromOFF({ code: "0000000000031", product_name: "Sparkling water", brands: "Brand", quantity: "100 g", serving_size: "12 fl oz (355 ml)", serving_quantity: 355, nutriments: { "energy-kcal_100g": 10, proteins_100g: 0, carbohydrates_100g: 2.5, fat_100g: 0 } });
  assert.ok(!(can.alts || []).some(a => /package/.test(a.label)), JSON.stringify(can.alts));
});

t("SC-09 label OCR: a gram line read as 'N.N9' with no unit is N.N g (the g read as 9), flagged to check", () => {
  const txt = "Nutrition Facts\nServing size 1/2 cup (113g)\nCalories 90\nTotal Fat 2.59\nSodium 390mg\nTotal Carbohydrate 5g\nDietary Fiber 0g\nTotal Sugars 4g\nProtein 13g";
  const r = M.food.label.parse(txt);
  assert.strictEqual(r.per.f, 2.5);
  assert.ok(r.check.includes("f"), JSON.stringify(r.check));
  const ok = M.food.label.parse(txt.replace("2.59", "2.5g"));
  assert.strictEqual(ok.per.f, 2.5); assert.ok(!ok.check.includes("f"), "a real 2.5g isn't flagged");
});

/* ---- partner check C4, round 4 ---- */
t("C4R4 quick notes with no commas are cut into foods: '2 chicken breasts 1 cup rice broccoli', 'greek yogurt blueberries agave', 'cod asparagus quinoa'", () => {
  M.reset();
  const got = s => { const r = M.food.describeLocal(s); assert.deepStrictEqual(r.unmatched, [], s + " unmatched"); return r.items; };
  let it = got("2 chicken breasts 1 cup rice broccoli");
  assert.strictEqual(it.length, 3, it.map(i => i.name).join(" + "));
  assert.ok(/chicken breast/i.test(it[0].name) && it[0].state === "raw", it[0].name); near(r4g(it[0]), 350, 0.5, "2 breasts raw");
  assert.ok(/rice/i.test(it[1].name) && it[1].state === "cooked", it[1].name); assert.ok(/^broccoli, raw/i.test(it[2].name), it[2].name);
  it = got("greek yogurt blueberries agave");
  assert.deepStrictEqual(it.map(i => i.name.split(",")[0].toLowerCase()), ["greek yogurt", "blueberries", "agave"]);
  it = got("cod asparagus quinoa");
  assert.ok(/^cod/i.test(it[0].name) && it[0].state === "raw" && /asparagus/i.test(it[1].name) && /quinoa/i.test(it[2].name) && it[2].state === "cooked", it.map(i => i.name + ":" + i.state).join(" + "));
  it = got("chicken broccoli rice"); assert.strictEqual(it.length, 3);
  /* an amount right after a food is that food's amount */
  it = got("chicken 200g rice broccoli"); near(r4g(it[0]), 200, 0.5, "chicken 200g"); assert.strictEqual(it.length, 3);
  it = got("chicken 200 g rice"); near(r4g(it[0]), 200, 0.5, "not 200 breasts"); assert.strictEqual(it.length, 2); assert.ok(r4g(it[1]) > 100, "rice keeps its own serving, not 1 g");
  it = got("pork tenderloin 6 oz broccoli"); near(r4g(it[0]), 170, 0.5, "6 oz pork"); assert.ok(/broccoli/i.test(it[1].name) && r4g(it[1]) > 50);
  it = got("3 eggs 2 slices daves"); near(it[0].servings, 3, 0.01); near(it[1].servings, 2, 0.01);
  /* the fewest foods: a two-word food isn't cut in two (no second cottage cheese / bell pepper) */
  it = got("turkey slices cucumber cottage cheese"); assert.strictEqual(it.length, 3, it.map(i => i.name).join(" + "));
  it = got("shrimp quinoa bell pepper"); assert.strictEqual(it.length, 3, it.map(i => i.name).join(" + "));
  it = got("egg whites spinach"); assert.ok(/egg white/i.test(it[0].name), it[0].name);
  it = got("chicken 1 banana"); assert.strictEqual(it.length, 2, "the banana isn't lost"); near(r4g(it[0]), 175, 0.5);
  it = got("chicken 2 breasts rice"); assert.strictEqual(it.length, 2, it.map(i => i.name).join(" + ")); near(r4g(it[0]), 350, 0.5);
  assert.ok(/lime juice/i.test(r4one("juice of 1 lime").name));
  near(r4g(r4one("juice of 2 limes")), 2 * r4g(r4one("juice of 1 lime")), 0.5);
});
t("C4R4 one food is never cut in two; a fruit + bread / juice / peppers isn't two foods; jam of any flavor is their Smucker's; a flavor word isn't a food", () => {
  M.reset();
  for (const s of ["sweet potato", "peanut butter", "olive oil", "cottage cheese", "greek yogurt", "corn on the cob", "chicken breast", "pork tenderloin", "baby carrots", "bell pepper", "brown rice", "white rice", "egg whites", "half and half", "sweet onion", "roma tomatoes", "turkey slices"]) r4one(s);
  for (const s of ["grilled chicken", "baked cod", "steamed broccoli", "scrambled eggs", "sliced turkey", "fresh strawberries", "organic banana", "frozen blueberries", "plain greek yogurt"]) r4one(s);
  for (const s of ["banana bread", "grape juice", "banana peppers", "corn chips", "strawberry yogurt"]) {
    const r = M.food.describeLocal(s); assert.strictEqual(r.items.length, 0, s + " → " + r.items.map(i => i.name).join(" + ")); assert.deepStrictEqual(r.unmatched, [s]);
  }
  for (const s of ["grape jelly", "blueberry jam"]) assert.ok(/smucker/i.test(r4one(s).brand), s);
  const lp = M.food.describeLocal("lemon pepper chicken");
  assert.ok(!lp.items.some(i => /^lemon|pepper/i.test(i.name)), lp.items.map(i => i.name).join(" + "));
  assert.strictEqual(M.food.describeLocal("chicken broccoli lemon").items.length, 3, "a lemon at the end is a food");
  const t0 = Date.now(); const big = M.food.describeLocal("chicken broccoli rice quinoa asparagus cod shrimp scallops zucchini onion banana blueberries");
  assert.strictEqual(big.items.length, 12); assert.ok(Date.now() - t0 < 4000, "a long note stays quick");
});

t("C4R4 K3: a second code linked to one of My foods finds it offline and isn't called built in; UPC-A, EAN-13 and 11 digits find a built-in", async () => {
  M.reset();
  global.fetch = async () => { throw new TypeError("Failed to fetch"); };
  NAV.onLine = false;
  try {
    const mine = M.foods.add({ name: "Oat milk", brand: "Store", source: "custom", barcode: "066666666666", serving: { qty: 1, unit: "cup", g: 240 }, per: { cal: 120, p: 3, c: 16, f: 5, fiber: 2, sugar: 7, sodium: 100 } });
    assert.ok(M.foods.linkCode("055555555550", mine.id), "linked");
    const r = await M.food.lookup("055555555550");
    assert.strictEqual(r.food.id, mine.id); assert.ok(!r.builtIn, "one of My foods isn't built in");
    const g = M.DB.generic.find(f => Array.isArray(f.barcodes) && f.barcodes.length);
    if (g) {
      const c = String(g.barcodes[0]).replace(/^0+/, "");
      for (const code of [c.padStart(12, "0"), c.padStart(13, "0"), c]) { const b = await M.food.lookup(code); assert.strictEqual(b.food.id, g.id, code); assert.strictEqual(b.builtIn, true, code); }
    }
  } finally { NAV.onLine = true; delete global.fetch; delete M.MS.codes; M.reset(); }
});

/* ---- fixer round 5 (F4): describe speed and swarm #3 words findings ---- */
const f5Seed = () => {
  M.reset();
  const P = (cal, p, c, f) => ({ cal, p, c, f, fiber: 0, sugar: 0, sodium: 0 });
  const food = (name, brand, unit, g, per) => M.foods.add({ name, brand, source: "off", serving: { qty: 1, unit, g }, per, per100g: { cal: per.cal * 100 / g, p: per.p * 100 / g, c: per.c * 100 / g, f: per.f * 100 / g, fiber: 0, sugar: 0, sodium: 0 } });
  const bites = food("Egg bites, bacon and gruyere", "Store", "piece", 65, P(150, 9, 5, 10));
  const van = food("Greek yogurt, vanilla", "Store", "container", 150, P(120, 12, 16, 0));
  const it = (id, servings) => { const f = M.foods.get(id); return { foodId: f.id, name: f.name, brand: f.brand, servings, servingLabel: M.fmtServing(f.serving), g: f.serving.g, per: f.per }; };
  const meal = (name, ids) => M.meals.add({ name, slot: "Lunch", items: ids.map(x => it(x, 1)) });
  meal("Cottage cheese and fruit", ["g_cottage_cheese_2", "g_strawberries"]);
  meal("Salmon and sweet potato", ["g_salmon", "g_sweet_potato_baked"]);
  meal("Peanut butter toast", ["g_dkb_21_grains", "g_peanut_butter"]);
  meal("PB&J", ["g_dkb_21_grains", "g_peanut_butter", "g_jam"]);
  meal("Egg scramble", ["g_egg_large", "g_spinach_raw"]);
  meal("Greek yogurt bowl", ["g_greek_yogurt_2", "g_blueberries"]);
  meal("Chicken rice bowl", ["g_kirkland_organic_chicken", "g_white_rice"]);
  return { bites, van };
};
const f5 = s => M.food.describeLocal(s);
const f5names = s => f5(s).items.map(i => i.name);
t("F4R5 SD-05/SP-02 describe stays fast with 420 saved foods and 92 meals; one list read per call", () => {
  M.reset();
  const words = ["organic", "chicken", "beef", "turkey", "greek", "yogurt", "protein", "chips", "salsa", "bread", "tortilla", "milk", "almond", "rice", "pasta", "sauce", "soup", "salad", "wrap", "vanilla", "chocolate", "strawberry", "peanut", "butter", "honey", "sweet", "spicy", "smoked", "lite", "zero"];
  let seed = 7; const r = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; const pick = a => a[Math.floor(r() * a.length)];
  const ids = [];
  for (let i = 0; i < 420; i++) ids.push(M.foods.add({ name: pick(words) + " " + pick(words) + " " + pick(words), brand: "Brand " + (i % 20), source: "off", serving: { qty: 1, unit: "serving", g: 50 }, per: { cal: 200, p: 10, c: 20, f: 8, fiber: 1, sugar: 5, sodium: 100 }, per100g: { cal: 400, p: 20, c: 40, f: 16, fiber: 2, sugar: 10, sodium: 200 } }).id);
  for (let i = 0; i < 92; i++) M.meals.add({ name: pick(words) + " " + pick(words) + " " + pick(["bowl", "plate", "wrap"]), slot: "Lunch", items: [0, 1, 2].map(() => { const f = M.foods.get(pick(ids)); return { foodId: f.id, name: f.name, servings: 1, servingLabel: "1 serving", g: 50, per: f.per }; }) });
  let lists = 0; const fl = M.foods.list, ml = M.meals.list;
  M.foods.list = function () { lists++; return fl.apply(this, arguments); };
  M.meals.list = function () { lists++; return ml.apply(this, arguments); };
  try {
    const notes = ["chicken rice broccoli salmon asparagus quinoa eggs toast coffee banana almonds yogurt", "turkey slices cucumber cottage cheese strawberries banana almonds", "xyzzy blorp flarn quux wibble wobble frob nitz garply waldo fred plugh"];
    f5(notes[0]);
    for (const n of notes) {
      lists = 0;
      const t0 = Date.now(); const res = f5(n); const ms = Date.now() - t0;
      assert.ok(ms < 400, n + " took " + ms + " ms (v17 took seconds)");
      assert.ok(lists <= 2, "lists read once per call, got " + lists);
      if (n === notes[0]) assert.ok(res.items.length >= 8, res.items.map(i => i.name).join(" + ") + " ✗" + JSON.stringify(res.unmatched));
    }
  } finally { M.foods.list = fl; M.meals.list = ml; M.reset(); }
});
t("F4R5 SD-01 a saved meal doesn't take over a plain food; only its full name picks it", () => {
  f5Seed();
  assert.ok(/^cottage cheese, 2%/i.test(f5names("cottage cheese")[0]), f5names("cottage cheese").join());
  assert.ok(/^cottage cheese, 2%/i.test(f5names("1 cup cottage cheese")[0]));
  assert.ok(/^sweet potato/i.test(f5names("sweet potato")[0]), f5names("sweet potato").join());
  assert.ok(/^peanut butter,/i.test(f5names("2 tbsp peanut butter")[0]), f5names("2 tbsp peanut butter").join());
  assert.deepStrictEqual(f5names("cottage cheese and fruit"), ["Cottage cheese and fruit"], "the full name is the meal");
  assert.deepStrictEqual(f5names("greek yogurt bowl"), ["Greek yogurt bowl"], "a bowl word in the name counts");
  const cr = f5names("chicken rice broccoli");
  assert.strictEqual(cr.length, 3, cr.join(" + ")); assert.ok(!cr.some(n => /bowl/i.test(n)), "a piece of a note is never a meal");
  assert.ok(/^eggs?, whole/i.test(f5names("3 scrambled eggs")[0]), "not the Egg scramble meal: " + f5names("3 scrambled eggs").join());
});
t("F4R5 SD-02 PB&J: their PB&J meal first; with no meal it's bread + peanut butter + jam, never a toast meal", () => {
  f5Seed();
  for (const s of ["pb&j", "pbj", "pb and j", "peanut butter and jelly sandwich", "pb and jelly"]) assert.deepStrictEqual(f5names(s), ["PB&J"], s);
  const two = f5("2 pb&js").items; assert.strictEqual(two.length, 1); near(two[0].servings, 2, 0.01, "2 sandwiches");
  const pbt = f5names("pb toast"); assert.deepStrictEqual(pbt, ["Peanut butter toast"], "pb is peanut butter");
  M.meals.list().filter(m => /pb&j/i.test(m.name)).forEach(m => M.meals.remove ? M.meals.remove(m.id) : delete M.MS.meals[m.id]);
  const parts = f5names("pb&j");
  assert.strictEqual(parts.length, 3, parts.join(" + ")); assert.ok(!parts.some(n => /toast/i.test(n)), parts.join(" + "));
});
t("F4R5 SD-03/SD-04/SD-07 amounts start the right food; eggs are never lost; egg whites by the cup are the liquid kind", () => {
  f5Seed();
  let it = f5("toast 2 eggs").items; assert.strictEqual(it.length, 2, it.map(i => i.name).join(" + ")); assert.ok(/^eggs?, whole/i.test(it[1].name)); near(it[1].servings, 2, 0.01);
  it = f5("spinach 2 eggs").items; assert.strictEqual(it.length, 2); near(it[1].servings, 2, 0.01);
  it = f5("2 eggs 2 whites").items; assert.strictEqual(it.length, 2, it.map(i => i.name).join(" + ")); assert.ok(/whole/i.test(it[0].name) && /white/i.test(it[1].name));
  it = f5("x2 eggs").items; near(it[0].servings, 2, 0.01);
  it = f5("1 cup rice broccoli 6oz salmon").items; assert.strictEqual(it.length, 3); assert.ok(/salmon/i.test(it[2].name)); near(it[2].g, 170, 1, "6 oz is the salmon's");
  it = f5("chicken 200g rice 1 cup").items; assert.strictEqual(it.length, 2); near(it[0].g, 200, 0.5, "200 g chicken"); assert.ok(/rice/i.test(it[1].name) && /^1 cup/.test(it[1].servingLabel), it[1].servingLabel);
  it = f5("salmon 6oz asparagus 6 spears").items; near(it[0].g, 170, 1); assert.ok(/6 spears/.test(it[1].servingLabel), it[1].servingLabel);
  it = f5("1 cup egg whites").items; assert.ok(/liquid/i.test(it[0].name), it[0].name); assert.ok(it[0].g > 200, "a cup is about 243 g");
});
t("F4R5 SD-06/SD-19/SD-17 a glass is one drink, a shot is a shot, 'half cup' after the food counts", () => {
  M.reset();
  let it = f5("2 glasses of wine").items; assert.strictEqual(it.length, 1); assert.ok(!/bottle/i.test(it[0].servingLabel), it[0].servingLabel); near(it[0].per.cal * it[0].servings, 250, 10);
  it = f5("2 wines").items; assert.ok(!/bottle/i.test(it[0].servingLabel), "no package unless said");
  it = f5("2 shots tequila").items; near(it[0].servings, 2, 0.01); assert.ok(/shot/.test(it[0].servingLabel));
  it = f5("tequila shot").items; near(it[0].servings, 1, 0.01);
  it = f5("rice half cup").items; assert.strictEqual(f5("rice half cup").unmatched.length, 0); near(it[0].servings * (/^1 cup/.test(it[0].servingLabel) ? 1 : 2), 0.5, 0.01);
  it = f5("blueberries half cup").items; near(it[0].servings, 0.5, 0.01);
});
t("F4R5 SD-16/SD-12/SD-15 a flavor after the comma isn't the food; two foods side by side both count; plain cheese isn't cottage cheese", () => {
  const { bites } = f5Seed();
  assert.ok(!f5names("eggs bacon toast").some(n => n === bites.name), f5names("eggs bacon toast").join(" + "));
  assert.ok(!f5names("2 slices bacon 2 eggs").some(n => n === bites.name));
  assert.deepStrictEqual(f5names("egg bites"), [bites.name], "its own name still finds it");
  assert.strictEqual(f5names("almonds banana").length, 2, "almonds + banana");
  const ob = f5("oats banana"); assert.ok(ob.items.some(x => /banana/i.test(x.name)), "the banana isn't lost: " + JSON.stringify(ob));
  assert.deepStrictEqual(f5("cheese").unmatched, ["cheese"]);
  assert.deepStrictEqual(f5("1 slice cheese").items, []);
  assert.ok(/cottage/i.test(f5names("cottage cheese")[0]));
});
t("F4R5 SP-01 meal and time words aren't foods (lunch meat, breakfast sausage stay)", () => {
  f5Seed();
  for (const s of ["lunch: chicken breast", "for lunch chicken breast", "lunch was a chicken breast", "I had a chicken breast for dinner today"]) { const r = f5(s); assert.deepStrictEqual(r.unmatched, [], s); assert.ok(/chicken breast/i.test(r.items[0].name), s); }
  let r = f5("for breakfast 2 eggs"); assert.ok(/^eggs?, whole/i.test(r.items[0].name)); near(r.items[0].servings, 2, 0.01);
  r = f5("breakfast 2 eggs"); assert.ok(/^eggs?, whole/i.test(r.items[0].name), r.items.map(i => i.name).join());
  r = f5("dinner: salmon and rice"); assert.strictEqual(r.items.length, 2); assert.deepStrictEqual(r.unmatched, []);
  assert.ok(/turkey/i.test(f5names("lunch meat")[0]));
  const bs = f5("breakfast sausage"); assert.ok(bs.items.length ? /sausage/i.test(bs.items[0].name) : bs.unmatched[0] === "breakfast sausage");
});
t("F4R5 MF-02 pasta by weight is dry; ¼–⅓ cup or 40–60 g of rice / quinoa is dry; more is cooked", () => {
  M.reset();
  const st = s => { const it = r4one(s); return it.state; };
  assert.strictEqual(st("2 oz pasta"), "raw"); near(r4one("2 oz pasta").per.cal * r4one("2 oz pasta").servings, 210, 12, "the box: about 200 cal");
  assert.strictEqual(st("1/4 cup rice"), "raw"); assert.strictEqual(st("50g quinoa"), "raw");
  assert.strictEqual(st("1 cup rice"), "cooked"); assert.strictEqual(st("1/2 cup quinoa"), "cooked"); assert.strictEqual(st("2 oz cooked pasta"), "cooked");
});
t("F4R5 decision 2 / PL-01 a word no food fits is said back plainly; the rest still counts", () => {
  M.reset();
  let r = f5("greek yogurt blueberries granola");
  assert.strictEqual(r.items.length, 2, r.items.map(i => i.name).join(" + ")); assert.deepStrictEqual(r.unmatched, ["granola"]);
  r = f5("a large mocha frappuccino"); assert.deepStrictEqual(r.unmatched, ["mocha frappuccino"]);
  for (const s of ["french toast", "mashed potatoes", "white claw", "diet coke", "chicken strips"]) assert.strictEqual(f5(s).items.length, 0, s + " → " + f5names(s).join(" + "));
  r = f5("shrimp stir fry"); assert.deepStrictEqual(r.unmatched, []); assert.ok(/shrimp/i.test(r.items[0].name) && r.items.length === 1, r.items.map(i => i.name).join(" + "));
  const lp = f5("lemon pepper chicken"); assert.ok(!lp.items.some(i => /pepper|lemon/i.test(i.name)), lp.items.map(i => i.name).join(" + "));
});

t("F4R5 SD-14/SD-18/sizes: mayo, ranch, a brand name, 'whole avocado', '10 jumbo shrimp'", () => {
  M.reset();
  assert.ok(/mayonnaise/i.test(r4one("mayo 1 tbsp").name));
  if (M.DB.generic.some(f => /^ranch/i.test(f.name))) assert.ok(/ranch/i.test(r4one("2 tbsp ranch").name));
  if (M.DB.generic.some(f => /^marinara/i.test(f.name))) assert.ok(/marinara/i.test(r4one("marinara").name));
  assert.deepStrictEqual(f5("two tacos").unmatched, ["two tacos"], "not the taco seasoning");
  assert.ok(!/oil/i.test(r4one("avocado").name), "avocado isn't avocado oil");
  const fl = M.foods.add({ name: "Ultra-filtered milk, 2%", brand: "Fairlife", source: "off", serving: { qty: 1, unit: "cup", g: 240 }, per: { cal: 120, p: 13, c: 6, f: 4.5, fiber: 0, sugar: 6, sodium: 125 } });
  assert.strictEqual(r4one("fairlife 1 cup").foodId, fl.id, "their milk by its brand");
  const av = r4one("whole avocado"), half = r4one("avocado");
  near(av.g, 2 * half.g, 2, "a whole avocado is twice the usual half");
  assert.ok(/whole/i.test(r4one("whole milk").name));
  const sh = M.DB.generic.find(f => /^shrimp$/i.test(f.name));
  if (sh && (sh.alts || []).some(a => /jumbo/i.test(a.label))) {
    assert.ok(/jumbo/i.test(r4one("10 jumbo shrimp").servingLabel), r4one("10 jumbo shrimp").servingLabel);
    assert.ok(!/jumbo/i.test(r4one("10 shrimp").servingLabel), "plain count is the large size");
  }
});
t("F4R5 KJ-04 Meal ideas: the person's own meals first; the other person's say whose they are; snacks rank snack ideas first", () => {
  M.reset();
  const P = { cal: 300, p: 25, c: 20, f: 10, fiber: 0, sugar: 0, sodium: 0 };
  const item = { name: "Food", servings: 1, servingLabel: "1 serving", per: P };
  const prev = S.profile;
  try {
    S.profile = "nick"; const nm = M.meals.add({ name: "Tuna bowl", slot: "Lunch", items: [item] }); M.meals.update ? M.meals.update(nm.id, { uses: 9 }) : (M.MS.meals[nm.id].uses = 9);
    S.profile = "kat"; const km = M.meals.add({ name: "Salad plate", slot: "Lunch", items: [item] });
    if (M.MS.meals[nm.id].pid !== "nick" || M.MS.meals[km.id].pid !== "kat") return;   /* meals without owners: nothing to sort */
    const list = M.food.suggestMine({ slot: "Lunch", remaining: { cal: 1500, p: 100, c: 150, f: 50 } });
    assert.strictEqual(list[0].id, km.id, "Katerina's own meal first: " + list.map(x => x.name).join(", "));
    const other = list.find(x => x.id === nm.id);
    assert.ok(other && other.own === false && other.whoLabel === "Nick's meal", JSON.stringify(other && { own: other.own, who: other.whoLabel }));
    assert.strictEqual(list[0].own, true); assert.ok(!list[0].whoLabel);
  } finally { S.profile = prev; M.reset(); }
  const ideas = M.food.suggestBuiltin({ slot: "Snacks", remaining: { cal: 1500, p: 100, c: 150, f: 50 }, n: 4, jitter: 0 });
  if (M.DB.suggest.some(x => x.slot === "Snacks")) assert.ok(ideas.slice(0, 2).every(x => x.slot === "Snacks"), ideas.map(x => x.slot + ":" + x.name).join(", "));
});

t("F4R5 SD-13 small typos still find the food ('chiken breast', 'brocoli', 'bannana', 'salmom 6oz'); nonsense stays not found", () => {
  M.reset();
  assert.ok(/chicken breast/i.test(r4one("chiken breast").name));
  near(r4one("chicken brest 200g").g, 200, 0.5, "the amount stays with it");
  assert.ok(/^broccoli/i.test(r4one("brocoli").name)); assert.ok(/^banana/i.test(r4one("bannana").name));
  near(r4one("salmom 6oz").g, 170, 1);
  assert.deepStrictEqual(f5("xyzzy blorp").unmatched, ["xyzzy blorp"]);
});

t("C4R5 a long note with no commas (13–40 words) is still cut into foods, fast", () => {
  M.reset();
  const note = "2 eggs 2 slices daves toast butter banana coffee chicken breast 1 cup rice broccoli 6oz salmon asparagus quinoa greek yogurt blueberries agave";
  assert.ok(note.split(" ").length > 20);
  const t0 = Date.now(), r = f5(note), ms = Date.now() - t0;
  assert.deepStrictEqual(r.unmatched, [], JSON.stringify(r.unmatched));
  const names = r.items.map(i => i.name).join(" | ");
  ["egg", "banana", "chicken breast", "rice", "broccoli", "salmon", "asparagus", "quinoa", "greek yogurt", "blueberr", "agave"].forEach(w => assert.ok(names.toLowerCase().indexOf(w) >= 0, w + " missing: " + names));
  const ch = r.items.find(i => /chicken breast/i.test(i.name));
  assert.strictEqual(ch.state, "raw"); near(ch.g, 175, 0.5, "one breast, raw");
  assert.ok(ms < 1500, "took " + ms + " ms");
});
t("C4R5 '2 whites' is egg whites (never white bread); 'cucumber half' is half a cucumber; meal words inside a long note aren't foods", () => {
  M.reset();
  let r = f5("2 eggs 2 whites toast");
  assert.deepStrictEqual(r.unmatched, []);
  assert.ok(r.items.some(i => /^egg white/i.test(i.name) && Math.round(i.per.cal * i.servings) === 34), r.items.map(i => i.name).join(" | "));
  assert.ok(!r.items.some(i => /white, sandwich|bread, white/i.test(i.name)), "no white bread: " + r.items.map(i => i.name).join(" | "));
  const cu = r4one("cucumber half");
  assert.ok(/^cucumber/i.test(cu.name)); near(cu.g, 150, 1, "half a cucumber");
  near(r4one("chicken breast half").g, 87.5, 0.6, "half a breast, raw");
  assert.ok(/half and half/i.test(r4one("half and half").name), "half and half stays one food");
  r = f5("lunch 2 chicken breasts 2 cups rice broccoli dinner cod quinoa asparagus snack greek yogurt blueberries");
  assert.deepStrictEqual(r.unmatched, []);
  assert.ok(r.items.some(i => /^cod/i.test(i.name)) && r.items.some(i => /greek yogurt/i.test(i.name)), r.items.map(i => i.name).join(" | "));
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
