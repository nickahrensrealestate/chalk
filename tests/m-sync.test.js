/* node tests/m-sync.test.js — m-sync.js (M.cloud) against a mock Supabase / PostgREST.
   The mock is a real Node http server that behaves like the chalk_sync table:
   row-level security by the x-household header, upserts on (household, kind, id)
   stamped with ONE server timestamp per request (like now() in a transaction),
   jsonb key order on the way back out, cursor pulls with gt / order / limit.
   Every "phone" is its own vm context with its own localStorage, M, and fetch. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const http = require("http");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const SRC = { core: fs.readFileSync(path.join(ROOT, "m-core.js"), "utf8"), sync: fs.readFileSync(path.join(ROOT, "m-sync.js"), "utf8") };
const KEY = "test-publishable-key", JWT_KEY = "eyJhbGciOiJIUzI1NiJ9.test.sig";
const DAY = 864e5;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = o => JSON.parse(JSON.stringify(o));      /* move values out of a phone's realm */
const CODE_RE = /^[A-HJ-NP-Z2-9]{20}$/;

/* ======================================================= mock PostgREST */
function tsVal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(String(s || "").trim());
  if (!m) return NaN;
  let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[8] && m[8].toUpperCase() !== "Z") { const z = m[8].replace(":", ""), sg = z[0] === "-" ? -1 : 1; ms -= sg * ((+z.slice(1, 3)) * 60 + (+(z.slice(3, 5) || 0))) * 60000; }
  return ms * 1000 + (m[7] ? +(m[7] + "000000").slice(0, 6) : 0);
}
function pgTs(us) {   /* PostgREST style: microseconds, trailing zeros trimmed, +00:00 */
  const iso = new Date(Math.floor(us / 1000)).toISOString().slice(0, 19);
  const frac = String(us % 1000000).padStart(6, "0").replace(/0+$/, "");
  return iso + (frac ? "." + frac : "") + "+00:00";
}
function jsonb(v) {   /* jsonb stores object keys sorted by length, then bytewise */
  if (Array.isArray(v)) return v.map(jsonb);
  if (v && typeof v === "object") { const o = {}; Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).forEach(k => { o[k] = jsonb(v[k]); }); return o; }
  return v;
}
function mockServer() {
  const rows = new Map();          /* household|kind|id → row */
  const log = [];
  let lastUs = 0;
  const srv = { rows, log, reject: null, failNext: 0,
    clock() { let us = Date.now() * 1000; if (us <= lastUs) us = lastUs + 1; lastUs = us; return us; },
    all(hh) { return [...rows.values()].filter(r => !hh || r.household === hh); },
    get(hh, kind, id) { return rows.get(hh + "|" + kind + "|" + id) || null; },
    /* a row whose transaction started `agoMs` ago but only commits now */
    lateInsert(row, agoMs) { const us = srv.clock() - agoMs * 1000; rows.set(row.household + "|" + row.kind + "|" + row.id, Object.assign({}, row, { data: JSON.stringify(row.data), _us: us, updated_at: pgTs(us) })); },
    /* a row written by someone else (another app version, a script): stamped now */
    put(row) { const us = srv.clock(); rows.set(row.household + "|" + row.kind + "|" + row.id, Object.assign({ deleted: false, client_updated: 0, device: "x" }, row, { data: typeof row.data === "string" ? row.data : JSON.stringify(row.data), _us: us, updated_at: pgTs(us) })); }
  };
  const send = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(body == null ? "" : JSON.stringify(body)); };
  srv.server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      const hh = req.headers["x-household"] || "";
      const entry = { method: req.method, path: u.pathname, query: u.search, hh, apikey: req.headers.apikey, auth: req.headers.authorization || "", prefer: req.headers.prefer || "", n: 0 };
      log.push(entry);
      if (u.pathname !== "/rest/v1/chalk_sync") return send(res, 404, { message: "not found" });
      if (req.headers.apikey !== KEY && req.headers.apikey !== JWT_KEY) return send(res, 401, { message: "Invalid API key" });
      if (req.headers.apikey === JWT_KEY && req.headers.authorization !== "Bearer " + JWT_KEY) return send(res, 401, { message: "JWT missing" });
      if (srv.failNext) { const s = srv.failNext; srv.failNext = 0; if (srv.retryAfter) res.setHeader("retry-after", String(srv.retryAfter)); return send(res, s, { message: "boom" }); }
      if (srv.hook) { const h = srv.hook(req, entry, body); if (h) return send(res, h.status, h.body || { message: "hook" }); }
      const q = u.searchParams;
      if (req.method === "GET") {
        let out = srv.all().filter(r => srv.noRLS || r.household === hh);   /* RLS: only your own household */
        for (const [k, v] of q) {
          if (k === "select" || k === "order" || k === "limit" || k === "offset") continue;
          const m = /^(eq|gt|in|like)\.(.*)$/.exec(v); if (!m) return send(res, 400, { message: "bad filter " + k });
          if (k === "updated_at") { const t = tsVal(m[2]); if (!isFinite(t)) return send(res, 400, { message: "bad ts " + m[2] }); out = out.filter(r => (m[1] === "gt" ? r._us > t : r._us === t)); }
          else if (m[1] === "in") { const list = m[2].replace(/^\(|\)$/g, "").split(","); out = out.filter(r => list.includes(String(r[k]))); }
          else if (m[1] === "like") { const re = new RegExp("^" + m[2].split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"); out = out.filter(r => re.test(String(r[k]))); }
          else if (m[1] === "gt") out = out.filter(r => String(r[k]) > m[2]);
          else out = out.filter(r => String(r[k]) === m[2]);
        }
        if (q.get("order")) {
          const keys = q.get("order").split(",").map(s => s.split(".")[0]);
          const val = (r, k) => (k === "updated_at" ? r._us : String(r[k]));
          out.sort((a, b) => { for (const k of keys) { const x = val(a, k), y = val(b, k); if (x < y) return -1; if (x > y) return 1; } return 0; });
        }
        if (q.get("offset")) out = out.slice(+q.get("offset"));
        if (q.get("limit")) out = out.slice(0, +q.get("limit"));
        const cols = (q.get("select") || "*").split(",");
        entry.n = out.length; entry.ts = out.map(r => r.updated_at);
        const result = out.map(r => { const o = {}; cols.forEach(c => { o[c] = c === "data" ? jsonb(JSON.parse(r.data)) : r[c]; }); return o; });
        /* srv.mutate(rows, entry) may return raw JSON text (to send keys like "__proto__" as-is) */
        const m = srv.mutate ? srv.mutate(result, entry) : result;
        if (typeof m === "string") { res.writeHead(200, { "content-type": "application/json" }); res.end(m); return; }
        return send(res, 200, m);
      }
      if (req.method === "POST") {
        if (q.get("on_conflict") !== "household,kind,id" || !/resolution=merge-duplicates/.test(entry.prefer)) return send(res, 400, { message: "not an upsert" });
        let arr; try { arr = JSON.parse(body); } catch (e) { return send(res, 400, { message: "bad json" }); }
        if (!Array.isArray(arr)) arr = [arr];
        entry.n = arr.length; entry.rows = arr.map(r => r.kind + "|" + r.id);
        const keys = JSON.stringify(Object.keys(arr[0] || {}).sort());
        if (arr.some(r => JSON.stringify(Object.keys(r).sort()) !== keys)) return send(res, 400, { code: "PGRST102", message: "All object keys must match" });
        for (const r of arr) {
          if (r.household !== hh) return send(res, 403, { message: "new row violates row-level security policy" });
          if (!["food", "meal", "day", "body", "profile", "train", "meta"].includes(r.kind)) return send(res, 400, { message: "check constraint" });
          if (typeof r.device !== "string" || r.device.length > 64) return send(res, 400, { message: "device" });
          if (!Number.isInteger(r.client_updated)) return send(res, 400, { message: "client_updated must be bigint" });
          if (typeof r.deleted !== "boolean" || !r.data || typeof r.data !== "object") return send(res, 400, { message: "shape" });
          if (Buffer.byteLength(JSON.stringify(r.data)) >= 3e6) return send(res, 413, { message: "too big" });
          if (srv.reject && srv.reject(r)) return send(res, 400, { message: "rejected row" });
        }
        const us = srv.clock();                       /* one now() for the whole request */
        arr.forEach(r => rows.set(r.household + "|" + r.kind + "|" + r.id, { household: r.household, kind: r.kind, id: r.id, data: JSON.stringify(r.data), deleted: r.deleted, client_updated: r.client_updated, device: r.device, _us: us, updated_at: pgTs(us) }));
        return send(res, 201, null);
      }
      return send(res, 405, { message: "no" });
    });
  });
  return srv;
}

