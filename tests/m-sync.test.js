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
/* Tests always start from an empty config line (sync off) and point M.cloud at the mock with
   configure(); the shipped line may hold the real project URL + publishable key. */
const SB_LINE = /const SB_URL = "([^"]*)";(\s*)const SB_KEY = "([^"]*)";/;
const SYNC_SHIPPED = fs.readFileSync(path.join(ROOT, "m-sync.js"), "utf8");
const SRC = { core: fs.readFileSync(path.join(ROOT, "m-core.js"), "utf8"),
  sync: SYNC_SHIPPED.replace(SB_LINE, (all, u, sp) => 'const SB_URL = "";' + sp + 'const SB_KEY = "";') };
/* a new-style publishable key (not a JWT: apikey header only) and an old-style JWT anon key */
const KEY = "sb_publishable_T3stK3y_0123456789abcdefGHIJ", JWT_KEY = "eyJhbGciOiJIUzI1NiJ9.test.sig";
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
/* The mock is the Supabase gateway + PostgREST 12 in front of public.chalk_sync, as
   supabase/chalk_sync.sql sets it up. What it does like the real thing:
   - apikey header required (401 {message, hint}); a publishable key is not a JWT, so
     "Authorization: Bearer <non-JWT>" is refused (401 PGRST301). Old JWT keys may send Bearer.
   - CORS: OPTIONS preflights answered like the gateway (echoes the asked-for headers);
     every response carries Access-Control-Allow-Origin and PostgREST's exposed headers.
   - Row-level security by the x-household header for select / insert / update (no delete
     grant: DELETE → 401 42501). An insert for another household → 401 42501 (anon role).
   - Columns, types and checks from the SQL file: household format, kind list, id length,
     data jsonb not null and < 3 MB as jsonb text, deleted boolean, client_updated bigint,
     device ≤ 64. Errors come back in PostgREST's shape {code, details, hint, message}.
   - Upsert: POST ?on_conflict=household,kind,id + Prefer resolution=merge-duplicates.
     One statement: all rows or none. Only the columns sent are updated.
   - updated_at: the BEFORE INSERT OR UPDATE trigger stamps now() — ONE time per request
     (a transaction). srv.trigger = false simulates a table without the trigger.
   - Reads: select / eq / neq / gt / gte / lt / lte / like / in / is filters, order,
     limit / offset and the Range header, max rows 1000, Content-Range, jsonb key order. */
const COLS = ["household", "kind", "id", "data", "deleted", "client_updated", "device", "updated_at"];
const EXPOSE = "Content-Encoding, Content-Location, Content-Range, Content-Type, Date, Location, Server, Transfer-Encoding, Range-Unit";
const pgErr = (code, message, details, hint) => ({ code, details: details === undefined ? null : details, hint: hint === undefined ? null : hint, message });
const jsonbKeyCmp = (a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b));
function jsonbText(v) {   /* jsonb's text output: ", " and ": " separators, keys by length then bytes */
  if (v === null) return "null";
  if (Array.isArray(v)) return "[" + v.map(jsonbText).join(", ") + "]";
  if (typeof v === "object") return "{" + Object.keys(v).sort(jsonbKeyCmp).map(k => JSON.stringify(k) + ": " + jsonbText(v[k])).join(", ") + "}";
  return JSON.stringify(v);
}
function badText(s) {
  if (s.indexOf("\u0000") >= 0) return pgErr("22P05", "unsupported Unicode escape sequence", "\\u0000 cannot be converted to text.");
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/.test(s)) return pgErr("22P02", "invalid input syntax for type json", "Unicode low surrogate must follow a high surrogate.");
  return null;
}
function badJson(v, d) {
  if (typeof v === "string") return badText(v);
  if (!v || typeof v !== "object" || d > 200) return null;
  for (const k of Object.keys(v)) { const e = (Array.isArray(v) ? null : badText(k)) || badJson(v[k], (d || 0) + 1); if (e) return e; }
  return null;
}
const coll = new Intl.Collator("en-US");   /* en_US.UTF-8-like text order, bytes break ties */
const textCmp = (a, b) => coll.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
function mockServer() {
  const rows = new Map();          /* household|kind|id → row (data kept as JSON text) */
  const log = [];
  let lastUs = 0;
  const srv = { rows, log, reject: null, failNext: 0, retryAfter: 0, hook: null, mutate: null, trigger: true, maxRows: 1000, preflightFail: false,
    clock() { let us = Date.now() * 1000; if (us <= lastUs) us = lastUs + 1; lastUs = us; return us; },
    all(hh) { return [...rows.values()].filter(r => !hh || r.household === hh); },
    get(hh, kind, id) { return rows.get(hh + "|" + kind + "|" + id) || null; },
    /* a row whose transaction started `agoMs` ago but only commits now */
    lateInsert(row, agoMs) { const us = srv.clock() - agoMs * 1000; rows.set(row.household + "|" + row.kind + "|" + row.id, Object.assign({}, row, { data: JSON.stringify(row.data), _us: us, updated_at: pgTs(us) })); },
    /* a row written by someone else (another app version, a script): stamped now */
    put(row) { const us = srv.clock(); rows.set(row.household + "|" + row.kind + "|" + row.id, Object.assign({ deleted: false, client_updated: 0, device: "x" }, row, { data: typeof row.data === "string" ? row.data : JSON.stringify(row.data), _us: us, updated_at: pgTs(us) })); }
  };
  const send = (res, code, body, hdrs) => {
    res.writeHead(code, Object.assign({ "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-expose-headers": EXPOSE }, hdrs || {}));
    res.end(body == null ? "" : typeof body === "string" ? body : JSON.stringify(body));
  };
  const failing = r => "Failing row contains (" + [r.household, r.kind, r.id, r.data === null ? null : jsonbText(r.data), r.deleted === null ? null : r.deleted ? "t" : "f", r.client_updated, r.device, r.updated_at].map(v => (v === null || v === undefined ? "null" : String(v))).join(", ") + ").";
  /* a value for a column, the way json_to_recordset reads it */
  function coerce(col, v) {
    if (v === null || v === undefined) return null;
    const raw = typeof v === "string" ? v : JSON.stringify(v);
    if (col === "data") return v;
    if (col === "deleted") {
      if (typeof v === "boolean") return v;
      const s = raw.trim().toLowerCase();
      if (["t", "true", "y", "yes", "on", "1"].includes(s)) return true;
      if (["f", "false", "n", "no", "off", "0"].includes(s)) return false;
      throw pgErr("22P02", 'invalid input syntax for type boolean: "' + raw + '"');
    }
    if (col === "client_updated") {
      const s = raw.trim();
      if (typeof v === "object" || !/^[+-]?\d+$/.test(s)) throw pgErr("22P02", 'invalid input syntax for type bigint: "' + raw + '"');
      const n = Number(s);
      if (Math.abs(n) > 9223372036854775807) throw pgErr("22003", 'value "' + s + '" is out of range for type bigint');
      return n;
    }
    if (col === "updated_at") { const t = tsVal(raw); if (!isFinite(t)) throw pgErr("22007", 'invalid input syntax for type timestamp with time zone: "' + raw + '"'); return t; }
    const e = badText(raw); if (e) throw e;
    return raw;                                   /* text columns: strings as-is, anything else as its JSON text */
  }
  /* a filter value typed like its column; throws PostgREST / Postgres errors */
  function typed(col, s) {
    if (col === "updated_at") { const t = tsVal(s); if (!isFinite(t)) throw pgErr("22007", 'invalid input syntax for type timestamp with time zone: "' + s + '"'); return t; }
    if (col === "client_updated") { if (!/^[+-]?\d+$/.test(s.trim())) throw pgErr("22P02", 'invalid input syntax for type bigint: "' + s + '"'); return Number(s); }
    if (col === "deleted") return coerce("deleted", s);
    if (col === "data") throw pgErr("42883", "operator does not exist: jsonb = unknown", null, "No operator matches the given name and argument types. You might need to add explicit type casts.");
    return s;
  }
  const colVal = (r, c) => (c === "updated_at" ? r._us : c === "data" ? r.data : r[c]);
  const cmp = (c, a, b) => (a === b ? 0 : a === null || a === undefined ? 1 : b === null || b === undefined ? -1 : typeof a === "string" && c !== "data" ? textCmp(a, b) : a < b ? -1 : 1);
  const parseErr = (what, s) => pgErr("PGRST100", '"failed to parse ' + what + " (" + s + ')" (line 1, column 1)', "unexpected end of input", null);
  function filterRows(out, q) {
    for (const [k, v] of q) {
      if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(k)) continue;
      if (!COLS.includes(k)) throw pgErr("42703", "column chalk_sync." + k + " does not exist");
      const m = /^(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|in|is)\.([\s\S]*)$/.exec(v);
      if (!m) throw parseErr("filter", v);
      const [, neg, op, arg] = m;
      let test;
      if (op === "in") {
        if (!/^\(.*\)$/.test(arg)) throw parseErr("filter", v);
        const list = arg.slice(1, -1).split(",").map(x => typed(k, x.replace(/^"(.*)"$/, "$1")));
        test = r => list.some(x => cmp(k, colVal(r, k), x) === 0);
      } else if (op === "is") {
        if (!/^(null|true|false|unknown)$/.test(arg)) throw parseErr("filter", v);
        test = r => (arg === "null" ? colVal(r, k) == null : colVal(r, k) === (arg === "true"));
      } else if (op === "like" || op === "ilike") {
        const re = new RegExp("^" + arg.split("").map(ch => (ch === "*" || ch === "%" ? ".*" : ch === "_" ? "." : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("") + "$", op === "ilike" ? "is" : "s");
        test = r => colVal(r, k) != null && re.test(String(colVal(r, k)));
      } else {
        const x = typed(k, arg);
        test = r => { const c = cmp(k, colVal(r, k), x); return op === "eq" ? c === 0 : op === "neq" ? c !== 0 : op === "gt" ? c > 0 : op === "gte" ? c >= 0 : op === "lt" ? c < 0 : c <= 0; };
      }
      out = out.filter(r => (neg ? !test(r) : test(r)));
    }
    return out;
  }
  srv.server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      const hh = req.headers["x-household"] || "";
      const entry = { method: req.method, path: u.pathname, query: u.search, hh, probe: !!req.headers["x-test-probe"], apikey: req.headers.apikey, auth: req.headers.authorization || "", prefer: req.headers.prefer || "", n: 0,
        hdrs: Object.keys(req.headers).filter(h => !["host", "connection", "content-length", "accept", "accept-encoding", "accept-language", "sec-fetch-mode", "user-agent", "origin", "pragma", "cache-control"].includes(h)).sort() };
      log.push(entry);
      /* the gateway answers CORS preflights itself: any origin, the headers that were asked for */
      if (req.method === "OPTIONS") {
        if (srv.preflightFail) { res.writeHead(403, { "content-type": "text/plain" }); res.end("blocked"); return; }
        res.writeHead(200, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS,TRACE,CONNECT",
          "access-control-allow-headers": req.headers["access-control-request-headers"] || "", "access-control-max-age": "3600", "content-length": "0" });
        res.end(); return;
      }
      if (!/^\/rest\/v1\//.test(u.pathname)) return send(res, 404, { message: "no Route matched with those values" });
      /* the gateway: a known apikey, and a Bearer token only if it's a JWT */
      if (!req.headers.apikey) return send(res, 401, { message: "No API key found in request", hint: "No `apikey` request header or url param was found." });
      if (req.headers.apikey !== KEY && req.headers.apikey !== JWT_KEY) return send(res, 401, { message: "Invalid API key", hint: "Double check your Supabase `anon` or `service_role` API key." });
      const auth = req.headers.authorization;
      if (auth != null) {
        const tok = /^Bearer (.+)$/i.exec(auth);
        const parts = tok ? tok[1].split(".").length : 0;
        if (!tok || parts !== 3) return send(res, 401, pgErr("PGRST301", "Expected 3 parts in JWT; got " + parts));
        if (tok[1] !== JWT_KEY) return send(res, 401, pgErr("PGRST301", "JWSError JWSInvalidSignature"));
      }
      if (u.pathname !== "/rest/v1/chalk_sync") return send(res, 404, pgErr("PGRST205", "Could not find the table 'public." + u.pathname.slice(9) + "' in the schema cache", null, "Perhaps you meant the table 'public.chalk_sync'"));
      if (srv.failNext) { const s = srv.failNext; srv.failNext = 0; return send(res, s, s === 429 ? { message: "API rate limit exceeded" } : pgErr("PGRST001", "Database client error. Retrying the connection.", "boom"),
        srv.retryAfter ? Object.assign({ "retry-after": String(srv.retryAfter) }, srv.exposeRetryAfter ? { "access-control-expose-headers": EXPOSE + ", Retry-After" } : {}) : null); }
      if (srv.hook) { const h = srv.hook(req, entry, body); if (h) return send(res, h.status, h.body || pgErr("XX000", "hook")); }
      const q = u.searchParams;
      try {
        if (req.method === "GET" || req.method === "HEAD") {
          const cols = (q.get("select") || "*") === "*" ? COLS : q.get("select").split(",");
          cols.forEach(c => { if (!COLS.includes(c)) throw pgErr("42703", "column chalk_sync." + c + " does not exist"); });
          let out = filterRows(srv.all().filter(r => r.household === hh), q);   /* RLS: only your own household */
          if (q.get("order")) {
            const keys = q.get("order").split(",").map(s => {
              const m = /^([a-z_]+)(?:\.(asc|desc))?(?:\.(nullsfirst|nullslast))?$/.exec(s);
              if (!m) throw parseErr("order", s);
              if (!COLS.includes(m[1])) throw pgErr("42703", "column chalk_sync." + m[1] + " does not exist");
              return { c: m[1], dir: m[2] === "desc" ? -1 : 1 };
            });
            out.sort((a, b) => { for (const k of keys) { const c = cmp(k.c, colVal(a, k.c), colVal(b, k.c)); if (c) return c * k.dir; } return 0; });
          }
          let off = 0, lim = Infinity;
          const rg = /^(\d+)-(\d*)$/.exec(req.headers.range || "");
          if (rg) { off = +rg[1]; if (rg[2] !== "") lim = +rg[2] - off + 1; }
          if (q.has("offset")) { if (!/^\d+$/.test(q.get("offset"))) throw parseErr("offset parameter", q.get("offset")); off = +q.get("offset"); }
          if (q.has("limit")) { if (!/^\d+$/.test(q.get("limit"))) throw parseErr("limit parameter", q.get("limit")); lim = Math.min(lim, +q.get("limit")); }
          out = out.slice(off, off + Math.min(lim, srv.maxRows));
          entry.n = out.length; entry.ts = out.map(r => r.updated_at);
          const result = out.map(r => { const o = {}; cols.forEach(c => { o[c] = c === "data" ? jsonb(JSON.parse(r.data)) : r[c]; }); return o; });
          const range = { "content-range": out.length ? off + "-" + (off + out.length - 1) + "/*" : "*/*" };
          /* srv.mutate(rows, entry) may return raw JSON text (to send keys like "__proto__" as-is) */
          const m = srv.mutate ? srv.mutate(result, entry) : result;
          return send(res, 200, req.method === "HEAD" ? null : m, range);
        }
        if (req.method === "POST" || req.method === "PATCH") {
          const ct = req.headers["content-type"] || "application/json";
          if (!/^application\/json\b/i.test(ct)) return send(res, 415, pgErr("PGRST107", "The request's Content-Type is not supported"));
          let arr; try { arr = JSON.parse(body); } catch (e) { return send(res, 400, pgErr("PGRST102", "Empty or invalid json")); }
          if (req.method === "PATCH" && (!arr || typeof arr !== "object" || Array.isArray(arr))) return send(res, 400, pgErr("PGRST102", "Empty or invalid json"));
          if (!Array.isArray(arr)) arr = [arr];
          if (arr.some(r => !r || typeof r !== "object" || Array.isArray(r))) return send(res, 400, pgErr("PGRST102", "All object keys must match"));
          const keys = JSON.stringify(Object.keys(arr[0] || {}).sort());
          if (arr.some(r => JSON.stringify(Object.keys(r).sort()) !== keys)) return send(res, 400, pgErr("PGRST102", "All object keys must match"));
          const sent = JSON.parse(keys);
          const unknown = sent.find(k => !COLS.includes(k));
          if (unknown) return send(res, 400, pgErr("PGRST204", "Could not find the '" + unknown + "' column of 'chalk_sync' in the schema cache"));
          const us = srv.clock();                       /* ONE now() for the whole request (one transaction) */
          const stamp = { _us: us, updated_at: pgTs(us) };
          const wrote = [];
          const store = (r, old) => {
            const t = srv.trigger ? stamp : old ? { _us: old._us, updated_at: old.updated_at } : stamp;   /* no trigger: an update keeps the old time */
            const v = Object.assign({}, old || {}, r, t);
            if (!old && r.data === undefined) v.data = {};
            if (!old && r.deleted === undefined) v.deleted = false;
            if (!old && r.client_updated === undefined) v.client_updated = 0;
            if (!old && r.device === undefined) v.device = "";
            return v;
          };
          const check = v => {   /* RLS WITH CHECK first, then NOT NULL and CHECK constraints */
            if (v.household !== hh) throw Object.assign(pgErr("42501", 'new row violates row-level security policy for table "chalk_sync"'), { status: 401 });
            for (const c of ["household", "kind", "id", "data", "deleted", "client_updated", "device"]) if (v[c] === null || v[c] === undefined) throw pgErr("23502", 'null value in column "' + c + '" of relation "chalk_sync" violates not-null constraint', failing(v));
            const bad = n => pgErr("23514", 'new row for relation "chalk_sync" violates check constraint "chalk_sync_' + n + '_check"', failing(v));
            if (!/^[A-HJ-NP-Z2-9]{20}$/.test(v.household)) throw bad("household");
            if (!["food", "meal", "day", "body", "profile", "train", "meta"].includes(v.kind)) throw bad("kind");
            if ([...v.id].length < 1 || [...v.id].length > 200) throw bad("id");
            if (Buffer.byteLength(jsonbText(v.data)) >= 3000000) throw bad("data");
            if ([...v.device].length > 64) throw bad("device");
            if (srv.reject && srv.reject(v)) throw bad("test");
          };
          if (req.method === "PATCH") {
            const r = {}; sent.forEach(c => { r[c] = coerce(c, arr[0][c]); });
            if (r.data !== undefined) { const e = badJson(r.data); if (e) throw e; }
            const hit = filterRows(srv.all().filter(x => x.household === hh), q);   /* RLS USING */
            const next = hit.map(old => { const v = store(r, Object.assign({}, old, { data: JSON.parse(old.data) })); check(v); return v; });
            next.forEach(v => { rows.set(v.household + "|" + v.kind + "|" + v.id, Object.assign(v, { data: JSON.stringify(v.data) })); });
            return send(res, 204, null);
          }
          const pref = entry.prefer;
          const merge = /resolution=merge-duplicates/.test(pref), ignore = /resolution=ignore-duplicates/.test(pref);
          if ((merge || ignore) && q.has("on_conflict") && q.get("on_conflict") !== "household,kind,id") return send(res, 400, pgErr("42P10", "there is no unique or exclusion constraint matching the ON CONFLICT specification"));
          entry.n = arr.length; entry.rows = arr.map(r => r.kind + "|" + r.id);
          const seen = new Set();
          for (const src of arr) {
            const r = {}; sent.forEach(c => { r[c] = coerce(c, src[c]); });
            if (r.data !== undefined && r.data !== null) { const e = badJson(r.data); if (e) throw e; }
            const pk = r.household + "|" + r.kind + "|" + r.id;
            const cur = rows.get(pk);
            const old = seen.has(pk) ? wrote.find(w => w.pk === pk).v : cur ? Object.assign({}, cur, { data: JSON.parse(cur.data) }) : null;
            if (old && !merge && !ignore) throw Object.assign(pgErr("23505", 'duplicate key value violates unique constraint "chalk_sync_pkey"', "Key (household, kind, id)=(" + r.household + ", " + r.kind + ", " + r.id + ") already exists."), { status: 409 });
            if (seen.has(pk) && merge) throw pgErr("21000", "ON CONFLICT DO UPDATE command cannot affect row a second time", null, "Ensure that no rows proposed for insertion within the same command have duplicate constrained values.");
            check(store(r, null));                     /* the proposed row: INSERT policy + checks */
            if (old && ignore) continue;
            const v = store(r, old);
            check(v);                                  /* after ON CONFLICT DO UPDATE: UPDATE policy + checks */
            seen.add(pk); wrote.push({ pk, v });
          }
          wrote.forEach(({ pk, v }) => rows.set(pk, Object.assign(v, { data: JSON.stringify(v.data) })));
          if (/return=representation/.test(pref)) {
            const cols = (q.get("select") || "*") === "*" ? COLS : q.get("select").split(",");
            return send(res, 201, wrote.map(({ v }) => { const o = {}; cols.forEach(c => { o[c] = c === "data" ? jsonb(JSON.parse(v.data)) : v[c]; }); return o; }), { "content-range": "*/*" });
          }
          return send(res, 201, null, { "content-range": "*/*" });
        }
        if (req.method === "DELETE") return send(res, 401, pgErr("42501", "permission denied for table chalk_sync"));
        return send(res, 405, pgErr("PGRST117", "Unsupported HTTP method: " + req.method));
      } catch (e) {
        if (e && e.code && e.message) { const st = e.status || (e.code === "42883" ? 404 : 400); delete e.status; return send(res, st, e); }
        return send(res, 500, pgErr("XX000", String(e && e.message || e)));
      }
    });
  });
  return srv;
}