/* ============================================================== phones */
let SERVER = null, URLBASE = "";
function trainState(pid, ids, extra) {
  const base = Date.now() - 30 * DAY;
  return Object.assign({ v: 1, updatedAt: Date.now(), profile: pid, settings: { restC: 60, restA: 45, theme: "system" }, program: { ver: 5, workouts: {} },
    ex: {}, log: ids.map((id, i) => ({ id, name: "Workout " + id, start: base + i * DAY, sets: { squat: [{ w: 225, r: 5 }], bench: [{ w: 135, r: 8 }], rdl: [{ w: 185, r: 8 }] } })), gone: [], active: null, next: "PULL" }, extra || {});
}
function phone(name, o) {
  o = o || {};
  const store = new Map(Object.entries(o.store || {}));
  const reqs = [];
  const full = new Set();     /* keys whose writes fail like a full phone */
  let offline = false;
  const winL = {}, docL = {};
  const doc = {
    visibilityState: "visible", activeElement: null, body: {}, _app: null,
    addEventListener(t, fn) { (docL[t] = docL[t] || []).push(fn); },
    getElementById(id) { return id === "app" ? doc._app : null; }
  };
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, TextEncoder, URL, Promise,
    crypto: globalThis.crypto,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { if (full.has(k)) { const e = new Error("The quota has been exceeded."); e.name = "QuotaExceededError"; throw e; } store.set(k, String(v)); },
      removeItem: k => { store.delete(k); }
    },
    fetch: (url, opt) => {
      reqs.push({ url: String(url), method: (opt && opt.method) || "GET", headers: Object.assign({}, opt && opt.headers), body: opt && opt.body });
      if (offline) return Promise.reject(new TypeError("Failed to fetch"));
      return fetch(url, opt);
    },
    location: { reloads: 0, reload() { this.reloads++; } },
    document: doc,
    S: o.S || { profile: "nick", active: null },
    PRESETS: { nick: { name: "Nick" }, kat: { name: "Katerina" } },
    CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
    addEventListener(t, fn) { (winL[t] = winL[t] || []).push(fn); },
    dispatchEvent(ev) { (winL[ev.type] || []).forEach(fn => fn(ev)); return true; }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC.core, ctx, { filename: "m-core.js" });
  vm.runInContext("M.ui = { renders: 0, rerender() { this.renders++; } };", ctx);
  vm.runInContext(SRC.sync, ctx, { filename: "m-sync.js" });
  const M = ctx.M;
  if (o.config !== false) M.cloud.configure({ url: URLBASE, key: o.key || KEY });
  if (o.train) store.set("chalk.v1", JSON.stringify(o.train));
  return {
    name, M, ctx, store, reqs, winL, docL,
    offline(v) { offline = v; },
    storageFull(k, v) { if (v) full.add(k); else full.delete(k); },
    fire(t) { (winL[t] || []).forEach(fn => fn({ type: t })); },
    visibility(v) { doc.visibilityState = v; (docL.visibilitychange || []).forEach(fn => fn()); },
    train() { const r = store.get("chalk.v1"); return r ? JSON.parse(r) : null; },
    setTrain(t) { store.set("chalk.v1", JSON.stringify(t)); },
    sync() { return M.cloud.syncNow().then(J); },
    posts() { return reqs.filter(r => r.method === "POST"); },
    gets() { return reqs.filter(r => r.method === "GET"); }
  };
}
/* Nick's real data on a phone */
function seedNick(P) {
  const M = P.M, now = Date.now();
  const p = M.person("nick");
  Object.assign(p, { sex: "m", age: 40, heightIn: 71, weightLb: 185, goalWeightLb: 175, activity: "moderate", pace: -1, setupAt: now - 5 * DAY, lastBody: now - DAY });
  M.calc.applyTargets(p);
  const chicken = M.foods.add({ name: "Kirkland organic chicken breast", brand: "Kirkland", serving: { qty: 4, unit: "oz", g: 112 }, per: { cal: 120, p: 26, c: 0, f: 1.5 } });
  const bread = M.foods.add({ name: "Dave's Killer Bread 21 grains", brand: "Dave's", serving: { qty: 1, unit: "slice", g: 45 }, per: { cal: 110, p: 5, c: 22, f: 1.5, fiber: 5 } });
  M.foods.add({ name: "Zucchini", serving: { qty: 1, unit: "cup", g: 124 }, per: { cal: 21, p: 1.5, c: 3.9, f: 0.4 } });
  M.meals.add({ name: "Chicken toast", desc: "Chicken on two slices.", slot: "Lunch", items: [{ name: chicken.name, servings: 1, per: chicken.per, foodId: chicken.id }, { name: bread.name, servings: 2, per: bread.per, foodId: bread.id }] });
  M.meals.add({ name: "Pork tenderloin plate", desc: "Pork, onions, broccoli.", slot: "Dinner", items: [{ name: "Pork tenderloin", servings: 1, per: { cal: 180, p: 30, c: 0, f: 5 } }] });
  for (let i = 0; i < 5; i++) M.log.add(M.addDays(M.today(), -i), { slot: "Lunch", name: "Chicken toast", per: { cal: 340, p: 36, c: 44, f: 4.5 } });
  for (let i = 0; i < 5; i++) M.body.add({ date: M.addDays(M.today(), -i), w: 185 - i * 0.3, rhr: 57 + (i % 2) });
  return { chicken, bread };
}
/* the training backup row: data = {v:1, json:"<chalk.v1 text>"} */
const trainOf = row => JSON.parse(JSON.parse(row.data).json);
const foodNames = P => Object.values(P.M.MS.foods).map(f => f.name).sort();
const mealNames = P => Object.values(P.M.MS.meals).map(m => m.name).sort();

/* ================================================================ tests */
const tests = [];
function t(name, fn) { tests.push({ name, fn }); }
console.log("m-sync.js");

let A, B, CODE;

t("not set up: zero network requests, nothing breaks", async () => {
  const P = phone("offgrid", { config: false, train: trainState("nick", ["w1"]) });
  const C = P.M.cloud;
  assert.strictEqual(C.configured(), false);
  assert.strictEqual(C.status().on, false);
  assert.strictEqual(C.create(), null, "create refuses without config");
  assert.match((await C.join("ABCD-EFGH-JKLM-NPQR-STUV")).error, /isn't set up/);
  assert.strictEqual((await C.syncNow()).ok, false);
  assert.strictEqual(await C.hasTrainingBackup(), false);
  assert.strictEqual(await C.restoreTraining(), false);
  assert.strictEqual(C.start(), false);
  seedNick(P);
  P.M.foods.add({ name: "Roma tomatoes" });
  P.visibility("hidden"); P.visibility("visible"); P.fire("online");
  await sleep(1700);   /* longer than the 1.5 s save delay */
  assert.strictEqual(P.reqs.length, 0, "no fetch at all");
  assert.strictEqual(P.M.save.__cloud, true, "M.save is wrapped");
  const saved = JSON.parse(P.store.get("chalk.macros.v1"));
  assert.ok(Object.values(saved.foods).some(f => f.name === "Roma tomatoes"), "M.save still writes storage");
  assert.strictEqual(C.fmtCode("abcdefghjklmnpqrstuv"), "ABCD-EFGH-JKLM-NPQR-STUV");
  assert.strictEqual(C._.canon({ b: 1, a: [{ d: 2, c: 1 }] }), C._.canon({ a: [{ c: 1, d: 2 }], b: 1 }), "canonical JSON ignores key order");
});

t("turn on: 20-letter code, everything goes up in chunks, headers right, nothing echoes back", async () => {
  A = phone("nick-phone", { train: trainState("nick", ["w1", "w2", "w3"]) });
  seedNick(A);
  const code = A.M.cloud.create();
  assert.ok(CODE_RE.test(code), "code " + code);
  CODE = code;
  const r = await A.sync();
  assert.ok(r.ok, JSON.stringify(r));
  const st = A.M.cloud.status();
  assert.strictEqual(st.on, true); assert.strictEqual(st.code, code); assert.strictEqual(st.lastError, ""); assert.ok(st.lastSync > 0);
  const kinds = SERVER.all(code).reduce((o, row) => { o[row.kind] = (o[row.kind] || 0) + 1; return o; }, {});
  assert.deepStrictEqual(kinds, { food: 3, meal: 2, day: 5, body: 5, profile: 1, meta: 1, train: 1 });
  const trRow = SERVER.get(code, "train", "nick");
  assert.deepStrictEqual(Object.keys(JSON.parse(trRow.data)).sort(), ["json", "v"], "training travels as text");
  assert.strictEqual(JSON.parse(trRow.data).json, A.store.get("chalk.v1"), "exact chalk.v1 text");
  assert.strictEqual(trainOf(trRow).log.length, 3, "training backed up");
  assert.ok(SERVER.get(code, "day", "nick|" + A.M.today()), "day ids are pid|date");
  /* request shape */
  const post = A.posts()[0];
  assert.ok(post.url.startsWith(URLBASE + "/rest/v1/chalk_sync?on_conflict=household,kind,id"), post.url);
  assert.strictEqual(post.headers.Prefer, "resolution=merge-duplicates,return=minimal");
  assert.strictEqual(post.headers.apikey, KEY); assert.strictEqual(post.headers["x-household"], code); assert.strictEqual(post.headers["content-type"], "application/json");
  assert.ok(!("Authorization" in post.headers), "no Bearer for a non-JWT key");
  /* self-test first: our household row goes up alone (twice: the server must stamp a newer time
     on the second write), comes back with our code, and another code sees none of it */
  assert.deepStrictEqual(JSON.parse(post.body).map(r => r.kind + "|" + r.id), ["meta|household"], "first request writes only the household row");
  assert.deepStrictEqual(JSON.parse(A.posts()[1].body).map(r => r.kind + "|" + r.id), ["meta|household"], "then again, to check the server's clock");
  const iso = A.gets().find(g => /kind=eq\.meta/.test(g.url) && g.headers["x-household"] !== code);
  assert.ok(iso && CODE_RE.test(iso.headers["x-household"]), "isolation check with another code");
  const get = A.gets().find(g => /updated_at=gt\./.test(g.url));
  assert.ok(get.url.startsWith(URLBASE + "/rest/v1/chalk_sync?select=household,kind,id,data,deleted,client_updated,updated_at&updated_at=gt."), get.url);
  assert.ok(/&order=updated_at\.asc,kind\.asc,id\.asc&limit=500$/.test(get.url), get.url);
  /* the code is a secret: only ever in the x-household header, never in a URL */
  assert.ok(A.reqs.every(r => r.url.indexOf(code) < 0), "code never in a URL");
  const row = JSON.parse(A.posts()[2].body)[0];
  assert.deepStrictEqual(Object.keys(row).sort(), ["client_updated", "data", "deleted", "device", "household", "id", "kind"]);
  assert.ok(row.device.length <= 64);
  assert.strictEqual(row.kind, "train", "training goes first");
  /* second sync: the pull re-reads our own rows (jsonb key order!) and nothing goes back up */
  const n = A.posts().length;
  const r2 = await A.sync();
  assert.ok(r2.ok); assert.strictEqual(r2.pushed, 0, "no echo push"); assert.strictEqual(r2.applied, 0, "no echo apply");
  assert.strictEqual(A.posts().length, n);
  /* the state survives in localStorage */
  const saved = JSON.parse(A.store.get("chalk.sync.v1"));
  assert.strictEqual(saved.code, code); assert.ok(saved.cursor && isFinite(tsVal(saved.cursor)), "cursor is a server timestamp");
});

t("joining with a code typed in lowercase with dashes works", async () => {
  B = phone("kat-phone", { S: { profile: "kat", active: null }, train: trainState("kat", ["k1", "k2"]) });
  const typed = "  " + A.M.cloud.fmtCode(CODE).toLowerCase() + " ";
  assert.ok(/^\s+[a-z2-9]{4}-/.test(typed));
  const r = await B.M.cloud.join(typed);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(B.M.cloud.status().code, CODE);
  assert.deepStrictEqual(foodNames(B), foodNames(A), "foods arrived");
  assert.deepStrictEqual(mealNames(B), mealNames(A), "meals arrived");
  assert.ok(!B.M.MS.days["nick|" + B.M.today()], "Nick's diary stays in the cloud, not on Katerina's phone");
  assert.ok(!Object.keys(B.M.MS.body).some(k => k.startsWith("nick|")), "and so do his weigh-ins");
  assert.ok(SERVER.get(CODE, "day", "nick|" + B.M.today()), "(they are in the cloud)");
  assert.ok(B.M.MS.profiles.nick && B.M.MS.profiles.nick.weightLb === 185, "Nick's profile arrived");
  assert.ok(B.M.ui.renders >= 1, "re-rendered after applying");
  const savedMacros = JSON.parse(B.store.get("chalk.macros.v1"));
  assert.strictEqual(Object.keys(savedMacros.foods).length, 3, "written to storage");
  assert.ok(SERVER.get(CODE, "train", "kat"), "Katerina's training backed up");
  assert.strictEqual(trainOf(SERVER.get(CODE, "train", "nick")).log.length, 3, "Nick's backup untouched by her phone");
});

t("two phones share foods and meals both ways", async () => {
  B.M.foods.add({ name: "King Soopers pork tenderloin", brand: "King Soopers", serving: { qty: 4, unit: "oz", g: 112 }, per: { cal: 120, p: 22, c: 0, f: 3 } });
  B.M.meals.add({ name: "Kat's egg plate", desc: "Eggs and toast.", slot: "Breakfast", items: [{ name: "Egg", servings: 3, per: { cal: 70, p: 6, c: 0, f: 5 } }] });
  assert.ok((await B.sync()).ok);
  const r = await A.sync();
  assert.ok(r.ok); assert.ok(r.applied >= 2);
  assert.ok(foodNames(A).includes("King Soopers pork tenderloin"));
  assert.ok(mealNames(A).includes("Kat's egg plate"));
  A.M.foods.add({ name: "Sweet onion" });
  await A.sync(); await B.sync();
  assert.deepStrictEqual(foodNames(A), foodNames(B));
  assert.deepStrictEqual(mealNames(A), mealNames(B));
  assert.deepStrictEqual(J(A.M.MS.foods[Object.keys(A.M.MS.foods)[0]]).per, J(B.M.MS.foods[Object.keys(A.M.MS.foods)[0]]).per);
  /* both quiet now */
  const pa = A.posts().length, pb = B.posts().length;
  await A.sync(); await B.sync();
  assert.strictEqual(A.posts().length, pa); assert.strictEqual(B.posts().length, pb);
});

t("a newer edit wins, whichever phone syncs first", async () => {
  const id = Object.values(A.M.MS.foods).find(f => f.name === "Zucchini").id;
  const base = Date.now();
  /* round 1: A edits first (older), B edits later (newer); A syncs first */
  A.M.now = () => base + 1000; A.M.foods.update(id, { name: "Zucchini (A)" });
  B.M.now = () => base + 2000; B.M.foods.update(id, { name: "Zucchini (B)" });
  await A.sync(); await B.sync(); await A.sync();
  assert.strictEqual(A.M.MS.foods[id].name, "Zucchini (B)");
  assert.strictEqual(B.M.MS.foods[id].name, "Zucchini (B)");
  /* round 2: B edits first (older), A edits later (newer); A syncs LAST */
  B.M.now = () => base + 3000; B.M.foods.update(id, { name: "Zucchini (B2)" });
  A.M.now = () => base + 4000; A.M.foods.update(id, { name: "Zucchini (A2)" });
  await B.sync(); await A.sync(); await B.sync();
  assert.strictEqual(A.M.MS.foods[id].name, "Zucchini (A2)");
  assert.strictEqual(B.M.MS.foods[id].name, "Zucchini (A2)");
  assert.strictEqual(JSON.parse(SERVER.get(CODE, "food", id).data).name, "Zucchini (A2)");
  /* an untouched copy always takes the cloud version, even an older one */
  B.M.now = () => base + 500; B.M.foods.update(id, { name: "Zucchini (old clock)" });
  await B.sync(); await A.sync();
  assert.strictEqual(A.M.MS.foods[id].name, "Zucchini (old clock)", "unchanged copy follows the cloud");
  delete A.M.now; delete B.M.now;
  A.M.now = () => Date.now(); B.M.now = () => Date.now();
});

t("deletions propagate and are not resurrected", async () => {
  const meal = Object.values(A.M.MS.meals).find(m => m.name === "Pork tenderloin plate");
  const bodyDay = A.M.addDays(A.M.today(), -4);
  assert.ok(B.M.MS.meals[meal.id] && SERVER.get(CODE, "body", "nick|" + bodyDay).deleted === false);
  A.M.meals.remove(meal.id);
  A.M.body.remove(bodyDay, "nick");
  assert.ok((await A.sync()).ok);
  const row = SERVER.get(CODE, "meal", meal.id);
  assert.strictEqual(row.deleted, true, "tombstone, not a delete");
  assert.strictEqual(SERVER.get(CODE, "body", "nick|" + bodyDay).deleted, true, "weigh-in tombstoned");
  await B.sync();
  assert.ok(!B.M.MS.meals[meal.id], "meal gone on B");
  for (let i = 0; i < 2; i++) { await A.sync(); await B.sync(); }
  assert.ok(!A.M.MS.meals[meal.id] && !B.M.MS.meals[meal.id], "still gone after more syncs");
  assert.strictEqual(SERVER.get(CODE, "meal", meal.id).deleted, true);
  /* a third phone never sees it */
  const C = phone("third", { S: { profile: "kat", active: null } });
  assert.ok((await C.M.cloud.join(CODE)).ok);
  assert.ok(!C.M.MS.meals[meal.id]);
  assert.ok(C.M.MS.meals[Object.values(A.M.MS.meals)[0].id], "but gets the rest");
  /* delete vs edit: an edit made since the last sync survives a delete from the other phone */
  const keep = Object.values(A.M.MS.meals).find(m => m.name === "Chicken toast");
  B.M.meals.update(keep.id, { desc: "Kat changed this." });
  A.M.meals.remove(keep.id);
  await A.sync(); await B.sync(); await A.sync();
  assert.ok(B.M.MS.meals[keep.id], "B kept its edit");
  assert.strictEqual(A.M.MS.meals[keep.id] && A.M.MS.meals[keep.id].desc, "Kat changed this.", "edit wins over delete");
});

t("a wrong household code sees nothing", async () => {
  const C = phone("stranger", { S: { profile: "kat", active: null } });
  const n = C.reqs.length;
  assert.match((await C.M.cloud.join("hello")).error, /doesn't look right/);
  assert.strictEqual(C.reqs.length, n, "bad format → no request");
  const other = "ABCDEFGHJKLMNPQRSTUV" === CODE ? "BBCDEFGHJKLMNPQRSTUV" : "ABCDEFGHJKLMNPQRSTUV";
  const r = await C.M.cloud.join(other);
  assert.strictEqual(r.ok, false); assert.match(r.error, /No one is using that code/);
  assert.strictEqual(C.M.cloud.status().on, false, "not joined");
  /* even asking for Nick's rows by name returns nothing with the wrong header */
  const res = await fetch(URLBASE + "/rest/v1/chalk_sync?select=kind,id,data&household=eq." + CODE, { headers: { apikey: KEY, "x-household": other } });
  assert.deepStrictEqual(await res.json(), []);
  /* and writing into Nick's household with the wrong header is refused */
  const before = SERVER.all(CODE).length;
  const w = await fetch(URLBASE + "/rest/v1/chalk_sync?on_conflict=household,kind,id", { method: "POST", headers: { apikey: KEY, "x-household": other, "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ household: CODE, kind: "food", id: "evil", data: {}, deleted: false, client_updated: 1, device: "x" }]) });
  assert.strictEqual(w.status, 403);
  assert.strictEqual(SERVER.all(CODE).length, before);
});

t("days and body back up and restore onto a fresh phone; training waits for Restore", async () => {
  const F = phone("new-phone", { train: trainState("nick", []) });   /* lost phone replaced: fresh Chalk, Nick picked */
  const r = await F.M.cloud.join(CODE);
  assert.ok(r.ok, JSON.stringify(r));
  const t0 = F.M.today();
  assert.strictEqual(F.M.MS.days["nick|" + t0].entries.length, 1, "today's diary back");
  assert.strictEqual(Object.keys(F.M.MS.days).filter(k => k.startsWith("nick|")).length, 5, "5 days back");
  assert.strictEqual(Object.keys(F.M.MS.body).filter(k => k.startsWith("nick|")).length, 4, "4 weigh-ins back (one was deleted)");
  assert.strictEqual(F.M.person("nick").setupAt > 0, true, "profile back, no first-day setup");
  assert.strictEqual(F.M.checkins.due("nick"), null);
  assert.ok(Object.values(F.M.MS.foods).length >= 4, "foods back");
  /* training: the fresh (empty) state must NOT overwrite the backup */
  const row = SERVER.get(CODE, "train", "nick");
  assert.strictEqual(trainOf(row).log.length, 3, "backup intact");
  assert.strictEqual(row.device, A.M.cloud.status().device, "still the old phone's copy");
  assert.ok(!F.posts().some(p => /"kind":"train"/.test(p.body)), "fresh phone never uploaded training");
  const info = F.M.cloud.training();
  assert.ok(info && info.n === 3 && info.missing === 3 && info.held === true && info.same === false && info.mine === false, JSON.stringify(info));
  assert.strictEqual(await F.M.cloud.hasTrainingBackup(), true);
  /* not mid-workout */
  F.ctx.S.active = { name: "Pull day" };
  assert.strictEqual(await F.M.cloud.restoreTraining(), false, "refuses during a workout");
  assert.strictEqual(F.train().log.length, 0);
  F.ctx.S.active = null;
  assert.strictEqual(await F.M.cloud.restoreTraining(), true);
  assert.strictEqual(F.ctx.location.reloads, 1, "page reloads");
  assert.strictEqual(F.train().log.length, 3, "training restored into chalk.v1");
  assert.deepStrictEqual(F.train().log.map(x => x.id), ["w1", "w2", "w3"]);
  assert.strictEqual(F.store.get("chalk.v1"), A.store.get("chalk.v1"), "byte-for-byte the old phone's save");
  assert.deepStrictEqual(Object.keys(F.train().log[0].sets), ["squat", "bench", "rdl"], "exercise order kept (jsonb would sort it)");
  const after = F.M.cloud.training();
  assert.ok(after.mine && after.same && after.missing === 0, "restored copy counts as this phone's own: " + JSON.stringify(after));
  /* after the restore nothing goes back up until something changes */
  const n = F.posts().length;
  await F.sync();
  assert.strictEqual(F.posts().length, n);
  /* a new workout on the new phone: now it is a superset, so it backs up */
  const tr = F.train(); tr.log.unshift({ id: "w4", name: "Legs", start: Date.now(), sets: {} }); tr.updatedAt = Date.now(); F.setTrain(tr);
  await F.sync();
  assert.strictEqual(trainOf(SERVER.get(CODE, "train", "nick")).log.length, 4, "new phone now owns the backup");
  /* the old phone (still around in this test) has fewer workouts → it must not clobber the newer backup */
  const oldTrain = A.train(); oldTrain.settings.restC = 90; oldTrain.updatedAt = Date.now(); A.setTrain(oldTrain);
  await A.sync();
  assert.strictEqual(trainOf(SERVER.get(CODE, "train", "nick")).log.length, 4, "old phone held back");
  assert.strictEqual(A.M.cloud.training().missing, 1);
});

t("one person's training backup is safe from the other phone switching person", async () => {
  const katRow = SERVER.get(CODE, "train", "kat");
  const tr = A.train(); tr.profile = "kat"; tr.updatedAt = Date.now(); A.setTrain(tr);   /* Nick's history, now labelled kat */
  A.ctx.S.profile = "kat";
  await A.sync();
  assert.strictEqual(SERVER.get(CODE, "train", "kat").data, katRow.data, "Katerina's backup untouched");
  const back = A.train(); back.profile = "nick"; A.setTrain(back); A.ctx.S.profile = "nick";
});

t("training backup is tied to person AND phone: a borrowed phone never backs up someone else's history (BES-02)", async () => {
  const N = phone("bes02-nick", { train: trainState("nick", ["n1", "n2", "n3", "n4"]) });
  seedNick(N);
  const code = N.M.cloud.create(); assert.ok((await N.sync()).ok);
  /* Train → Settings → Switch person → Katerina ("History stays"): Nick's 4 workouts now say kat */
  N.ctx.S.profile = "kat"; N.setTrain(Object.assign(N.train(), { profile: "kat", updatedAt: Date.now() }));
  await N.M.cloud._.cycle({ reason: "tick" });
  assert.ok(!SERVER.get(code, "train", "kat"), "no kat backup made of Nick's history");
  const held = N.M.cloud.training();
  assert.ok(held && held.held && held.why === "switched", JSON.stringify(held));
  assert.ok((await N.sync()).ok, "Sync now doesn't force it either");
  assert.ok(!SERVER.get(code, "train", "kat"));
  /* she really trains on his phone: now there's a kat history here, backed up as a borrowed-phone copy */
  const tr = N.train(); tr.log.unshift({ id: "kx", name: "Kat on Nick's phone", start: Date.now(), sets: {} }); tr.updatedAt = Date.now(); N.setTrain(tr);
  assert.ok((await N.sync()).ok);
  const guest = SERVER.get(code, "train", "kat");
  assert.ok(guest && JSON.parse(guest.data).guest === true, "marked as made on a borrowed phone");
  N.ctx.S.profile = "nick"; N.setTrain(Object.assign(N.train(), { profile: "nick", updatedAt: Date.now() }));
  assert.ok((await N.sync()).ok);
  assert.ok(trainOf(SERVER.get(code, "train", "nick")).log.some(x => x.id === "kx"), "(his own backup has everything on his phone)");
  /* her own phone joins: her 2 workouts win over the borrowed-phone copy, which it doesn't have */
  const K = phone("bes02-kat", { S: { profile: "kat", active: null }, train: trainState("kat", ["k1", "k2"]) });
  assert.ok((await K.M.cloud.join(code)).ok);
  const mine = SERVER.get(code, "train", "kat");
  assert.deepStrictEqual(trainOf(mine).log.map(x => x.id), ["k1", "k2"], "her phone's history is the backup now");
  assert.ok(!JSON.parse(mine.data).guest, "and it's from her own phone");
  const info = K.M.cloud.training();
  assert.ok(info.mine && info.same && info.missing === 0, JSON.stringify(info));
  /* Nick's phone, switched to kat again later, can't overwrite her real backup */
  N.ctx.S.profile = "kat"; const t2 = N.train(); t2.profile = "kat"; t2.log.unshift({ id: "ky", name: "again", start: Date.now(), sets: {} }); t2.updatedAt = Date.now(); N.setTrain(t2);
  assert.ok((await N.sync()).ok);
  assert.deepStrictEqual(trainOf(SERVER.get(code, "train", "kat")).log.map(x => x.id), ["k1", "k2"], "her backup untouched");
  assert.strictEqual(N.M.cloud.training().why, "missing");
  N.ctx.S.profile = "nick"; N.setTrain(Object.assign(N.train(), { profile: "nick" }));
  N.M.cloud.leave(); K.M.cloud.leave();
});

t("restore keeps the replaced training for Undo and leaves a one-time note (BES-02)", async () => {
  const O = phone("bes02u-old", { train: trainState("nick", ["w1", "w2", "w3"]) });
  seedNick(O);
  const code = O.M.cloud.create(); assert.ok((await O.sync()).ok);
  /* a phone with a little training of its own (2 workouts the backup doesn't have) */
  const P = phone("bes02u-new", { train: trainState("nick", ["p1", "p2"]) });
  const before = P.store.get("chalk.v1");
  assert.ok((await P.M.cloud.join(code)).ok);
  assert.strictEqual(P.M.cloud.undoInfo(), null, "nothing to undo yet");
  assert.strictEqual(await P.M.cloud.restoreTraining(), true);
  assert.strictEqual(P.train().log.length, 3, "restored");
  assert.strictEqual(P.store.get("chalk.sync.restored"), "3", "one-time note for the toast");
  const u = P.M.cloud.undoInfo();
  assert.ok(u && u.n === 2 && u.pid === "nick" && u.at > 0, JSON.stringify(u));
  assert.strictEqual(JSON.parse(P.store.get("chalk.sync.undo")).raw, before, "the replaced training, byte for byte");
  assert.strictEqual(P.M.cloud.takeRestored(), 3);
  assert.strictEqual(P.M.cloud.takeRestored(), null, "only once");
  /* Undo: the phone's own 2 workouts come back, and nothing overwrites the cloud copy */
  P.ctx.S.active = { name: "Legs" };
  assert.strictEqual(P.M.cloud.undoRestore(), false, "not mid-workout");
  P.ctx.S.active = null;
  const reloads = P.ctx.location.reloads;
  assert.strictEqual(P.M.cloud.undoRestore(), true);
  assert.strictEqual(P.ctx.location.reloads, reloads + 1, "page reloads");
  assert.strictEqual(P.store.get("chalk.v1"), before, "back to what it was");
  assert.strictEqual(P.M.cloud.undoInfo(), null);
  assert.ok((await P.sync()).ok);
  assert.deepStrictEqual(trainOf(SERVER.get(code, "train", "nick")).log.map(x => x.id), ["w1", "w2", "w3"], "backup untouched after Undo");
  assert.strictEqual(P.M.cloud.training().missing, 3, "and Restore is still offered");
  /* the Undo copy expires after a week */
  assert.strictEqual(await P.M.cloud.restoreTraining(), true);
  const real = Date.now;
  P.M.now = () => real() + 8 * DAY;
  assert.strictEqual(P.M.cloud.undoInfo(), null, "gone after 7 days");
  P.M.now = () => Date.now();
  O.M.cloud.leave(); P.M.cloud.leave();
});

t("mid-workout training uploads wait (10 min); Sync now sends them", async () => {
  const P = phone("gym", { train: trainState("nick", ["g1"]) });
  assert.ok((await P.M.cloud.join(CODE)).ok);
  /* this phone's history lacks w1..w4, so give it a superset to be allowed to back up */
  const cloud = trainOf(SERVER.get(CODE, "train", "nick"));
  const tr = cloud; tr.active = { name: "Push day", start: Date.now() }; tr.updatedAt = Date.now(); P.setTrain(tr);
  await P.M.cloud._.cycle({ reason: "tick" });
  const first = SERVER.get(CODE, "train", "nick");
  assert.ok(trainOf(first).active, "first mid-workout upload goes (nothing sent yet)");
  tr.log.unshift({ id: "g2", name: "Push", start: Date.now(), sets: {} }); tr.updatedAt = Date.now() + 1; P.setTrain(tr);
  await P.M.cloud._.cycle({ reason: "tick" });
  assert.strictEqual(SERVER.get(CODE, "train", "nick").updated_at, first.updated_at, "second one waits");
  await P.M.cloud.syncNow();
  assert.strictEqual(trainOf(SERVER.get(CODE, "train", "nick")).log[0].id, "g2", "Sync now sends it");
  /* workout finished → no throttle */
  tr.active = null; tr.updatedAt = Date.now() + 2; P.setTrain(tr);
  await P.M.cloud._.cycle({ reason: "tick" });
  assert.strictEqual(trainOf(SERVER.get(CODE, "train", "nick")).active, null);
  P.M.cloud.leave();
});

t("offline: data stays, the error is plain, the retry succeeds later", async () => {
  A.offline(true);
  A.M.foods.add({ name: "White onion" });
  const r = await A.sync();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Can't reach the internet/);
  const st = A.M.cloud.status();
  assert.match(st.lastError, /Can't reach the internet/);
  assert.ok(st.pending >= 1, "changes waiting: " + st.pending);
  assert.ok(foodNames(A).includes("White onion"), "kept locally");
  assert.ok(JSON.parse(A.store.get("chalk.macros.v1")).foods && Object.values(JSON.parse(A.store.get("chalk.macros.v1")).foods).some(f => f.name === "White onion"));
  assert.ok(!SERVER.all(CODE).some(x => x.kind === "food" && /White onion/.test(x.data)));
  /* back online: the browser's "online" event retries on its own */
  A.offline(false);
  A.fire("online");
  for (let i = 0; i < 50 && !SERVER.all(CODE).some(x => x.kind === "food" && /White onion/.test(x.data)); i++) await sleep(20);
  assert.ok(SERVER.all(CODE).some(x => x.kind === "food" && /White onion/.test(x.data)), "sent after coming back");
  await sleep(30);
  assert.strictEqual(A.M.cloud.status().lastError, "", "error cleared");
  await B.sync();
  assert.ok(foodNames(B).includes("White onion"));
  /* server trouble reads plainly too */
  SERVER.failNext = 503;
  const r2 = await A.sync();
  assert.strictEqual(r2.error, "The cloud is having trouble. We'll try again soon.", "plain words, no codes");
  assert.ok((await A.sync()).ok);
});

t("a saved change goes up 1.5 s later on its own", async () => {
  const id = Object.values(A.M.MS.foods).find(f => f.name === "Sweet onion").id;
  A.M.foods.update(id, { name: "Sweet onion (Costco)" });
  await sleep(900);
  assert.ok(!/Costco/.test(SERVER.get(CODE, "food", id).data), "not before the delay");
  await sleep(1100);
  assert.ok(/Costco/.test(SERVER.get(CODE, "food", id).data), "pushed after ~1.5 s");
  /* a save that only touched this phone's UI state (Train | Macros) sends nothing */
  const n = A.reqs.length;
  A.M.setMode("macros"); A.M.setMode("train");
  await sleep(1700);
  assert.strictEqual(A.reqs.length, n, "no request for a mode switch");
  /* coming back to the app pulls */
  B.visibility("hidden"); B.visibility("visible");
  for (let i = 0; i < 50 && B.M.MS.foods[id].name !== "Sweet onion (Costco)"; i++) await sleep(20);
  assert.strictEqual(B.M.MS.foods[id].name, "Sweet onion (Costco)", "pulled on visible");
});

t("paging: 650 new foods cross page and same-timestamp boundaries and all arrive", async () => {
  for (let i = 0; i < 650; i++) A.M.MS.foods["bulk" + i] = { id: "bulk" + i, name: "Bulk food " + i, brand: "", barcode: "", source: "custom", serving: { qty: 1, unit: "serving", g: null }, per: { cal: i, p: 0, c: 0, f: 0, fiber: 0, sugar: 0, sodium: 0 }, per100g: null, alts: [], createdAt: 1, updatedAt: Date.now(), uses: 0, lastUsed: 0, pid: "nick" };
  A.M.save();
  const posts0 = A.posts().length;
  assert.ok((await A.sync()).ok);
  const newPosts = A.posts().slice(posts0);
  assert.ok(newPosts.length >= 4, "chunked: " + newPosts.length);
  newPosts.forEach(p => assert.ok(JSON.parse(p.body).length <= 200, "≤ 200 rows per request"));
  const G = phone("pager", { S: { profile: "kat", active: null } });
  assert.ok((await G.M.cloud.join(CODE)).ok);
  const bulk = Object.keys(G.M.MS.foods).filter(k => k.startsWith("bulk"));
  assert.strictEqual(bulk.length, 650, "all 650 arrived");
  const pages = G.gets().filter(g => /updated_at=gt\./.test(g.url));
  assert.ok(pages.length >= 2, "more than one page");
  pages.forEach(g => assert.ok(/updated_at=gt\.[^&]*%3A/.test(g.url), "cursor is URL-encoded"));
  /* prove the group read: page 1 was full and ended inside one request's timestamp group; that
     whole group was then read by its own timestamp before the cursor moved past it */
  const served = SERVER.log.filter(e => e.method === "GET" && e.hh === CODE && e.ts && /updated_at=(gt|eq)/.test(e.query));
  const i = served.findIndex(e => e.n === 500 && /updated_at=gt/.test(e.query));
  assert.ok(i >= 0 && served[i + 1], "a full page was served");
  const tail = served[i].ts[499];
  const inGroup = SERVER.all(CODE).filter(r => r.updated_at === tail).length;
  assert.ok(served[i].ts.filter(x => x === tail).length < inGroup, "page 1 cut a group short");
  assert.ok(/updated_at=eq\./.test(served[i + 1].query) && /offset=0/.test(served[i + 1].query), "then the group by its timestamp: " + served[i + 1].query);
  assert.strictEqual(served[i + 1].n, inGroup, "the whole group came back");
  assert.ok((await B.sync()).ok);
  assert.strictEqual(Object.keys(B.M.MS.foods).filter(k => k.startsWith("bulk")).length, 650);
  G.M.cloud.leave();
});

t("a row that commits late (inside the overlap window) is still pulled", async () => {
  A.M.foods.add({ name: "Fresh row" }); await A.sync();
  await B.sync();
  const cursor = B.M.cloud._.state().cursor;
  SERVER.lateInsert({ household: CODE, kind: "food", id: "late1", data: { id: "late1", name: "Late carrots", per: { cal: 25 }, updatedAt: Date.now() }, deleted: false, client_updated: Date.now(), device: "x" }, 3000);
  assert.ok(tsVal(SERVER.get(CODE, "food", "late1").updated_at) < tsVal(cursor), "stamped before B's cursor");
  await B.sync();
  assert.ok(B.M.MS.foods.late1, "late row pulled");
});

t("hasTrainingBackup is false when the cloud has none for this person", async () => {
  const P = phone("zed", { S: { profile: "zed", active: null } });   /* no Chalk training saved on this phone */
  assert.ok((await P.M.cloud.join(CODE)).ok);
  assert.ok(!SERVER.get(CODE, "train", "zed"));
  assert.strictEqual(await P.M.cloud.hasTrainingBackup(), false);
  assert.strictEqual(P.M.cloud.training(), null);
  assert.strictEqual(await P.M.cloud.restoreTraining(), false);
  assert.strictEqual(P.ctx.location.reloads, 0);
  P.M.cloud.leave();
});

t("a default profile never overwrites a real one", async () => {
  /* a new phone that once showed Nick's defaults joins: it takes the real profile */
  const P = phone("defaults", { S: { profile: "kat", active: null } });
  P.M.person("nick"); P.M.save();
  assert.strictEqual(P.M.MS.profiles.nick.setupAt, null);
  assert.ok((await P.M.cloud.join(CODE)).ok);
  assert.strictEqual(P.M.MS.profiles.nick.weightLb, 185, "real profile won");
  assert.strictEqual(JSON.parse(SERVER.get(CODE, "profile", "nick").data).weightLb, 185, "cloud still real");
  P.M.cloud.leave();
  /* Katerina's real profile vs a default one on Nick's phone from before she ever joined */
  const H2 = phone("h2-nick", {});
  seedNick(H2);
  H2.M.person("kat"); H2.M.save();
  const code2 = H2.M.cloud.create(); await H2.sync();
  assert.ok(!SERVER.get(code2, "profile", "kat"), "a profile nobody set up never goes up");
  assert.ok(SERVER.get(code2, "profile", "nick"), "a real one does");
  /* an older app did push one, and later than her last edit */
  const K = phone("h2-kat", { S: { profile: "kat", active: null } });
  const kp = K.M.person("kat"); Object.assign(kp, { sex: "f", age: 36, heightIn: 65, weightLb: 135, setupAt: Date.now() - 90 * DAY, lastBody: Date.now() - 20 * DAY, updatedAt: Date.now() - 20 * DAY }); K.M.save();
  const dflt = J(H2.M.MS.profiles.kat); dflt.updatedAt = Date.now();
  SERVER.put({ household: code2, kind: "profile", id: "kat", data: dflt, client_updated: Date.now(), device: "old-app" });
  assert.ok((await K.M.cloud.join(code2)).ok);
  assert.strictEqual(K.M.MS.profiles.kat.weightLb, 135, "her phone kept hers");
  assert.strictEqual(JSON.parse(SERVER.get(code2, "profile", "kat").data).weightLb, 135, "cloud now has hers");
  await H2.sync();
  assert.strictEqual(H2.M.MS.profiles.kat.weightLb, 135, "Nick's phone took hers");
  /* and a default arriving later on a phone that already agreed on her real one changes nothing there */
  SERVER.put({ household: code2, kind: "profile", id: "kat", data: dflt, client_updated: Date.now() + 1000, device: "old-app" });
  await K.sync();
  assert.strictEqual(K.M.MS.profiles.kat.weightLb, 135, "still hers");
  assert.strictEqual(JSON.parse(SERVER.get(code2, "profile", "kat").data).weightLb, 135, "and hers went back up");
  H2.M.cloud.leave(); K.M.cloud.leave();
});

t("a new phone's first-day setup never overwrites real targets (BES-01)", async () => {
  /* Nick's real profile: manual targets, set up days ago */
  const P = phone("bes01-old", {});
  seedNick(P);
  const p = P.M.person("nick"); p.targetsManual = true; p.targets = { cal: 2350, p: 210, c: 190, f: 70, fiber: 35, water: 120 }; p.updatedAt = Date.now() - 3 * DAY; P.M.save();
  const code = P.M.cloud.create(); assert.ok((await P.sync()).ok);
  /* new iPhone: Nick fills in the first-day setup (what the Diary shows first), THEN joins */
  const F = phone("bes01-new", { train: trainState("nick", []) });
  const f = F.M.person("nick");
  Object.assign(f, { sex: "m", age: 40, heightIn: 71, weightLb: 186, goalWeightLb: null, activity: "moderate", pace: 0, targetsManual: false, updatedAt: Date.now() });
  F.M.calc.applyTargets(f); F.M.checkins.done("nick", "setup"); F.M.save();
  assert.ok(F.M.MS.profiles.nick.setupAt > 0, "new phone was set up");
  assert.ok((await F.M.cloud.join(code)).ok);
  assert.strictEqual(F.M.MS.profiles.nick.targets.cal, 2350, "new phone took the real targets");
  assert.strictEqual(F.M.MS.profiles.nick.targetsManual, true);
  const cloudP = JSON.parse(SERVER.get(code, "profile", "nick").data);
  assert.strictEqual(cloudP.targets.cal, 2350, "cloud kept the real targets"); assert.strictEqual(cloudP.targetsManual, true);
  await P.sync();
  assert.strictEqual(P.M.MS.profiles.nick.targets.cal, 2350, "old phone unchanged");
  /* after joining, an edit on the new phone is a real edit and goes everywhere */
  F.M.person("nick").targets.cal = 2400; F.M.person("nick").updatedAt = Date.now(); F.M.save();
  await F.sync(); await P.sync();
  assert.strictEqual(P.M.MS.profiles.nick.targets.cal, 2400);
  P.M.cloud.leave(); F.M.cloud.leave();
});

t("a row the server rejects is skipped; the rest still sync", async () => {
  SERVER.reject = r => r.kind === "food" && /REJECT/.test(JSON.stringify(r.data));
  A.M.foods.add({ name: "REJECT me" });
  A.M.foods.add({ name: "Broccoli crowns" });
  const r = await A.sync();
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(SERVER.all(CODE).some(x => /Broccoli crowns/.test(x.data)), "good row saved");
  assert.ok(!SERVER.all(CODE).some(x => /REJECT/.test(x.data)));
  assert.strictEqual(A.M.cloud.status().lastError, "1 item isn't backed up yet. We'll keep trying.");
  assert.strictEqual(A.M.cloud.status().stuck, 1);
  assert.ok(A.M.cloud.status().pending >= 1, "still counted as waiting");
  /* background syncs don't hammer it; the line stays */
  const n = A.posts().length;
  await A.M.cloud._.cycle({ reason: "tick" });
  assert.strictEqual(A.posts().length, n, "not retried on every tick");
  assert.strictEqual(A.M.cloud.status().lastError, "1 item isn't backed up yet. We'll keep trying.", "the line lasts");
  /* Sync now tries it again, alone */
  await A.sync();
  assert.strictEqual(A.posts().length, n + 1);
  assert.strictEqual(JSON.parse(A.posts()[n].body).length, 1);
  assert.strictEqual(A.M.cloud.status().stuck, 1);
  /* once the server takes it, it's up and the line clears */
  SERVER.reject = null;
  assert.ok((await A.sync()).ok);
  assert.ok(SERVER.all(CODE).some(x => /REJECT/.test(x.data)));
  assert.strictEqual(A.M.cloud.status().lastError, ""); assert.strictEqual(A.M.cloud.status().stuck, 0);
});

t("a full phone keeps pulled data in memory and never records it as saved", async () => {
  const P = phone("full-phone", { S: { profile: "kat", active: null } });
  assert.ok((await P.M.cloud.join(CODE)).ok);
  const food = A.M.foods.add({ name: "Storage test food" });
  await A.sync();
  P.storageFull("chalk.macros.v1", true);
  const r = await P.sync();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /storage is full/);
  assert.ok(P.M.MS.foods[food.id], "in memory");
  const disk = () => JSON.parse(P.store.get("chalk.sync.v1"));
  assert.strictEqual(disk().hashes["food|" + food.id], undefined, "sync state on disk doesn't claim it");
  assert.ok(!JSON.parse(P.store.get("chalk.macros.v1")).foods[food.id], "not on disk");
  /* still full: a second sync re-reads the row (already in memory) and must still not claim it */
  const r2 = await P.sync();
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(disk().hashes["food|" + food.id], undefined);
  /* space is back */
  P.storageFull("chalk.macros.v1", false);
  assert.ok((await P.sync()).ok);
  assert.ok(JSON.parse(P.store.get("chalk.macros.v1")).foods[food.id], "on disk now");
  assert.ok(disk().hashes["food|" + food.id], "and recorded");
  /* nothing was deleted anywhere along the way */
  assert.strictEqual(SERVER.get(CODE, "food", food.id).deleted, false);
  P.M.cloud.leave();
});

t("remote changes re-render once, but never while someone is typing", async () => {
  const input = { tagName: "INPUT", _blur: [], addEventListener(t, fn) { if (t === "blur") this._blur.push(fn); } };
  B.ctx.document.activeElement = input;
  B.ctx.document._app = { contains: el => el === input };
  const before = B.M.ui.renders;
  A.M.foods.add({ name: "Carrots (bag)" });
  await A.sync(); await B.sync();
  assert.ok(foodNames(B).includes("Carrots (bag)"));
  assert.strictEqual(B.M.ui.renders, before, "held while typing");
  input._blur.forEach(fn => fn());
  await sleep(5);
  assert.strictEqual(B.M.ui.renders, before + 1, "rendered after the field lost focus");
  B.ctx.document.activeElement = null;
});

t("JWT keys also send Authorization; a bad key reads plainly", async () => {
  const P = phone("jwt", { key: JWT_KEY, S: { profile: "kat", active: null } });
  assert.ok((await P.M.cloud.join(CODE)).ok);
  assert.strictEqual(P.reqs[0].headers.Authorization, "Bearer " + JWT_KEY);
  P.M.cloud.configure({ key: "wrong" });
  const r = await P.sync();
  assert.strictEqual(r.error, "The cloud didn't let this phone in. We'll try again later.", "no codes, no rejoin advice");
  P.M.cloud.leave();
});

t("Erase everything (M.reset) leaves the household and keeps the cloud copy", async () => {
  const P = phone("wiper", { S: { profile: "kat", active: null } });
  assert.ok((await P.M.cloud.join(CODE)).ok);
  const rows = SERVER.all(CODE).length, deleted = SERVER.all(CODE).filter(x => x.deleted).length;
  const n = P.reqs.length;
  P.M.reset();
  assert.strictEqual(P.M.cloud.status().on, false, "sync off");
  assert.strictEqual(Object.keys(P.M.MS.foods).length, 0, "phone wiped");
  P.M.foods.add({ name: "after wipe" });
  await sleep(1700);
  assert.strictEqual(P.reqs.length, n, "no requests after the wipe");
  assert.strictEqual(SERVER.all(CODE).length, rows);
  assert.strictEqual(SERVER.all(CODE).filter(x => x.deleted).length, deleted, "no tombstones from the wipe");
  assert.strictEqual(JSON.parse(P.store.get("chalk.sync.v1")).code, "");
});

t("Turn off sync keeps local data and stops all requests", async () => {
  const C = phone("leaver", { S: { profile: "kat", active: null } });
  assert.ok((await C.M.cloud.join(CODE)).ok);
  const count = Object.keys(C.M.MS.foods).length;
  assert.strictEqual(C.M.cloud.leave(), true);
  assert.strictEqual(C.M.cloud.status().on, false);
  assert.strictEqual(Object.keys(C.M.MS.foods).length, count, "data stays");
  const n = C.reqs.length;
  C.M.foods.add({ name: "offline food" });
  C.visibility("hidden"); C.visibility("visible");
  await sleep(1700);
  assert.strictEqual(C.reqs.length, n);
  assert.strictEqual((await C.M.cloud.syncNow()).ok, false);
  const again = await C.M.cloud.join(CODE);
  assert.ok(again.ok, "can join again");
  C.M.cloud.leave();
});

/* ------------------------------------------------ fixes from the sync review */
function household(name, o) {
  const P = phone(name, o || {});
  seedNick(P);
  const code = P.M.cloud.create();
  return P.sync().then(r => { assert.ok(r.ok, JSON.stringify(r)); return { P, code }; });
}
const katPhone = (name, extra) => {
  const K = phone(name, Object.assign({ S: { profile: "kat", active: null } }, extra || {}));
  const kp = K.M.person("kat"); Object.assign(kp, { sex: "f", age: 36, heightIn: 65, weightLb: 135, setupAt: Date.now() - DAY, lastBody: Date.now(), updatedAt: Date.now() - DAY }); K.M.calc.applyTargets(kp);
  for (let i = 0; i < 3; i++) K.M.log.add(K.M.addDays(K.M.today(), -i), { slot: "Dinner", name: "Kat dinner", per: { cal: 500, p: 40, c: 50, f: 15 } });
  K.M.body.add({ date: K.M.today(), w: 135, pid: "kat" });
  K.M.save();
  return K;
};
const rowsOf = (P, coll, pid) => Object.keys(P.M.MS[coll]).filter(k => k.startsWith(pid + "|"));

t("each phone keeps only its own person's diary and weigh-ins; switching person pulls theirs (BES-03)", async () => {
  const { P: N, code } = await household("bes03-nick");
  const K = katPhone("bes03-kat");
  assert.ok((await K.M.cloud.join(code)).ok);
  assert.ok((await N.sync()).ok);
  assert.strictEqual(rowsOf(K, "days", "nick").length + rowsOf(K, "body", "nick").length, 0, "Nick's rows stay off her phone");
  assert.strictEqual(rowsOf(N, "days", "kat").length + rowsOf(N, "body", "kat").length, 0, "hers stay off his");
  assert.strictEqual(SERVER.all(code).filter(r => r.kind === "day").length, 8, "both diaries are in the cloud");
  /* a phone from before this change holds both people's rows (in sync): the other person's leave it */
  const st = N.M.cloud._.state();
  rowsOf(K, "days", "kat").forEach(id => { N.M.MS.days[id] = J(K.M.MS.days[id]); st.hashes["day|" + id] = N.M.cloud._.hash(N.M.MS.days[id]); });
  rowsOf(K, "body", "kat").forEach(id => { N.M.MS.body[id] = J(K.M.MS.body[id]); st.hashes["body|" + id] = N.M.cloud._.hash(N.M.MS.body[id]); });
  N.M.save();
  assert.ok((await N.sync()).ok);
  assert.strictEqual(rowsOf(N, "days", "kat").length + rowsOf(N, "body", "kat").length, 0, "her rows left his phone");
  const disk = JSON.parse(N.store.get("chalk.sync.v1"));
  assert.ok(!Object.keys(disk.hashes).some(k => /\|kat\|/.test(k)), "and so did their sync memory");
  assert.ok(SERVER.all(code).filter(r => /^kat\|/.test(r.id)).every(r => r.deleted === false), "never deleted in the cloud");
  await K.sync();
  assert.strictEqual(rowsOf(K, "days", "kat").length, 3, "her phone still has them");
  /* Nick's phone switches to Katerina: her rows come down, his leave (they're in the cloud) */
  N.ctx.S.profile = "kat";
  assert.ok((await N.sync()).ok);
  assert.strictEqual(rowsOf(N, "days", "kat").length, 3, "her diary arrived");
  assert.strictEqual(rowsOf(N, "body", "kat").length, 1, "her weigh-in too");
  assert.strictEqual(rowsOf(N, "days", "nick").length, 0, "his left the phone");
  assert.ok(SERVER.all(code).every(r => r.deleted === false), "nothing deleted anywhere");
  /* and back */
  N.ctx.S.profile = "nick";
  assert.ok((await N.sync()).ok);
  assert.strictEqual(rowsOf(N, "days", "nick").length, 5, "his diary is back");
  assert.strictEqual(rowsOf(N, "days", "kat").length, 0);
  assert.ok(SERVER.all(code).every(r => r.deleted === false));
  N.M.cloud.leave(); K.M.cloud.leave();
});

t("a row that keeps failing (409 / 5xx) is found and set aside; the rest go up, training first (BES-04/05)", async () => {
  const { P, code } = await household("bes04", { train: trainState("nick", ["w1"]) });
  for (let i = 0; i < 250; i++) P.M.MS.foods["e1_" + i] = { id: "e1_" + i, name: "E1 food " + i, brand: "", barcode: "", source: "custom", serving: { qty: 1, unit: "serving", g: null }, per: { cal: i, p: 0, c: 0, f: 0, fiber: 0, sugar: 0, sodium: 0 }, per100g: null, alts: [], createdAt: 1, updatedAt: Date.now(), uses: 0, lastUsed: 0, pid: "nick" };
  P.M.foods.add({ name: "Poison 409 food" });
  const tr = P.train(); tr.log.unshift({ id: "w2", name: "new", start: Date.now(), sets: {} }); tr.updatedAt = Date.now(); P.setTrain(tr);
  SERVER.hook = (req, e, body) => (req.method === "POST" && /Poison 409/.test(body) ? { status: 409, body: { code: "23505", message: "duplicate key" } } : null);
  const r1 = await P.sync();
  assert.strictEqual(trainOf(SERVER.get(code, "train", "nick")).log.length, 2, "training went up first, on its own");
  assert.strictEqual(r1.ok, false, "one chunk failed once: try again");
  const r2 = await P.sync();
  assert.ok(r2.ok, JSON.stringify(r2));
  assert.strictEqual(SERVER.all(code).filter(x => /^e1_/.test(x.id)).length, 250, "all 250 other foods are up");
  const s = P.M.cloud.status();
  assert.strictEqual(s.lastError, "1 item isn't backed up yet. We'll keep trying.");
  assert.strictEqual(s.stuck, 1); assert.ok(s.pending >= 1);
  /* the server is down for everything: nothing is set aside, it just waits */
  SERVER.hook = (req) => (req.method === "POST" ? { status: 503, body: { message: "down" } } : null);
  const f2 = P.M.foods.add({ name: "During the outage" });
  for (let i = 0; i < 4; i++) await P.sync();
  assert.ok(!P.M.cloud._.state().bad["food|" + f2.id], "an outage never sets rows aside");
  /* server fixed: everything goes up and the line clears */
  SERVER.hook = null;
  assert.ok((await P.sync()).ok);
  assert.ok(SERVER.all(code).some(x => /Poison 409/.test(x.data)) && SERVER.get(code, "food", f2.id));
  assert.strictEqual(P.M.cloud.status().lastError, ""); assert.strictEqual(P.M.cloud.status().stuck, 0);
  P.M.cloud.leave();
});

t("the cloud lost the household: Sync now notices and sends everything again (BES-06)", async () => {
  const { P, code } = await household("bes06");
  const n = SERVER.all(code).length;
  for (const k of [...SERVER.rows.keys()]) if (k.startsWith(code + "|")) SERVER.rows.delete(k);
  /* background syncs check only once per start and per day */
  const g0 = P.gets().length;
  await P.M.cloud._.cycle({ reason: "tick" });
  assert.ok(!P.gets().slice(g0).some(g => /kind=eq\.meta/.test(g.url)), "no check on a background sync");
  const r = await P.sync();
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(SERVER.all(code).length, n, "everything is back in the cloud");
  const C = phone("bes06-new", { S: { profile: "kat", active: null } });
  assert.ok((await C.M.cloud.join(code)).ok, "and another phone can join");
  assert.strictEqual(Object.keys(C.M.MS.foods).length, 3);
  P.M.cloud.leave(); C.M.cloud.leave();
});

t("Turn off, then join again: what the other phone deleted meanwhile stays deleted (BES-07)", async () => {
  const { P: N, code } = await household("bes07-nick");
  const K = phone("bes07-kat", { S: { profile: "kat", active: null } });
  assert.ok((await K.M.cloud.join(code)).ok);
  const meal = Object.values(N.M.MS.meals).find(m => m.name === "Pork tenderloin plate");
  const food = Object.values(N.M.MS.foods).find(f => /Zucchini/.test(f.name));
  K.M.cloud.leave();
  assert.ok(K.M.cloud._.state().prev && K.M.cloud._.state().prev.code === code, "Turn off remembers what it agreed on");
  N.M.meals.remove(meal.id); N.M.foods.remove(food.id);
  assert.ok((await N.sync()).ok);
  assert.ok((await K.M.cloud.join(code)).ok);
  assert.ok(!K.M.MS.meals[meal.id] && !K.M.MS.foods[food.id], "gone on the rejoined phone");
  await N.sync();
  assert.ok(!N.M.MS.meals[meal.id] && !N.M.MS.foods[food.id], "and not brought back to the other one");
  assert.strictEqual(SERVER.get(code, "meal", meal.id).deleted, true);
  /* with no memory of the household (older app): a delete newer than the phone's copy still wins */
  const bread = Object.values(N.M.MS.foods).find(f => /Dave/.test(f.name));
  K.M.cloud.leave(); K.M.cloud._.state().prev = null;
  N.M.foods.remove(bread.id); assert.ok((await N.sync()).ok);
  assert.ok((await K.M.cloud.join(code)).ok);
  assert.ok(!K.M.MS.foods[bread.id], "newer delete wins on a first join");
  await N.sync();
  assert.ok(!N.M.MS.foods[bread.id]);
  N.M.cloud.leave(); K.M.cloud.leave();
});

t("incoming rows are cleaned before they touch the phone (BES-08 / SEC-01 / BES-15)", async () => {
  const { P: N, code } = await household("bes08-nick");
  const K = katPhone("bes08-kat");
  assert.ok((await K.M.cloud.join(code)).ok);
  const ts = new Date().toISOString();
  const bad = [
    "null", "5", '"x"', '{"kind":"food"}',
    '{"kind":"food","id":"__proto__","data":{"name":"x"},"deleted":false,"client_updated":1,"updated_at":"' + ts + '"}',
    '{"kind":"food","id":"polluter","data":{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"name":"Evil","per":{"cal":1,"__proto__":{"x":1}}},"deleted":false,"client_updated":1,"updated_at":"' + ts + '"}',
    '{"kind":"food","id":"badfood","data":{"name":42,"brand":{"x":1},"per":"lots"},"deleted":false,"client_updated":9e15,"updated_at":null}',
    '{"kind":"day","id":"kat|2026-09-20","data":{"entries":[null,{"per":null},7,{"name":"ok","per":{"cal":"120"},"slot":"Lunch"}],"water":"x"},"deleted":false,"client_updated":1,"updated_at":"infinity"}',
    '{"kind":"profile","id":"kat","data":{"targets":"high","setupAt":"yesterday","sex":"x"},"deleted":false,"client_updated":4000000000000,"updated_at":"2026-09-28 19:22:33.12+00 (UTC)"}',
    '{"kind":"profile","id":"zed","data":{"name":"Zed"},"deleted":false,"client_updated":1}',
    '{"kind":"day","id":"zed|2026-09-20","data":{"entries":[]},"deleted":false,"client_updated":1}',
    '{"kind":"meal","id":"m-bad","data":{"name":"Bad","items":"none"},"deleted":"false","client_updated":1}',
    '{"kind":"train","id":"kat","data":{"v":1,"json":"{not json"},"deleted":false}',
    '{"kind":"train","id":"kat","data":{"v":1,"json":' + JSON.stringify('{"v":1,"profile":"kat","log":[],"__proto__":{"polluted":1}}') + '},"deleted":false}',
    '{"household":"ZZZZZZZZZZZZZZZZZZZZ","kind":"food","id":"foreign","data":{"name":"Not ours"},"deleted":false,"client_updated":1}',
    '{"kind":"body","id":"kat|2026-09-19","data":{"w":"135.5","rhr":"x"},"deleted":false,"client_updated":1}'
  ];
  let done = false;
  SERVER.mutate = (rows, e) => { if (done || e.hh !== code || !/updated_at=gt/.test(e.query)) return rows; done = true; return "[" + rows.map(r => JSON.stringify(r)).concat(bad).join(",") + "]"; };
  let threw = null, r = null;
  try { r = await K.sync(); } catch (e) { threw = e; }
  SERVER.mutate = null;
  assert.ok(!threw && r && r.ok, "sync took it calmly: " + JSON.stringify(r || threw));
  assert.strictEqual(vm.runInContext("({}).polluted", K.ctx), undefined, "no prototype pollution");
  assert.strictEqual(({}).polluted, undefined);
  const foods = K.M.MS.foods;
  assert.ok(!Object.prototype.hasOwnProperty.call(foods, "__proto__"), "no __proto__ record");
  assert.strictEqual(foods.polluter.name, "Evil"); assert.strictEqual(foods.polluter.per.cal, 1);
  assert.ok(!Object.keys(foods.polluter).some(k => k === "__proto__" || k === "constructor"), "bad keys dropped");
  assert.strictEqual(foods.badfood.name, "42"); assert.strictEqual(foods.badfood.brand, ""); assert.strictEqual(foods.badfood.per.cal, 0);
  const day = K.M.MS.days["kat|2026-09-20"];
  assert.strictEqual(day.entries.length, 2, "null and 7 dropped"); assert.strictEqual(day.entries[1].per.cal, 120);
  assert.ok(day.entries.every(e => typeof e.id === "string" && K.M.isSlot(e.slot)));
  assert.strictEqual(day.water, 0);
  assert.strictEqual(K.M.MS.profiles.kat.weightLb, 135, "a broken profile never replaces a real one");
  assert.ok(!K.M.MS.profiles.zed && !K.M.MS.days["zed|2026-09-20"], "only nick and kat");
  assert.deepStrictEqual(J(K.M.MS.meals["m-bad"].items), []);
  assert.strictEqual(K.M.MS.body["kat|2026-09-19"].w, 135.5); assert.strictEqual(K.M.MS.body["kat|2026-09-19"].rhr, null);
  assert.ok(!foods.foreign, "never another household's row");
  assert.strictEqual(K.M.cloud._.state().train.kat, undefined, "broken training copies ignored");
  /* the app still works on top of it */
  K.M.foods.list(); K.M.meals.list(); K.M.log.totals("2026-09-20", "kat"); K.M.person("kat"); K.M.checkins.due("kat");
  /* the cursor only moved to a time it can read, and the next sync works */
  const cur = K.M.cloud._.state().cursor;
  assert.ok(isFinite(tsVal(cur)) && tsVal(cur) / 1000 < Date.now() + DAY, "cursor " + cur);
  N.M.foods.add({ name: "After the junk" }); await N.sync();
  assert.ok((await K.sync()).ok);
  assert.ok(Object.values(K.M.MS.foods).some(f => f.name === "After the junk"));
  /* a bad cursor saved on disk is dropped at the next start */
  const saved = JSON.parse(K.store.get("chalk.sync.v1")); saved.cursor = "infinity";
  const K2 = phone("bes08-relaunch", { S: { profile: "kat", active: null }, store: Object.assign(Object.fromEntries(K.store), { "chalk.sync.v1": JSON.stringify(saved) }) });
  K.M.cloud.leave();
  assert.strictEqual(K2.M.cloud._.state().cursor, "");
  assert.ok((await K2.sync()).ok);
  N.M.cloud.leave(); K2.M.cloud.leave();
});

t("the SQL file sets the table up safely (BES-09)", () => {
  const sql = fs.readFileSync(path.join(ROOT, "supabase", "chalk_sync.sql"), "utf8");
  const flat = sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");
  assert.ok(/create table if not exists public\.chalk_sync \(/.test(flat));
  assert.ok(flat.includes("household text not null check (household ~ '^[A-HJ-NP-Z2-9]{20}$')"), "household format");
  assert.ok(flat.includes("check (kind in ('food', 'meal', 'day', 'body', 'profile', 'train', 'meta'))"), "kinds");
  ["id text not null", "data jsonb not null", "deleted boolean not null", "client_updated bigint not null", "updated_at timestamptz not null", "primary key (household, kind, id)"].forEach(s => assert.ok(flat.includes(s), s));
  assert.ok(/device text not null default '' check \(char_length\(device\) <= 64\)/.test(flat), "device ≤ 64");
  assert.ok(/check \(octet_length\(data::text\) < 3000000\)/.test(flat), "data < 3 MB");
  assert.ok(/create or replace function public\.chalk_sync_stamp\(\) returns trigger language plpgsql set search_path = '' as \$\$ begin new\.updated_at := pg_catalog\.now\(\); return new; end; \$\$;/.test(flat), "stamp function, search_path set");
  assert.ok(/create trigger chalk_sync_stamp before insert or update on public\.chalk_sync for each row execute function public\.chalk_sync_stamp\(\);/.test(flat), "BEFORE INSERT OR UPDATE trigger");
  assert.ok(/create index if not exists \w+ on public\.chalk_sync \(household, updated_at/.test(flat), "index");
  assert.ok(/alter table public\.chalk_sync enable row level security;/.test(flat), "RLS on");
  const hdr = "household = coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-household', '')";
  assert.ok(flat.includes("for select to anon using (" + hdr + ")"), "select policy");
  assert.ok(flat.includes("for insert to anon with check (" + hdr + ")"), "insert policy");
  assert.ok(flat.includes("for update to anon using (" + hdr + ") with check (" + hdr + ")"), "update policy");
  assert.ok(!/for delete|for all|grant[^;]*delete/i.test(flat), "no delete");
  assert.ok(/grant select, insert, update on table public\.chalk_sync to anon;/.test(flat), "grants");
});

t("turn on checks the server stamps every write (BES-09)", async () => {
  const P = phone("bes09", {}); seedNick(P);
  /* a table with updated_at only as a column default: an update keeps the old time */
  SERVER.hook = (req, e, body) => {
    if (req.method !== "POST" || !/"kind":"meta"/.test(body)) return null;
    const hh = req.headers["x-household"], old = SERVER.get(hh, "meta", "household");
    if (!old) return null;
    const keep = { _us: old._us, updated_at: old.updated_at };
    setTimeout(() => Object.assign(SERVER.get(hh, "meta", "household"), keep), 0);
    return null;
  };
  const code = P.M.cloud.create();
  const r = await P.sync();
  SERVER.hook = null;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "The cloud isn't set up right yet. We'll try again.");
  assert.ok(!SERVER.all(code).some(x => x.kind === "food"), "nothing else went up");
  assert.ok((await P.sync()).ok, "fixed server: works");
  P.M.cloud.leave();
});

t("Delete my cloud data, Change code, and the code stays out of URLs (SEC-03)", async () => {
  const { P: N, code } = await household("sec03-nick", { train: trainState("nick", ["w1"]) });
  assert.strictEqual(N.M.cloud.codeMasked(), code.slice(0, 4) + "-••••-••••-••••-••••");
  const K = katPhone("sec03-kat");
  assert.ok((await K.M.cloud.join(code)).ok);
  const kFoods = Object.keys(K.M.MS.foods).length;
  /* Change code: a new household gets everything; the old one is cleared; the other phone stops */
  const c = await N.M.cloud.changeCode();
  assert.ok(c.ok, JSON.stringify(c));
  assert.ok(CODE_RE.test(c.code) && c.code !== code);
  assert.strictEqual(N.M.cloud.status().code, c.code);
  const kinds = SERVER.all(c.code).filter(x => !x.deleted).reduce((o, x) => { o[x.kind] = (o[x.kind] || 0) + 1; return o; }, {});
  assert.deepStrictEqual(kinds, { food: 3, meal: 2, day: 5, body: 5, profile: 2, meta: 1, train: 1 }, "all of it in the new household");
  assert.ok(SERVER.all(code).every(x => x.deleted === true), "old household: every row marked deleted");
  assert.ok(SERVER.all(code).filter(x => x.kind !== "meta").every(x => x.data === "{}"), "and emptied");
  const kr = await K.sync();
  assert.strictEqual(kr.ok, false);
  assert.strictEqual(K.M.cloud.status().on, false);
  assert.strictEqual(K.M.cloud.status().note, "Sync is off. The other phone deleted the cloud copy or changed the code. Everything is still on this phone.");
  assert.strictEqual(Object.keys(K.M.MS.foods).length, kFoods, "her data stays");
  assert.ok((await K.M.cloud.join(c.code)).ok, "she joins with the new code");
  /* Delete my cloud data (offline first: it finishes when the phone is back online) */
  N.offline(true);
  const d = await N.M.cloud.deleteCloud();
  assert.strictEqual(d.ok, false); assert.strictEqual(d.later, true);
  assert.strictEqual(d.error, "Couldn't reach the cloud. We'll finish deleting when you're online.");
  assert.strictEqual(N.M.cloud.status().on, false, "sync is off on this phone right away");
  N.offline(false); N.fire("online");
  for (let i = 0; i < 100 && SERVER.all(c.code).some(x => !x.deleted); i++) await sleep(20);
  assert.ok(SERVER.all(c.code).every(x => x.deleted === true), "every row marked deleted");
  assert.ok(SERVER.all(c.code).filter(x => x.kind !== "meta").every(x => x.data === "{}"), "and emptied");
  assert.strictEqual(N.M.cloud.status().note, "Your cloud copy is deleted. Everything is still on this phone.");
  assert.strictEqual(Object.keys(N.M.MS.foods).length, 3, "this phone keeps everything");
  assert.strictEqual((await K.sync()).ok, false, "the other phone stops");
  assert.strictEqual(K.M.cloud.status().on, false);
  /* the household code never travelled in a URL, in any request of this whole run */
  const codes = new Set(SERVER.log.map(e => e.hh).filter(h => CODE_RE.test(h)));
  assert.ok(codes.size > 3);
  SERVER.log.forEach(e => codes.forEach(h => assert.ok(e.query.indexOf(h) < 0, "code in a URL: " + e.query)));
});

t("smaller fixes: field merge, use counts, clock skew, Retry-After, duplicates on first join (P3)", async () => {
  const { P: N, code } = await household("p3-nick");
  const K = phone("p3-kat", { S: { profile: "kat", active: null } });
  assert.ok((await K.M.cloud.join(code)).ok);
  const fid = Object.values(N.M.MS.foods).find(f => /Zucchini/.test(f.name)).id;
  /* BES-10: two phones change different fields of one food: both changes are kept */
  N.offline(true); K.offline(true);
  N.M.foods.update(fid, { name: "Zucchini (Nick renamed)" });
  await sleep(5);
  K.M.foods.update(fid, { per: { cal: 30, p: 2, c: 5, f: 0.5 } });
  N.offline(false); K.offline(false);
  await N.sync(); await K.sync(); await N.sync();
  [N, K].forEach(P => { assert.strictEqual(P.M.MS.foods[fid].name, "Zucchini (Nick renamed)"); assert.strictEqual(P.M.MS.foods[fid].per.cal, 30); });
  /* BES-12: logging a food isn't an edit: it isn't sent, and it doesn't bring back a food the other phone deleted */
  const dup = N.M.foods.add({ name: "Old duplicate food", per: { cal: 50 } });
  await N.sync(); await K.sync();
  const posts = K.posts().length;
  K.M.log.add(K.M.today(), { slot: "Snacks", foodId: dup.id, servings: 1 });
  await K.sync();
  assert.ok(!K.posts().slice(posts).some(p => /Old duplicate food/.test(p.body) && /"kind":"food"/.test(p.body)), "no food upload for a use");
  K.offline(true);
  K.M.log.add(K.M.today(), { slot: "Snacks", foodId: dup.id, servings: 1 });
  N.M.foods.remove(dup.id);
  await N.sync(); K.offline(false); await K.sync(); await N.sync();
  assert.ok(!N.M.MS.foods[dup.id] && !K.M.MS.foods[dup.id], "stays deleted");
  /* BES-11: a phone whose clock runs an hour fast can't win with an edit it made earlier */
  const real = Date.now;
  K.M.now = () => real() + 3600e3;
  K.offline(true);
  K.M.foods.update(fid, { name: "Zucchini (Kat, earlier)" });
  await sleep(20);
  N.M.foods.update(fid, { name: "Zucchini (Nick, later)" });
  await N.sync(); K.offline(false); await K.sync(); await N.sync();
  assert.strictEqual(N.M.MS.foods[fid].name, "Zucchini (Nick, later)", "the later real edit wins on Nick's phone");
  assert.strictEqual(K.M.MS.foods[fid].name, "Zucchini (Nick, later)", "and on Kat's");
  K.M.now = () => Date.now();
  /* BES-13: Retry-After is respected; background syncs wait, Sync now doesn't */
  SERVER.failNext = 429; SERVER.retryAfter = 120;
  const r = await N.sync();
  SERVER.retryAfter = 0;
  assert.strictEqual(r.error, "The cloud is busy. We'll try again soon.");
  assert.ok(N.M.cloud._.state().retryAt >= Date.now() + 110e3, "waits as long as the server asked");
  const n = N.reqs.length;
  N.M.foods.add({ name: "While waiting" });
  await N.M.cloud._.cycle({ reason: "tick" }); await N.M.cloud._.cycle({ reason: "save" });
  assert.strictEqual(N.reqs.length, n, "background syncs wait");
  assert.ok((await N.sync()).ok, "Sync now goes right away");
  N.M.cloud.leave(); K.M.cloud.leave();
  /* BES-17: the same food and meal made on both phones before sync become one on the first join */
  const X = phone("p3-x", {}), Y = phone("p3-y", { S: { profile: "kat", active: null } });
  const food = { name: "Kirkland Organic Chicken Breast", brand: "Kirkland", barcode: "096619555555", serving: { qty: 4, unit: "oz", g: 112 }, per: { cal: 120, p: 26, c: 0, f: 1.5 } };
  X.M.foods.add(Object.assign({}, food)); const yf = Y.M.foods.add(Object.assign({}, food, { name: "kirkland organic chicken breast " }));
  X.M.meals.add({ name: "Chicken rice bowl", slot: "Lunch", items: [{ name: "Chicken", servings: 1, per: { cal: 120, p: 26, c: 0, f: 1.5 } }] });
  Y.M.meals.add({ name: "Chicken rice bowl", slot: "Lunch", items: [{ name: "Chicken", servings: 1, per: { cal: 120, p: 26, c: 0, f: 1.5 }, foodId: yf.id }] });
  Y.M.log.add(Y.M.today(), { slot: "Lunch", foodId: yf.id, servings: 1 });
  const c2 = X.M.cloud.create(); await X.sync(); assert.ok((await Y.M.cloud.join(c2)).ok); await X.sync();
  [X, Y].forEach(P => {
    assert.strictEqual(Object.values(P.M.MS.foods).filter(f => f.barcode === food.barcode).length, 1, "one food");
    assert.strictEqual(Object.values(P.M.MS.meals).filter(m => m.name === "Chicken rice bowl").length, 1, "one meal");
  });
  const keptId = Object.values(Y.M.MS.foods).find(f => f.barcode === food.barcode).id;
  assert.strictEqual(Y.M.MS.days["kat|" + Y.M.today()].entries[0].foodId, keptId, "her diary points at the kept food");
  X.M.cloud.leave(); Y.M.cloud.leave();
});

/* =================================================================== run */
(async () => {
  SERVER = mockServer();
  await new Promise(r => SERVER.server.listen(0, "127.0.0.1", r));
  URLBASE = "http://127.0.0.1:" + SERVER.server.address().port;
  let passed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log("  ok  " + name); }
    catch (e) { console.log("  FAIL " + name + "\n" + (e && e.stack || e)); process.exitCode = 1; break; }
  }
  [A, B].forEach(P => { try { P && P.M.cloud.leave(); } catch (e) {} });
  SERVER.server.close();
  console.log("\n" + passed + "/" + tests.length + " test groups passed");
})();