/* ======================================================= a browser's fetch */
/* The app runs on its own origin, so every request to Supabase is cross-origin. Like a browser:
   a request with headers beyond the CORS-safelisted ones (apikey, x-household, Prefer,
   content-type: application/json, Authorization) first sends an OPTIONS preflight; a preflight
   that fails, or a response without Access-Control-Allow-Origin, rejects with
   TypeError("Failed to fetch"); the page can read only the headers the server exposes. */
const ORIGIN = "https://chalk.example";
function corsUnsafe(h) {
  const out = [];
  Object.keys(h || {}).forEach(k => {
    const n = k.toLowerCase(), v = String(h[k]);
    if (n === "accept" || n === "accept-language" || n === "content-language") return;
    if (n === "content-type" && /^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)\s*(;|$)/i.test(v)) return;
    out.push(n);
  });
  return out.sort();
}
async function browserFetch(url, opt, preflights) {
  opt = opt || {};
  const method = String(opt.method || "GET").toUpperCase(), unsafe = corsUnsafe(opt.headers);
  const fail = () => { throw new TypeError("Failed to fetch"); };
  if (unsafe.length || !["GET", "HEAD", "POST"].includes(method)) {
    let pre = null;
    try { pre = await fetch(url, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": method, "access-control-request-headers": unsafe.join(",") } }); } catch (e) { pre = null; }
    preflights.push({ url: String(url), method, asked: unsafe.join(","), status: pre ? pre.status : 0 });
    if (!pre || !pre.ok) fail();
    const ao = pre.headers.get("access-control-allow-origin");
    const ah = (pre.headers.get("access-control-allow-headers") || "").toLowerCase().split(",").map(x => x.trim());
    const am = (pre.headers.get("access-control-allow-methods") || "").toUpperCase().split(",").map(x => x.trim());
    if ((ao !== "*" && ao !== ORIGIN) || unsafe.some(x => !ah.includes(x)) || (!["GET", "HEAD", "POST"].includes(method) && !am.includes(method))) fail();
  }
  let res;
  try { res = await fetch(url, Object.assign({}, opt, { headers: Object.assign({ origin: ORIGIN }, opt.headers) })); }
  catch (e) { if (e && e.name === "AbortError") throw e; fail(); }
  const ao = res.headers.get("access-control-allow-origin");
  if (ao !== "*" && ao !== ORIGIN) fail();
  const exposed = new Set(["cache-control", "content-language", "content-length", "content-type", "expires", "last-modified", "pragma"]
    .concat((res.headers.get("access-control-expose-headers") || "").toLowerCase().split(",").map(x => x.trim())));
  return { ok: res.ok, status: res.status, statusText: res.statusText, headers: { get: n => (exposed.has(String(n).toLowerCase()) ? res.headers.get(n) : null) }, json: () => res.json(), text: () => res.text() };
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
  const reqs = [], preflights = [];
  const full = new Set();     /* keys whose writes fail like a full phone */
  let offline = false;
  const nav = { onLine: true };
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
    navigator: nav,
    fetch: (url, opt) => {
      reqs.push({ url: String(url), method: (opt && opt.method) || "GET", headers: Object.assign({}, opt && opt.headers), body: opt && opt.body });
      if (offline) return Promise.reject(new TypeError("Failed to fetch"));
      return browserFetch(url, opt, preflights);
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
    name, M, ctx, store, reqs, preflights, winL, docL,
    offline(v) { offline = v; nav.onLine = !v; },
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
  /* the publishable key goes in apikey only; a read is apikey + x-household, a write adds
     content-type and Prefer: the browser's CORS check (preflight) only ever sees these two shapes */
  assert.ok(A.reqs.every(r => !Object.keys(r.headers).some(h => h.toLowerCase() === "authorization")), "never Authorization with a publishable key");
  assert.deepStrictEqual(Object.keys(A.gets()[0].headers).sort(), ["apikey", "x-household"], "a read: apikey + x-household only");
  assert.deepStrictEqual(Object.keys(post.headers).sort(), ["Prefer", "apikey", "content-type", "x-household"], "a write adds content-type and Prefer");
  assert.deepStrictEqual([...new Set(A.preflights.map(p => p.method + " " + p.asked))].sort(), ["GET apikey,x-household", "POST apikey,content-type,prefer,x-household"], "two request shapes, nothing extra");
  assert.ok(A.preflights.length > 0 && A.preflights.every(p => p.status === 200), "every preflight passed");
  /* self-test first: our household row goes up alone (twice: the server must stamp a newer time
     on the second write), comes back with our code, and another code sees none of it */
  assert.deepStrictEqual(JSON.parse(post.body).map(r => r.kind + "|" + r.id), ["meta|household"], "first request writes only the household row");
  assert.deepStrictEqual(JSON.parse(A.posts()[1].body).map(r => r.kind + "|" + r.id), ["meta|household"], "then again, to check the server's clock");
  const iso = A.gets().find(g => /kind=eq\.meta/.test(g.url) && g.headers["x-household"] !== code);
  assert.ok(iso && CODE_RE.test(iso.headers["x-household"]), "isolation check with another code");
  const get = A.gets().find(g => /updated_at=gt\./.test(g.url));
  assert.ok(get.url.startsWith(URLBASE + "/rest/v1/chalk_sync?select=household,kind,id,data,deleted,client_updated,updated_at,device&updated_at=gt."), get.url);
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
  const res = await fetch(URLBASE + "/rest/v1/chalk_sync?select=kind,id,data&household=eq." + CODE, { headers: { apikey: KEY, "x-household": other, "x-test-probe": "1" } });
  assert.deepStrictEqual(await res.json(), []);
  /* and writing into Nick's household with the wrong header is refused */
  const before = SERVER.all(CODE).length;
  const w = await fetch(URLBASE + "/rest/v1/chalk_sync?on_conflict=household,kind,id", { method: "POST", headers: { apikey: KEY, "x-household": other, "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal", "x-test-probe": "1" },
    body: JSON.stringify([{ household: CODE, kind: "food", id: "evil", data: {}, deleted: false, client_updated: 1, device: "x" }]) });
  assert.strictEqual(w.status, 401, "row-level security refuses it (anon role: 401)");
  assert.deepStrictEqual(await w.json(), { code: "42501", details: null, hint: null, message: 'new row violates row-level security policy for table "chalk_sync"' });
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
  assert.strictEqual(P.M.cloud.training().keep, 2, "the card can say 2 workouts stay");
  assert.strictEqual(await P.M.cloud.restoreTraining(), true);
  assert.deepStrictEqual(J(P.train().log.map(x => x.id)), ["w3", "p2", "w2", "p1", "w1"], "restored, and this phone's 2 stay, newest first like Chalk (SY-04)");
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
  /* the Undo copy expires after a day (it can be big) */
  assert.strictEqual(await P.M.cloud.restoreTraining(), true);
  const real = Date.now;
  P.M.now = () => real() + DAY / 2;
  assert.ok(P.M.cloud.undoInfo(), "still there after 12 hours");
  P.M.now = () => real() + 2 * DAY;
  assert.strictEqual(P.M.cloud.undoInfo(), null, "gone after a day");
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

t("a blocked CORS check (preflight) reads plainly and never leaves the card on Syncing…", async () => {
  SERVER.preflightFail = true;
  A.M.foods.add({ name: "Preflight food" });
  const r = await A.sync();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "Couldn't reach the cloud. We'll try again soon.", "online but no answer: not blamed on their connection");
  const s = A.M.cloud.status();
  assert.strictEqual(s.busy, false, "not stuck on Syncing…");
  assert.ok(s.pending >= 1, "the change waits");
  assert.ok(foodNames(A).includes("Preflight food"), "kept on the phone");
  /* joining fails plainly too, and says what to do */
  const P = phone("preflight-join", { S: { profile: "kat", active: null } });
  const j = await P.M.cloud.join(CODE);
  assert.strictEqual(j.ok, false);
  assert.strictEqual(j.error, "Couldn't reach the cloud. Try again in a minute.");
  assert.strictEqual(P.M.cloud.status().on, false); assert.strictEqual(P.M.cloud.status().busy, false);
  /* the check passes again: the next sync sends it */
  SERVER.preflightFail = false;
  assert.ok((await A.sync()).ok);
  assert.ok(SERVER.all(CODE).some(x => /Preflight food/.test(x.data)));
  assert.strictEqual(A.M.cloud.status().lastError, "");
});

t("a secret key is never used, and the Anthropic key never leaves the phone", async () => {
  const P = phone("secret", { key: "sb_secret_abcdefghijklmnopqrstuvwxyz0123", S: { profile: "kat", active: null } });
  assert.strictEqual(P.M.cloud.configured(), false, "sync stays off with a secret key");
  assert.match((await P.M.cloud.join(CODE)).error, /isn't set up/);
  assert.strictEqual(P.M.cloud.create(), null);
  assert.strictEqual(P.reqs.length, 0, "no request with it");
  /* the Claude key lives in its own localStorage entry: not in sync, not in the export */
  const AI = "sk-ant-api03-SECRETsecretSECRET0123456789-abcdefABCDEF_xyz";
  const Q = phone("aikey", { S: { profile: "kat", active: null }, train: trainState("kat", ["q1"]) });
  Q.store.set("chalk.ai.key", AI);
  Q.M.foods.add({ name: "Greek yogurt 2%" });
  assert.ok((await Q.M.cloud.join(CODE)).ok);
  assert.ok(JSON.stringify(Q.M.export()).indexOf(AI) < 0, "not in M.export()");
  /* even pasted into a food name by mistake, it isn't sent */
  Q.M.foods.add({ name: "Oops " + AI });
  assert.ok((await Q.sync()).ok);
  const seen = JSON.stringify(Q.reqs) + JSON.stringify(SERVER.log) + JSON.stringify(SERVER.all(CODE));
  assert.ok(seen.indexOf("sk-ant-") < 0 && seen.indexOf(AI) < 0, "no request and no cloud row holds the key");
  assert.ok(SERVER.all(CODE).some(x => x.kind === "food" && /"Oops /.test(x.data)), "the food itself went up");
  Q.M.cloud.leave();
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
  /* Nick's phone switches to Katerina: her rows come down; his stay (it's his phone: SY-01) */
  N.ctx.S.profile = "kat";
  assert.ok((await N.sync()).ok);
  assert.strictEqual(rowsOf(N, "days", "kat").length, 3, "her diary arrived");
  assert.strictEqual(rowsOf(N, "body", "kat").length, 1, "her weigh-in too");
  assert.strictEqual(rowsOf(N, "days", "nick").length, 5, "his never leave his own phone");
  assert.strictEqual(rowsOf(N, "body", "nick").length, 5, "nor his weigh-ins");
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

t("the mock answers like Supabase + PostgREST for this table (so green here means the real thing works)", async () => {
  const U = URLBASE + "/rest/v1/chalk_sync", HH = "MQCKCHECKAAAAAAAAAAA";
  const hdr = x => Object.assign({ apikey: KEY, "x-household": HH, "x-test-probe": "1" }, x || {});
  const post = (rows, x) => fetch(U + "?on_conflict=household,kind,id", { method: "POST", headers: hdr(Object.assign({ "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, x)), body: JSON.stringify(rows) });
  const row = (id, extra) => Object.assign({ household: HH, kind: "food", id, data: { name: id }, deleted: false, client_updated: 1, device: "t" }, extra || {});
  const err = async (res, status, code) => {
    assert.strictEqual(res.status, status, code);
    const j = await res.json();
    assert.deepStrictEqual(Object.keys(j).sort(), ["code", "details", "hint", "message"], "PostgREST error shape");
    assert.strictEqual(j.code, code); return j;
  };
  /* the gateway: apikey required; a publishable key is not a JWT */
  let r = await fetch(U + "?select=id", { headers: { "x-household": HH } });
  assert.strictEqual(r.status, 401); assert.deepStrictEqual(await r.json(), { message: "No API key found in request", hint: "No `apikey` request header or url param was found." });
  r = await fetch(U + "?select=id", { headers: { apikey: "nope", "x-household": HH } });
  assert.strictEqual(r.status, 401); assert.strictEqual((await r.json()).message, "Invalid API key");
  await err(await fetch(U + "?select=id", { headers: hdr({ Authorization: "Bearer " + KEY }) }), 401, "PGRST301");
  /* upsert: one server time per request, stamped again on update, only the sent columns change */
  assert.strictEqual((await post([row("a"), row("b")])).status, 201);
  const a1 = SERVER.get(HH, "food", "a");
  assert.strictEqual(a1.updated_at, SERVER.get(HH, "food", "b").updated_at, "one now() per request");
  assert.strictEqual((await post([row("a", { data: { name: "a2" } })])).status, 201);
  assert.ok(tsVal(SERVER.get(HH, "food", "a").updated_at) > tsVal(a1.updated_at), "an update is stamped again (trigger)");
  /* the table's checks and types, in PostgREST's error shape; a failed request writes nothing */
  await err(await post([row("c", { kind: "nope" })]), 400, "23514");
  await err(await post([row("c", { client_updated: 1.5 })]), 400, "22P02");
  await err(await post([row("c", { data: null })]), 400, "23502");
  await err(await post([row("c", { data: { name: "nul\u0000" } })]), 400, "22P05");
  await err(await post([row("c"), { household: HH, kind: "food", id: "d" }]), 400, "PGRST102");
  await err(await post([Object.assign(row("c"), { color: "red" })]), 400, "PGRST204");
  await err(await post([row("c", { device: "x".repeat(65) })]), 400, "23514");
  await err(await post([row("big", { data: { s: "x".repeat(3e6) } })]), 400, "23514");
  await err(await post([row("c"), row("c")]), 400, "21000");
  await err(await post([row("c", { household: "ABCDEFGHJKLMNPQRSTUV" })]), 401, "42501");
  assert.ok(!SERVER.get(HH, "food", "c") && !SERVER.get("ABCDEFGHJKLMNPQRSTUV", "food", "c"), "nothing written");
  /* no delete, ever */
  await err(await fetch(U + "?id=eq.a", { method: "DELETE", headers: hdr() }), 401, "42501");
  assert.ok(SERVER.get(HH, "food", "a"), "still there");
  await err(await fetch(U + "?select=nope", { headers: hdr() }), 400, "42703");
  await err(await fetch(U + "?select=id&updated_at=gt.yesterday", { headers: hdr() }), 400, "22007");
  /* reads: own household only, limit / offset, Range, max rows 1000, Content-Range */
  const many = Array.from({ length: 1200 }, (_, i) => row("m" + String(i).padStart(4, "0")));
  for (let i = 0; i < many.length; i += 400) assert.strictEqual((await post(many.slice(i, i + 400))).status, 201);
  r = await fetch(U + "?select=id&order=id.asc&limit=5000", { headers: hdr() });
  assert.strictEqual((await r.json()).length, 1000, "max rows 1000");
  r = await fetch(U + "?select=id&order=id.asc&limit=2&offset=3", { headers: hdr() });
  assert.strictEqual(r.headers.get("content-range"), "3-4/*"); assert.deepStrictEqual((await r.json()).map(x => x.id), ["m0001", "m0002"]);
  r = await fetch(U + "?select=id&order=id.asc", { headers: hdr({ "Range-Unit": "items", Range: "0-1" }) });
  assert.deepStrictEqual((await r.json()).map(x => x.id), ["a", "b"]);
  r = await fetch(U + "?select=id", { headers: hdr({ "x-household": "ABCDEFGHJKLMNPQRSTUV" }) });
  assert.ok(!(await r.json()).some(x => /^m\d/.test(x.id)), "another household sees none of them");
  r = await fetch(U + "?select=id", { headers: { apikey: KEY, "x-test-probe": "1" } });
  assert.deepStrictEqual(await r.json(), [], "no header, no rows");
  for (const k of [...SERVER.rows.keys()]) if (k.startsWith(HH + "|")) SERVER.rows.delete(k);
});

t("turn on checks the server stamps every write (BES-09)", async () => {
  const P = phone("bes09", {}); seedNick(P);
  /* a table with updated_at only as a column default (the trigger missing): an update keeps the old time */
  SERVER.trigger = false;
  const code = P.M.cloud.create();
  const r = await P.sync();
  SERVER.trigger = true;
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
  /* C5: her diary and weigh-in too (they came down to this phone first), not only what this phone kept */
  assert.deepStrictEqual(kinds, { food: 3, meal: 2, day: 8, body: 6, profile: 2, meta: 1, train: 1 }, "all of it in the new household");
  assert.strictEqual(rowsOf(N, "days", "kat").length, 0, "and her rows left his phone again once they were in the new household");
  assert.ok(SERVER.all(code).every(x => x.deleted === true), "old household: every row marked deleted");
  assert.ok(SERVER.all(code).filter(x => x.kind !== "meta").every(x => x.data === "{}"), "and emptied");
  const kr = await K.sync();
  assert.strictEqual(kr.ok, false);
  assert.strictEqual(K.M.cloud.status().on, false);
  assert.strictEqual(K.M.cloud.status().note, "Sync is off. The other phone deleted the cloud copy or changed the code. Everything is still on this phone.");
  assert.strictEqual(Object.keys(K.M.MS.foods).length, kFoods, "her data stays");
  assert.ok((await K.M.cloud.join(c.code)).ok, "she joins with the new code");
  /* Delete my cloud data. Offline first (C5): everything must come down to this phone before the
     cloud copy goes, so offline nothing is deleted and sync stays on. */
  N.offline(true);
  const d0 = await N.M.cloud.deleteCloud();
  assert.strictEqual(d0.ok, false);
  assert.strictEqual(d0.error, "Can't reach the internet. Nothing was deleted. Try again in a minute.");
  assert.strictEqual(N.M.cloud.status().on, true, "sync stays on");
  assert.ok(SERVER.all(c.code).some(x => !x.deleted), "nothing deleted");
  N.offline(false);
  const d = await N.M.cloud.deleteCloud();
  assert.ok(d.ok, JSON.stringify(d));
  assert.strictEqual(N.M.cloud.status().on, false, "sync is off on this phone");
  assert.strictEqual(rowsOf(N, "days", "kat").length, 3, "her diary is on this phone too now");
  assert.ok(SERVER.all(c.code).every(x => x.deleted === true), "every row marked deleted");
  assert.ok(SERVER.all(c.code).filter(x => x.kind !== "meta").every(x => x.data === "{}"), "and emptied");
  assert.strictEqual(N.M.cloud.status().note, "Your cloud copy is deleted. Everything is still on this phone.");
  assert.strictEqual(Object.keys(N.M.MS.foods).length, 3, "this phone keeps everything");
  assert.strictEqual((await K.sync()).ok, false, "the other phone stops");
  assert.strictEqual(K.M.cloud.status().on, false);
  /* the household code never travelled in a URL, in any request the app made in this whole run
     (the test's own raw probes, marked x-test-probe, put one there on purpose) */
  const codes = new Set(SERVER.log.map(e => e.hh).filter(h => CODE_RE.test(h)));
  assert.ok(codes.size > 3);
  SERVER.log.filter(e => !e.probe).forEach(e => codes.forEach(h => assert.ok(e.query.indexOf(h) < 0, "code in a URL: " + e.query)));
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
  /* BES-10: two pushes that race (neither phone pulled the other's first) still keep both edits */
  const mid = Object.values(N.M.MS.meals).find(m => m.name === "Chicken toast").id;
  N.M.meals.update(mid, { name: "Chicken toast (big)" });
  K.M.meals.update(mid, { desc: "Kat: use the thin bread." });
  assert.ok((await N.M.cloud._.cycle({ reason: "manual", manual: true, pull: false })).ok);
  assert.ok((await K.M.cloud._.cycle({ reason: "manual", manual: true, pull: false })).ok);
  assert.strictEqual(JSON.parse(SERVER.get(code, "meal", mid).data).name, "Chicken toast", "(her push overwrote his in the cloud)");
  await N.sync(); await K.sync(); await N.sync();
  [N, K].forEach(P => { const m = P.M.MS.meals[mid]; assert.strictEqual(m.name, "Chicken toast (big)", P.name); assert.strictEqual(m.desc, "Kat: use the thin bread.", P.name); });
  assert.strictEqual(JSON.parse(SERVER.get(code, "meal", mid).data).name, "Chicken toast (big)");
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
  await sleep(1500);   /* the server's Date header has whole seconds: edits under ~1 s apart are a tie */
  N.M.foods.update(fid, { name: "Zucchini (Nick, later)" });
  await N.sync(); K.offline(false); await K.sync(); await N.sync();
  assert.strictEqual(N.M.MS.foods[fid].name, "Zucchini (Nick, later)", "the later real edit wins on Nick's phone");
  assert.strictEqual(K.M.MS.foods[fid].name, "Zucchini (Nick, later)", "and on Kat's");
  K.M.now = () => Date.now();
  /* BES-13: Retry-After is respected; background syncs wait, Sync now doesn't */
  /* a browser reads Retry-After only when the server exposes it (Supabase's list doesn't) */
  SERVER.failNext = 429; SERVER.retryAfter = 120;
  let r = await N.sync();
  assert.strictEqual(r.error, "The cloud is busy. We'll try again soon.");
  assert.ok(N.M.cloud._.state().retryAt >= Date.now() + 55e3, "hidden Retry-After: a 429 still waits at least a minute");
  assert.ok((await N.sync()).ok);
  SERVER.failNext = 429; SERVER.exposeRetryAfter = true;
  r = await N.sync();
  SERVER.retryAfter = 0; SERVER.exposeRetryAfter = false;
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

/* C5: a damaged save that falls back to the daily backup, or records that vanish from the
   phone without the app deleting them, must never go up as deletes (that would empty the
   cloud copy and delete them on the other phone). The phone reads everything again instead. */
t("records lost on this phone (damaged save, backup copy) are brought back, never deleted in the cloud (C5)", async () => {
  const { P: N, code } = await household("c5-nick");
  const K = katPhone("c5-kat");
  assert.ok((await K.M.cloud.join(code)).ok);
  assert.ok((await N.sync()).ok);
  const nFoods = foodNames(N), nMeals = mealNames(N), nDays = rowsOf(N, "days", "nick").length, nBody = rowsOf(N, "body", "nick").length;
  assert.ok(nFoods.length >= 3 && nDays >= 5 && nBody >= 5);
  /* today's edit that the daily backup copy doesn't have */
  const lastFood = Object.values(N.M.MS.foods).find(f => f.name === "Zucchini");
  N.M.foods.update ? N.M.foods.update(lastFood.id, { name: "Zucchini, green" }) : Object.assign(N.M.MS.foods[lastFood.id], { name: "Zucchini, green", updatedAt: Date.now() });
  N.M.save();
  assert.ok((await N.sync()).ok);
  /* the main copy gets damaged; the next start falls back to the backup copy (an older, smaller state) */
  const store = Object.fromEntries(N.store);   /* the phone's storage as it is (sync still on) */
  N.M.cloud.leave();   /* the old page is gone */
  const bak = JSON.parse(store["chalk.macros.v1.bak"] || "null");
  const small = { v: 1, ui: {}, profiles: J(N.M.MS.profiles), foods: {}, meals: {}, days: {}, body: {} };
  const oldZ = Object.assign(J(N.M.MS.foods[lastFood.id]), { name: "Zucchini", updatedAt: Date.now() - DAY, u: Date.now() - DAY });   /* a day-old copy: day-old edit stamps */
  small.foods[lastFood.id] = oldZ;
  store["chalk.macros.v1.bak"] = JSON.stringify({ bak: 1, day: (bak && bak.day) || N.M.today(), at: Date.now() - DAY, data: small });
  store["chalk.macros.v1"] = "{broken";
  assert.ok(Object.keys(JSON.parse(store["chalk.sync.v1"]).hashes).length > 15, "the phone knew what the cloud holds");
  const N2 = phone("c5-nick-2", { store, train: trainState("nick", ["w1", "w2", "w3"]) });
  assert.ok(N2.M.storage.restoredFrom, "m-core used the backup copy");
  N2.M.cloud._.scan();   /* the first look (a save timer) already forgets, on disk too: a restart can't undo it */
  const disk = JSON.parse(N2.store.get("chalk.sync.v1"));
  assert.ok(!Object.keys(disk.hashes).some(k => /^(food|meal|day|body|profile)\|/.test(k)), "sync memory of the damaged records is gone on disk");
  assert.strictEqual(disk.cursor, "", "and the next sync reads everything");
  const r = await N2.sync();
  assert.ok(r.ok, JSON.stringify(r));
  const live = SERVER.all(code).filter(x => x.kind !== "meta" && x.kind !== "train");
  assert.strictEqual(live.filter(x => x.deleted).length, 0, "nothing was deleted in the cloud: " + live.filter(x => x.deleted).map(x => x.kind + "|" + x.id).join(", "));
  assert.deepStrictEqual(foodNames(N2), nFoods.map(n => n === "Zucchini" ? "Zucchini, green" : n).sort(), "his foods came back, with today's edit");
  assert.deepStrictEqual(mealNames(N2), nMeals, "his meals came back");
  assert.strictEqual(rowsOf(N2, "days", "nick").length, nDays, "his diary came back");
  assert.strictEqual(rowsOf(N2, "body", "nick").length, nBody, "his weigh-ins came back");
  assert.strictEqual(Object.values(SERVER.all(code)).find(x => x.kind === "food" && x.id === lastFood.id).deleted, false);
  assert.ok(JSON.parse(SERVER.get(code, "food", lastFood.id).data).name === "Zucchini, green", "the older backup copy didn't overwrite the cloud");
  assert.ok((await K.sync()).ok);
  assert.deepStrictEqual(foodNames(K), foodNames(N2), "her phone kept every food");
  assert.strictEqual(mealNames(K).length, nMeals.length, "and every meal");
  /* a phone whose synced records vanish without the app deleting them (storage cleared, a bug): no deletes either */
  const ids = Object.keys(N2.M.MS.days).filter(k => k.startsWith("nick|"));
  ids.forEach(id => { delete N2.M.MS.days[id]; });
  Object.keys(N2.M.MS.foods).forEach(id => { delete N2.M.MS.foods[id]; });
  N2.M.save();
  assert.ok((await N2.sync()).ok);
  assert.strictEqual(SERVER.all(code).filter(x => x.deleted && x.kind !== "meta").length, 0, "still nothing deleted in the cloud");
  assert.ok((await N2.sync()).ok);
  assert.strictEqual(rowsOf(N2, "days", "nick").length, nDays, "his diary came back again");
  assert.strictEqual(foodNames(N2).length, nFoods.length, "and his foods");
  /* one food deleted on purpose still goes: a delete of one food is a real delete */
  const one = Object.values(N2.M.MS.foods).find(f => f.name === "Zucchini, green");
  N2.M.foods.remove(one.id);
  assert.ok((await N2.sync()).ok);
  assert.strictEqual(SERVER.get(code, "food", one.id).deleted, true, "a real delete still reaches the cloud");
  assert.ok((await K.sync()).ok);
  assert.ok(!foodNames(K).includes("Zucchini, green"), "and the other phone");
  /* a clean-up of many foods at once (fewer than half of them) is real too, even with sync off meanwhile */
  const made = []; for (let i = 0; i < 24; i++) made.push(N2.M.foods.add({ name: "Extra food " + i }).id);
  assert.ok((await N2.sync()).ok);
  made.slice(0, 11).forEach(id => N2.M.foods.remove(id));
  assert.ok((await N2.sync()).ok);
  assert.strictEqual(made.slice(0, 11).filter(id => SERVER.get(code, "food", id).deleted === true).length, 11, "11 foods deleted in the cloud");
  assert.strictEqual(foodNames(N2).filter(n => /^Extra food/.test(n)).length, 13, "and they stay deleted here");
  N2.M.cloud.leave(); K.M.cloud.leave();
});

/* C5: tonight both phones already hold real data. If Nick's phone once set up a profile for
   Katerina, her own phone (with weeks of her diary) must keep her newer profile on joining. */
t("joining with a phone that is already hers keeps her newer profile (C5)", async () => {
  const H = phone("c5b-nick", {});
  seedNick(H);
  const old = H.M.person("kat");
  Object.assign(old, { sex: "f", age: 35, heightIn: 65, weightLb: 150, goalWeightLb: 140, activity: "light", pace: -1, setupAt: Date.now() - 30 * DAY, updatedAt: Date.now() - 30 * DAY, lastBody: Date.now() - 30 * DAY });
  H.M.calc.applyTargets(old); H.M.save();
  const code = H.M.cloud.create(); assert.ok((await H.sync()).ok);
  assert.strictEqual(JSON.parse(SERVER.get(code, "profile", "kat").data).weightLb, 150, "his phone's old copy of her profile is in the cloud");
  const K = katPhone("c5b-kat");   /* set up later on her own phone, 3 days of her diary, edited since */
  const kp = K.M.person("kat"); kp.setupAt = Date.now() - 20 * DAY; kp.updatedAt = Date.now() - DAY; K.M.save();
  assert.ok((await K.M.cloud.join(code)).ok);
  assert.strictEqual(K.M.MS.profiles.kat.weightLb, 135, "her phone kept her own profile");
  assert.strictEqual(JSON.parse(SERVER.get(code, "profile", "kat").data).weightLb, 135, "and the cloud has hers now");
  assert.ok((await H.sync()).ok);
  assert.strictEqual(H.M.MS.profiles.kat.weightLb, 135, "his phone took hers");
  assert.strictEqual(H.M.MS.profiles.nick.weightLb, 185, "his own profile is untouched");
  H.M.cloud.leave(); K.M.cloud.leave();
});

/* C5: after "Switch person", a phone holds only the new person's diary; its own person's lives in
   the cloud. Delete cloud copy and Change code must bring that back first, or it is gone. */
t("Delete cloud copy and Change code on a phone that switched person keep every diary (C5)", async () => {
  const { P: N, code } = await household("c5c-nick");
  const K = katPhone("c5c-kat");
  assert.ok((await K.M.cloud.join(code)).ok);
  assert.ok((await N.sync()).ok);
  N.ctx.S.profile = "kat";           /* Katerina borrows Nick's phone ... */
  assert.ok((await N.sync()).ok);
  assert.strictEqual(rowsOf(N, "days", "kat").length, 3, "her diary came down");
  N.ctx.S.profile = "nick";          /* ... and hands it back: her rows leave (they're in the cloud) */
  assert.ok((await N.sync()).ok);
  assert.strictEqual(rowsOf(N, "days", "kat").length, 0, "her diary left his phone (it's in the cloud)");
  assert.strictEqual(rowsOf(N, "days", "nick").length, 5, "his never left");
  /* Change code: her diary goes to the new household too */
  const c = await N.M.cloud.changeCode();
  assert.ok(c.ok, JSON.stringify(c));
  assert.strictEqual(SERVER.all(c.code).filter(x => x.kind === "day" && /^kat\|/.test(x.id) && !x.deleted).length, 3, "her 3 days are in the new household");
  assert.strictEqual(SERVER.all(c.code).filter(x => x.kind === "body" && /^kat\|/.test(x.id) && !x.deleted).length, 1, "and her weigh-in");
  assert.strictEqual(SERVER.all(c.code).filter(x => x.kind === "day" && /^nick\|/.test(x.id) && !x.deleted).length, 5, "and his 5 days");
  /* Delete cloud copy: her diary comes back to his phone first */
  const d = await N.M.cloud.deleteCloud();
  assert.ok(d.ok, JSON.stringify(d));
  assert.strictEqual(rowsOf(N, "days", "kat").length, 3, "her diary is on his phone");
  assert.strictEqual(rowsOf(N, "body", "kat").length, 1, "and her weigh-in");
  assert.strictEqual(rowsOf(N, "days", "nick").length, 5, "his too");
  assert.strictEqual(rowsOf(N, "body", "nick").length, 5, "and his weigh-ins");
  K.M.cloud.leave();
});

/* ============================================================ round 4 (swarm #2) */
const dayNames = (P, pid, date) => { const d = P.M.MS.days[pid + "|" + (date || P.M.today())]; return d ? J(d.entries.map(e => e.name)) : null; };
const cloudDay = (code, id) => { const r = SERVER.all(code).find(x => x.kind === "day" && x.id === id); return r ? JSON.parse(r.data) : null; };

t("SY-01 a lent phone never loses its own person's diary; logging after switching back keeps the day", async () => {
  const { P: N, code } = await household("sy01-nick");
  const K = katPhone("sy01-kat");
  assert.ok((await K.M.cloud.join(code)).ok);
  assert.ok((await N.sync()).ok);
  assert.ok((await K.sync()).ok);
  const kid = "kat|" + K.M.today();
  /* Katerina lends her phone to Nick */
  K.ctx.S.profile = "nick";
  const r1 = await K.M.cloud.personChanged();
  assert.ok(r1.ok, JSON.stringify(r1));
  assert.strictEqual(rowsOf(K, "days", "nick").length, 5, "his diary came down at once (K6)");
  assert.strictEqual(rowsOf(K, "days", "kat").length, 3, "hers never left her phone");
  assert.strictEqual(rowsOf(K, "body", "kat").length, 1, "nor her weigh-in");
  assert.strictEqual(K.M.cloud.catchingUp(), false);
  /* switched back, no sync yet: her diary is right there; she logs a snack */
  K.ctx.S.profile = "kat";
  assert.deepStrictEqual(dayNames(K, "kat"), ["Kat dinner"], "her diary shows at once (SY-05)");
  assert.strictEqual(K.M.cloud.catchingUp(), false, "her own diary never waits");
  K.M.log.add(K.M.today(), { slot: "Snacks", name: "Kat snack", per: { cal: 150, p: 10, c: 15, f: 5 } });
  assert.ok((await K.sync()).ok);
  assert.deepStrictEqual(dayNames(K, "kat"), ["Kat dinner", "Kat snack"]);
  assert.deepStrictEqual(cloudDay(code, kid).entries.map(e => e.name), ["Kat dinner", "Kat snack"], "the cloud keeps both");
  assert.strictEqual(rowsOf(K, "days", "nick").length, 0, "the borrowed person's rows leave once she's back");
  assert.strictEqual(rowsOf(K, "days", "kat").length, 3);
  /* a phone an older build already trimmed: her day is gone here, she logs before a sync */
  const st = K.M.cloud._.state();
  delete K.M.MS.days[kid]; delete st.hashes["day|" + kid]; delete st.base["day|" + kid];
  K.M.log.add(K.M.today(), { slot: "Snacks", name: "Kat apple", per: { cal: 95, p: 0.5, c: 25, f: 0.3 } });
  assert.ok((await K.sync()).ok);
  assert.deepStrictEqual(dayNames(K, "kat").slice().sort(), ["Kat apple", "Kat dinner", "Kat snack"], "nothing erased on her phone");
  assert.deepStrictEqual(cloudDay(code, kid).entries.map(e => e.name).sort(), ["Kat apple", "Kat dinner", "Kat snack"], "nor in the cloud");
  /* a borrowed person waits for their diary: catchingUp says so until it's down */
  K.ctx.S.profile = "nick";
  assert.strictEqual(K.M.cloud.catchingUp(), true, "show Getting your diary…");
  assert.strictEqual(K.M.cloud.status().catchUp, true);
  await K.M.cloud.personChanged();
  assert.strictEqual(K.M.cloud.catchingUp(), false);
  assert.strictEqual(rowsOf(K, "days", "nick").length, 5);
  K.ctx.S.profile = "kat"; await K.sync();
  assert.ok(SERVER.all(code).every(r => r.deleted === false), "nothing deleted anywhere");
  /* the home person survives a reload of the sync state (phones that joined before this build use their training owner) */
  const disk = JSON.parse(K.store.get("chalk.sync.v1"));
  assert.strictEqual(disk.home, "kat");
  N.M.cloud.leave(); K.M.cloud.leave();
});

t("SY-02 days merge entry by entry: both phones' entries stay, deletes stick, the newer edit wins, water and note on their own", async () => {
  const { P: N, code } = await household("sy02-nick");
  const K = katPhone("sy02-kat");
  assert.ok((await K.M.cloud.join(code)).ok);
  K.ctx.S.profile = "nick";                      /* her phone logs for Nick too */
  assert.ok((await K.M.cloud.personChanged()).ok);
  assert.ok((await N.sync()).ok);
  const date = N.M.today(), id = "nick|" + date;
  const same = () => { assert.deepStrictEqual(dayNames(N, "nick"), dayNames(K, "nick")); assert.deepStrictEqual(cloudDay(code, id).entries.map(e => e.name), dayNames(N, "nick")); };
  const run = async () => { await N.sync(); await K.sync(); await N.sync(); await K.sync(); };
  /* 1. both log at the same time (a normal 2-minute tick) */
  N.M.log.add(date, { slot: "Snacks", name: "N snack", per: { cal: 200, p: 30, c: 5, f: 3 } });
  await sleep(5);
  K.M.log.add(date, { slot: "Dinner", name: "K dinner", per: { cal: 700, p: 50, c: 60, f: 20 } });
  await run();
  assert.deepStrictEqual(dayNames(N, "nick"), ["Chicken toast", "N snack", "K dinner"], "both entries kept, in time order");
  same();
  /* 2. N deletes his snack while K adds a drink: the delete sticks, the drink stays */
  const snack = N.M.MS.days[id].entries.find(e => e.name === "N snack").id;
  N.M.log.remove(date, snack);
  await sleep(5);
  K.M.log.add(date, { slot: "Snacks", name: "K drink", per: { cal: 100, p: 0, c: 25, f: 0 } });
  await K.sync(); await N.sync(); await K.sync(); await N.sync();
  assert.deepStrictEqual(dayNames(N, "nick"), ["Chicken toast", "K dinner", "K drink"], "deleted snack stays deleted");
  same();
  /* 3. the same entry edited on both: the newer edit wins; water and note merge on their own */
  const din = N.M.MS.days[id].entries.find(e => e.name === "K dinner").id;
  const t0 = Date.now();
  N.M.now = () => t0 + 1000; N.M.log.update(date, din, { servings: 2 }); N.M.log.setWater(date, 40);
  K.M.now = () => t0 + 2000; K.M.log.update(date, din, { servings: 3 }); K.M.log.setNote(date, "Big day");
  await run();
  N.M.now = () => Date.now(); K.M.now = () => Date.now();
  const e3 = P => P.M.MS.days[id].entries.find(e => e.id === din);
  assert.strictEqual(e3(N).servings, 3, "K's edit was newer");
  assert.strictEqual(e3(K).servings, 3);
  assert.strictEqual(N.M.MS.days[id].water, 40, "water from one phone");
  assert.strictEqual(K.M.MS.days[id].water, 40);
  assert.strictEqual(N.M.MS.days[id].note, "Big day", "note from the other");
  same();
  /* 4. nothing doubles, and the phones agree with the cloud (no echo) */
  const ids = N.M.MS.days[id].entries.map(e => e.id);
  assert.strictEqual(new Set(ids).size, ids.length, "no duplicate entries");
  const before = SERVER.all(code).length, posts = N.posts().length + K.posts().length;
  await run();
  assert.strictEqual(N.posts().length + K.posts().length, posts, "nothing left to send");
  assert.strictEqual(SERVER.all(code).length, before);
  /* 5. the merge base is small (fingerprints) and only kept for recent days */
  const b = N.M.cloud._.state().base["day|" + id];
  assert.ok(b && b.d === 1 && Object.keys(b.e).length === 3 && b.w === 40, JSON.stringify(b));
  const old = N.M.addDays(date, -90);
  N.M.log.add(old, { slot: "Lunch", name: "Old lunch", per: { cal: 300, p: 20, c: 30, f: 10 } });
  await N.sync(); await N.sync();
  assert.ok(N.M.cloud._.state().hashes["day|nick|" + old], "old day synced");
  assert.ok(!N.M.cloud._.state().base["day|nick|" + old], "but keeps no merge base");
  N.M.cloud.leave(); K.M.cloud.leave();
});

t("SY-02 no base (new day on both phones): nothing counts as deleted; water and note fill from the side that has them", async () => {
  const M1 = phone("sy02b").M;
  const md = M1.cloud._.mergeDay;   /* (base, sent, mine, theirs, theirDeletes, ourDeletes) */
  const e = (id, name, at, extra) => Object.assign({ id, name, at, slot: "Lunch", servings: 1, per: { cal: 100, p: 1, c: 1, f: 1 } }, extra || {});
  const mine = { id: "nick|2026-09-29", pid: "nick", date: "2026-09-29", entries: [e("a", "A", 1), e("b", "B", 3, { u: 20 })], water: 0, note: "", updatedAt: 10 };
  const theirs = { id: "nick|2026-09-29", pid: "nick", date: "2026-09-29", entries: [e("c", "C", 2), e("b", "B2", 3, { u: 10 })], water: 24, note: "hi", updatedAt: 5 };
  const out = J(md(null, null, mine, theirs));
  assert.deepStrictEqual(out.entries.map(x => x.name), ["A", "C", "B"], "union by id, time order, the newer edit stamp wins B");
  assert.strictEqual(out.water, 24); assert.strictEqual(out.note, "hi");
  assert.strictEqual(out.updatedAt, 10);
  /* the other phone settles it the same way */
  assert.deepStrictEqual(J(md(null, null, theirs, mine)).entries.find(x => x.id === "b").name, "B", "same winner on both phones");
  /* no stamps, or an exact tie: the larger copy wins, on both phones */
  const m0 = { entries: [e("b", "B", 3)], water: 0, note: "", updatedAt: 10 }, t0 = { entries: [e("b", "B2", 3)], water: 0, note: "", updatedAt: 99 };
  assert.strictEqual(J(md(null, null, m0, t0)).entries[0].name, J(md(null, null, t0, m0)).entries[0].name, "a tie settles the same way on both phones");
  /* with a base: a delete on one side sticks, on both phones, even against an edit */
  const base = M1.cloud._.dayBase({ entries: [e("a", "A", 1), e("b", "B", 3)], water: 0, note: "" });
  const t2 = { entries: [e("a", "A", 1)], water: 0, note: "", updatedAt: 20 };
  assert.deepStrictEqual(J(md(base, null, { entries: [e("a", "A", 1), e("b", "B", 3)], water: 0, note: "", updatedAt: 10 }, t2)).entries.map(x => x.name), ["A"], "delete sticks");
  const ed = { entries: [e("a", "A", 1), e("b", "B edited", 3, { u: 30 })], water: 0, note: "", updatedAt: 30 };
  assert.deepStrictEqual(J(md(base, null, ed, t2)).entries.map(x => x.name), ["A"], "a delete beats an edit made at the same time");
  assert.deepStrictEqual(J(md(base, null, t2, ed)).entries.map(x => x.name), ["A"], "on the other phone too");
});

t("SY-03 a saved meal edited on both phones: items by id, per and batch raw weight worked out again, cooked weight kept", async () => {
  const { P: N, code } = await household("sy03-nick");
  const K = katPhone("sy03-kat");
  assert.ok((await K.M.cloud.join(code)).ok);
  assert.ok((await N.sync()).ok);
  const run = async () => { await N.sync(); await K.sync(); await N.sync(); await K.sync(); };
  const check = (P, mid) => { const m = P.M.MS.meals[mid], exp = P.M.meals.computePer(m); assert.deepStrictEqual(J(m.per), J(exp), "per matches the items"); return m; };
  const mid = Object.values(N.M.MS.meals).find(m => m.name === "Chicken toast").id;
  /* A: he adds rice, she sets servings made = 2 */
  N.M.meals.update(mid, { items: N.M.MS.meals[mid].items.concat([{ name: "White rice, cooked", servings: 1, per: { cal: 205, p: 4.3, c: 45, f: 0.4 } }]) });
  await sleep(5);
  K.M.meals.update(mid, { servingsMade: 2 });
  await run();
  [N, K].forEach(P => { const m = check(P, mid); assert.strictEqual(m.items.length, 3); assert.strictEqual(m.servingsMade, 2); assert.strictEqual(m.per.cal, 272.5); });
  /* B: both add a different item */
  const mid2 = Object.values(N.M.MS.meals).find(m => m.name === "Pork tenderloin plate").id;
  N.M.meals.update(mid2, { items: N.M.MS.meals[mid2].items.concat([{ name: "Broccoli", servings: 1, per: { cal: 55, p: 3.7, c: 11, f: 0.6 } }]) });
  await sleep(5);
  K.M.meals.update(mid2, { items: K.M.MS.meals[mid2].items.concat([{ name: "Sweet potato", servings: 1, per: { cal: 112, p: 2, c: 26, f: 0.1 } }]) });
  await run();
  [N, K].forEach(P => { const m = check(P, mid2); assert.deepStrictEqual(J(m.items.map(i => i.name).sort()), ["Broccoli", "Pork tenderloin", "Sweet potato"]); });
  /* C: batch: he changes the cooked weight, she adds an onion (150 g) */
  N.M.meals.update(mid2, { batch: { cookedG: 900 } });
  await run();
  N.M.meals.update(mid2, { batch: { cookedG: 1200 } });
  await sleep(5);
  K.M.meals.update(mid2, { items: K.M.MS.meals[mid2].items.concat([{ name: "Onion", servings: 1, g: 150, per: { cal: 60, p: 1.6, c: 14, f: 0.2 } }]) });
  await run();
  [N, K].forEach(P => { const m = check(P, mid2); assert.strictEqual(m.batch.cookedG, 1200, "his cooked weight kept"); assert.strictEqual(m.batch.rawG, P.M.cook.rawTotal(m.items), "raw weight from the items"); assert.strictEqual(m.items.length, 4); });
  /* foods: the numbers come from one side together (serving + per never mixed) */
  const fid = Object.values(N.M.MS.foods).find(f => f.name === "Zucchini").id;
  N.M.foods.update(fid, { serving: { qty: 1, unit: "medium", g: 196 }, per: { cal: 33, p: 2.4, c: 6.1, f: 0.6 } });
  await sleep(5);
  K.M.foods.update(fid, { per: { cal: 25, p: 2, c: 4, f: 0.5 }, brand: "Farm" });
  await run();
  [N, K].forEach(P => { const f = P.M.MS.foods[fid]; assert.strictEqual(f.serving.unit, "cup", "her numbers (newer) came together"); assert.strictEqual(f.per.cal, 25); assert.strictEqual(f.brand, "Farm"); });
  N.M.cloud.leave(); K.M.cloud.leave();
});

t("SY-04 a training restore adds the backup to this phone's workouts; Undo keeps workouts logged since", async () => {
  const { P: N, code } = await household("sy04-nick", { train: trainState("nick", ["n1", "n2", "n3"]) });
  const K = katPhone("sy04-kat", { train: trainState("kat", ["k1", "k2", "k3", "k4"]) });
  assert.ok((await K.M.cloud.join(code)).ok); assert.ok((await K.sync()).ok); assert.ok((await N.sync()).ok);
  /* her NEW phone already has 2 workouts; one is in progress */
  const K2 = phone("sy04-k2", { S: { profile: "kat", active: null }, train: trainState("kat", ["new1", "new2"], { active: { name: "Legs", start: Date.now() } }) });
  assert.ok((await K2.M.cloud.join(code)).ok);
  const info = K2.M.cloud.training();
  assert.ok(info && info.missing === 4 && info.keep === 2, JSON.stringify(info));
  const before = K2.store.get("chalk.v1");
  assert.strictEqual(await K2.M.cloud.restoreTraining(), true);
  const after = K2.train();
  assert.deepStrictEqual(J(after.log.map(w => w.id)).sort(), ["k1", "k2", "k3", "k4", "new1", "new2"], "nothing on this phone was dropped");
  assert.ok(after.log.every((w, i) => i === 0 || after.log[i - 1].start >= w.start), "newest first, like Chalk");
  assert.strictEqual(after.active && after.active.name, "Legs", "the workout in progress stays");
  assert.ok((await K2.sync()).ok);
  const cloudIds = J(trainOf(SERVER.get(code, "train", "kat")).log.map(w => w.id)).sort();
  assert.deepStrictEqual(cloudIds, ["k1", "k2", "k3", "k4", "new1", "new2"], "the backup now has all six");
  /* she logs a workout, then taps Undo: back to her 2, plus the one logged since */
  const t = K2.train(); t.log.push({ id: "since1", name: "Workout since1", start: Date.now(), sets: {} }); t.active = null; K2.setTrain(t);
  assert.strictEqual(K2.M.cloud.undoRestore(), true);
  assert.deepStrictEqual(J(K2.train().log.map(w => w.id)), ["since1", "new2", "new1"], "Undo keeps the workout logged since (newest first)");
  /* nothing logged since: Undo gives back the exact text */
  const K3 = phone("sy04-k3", { S: { profile: "kat", active: null }, train: trainState("kat", ["x1"]) });
  assert.ok((await K3.M.cloud.join(code)).ok);
  const b3 = K3.store.get("chalk.v1");
  assert.strictEqual(await K3.M.cloud.restoreTraining(), true);
  assert.strictEqual(K3.train().log.length, 7);
  assert.strictEqual(K3.M.cloud.undoRestore(), true);
  assert.strictEqual(K3.store.get("chalk.v1"), b3, "byte for byte");
  assert.ok(before);
  [N, K, K2, K3].forEach(P => P.M.cloud.leave());
});

t("K4 / SE-01 incoming rows also go through m-core's cleaner (when it has one); bad lookup ids are blanked; lines keep steady ids", async () => {
  const { P: N, code } = await household("k4-nick");
  const B2 = phone("k4-b2");
  assert.ok((await B2.M.cloud.join(code)).ok);
  const date = "2026-01-02", now = Date.now();
  const day = { id: "nick|" + date, pid: "nick", date, updatedAt: now, water: 0, note: "", entries: [
    { id: "e1", name: "Evil", slot: "Lunch", servings: 1, foodId: "__proto__", mealId: "constructor", per: { cal: 10, p: 1, c: 1, f: 1 }, at: now },
    { name: "No id", slot: "Lunch", servings: 1, per: { cal: 5, p: 0, c: 1, f: 0 }, at: now },
    { id: "e1", name: "Same id", slot: "Lunch", servings: 1, per: { cal: 5, p: 0, c: 1, f: 0 }, at: now }] };
  SERVER.put({ household: code, kind: "day", id: day.id, data: day, client_updated: now, device: "old-app" });
  SERVER.put({ household: code, kind: "meal", id: "m-hostile", data: { id: "m-hostile", name: "Hostile", slot: "Lunch", servingsMade: 1, items: [{ name: "A", servings: 1, mealId: "__proto__", per: { cal: 100, p: 1, c: 1, f: 1 } }, { name: "B", servings: 2, per: { cal: 50, p: 1, c: 1, f: 1 } }], per: { cal: 200, p: 3, c: 3, f: 3 }, updatedAt: now }, client_updated: now, device: "old-app" });
  SERVER.put({ household: code, kind: "body", id: "nick|" + date, data: { id: "nick|" + date, pid: "nick", date, w: 5000, rhr: null, at: now }, client_updated: now, device: "old-app" });
  let calls = 0;
  const orig = B2.M.clean;
  assert.strictEqual(typeof orig, "function", "m-core has M.clean (K4)");
  B2.M.clean = function () { calls++; return orig.apply(this, arguments); };
  assert.ok((await B2.sync()).ok);
  assert.ok(calls > 0, "m-core's cleaner ran");
  const d = B2.M.MS.days[day.id];
  assert.ok(d && d.entries.length === 3, "every entry kept");
  assert.ok(!("foodId" in d.entries[0]) && !("mealId" in d.entries[0]), "no lookups by __proto__ / constructor");
  const ids = J(d.entries.map(e => e.id));
  assert.strictEqual(new Set(ids).size, 3, "no two entries share an id: " + ids);
  assert.ok(!B2.M.MS.body["nick|" + date], "a 5,000 lb weigh-in is refused");
  const m = B2.M.MS.meals["m-hostile"];
  assert.ok(m && m.items.every(it => typeof it.id === "string" && it.id) && !("mealId" in m.items[0]), JSON.stringify(m && m.items));
  assert.strictEqual(({}).polluted, undefined);
  /* the same rows read again give the same ids (a merge matches lines by id: nothing doubles) */
  B2.M.cloud._.state().cursor = "";
  assert.ok((await B2.sync()).ok);
  assert.deepStrictEqual(J(B2.M.MS.days[day.id].entries.map(e => e.id)), ids, "steady ids");
  assert.strictEqual(B2.M.MS.meals["m-hostile"].items.length, 2);
  /* without m-core's cleaner, sync's own still does all of this */
  const B3 = phone("k4-b3");
  B3.M.clean = undefined;
  assert.ok((await B3.M.cloud.join(code)).ok);
  const d3 = B3.M.MS.days[day.id];
  assert.ok(d3 && d3.entries.length === 3 && !("foodId" in d3.entries[0]));
  assert.strictEqual(new Set(J(d3.entries.map(e => e.id))).size, 3);
  [N, B2, B3].forEach(P => P.M.cloud.leave());
});

t("PF-03 / PF-04 one logged food: one sync-state write per cycle, and only changed records are hashed again", async () => {
  const { P: N, code } = await household("pf-nick");
  for (let i = 5; i < 60; i++) N.M.log.add(N.M.addDays(N.M.today(), -i), { slot: "Lunch", name: "Day " + i, per: { cal: 300, p: 20, c: 30, f: 10 } });
  assert.ok((await N.sync()).ok); assert.ok((await N.sync()).ok);
  let writes = 0;
  const set = N.ctx.localStorage.setItem;
  N.ctx.localStorage.setItem = (k, v) => { if (k === "chalk.sync.v1") writes++; return set(k, v); };
  N.M.log.add(N.M.today(), { slot: "Snacks", name: "One snack", per: { cal: 100, p: 5, c: 10, f: 2 } });
  const r = await N.M.cloud._.cycle({ reason: "save" });
  assert.ok(r.ok && r.pushed === 1, JSON.stringify(r));
  assert.strictEqual(writes, 1, "the sync state was written once (was 4+ times)");
  N.ctx.localStorage.setItem = set;
  /* the per-record cache never hides a change: edits, water, a note and a deleted entry all go up */
  const id = "nick|" + N.M.today(), d = N.M.MS.days[id];
  const e0 = d.entries[d.entries.length - 1].id;
  const cloudDay = () => JSON.parse(SERVER.get(code, "day", id).data);
  N.M.log.update(N.M.today(), e0, { servings: 3 }); assert.ok((await N.sync()).ok);
  assert.strictEqual(cloudDay().entries.find(e => e.id === e0).servings, 3);
  N.M.log.setWater(N.M.today(), 32); assert.ok((await N.sync()).ok);
  assert.strictEqual(cloudDay().water, 32);
  N.M.log.remove(N.M.today(), e0); assert.ok((await N.sync()).ok);
  assert.ok(!cloudDay().entries.some(e => e.id === e0));
  const wd = N.M.MS.body[Object.keys(N.M.MS.body)[0]];
  N.M.body.add({ date: wd.date, w: 181.5 }); assert.ok((await N.sync()).ok);
  assert.strictEqual(JSON.parse(SERVER.get(code, "body", wd.id).data).w, 181.5);
  N.M.cloud.leave();
});

t("Change code moves the other person's training backup too; if it can't, nothing changes", async () => {
  const { P: N, code } = await household("cc-nick", { train: trainState("nick", ["n1", "n2"]) });
  const K = katPhone("cc-kat", { train: trainState("kat", ["k1", "k2", "k3"]) });
  assert.ok((await K.M.cloud.join(code)).ok); assert.ok((await K.sync()).ok); assert.ok((await N.sync()).ok);
  /* the cloud can't be reached for the move: the old code keeps working */
  N.offline(true);
  const bad = await N.M.cloud.changeCode();
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(N.M.cloud.status().code, code, "still the old code");
  N.offline(false);
  const c = await N.M.cloud.changeCode();
  assert.ok(c.ok && c.code !== code, JSON.stringify(c));
  const kt = SERVER.get(c.code, "train", "kat");
  assert.ok(kt && !kt.deleted, "her training backup is in the new household");
  assert.deepStrictEqual(J(trainOf(kt).log.map(w => w.id)), ["k1", "k2", "k3"]);
  assert.deepStrictEqual(J(trainOf(SERVER.get(c.code, "train", "nick")).log.map(w => w.id)), ["n1", "n2"], "and his");
  assert.ok(SERVER.all(code).every(r => r.deleted === true), "the old household is cleared");
  N.M.cloud.leave(); K.M.cloud.leave();
});

t("SY-04 on a borrowed phone, a restore never mixes the other person's workouts into hers", async () => {
  const { P: N, code } = await household("sy04b-nick", { train: trainState("nick", ["n1", "n2"]) });
  const K = katPhone("sy04b-kat", { train: trainState("kat", ["k1", "k2", "k3"]) });
  assert.ok((await K.M.cloud.join(code)).ok); assert.ok((await K.sync()).ok); assert.ok((await N.sync()).ok);
  /* Katerina borrows Nick's phone (history stays: his 2 workouts now say kat) */
  N.ctx.S.profile = "kat"; N.setTrain(Object.assign(N.train(), { profile: "kat", updatedAt: Date.now() }));
  await N.M.cloud._.cycle({ reason: "tick" });
  const info = N.M.cloud.training();
  assert.ok(info && info.keep === 0, "none of these workouts are hers: " + JSON.stringify(info));
  assert.strictEqual(await N.M.cloud.restoreTraining(), true);
  assert.deepStrictEqual(J(N.train().log.map(w => w.id)), ["k1", "k2", "k3"], "only hers");
  assert.ok((await N.sync()).ok);
  assert.deepStrictEqual(J(trainOf(SERVER.get(code, "train", "kat")).log.map(w => w.id)), ["k1", "k2", "k3"], "her backup stays clean");
  assert.deepStrictEqual(J(trainOf(SERVER.get(code, "train", "nick")).log.map(w => w.id)), ["n1", "n2"], "his stay in his backup");
  N.M.cloud.leave(); K.M.cloud.leave();
});

t("C5 upgrade: a phone that synced before day bases were kept never brings back the other phone's deletes (also days older than 60); a push race still keeps both", async () => {
  const { P: A, code } = await household("c5up-a");
  const B = phone("c5up-b");                          /* a second phone on Nick */
  const date = A.M.today(), old = A.M.addDays(date, -61), per = { cal: 300, p: 40, c: 0, f: 10 };
  A.M.log.add(date, { slot: "Dinner", name: "Pork", per });
  A.M.log.add(old, { slot: "Dinner", name: "Old A", per }); A.M.log.add(old, { slot: "Dinner", name: "Old B", per });
  assert.ok((await A.sync()).ok);
  assert.ok((await B.M.cloud.join(code)).ok);
  await B.sync(); await A.sync(); await B.sync();
  assert.deepStrictEqual(dayNames(B, "nick"), ["Chicken toast", "Pork"]);
  assert.deepStrictEqual(dayNames(B, "nick", old), ["Old A", "Old B"]);
  /* what the live build (b01144d) left in storage: no day bases and no home */
  [A, B].forEach(P => { const s = P.M.cloud._.state(); Object.keys(s.base).forEach(k => { if (k.startsWith("day|")) delete s.base[k]; }); s.home = ""; });
  const del = (P, d, name) => P.M.log.remove(d, P.M.MS.days["nick|" + d].entries.find(e => e.name === name).id);
  del(A, date, "Chicken toast"); del(A, old, "Old A");
  assert.ok((await A.sync()).ok); assert.ok((await B.sync()).ok); assert.ok((await A.sync()).ok); assert.ok((await B.sync()).ok);
  [A, B].forEach(P => {
    assert.deepStrictEqual(dayNames(P, "nick"), ["Pork"], P.name + ": the delete sticks");
    assert.deepStrictEqual(dayNames(P, "nick", old), ["Old B"], P.name + ": the delete sticks on a day older than 60");
  });
  assert.deepStrictEqual(cloudDay(code, "nick|" + date).entries.map(e => e.name), ["Pork"]);
  assert.deepStrictEqual(cloudDay(code, "nick|" + old).entries.map(e => e.name), ["Old B"]);
  /* right after an upgrade both phones log and push at once (neither saw the other): both stay */
  [A, B].forEach(P => { const s = P.M.cloud._.state(); Object.keys(s.base).forEach(k => { if (k.startsWith("day|")) delete s.base[k]; }); });
  A.M.cloud.configure({ delay: 60 }); B.M.cloud.configure({ delay: 60 });
  A.M.log.add(date, { slot: "Snacks", name: "A snack", per });
  B.M.log.add(date, { slot: "Snacks", name: "B snack", per });
  await Promise.all([A.sync(), B.sync()]);
  for (let i = 0; i < 2; i++) { await A.sync(); await B.sync(); }
  [A, B].forEach(P => assert.deepStrictEqual(dayNames(P, "nick"), ["Pork", "A snack", "B snack"], P.name + ": nothing lost in the race"));
  /* the same race on a day older than 60 days (no base kept there) */
  A.M.log.add(old, { slot: "Snacks", name: "A old snack", per });
  B.M.log.add(old, { slot: "Snacks", name: "B old snack", per });
  await Promise.all([A.sync(), B.sync()]);
  for (let i = 0; i < 2; i++) { await A.sync(); await B.sync(); }
  [A, B].forEach(P => assert.deepStrictEqual(dayNames(P, "nick", old), ["Old B", "A old snack", "B old snack"], P.name + ": nothing lost on an old day"));
  /* and then nothing more to send, both ways */
  const pa = A.posts().length, pb = B.posts().length;
  await A.sync(); await B.sync(); await A.sync(); await B.sync();
  assert.strictEqual(A.posts().length - pa + B.posts().length - pb, 0, "no ping-pong");
  A.M.cloud.configure({ delay: 0 }); B.M.cloud.configure({ delay: 0 });
  A.M.cloud.leave(); B.M.cloud.leave();
});

t("C5 restore and Undo keep Chalk's order: newest workout first (log[0] is the last workout)", async () => {
  const now = Date.now(), w = (id, daysAgo) => ({ id, name: "Workout " + id, start: now - daysAgo * DAY, sets: { squat: [{ w: 225, r: 5 }] } });
  /* real Chalk logs are newest first (it adds with unshift and sorts b.start - a.start) */
  const O = phone("c5ord-old", { train: trainState("nick", [], { log: [w("b1", 2), w("b2", 9), w("b3", 16)] }) });
  seedNick(O);
  const code = O.M.cloud.create(); assert.ok((await O.sync()).ok);
  const P = phone("c5ord-new", { train: trainState("nick", [], { log: [w("p1", 1), w("p2", 12)] }) });
  assert.ok((await P.M.cloud.join(code)).ok);
  assert.strictEqual(await P.M.cloud.restoreTraining(), true);
  assert.deepStrictEqual(J(P.train().log.map(x => x.id)), ["p1", "b1", "b2", "p2", "b3"], "newest first after the restore");
  /* a workout logged since, then Undo: still newest first */
  const t2 = P.train(); t2.log.unshift(w("since", 0)); t2.updatedAt = Date.now(); P.setTrain(t2);
  assert.strictEqual(P.M.cloud.undoRestore(), true);
  assert.deepStrictEqual(J(P.train().log.map(x => x.id)), ["since", "p1", "p2"], "newest first after Undo");
  O.M.cloud.leave(); P.M.cloud.leave();
});

t("C5 an Undo copy made by the live build (its restore replaced every workout) keeps its week; a new one keeps one day", async () => {
  const raw = JSON.stringify(trainState("nick", ["only1", "only2"]));
  const oldCopy = JSON.stringify({ v: 1, at: Date.now() - 3 * DAY, pid: "nick", n: 2, raw });
  const P = phone("c5undo-old", { store: { "chalk.sync.undo": oldCopy }, train: trainState("nick", ["b1"]) });
  const u = P.M.cloud.undoInfo();
  assert.ok(u && u.n === 2 && u.pid === "nick", "still there after 3 days: " + JSON.stringify(u));
  assert.strictEqual(P.store.get("chalk.sync.undo"), oldCopy);
  assert.strictEqual(P.M.cloud.undoRestore(), true);
  assert.deepStrictEqual(J(P.train().log.map(w => w.id)).sort(), ["b1", "only1", "only2"], "the replaced workouts come back, none lost");
  const tooOld = JSON.stringify({ v: 1, at: Date.now() - 8 * DAY, pid: "nick", n: 2, raw });
  const P2 = phone("c5undo-8d", { store: { "chalk.sync.undo": tooOld } });
  assert.strictEqual(P2.M.cloud.undoInfo(), null); assert.ok(!P2.store.has("chalk.sync.undo"), "a week is the most");
  const newCopy = JSON.stringify({ v: 1, at: Date.now() - 2 * DAY, pid: "nick", n: 2, raw, bk: ["b1"] });
  const P3 = phone("c5undo-new", { store: { "chalk.sync.undo": newCopy } });
  assert.strictEqual(P3.M.cloud.undoInfo(), null); assert.ok(!P3.store.has("chalk.sync.undo"), "this build's copy: one day");
});

/* ------------------------------------------ S3-01 / S3-02: both phones settle the same way */
const noUse = o => { const x = Object.assign({}, o); delete x.uses; delete x.lastUsed; return x; };
/* after a conflict: a few rounds to settle, then one more round moves nothing, and the phones
   and the cloud hold the same copy */
async function settleIdle(Ps, label, kind, id, code) {
  for (let i = 0; i < 5; i++) for (const P of Ps) await P.sync();
  for (const P of Ps) { const r = await P.sync(); assert.ok(r.ok && !r.pushed && !r.applied, label + ": still moving after 5 rounds " + JSON.stringify(r)); }
  const coll = { food: "foods", meal: "meals", day: "days" }[kind];
  const cloud = Ps[0].M.cloud._.clean(kind, id, JSON.parse(SERVER.get(code, kind, id).data));
  const want = Ps[0].M.cloud._.hash(noUse(cloud));
  Ps.forEach((P, i) => assert.strictEqual(P.M.cloud._.hash(noUse(P.M.MS[coll][id])), want, label + ": phone " + i + " differs from the cloud"));
}

t("S3-01 a food both phones changed, then one more edit: both settle on one copy, nothing ping-pongs", async () => {
  const { P: N, code } = await household("s301f-n");
  const K = katPhone("s301f-k");
  [N, K].forEach(P => P.M.cloud.configure({ delay: 1e9 }));
  assert.ok((await K.M.cloud.join(code)).ok); await K.sync(); await N.sync(); await K.sync(); await N.sync();
  const fid = Object.values(N.M.MS.foods).find(f => /Kirkland/.test(f.name)).id;
  N.offline(true); K.offline(true);
  N.M.foods.update(fid, { per: { cal: 130, p: 28, c: 0, f: 2 } }); await sleep(5);
  K.M.foods.update(fid, { per: { cal: 110, p: 24, c: 0, f: 1 } }); await sleep(5);
  N.M.foods.update(fid, { brand: "Kirkland Signature" }); await sleep(5);
  K.M.foods.update(fid, { name: "Kirkland chicken (raw)" }); await sleep(5);
  N.offline(false); K.offline(false);
  await N.sync(); await K.sync();
  N.M.foods.update(fid, { barcode: "0096619000000" }); await sleep(5);
  await settleIdle([N, K], "food", "food", fid, code);
  const f = K.M.MS.foods[fid];
  assert.strictEqual(f.brand, "Kirkland Signature"); assert.strictEqual(f.name, "Kirkland chicken (raw)"); assert.strictEqual(f.barcode, "0096619000000");
  assert.ok(f.per.cal === 110 || f.per.cal === 130, "one side's numbers, whole: " + JSON.stringify(f.per));
  [N, K].forEach(P => P.M.cloud.leave());
});

t("S3-01 a saved meal both phones changed, then one more edit: both settle on one copy", async () => {
  const { P: N, code } = await household("s301m-n");
  const K = katPhone("s301m-k");
  [N, K].forEach(P => P.M.cloud.configure({ delay: 1e9 }));
  assert.ok((await K.M.cloud.join(code)).ok); await K.sync(); await N.sync(); await K.sync(); await N.sync();
  const mid = Object.values(N.M.MS.meals).find(m => m.name === "Chicken toast").id;
  const edit = (P, f) => { const m = P.M.MS[ "meals"][mid]; const items = m.items.map(i => Object.assign({}, i)); f(items); P.M.meals.update(mid, { items }); };
  N.offline(true); K.offline(true);
  edit(N, items => { items[1].servings = 3; }); await sleep(5);
  edit(K, items => { items[1].servings = 1; }); await sleep(5);
  N.M.meals.update(mid, { desc: "Nick's note" }); await sleep(5);
  K.M.meals.update(mid, { name: "Chicken toast (Kat)" }); await sleep(5);
  N.offline(false); K.offline(false);
  await N.sync(); await K.sync();
  N.M.meals.update(mid, { slot: "Dinner" }); await sleep(5);
  await settleIdle([N, K], "meal", "meal", mid, code);
  const m = N.M.MS.meals[mid];
  assert.strictEqual(m.desc, "Nick's note"); assert.strictEqual(m.name, "Chicken toast (Kat)"); assert.strictEqual(m.slot, "Dinner");
  assert.strictEqual(m.items.length, 2);
  assert.strictEqual(N.M.cloud._.canon(m.per), N.M.cloud._.canon(N.M.meals.computePer(m)), "per matches the merged items: " + JSON.stringify(m.per) + " vs " + JSON.stringify(N.M.meals.computePer(m)));
  [N, K].forEach(P => P.M.cloud.leave());
});

t("S3-01 one diary entry changed on two phones, then one more add: both settle, every add kept", async () => {
  const { P: N, code } = await household("s301d-n");
  const N2 = phone("s301d-n2", { S: { profile: "nick", active: null } });
  [N, N2].forEach(P => P.M.cloud.configure({ delay: 1e9 }));
  assert.ok((await N2.M.cloud.join(code)).ok); await N2.sync(); await N.sync(); await N2.sync(); await N.sync();
  const today = N.M.today(), id = "nick|" + today;
  const x = N.M.log.add(today, { slot: "Dinner", name: "Chicken breast", per: { cal: 200, p: 30, c: 0, f: 8 } });
  await N.sync(); await N2.sync(); await N.sync(); await N2.sync();
  N.offline(true); N2.offline(true);
  N.M.log.update(today, x.id, { servings: 2 }); await sleep(5);
  N2.M.log.update(today, x.id, { servings: 1.5 }); await sleep(5);
  N.M.log.add(today, { slot: "Snacks", name: "Apple", per: { cal: 95, p: 0, c: 25, f: 0 } }); await sleep(5);
  N2.M.log.add(today, { slot: "Snacks", name: "Pear", per: { cal: 100, p: 1, c: 27, f: 0 } }); await sleep(5);
  N.offline(false); N2.offline(false);
  await N.sync(); await N2.sync();
  N.M.log.add(today, { slot: "Snacks", name: "Almonds", per: { cal: 160, p: 6, c: 6, f: 14 } }); await sleep(5);
  await settleIdle([N, N2], "day", "day", id, code);
  const names = N2.M.MS.days[id].entries.map(e => e.name);
  ["Chicken breast", "Apple", "Pear", "Almonds"].forEach(n => assert.ok(names.includes(n), n + " kept: " + names));
  const s = N2.M.MS.days[id].entries.find(e => e.id === x.id).servings;
  assert.ok(s === 2 || s === 1.5, "one of the two edits: " + s);
  [N, N2].forEach(P => P.M.cloud.leave());
});

t("S3-02 a delete or edit made right after this phone's own push sticks when the other phone's copy comes first", async () => {
  for (const variant of ["delete", "edit"]) {
    const { P: N, code } = await household("s302n-" + variant);
    const K = katPhone("s302k-" + variant);
    [N, K].forEach(P => P.M.cloud.configure({ delay: 1e9 }));
    assert.ok((await K.M.cloud.join(code)).ok); await N.sync(); await K.sync();
    const today = K.M.today(), id = "kat|" + today;
    const y = K.M.log.add(today, { slot: "Breakfast", name: "Greek yogurt", per: { cal: 150, p: 12, c: 10, f: 6 } });
    assert.ok((await K.sync()).ok);
    K.offline(true);
    if (variant === "delete") K.M.log.remove(today, y.id); else K.M.log.update(today, y.id, { servings: 2 });
    await sleep(20);
    /* Nick logs her lunch on his phone (Switch person) */
    N.ctx.S.profile = "kat"; await N.M.cloud.personChanged();
    N.M.log.add(today, { slot: "Lunch", name: "Salad", per: { cal: 150, p: 12, c: 10, f: 6 } });
    assert.ok((await N.sync()).ok);
    N.ctx.S.profile = "nick"; await N.M.cloud.personChanged();
    K.offline(false);
    await K.sync(); await N.sync(); await K.sync();
    const mine = K.M.MS.days[id].entries, cloud = JSON.parse(SERVER.get(code, "day", id).data).entries;
    [mine, cloud].forEach((L, i) => {
      const w = i ? "cloud" : "her phone";
      assert.ok(L.some(e => e.name === "Salad"), variant + ": Nick's add kept on " + w);
      const yy = L.find(e => e.id === y.id);
      if (variant === "delete") assert.ok(!yy, "the delete sticks on " + w);
      else assert.ok(yy && yy.servings === 2, "the edit sticks on " + w + ": " + J(yy));
    });
    [N, K].forEach(P => P.M.cloud.leave());
  }
});

t("S3-04 a sync while the person picker is open still brings down the phone's own person's new rows", async () => {
  const { P: N, code } = await household("s304-n", { train: trainState("nick", ["n1"]) });
  const K = katPhone("s304-k", { train: trainState("kat", ["k1"]) });
  [N, K].forEach(P => P.M.cloud.configure({ delay: 1e9 }));
  assert.ok((await K.M.cloud.join(code)).ok); await K.sync(); await N.sync(); await K.sync();
  const d5 = K.M.addDays(K.M.today(), -5);
  N.ctx.S.profile = "kat"; N.setTrain(Object.assign(N.train(), { profile: "kat" })); await N.M.cloud.personChanged();
  N.M.log.add(d5, { slot: "Dinner", name: "Salmon", per: { cal: 400, p: 40, c: 0, f: 25 } });
  N.M.body.add({ date: d5, w: 134, pid: "kat" });
  assert.ok((await N.sync()).ok);
  N.ctx.S.profile = "nick"; N.setTrain(Object.assign(N.train(), { profile: "nick" })); await N.M.cloud.personChanged();
  K.ctx.S.profile = null;                       /* the picker is open */
  assert.ok((await K.sync()).ok);
  K.ctx.S.profile = "kat";                      /* Cancel */
  await K.sync();
  assert.ok(K.M.MS.days["kat|" + d5] && K.M.MS.days["kat|" + d5].entries.some(e => e.name === "Salmon"), "her day came down");
  assert.ok(K.M.MS.body["kat|" + d5], "her weigh-in came down");
  assert.ok(!Object.keys(K.M.MS.days).some(k => k.startsWith("nick|")), "Nick's diary stays off her phone");
  [N, K].forEach(P => P.M.cloud.leave());
});

t("S3-03 once the cursor has settled, an idle sync reads nothing again", async () => {
  const { P: A, code } = await household("s303-a");
  const B = phone("s303-b", { S: { profile: "nick", active: null } });
  [A, B].forEach(P => P.M.cloud.configure({ delay: 1e9 }));
  assert.ok((await B.M.cloud.join(code)).ok); await B.sync();
  for (let i = 0; i < 20; i++) A.M.foods.add({ name: "Burst food " + i, per: { cal: 10 + i } });
  assert.ok((await A.sync()).ok);
  /* rows a pull reads (the household check reads its own row: not counted) */
  let rows = 0, seen = []; SERVER.mutate = r => { const p = r.filter(x => x && x.kind !== "meta"); rows += p.length; seen = seen.concat(p.map(x => x.kind + ":" + x.id)); return r; };
  try {
    assert.ok((await B.sync()).ok); assert.ok(rows >= 20, "the burst came down: " + rows);
    rows = 0; assert.ok((await B.sync()).ok);
    assert.ok(rows >= 1, "right after, the last 10 s are read again (a late row may still commit): " + rows);
    let skew = 120000; B.M.now = () => Date.now() + skew;
    rows = 0; assert.ok((await B.sync()).ok); assert.ok(rows >= 1, "one more read a minute later");
    rows = 0; seen = []; const r = await B.sync(); assert.ok(r.ok && !r.applied && !r.pushed, JSON.stringify(r) + " " + B.M.cloud._.state().cursor + " ov " + B.M.cloud._.state().ov);
    assert.strictEqual(rows, 0, "then idle syncs read nothing again: " + JSON.stringify(seen));
    /* a new row moves the cursor: the next pull reads it */
    A.M.foods.add({ name: "After the burst" }); assert.ok((await A.sync()).ok);
    await B.sync();
    assert.ok(Object.values(B.M.MS.foods).some(f => f.name === "After the burst"));
  } finally { SERVER.mutate = null; }
  [A, B].forEach(P => P.M.cloud.leave());
});

t("S3-02 a phone that never saw its own push come back still takes the other phone's delete (the row says what was deleted)", async () => {
  const { P: N, code } = await household("s302g-n");
  const N2 = phone("s302g-n2", { S: { profile: "nick", active: null } });
  [N, N2].forEach(P => P.M.cloud.configure({ delay: 1e9 }));
  assert.ok((await N2.M.cloud.join(code)).ok); await N2.sync(); await N.sync(); await N2.sync();
  const day = N.M.addDays(N.M.today(), -9), id = "nick|" + day;
  const e = N2.M.log.add(day, { slot: "Lunch", name: "Tuna", per: { cal: 120, p: 26, c: 0, f: 1 } });
  assert.ok((await N2.sync()).ok);
  N2.offline(true);                              /* its own row never comes back to it */
  await N.sync();
  assert.ok(N.M.MS.days[id].entries.some(x => x.id === e.id));
  N.M.log.remove(day, e.id);
  assert.ok((await N.sync()).ok);
  const row = JSON.parse(SERVER.get(code, "day", id).data);
  assert.ok(row.gone && row.gone["i" + e.id], "the row lists the deleted entry: " + JSON.stringify(row.gone));
  N2.offline(false);
  for (let i = 0; i < 3; i++) { await N2.sync(); await N.sync(); }
  assert.ok(!N2.M.MS.days[id].entries.some(x => x.id === e.id), "the delete sticks on the phone that added it");
  assert.ok(!JSON.parse(SERVER.get(code, "day", id).data).entries.some(x => x.id === e.id), "and in the cloud");
  assert.ok(!("gone" in N2.M.MS.days[id]) && !("gone" in N.M.MS.days[id]), "the list never lands in a phone's diary");
  for (const P of [N, N2]) { const r = await P.sync(); assert.ok(r.ok && !r.pushed && !r.applied, "idle: " + JSON.stringify(r)); }
  [N, N2].forEach(P => P.M.cloud.leave());
});

t("S3-02 an old day (no merge base kept): two phones add at once and their pushes race: both adds kept", async () => {
  const { P: N, code } = await household("s302old-n");
  const N2 = phone("s302old-n2", { S: { profile: "nick", active: null } });
  [N, N2].forEach(P => P.M.cloud.configure({ delay: 1e9 }));
  const day = N.M.addDays(N.M.today(), -75), id = "nick|" + day;
  N.M.log.add(day, { slot: "Lunch", name: "Old lunch", per: { cal: 300, p: 20, c: 30, f: 10 } });
  assert.ok((await N.sync()).ok);
  assert.ok((await N2.M.cloud.join(code)).ok); await N2.sync(); await N.sync(); await N2.sync();
  assert.ok(!N.M.cloud._.state().base["day|" + id], "no base for a day this old");
  N.M.log.add(day, { slot: "Dinner", name: "Phone 1 dinner", per: { cal: 500, p: 40, c: 40, f: 20 } });
  N2.M.log.add(day, { slot: "Snacks", name: "Phone 2 snack", per: { cal: 100, p: 2, c: 20, f: 1 } });
  /* both push before either pulls the other's */
  assert.ok((await N.M.cloud._.cycle({ reason: "manual", manual: true, pull: false })).ok);
  assert.ok((await N2.M.cloud._.cycle({ reason: "manual", manual: true, pull: false })).ok);
  for (let i = 0; i < 3; i++) { await N.sync(); await N2.sync(); }
  for (const L of [N.M.MS.days[id].entries, N2.M.MS.days[id].entries, JSON.parse(SERVER.get(code, "day", id).data).entries])
    assert.deepStrictEqual(J(L.map(e => e.name).sort()), ["Old lunch", "Phone 1 dinner", "Phone 2 snack"]);
  [N, N2].forEach(P => P.M.cloud.leave());
});

t("S3-02 a day an older build stored with a row's delete list is not sent again and again", async () => {
  const { P: N, code } = await household("s302stale-n");
  N.M.cloud.configure({ delay: 1e9 });
  const id = "nick|" + N.M.today();
  assert.ok((await N.sync()).ok); await N.sync();
  N.M.MS.days[id].gone = { ixyz: "abc" };   /* what a build before this one kept from a newer phone's row */
  N.M.save();
  N.M.cloud.configure({ delay: 1e9 });
  const R = phone("s302stale-r", { store: Object.fromEntries(N.store), S: N.ctx.S });   /* the app opens again */
  N.offline(true);
  R.M.cloud.configure({ delay: 1e9 });
  const rs = [];
  for (let i = 0; i < 3; i++) rs.push(await R.sync());
  assert.ok(rs.every(r => r.ok && !r.pushed), "nothing to send: " + JSON.stringify(rs));
  assert.ok(!("gone" in JSON.parse(SERVER.get(code, "day", id).data)), "the cloud copy has no stale list");
  R.M.cloud.leave();
});

t("C5 a phone upgraded from v16/v17 that took a newer phone's day row whole sends nothing and drops the list from its diary", async () => {
  const { P: N, code } = await household("c5gone-n");
  N.M.cloud.configure({ delay: 1e9 });
  const id = "nick|" + N.M.today(), key = "day|" + id;
  assert.ok((await N.sync()).ok); await N.sync();
  const names = P => P.M.MS.days[id].entries.map(e => e.name).sort().join(",");
  const want = names(N);
  /* what v16/v17 keep after taking a newer phone's row: the delete list inside the day, and a
     hash that counts it; the overlap was read long ago (a real phone: the pull re-reads nothing) */
  N.M.MS.days[id].gone = { ixyz: "abc" };
  N.M.save();
  const store = Object.fromEntries(N.store);
  const o = JSON.parse(store["chalk.sync.v1"]);
  o.hashes[key] = N.M.cloud._.hash(N.M.MS.days[id]);
  o.ov = o.cursor;
  store["chalk.sync.v1"] = JSON.stringify(o);
  N.offline(true);
  const R = phone("c5gone-r", { store, S: N.ctx.S });   /* the app opens again on the new build */
  R.M.cloud.configure({ delay: 1e9 });
  assert.ok(!("gone" in R.M.MS.days[id]), "the list left the diary on load");
  assert.equal(R.M.cloud._.scan().changed.length, 0, "the day still counts as synced");
  const rs = [];
  for (let i = 0; i < 3; i++) rs.push(await R.sync());
  assert.ok(rs.every(r => r.ok && !r.pushed), "nothing to send: " + JSON.stringify(rs));
  assert.equal(names(R), want, "nothing lost");
  assert.ok(!JSON.stringify(R.M.export()).includes('"gone"'), "not in the backup copy");
  /* a merge built on a day that still holds a list never keeps it */
  const e = (n, i) => ({ id: "e" + i, name: n, slot: "Lunch", servings: 1, per: { cal: 100, p: 1, c: 1, f: 1 } });
  const mine = { id, pid: "nick", date: N.M.today(), entries: [e("A", 1)], water: 0, note: "", updatedAt: 5, gone: { ie9: "x" } };
  const theirs = { id, pid: "nick", date: N.M.today(), entries: [e("B", 2)], water: 0, note: "", updatedAt: 6 };
  const m = R.M.cloud._.mergeDay(null, null, mine, theirs, null, null);
  assert.equal(m.entries.length, 2, "both entries kept");
  assert.ok(!("gone" in m), "merged day has no list");
  R.M.cloud.leave();
});

t("a share (M.share) rides the meal rows: Kat sends Breakfast, it lands in Nick's inbox, accepting puts it in his diary and clears it on both phones", async () => {
  const A = phone("nick-share"), B = phone("kat-share", { S: { profile: "kat", active: null } });
  const code = A.M.cloud.create(); assert.ok((await A.sync()).ok); assert.ok((await B.M.cloud.join(code)).ok);
  const bm = B.M, am = A.M, today = bm.today();
  bm.log.add(today, { slot: "Breakfast", name: "Eggs, whole", servings: 2, servingLabel: "1 large egg (50 g)", g: 50, per: { cal: 72, p: 6, c: 0.4, f: 5 } });
  const sent = bm.share.send({ to: "nick", from: "kat", kind: "log", name: "Breakfast", slot: "Breakfast", date: today, items: bm.log.slotEntries(today, "Breakfast", "kat").map(e => ({ name: e.name, servings: e.servings, servingLabel: e.servingLabel, g: e.g, per: e.per })) });
  assert.ok(sent && sent.share.to === "nick" && sent.pid === "nick", "share record made for Nick");
  assert.ok(!bm.meals.list().some(m => m.id === sent.id), "a share is never a saved meal");
  assert.strictEqual(bm.share.outbox("kat").length, 1);
  assert.ok((await B.sync()).ok);
  const r = await A.sync(); assert.ok(r.ok && r.applied >= 1);
  const inbox = am.share.inbox("nick");
  assert.strictEqual(inbox.length, 1, "Nick's phone has the share in his inbox");
  assert.strictEqual(inbox[0].items[0].name, "Eggs, whole");
  assert.ok(!am.meals.list().some(m => m.id === sent.id), "not in Nick's saved meals either");
  const acc = am.share.acceptLog(inbox[0].id);
  assert.ok(acc && acc.entries.length === 1 && acc.slot === "Breakfast");
  assert.strictEqual(am.log.slotEntries(today, "Breakfast", "nick")[0].servings, 2, "the items are in Nick's own Breakfast");
  assert.strictEqual(am.share.inbox("nick").length, 0);
  await A.sync(); await B.sync();
  assert.strictEqual(bm.share.outbox("kat").length, 0, "Kat's phone sees it was taken");
  assert.ok(!bm.MS.meals[sent.id] && !am.MS.meals[sent.id], "the share row is gone on both phones");
  /* a saved-meal share becomes the receiver's own copy; an activity share carries its payload */
  const ms = am.share.send({ to: "kat", from: "nick", kind: "meal", name: "Protein oats", desc: "Oats + whey", slot: "Breakfast", servingsMade: 2, items: [{ name: "Oats", servings: 1, per: { cal: 150, p: 5, c: 27, f: 3 } }] });
  const as = am.share.send({ to: "kat", from: "nick", kind: "activity", name: "Hike", date: today, act: { act: "hike", start: Date.now() - 36e5, min: 90, mi: 4.2, elev: 900, note: "Chautauqua" } });
  await A.sync(); await B.sync();
  assert.deepStrictEqual(J(bm.share.inbox("kat").map(m => m.share.kind).sort()), ["activity", "meal"]);
  const copy = bm.share.acceptMeal(ms.id);
  assert.ok(copy && copy.pid === "kat" && copy.servingsMade === 2 && copy.items.length === 1, "Kat gets her own copy with the servings");
  const act = bm.share.acceptActivity(as.id);
  assert.ok(act && act.act === "hike" && act.mi === 4.2 && act.elev === 900 && act.from === "nick", "the activity payload comes back whole");
  assert.strictEqual(bm.share.inbox("kat").length, 0);
  await B.sync(); await A.sync();
  assert.strictEqual(am.share.outbox("nick").length, 0);
  assert.ok(mealNames(A).includes("Protein oats") && mealNames(B).includes("Protein oats"), "the copy syncs like any meal");
  A.M.cloud.leave(); B.M.cloud.leave();
});

/* =================================================================== run */
(async () => {
  SERVER = mockServer();
  await new Promise(r => SERVER.server.listen(0, "127.0.0.1", r));
  URLBASE = "http://127.0.0.1:" + SERVER.server.address().port;
  let passed = 0;
  for (const { name, fn } of tests) {
    if (process.env.ONLY && !name.includes(process.env.ONLY)) continue;   /* ONLY=S3- node tests/m-sync.test.js */
    try { await fn(); passed++; console.log("  ok  " + name); }
    catch (e) { console.log("  FAIL " + name + "\n" + (e && e.stack || e)); process.exitCode = 1; break; }
  }
  [A, B].forEach(P => { try { P && P.M.cloud.leave(); } catch (e) {} });
  SERVER.server.close();
  console.log("\n" + passed + "/" + tests.length + " test groups passed");
})();
