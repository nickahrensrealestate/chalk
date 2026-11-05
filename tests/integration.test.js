/* node tests/integration.test.js — Chalk ⇄ Macros integration (jsdom).
   Loads index.html with Chalk's inline script plus the local m-*.js files
   injected inline (external <script src> / <link> tags are stripped), then
   checks every hook the integration owns: mode bar, render() routing,
   #tabs data-mtab routing, TRAIN_TABS restore, Train Today banner,
   export/import of __macros, wipe → M.reset().
   Pass 1 always runs with a stub M.ui (deterministic). Pass 2 runs with the
   real m-ui.js / m-trends.js when both files exist. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
const exists = f => fs.existsSync(path.join(ROOT, f));
const HTML = read("index.html");

/* ---------------------------------------------------------------- helpers */
function inlineScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "index.html has one inline <script> block");
  return m[1];
}
const safeJS = src => src.replace(/<\/script/gi, "<\\/script");

/* FILL=true only adds the members m-ui.js would provide when they are missing
   (so a real m-trends.js keeps its bannerHTML / actions); FILL=false replaces
   M.ui entirely for a deterministic wiring test. */
const stubUI = fill => `
window.M = window.M || {};
(function(){ const stub = {
  tab: "diary",
  chrome() {
    const mode = (M.mode && M.mode()) || "train";
    document.querySelectorAll('#modebar [data-m="mode"]').forEach(b => b.classList.toggle("on", b.dataset.v === mode));
    const tabs = document.getElementById("tabs");
    if (!tabs) return;
    if (mode === "macros") { if (!tabs.querySelector("[data-mtab]")) tabs.innerHTML = M.ui.tabsHTML(); }
    else if (window.TRAIN_TABS && tabs.querySelector("[data-mtab]")) tabs.innerHTML = window.TRAIN_TABS;
  },
  render() { this.chrome(); document.getElementById("app").innerHTML = "<div id='m-stub'>macros:" + this.tab + "</div>"; },
  bind() {
    if (this._bound) return; this._bound = true;
    document.addEventListener("click", e => {
      const el = e.target.closest && e.target.closest('[data-m="mode"]'); if (!el) return;
      M.setMode(el.dataset.v); if (typeof render === "function") render();
    });
  },
  bannerHTML() { return "<div class='card' id='m-banner'>banner</div>"; },
  trainSummaryHTML() { return "<div class='card' id='m-sum'>macros today</div>"; },
  tabsHTML() { return "<button data-mtab='diary' class='on'>Diary</button><button data-mtab='foods'>Foods</button>"; }
};
${fill ? "M.ui = M.ui || {}; Object.keys(stub).forEach(k => { if (!(k in M.ui)) M.ui[k] = stub[k]; });" : "M.ui = stub;"}
})();`;

/* m-sync.js with its config line set for the test: empty (sync off, zero requests) unless a
   fake Supabase is given for pass 3. The shipped line must be either empty or a real project
   URL + a publishable key (never a secret key). */
const SB_RE = /const SB_URL = "([^"]*)";(\s*)const SB_KEY = "([^"]*)";/;
function syncSource(cfg) {
  const src = read("m-sync.js");
  const m = src.match(SB_RE);
  assert.ok(m, "m-sync.js carries the config line (SB_URL, SB_KEY)");
  const url = m[1], key = m[3];
  assert.ok((url === "" && key === "") ||
    (/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url) && /^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(key)),
    "shipped sync config is empty, or a project URL + a publishable key");
  const c = cfg || { url: "", key: "" };
  return src.replace(SB_RE, (all, u, sp) => "const SB_URL = " + JSON.stringify(c.url) + ";" + sp + "const SB_KEY = " + JSON.stringify(c.key) + ";");
}

/* mode: "stub"  → m-core/m-data/m-food + a full stub M.ui (deterministic wiring test)
         "real"  → every m-*.js that exists; the stub only fills members m-ui.js would add
   m-sync.js always loads last, like in index.html. */
function buildPage({ real, sync }) {
  let html = HTML;
  // Strip every external stylesheet / font link and every <script src>.
  html = html.replace(/<link[^>]*rel="stylesheet"[^>]*>\s*/g, "");
  const scripts = ["m-core.js", "m-data.js", "m-food.js"];
  if (real) scripts.push("m-ui.js", "m-trends.js");
  let inject = scripts.filter(exists).map(f => "<script>/* " + f + " */\n" + safeJS(read(f)) + "\n</script>").join("\n");
  if (!real) inject += "\n<script>" + stubUI(false) + "</script>";
  else if (!exists("m-ui.js")) inject += "\n<script>" + stubUI(true) + "</script>";
  if (exists("m-sync.js")) inject += "\n<script>/* m-sync.js */\n" + safeJS(syncSource(sync)) + "\n</script>";
  let n = 0;
  html = html.replace(/<script src="[^"]+"><\/script>\s*/g, () => (n++ === 0 ? inject + "\n" : ""));
  assert.ok(n >= 6, "found the 6 <script src> tags (got " + n + ")");
  return html;
}

/* Every page gets a fetch spy: pass 1 and 2 must never touch the network. */
function boot({ real, sync, store, hook }) {
  const errors = [], fetches = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push(e && e.detail ? e.detail : e));
  vc.on("error", (...a) => errors.push(a.map(String).join(" ")));
  const dom = new JSDOM(buildPage({ real, sync }), {
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      Object.keys(store || {}).forEach(k => win.localStorage.setItem(k, store[k]));
      if (hook) hook(win);
      win.fetch = (url, opt) => {
        fetches.push({ url: String(url), method: (opt && opt.method) || "GET", headers: Object.assign({}, opt && opt.headers), body: opt && opt.body });
        const get = !opt || !opt.method || opt.method === "GET";
        return Promise.resolve({ ok: true, status: get ? 200 : 201, json: () => Promise.resolve([]), text: () => Promise.resolve("") });
      };
    }
  });
  const w = dom.window;
  w.addEventListener("error", e => errors.push(e.error || e.message));
  return { dom, w, d: w.document, errors, fetches };
}

const click = (w, el) => { assert.ok(el, "element to click exists"); el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true })); };
const q = (d, sel) => d.querySelector(sel);

let pass = 0, fail = 0;
/* Chalk's render() marks the active tab (class + aria-current); compare tab markup without that state */
const tabsNorm = h => String(h).replace(/\s*aria-current="page"/g, "").replace(/\s*class="on"/g, "").replace(/\s+/g, " ").trim();
function t(name, fn) {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n       ") : e)); }
}

/* --------------------------------------------------- static / syntax checks */
console.log("static");
t("inline Chalk script parses (node vm)", () => { new vm.Script(inlineScript(HTML), { filename: "index.inline.js" }); });
const APPV = +((HTML.match(/const APP_VERSION=(\d+)/) || [])[1] || 0);
const VQ = "?v=" + APPV;
t("head links m.css and m-trends.css after Google Fonts", () => {
  const i = HTML.indexOf('href="https://fonts.googleapis.com');
  const a = HTML.indexOf('<link rel="stylesheet" href="m.css' + VQ + '">');
  const b = HTML.indexOf('<link rel="stylesheet" href="m-trends.css' + VQ + '">');
  assert.ok(i > 0 && a > i && b > a, "order: fonts < m.css < m-trends.css");
  assert.ok(a < HTML.indexOf("<style>"), "links before <style>");
});
t("six module scripts in order (m-sync.js right after m-trends.js), before the inline script", () => {
  assert.ok(APPV >= 16, "APP_VERSION set");
  const order = ["m-core.js", "m-data.js", "m-food.js", "m-ui.js", "m-trends.js", "m-sync.js"].map(f => HTML.indexOf('<script src="' + f + VQ + '"></script>'));
  order.forEach((p, i) => assert.ok(p > 0 && (i === 0 || p > order[i - 1]), "script " + i + " position"));
  assert.ok(/<script src="m-trends\.js\?v=\d+"><\/script>\s*<script src="m-sync\.js\?v=\d+"><\/script>/.test(HTML), "m-sync.js directly after m-trends.js");
  assert.ok(order[5] < HTML.indexOf("<script>\n/* ================= EXERCISE LIBRARY"), "before Chalk's inline script");
});
t("boot starts cloud sync right after M.sync.init(), before the first render", () => {
  const js = inlineScript(HTML);
  const init = js.indexOf("M.sync.init();"), start = js.indexOf("M.cloud.start();"), first = js.indexOf("applyTheme(); render();", init);
  assert.ok(init > 0 && start > init && first > start, "order: M.sync.init → M.cloud.start → render");
  assert.ok(/if\(window\.M&&M\.cloud&&M\.cloud\.start\) M\.cloud\.start\(\);/.test(js), "guarded call");
});
t("Train Today: Chalk's check-in card, then the Macros banner, then the summary row (TRN-18)", () => {
  const js = inlineScript(HTML);
  const c = js.indexOf("if(checkinDue()) h+=`<div class=\"card first\">");
  const i = js.indexOf('if(window.M&&M.ui&&M.ui.bannerHTML){ try{ h+=M.ui.bannerHTML()||""; }catch(e){} }');
  const j = js.indexOf('if(window.M&&M.ui&&typeof M.ui.trainSummaryHTML==="function"){ try{ h+=M.ui.trainSummaryHTML()||""; }catch(e){} }');
  assert.ok(c > 0 && i > c && j > i && j - i < 120, "check-in < banner < summary row");
});
t("modebar sits between .top and #scroll", () => {
  const top = HTML.indexOf('<div class="top">'), mb = HTML.indexOf('<div class="modebar" id="modebar">'), sc = HTML.indexOf('<div id="scroll">');
  assert.ok(top > 0 && mb > top && sc > mb);
});
t("modebar fallback CSS present inside <style>", () => {
  const css = HTML.slice(HTML.indexOf("<style>"), HTML.indexOf("</style>"));
  assert.ok(/\.modebar\{flex:none;display:grid;grid-template-columns:1fr 1fr;/.test(css));
  assert.ok(/\.modebar button\.on\{background:var\(--acc\);color:var\(--acc-ink\)\}/.test(css));
  assert.ok(/\.modebar svg\{width:22px;height:22px;fill:none;stroke:currentColor/.test(css));
});
/* ------------------------------------------------------------ sw.js checks */
const SWSRC = read("sw.js");
const SWV = +((SWSRC.match(/const VERSION = (\d+);/) || [])[1] || 0);
/* Runs sw.js in a vm with an in-memory CacheStorage and a scripted fetch. NET_MS is shortened so timeouts are quick. */
function swRig(opts) {
  opts = opts || {};
  const BASE = "https://nickahrensrealestate.github.io/chalk/";
  const abs = u => new URL(typeof u === "string" ? u : u.url, BASE).href;
  const stores = new Map(opts.caches || []);
  const mk = name => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
  const cacheObj = name => ({
    match: async (r) => { const m = stores.get(name); return m && m.has(abs(r)) ? m.get(abs(r)).clone() : undefined; },
    put: async (r, res) => { if (opts.putFails) throw new Error("quota"); const buf = await res.arrayBuffer(); mk(name).set(abs(r), new Response(buf, { status: res.status, headers: res.headers })); },
    keys: async () => [...mk(name).keys()]
  });
  const caches = {
    open: async n => { mk(n); return cacheObj(n); },
    keys: async () => [...stores.keys()],
    delete: async n => stores.delete(n),
    match: async r => { for (const n of stores.keys()) { const h = await cacheObj(n).match(r); if (h) return h; } return undefined; }
  };
  const fetched = [], posted = [];
  let updates = 0;
  const net = opts.net || (() => "ok");
  const fetch = (input, init) => {
    const url = abs(input), signal = (init && init.signal) || (input && input.signal);
    fetched.push({ url, mode: (init && init.mode) || (input && input.mode) || "", cache: (input && input.cache) || "" });
    const how = net(url);
    if (how === "hang") return new Promise((res, rej) => { if (signal) signal.addEventListener("abort", () => rej(new Error("aborted"))); });
    if (how === "down") return Promise.reject(new TypeError("Failed to fetch"));
    if (how === "cut") {
      const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("half of the fi")); setTimeout(() => c.error(new Error("connection reset")), 5); } });
      return Promise.resolve(new Response(body, { status: 200 }));
    }
    if (how === "opaque") return Promise.resolve({ ok: false, status: 0, type: "opaque", clone() { return this; }, arrayBuffer: async () => new ArrayBuffer(0) });
    if (typeof how === "number") return Promise.resolve(new Response("error " + how, { status: how }));
    if (how && typeof how === "object") return Promise.resolve(new Response(how.body, { status: 200, headers: { "content-type": "text/html" } }));
    /* the server's index.html is this checkout's (install checks its version) */
    if (/\/index\.html$/.test(url)) return Promise.resolve(new Response(HTML, { status: 200, headers: { "content-type": "text/html" } }));
    return Promise.resolve(new Response("NET " + url, { status: 200, headers: { "content-type": "text/plain" } }));
  };
  class R extends Request { constructor(u, init) { super(typeof u === "string" ? new URL(u, BASE + "sw.js").href : u, init); } }
  const listeners = {};
  const self = {
    addEventListener: (t, f) => { listeners[t] = f; }, skipWaiting: async () => {},
    location: { href: BASE + "sw.js", origin: new URL(BASE).origin },
    registration: { scope: BASE, update: async () => { updates++; } },
    clients: { claim: async () => {}, matchAll: async () => opts.clients || [{ postMessage: m => posted.push(m) }] }
  };
  const src = SWSRC.replace("const NET_MS = 8000;", "const NET_MS = " + (opts.netMs || 120) + ";");
  vm.runInNewContext(src, { self, caches, fetch, Request: R, Response, Headers, URL, AbortController, ReadableStream, TextEncoder, setTimeout, clearTimeout, Promise, console });
  const fire = (url, o) => {
    o = o || {};
    const request = o.mode === "navigate" ? { url: abs(url), method: "GET", mode: "navigate", headers: new Headers() } : new R(url, { method: o.method || "GET" });
    let p = null; const waits = [];
    listeners.fetch({ request, respondWith: x => { p = Promise.resolve(x); }, waitUntil: w => waits.push(w) });
    return { took: !!p, res: p, waits };
  };
  const ext = type => new Promise((res, rej) => { const waits = []; listeners[type]({ waitUntil: w => waits.push(w) }); Promise.all(waits).then(res, rej); });
  const message = (data, source) => listeners.message({ data, source });
  return { BASE, abs, stores, fetched, posted, fire, message, install: () => ext("install"), activate: () => ext("activate"), updates: () => updates };
}
const coreOf = src => { const m = src.match(/const CORE = \[([\s\S]*?)\];/); return m ? m[1] : ""; };
t("sw.js: one version everywhere — CACHE, CORE ?v=, index.html's files and APP_VERSION agree", () => {
  new vm.Script(SWSRC, { filename: "sw.js" });
  assert.ok(SWV >= 16, "VERSION constant (got " + SWV + ")");
  assert.ok(/const CACHE = "chalk-v" \+ VERSION;/.test(SWSRC), "CACHE is built from VERSION");
  assert.strictEqual(APPV, SWV, "index.html APP_VERSION matches sw.js VERSION");
  /* every same-origin file index.html loads is in CORE with the same ?v= */
  const loads = [...HTML.matchAll(/<(?:script src|link rel="stylesheet" href)="([^":]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(loads.sort(), ["m-core.js", "m-data.js", "m-food.js", "m-sync.js", "m-trends.css", "m-trends.js", "m-ui.js", "m.css"].map(f => f + "?v=" + SWV).sort());
  const core = coreOf(SWSRC);
  ["index.html", "manifest.json", "icon-180.png", "icon-192.png", "icon-512.png"].forEach(f => assert.ok(core.includes('"' + f + '"'), "CORE has " + f));
  ["m.css", "m-trends.css", "m-core.js", "m-data.js", "m-food.js", "m-ui.js", "m-trends.js", "m-sync.js"].forEach(f => assert.ok(core.includes('"' + f + '" + V'), "CORE has " + f + "?v="));
  /* and every m-* file in the app folder, so a new module can't be left out of the offline copy */
  fs.readdirSync(ROOT).filter(f => /^m[-.].*\.(js|css)$/.test(f)).forEach(f => assert.ok(core.includes('"' + f + '" + V'), "CORE has the app file " + f));
});
t("Train | Macros reads as one two-way switch: one rounded frame, the side you're on filled with the accent", () => {
  const css = (HTML.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || "";
  const last = sel => { const all = [...css.matchAll(new RegExp(sel.replace(/[.+]/g, "\\$&") + "\\{([^}]*)\\}", "g"))]; return all.length ? all[all.length - 1][1] : ""; };
  assert.ok(/border-radius:14px/.test(last(".modebar")) && /border:1px solid var\(--line\)/.test(last(".modebar")), "framed");
  assert.ok(/background:var\(--acc\)/.test(last(".modebar button.on")) && /color:var\(--acc-ink\)/.test(last(".modebar button.on")), "selected side filled");
  const all = sel => [...css.matchAll(new RegExp(sel.replace(/[.+]/g, "\\$&") + "\\{([^}]*)\\}", "g"))].map(m => m[1]);
  assert.ok(all(".modebar button").some(r => /min-height:4[4-9]px/.test(r)), "44 px or taller");
});
t("LK-03: dark mode OFF switches stand out (both dark blocks); ON stays in the accent color", () => {
  assert.ok(HTML.includes('@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]) .toggle:not(.on){background:#4A525B} :root:not([data-theme="light"]) .toggle i{background:#F2EFE8} }'));
  assert.ok(HTML.includes(':root[data-theme="dark"] .toggle:not(.on){background:#4A525B}') && HTML.includes(':root[data-theme="dark"] .toggle i{background:#F2EFE8}'));
  assert.ok(HTML.includes(".toggle.on{background:var(--acc)}"));
});
t("round 5 P3: Today's plan buttons fit one line (LK-06); no Train label under 12 px (PL-08)", () => {
  assert.ok(HTML.includes('data-a="plan-add">+ Exercise</button>') && HTML.includes('${P.abs?"Skip abs":"Add abs"}'));
  assert.strictEqual((HTML.match(/style="flex:1;white-space:nowrap" data-a="plan-/g) || []).length, 3, "three one-line buttons");
  const css = (HTML.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || "";
  const small = [...css.matchAll(/([^{}]+)\{[^}]*font-size:(\d+(?:\.\d+)?)px/g)].filter(m => +m[2] < 12).map(m => m[1].trim() + " " + m[2] + "px");
  assert.deepStrictEqual(small, [], "labels under 12 px");
  assert.ok(HTML.includes('<div class="k">${H.length} session${H.length===1?"":"s"}</div>'), "LK-10: 1 session, 2 sessions");
});
t("light theme tokens: muted and warning text dark enough, placeholders in --mut (IOS-07); content starts 10px under the bar (TRN-11)", () => {
  const root = (HTML.match(/:root\{([^}]*)\}/) || [])[1] || "";
  assert.ok(root.includes("--mut:#5C6169") && root.includes("--warn:#B03A24") && root.includes("--mus-t:#1F66D6"), root);
  assert.ok(/input::placeholder,textarea::placeholder\{color:var\(--mut\);opacity:1\}/.test(HTML));
  assert.ok(/\.wrap\{padding:10px /.test(HTML));
  assert.ok(/\.modebar button\.on:focus-visible\{outline-color:var\(--acc-ink\)/.test(HTML), "focus ring visible on the selected mode button (IOS-15)");
});
/* OFL-13: a phone keeps the cached app until sw.js says a new version exists. So whenever any CORE file differs from
   what's live (GitHub Pages serves main → origin/main, else main), CACHE must differ from the live CACHE too.
   The file list is read from CORE itself, so a file added to CORE is covered automatically. */
t("sw.js: CACHE differs from the live one whenever a CORE file differs from what's live (OFL-13)", () => {
  const { execFileSync } = require("child_process");
  const git = args => execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
  let ref = null;
  for (const r of ["origin/main", "main"]) { try { git(["rev-parse", "--verify", "-q", r + "^{commit}"]); ref = r; break; } catch (e) {} }
  if (!ref) { console.log("       (no git history here, check skipped)"); return; }
  const cacheOfSrc = src => { const v = src.match(/const VERSION = (\d+);/); if (v) return "chalk-v" + v[1]; const c = src.match(/const CACHE = "([^"]+)"/); return c ? c[1] : null; };
  const liveCache = cacheOfSrc(git(["show", ref + ":sw.js"]).toString("utf8")), nowCache = cacheOfSrc(SWSRC);
  const files = [...coreOf(SWSRC).matchAll(/"([^"]+)"/g)].map(m => m[1]).filter(f => f !== "./");
  assert.ok(files.length >= 13 && files.includes("m-sync.js") && files.includes("index.html"), "CORE parsed: " + files.join(", "));
  files.forEach(f => assert.ok(exists(f), "CORE file exists: " + f));
  const liveBytes = f => { try { return git(["show", ref + ":" + f]); } catch (e) { return null; } };
  /* the rule: any CORE file not byte-identical to live → the version must not be live's */
  const problem = (read, now) => { const changed = files.filter(f => { const old = liveBytes(f); return !old || !old.equals(read(f)); }); return changed.length && now === liveCache ? changed : null; };
  /* phones only take a newer version: the number must go up, never sideways */
  const num = c => +((/^chalk-v(\d+)$/.exec(c || "") || [])[1] || 0);
  assert.ok(num(nowCache) >= num(liveCache), nowCache + " is older than live " + liveCache);
  const bad = problem(f => fs.readFileSync(path.join(ROOT, f)), nowCache);
  assert.ok(!bad, "these app files differ from " + ref + " but sw.js still says " + nowCache + ". Bump VERSION in sw.js, APP_VERSION and every ?v= in index.html: " + (bad || []).join(", "));
  /* and the rule catches a forgotten bump: live files with one edited, version left at live's */
  const edited = f => { const b = liveBytes(f) || Buffer.from(""); return f === "m-ui.js" ? Buffer.concat([b, Buffer.from("\n/* edit */")]) : b; };
  assert.deepStrictEqual(problem(edited, liveCache), ["m-ui.js"], "an edit without a bump is caught");
  assert.strictEqual(problem(edited, "chalk-v" + (SWV + 1)), null, "the same edit with a bump passes");
});
t("Settings backup rows say what they do now (a file on iPhone, a paste or a file to restore)", () => {
  assert.ok(HTML.includes('Saves a copy of everything. Keep it in Files or Notes.</div></div><button class="btn" data-a="export">Save</button>'));
  assert.ok(HTML.includes('Pick the backup file or paste the text.</div></div><button class="btn" data-a="import">Open</button>'));
  assert.ok(!/Copies everything as text|Copy a backup/.test(HTML), "every hint names the Save button");
  assert.ok(HTML.includes("Save a backup in Settings.") && HTML.includes("Save a backup first."));
});
t("manifest.json description", () => {
  const m = JSON.parse(read("manifest.json"));
  assert.strictEqual(m.description, "Gym log and macro tracker.");
  assert.strictEqual(m.name, "Chalk");
});

/* ------------------------------------------------------ pass 1: stub M.ui */
function runPass(label, real) {
  console.log(label);
  const { dom, w, d, errors, fetches } = boot({ real });
  try {
    t("page boots without throwing", () => { assert.deepStrictEqual(errors, []); assert.ok(w.M && w.M.MS, "M loaded"); assert.strictEqual(typeof w.render, "function"); });
    t("M.cloud loaded after the rest, not set up, so it stays off", () => {
      assert.ok(w.M.cloud && typeof w.M.cloud.start === "function", "M.cloud present");
      assert.strictEqual(w.M.cloud.configured(), false);
      assert.strictEqual(w.M.cloud.status().on, false);
      assert.strictEqual(w.M.save.__cloud, true, "M.save wrapped by m-sync.js");
    });
    t("#modebar has two mode buttons, Train on by default", () => {
      const bs = d.querySelectorAll('#modebar button[data-m="mode"]');
      assert.strictEqual(bs.length, 2);
      assert.strictEqual(bs[0].dataset.v, "train"); assert.strictEqual(bs[1].dataset.v, "macros");
      assert.ok(bs[0].classList.contains("on") && !bs[1].classList.contains("on"));
      assert.ok(q(d, '#modebar [data-v="train"] svg') && q(d, '#modebar [data-v="macros"] svg'), "both have icons");
      assert.strictEqual(bs[0].textContent.trim(), "Train"); assert.strictEqual(bs[1].textContent.trim(), "Macros");
    });
    t("TRAIN_TABS captured with the 4 Chalk tabs", () => {
      assert.strictEqual(typeof w.TRAIN_TABS, "string");
      const tmp = d.createElement("div"); tmp.innerHTML = w.TRAIN_TABS;
      assert.deepStrictEqual([...tmp.querySelectorAll("button")].map(b => b.dataset.tab), ["today", "history", "progress", "settings"]);
      assert.strictEqual(w.M.mode(), "train");
    });
    t("Train mode renders Chalk (person picker, no macro view)", () => {
      assert.ok(q(d, '#app [data-a="pick-profile"][data-v="nick"]'), "picker shown");
      assert.ok(!q(d, "#m-stub"));
      assert.strictEqual(tabsNorm(q(d, "#tabs").innerHTML), tabsNorm(w.TRAIN_TABS));
    });
    t("clicking the Macros mode button routes render() to M.ui.render()", () => {
      click(w, q(d, '#modebar [data-m="mode"][data-v="macros"]'));
      if (w.M.mode() !== "macros") { w.M.setMode("macros"); w.render(); }   // stub bind() fallback
      assert.strictEqual(w.M.mode(), "macros");
      if (!real || !exists("m-ui.js")) assert.ok(q(d, "#app #m-stub"), "stub view rendered");
      else assert.strictEqual(q(d, "#title").textContent, "Macros");
      assert.ok(q(d, '#modebar [data-v="macros"]').classList.contains("on") && !q(d, '#modebar [data-v="train"]').classList.contains("on"), "on-state moved");
      assert.ok(q(d, "#tabs [data-mtab]"), "macro tabs installed");
      assert.ok(!q(d, "#tabs [data-tab]"), "Chalk tabs gone");
      assert.notStrictEqual(q(d, "#tabs").innerHTML, w.TRAIN_TABS);
    });
    t("#tabs click on a data-mtab button sets M.ui.tab and re-renders macros", () => {
      const target = q(d, '#tabs [data-mtab="foods"]') || d.querySelectorAll("#tabs [data-mtab]")[1];
      click(w, target);
      assert.strictEqual(w.M.ui.tab, target.dataset.mtab);
      if (!real || !exists("m-ui.js")) assert.strictEqual(q(d, "#m-stub").textContent, "macros:" + target.dataset.mtab);
      assert.strictEqual(w.M.mode(), "macros", "Chalk tab handler did not take over");
      assert.ok(!q(d, '#app [data-a="pick-profile"]') || real, "not the Chalk picker");
    });
    t("switching back to Train restores the original 4 Chalk tabs", () => {
      click(w, q(d, '#modebar [data-m="mode"][data-v="train"]'));
      if (w.M.mode() !== "train") { w.M.setMode("train"); w.render(); }
      assert.strictEqual(w.M.mode(), "train");
      assert.strictEqual(tabsNorm(q(d, "#tabs").innerHTML), tabsNorm(w.TRAIN_TABS));
      assert.ok(q(d, '#modebar [data-v="train"]').classList.contains("on"));
      assert.ok(!q(d, "#m-stub"));
      assert.ok(q(d, '#app [data-a="pick-profile"]'), "Chalk view back");
    });
    t("with S.profile=nick the Train Today view starts with the check-in banner", () => {
      click(w, q(d, '#app [data-a="pick-profile"][data-v="nick"]'));
      assert.strictEqual(w.eval("S.profile"), "nick");
      const app = q(d, "#app");
      if (!real || !exists("m-trends.js")) {
        assert.ok(q(d, "#app #m-banner"), "banner present");
        assert.strictEqual(app.firstElementChild.id, "m-banner", "banner is the first element");
      } else {
        // real m-trends: the banner shows the 60-day refresh / 2-week body cards.
        // Make a profile whose numbers are 61 days old → "refresh60" is due.
        assert.strictEqual(typeof w.M.ui.bannerHTML, "function");
        const p = w.M.person("nick"); p.setupAt = Date.now() - 61 * 864e5; p.lastBody = Date.now(); w.M.save();
        assert.strictEqual(w.M.checkins.due("nick"), "refresh60");
        const banner = w.M.ui.bannerHTML();
        assert.ok(banner.length > 0 && /card/.test(banner), "real bannerHTML returns a card");
        w.render();
        assert.ok(q(d, "#app").innerHTML.startsWith(banner.slice(0, 60)), "banner is the first element of Train Today");
      }
      assert.ok(q(d, '#cta button[data-a="start"]'), "Today CTA still works");
    });
    t("Train Today: Macros summary row sits right after the check-in banner", () => {
      const ui = w.M.ui, real0 = ui.trainSummaryHTML;
      if (real0) assert.doesNotThrow(() => real0.call(ui), "the real trainSummaryHTML runs");
      ui.trainSummaryHTML = () => "<div class='card' id='m-sum-probe'>probe</div>";
      w.render();
      const probe = q(d, "#m-sum-probe");
      assert.ok(probe, "row rendered");
      assert.ok(probe.previousElementSibling && probe.previousElementSibling === q(d, "#app").firstElementChild, "directly after the banner card");
      assert.ok(/banner|card/.test(probe.previousElementSibling.className + probe.previousElementSibling.id));
      /* a broken summary never breaks Today */
      ui.trainSummaryHTML = () => { throw new Error("boom"); };
      w.render();
      assert.ok(!q(d, "#m-sum-probe") && q(d, '#cta button[data-a="start"]'), "Today still renders");
      /* no summary function → nothing, no error */
      delete ui.trainSummaryHTML;
      w.render();
      assert.ok(q(d, '#cta button[data-a="start"]'));
      if (real0) ui.trainSummaryHTML = real0; else if (!real) ui.trainSummaryHTML = () => "<div class='card' id='m-sum'>macros today</div>";
      w.render();
      if (!real) assert.strictEqual(q(d, "#m-banner").nextElementSibling.id, "m-sum", "stub summary follows the stub banner");
    });
    t("export text contains __macros", () => {
      click(w, q(d, '#tabs [data-tab="settings"]'));
      click(w, q(d, '#app [data-a="export"]'));
      const ta = q(d, "#sheetB textarea");
      assert.ok(ta, "backup sheet opened (no share/clipboard in jsdom)");
      const parsed = JSON.parse(ta.value);
      assert.ok(parsed.__macros && parsed.__macros.v === 1, "__macros.v === 1");
      assert.strictEqual(parsed.profile, "nick");
      assert.strictEqual(parsed.v, 1);
      click(w, q(d, '#sheet [data-a="sheet-close"]'));
    });
    t("import of {...S, __macros:{v:1,...}} calls M.import and restores S", () => {
      const S = JSON.parse(w.eval("JSON.stringify(S)"));
      const macros = { v: 1, updatedAt: Date.now() + 5000, ui: { mode: "train", person: "nick", date: null, tab: "diary" },
        /* a real backup's profile was set up and carries its own updatedAt (M.import merges profile by profile, BEC-03) */
        profiles: { nick: { id: "nick", name: "Nick", weightLb: 190, setupAt: Date.now() - 864e5, updatedAt: Date.now() + 5000 } }, foods: {}, meals: {}, days: {}, body: {} };
      let got = null; const orig = w.M.import;
      w.M.import = o => { got = o; return orig.call(w.M, o); };
      click(w, q(d, '#app [data-a="import"]'));
      q(d, "#impT").value = JSON.stringify({ ...S, __macros: macros, settings: { ...S.settings, restC: 90 } });
      click(w, q(d, '#sheet [data-a="import-do"]'));
      w.M.import = orig;
      assert.ok(got && got.v === 1 && got.profiles.nick.weightLb === 190, "M.import received __macros");
      assert.strictEqual(q(d, "#toast").textContent, "Restored");
      assert.strictEqual(w.eval("S.settings.restC"), 90, "Chalk state restored");
      assert.strictEqual(w.eval("S.__macros"), undefined, "__macros stripped from S");
      assert.strictEqual(w.M.MS.profiles.nick.weightLb, 190, "macros merged");
      assert.ok(!q(d, "#sheetBg").classList.contains("on"), "sheet closed");
    });
    t("import of a non-backup does not call M.import and toasts", () => {
      let called = 0; const orig = w.M.import; w.M.import = o => { called++; return orig.call(w.M, o); };
      click(w, q(d, '#app [data-a="import"]'));
      q(d, "#impT").value = "{\"hello\":1}";
      click(w, q(d, '#sheet [data-a="import-do"]'));
      w.M.import = orig;
      assert.strictEqual(called, 0);
      assert.strictEqual(q(d, "#toast").textContent, "That's not a Chalk backup");
      click(w, q(d, '#sheet [data-a="sheet-close"]'));
    });
    t("wipe calls M.reset() and Chalk resets", () => {
      let called = 0; const orig = w.M.reset; w.M.reset = () => { called++; return orig.call(w.M); };
      click(w, q(d, '#app [data-a="wipe"]'));
      click(w, q(d, '#sheet [data-a="wipe-do"]'));
      w.M.reset = orig;
      assert.strictEqual(called, 1);
      assert.ok(!w.eval("S.profile"), "Chalk profile cleared");
      click(w, q(d, '#tabs [data-tab="today"]'));
      assert.ok(q(d, '#app [data-a="pick-profile"]'), "picker shown again on Today");
      assert.strictEqual(w.M.MS.profiles.nick, undefined, "macros state cleared");
      assert.strictEqual(w.M.mode(), "train");
    });
    t("no errors were logged during the whole pass", () => assert.deepStrictEqual(errors, []));
    t("cloud sync not set up → not one network request during the whole pass", () => assert.deepStrictEqual(fetches.map(f => f.url), []));
  } finally { dom.window.close(); }
}

/* ------------------------------------------------ sw.js behavior (async) */
async function runSwPass() {
  console.log("sw.js behavior (in-memory caches, scripted network)");
  const V = "?v=" + SWV;
  await ta("install fills chalk-vN with every CORE file, fetched past the HTTP cache", async () => {
    const rig = swRig(); await rig.install();
    const keys = [...rig.stores.get("chalk-v" + SWV).keys()].map(k => k.replace(rig.BASE, "")).sort();
    assert.deepStrictEqual(keys, ["icon-180.png", "icon-192.png", "icon-512.png", "index.html", "m-core.js" + V, "m-data.js" + V, "m-food.js" + V, "m-sync.js" + V, "m-trends.css" + V, "m-trends.js" + V, "m-ui.js" + V, "m.css" + V, "manifest.json"].sort());
    assert.ok(rig.fetched.every(f => f.cache === "reload"), "cache: reload");
  });
  await ta("install is all or nothing: one failed file stores nothing and fails the install", async () => {
    const rig = swRig({ net: u => (/m-ui\.js/.test(u) ? 503 : "ok") });
    await assert.rejects(rig.install());
    assert.strictEqual((rig.stores.get("chalk-v" + SWV) || new Map()).size, 0);
    const cut = swRig({ net: u => (/m-food\.js/.test(u) ? "cut" : "ok") });
    await assert.rejects(cut.install());
    assert.strictEqual((cut.stores.get("chalk-v" + SWV) || new Map()).size, 0, "a body cut off halfway is never stored");
  });
  await ta("install refuses an index.html of another version (the CDN can lag a minute after a deploy)", async () => {
    const stale = HTML.replace(/const APP_VERSION=\d+/, "const APP_VERSION=" + (SWV - 1));
    const rig = swRig({ net: u => (/index\.html$/.test(u) ? { body: stale } : "ok") });
    await assert.rejects(rig.install(), /not version/);
    assert.strictEqual((rig.stores.get("chalk-v" + SWV) || new Map()).size, 0, "nothing stored");
    const none = swRig({ net: u => (/index\.html$/.test(u) ? { body: "<!doctype html><p>GitHub is down</p>" } : "ok") });
    await assert.rejects(none.install(), /not version/);
  });
  await ta("activate deletes only old chalk-* caches (keeps the newest older one a while), the CDN/font caches and other apps' caches stay; tells open pages", async () => {
    const m = () => new Map([["x", new Response("x")]]);
    const P = SWV - 1;
    const rig = swRig({ caches: [["chalk-v" + (P - 1), m()], ["chalk-v" + P, m()], ["chalk-v" + SWV, m()], ["chalk-v" + (SWV + 1), m()], ["chalk-cdn", m()], ["chalk-fonts", m()], ["chalk-v9x", m()], ["apollo-tracker-v3", m()], ["workbox-precache", m()]] });
    await rig.activate();
    assert.deepStrictEqual([...rig.stores.keys()].sort(), ["apollo-tracker-v3", "chalk-cdn", "chalk-fonts", "chalk-v" + P, "chalk-v" + SWV, "workbox-precache"].sort());
    assert.strictEqual(JSON.stringify(rig.posted), JSON.stringify([{ type: "chalk-updated", cache: "chalk-v" + SWV }]));
    /* next update: the one kept before goes, this one stays one more round */
    const next = swRig({ caches: [["chalk-v" + (SWV - 2), m()], ["chalk-v" + (SWV - 1), m()], ["chalk-v" + SWV, m()]] });
    await next.activate();
    assert.deepStrictEqual([...next.stores.keys()].sort(), ["chalk-v" + (SWV - 1), "chalk-v" + SWV].sort());
  });
  await ta("T3-03: the worker never reloads a page from outside, whatever version came before (v15 pages get the new version at their next launch); v16+ pages still reload themselves when quiet", async () => {
    assert.ok(!/\.navigate\(|reloadHidden|isOldHidden|SELF_SINCE|HIDDEN_MS/.test(SWSRC), "no outside reload code left in sw.js");
    const m = () => new Map([["x", new Response("x")]]);
    const nav = [];
    await Promise.all([["chalk-v15"], ["chalk-v16"], ["chalk-v17"], ["chalk-v15", "chalk-v16"], []].map(async before => {
      const name = before.join("+") || "no older cache";
      const said = [];
      const pg = id => ({ id, visibilityState: "hidden", url: "https://nickahrensrealestate.github.io/chalk/index.html", postMessage: x => said.push(x), navigate: () => { nav.push(name + ":" + id); return Promise.resolve(null); } });
      const rig = swRig({ clients: [pg("busy"), pg("idle")], caches: before.map(k => [k, m()]) });
      await rig.activate();
      rig.message({ type: "chalk-self" }, { id: "busy" });     /* a v17+ page still says it updates itself: harmless */
      assert.strictEqual(said.length, 2, name + ": every open page is told");
      assert.ok(said.every(x => x.type === "chalk-updated" && x.cache === "chalk-v" + SWV), name);
    }));
    await sleep(1800);
    assert.deepStrictEqual(nav, [], "no reload from outside");
  });
  await ta("a page still loading the version before gets its own files from the kept cache, even offline", async () => {
    const P = SWV - 1, rig = swRig({ net: () => "down" });
    rig.stores.set("chalk-v" + P, new Map([[rig.abs("m-core.js?v=" + P), new Response("OLD CORE")], [rig.abs("m-core.js"), new Response("OLDER CORE")]]));
    rig.stores.set("chalk-v" + SWV, new Map([[rig.abs("m-core.js" + V), new Response("NEW CORE")]]));
    await rig.activate();
    assert.strictEqual(await (await rig.fire("m-core.js?v=" + P).res).text(), "OLD CORE", "never the new file under the old name");
    assert.strictEqual(await (await rig.fire("m-core.js" + V).res).text(), "NEW CORE");
    assert.strictEqual(await (await rig.fire("m-core.js").res).text(), "OLDER CORE", "an unversioned page from before ?v= still works");
  });
  await ta("app shell is cache first: opens instantly from the cache while the network hangs, and checks for an update", async () => {
    const rig = swRig({ net: () => "hang", netMs: 5000 });
    rig.stores.set("chalk-v" + SWV, new Map([[rig.abs("index.html"), new Response("CACHED PAGE")], [rig.abs("m-core.js" + V), new Response("CACHED CORE")]]));
    const t0 = Date.now();
    const nav = rig.fire(rig.BASE, { mode: "navigate" });
    assert.ok(nav.took);
    assert.strictEqual(await (await nav.res).text(), "CACHED PAGE");
    const core = rig.fire("m-core.js" + V);
    assert.strictEqual(await (await core.res).text(), "CACHED CORE");
    assert.ok(Date.now() - t0 < 400, "no waiting on the network");
    await Promise.all(nav.waits);
    assert.strictEqual(rig.updates(), 1, "registration.update() in the background");
    const again = rig.fire(rig.BASE + "index.html", { mode: "navigate" }); await again.res; await Promise.all(again.waits);
    assert.strictEqual(rig.updates(), 1, "update checks are throttled");
  });
  await ta("nothing cached: network with a hard budget → 504 page, never a cut-off file", async () => {
    const hang = swRig({ net: () => "hang" });
    const t0 = Date.now();
    const r1 = await hang.fire("m-ui.js" + V).res;
    assert.strictEqual(r1.status, 504); assert.ok(Date.now() - t0 < 1500, "gave up at the budget");
    const nav = await hang.fire(hang.BASE, { mode: "navigate" }).res;
    assert.strictEqual(nav.status, 504); assert.ok(/Try again/.test(await nav.text()), "a page that says what happened");
    const cut = swRig({ net: () => "cut" });
    assert.strictEqual((await cut.fire("m-food.js" + V).res).status, 504, "half a file is a 504, not a broken script");
    const ok = swRig();
    const r = await ok.fire("SPEC-MACROS.md").res;
    assert.strictEqual(r.status, 200); assert.ok(/NET /.test(await r.text()));
    assert.strictEqual((ok.stores.get("chalk-v" + SWV) || new Map()).size, 0, "only install fills the shell cache");
  });
  await ta("routing: in-scope same-origin, fonts and pinned jsdelivr files only", async () => {
    const rig = swRig();
    const takes = (u, o) => rig.fire(u, o).took;
    assert.ok(takes(rig.BASE + "m-core.js" + V));
    assert.ok(!takes("https://nickahrensrealestate.github.io/apollo-tracker/app.js"), "other apps on the origin pass through");
    assert.ok(takes("https://fonts.gstatic.com/s/barlow/v1/x.woff2") && takes("https://fonts.googleapis.com/css2?family=Barlow"));
    assert.ok(takes("https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/iife/ponyfill.js"));
    assert.ok(takes("https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm.js"));
    assert.ok(!takes("https://cdn.jsdelivr.net/npm/some-lib/dist/x.js"), "unpinned CDN files pass through");
    ["https://world.openfoodfacts.org/api/v2/product/1.json", "https://api.anthropic.com/v1/messages", "https://abcdefgh.supabase.co/rest/v1/chalk_sync?select=kind,id"].forEach(u => assert.ok(!takes(u), "not intercepted: " + u));
    assert.ok(!takes(rig.BASE + "index.html", { method: "POST" }), "non-GET passes through");
  });
  await ta("pinned CDN files: kept after the first good download (fetched as CORS), served offline; errors and opaque never kept", async () => {
    let mode = "ok";
    const rig = swRig({ net: () => mode });
    const U = "https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.3/dist/reader/zxing_reader.wasm";
    assert.strictEqual((await rig.fire(U).res).status, 200);
    assert.strictEqual(rig.fetched[0].mode, "cors");
    await new Promise(r => setTimeout(r, 10));
    assert.ok(rig.stores.get("chalk-cdn").has(U), "stored");
    mode = "down";
    assert.ok(/NET /.test(await (await rig.fire(U).res).text()), "offline: served from the cache");
    const bad = swRig({ net: () => 503 });
    const B = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js";
    assert.strictEqual((await bad.fire(B).res).status, 503);
    assert.ok(!(bad.stores.get("chalk-cdn") || new Map()).has(B), "a 503 is not kept");
    const op = swRig({ net: () => "opaque" });
    await op.fire("https://fonts.googleapis.com/css2?family=Barlow").res;
    assert.strictEqual((op.stores.get("chalk-fonts") || new Map()).size, 0, "opaque answers are not kept");
    const font = swRig({ net: () => 503 });
    await font.fire("https://fonts.gstatic.com/s/barlow/v12/a.woff2").res;
    assert.strictEqual((font.stores.get("chalk-fonts") || new Map()).size, 0, "a failed font is not kept (it used to stick)");
    const full = swRig({ putFails: true });
    assert.strictEqual((await full.fire(U).res).status, 200, "a full disk still serves the file");
  });
}

/* ------------------------------------------- pass 3: m-sync.js configured */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ta(name, fn) {
  try { await fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n       ") : e)); }
}
async function runSyncPass() {
  console.log("pass 3: m-sync.js pointed at a fake Supabase, this phone already in a household");
  const CODE = "ABCDEFGHJKLMNPQRSTUV", URL0 = "https://fake-project.supabase.co", KEY0 = "sb_publishable_test";
  const store = { "chalk.sync.v1": JSON.stringify({ v: 1, code: CODE, device: "dtest", cursor: "", lastSync: 0, lastError: "", hashes: {}, gone: {}, bad: {}, train: {}, trainAt: 0, meta: null }) };
  const { dom, w, d, errors, fetches } = boot({ real: true, sync: { url: URL0, key: KEY0 }, store });
  try {
    t("boots without errors; sync is on", () => {
      assert.deepStrictEqual(errors, []);
      assert.strictEqual(w.M.cloud.configured(), true);
      assert.strictEqual(w.M.cloud.status().on, true);
    });
    for (let i = 0; i < 50 && !fetches.length; i++) await sleep(10);
    t("boot talks to chalk_sync for this household with apikey + x-household", () => {
      /* m-sync may check the household's meta row first, and may send the household only in the header (SEC) */
      const gets = fetches.filter(f => f.method === "GET" && f.url.startsWith(URL0 + "/rest/v1/chalk_sync?"));
      assert.ok(gets.length, "a request happened at boot: " + fetches.map(f => f.url).join(" | "));
      gets.forEach(g => {
        assert.strictEqual(g.headers.apikey, KEY0);
        assert.strictEqual(g.headers["x-household"], CODE);
        assert.ok(!("Authorization" in g.headers), "no Bearer for a publishable key");
        const hh = g.url.match(/[?&]household=eq\.([^&]*)/); if (hh) assert.strictEqual(hh[1], CODE, "household filter is this household");
      });
    });
    await sleep(20);
    let nPick = 0;
    t("You tab: Sync & backup card shows the code in groups of 4 (hidden behind Show when m-sync can mask it)", () => {
      nPick = fetches.length;
      click(w, q(d, '#app [data-a="pick-profile"][data-v="nick"]'));
      w.M.setMode("macros"); w.M.ui.tab = "you"; w.render();
      assert.ok(q(d, "#mt-sync"), "card rendered");
      const show = q(d, '#mt-sync [data-m="t-sync-show"]');
      if (typeof w.M.cloud.codeMasked === "function" && show) {
        assert.strictEqual(q(d, "#mt-code").textContent, w.M.cloud.codeMasked(), "masked until Show");
        assert.ok(!/EFGH/.test(q(d, "#mt-code").textContent), "the rest of the code is hidden");
        click(w, show);
      }
      assert.strictEqual(q(d, "#mt-code").textContent, "ABCD-EFGH-JKLM-NPQR-STUV");
      assert.ok(q(d, '#mt-sync [data-m="t-sync-now"]') && q(d, '#mt-sync [data-m="t-sync-off"]'));
      assert.ok(/Synced just now|Syncing/.test(q(d, "#mt-sync-status").textContent), q(d, "#mt-sync-status").textContent);
    });
    await ta("a macro change is uploaded about 1.5 s later", async () => {
      /* picking the person above starts a catch-up right away (K6): let it finish first */
      let last = -1; for (let i = 0; i < 40 && fetches.length !== last; i++) { last = fetches.length; await sleep(300); }
      const n = fetches.length;
      w.M.foods.add({ name: "Integration zucchini" });
      await sleep(600);
      assert.ok(!fetches.slice(n).some(f => f.method === "POST"), "not right away");
      await sleep(1400);
      const posts = fetches.slice(n).filter(f => f.method === "POST");
      assert.ok(posts.some(p => /Integration zucchini/.test(p.body)), "food row sent");
      posts.forEach(p => {
        assert.strictEqual(p.url, URL0 + "/rest/v1/chalk_sync?on_conflict=household,kind,id");
        assert.strictEqual(p.headers.Prefer, "resolution=merge-duplicates,return=minimal");
        JSON.parse(p.body).forEach(row => assert.strictEqual(row.household, CODE));
      });
      /* the training row may already have gone up with the catch-up that picking the person started */
      assert.ok(fetches.slice(nPick).filter(f => f.method === "POST").some(p => JSON.parse(p.body).some(row => row.kind === "train" && row.id === "nick")), "Chalk training backed up too");
    });
    await ta("Turn off sync (two taps) stops the network", async () => {
      w.M.ui.tab = "you"; w.render();
      const off = q(d, '#mt-sync [data-m="t-sync-off"]');
      click(w, off); click(w, off);
      assert.strictEqual(w.M.cloud.status().on, false);
      assert.ok(/Share foods and meals/.test(q(d, "#mt-sync").textContent), "card back to off");
      const n = fetches.length;
      w.M.foods.add({ name: "After turning off" });
      await sleep(1800);
      assert.strictEqual(fetches.length, n);
    });
    t("no errors were logged during pass 3", () => assert.deepStrictEqual(errors, []));
  } finally { dom.window.close(); }
}

/* ------------------- the update keeps every workout: live saves go in, the same bytes come out
   tests/fixtures/chalk-v1-live.json holds chalk.v1 exactly as the version on the phones now (d757f4b, chalk-v15)
   wrote it after real taps, for Nick and for Katerina, each with a workout still running. */
function runLiveDataPass() {
  console.log("live training data (saved by the version on the phones now) through the new code");
  const LIVE = JSON.parse(read("tests/fixtures/chalk-v1-live.json"));
  for (const who of ["nick", "kat"]) {
    const raw = LIVE[who], S0 = JSON.parse(raw);
    const { dom, w, d, errors } = boot({ real: true, store: { "chalk.v1": raw, "chalk.bak.d": "2000-01-01" } });
    const stored = () => w.localStorage.getItem("chalk.v1");
    const tab = name => click(w, q(d, '#tabs [data-tab="' + name + '"]'));
    try {
      t(who + ": boot leaves chalk.v1 byte for byte as the live app wrote it", () => {
        assert.deepStrictEqual(errors, []);
        assert.strictEqual(stored(), raw);
        assert.strictEqual(w.localStorage.getItem("chalk.bak"), raw, "today's backup is the untouched save");
        assert.strictEqual(w.localStorage.getItem("chalk.bad"), null);
      });
      t(who + ": the page holds exactly the saved data; cleanTrain leaves a real save alone", () => {
        assert.deepStrictEqual(JSON.parse(w.eval("JSON.stringify(S)")), S0);
        const c = JSON.parse(raw); w.cleanTrain(c); assert.strictEqual(JSON.stringify(c), raw);
      });
      if (who === "nick") t("older save shapes pass through unchanged too (null reps from a reps block, a custom move from before muscle lists, a cleared weight box)", () => {
        const old = JSON.parse(raw);
        old.ex.mb_slam = { w: 0, miss: 0, best: 0, hist: [{ d: 1790000000000, w: 0, r: [null, null], e1: 0, sec: false }], last: { w: 0, r: [null] } };
        old.custom.c_old_move_x1 = { n: "Old move", m: "Core", t: "band", inc: 5, rest: 75, guess: 0, k: 0, p: "crunch" };
        old.active.items.forEach(it => { if (it.t !== "block") it.draft = { w: null, r: 8 }; });
        const before = JSON.stringify(old); w.cleanTrain(old); assert.strictEqual(JSON.stringify(old), before);
      });
      t(who + ": every Train view and the Macros switch render it without writing anything", () => {
        ["history", "progress", "settings", "today"].forEach(n => { tab(n); assert.ok(d.getElementById("app").children.length, n + " rendered"); });
        tab("history"); const h = q(d, '#app [data-a="hist"]'); assert.ok(h, "a workout row"); click(w, h);
        tab("today");
        click(w, q(d, '#modebar [data-v="macros"]')); click(w, q(d, '#modebar [data-v="train"]'));
        assert.strictEqual(stored(), raw);
        assert.deepStrictEqual(errors, []);
      });
      t(who + ": History lists every workout; the running workout is still running", () => {
        tab("history"); const app = d.getElementById("app").textContent;
        S0.log.forEach(r => assert.ok(app.includes(r.name), r.name + " listed"));
        tab("today");
        assert.ok(q(d, '[data-a="finish"]'), "Finish shows: the workout in progress resumed");
        assert.strictEqual(w.eval("S.active && S.active.id"), S0.active.id);
      });
      t(who + ": logging the next set keeps every earlier workout, lift and custom move as it was", () => {
        const nDone = A => A.items.reduce((n, it) => n + (Array.isArray(it.done) ? it.done.length : 0), 0);
        click(w, q(d, '#app [data-a="log"]'));
        const now = JSON.parse(stored());
        ["log", "custom", "program", "ex", "cyc", "mix", "goal", "settings", "lastSummary", "profile"].forEach(k => assert.deepStrictEqual(now[k], S0[k], k));
        assert.strictEqual(nDone(now.active), nDone(S0.active) + 1, "one new set");
        assert.deepStrictEqual(errors, []);
      });
    } finally { dom.window.close(); }
  }
}

/* ------------------- KJ-02: a borrowed phone keeps each person's plan. The live saves (workout finished, so Switch
   is allowed) go Nick → Katerina → Nick: chalk.v1 comes back byte for byte (only updatedAt moves), workouts, weights
   and custom moves are never touched, a person never used on this phone gets their preset, and the plan kept for
   later lives in its own key, never inside chalk.v1 (the current person's cloud training backup). */
function runPlanStashPass() {
  console.log("KJ-02: switch person and back keeps each person's plan (live saves)");
  const LIVE = JSON.parse(read("tests/fixtures/chalk-v1-live.json"));
  const PLAN = ["program", "mix", "goal", "block", "cyc", "next", "plan", "pick", "absNext", "lastSummary"];
  const HIST = ["log", "ex", "custom", "settings"];
  for (const who of ["nick", "kat"]) {
    const other = who === "nick" ? "kat" : "nick";
    const S0 = JSON.parse(LIVE[who]); S0.active = null;        /* same key order as the live save */
    const raw0 = JSON.stringify(S0);
    const { dom, w, d, errors } = boot({ real: true, hook: swHook, store: { "chalk.v1": raw0, "chalk.bak.d": "2000-01-01" } });
    const stored = () => JSON.parse(w.localStorage.getItem("chalk.v1"));
    const kept = () => JSON.parse(w.localStorage.getItem("chalk.people") || "null");
    const tab = name => click(w, q(d, '#tabs [data-tab="' + name + '"]'));
    const switchTo = pid => { tab("settings"); click(w, q(d, '#app [data-a="switch-profile"]')); click(w, q(d, '#app [data-a="pick-profile"][data-v="' + pid + '"]')); tab("today"); };
    const sameBytes = (now, ref) => JSON.stringify(Object.assign({}, now, { updatedAt: ref.updatedAt }));
    try {
      t(who + ": one person on the phone: boot, every tab and Macros write nothing extra", () => {
        ["history", "progress", "settings", "today"].forEach(tab);
        click(w, q(d, '#modebar [data-v="macros"]')); click(w, q(d, '#modebar [data-v="train"]'));
        assert.strictEqual(w.localStorage.getItem("chalk.v1"), raw0);
        assert.strictEqual(w.localStorage.getItem("chalk.people"), null, "nothing kept aside");
        assert.deepStrictEqual(errors, []);
      });
      t(who + ": switching to someone never used here gives their preset; history untouched; the plan kept aside is not in chalk.v1", () => {
        switchTo(other);
        const now = stored(), pr = JSON.parse(w.eval("JSON.stringify(PRESETS." + other + ")"));
        assert.strictEqual(now.profile, other);
        assert.deepStrictEqual(now.mix, pr.mix); assert.strictEqual(now.goal.mode, pr.goal); assert.strictEqual(now.block, 0);
        assert.strictEqual(now.program.mode, pr.goal, "their own program");
        HIST.forEach(k => assert.deepStrictEqual(now[k], S0[k], k + " untouched"));
        const k = kept(); assert.ok(k && k[who] && !k[other], "only the person who left is kept");
        PLAN.forEach(f => assert.deepStrictEqual(k[who][f], S0[f], f + " kept exactly"));
        assert.ok(!("people" in now) && !JSON.stringify(now.program).includes(JSON.stringify(S0.program.workouts[S0.program.order[0]].items)), "chalk.v1 (the training backup) holds only the current person's plan");
        assert.deepStrictEqual(errors, []);
      });
      t(who + ": switching back restores the first plan byte for byte (program, edits, rotation, 45-day clock)", () => {
        const mem = () => w.eval("JSON.stringify(" + JSON.stringify(PLAN) + ".map(f => S[f] === undefined ? null : S[f]))");
        const otherPlan = mem();   /* as on screen: Today builds the day's plan in memory */
        switchTo(who);
        const now = stored();
        assert.strictEqual(sameBytes(now, S0), raw0, "chalk.v1 as it was, except updatedAt");
        PLAN.forEach((f, i) => assert.strictEqual(JSON.stringify(kept()[other][f] === undefined ? null : kept()[other][f]), JSON.stringify(JSON.parse(otherPlan)[i]), "the other person's plan kept for them: " + f));
        assert.ok(d.getElementById("app").textContent.length > 0);
        /* and the other way round: their plan comes back exactly too */
        switchTo(other);
        assert.strictEqual(mem(), otherPlan);
        switchTo(who);
        assert.strictEqual(sameBytes(stored(), S0), raw0);
        assert.deepStrictEqual(errors, []);
      });
      t(who + ": a damaged kept plan falls back to the preset; Erase removes the kept plans", () => {
        w.localStorage.setItem("chalk.people", JSON.stringify({ [other]: { program: { order: ["X"], workouts: {} } }, zz: 1 }));
        switchTo(other);
        assert.deepStrictEqual(stored().mix, JSON.parse(w.eval("JSON.stringify(PRESETS." + other + ".mix)")));
        assert.ok(!("zz" in kept()), "unknown names dropped");
        switchTo(who); assert.strictEqual(sameBytes(stored(), S0), raw0);
        /* C6: a kept plan with a null exercise or a broken day never reaches Today (it crashed there); bad side fields fall back */
        const pr2 = JSON.parse(w.eval("JSON.stringify(PRESETS." + other + ")"));
        for (const bad of [{ program: { order: ["A"], workouts: { A: { name: "A", items: [null] } } } },
          { program: { order: ["A"], workouts: { A: { name: "A", items: [{ t: "block", moves: [null] }] } } } },
          { program: { order: ["A"], workouts: { A: { name: "A", items: [] }, ABS: null } } },
          { program: { order: ["A"], workouts: { A: { name: "A", items: "x" } } } }]) {
          w.localStorage.setItem("chalk.people", JSON.stringify({ [other]: bad }));
          switchTo(other);
          assert.strictEqual(stored().profile, other); assert.deepStrictEqual(stored().mix, pr2.mix, "preset used: " + JSON.stringify(bad));
          assert.ok(d.getElementById("app").textContent.length > 200, "Today still draws");
          switchTo(who); assert.strictEqual(sameBytes(stored(), S0), raw0);
        }
        w.localStorage.setItem("chalk.people", JSON.stringify({ [other]: { program: { order: ["A"], workouts: { A: { name: "A", items: [] } } }, plan: "zz", goal: 5, mix: [], cyc: "q", next: 7, block: "b", absNext: "y", pick: 3, lastSummary: { rec: null } } }));
        switchTo(other);
        { const now = stored(); assert.deepStrictEqual(now.mix, pr2.mix); assert.strictEqual(now.goal.mode, pr2.goal); assert.deepStrictEqual(now.cyc, {}); assert.strictEqual(now.block, 0);
          assert.strictEqual(now.absNext, true); assert.strictEqual(now.pick, null); assert.strictEqual(now.lastSummary, null); assert.strictEqual(now.next, "A"); assert.ok(!now.plan || Array.isArray(now.plan.items)); }
        switchTo(who); assert.strictEqual(sameBytes(stored(), S0), raw0);
        w.localStorage.setItem("chalk.people", '{"__proto__":{"program":1},"zz":{}}'); switchTo(other); switchTo(who);
        assert.ok(!Object.keys(kept()).some(k => k !== "nick" && k !== "kat"), "only real people kept");
        w.localStorage.setItem("chalk.people", "{not json"); switchTo(other); assert.strictEqual(stored().profile, other, "unreadable key: still switches");
        tab("settings"); click(w, q(d, '#app [data-a="wipe"]')); click(w, q(d, '#sheet [data-a="wipe-do"]'));
        assert.strictEqual(w.localStorage.getItem("chalk.people"), null);
        assert.deepStrictEqual(errors, []);
      });
    } finally { dom.window.close(); }
  }
}

/* ------------------- SP-04 (training half): chalk.v1 and chalk.bak are written with characters past U+00FF as \uXXXX,
   so Safari keeps them at 1 byte a character; the live build (v15) reads them back as exactly the same data */
function runNarrowPass() {
  console.log("SP-04: Chalk's save and daily backup escape wide characters");
  const LIVE = JSON.parse(read("tests/fixtures/chalk-v1-live.json"));
  const WIDE = /[\u0100-\uffff]/;
  /* the live build's own load(), straight from git (skipped when there is no history) */
  let liveLoad = null;
  try {
    const { execFileSync } = require("child_process");
    const v15 = execFileSync("git", ["show", "d757f4b:index.html"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 }).toString("utf8");
    const src = (v15.match(/function load\(\)\{[^\n]*\n/) || [])[0];
    assert.ok(src, "the live build's load() found");
    liveLoad = text => vm.runInNewContext("(" + src.replace(/^function load/, "function") + ")()", { KEY: "chalk.v1", localStorage: { getItem: () => text, setItem() {} }, JSON });
  } catch (e) { if (e instanceof assert.AssertionError) throw e; liveLoad = null; }
  for (const who of ["nick", "kat"]) {
    const raw = LIVE[who];
    t(who + ": the live save has no wide characters, so the new writer gives the very same bytes", () => {
      assert.ok(!WIDE.test(raw));
      const { dom, w, errors } = boot({ real: true, store: { "chalk.v1": raw, "chalk.bak.d": "2000-01-01" } });
      try {
        assert.strictEqual(w.eval("lsText(S)"), raw);
        assert.strictEqual(w.localStorage.getItem("chalk.bak"), raw);
        assert.deepStrictEqual(errors, []);
      } finally { dom.window.close(); }
    });
    t(who + ": a save with ’ — → and an emoji: boot leaves it alone, the backup and the next save escape them, and the live build reads both back the same", () => {
      const S0 = JSON.parse(raw);
      const cid = Object.keys(S0.custom)[0];
      S0.custom[cid].n = "Landmine press — Nick’s → 💪";
      S0.settings.note = "½ × · stay Latin-1";
      const old = JSON.stringify(S0);                           /* as an older build wrote it: wide characters raw */
      assert.ok(WIDE.test(old));
      const { dom, w, d, errors } = boot({ real: true, store: { "chalk.v1": old, "chalk.bak.d": "2000-01-01" } });
      try {
        assert.strictEqual(w.localStorage.getItem("chalk.v1"), old, "boot writes nothing");
        const bak = w.localStorage.getItem("chalk.bak");
        assert.ok(!WIDE.test(bak) && bak.includes("\\u2014") && bak.includes("½ × ·"), "backup escaped, Latin-1 kept as is");
        assert.deepStrictEqual(JSON.parse(bak), JSON.parse(old));
        w.eval("save()");
        const now = w.localStorage.getItem("chalk.v1");
        assert.ok(!WIDE.test(now), "the next save is all 1-byte characters");
        const back = JSON.parse(now); back.updatedAt = S0.updatedAt;
        assert.strictEqual(JSON.stringify(back), old, "same data");
        assert.ok(liveLoad, "checked against the live build");
        if (liveLoad) {
          assert.strictEqual(JSON.stringify(liveLoad(now)).replace(/"updatedAt":\d+/, ""), JSON.stringify(JSON.parse(now)).replace(/"updatedAt":\d+/, ""), "v15's load() reads it the same");
          assert.strictEqual(JSON.stringify(liveLoad(bak)), old, "v15's load() reads the backup the same");
        }
        assert.deepStrictEqual(errors, []);
      } finally { dom.window.close(); }
      /* and a relaunch on the escaped save writes nothing */
      const again = boot({ real: true, store: { "chalk.v1": JSON.stringify(Object.assign(JSON.parse(old), { updatedAt: 1 })).replace(/[\u0100-\uffff]/g, c => "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4)), "chalk.bak.d": "2000-01-01" } });
      try {
        const before = again.w.localStorage.getItem("chalk.bak");
        assert.strictEqual(again.w.localStorage.getItem("chalk.v1"), before, "escaped save left byte for byte");
        assert.strictEqual(again.w.eval("S.custom[" + JSON.stringify(cid) + "].n"), "Landmine press — Nick’s → 💪");
        assert.deepStrictEqual(again.errors, []);
      } finally { again.dom.window.close(); }
    });
  }
}

/* ------------------- T3-04: Katerina's "Replace Back Squat" starts with real squat swaps, never Skater Hop "· 0 lb" */
function runReplacePass() {
  console.log("T3-04: Replace suggestions for a loaded lift");
  const LIVE = JSON.parse(read("tests/fixtures/chalk-v1-live.json"));
  const raw = LIVE.kat;
  const { dom, w, d, errors } = boot({ real: true, store: { "chalk.v1": raw, "chalk.bak.d": "2000-01-01" } });
  try {
    t("kat: Replace Back Squat lists loaded squat swaps first; no cardio or timed moves; bodyweight says so, never \"0 lb\"; nothing saved", () => {
      const cardio = ["burpee", "jump_squat", "mtn_climber", "high_knees", "skater", "plank_tap", "bicycle", "bear_crawl", "jumping_jack", "jump_rope", "box_jump", "box_burpee", "lat_box_hop"];
      assert.ok(w.eval("S.ex.skater && S.ex.skater.w === 0"), "her HIIT left a 0 for Skater Hop (the case that ranked it first)");
      const subs = JSON.parse(w.eval('JSON.stringify(subsFor("squat",[],135))'));
      assert.ok(subs.length >= 3);
      subs.forEach(x => assert.ok(!cardio.includes(x.id), x.id + " is not a squat swap"));
      assert.ok(!w.eval("NOLOAD(getEx(" + JSON.stringify(subs[0].id) + ").t)"), "a loaded move first: " + subs[0].id);
      const at = JSON.parse(w.eval("JSON.stringify((()=>{ for(const wid of S.program.order){ const it=S.program.workouts[wid].items; for(let i=0;i<it.length;i++) if(it[i].ex==='squat') return {wid,i}; } return null; })())"));
      assert.ok(at, "Back Squat is in her program");
      w.openReplace({ where: "prog", wid: at.wid, i: at.i, mi: null });
      const rows = [...d.querySelectorAll('#sheetB .opt[data-a="rep-do"]')].map(b => b.textContent.replace(/\s+/g, " ").trim());
      assert.ok(!/Skater Hop|Burpee/.test(rows.slice(0, 6).join(" | ")), rows.slice(0, 6).join(" | "));
      assert.ok(rows.every(r => !/ 0 lb/.test(r)), "no \"0 lb\" rows: " + rows.filter(r => / 0 lb/.test(r)).join(" | "));
      assert.ok(rows.some(r => /bodyweight$/.test(r)), "bodyweight moves say so");
      w.closeSheet();
      assert.strictEqual(w.localStorage.getItem("chalk.v1"), raw, "looking at swaps writes nothing");
      /* replacing a bodyweight move still offers the cardio moves, and your own numbers rank them */
      const bw = JSON.parse(w.eval('JSON.stringify(subsFor("jump_squat",[],null))')).map(x => x.id);
      assert.ok(bw.includes("skater") && bw.includes("burpee"), bw.join(","));
      assert.strictEqual(bw[0], "skater", "her own Skater Hop first for a bodyweight swap");
      assert.deepStrictEqual(errors, []);
    });
  } finally { dom.window.close(); }
}

/* ------------------- T3-02: a weight or reps typed or stepped but not logged yet survives a relaunch */
async function runDraftPass() {
  console.log("T3-02: typed and stepped numbers survive a relaunch");
  const LIVE = JSON.parse(read("tests/fixtures/chalk-v1-live.json"));
  for (const who of ["nick", "kat"]) {
    const raw = LIVE[who];
    const { dom, w, d, errors } = boot({ real: true, hook: swHook, store: { "chalk.v1": raw, "chalk.bak.d": "2000-01-01" } });
    const stored = () => JSON.parse(w.localStorage.getItem("chalk.v1"));
    const type = (el, v) => { el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); };
    try {
      await ta(who + ": typed weight and reps are saved 400 ms later; steppers too; nothing else changes", async () => {
        const cur = w.eval("nextOpenSlot(-1)");
        const wi = q(d, 'input[data-f="w"][data-i="' + cur + '"]'), ri = q(d, 'input[data-f="r"][data-i="' + cur + '"]');
        assert.ok(wi && ri, "the open lift's boxes");
        type(wi, "102.5"); type(ri, "9");
        assert.strictEqual(w.localStorage.getItem("chalk.v1"), raw, "not on every key press");
        await sleep(480);
        const now = stored();
        assert.deepStrictEqual(JSON.parse(JSON.stringify(now.active.items[cur].draft)), { w: 102.5, r: 9 });
        const S0 = JSON.parse(raw);
        ["log", "ex", "custom", "program", "cyc", "goal", "mix", "settings", "profile"].forEach(k => assert.deepStrictEqual(now[k], S0[k], k));
        const nx = w.eval("(()=>{ for(let k=" + cur + "+1;k<S.active.items.length;k++) if(S.active.items[k].t==='lift') return k; return null; })()");
        if (nx != null) {
          const before = w.eval("slotDraft(S.active.items[" + nx + "]).w");
          click(w, q(d, '[data-a="w+"][data-i="' + nx + '"]')); click(w, q(d, '[data-a="r-"][data-i="' + nx + '"]'));
          await sleep(480);
          const dr = stored().active.items[nx].draft;
          assert.ok(dr && dr.w > before, "stepped weight saved");
        }
        assert.deepStrictEqual(errors, []);
      });
      await ta(who + ": going to the background or closing saves at once; a relaunch shows the same numbers", async () => {
        const cur = w.eval("nextOpenSlot(-1)");
        type(q(d, 'input[data-f="w"][data-i="' + cur + '"]'), "77.5");
        Object.defineProperty(d, "visibilityState", { configurable: true, get: () => "hidden" });
        d.dispatchEvent(new w.Event("visibilitychange"));
        assert.strictEqual(stored().active.items[cur].draft.w, 77.5, "saved when hidden");
        Object.defineProperty(d, "visibilityState", { configurable: true, get: () => "visible" });
        type(q(d, 'input[data-f="r"][data-i="' + cur + '"]'), "11");
        w.dispatchEvent(new w.Event("pagehide"));
        assert.strictEqual(stored().active.items[cur].draft.r, 11, "saved on close");
        const up = stored().updatedAt;
        Object.defineProperty(d, "visibilityState", { configurable: true, get: () => "hidden" });
        d.dispatchEvent(new w.Event("visibilitychange")); w.dispatchEvent(new w.Event("pagehide"));
        assert.strictEqual(stored().updatedAt, up, "nothing typed since: no extra save");
        const again = boot({ real: true, hook: swHook, store: { "chalk.v1": w.localStorage.getItem("chalk.v1"), "chalk.bak.d": "2000-01-01" } });
        try {
          assert.strictEqual(q(again.d, 'input[data-f="w"][data-i="' + cur + '"]').value, "77.5");
          assert.strictEqual(q(again.d, 'input[data-f="r"][data-i="' + cur + '"]').value, "11");
          assert.deepStrictEqual(again.errors, []);
        } finally { again.dom.window.close(); }
        assert.deepStrictEqual(errors, []);
      });
    } finally { dom.window.close(); }
  }
}

/* ------------------- F6: sheets, toast, rest badge, switch person, backup, updates, escaping (real modules) */
const swHook = win => {
  /* a service-worker stand-in: the page listens to it for "a newer version is ready" */
  const sw = new win.EventTarget(); sw.controller = null; sw.getRegistration = () => Promise.resolve(null);
  Object.defineProperty(win.navigator, "serviceWorker", { value: sw, configurable: true });
};
const swSays = (w, data) => w.navigator.serviceWorker.dispatchEvent(new w.MessageEvent("message", { data }));
async function runF6Pass() {
  console.log("F6: sheets, toast, rest badge, switch person, backup, updates, escaping");
  {
    const { dom, w, errors } = boot({ real: true, hook: swHook });
    try {
      t("update at launch with nothing going on: reloads straight away", () => {
        let n = 0; w.reloadApp = () => { n++; };
        swSays(w, { type: "chalk-updated", cache: "chalk-v" + (APPV) }); assert.strictEqual(n, 0, "same version: nothing");
        swSays(w, { type: "chalk-updated", cache: "chalk-v" + (APPV + 1) }); assert.strictEqual(n, 1, "newer: reload");
        assert.deepStrictEqual(errors, []);
      });
    } finally { dom.window.close(); }
  }
  /* round 4: updates never wipe typed numbers (K5), background pages reload, the button follows the bar (TN-01) */
  {
    const { dom, w, d, errors } = boot({ real: true, hook: swHook });
    try {
      t("K5: an update while Macros setup/You has typed numbers doesn't reload; the button waits instead", () => {
        let n = 0; w.reloadApp = () => { n++; };
        assert.ok(w.quietNow(), "quiet before");
        w.M.trends = w.M.trends || {}; const had = w.M.trends.hasDraft; w.M.trends.hasDraft = () => true;
        assert.strictEqual(w.quietNow(), false, "typed numbers: not quiet");
        swSays(w, { type: "chalk-updated", cache: "chalk-v" + (APPV + 1) });
        assert.strictEqual(n, 0, "no reload"); assert.ok(!d.getElementById("upd").hidden, "the button shows");
        w.M.trends.hasDraft = () => { throw new Error("broken"); }; assert.ok(w.quietNow(), "a throwing hasDraft never blocks updates for good");
        w.M.trends.hasDraft = had;
        assert.deepStrictEqual(errors, []);
      });
      t("T3-01: while the update button shows, the page gets room at the bottom so nothing sits under it; gone mid-workout", () => {
        assert.ok(/body\.upd-on #app\.wrap\{padding-bottom:calc\(var\(--upd-h,46px\) \+ 36px\)\}/.test(HTML), "the rule");
        const u = d.getElementById("upd");
        assert.ok(!u.hidden && d.body.classList.contains("upd-on"), "room added while it shows");
        Object.defineProperty(u, "offsetHeight", { configurable: true, get: () => 70 }); w.placeUpd();
        assert.strictEqual(d.body.style.getPropertyValue("--upd-h"), "70px", "a two-line button gets more room");
        w.eval("S.active={id:'x',items:[],start:Date.now()}"); w.placeUpd();
        assert.ok(u.hidden && !d.body.classList.contains("upd-on"), "no button, no extra room");
        w.eval("S.active=null"); w.placeUpd();
        assert.ok(!u.hidden && d.body.classList.contains("upd-on"));
      });
      await ta("TN-01: the update button moves up when the bottom bar grows, without a render() (Macros tab switches)", async () => {
        const u = d.getElementById("upd"), cta = d.getElementById("cta");
        Object.defineProperty(cta, "offsetHeight", { configurable: true, get: () => 64 });
        cta.classList.remove("on"); await sleep(0); w.placeUpd(); assert.strictEqual(u.style.bottom, "12px");
        cta.classList.add("on"); await sleep(0);
        assert.strictEqual(u.style.bottom, "76px", "above the Log food bar");
        cta.classList.remove("on"); await sleep(0); assert.strictEqual(u.style.bottom, "12px");
        assert.strictEqual(u.textContent, "New version ready. Tap to update.");
      });
    } finally { dom.window.close(); }
  }
  {
    const { dom, w, d, errors } = boot({ real: true, hook: swHook });
    try {
      t("OF-02: a quiet page in the background reloads on its own and tells the worker it updates itself", () => {
        let n = 0; w.reloadApp = () => { n++; }; const told = [];
        w.navigator.serviceWorker.controller = { postMessage: m => told.push(m) };
        w.eval("window.BOOT_AT0=BOOT_AT"); Object.defineProperty(d, "visibilityState", { configurable: true, get: () => "hidden" });
        w.eval("S.active=null");
        /* past the 10 s launch window, so only "in the background" can reload it */
        const orig = w.Date.now; w.Date.now = () => orig() + 60000;
        try { swSays(w, { type: "chalk-updated", cache: "chalk-v" + (APPV + 1) }); } finally { w.Date.now = orig; }
        assert.strictEqual(n, 1, "reloaded"); assert.strictEqual(JSON.stringify(told), JSON.stringify([{ type: "chalk-self" }]));
        assert.deepStrictEqual(errors, []);
      });
    } finally { dom.window.close(); }
  }
  {
    const { dom, w, d, errors } = boot({ real: true, hook: swHook });
    try {
      t("OF-02: in the background mid-workout it doesn't reload (the rest clock would stop); K6 on pick-profile", () => {
        let n = 0; w.reloadApp = () => { n++; };
        let pc = 0; w.M.cloud = w.M.cloud || {}; const had = w.M.cloud.personChanged; w.M.cloud.personChanged = () => { pc++; };
        click(w, q(d, '#app [data-a="pick-profile"][data-v="nick"]'));
        assert.strictEqual(pc, 1, "K6: picking a person starts a sync catch-up for them");
        w.M.cloud.personChanged = () => { throw new Error("offline"); };
        click(w, q(d, '#tabs [data-tab="settings"]')); click(w, q(d, '#app [data-a="switch-profile"]')); click(w, q(d, '#app [data-a="pick-profile"][data-v="kat"]'));
        assert.strictEqual(w.eval("S.profile"), "kat", "a failing catch-up never blocks the switch");
        if (had) w.M.cloud.personChanged = had; else delete w.M.cloud.personChanged;
        click(w, q(d, '#tabs [data-tab="today"]')); click(w, q(d, '#cta [data-a="start"]'));
        Object.defineProperty(d, "visibilityState", { configurable: true, get: () => "hidden" });
        swSays(w, { type: "chalk-updated", cache: "chalk-v" + (APPV + 1) });
        assert.strictEqual(n, 0); assert.ok(w.eval("!!S.active"));
        assert.deepStrictEqual(errors, []);
      });
    } finally { dom.window.close(); }
  }
  /* round 4: plain workout time, the keyboard never hides a sheet's button, hostile exercise ids */
  {
    const vvHook = win => { swHook(win); win.scrollTo = () => {}; const vv = new win.EventTarget(); vv.height = 768; vv.offsetTop = 0; win.visualViewport = vv; };
    const { dom, w, d, errors } = boot({ real: true, hook: vvHook });
    try {
      t("FX-03/CP-01: workout time in plain words; past 3 hours it asks to finish; rest and HIIT clocks say which (TN-06)", () => {
        const ago = m => w.Date.now() - m * 60000;
        assert.strictEqual(w.elapsed(ago(0)), "just started"); assert.strictEqual(w.elapsed(ago(25)), "25 min");
        assert.strictEqual(w.elapsed(ago(60)), "1 hr"); assert.strictEqual(w.elapsed(ago(85)), "1 hr 25 min");
        assert.strictEqual(w.elapsed(ago(179)), "2 hr 59 min"); assert.strictEqual(w.elapsed(ago(527)), "Finish workout?");
        click(w, q(d, '#app [data-a="pick-profile"][data-v="nick"]')); click(w, q(d, '#cta [data-a="start"]'));
        w.eval("S.active.start=Date.now()-527*60000; render()");
        assert.strictEqual(w.trainBadge(), "Train · Finish workout?"); assert.strictEqual(d.getElementById("subtitle").textContent, "Finish workout?");
        /* C6: the question in the title bar can be tapped; it asks before finishing */
        const sub = d.getElementById("subtitle");
        assert.strictEqual(sub.getAttribute("data-a"), "finish-ask"); assert.strictEqual(sub.getAttribute("role"), "button");
        click(w, sub);
        assert.strictEqual(d.getElementById("sheetT").textContent, "Finish workout?");
        assert.ok(/over 3 hours ago/.test(d.getElementById("sheetB").textContent) && q(d, '#sheetB [data-a="finish-do"]') && q(d, '#sheetB [data-a="sheet-close"]'));
        click(w, q(d, '#sheetB [data-a="sheet-close"]'));
        assert.ok(w.eval("!!S.active"), "Keep going keeps the workout");
        w.eval("S.active.start=Date.now()-25*60000; render()"); assert.strictEqual(w.trainBadge(), "Train · 25 min");
        assert.strictEqual(sub.getAttribute("data-a"), null, "under 3 hours: plain text again"); assert.strictEqual(sub.getAttribute("role"), null);
        w.eval("CT={bi:0,mi:0,round:1,phase:'work',end:Date.now()+12000,paused:false,remain:0,warned:true}");
        assert.strictEqual(w.trainBadge(), "Train · Work 0:12");
        w.eval("CT.phase='rest'; CT.end=Date.now()+8000"); assert.strictEqual(w.trainBadge(), "Train · Rest 0:08");
        w.eval("CT.paused=true"); assert.strictEqual(w.trainBadge(), "Train · 25 min", "paused: the workout time");
        w.eval("CT=null; S.active=null; save(); render()"); assert.strictEqual(w.trainBadge(), "Train");
      });
      t("IO-01: with the keyboard up, an open sheet sits on top of it and fits the space left; back to normal when it closes", () => {
        const vv = w.visualViewport, sh = d.getElementById("sheet");
        w.openSheet("Amount", '<input id="kb-in" inputmode="decimal"><button class="btn primary">Add</button>');
        vv.height = 420; vv.dispatchEvent(new w.Event("resize"));
        assert.strictEqual(sh.style.bottom, (w.innerHeight - 420) + "px"); assert.strictEqual(sh.style.maxHeight, "408px");
        vv.offsetTop = 30; vv.dispatchEvent(new w.Event("scroll"));
        assert.strictEqual(sh.style.bottom, (w.innerHeight - 450) + "px", "follows iOS scrolling the page up");
        vv.height = w.innerHeight; vv.offsetTop = 0; vv.dispatchEvent(new w.Event("resize"));
        assert.strictEqual(sh.style.bottom, "", "keyboard down: normal again");
        vv.height = 420; vv.dispatchEvent(new w.Event("resize")); assert.ok(sh.style.bottom);
        w.closeSheet(); assert.strictEqual(sh.style.bottom, ""); assert.strictEqual(sh.style.maxHeight, "");
        vv.dispatchEvent(new w.Event("resize")); assert.strictEqual(sh.style.bottom, "", "no sheet: nothing moves");
        vv.height = w.innerHeight;
      });
      t("SE-01: a backup with exercise id \"__proto__\" can't touch Object.prototype, and Finish workout still saves", () => {
        const bk = JSON.parse(w.eval("JSON.stringify(S)")); const W0 = bk.program.order[0];
        bk.program.workouts[W0].items[0].ex = "__proto__";
        bk.log = [{ id: "r1", wid: W0, name: "Pull day", start: Date.now() - 864e5, end: Date.now() - 864e5 + 3600e3, sets: { bb_row: [{ w: 135, r: 8 }] }, volume: 1080, nsets: 1, blocks: [], abs: false, results: [{ ex: "bb_row", from: 130, to: 135, kind: "up", chg: "", pr: false, range: null, dsets: 0 }] }];
        let txt = JSON.stringify(bk);
        txt = txt.replace('"sets":{"bb_row"', '"sets":{"__proto__":[{"w":1,"r":1}],"bb_row"').replace('"ex":{', '"ex":{"__proto__":{"w":5,"miss":0,"best":0,"hist":[]},"constructor":{"w":7},').replace(/"custom":\{(\}?)/, (m0, end) => '"custom":{"__proto__":{"n":"Evil","m":"Back","t":"bb"}' + (end ? "}" : ","));
        assert.ok(txt.includes('"sets":{"__proto__"') && txt.includes('"ex":{"__proto__"') && txt.includes('"custom":{"__proto__"'), "hostile backup built");
        click(w, q(d, '#tabs [data-tab="settings"]')); click(w, q(d, '#app [data-a="import"]'));
        d.getElementById("impT").value = txt; click(w, q(d, '#sheetB [data-a="import-do"]'));
        assert.strictEqual(w.eval("S.program.workouts[" + JSON.stringify(W0) + "].items.some(it=>it.ex==='__proto__')"), false, "the bad lift is dropped");
        assert.strictEqual(w.eval("Object.keys(S.ex).filter(k=>k==='__proto__'||k==='constructor').length"), 0);
        assert.strictEqual(w.eval("Object.prototype.hasOwnProperty.call(S.log[0].sets,'__proto__')"), false);
        assert.strictEqual(w.eval("S.log[0].sets.bb_row.length"), 1, "real history kept");
        assert.strictEqual(w.eval("getEx('__proto__')===Object.prototype"), false); assert.strictEqual(w.eval("getEx('__proto__').n"), "__proto__");
        assert.strictEqual(w.eval("exState('__proto__')===Object.prototype||exState('constructor')===Object"), false);
        assert.strictEqual(w.eval("getEx('zz_retired_lift').m"), "Other", "an unknown normal id still works");
        const c = JSON.parse('{"v":1,"log":[{"id":"x","sets":{"old_lift":[{"w":50,"r":5}]}}],"ex":{"old_lift":{"w":50,"miss":0,"best":0,"hist":[]}}}'); const before = JSON.stringify(c);
        w.cleanTrain(c); assert.strictEqual(JSON.stringify(c), before, "history of a lift that's no longer in the list is kept");
        click(w, q(d, '#tabs [data-tab="today"]')); click(w, q(d, '#cta [data-a="start"]'));
        const n = w.eval("S.log.length"); click(w, q(d, '#app [data-a="log"]')); w.eval("stopRest()");
        click(w, q(d, '#app [data-a="finish"]')); const fin = q(d, '#sheetB [data-a="finish-do"]'); if (fin) click(w, fin);
        assert.strictEqual(w.eval("S.log.length"), n + 1, "the workout saved"); assert.strictEqual(w.eval("S.active"), null);
        assert.strictEqual(w.eval("(()=>{ const k=[]; for (const x in {}) k.push(x); return k.join(','); })()"), "", "Object.prototype clean");
        w.closeSheet();
      });
      t("CP-06: with Sync on, the Settings footer says the data is backed up with Sync; CP-05 backup text box says what to do", () => {
        const had = w.M.cloud; w.M.cloud = Object.assign({}, had || {}, { status: () => ({ on: true }) });
        try { click(w, q(d, '#tabs [data-tab="settings"]')); assert.ok(d.getElementById("app").textContent.includes("Chalk · your data is on this phone and backed up with Sync.")); }
        finally { w.M.cloud = had; }
        w.render(); assert.ok(d.getElementById("app").textContent.includes("Chalk · your data lives on this phone"), "sync off: the old line");
        assert.ok(HTML.includes('<p class="hint" style="margin-bottom:8px">Copy all of this text and paste it into Notes.</p><textarea readonly'));
      });
      t("IO-05: Train's choices, small buttons and muscle chips are 44 px tap targets; the goal tag has a 44 px hit area", () => {
        assert.ok(HTML.includes(".seg button[data-a],.btn.sm[data-a],button.chip[data-a]{min-height:44px}"));
        assert.ok(HTML.includes('button.tag[data-a="checkin"]::after{content:"";position:absolute;left:0;right:0;top:50%;height:44px;transform:translateY(-50%)}'));
        assert.ok(HTML.includes('button.tag[data-a="checkin"]{position:relative;color:#7A4F06}'));
      });
      t("IO-04: presses show on iPhone (touchstart listener + :active)", () => {
        assert.ok(HTML.includes('document.addEventListener("touchstart",()=>{},{passive:true});'));
        assert.ok(HTML.includes(".btn:active,.opt:active,.chip:active,.m-row:active,.tabs button:active,.modebar button:active,.seg button:active{filter:brightness(.92)}"));
      });
      t("TN-03: Settings choice buttons never shrink (90s visible at 375 px); TN-04: text boxes use the app font", () => {
        assert.ok(HTML.includes(".srow>div:first-child{flex:1 1 auto;min-width:0}") && HTML.includes(".srow>.seg{flex-shrink:0}"));
        assert.ok(HTML.includes("input,select,textarea{font:inherit;color:inherit}") && !/textarea\{[^}]*monospace/.test(HTML));
      });
      t("no errors in the round-4 page", () => assert.deepStrictEqual(errors.map(String), [], errors.map(String).join(" | ")));
    } finally { dom.window.close(); }
  }
  for (const bad of ["{\"v\":1,\"log\":[{\"id\":\"cut", "{\"v\":2,\"log\":[]}"]) {
    const { dom, w, errors } = boot({ real: true, hook: swHook, store: { "chalk.v1": bad, "chalk.bak.d": "2000-01-01" } });
    try {
      t("a save this version can't read stays in place at launch (" + bad.slice(0, 12) + "…)", () => {
        assert.strictEqual(w.localStorage.getItem("chalk.v1"), bad, "not written over at launch");
        assert.strictEqual(w.localStorage.getItem("chalk.bak"), bad, "today's backup holds it");
        assert.ok(w.eval("S.v===1 && Array.isArray(S.log)"), "the app still opens");
        assert.deepStrictEqual(errors, []);
      });
    } finally { dom.window.close(); }
  }
  const { dom, w, d, errors } = boot({ real: true, hook(win) {
    swHook(win); win.scrollTo = () => {};   /* jsdom has no scrolling; the focusout handler calls it */
    const gi = win.Storage.prototype.getItem; win.__reads = 0;
    win.Storage.prototype.getItem = function (k) { if (k === "chalk.v1") win.__reads++; return gi.call(this, k); };
  } });
  const app = () => d.getElementById("app"), toastEl = () => d.getElementById("toast");
  const tab = n => click(w, q(d, '#tabs [data-tab="' + n + '"]'));
  const mode = v => click(w, q(d, '#modebar [data-v="' + v + '"]'));
  const act = a => { const b = d.createElement("button"); b.dataset.a = a; d.body.appendChild(b); click(w, b); b.remove(); };
  const restore = bk => { tab("settings"); click(w, q(d, '#app [data-a="import"]')); d.getElementById("impT").value = JSON.stringify(bk); click(w, q(d, '#sheetB [data-a="import-do"]')); };
  try {
    t("boot reads the training save once (PRF-07) and logs no errors", () => { assert.deepStrictEqual(errors, []); assert.strictEqual(w.__reads, 1); });
    click(w, q(d, '#app [data-a="pick-profile"][data-v="nick"]'));
    t("mode buttons carry aria-pressed that follows the mode (TRN-15)", () => {
      const tr = q(d, '#modebar [data-v="train"]'), mc = q(d, '#modebar [data-v="macros"]');
      assert.deepStrictEqual([tr.getAttribute("aria-pressed"), mc.getAttribute("aria-pressed")], ["true", "false"]);
      mode("macros"); assert.deepStrictEqual([tr.getAttribute("aria-pressed"), mc.getAttribute("aria-pressed")], ["false", "true"]);
      mode("train"); assert.deepStrictEqual([tr.getAttribute("aria-pressed"), mc.getAttribute("aria-pressed")], ["true", "false"]);
    });
    t("toast time grows with length: 1.5 s + 60 ms a letter, 6 s at most", () => {
      assert.strictEqual(w.toastMs(""), 1500); assert.strictEqual(w.toastMs("x".repeat(10)), 2100); assert.strictEqual(w.toastMs("x".repeat(500)), 6000);
    });
    let opener = null;
    t("sheet open: screen behind is inert, the sheet is live, focus on its title, toasts show at the top (IOS-02/03)", () => {
      opener = q(d, '#app [data-a="pick-workout"]'); assert.ok(opener, "Which workout? button");
      w.toast("Before the sheet"); assert.ok(!toastEl().classList.contains("top"));
      opener.focus(); click(w, opener);
      assert.ok(toastEl().classList.contains("top"), "a toast from a moment ago moves up, out from under the sheet");
      [q(d, ".top"), ...["modebar", "scroll", "cta", "tabs"].map(id => d.getElementById(id))].forEach(el => assert.ok(el.hasAttribute("inert"), (el.id || el.className) + " inert"));
      const sh = d.getElementById("sheet"); assert.ok(!sh.hasAttribute("inert") && !sh.hasAttribute("aria-hidden"), "sheet live");
      assert.strictEqual(d.activeElement, d.getElementById("sheetT"));
      w.toast("Saved"); assert.ok(toastEl().classList.contains("top") && toastEl().classList.contains("on"));
    });
    await ta("Escape closes it: inert lifted, sheet hidden, focus back on the opener, M.ui.cleanup runs, body cleared (PRF-12)", async () => {
      let cleaned = 0; const orig = w.M.ui.cleanup; w.M.ui.cleanup = function () { cleaned++; return orig ? orig.apply(this, arguments) : undefined; };
      d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      ["modebar", "scroll", "cta", "tabs"].forEach(id => assert.ok(!d.getElementById(id).hasAttribute("inert"), id));
      const sh = d.getElementById("sheet"); assert.strictEqual(sh.getAttribute("aria-hidden"), "true"); assert.ok(sh.hasAttribute("inert"));
      assert.strictEqual(d.activeElement, opener);
      await sleep(320);
      w.M.ui.cleanup = orig;
      assert.strictEqual(cleaned, 1); assert.strictEqual(d.getElementById("sheetB").innerHTML, "");
      w.toast("Back"); assert.ok(!toastEl().classList.contains("top"), "bottom again");
    });
    t("workout running: the Train half reads the workout time (TRN-09)", () => {
      click(w, q(d, '#cta [data-a="start"]')); assert.ok(w.eval("!!S.active"));
      assert.strictEqual(w.trainBadge(), "Train · just started");
      assert.strictEqual(q(d, '#modebar [data-v="train"] .mb-l').textContent, "Train · just started");
    });
    t("resting: overlay on, mode bar tappable; in Macros the overlay hides and the clock runs on the Train half (UX2-05/TRN-05)", () => {
      click(w, q(d, '#app [data-a="log"]')); assert.ok(w.eval("!!T"), "rest started");
      assert.ok(d.getElementById("rest").classList.contains("on")); assert.match(w.trainBadge(), /^Train · Rest \d+:\d\d$/);
      mode("macros");
      assert.ok(!d.getElementById("rest").classList.contains("on"), "overlay hidden in Macros"); assert.ok(w.eval("!!T"), "clock still running");
      assert.match(q(d, '#modebar [data-v="train"] .mb-l').textContent, /^Train · Rest \d+:\d\d$/);
    });
    t("rest ends while in Macros: a toast says so, the badge goes back to the workout time", () => {
      w.eval("T.end=Date.now()-1; tickRest()");
      assert.match(toastEl().textContent, /^Rest is over\. Next: /); assert.strictEqual(w.trainBadge(), "Train · just started");
      w.eval("stopRest()");
    });
    t("back in Train before rest ends: the overlay is there again", () => {
      mode("train"); click(w, q(d, '#app [data-a="log"]')); mode("macros"); mode("train");
      assert.ok(d.getElementById("rest").classList.contains("on")); w.eval("stopRest()");
    });
    t("clock ticks in Macros don't draw Train over it (TRN-16)", () => {
      mode("macros"); const before = app().innerHTML; w.eval("trainRender()"); assert.strictEqual(app().innerHTML, before); mode("train");
    });
    await ta("a \"Program updated\" note waits for Train instead of popping up over Macros (TRN-17)", async () => {
      w.eval("stopRest()"); mode("macros"); w.eval("S.flash='Your days were rebuilt.'; render()");
      await sleep(500); assert.ok(!d.getElementById("sheetBg").classList.contains("on"), "no sheet over Macros"); assert.ok(w.eval("!!S.flash"), "note kept");
      mode("train"); await sleep(500);
      assert.strictEqual(d.getElementById("sheetT").textContent, "Program updated"); assert.ok(!w.eval("S.flash"));
      w.closeSheet(); await sleep(300);
    });
    t("update during a workout: no reload and no button mid-set; the button shows once the workout is done; tapping it reloads", () => {
      let n = 0; w.reloadApp = () => { n++; };
      swSays(w, { type: "chalk-version", cache: "chalk-v" + (APPV + 1) });
      const u = d.getElementById("upd");
      assert.strictEqual(n, 0); assert.ok(w.eval("!!S.active")); assert.ok(u.hidden, "no button while the workout runs");
      w.eval("render()"); assert.ok(u.hidden, "still waiting after a redraw");
      w.eval("window.__act=S.active; S.active=null; render()");
      assert.ok(!u.hidden, "workout over: the button shows"); assert.strictEqual(u.textContent, "New version ready. Tap to update.");
      click(w, u); assert.strictEqual(n, 1);
      swSays(w, { type: "chalk-version", cache: "chalk-v" + (APPV + 1) }); assert.strictEqual(n, 1, "only once");
      w.eval("S.active=window.__act; delete window.__act; render()"); assert.ok(u.hidden);
    });
    t("Switch person is hidden during a workout; a Switch from elsewhere says finish first (UIT-10/TRN-03)", () => {
      tab("settings"); assert.ok(!q(d, '#app [data-a="switch-profile"]'));
      act("switch-profile"); assert.strictEqual(w.eval("S.profile"), "nick"); assert.strictEqual(toastEl().textContent, "Finish your workout first");
      w.eval("S.active=null; save(); render()");
    });
    t("CP-07: Switch says who is on now; Keep goes back with the plan as it was; the other person gets their own start", () => {
      const plan = () => w.eval("JSON.stringify({program:S.program,mix:S.mix,goal:S.goal,block:S.block,cyc:S.cyc})");
      const before = plan();
      tab("settings"); click(w, q(d, '#app [data-a="switch-profile"]'));
      assert.strictEqual(w.eval("S.profile"), null);
      assert.ok(app().textContent.includes("Who is this?") && app().textContent.includes("Now: Nick. Workout history is kept."));
      assert.strictEqual(q(d, '#app [data-a="pick-profile"][data-v="kat"]').textContent, "Switch to Katerina");
      assert.strictEqual(q(d, '#app [data-a="switch-cancel"]').textContent, "Keep Nick");
      assert.ok(!q(d, '#app [data-a="pick-profile"][data-v="nick"]'), "no second way to keep Nick");
      click(w, q(d, '#app [data-a="switch-cancel"]'));
      assert.strictEqual(w.eval("S.profile"), "nick"); assert.strictEqual(plan(), before, "program, mix, goal, 45-day clock kept");
      tab("settings"); click(w, q(d, '#app [data-a="switch-profile"]')); click(w, q(d, '#app [data-a="pick-profile"][data-v="kat"]'));
      assert.strictEqual(w.eval("S.profile"), "kat"); assert.strictEqual(w.eval("JSON.stringify(S.mix)"), w.eval("JSON.stringify(PRESETS.kat.mix)"));
    });
    t("Restore says what happens; if the food part can't be read the workouts still come back (CPY-35/TRN-08/TRN-13)", () => {
      tab("settings"); click(w, q(d, '#app [data-a="import"]'));
      assert.ok(d.getElementById("sheetB").textContent.includes("Pick your backup file, or paste the backup text. Your workouts are replaced by the ones in the backup. Food logs and meals in the backup are added. Newer food changes on this phone stay."));
      const bk = JSON.parse(w.eval("JSON.stringify(S)")); bk.settings.restC = 90; bk.__macros = { v: 1 };
      const orig = w.M.import; w.M.import = () => { throw new Error("unreadable"); };
      try { d.getElementById("impT").value = JSON.stringify(bk); click(w, q(d, '#sheetB [data-a="import-do"]')); } finally { w.M.import = orig; }
      assert.strictEqual(w.eval("S.settings.restC"), 90); assert.strictEqual(toastEl().textContent, "Workouts restored. The food part couldn't be read.");
    });
    t("a big backup is offered as a file, never dumped into a text box (PRF-08)", () => {
      w.URL.createObjectURL = () => "blob:chalk-test"; w.URL.revokeObjectURL = () => {};
      w.eval("S.log=Array.from({length:900},(_,i)=>({id:'r'+i,wid:'PULL',name:'Pull day',start:Date.now()-i*864e5,end:Date.now()-i*864e5+3600e3,sets:{bb_row:[{w:135,r:8},{w:135,r:8},{w:135,r:8}]},volume:3240,nsets:3,blocks:[],abs:false,results:[]}))");
      tab("settings"); click(w, q(d, '#app [data-a="export"]'));
      assert.ok(!q(d, "#sheetB textarea"), "no text box"); const a = q(d, '#sheetB a[download]');
      assert.ok(a && a.textContent === "Save file" && /^chalk-backup-\d{4}-\d\d-\d\d\.json$/.test(a.getAttribute("download")));
      w.closeSheet(); w.eval("S.log=[]; save(); render()");
    });
    t("a hostile backup can't put markup on any Train screen; ids survive as text (SEC-02)", () => {
      const X = '"><img src=x onerror="window.__pwn=1">';
      const bk = JSON.parse(w.eval("JSON.stringify(S)")); const W0 = bk.program.order[0];
      bk.log = [{ id: "a" + X, wid: W0, name: "Legs" + X, start: Date.now() - 3600e3, end: Date.now(), sets: { bb_row: [{ w: "135" + X, r: 8 }], ["zz" + X]: [{ w: 1, r: 1 }] }, volume: 1, nsets: 2,
        blocks: [{ name: "B" + X, mode: "timer", done: 2, rounds: 3, work: 30, rest: 10, moves: [{ ex: "mb_slam", w: 0, reps: 10 }] }], abs: false,
        results: [{ ex: "bb_row", from: 1, to: 2, kind: "up", chg: "c" + X, pr: false, range: null, dsets: 0 }] }];
      bk.custom = { ["c_x" + X]: { n: "Evil" + X, m: "Chest" + X, t: "bb" + X, inc: 5, rest: 75, guess: 50, s: ["Back" + X], p: "generic" } };
      bk.ex["c_x" + X] = { w: 100, miss: 0, best: 0, hist: [{ d: Date.now(), w: 100, r: [5], e1: 110 }] };
      bk.program.workouts[W0].name = "Day" + X; bk.program.workouts[W0].focus = ["Back", "Back" + X];
      restore(bk);
      ["today", "history", "progress", "settings"].forEach(n => { tab(n); assert.ok(app().children.length, n); });
      tab("history"); const hr = q(d, '#app [data-a="hist"]'); assert.strictEqual(hr.dataset.id, "a" + X); click(w, hr);
      tab("today"); click(w, q(d, '#app [data-a="pick-workout"]')); w.closeSheet();
      click(w, q(d, '#cta [data-a="start"]'));
      assert.strictEqual(d.querySelectorAll("img").length, 0); assert.ok(!d.querySelector("[onerror]")); assert.strictEqual(w.__pwn, undefined);
      assert.strictEqual(w.eval("S.custom[" + JSON.stringify("c_x" + X) + "].m"), "Other", "unknown muscle name dropped");
      w.eval("S.active=null; save(); render()");
    });
    t("Erase names everything it deletes and removes the Claude key too (CPY-04/TRN-07/TRN-14); backups and drafts go too (TN-05)", () => {
      w.localStorage.setItem("chalk.ai.key", "sk-test");
      ["chalk.bak", "chalk.bak.d", "chalk.bad", "chalk.macros.setupDraft.nick", "chalk.macros.draft.food", "chalk.macros.draft.meal.x"].forEach(k => w.localStorage.setItem(k, "x"));
      w.localStorage.setItem("apollo.other.app", "keep");
      tab("settings"); click(w, q(d, '#app [data-a="wipe"]'));
      const txt = d.getElementById("sheetB").textContent;
      ["workouts", "food logs", "saved meals", "your foods", "weigh-ins", "Claude key"].forEach(s => assert.ok(txt.includes(s), s));
      click(w, q(d, '#sheetB [data-a="wipe-do"]'));
      assert.strictEqual(w.localStorage.getItem("chalk.ai.key"), null); assert.ok(!w.eval("S.profile"));
      ["chalk.bak", "chalk.bak.d", "chalk.bad", "chalk.macros.setupDraft.nick", "chalk.macros.draft.food", "chalk.macros.draft.meal.x"].forEach(k => assert.strictEqual(w.localStorage.getItem(k), null, k));
      assert.strictEqual(w.localStorage.getItem("apollo.other.app"), "keep", "other apps' keys stay");
      assert.strictEqual(q(d, '#app [data-a="pick-profile"][data-v="nick"]').textContent, "I'm Nick", "CP-07");
      assert.ok(d.getElementById("app").textContent.includes("Who is this?"));
    });
    t("no errors during the F6 pass", () => assert.deepStrictEqual(errors.map(String), [], errors.map(String).join(" | ")));
  } finally { dom.window.close(); }
}

/* ------------------------------------------------- v21: optional 4th training day (Athletic day) */
function runFourDayPass() {
  console.log("v21: 3 or 4 training days");
  const LIVE = JSON.parse(read("tests/fixtures/chalk-v1-live.json"));
  for (const who of ["nick", "kat"]) {
    const S0 = JSON.parse(LIVE[who]); S0.active = null; const raw = JSON.stringify(S0);
    const { dom, w, d, errors } = boot({ real: true, store: { "chalk.v1": raw, "chalk.bak.d": "2000-01-01" } });
    const tab = name => click(w, q(d, '#tabs [data-tab="' + name + '"]'));
    try {
      t(who + ": a live save still trains 3 days; Settings offers 3 / 4 with 3 on", () => {
        assert.deepStrictEqual(errors, []);
        assert.strictEqual(w.eval("daysOf()"), 3);
        assert.strictEqual(JSON.parse(w.eval("JSON.stringify(S.program.order)")).length, 3);
        tab("settings");
        assert.ok(q(d, '#app [data-a="days"][data-v="3"].on'), "3 days is on");
        assert.ok(q(d, '#app [data-a="days"][data-v="4"]') && !q(d, '#app [data-a="days"][data-v="4"].on'), "4 days is offered, off");
      });
      t(who + ": 4 days adds an Athletic day — full body, medium weights, no heavy main lift, rotates, no doubled abs", () => {
        const ex0 = w.eval("JSON.stringify(S.ex)"), log0 = w.eval("S.log.length");
        click(w, q(d, '#app [data-a="days"][data-v="4"]'));
        assert.strictEqual(w.eval("daysOf()"), 4);
        assert.strictEqual(w.eval("S.days"), 4);
        const P = JSON.parse(w.eval("JSON.stringify(S.program)"));
        assert.strictEqual(P.order.length, 4); assert.strictEqual(P.order[3], "ATHL");
        const A = P.workouts.ATHL;
        assert.strictEqual(A.name, "Athletic day"); assert.ok(A.noAbs, "carries its own core work");
        assert.ok(A.items.every(it => !it.main), "no heavy main lift");
        const lifts = A.items.filter(it => it.t === "lift"), blocks = A.items.filter(it => it.t === "block");
        assert.ok(lifts.length >= 4 && blocks.length === 2, lifts.length + " lifts, " + blocks.length + " blocks");
        assert.ok(lifts.filter(it => it.pool && it.pool.length).every(it => it.rot), "every lift slot rotates");
        const medium = lifts.filter(it => it.lo === 10 && it.hi === 15);
        assert.ok(medium.length >= 4, "medium-weight rep ranges (10–15): " + medium.length);
        assert.ok(blocks.some(b => b.name === "Circuit") && blocks.some(b => b.name === "Core"), blocks.map(b => b.name).join(","));
        assert.strictEqual(A.gear, "hotel", "hotel gym by default (bodyweight + light weights)");
        const every = [].concat(...A.items.map(it => it.t === "block" ? it.moves.map(m => m.ex) : [it.ex]));
        every.forEach(id => assert.ok(w.eval("gearOk(" + JSON.stringify(id) + ",'hotel')"), id + " needs no barbell, machine or cable"));
        const circ = blocks.find(b => b.name === "Circuit").moves.map(m => m.ex);
        assert.ok(circ.length >= 3, "circuit moves: " + circ.join(","));
        const groups = new Set([].concat(...A.items.map(it => it.t === "block" ? it.moves.map(m => w.eval("getEx(" + JSON.stringify(m.ex) + ").m")) : [w.eval("getEx(" + JSON.stringify(it.ex) + ").m")])));
        assert.ok(groups.size >= 4, "full body: " + [...groups].join(","));
        A.focus.forEach(m => assert.ok(groups.has(m), "focus " + m + " is hit"));
        /* weights, history and the other days survive the rebuild */
        assert.strictEqual(w.eval("JSON.stringify(S.ex)"), ex0, "weights untouched");
        assert.strictEqual(w.eval("S.log.length"), log0, "history untouched");
        assert.ok(P.order.slice(0, 3).every(id => P.workouts[id] && P.workouts[id].items.length), "the 3 original days are still there");
        /* planning that day appends no abs even when abs are due */
        w.eval("S.absNext=true; S.program.absEvery=S.program.absEvery||2; if(!S.program.workouts.ABS) S.program.workouts.ABS={name:'Abs',focus:['Core'],items:[]}; S.plan=null;");
        const plan = JSON.parse(w.eval("JSON.stringify(planFor('ATHL'))"));
        assert.strictEqual(plan.abs, false); assert.ok(plan.items.every(it => !it.abs), "no abs items");
        /* the suggested-day rotation reaches it */
        const week = JSON.parse(w.eval("JSON.stringify(weekSchedule(8))"));
        assert.ok(week.includes("ATHL"), "Athletic day comes around: " + week.join(" "));
        assert.ok(q(d, '#app [data-a="days"][data-v="4"].on'), "4 days is on");
        assert.ok(JSON.parse(w.localStorage.getItem("chalk.v1")).days === 4, "saved");
      });
      t(who + ": Day 4 gear → No equipment: every move is bodyweight, a squat / push / pull / lunge / hinge each, circuit + core; Hotel gym brings dumbbells, med ball and box back", () => {
        assert.ok(q(d, '#app [data-a="gear"][data-v="hotel"].on'), "Settings shows the gear row with Hotel gym on");
        click(w, q(d, '#app [data-a="gear"][data-v="bw"]'));
        assert.strictEqual(w.eval("gearOf()"), "bw");
        const A = JSON.parse(w.eval("JSON.stringify(S.program.workouts.ATHL)"));
        assert.strictEqual(A.gear, "bw"); assert.ok(/bodyweight only/.test(A.sub), A.sub);
        const every = [].concat(...A.items.map(it => it.t === "block" ? it.moves.map(m => m.ex) : [it.ex]));
        every.forEach(id => assert.strictEqual(w.eval("getEx(" + JSON.stringify(id) + ").t"), "bw", id + " is bodyweight"));
        const lifts = A.items.filter(it => it.t === "lift");
        assert.strictEqual(lifts.length, 5, "squat · push · pull · lunge · hinge");
        const groups = lifts.map(it => w.eval("getEx(" + JSON.stringify(it.ex) + ").m"));
        ["Quads", "Back"].forEach(m => assert.ok(groups.includes(m), m + " in " + groups.join(",")));
        assert.ok(groups.some(m => m === "Chest" || m === "Shoulders" || m === "Triceps"), "a push: " + groups.join(","));
        assert.ok(lifts.every(it => it.rot), "every slot rotates");
        assert.deepStrictEqual(A.items.filter(it => it.t === "block").map(b => b.name), ["Circuit", "Core"]);
        assert.ok(JSON.parse(w.eval("JSON.stringify(S.program.order)")).length === 4, "the other days are untouched");
        /* the Add picker on that day: bodyweight first, barbell / machine / cable moves behind "show" */
        w.openAdd({ where: "prog", wid: "ATHL" });
        const sheet = q(d, "#sheetB");
        const groupsH = [...sheet.querySelectorAll(".opt-grp")].map(g => g.textContent.trim());
        assert.strictEqual(groupsH[0], "Bodyweight");
        const more = sheet.querySelector('.opt[data-a="more"]'); assert.ok(more && /Barbell, machine and cable/.test(more.textContent));
        const shown = [...sheet.querySelectorAll('.opt[data-a="add-do"]')].filter(b => !b.closest("[hidden]")).map(b => b.dataset.ex).filter(id => id !== "__new");
        shown.forEach(id => assert.strictEqual(w.eval("getEx(" + JSON.stringify(id) + ").t"), "bw", id + " shown on a no-equipment day"));
        assert.ok(shown.includes("bw_lunge") && shown.includes("pushup") && shown.includes("pullup") && shown.includes("jump_squat"));
        assert.ok(!shown.includes("squat") && !shown.includes("bench"), "the barbell lifts are tucked away");
        w.closeSheet();
        /* Today shows the gear switch on this day and the hotel option brings the light weights back */
        w.eval("S.pick='ATHL'; S.plan=null;"); tab("today");
        assert.ok(q(d, '#app [data-a="gear"][data-v="bw"].on') && q(d, '#app [data-a="gear"][data-v="hotel"]'), "gear switch on Today");
        assert.ok(!q(d, '#app [data-a="style"]'), "the Weights / Functional / HIIT row steps aside on this day");
        click(w, q(d, '#app [data-a="gear"][data-v="hotel"]'));
        const H = JSON.parse(w.eval("JSON.stringify(S.program.workouts.ATHL)"));
        assert.strictEqual(H.gear, "hotel");
        const types = new Set([].concat(...H.items.map(it => it.t === "block" ? it.moves.map(m => w.eval("getEx(" + JSON.stringify(m.ex) + ").t")) : [w.eval("getEx(" + JSON.stringify(it.ex) + ").t")])));
        assert.ok(types.has("db") || types.has("kb"), "light weights back: " + [...types].join(","));
        assert.ok(H.items.some(it => it.t === "lift" && it.pool && it.pool.includes("pullup")), "a pull-up / row slot");
        assert.ok(H.items.some(it => it.t === "lift" && it.pool && it.pool.includes("dips")), "a dip slot");
        w.eval("S.pick=null;"); tab("settings");
      });
      t(who + ": back to 3 days drops the Athletic day and keeps everything else", () => {
        click(w, q(d, '#app [data-a="days"][data-v="3"]'));
        const P = JSON.parse(w.eval("JSON.stringify(S.program)"));
        assert.strictEqual(P.order.length, 3); assert.ok(!P.workouts.ATHL);
        assert.ok(P.order.includes(w.eval("S.next")), "the rotation pointer is a real day");
      });
      t(who + ": no errors during the 4-day pass", () => assert.deepStrictEqual(errors.map(String), [], errors.map(String).join(" | ")));
    } finally { dom.window.close(); }
  }
}

/* ------------------------------------------------- v22: bodyweight moves you can add anywhere */
function runBodyweightPass() {
  console.log("v22: add bodyweight moves (lunges, push-ups, pull-ups, jump squats)");
  const LIVE = JSON.parse(read("tests/fixtures/chalk-v1-live.json"));
  const S0 = JSON.parse(LIVE.nick); S0.active = null; const raw = JSON.stringify(S0);
  const { dom, w, d, errors } = boot({ real: true, store: { "chalk.v1": raw, "chalk.bak.d": "2000-01-01" } });
  const tab = name => click(w, q(d, '#tabs [data-tab="' + name + '"]'));
  try {
    t("the library has the bodyweight staples, each with a figure and no dumbbells in the lunge rig", () => {
      ["bw_squat", "bw_lunge", "bw_lunge_walk", "bw_split_squat", "chinup", "pushup", "pullup", "jump_squat", "diamond_pushup", "pike_pushup", "bw_calf"].forEach(id => {
        const L = JSON.parse(w.eval("JSON.stringify(getEx(" + JSON.stringify(id) + "))"));
        assert.strictEqual(L.t, "bw", id + " is bodyweight");
        assert.ok(w.eval("!!PAT[getEx(" + JSON.stringify(id) + ").p]"), id + " has a figure");
      });
      assert.ok(w.eval("PAT.bwlunge && !PAT.bwlunge.grip && PAT.lunge.grip==='db'"), "the bodyweight lunge figure holds nothing");
    });
    t("Today → + Exercise lists a Bodyweight group first with lunges, push-ups, pull-ups and jump squats, labelled bodyweight", () => {
      tab("today");
      const wid = w.eval("nextWorkoutId()");
      w.openAdd({ where: "plan", wid });
      const sheet = q(d, "#sheetB");
      const groups = [...sheet.querySelectorAll(".opt-grp")].map(g => g.textContent.trim());
      assert.strictEqual(groups[0], "Bodyweight", groups.slice(0, 3).join(" | "));
      const bwRows = []; let el = sheet.querySelector(".opt-grp").nextElementSibling;
      while (el && !el.classList.contains("opt-grp")) { bwRows.push(el); el = el.nextElementSibling; }
      const names = bwRows.map(b => b.querySelector("span").textContent.replace(/\s*in today\s*$/, "").trim());
      ["Reverse Lunge", "Walking Lunge (bodyweight)", "Push-Up", "Pull-Up", "Jump Squat", "Air Squat", "Chin-Up"].forEach(n => assert.ok(names.includes(n), n + " listed: " + names.join(", ")));
      bwRows.forEach(b => { const m = b.querySelector(".m").textContent; assert.ok(/bodyweight|\d+ lb/.test(m) && !/added weight/.test(m), m); });
      assert.ok(names.length === new Set(names).size, "no duplicates in the Bodyweight group");
      w.closeSheet();
    });
    t("adding a bodyweight move gives it a rep range that fits it (push-up 10–15, pull-up 5–10, lunge 8–12) and it sits in today's plan", () => {
      const wid = w.eval("nextWorkoutId()");
      const add = id => { w.openAdd({ where: "plan", wid }); click(w, q(d, '#sheetB .opt[data-a="add-do"][data-ex="' + id + '"]')); };
      add("pushup"); add("pullup"); add("bw_lunge"); add("jump_squat");
      const plan = JSON.parse(w.eval("JSON.stringify(planFor(" + JSON.stringify(wid) + ").items)"));
      const of = id => plan.filter(it => it.ex === id).pop();
      assert.deepStrictEqual([of("pushup").lo, of("pushup").hi], [10, 15]);
      assert.deepStrictEqual([of("pullup").lo, of("pullup").hi], [5, 10]);
      assert.deepStrictEqual([of("bw_lunge").lo, of("bw_lunge").hi], [8, 12]);
      assert.deepStrictEqual([of("jump_squat").lo, of("jump_squat").hi], [10, 15]);
      ["pushup", "pullup", "bw_lunge", "jump_squat"].forEach(id => assert.strictEqual(of(id).sets, 3, id + " 3 sets"));
      const txt = d.getElementById("app").textContent;
      ["Push-Up", "Pull-Up", "Reverse Lunge", "Jump Squat"].forEach(n => assert.ok(txt.includes(n), n + " on Today"));
      assert.ok(/Reverse Lunge\s*BW/.test(txt.replace(/\s+/g, " ")) || /Reverse Lunge.{0,40}BW/.test(txt.replace(/\s+/g, " ")), "a bodyweight move shows BW, not a weight");
    });
    t("the bodyweight circuits can draw the new moves", () => {
      const pool = JSON.parse(w.eval("JSON.stringify(POOLS.bw)"));
      assert.ok(pool.includes("bw_lunge") && pool.includes("bw_squat"), pool.join(","));
      assert.ok(JSON.parse(w.eval("JSON.stringify(POOLS.fullD)")).includes("bw_lunge_walk"));
    });
    t("no errors during the bodyweight pass", () => assert.deepStrictEqual(errors.map(String), [], errors.map(String).join(" | ")));
  } finally { dom.window.close(); }
}

/* ------------------------------------------------- v24: the 25 most common missing moves · shaded 3D figures */
function runV24Pass() {
  console.log("v24: 25 missing gym moves, pools refreshed in older programs, figures shaded as solids");
  const LIVE = JSON.parse(read("tests/fixtures/chalk-v1-live.json"));
  const S0 = JSON.parse(LIVE.nick); S0.active = null; const raw = JSON.stringify(S0);
  const { dom, w, d, errors } = boot({ real: true, store: { "chalk.v1": raw, "chalk.bak.d": "2000-01-01" } });
  const tab = name => click(w, q(d, '#tabs [data-tab="' + name + '"]'));
  const ex = id => JSON.parse(w.eval("JSON.stringify(getEx(" + JSON.stringify(id) + "))"));
  const NEW = ["db_fly", "dec_bench", "db_pullover", "assist_dip", "mc_row", "cg_pulldown", "back_ext", "sumo_dl", "good_morning", "hip_add", "lp_calf", "front_raise", "mc_lat_raise", "push_press", "bb_curl", "conc_curl", "rope_hammer", "db_kickback", "rope_pushdown", "crunch_floor", "situp", "leg_raise", "rev_crunch", "woodchop", "battle_rope"];
  try {
    t("exactly 25 new moves, each in the library with a figure, a known muscle, known equipment, a weight jump and a rest", () => {
      const ids = JSON.parse(w.eval("JSON.stringify(LIB_V24)"));
      assert.deepStrictEqual(ids, NEW);
      assert.strictEqual(new Set(ids).size, 25);
      const muscles = JSON.parse(w.eval("JSON.stringify(MUSCLES)"));
      ids.forEach(id => {
        assert.ok(w.eval("Object.prototype.hasOwnProperty.call(LIB," + JSON.stringify(id) + ")"), id + " is in LIB, not a custom fallback");
        const L = ex(id);
        assert.ok(muscles.includes(L.m), id + " muscle " + L.m);
        (L.s || []).forEach(m => assert.ok(muscles.includes(m), id + " secondary " + m));
        assert.ok(w.eval("!!TYPE_LABEL[" + JSON.stringify(L.t) + "]"), id + " equipment " + L.t);
        assert.ok(w.eval("!!PAT[getEx(" + JSON.stringify(id) + ").p]"), id + " has its own figure (" + L.p + ")");
        assert.ok(L.inc > 0 && L.rest > 0 && typeof L.n === "string" && L.n.length > 2, id + " inc / rest / name");
      });
      const names = ids.map(id => ex(id).n);
      ["Dumbbell Fly", "Decline Bench Press", "Sumo Deadlift", "Good Morning", "Barbell Curl", "Crunch", "Sit-Up", "Lying Leg Raise", "Cable Woodchop", "Battle Ropes", "Seated Machine Row", "Close-Grip Lat Pulldown"].forEach(n => assert.ok(names.includes(n), n));
      assert.strictEqual(new Set(names).size, 25, "25 different names");
      const all = Object.keys(JSON.parse(w.eval("JSON.stringify(LIB)")));
      assert.ok(all.length >= 140, "library size " + all.length);
    });
    t("every new move sits in at least one rotation pool, and the figures of the 25 are all different from one another where the move differs", () => {
      const POOLS = JSON.parse(w.eval("JSON.stringify(POOLS)"));
      const flat = new Set([].concat(...Object.values(POOLS)));
      NEW.forEach(id => assert.ok(flat.has(id), id + " is in a pool"));
      assert.ok(POOLS.pushMain.includes("dec_bench") && POOLS.legMain.includes("sumo_dl") && POOLS.hinge.includes("sumo_dl"), "heavy moves in the main-lift pools");
      assert.ok(POOLS.absM.includes("crunch_floor") && POOLS.athCoreBW.includes("leg_raise") && POOLS.coreHiit.includes("situp"), "floor core work in the abs, athletic and HIIT core pools");
      assert.ok(POOLS.ropes.includes("battle_rope") && !POOLS.bw.includes("battle_rope"), "battle ropes join the sweat blocks, never the bodyweight circuit");
      const sweat = JSON.parse(w.eval("JSON.stringify(hiitPool({ball:1,balance:0,box:1},'sweat'))"));
      assert.ok(sweat.includes("battle_rope"), "a sweat block can draw battle ropes");
      const figs = NEW.map(id => ex(id).p);
      assert.strictEqual(new Set(figs).size, NEW.length, "25 figures for 25 moves");
    });
    t("a program built before v24 is left byte for byte alone, yet its slots rotate through the new moves (the live pool is used, never the saved copy)", () => {
      const P = JSON.parse(w.eval("JSON.stringify(S.program)"));
      assert.deepStrictEqual(P, S0.program, "nothing in the saved program moved at boot");
      /* each saved copy is the first part of the pool it came from */
      const chest2 = JSON.parse(w.eval("JSON.stringify(S.program.workouts.PUSH.items[1].pool)"));
      assert.deepStrictEqual(JSON.parse(w.eval("JSON.stringify(livePool(" + JSON.stringify(chest2) + "))")), JSON.parse(w.eval("JSON.stringify(POOLS.chest2)")), "the chest accessory copy resolves to today's chest2 pool");
      assert.deepStrictEqual(JSON.parse(w.eval("JSON.stringify(livePool(['bench']))")), ["bench"], "a swapped one-move pool is never widened");
      assert.strictEqual(w.eval("poolMatch(['burpee','box_jump','zzz'])"), null, "a mixed HIIT copy matches nothing");
      const snap = w.eval("JSON.stringify(S.program)"), cyc = w.eval("JSON.stringify(S.cyc)");
      const seen = {};
      ["PULL", "PUSH", "LEGS", "ABS"].forEach(wid => { seen[wid] = new Set(); for (let c = 0; c < 14; c++) { w.eval("S.cyc[" + JSON.stringify(wid) + "]=" + c + "; rotateDay(" + JSON.stringify(wid) + ")"); JSON.parse(w.eval("JSON.stringify(S.program.workouts[" + JSON.stringify(wid) + "].items)")).forEach(it => { if (it.t !== "block") seen[wid].add(it.ex); }); } });
      ["db_fly", "db_pullover", "assist_dip", "rope_pushdown", "db_kickback", "mc_lat_raise", "front_raise", "push_press"].forEach(id => assert.ok(seen.PUSH.has(id), id + " comes round on push day: " + [...seen.PUSH].join(",")));
      ["bb_curl", "conc_curl", "rope_hammer", "cg_pulldown", "mc_row"].forEach(id => assert.ok(seen.PULL.has(id), id + " comes round on pull day"));
      ["good_morning", "back_ext", "lp_calf", "hip_add"].forEach(id => assert.ok(seen.LEGS.has(id), id + " comes round on leg day"));
      ["crunch_floor", "leg_raise", "rev_crunch", "woodchop", "situp"].forEach(id => assert.ok(seen.ABS.has(id), id + " comes round on abs"));
      /* main lifts never rotate */
      assert.ok(!seen.PUSH.has("dec_bench") && !seen.LEGS.has("sumo_dl"), "a main lift only changes at the 45-day check-in");
      JSON.parse(snap); w.eval("S.program=" + JSON.stringify(JSON.parse(snap)) + "; S.cyc=" + cyc + ";");
      assert.deepStrictEqual(JSON.parse(w.eval("JSON.stringify(S.program)")), S0.program);
    });
    t("Katerina's functional supersets and deep-core block rotate through the new moves too, and her save is untouched", () => {
      const K = JSON.parse(LIVE.kat); K.active = null;
      const { dom: d2, w: w2, errors: e2 } = boot({ real: true, store: { "chalk.v1": JSON.stringify(K), "chalk.bak.d": "2000-01-01" } });
      try {
        assert.deepStrictEqual(JSON.parse(w2.eval("JSON.stringify(S.program)")), K.program, "untouched at boot");
        const seen = new Set();
        ["LOWER", "UPPER", "FULL"].forEach(wid => { for (let c = 0; c < 14; c++) { w2.eval("S.cyc[" + JSON.stringify(wid) + "]=" + c + "; rotateDay(" + JSON.stringify(wid) + ")"); JSON.parse(w2.eval("JSON.stringify(S.program.workouts[" + JSON.stringify(wid) + "].items)")).forEach(it => { if (it.t === "block") it.moves.forEach(m => seen.add(m.ex)); else seen.add(it.ex); }); } });
        ["woodchop", "good_morning", "front_raise", "rope_pushdown", "bb_curl", "db_fly"].forEach(id => assert.ok(seen.has(id), id + " in Katerina's rotation: " + [...seen].join(",")));
        assert.deepStrictEqual(e2.map(String), []);
      } finally { d2.window.close(); }
    });
    t("the next regen and a fresh program use the new pools, so new moves rotate in", () => {
      const fresh = JSON.parse(w.eval("JSON.stringify(buildProgram('weights',{ball:1,balance:0,box:1},0,3,'hotel'))"));
      const pools = []; Object.values(fresh.workouts).forEach(W => W.items.forEach(it => { if (it.pool) pools.push(it.pool); }));
      const flat = new Set([].concat(...pools));
      ["db_fly", "bb_curl", "crunch_floor", "lp_calf", "mc_row"].forEach(id => assert.ok(flat.has(id), id));
    });
    t("battle ropes: timed, no weight, their own label, never on the hotel-gym or no-equipment day", () => {
      const L = ex("battle_rope");
      assert.strictEqual(L.t, "rope"); assert.strictEqual(L.u, "s"); assert.ok(L.r >= 20);
      assert.ok(w.eval("NOLOAD('rope')"), "no load");
      assert.strictEqual(w.eval("TYPE_LABEL.rope"), "battle ropes");
      assert.ok(!w.eval("gearOk('battle_rope','bw')") && !w.eval("gearOk('battle_rope','hotel')"), "not hotel gear");
      ["crunch_floor", "situp", "leg_raise", "rev_crunch", "back_ext"].forEach(id => assert.ok(w.eval("gearOk(" + JSON.stringify(id) + ",'bw')"), id + " works with no equipment"));
      ["mc_row", "cg_pulldown", "dec_bench", "sumo_dl", "woodchop", "rope_pushdown"].forEach(id => assert.ok(!w.eval("gearOk(" + JSON.stringify(id) + ",'hotel')"), id + " needs the real gym"));
    });
    t("Today → + Exercise lists the new moves under their muscle groups (and the floor core work under Bodyweight)", () => {
      tab("today");
      const wid = w.eval("nextWorkoutId()");
      w.openAdd({ where: "plan", wid });
      const sheet = q(d, "#sheetB");
      const names = [...sheet.querySelectorAll('.opt[data-a="add-do"] > span:first-child')].map(e => e.textContent.replace(/\s*in today\s*$/, "").trim());
      NEW.forEach(id => assert.ok(names.includes(ex(id).n), ex(id).n + " listed"));
      const bwRows = []; let el = sheet.querySelector(".opt-grp").nextElementSibling;
      while (el && !el.classList.contains("opt-grp")) { bwRows.push(el); el = el.nextElementSibling; }
      const bwNames = bwRows.map(b => b.querySelector("span").textContent.replace(/\s*in today\s*$/, "").trim());
      ["Crunch", "Sit-Up", "Lying Leg Raise", "Reverse Crunch", "Back Extension (45°)"].forEach(n => assert.ok(bwNames.includes(n), n + " under Bodyweight: " + bwNames.join(", ")));
      assert.ok(!bwNames.includes("Battle Ropes"), "battle ropes are not a bodyweight move");
      w.closeSheet();
    });
    t("adding them: crunch 13–20, sit-up 10–15, battle ropes 20–30 sec, decline bench 6–10, dumbbell fly 8–12; they sit in today's plan", () => {
      const wid = w.eval("nextWorkoutId()");
      const add = id => { w.openAdd({ where: "plan", wid }); click(w, q(d, '#sheetB .opt[data-a="add-do"][data-ex="' + id + '"]')); };
      ["crunch_floor", "situp", "battle_rope", "dec_bench", "db_fly"].forEach(add);
      const plan = JSON.parse(w.eval("JSON.stringify(planFor(" + JSON.stringify(wid) + ").items)"));
      const of = id => plan.filter(it => it.ex === id).pop();
      assert.deepStrictEqual([of("crunch_floor").lo, of("crunch_floor").hi], [13, 20]);
      assert.deepStrictEqual([of("situp").lo, of("situp").hi], [10, 15]);
      assert.deepStrictEqual([of("battle_rope").lo, of("battle_rope").hi], [20, 30]);
      assert.deepStrictEqual([of("dec_bench").lo, of("dec_bench").hi], [6, 10]);
      assert.deepStrictEqual([of("db_fly").lo, of("db_fly").hi], [8, 12]);
      const txt = d.getElementById("app").textContent.replace(/\s+/g, " ");
      ["Crunch", "Sit-Up", "Battle Ropes", "Decline Bench Press", "Dumbbell Fly"].forEach(n => assert.ok(txt.includes(n), n + " on Today"));
      assert.ok(/Battle Ropes.{0,80}sec/.test(txt), "battle ropes show seconds");
    });
    t("a first-time weight for a new move comes from a related lift (dumbbell fly from the bench, barbell curl from the EZ curl)", () => {
      const fly = JSON.parse(w.eval("JSON.stringify(plannedW('db_fly'))")), curl = JSON.parse(w.eval("JSON.stringify(plannedW('bb_curl'))"));
      assert.ok(fly.w == null || (fly.est && fly.w > 0), "fly: " + JSON.stringify(fly));
      assert.ok(curl.w == null || (curl.est && curl.w > 0), "curl: " + JSON.stringify(curl));
    });
    t("the figures are drawn as shaded solids: a gradient per part, a radial highlight on the head, a floor shadow (none when hanging)", () => {
      const sq = w.eval("animFrame(PAT.squat,0.5,'thigh','side')");
      assert.ok(/<defs>/.test(sq) && /radialGradient/.test(sq), "defs with the round-part highlight");
      assert.ok((sq.match(/linearGradient/g) || []).length >= 10, "a gradient across each limb and the torso");
      assert.ok(/class="sh"/.test(sq) && /class="shd"/.test(sq), "shade overlays and a floor shadow");
      assert.ok(/class="hd"/.test(sq) && /class="tq/.test(sq) && /class="lm/.test(sq), "the body parts are still there");
      const ids = sq.match(/id="([^"]+)"/g); assert.strictEqual(new Set(ids).size, ids.length, "gradient ids are unique within a frame");
      const sq2 = w.eval("animFrame(PAT.squat,0.5,'thigh','front')");
      const ids2 = sq2.match(/id="([^"]+)"/g); assert.ok(!ids.some(i => ids2.includes(i)), "the side and front views never share a gradient id");
      const pu = w.eval("animFrame(PAT.pullup,0.5,'torso','side')");
      assert.ok(!/class="shd"/.test(pu) && !/class="floor"/.test(pu), "no floor, no shadow while hanging");
      assert.ok(/class="shd"/.test(w.eval("animFrame(PAT.hpress,0.5,'torso','side')")), "a shadow under the bench press");
    });
    t("the new figures carry their gear: ropes, a knee pad, a chest pad, elbow pads, one dumbbell for the pullover and the concentration curl, a decline bench", () => {
      const fr = (p, v) => w.eval("animFrame(PAT." + p + ",0.5,'torso'," + JSON.stringify(v || "side") + ")");
      assert.ok((fr("battlerope").match(/<path class="cab"[^>]*d="M[^"]*C/g) || []).length === 2, "two rope curves");
      assert.ok(/class="fur"/.test(fr("assistdip")) && /class="fur"/.test(fr("mcrow")), "a knee pad, a seat and a chest pad");
      assert.ok((fr("mcrow").match(/stroke-width:9/g) || []).length >= 1, "the chest pad is a thick pad");
      assert.ok((fr("mclatraise").match(/stroke-width:[56]\.\d/g) || []).length === 2, "an elbow pad each side");
      const rings = s => (s.match(/class="eq"/g) || []).length;
      assert.strictEqual(rings(fr("pullover")), 2, "one dumbbell (two ends) for the pullover");
      assert.strictEqual(rings(fr("conccurl")), 2, "one dumbbell for the concentration curl");
      assert.strictEqual(rings(fr("dbfly")), 4, "two dumbbells for the fly");
      assert.ok((fr("decpress").match(/class="fur"/g) || []).length >= 3 && /stroke-width:9/.test(fr("decpress")), "a decline bench with a pad and posts");
      assert.ok(/class="fur"/.test(fr("backext")) && (fr("backext").match(/stroke-width:9/g) || []).length === 3 && /class="eq"/.test(fr("backext")), "a 45° pad and foot rollers");
      ["dbfly", "decpress", "pullover", "assistdip", "mcrow", "cgpull", "backext", "sumo", "goodmorning", "hipadd", "lpcalf", "frontraise", "mclatraise", "pushpress", "conccurl", "dbkick", "ropepush", "ropecurl", "crunchfloor", "situp", "legraise", "revcrunch", "woodchop", "battlerope"].forEach(p => {
        ["side", "front"].forEach(v => { const s = fr(p, v); assert.ok(/^<svg class="rig/.test(s) && /viewBox="[-\d.]+ [-\d.]+ [\d.]+ [\d.]+"/.test(s) && !/NaN/.test(s), p + " " + v + " draws"); });
      });
    });
    t("the body map is shaded too: a sweep across every part and a highlight on the head, both views, muscles still light up", () => {
      const f = w.eval("bodySVG(false,m=>m==='Chest'?'on':'')"), b = w.eval("bodySVG(true,m=>m==='Back'?'on':'')");
      [f, b].forEach(s => {
        assert.ok(/<defs>/.test(s) && /linearGradient/.test(s) && /radialGradient/.test(s));
        const sk = (s.match(/class="sk"/g) || []).length, mm = (s.match(/class="mm/g) || []).length, sh = (s.match(/class="sh"/g) || []).length;
        assert.strictEqual(sh, sk + mm, "one shade per skin and muscle path (the head and neck are skin): " + sh + " vs " + (sk + mm));
      });
      assert.ok(/class="mm on" data-m="Chest"/.test(f) && /class="mm on" data-m="Back"/.test(b), "the working muscle is on");
      const ids = (f + b).match(/id="([^"]+)"/g); assert.strictEqual(new Set(ids).size, ids.length, "front and back maps use different gradient ids");
    });
    t("every loaded move steps 5 lb: the +/− buttons, the Up jump and a deload, on barbell, machine and cable moves alike (a med ball keeps 2)", () => {
      ["deadlift", "leg_press", "cable_row", "lat_pulldown", "hip_thrust", "shrug", "calf_stand", "lp_calf", "sumo_dl", "db_curl", "bench"].forEach(id => assert.strictEqual(w.eval("stepOf(" + JSON.stringify(id) + ")"), 5, id));
      ["mb_slam", "wall_ball", "mb_twist"].forEach(id => assert.strictEqual(w.eval("stepOf(" + JSON.stringify(id) + ")"), 2, id));
      const incs = JSON.parse(w.eval("JSON.stringify(Object.keys(LIB).map(id=>LIB[id].inc))"));
      assert.ok(!incs.includes(10), "no 10-lb jump left in the library");
      /* an older custom move that still says 10 steps 5 too */
      w.eval("S.custom.c_old10=S.custom.c_old10||{n:'Old machine',m:'Back',t:'mc',inc:10,rest:75,guess:90,k:1,s:[],p:'cablerow'}");
      assert.strictEqual(w.eval("stepOf('c_old10')"), 5);
      /* progression: top of the range on every set -> +5; beaten by 3+ everywhere -> +10; deload lands on a 5 */
      const up = JSON.parse(w.eval("JSON.stringify(applyProgress({ex:'deadlift',sets:3,lo:6,hi:10},[{w:185,r:10},{w:185,r:10},{w:185,r:10}]))"));
      assert.deepStrictEqual([up.from, up.to, up.kind], [185, 190, "up"]);
      const big = JSON.parse(w.eval("JSON.stringify(applyProgress({ex:'leg_press',sets:3,lo:8,hi:12},[{w:270,r:15},{w:270,r:15},{w:270,r:16}]))"));
      assert.deepStrictEqual([big.from, big.to], [270, 280]);
      w.eval("exState('cable_row').miss=1");
      const down = JSON.parse(w.eval("JSON.stringify(applyProgress({ex:'cable_row',sets:3,lo:8,hi:12},[{w:115,r:6},{w:115,r:5},{w:115,r:5}]))"));
      assert.strictEqual(down.kind, "down"); assert.strictEqual(down.to % 5, 0, "deload to " + down.to); assert.ok(down.to <= 110);
      const mb = JSON.parse(w.eval("JSON.stringify(applyProgress({ex:'mb_slam',sets:3,lo:10,hi:15},[{w:12,r:15},{w:12,r:15},{w:12,r:15}]))"));
      assert.deepStrictEqual([mb.from, mb.to], [12, 14], "a med ball still moves 2 lb");
      /* a first-time estimate lands on a 5 */
      const est = JSON.parse(w.eval("JSON.stringify(convertWeight('cable_row',115,'lat_pulldown'))"));
      assert.strictEqual(est.how, "est"); assert.strictEqual(est.w % 5, 0);
      w.eval("delete S.custom.c_old10; delete S.ex.deadlift; delete S.ex.leg_press; delete S.ex.cable_row; delete S.ex.mb_slam");
    });
    t("in a workout the weight stepper moves a deadlift, a leg press and a cable row by 5, not 10; a new custom move is born with 5", () => {
      tab("today");
      const wid = w.eval("nextWorkoutId()");
      w.eval("S.active=null; startWorkout(" + JSON.stringify(wid) + ")");
      w.eval("S.active.items.unshift({t:'lift',id:'t_dl',ex:'deadlift',sets:3,lo:6,hi:10,done:[],skipped:false,draft:{w:185,r:8}},{t:'lift',id:'t_lp',ex:'leg_press',sets:3,lo:8,hi:12,done:[],skipped:false,draft:{w:270,r:10}}); render()");
      const val = i => Number(q(d, '#slot' + i + ' input[data-f="w"]').value);
      click(w, q(d, '#slot0 [data-a="w+"]')); assert.strictEqual(val(0), 190, "deadlift +5");
      click(w, q(d, '#slot0 [data-a="w-"]')); click(w, q(d, '#slot0 [data-a="w-"]')); assert.strictEqual(val(0), 180, "deadlift −5");
      click(w, q(d, '#slot1 [data-a="w+"]')); assert.strictEqual(val(1), 275, "leg press +5");
      click(w, q(d, '#slot1 [data-a="w-"]')); click(w, q(d, '#slot1 [data-a="w-"]')); assert.strictEqual(val(1), 265, "leg press −5");
      w.eval("discardWorkout()");
      w.openAdd({ where: "plan", wid });
      click(w, q(d, '#sheetB .opt[data-a="add-do"][data-ex="__new"]'));
      q(d, "#nxName").value = "Hammer high row"; q(d, "#nxT").value = "mc"; q(d, "#nxM").value = "Back";
      click(w, q(d, '#sheetB [data-a="add-do"][data-ex="__create"]'));
      const made = JSON.parse(w.eval("JSON.stringify(Object.values(S.custom).find(c=>c.n==='Hammer high row'))"));
      assert.ok(made && made.inc === 5 && made.t === "mc", JSON.stringify(made));
      w.eval("Object.keys(S.custom).forEach(k=>{ if(S.custom[k].n==='Hammer high row') delete S.custom[k]; }); S.plan=null; save()");
    });
    t("sw.js: version 24 everywhere", () => { assert.ok(APPV >= 24 && SWV >= 24, APPV + " / " + SWV); });
    t("no errors during the v24 pass", () => assert.deepStrictEqual(errors.map(String), [], errors.map(String).join(" | ")));
  } finally { dom.window.close(); }
}

/* ------------------------------------------------- v26: three more lunges (dumbbell forward, dumbbell reverse, barbell) */
function runV26Pass() {
  console.log("v26: dumbbell forward lunge, dumbbell reverse lunge, barbell lunge");
  const LIVE = JSON.parse(read("tests/fixtures/chalk-v1-live.json"));
  const S0 = JSON.parse(LIVE.nick); S0.active = null; const raw = JSON.stringify(S0);
  const { dom, w, d, errors } = boot({ real: true, store: { "chalk.v1": raw, "chalk.bak.d": "2000-01-01" } });
  const tab = name => click(w, q(d, '#tabs [data-tab="' + name + '"]'));
  const ex = id => JSON.parse(w.eval("JSON.stringify(getEx(" + JSON.stringify(id) + "))"));
  const NEW = ["db_lunge", "db_rev_lunge", "bb_lunge"];
  const NAMES = ["Dumbbell Forward Lunge", "Dumbbell Reverse Lunge", "Barbell Lunge"];
  try {
    t("exactly three new lunges, each in the library: a quad move, reps per side, a figure, a 5-lb step, a rest and a load factor", () => {
      const ids = JSON.parse(w.eval("JSON.stringify(LIB_V26)"));
      assert.deepStrictEqual(ids, NEW);
      assert.deepStrictEqual(ids.map(id => ex(id).n), NAMES);
      const all = JSON.parse(w.eval("JSON.stringify(Object.keys(LIB))"));
      assert.strictEqual(new Set(all.map(id => ex(id).n)).size, all.length, "no two moves share a name");
      ids.forEach(id => {
        assert.ok(w.eval("Object.prototype.hasOwnProperty.call(LIB," + JSON.stringify(id) + ")"), id + " is in LIB, not a custom fallback");
        const L = ex(id);
        assert.strictEqual(L.m, "Quads", id + " muscle");
        assert.ok(L.s.includes("Glutes") && L.s.includes("Hamstrings"), id + " secondary");
        assert.strictEqual(L.ea, true, id + " counts each side");
        assert.strictEqual(L.inc, 5, id + " steps 5 lb");
        assert.strictEqual(w.eval("stepOf(" + JSON.stringify(id) + ")"), 5);
        assert.ok(L.rest >= 60 && L.guess > 0 && L.k > 0, id + " rest / first weight / load factor");
        assert.ok(w.eval("!!PAT[getEx(" + JSON.stringify(id) + ").p]"), id + " has a figure (" + L.p + ")");
      });
      assert.strictEqual(ex("db_lunge").t, "db"); assert.strictEqual(ex("db_rev_lunge").t, "db"); assert.strictEqual(ex("bb_lunge").t, "bb");
      assert.strictEqual(w.eval("TYPE_LABEL[getEx('bb_lunge').t]"), "total on bar");
      assert.strictEqual(w.eval("TYPE_LABEL[getEx('db_lunge').t]"), "each hand");
    });
    t("the figures: the forward lunge steps forward with dumbbells, the reverse lunge steps the near leg back, the barbell lunge carries the bar on the back", () => {
      const P = JSON.parse(w.eval("JSON.stringify({f:PAT.lunge,r:PAT.revlunge,b:PAT.bblunge})"));
      assert.strictEqual(P.f.grip, "db"); assert.strictEqual(P.r.grip, "db"); assert.strictEqual(P.b.grip, "back");
      assert.ok(P.f.b.th > 0 && P.f.b.th2 < 0, "forward: near leg forward, far leg back");
      assert.ok(P.r.b.th < 0 && P.r.b.th2 > 0, "reverse: near leg back, far leg forward");
      assert.ok(P.b.b.th > 0 && P.b.b.th2 < 0 && P.b.a.f === P.b.b.f && P.b.a.f < -90, "barbell: steps forward, hands stay on the bar");
      const bwr = JSON.parse(w.eval("JSON.stringify(PAT[getEx('bw_lunge').p])"));
      assert.ok(!bwr.grip && bwr.b.th < 0 && bwr.b.th2 > 0, "the bodyweight Reverse Lunge now steps back too, holding nothing");
      const fr = (p, v) => w.eval("animFrame(PAT." + p + ",0.5,'thigh'," + JSON.stringify(v) + ")");
      const rings = s => (s.match(/class="eq"/g) || []).length;
      ["revlunge", "bblunge"].forEach(p => ["side", "front"].forEach(v => { const s = fr(p, v); assert.ok(/^<svg class="rig/.test(s) && /viewBox="[-\d.]+ [-\d.]+ [\d.]+ [\d.]+"/.test(s) && !/NaN/.test(s) && /class="shd"/.test(s), p + " " + v + " draws with a floor shadow"); }));
      assert.strictEqual(rings(fr("revlunge", "side")), 4, "two dumbbells on the reverse lunge");
      assert.strictEqual(rings(fr("lunge", "side")), 4, "two dumbbells on the forward lunge");
      assert.strictEqual(rings(fr("bblunge", "side")), rings(fr("squat", "side")), "the same bar and plates as the back squat on the barbell lunge");
      assert.ok(rings(fr("bblunge", "side")) >= 2, "plates drawn");
    });
    t("every new lunge sits in a rotation pool, only at the end of it, and the barbell one never reaches the hotel-gym or no-equipment day", () => {
      const POOLS = JSON.parse(w.eval("JSON.stringify(POOLS)"));
      const flat = new Set([].concat(...Object.values(POOLS)));
      NEW.forEach(id => assert.ok(flat.has(id), id + " is in a pool"));
      assert.deepStrictEqual(POOLS.unilateral.slice(-3), NEW, "leg day's one-leg slot ends with the three");
      assert.ok(POOLS.quad2[POOLS.quad2.length - 1] === "bb_lunge", "the barbell lunge joins the quad accessories");
      assert.deepStrictEqual(POOLS.athLunge.slice(-2), ["db_lunge", "db_rev_lunge"], "the dumbbell lunges join the Athletic day's lunge slot");
      assert.ok(!POOLS.athLunge.includes("bb_lunge") && !POOLS.athLungeBW.includes("bb_lunge") && !POOLS.athLungeBW.includes("db_lunge") && !POOLS.bw.includes("db_lunge"), "no barbell on the Athletic day, no dumbbells on the no-equipment day");
      assert.ok(POOLS.fullA.includes("db_lunge") && POOLS.fullD.includes("db_rev_lunge") && POOLS.dbHiit.includes("db_rev_lunge"), "Katerina's full-body supersets and the HIIT dumbbell block can draw them");
      Object.keys(POOLS).forEach(k => { const P = POOLS[k]; const i = Math.min(...NEW.map(id => P.indexOf(id)).filter(i => i >= 0).concat([P.length])); assert.ok(P.slice(i).every(id => NEW.includes(id)), k + ": new moves only at the end: " + P.join(",")); });
      assert.ok(w.eval("gearOk('db_lunge','hotel') && gearOk('db_rev_lunge','hotel')"), "dumbbell lunges fit a hotel gym");
      assert.ok(!w.eval("gearOk('bb_lunge','hotel') || gearOk('bb_lunge','bw') || gearOk('db_lunge','bw')"), "barbell needs the real gym; dumbbells aren't 'no equipment'");
    });
    t("a program built before v26 is left byte for byte alone at boot, yet leg day's one-leg slot rotates through the three", () => {
      assert.deepStrictEqual(JSON.parse(w.eval("JSON.stringify(S.program)")), S0.program, "nothing in the saved program moved at boot");
      const snap = w.eval("JSON.stringify(S.program)"), cyc = w.eval("JSON.stringify(S.cyc)");
      const seen = new Set();
      for (let c = 0; c < 16; c++) { w.eval("S.cyc.LEGS=" + c + "; rotateDay('LEGS')"); JSON.parse(w.eval("JSON.stringify(S.program.workouts.LEGS.items)")).forEach(it => { if (it.t !== "block") seen.add(it.ex); }); }
      NEW.forEach(id => assert.ok(seen.has(id), id + " comes round on leg day: " + [...seen].join(",")));
      w.eval("S.program=" + JSON.stringify(JSON.parse(snap)) + "; S.cyc=" + cyc + ";");
      assert.deepStrictEqual(JSON.parse(w.eval("JSON.stringify(S.program)")), S0.program);
    });
    t("Katerina's lower-body and full-body supersets rotate through them too, and her save is untouched", () => {
      const K = JSON.parse(LIVE.kat); K.active = null;
      const { dom: d2, w: w2, errors: e2 } = boot({ real: true, store: { "chalk.v1": JSON.stringify(K), "chalk.bak.d": "2000-01-01" } });
      try {
        assert.deepStrictEqual(JSON.parse(w2.eval("JSON.stringify(S.program)")), K.program, "untouched at boot");
        const seen = new Set();
        ["LOWER", "FULL"].forEach(wid => { for (let c = 0; c < 16; c++) { w2.eval("S.cyc[" + JSON.stringify(wid) + "]=" + c + "; rotateDay(" + JSON.stringify(wid) + ")"); JSON.parse(w2.eval("JSON.stringify(S.program.workouts[" + JSON.stringify(wid) + "].items)")).forEach(it => { if (it.t === "block") it.moves.forEach(m => seen.add(m.ex)); else seen.add(it.ex); }); } });
        NEW.forEach(id => assert.ok(seen.has(id), id + " in Katerina's rotation: " + [...seen].join(",")));
        assert.deepStrictEqual(e2.map(String), []);
      } finally { d2.window.close(); }
    });
    t("a fresh program and the 4th (Athletic) day draw them: barbell on leg day, dumbbells on the hotel-gym day, none on the no-equipment day", () => {
      const fresh = JSON.parse(w.eval("JSON.stringify(buildProgram('weights',{ball:1,balance:0,box:1},0,4,'hotel'))"));
      const of = wid => { const out = new Set(); fresh.workouts[wid].items.forEach(it => { if (it.pool) it.pool.forEach(x => out.add(x)); }); return out; };
      NEW.forEach(id => assert.ok(of("LEGS").has(id), id + " on leg day"));
      assert.ok(of("ATHL").has("db_lunge") && of("ATHL").has("db_rev_lunge") && !of("ATHL").has("bb_lunge"), "hotel-gym Athletic day");
      const bw = JSON.parse(w.eval("JSON.stringify(athleticDay({ball:1,balance:0,box:1},'bw'))"));
      const bwIds = new Set(); bw.items.forEach(it => { if (it.pool) it.pool.forEach(x => bwIds.add(x)); if (it.pools) it.pools.forEach(p => p.forEach(x => bwIds.add(x))); });
      NEW.forEach(id => assert.ok(!bwIds.has(id), id + " never on the no-equipment day"));
    });
    t("Today → + Exercise lists the three under Quads (never under Bodyweight); adding one gives 8–12 reps × 3 sets, each side, and it sits in today's plan", () => {
      tab("today");
      const wid = w.eval("nextWorkoutId()");
      w.openAdd({ where: "plan", wid });
      const sheet = q(d, "#sheetB");
      const names = [...sheet.querySelectorAll('.opt[data-a="add-do"] > span:first-child')].map(e => e.textContent.replace(/\s*in today\s*$/, "").trim());
      NAMES.forEach(n => assert.ok(names.includes(n), n + " listed"));
      const bwRows = []; let el = sheet.querySelector(".opt-grp").nextElementSibling;
      while (el && !el.classList.contains("opt-grp")) { bwRows.push(el); el = el.nextElementSibling; }
      const bwNames = bwRows.map(b => b.querySelector("span").textContent.replace(/\s*in today\s*$/, "").trim());
      NAMES.forEach(n => assert.ok(!bwNames.includes(n), n + " is not a bodyweight move"));
      assert.ok(bwNames.includes("Reverse Lunge"), "the bodyweight reverse lunge is still there");
      const row = id => sheet.querySelector('.opt[data-a="add-do"][data-ex="' + id + '"] .m').textContent;
      assert.ok(/each hand|\d+ lb/.test(row("db_lunge")) && /total on bar|\d+ lb/.test(row("bb_lunge")), row("db_lunge") + " / " + row("bb_lunge"));
      w.closeSheet();
      const add = id => { w.openAdd({ where: "plan", wid }); click(w, q(d, '#sheetB .opt[data-a="add-do"][data-ex="' + id + '"]')); };
      NEW.forEach(add);
      const plan = JSON.parse(w.eval("JSON.stringify(planFor(" + JSON.stringify(wid) + ").items)"));
      const of = id => plan.filter(it => it.ex === id).pop();
      NEW.forEach(id => { assert.deepStrictEqual([of(id).sets, of(id).lo, of(id).hi], [3, 8, 12], id); });
      const txt = d.getElementById("app").textContent.replace(/\s+/g, " ");
      NAMES.forEach(n => assert.ok(txt.includes(n), n + " on Today"));
      assert.ok(/Barbell Lunge.{0,80}each side/.test(txt) && /Dumbbell Reverse Lunge.{0,80}each side/.test(txt), "shown as each side");
      w.eval("S.plan=null; save()");
    });
    t("a first-time weight comes from a related leg lift and lands on a 5: the dumbbell lunges from the split squat / goblet, the barbell lunge from the squat", () => {
      const est = (a, wt, b) => JSON.parse(w.eval("JSON.stringify(convertWeight(" + JSON.stringify(a) + "," + wt + "," + JSON.stringify(b) + "))"));
      const e1 = est("squat", 185, "bb_lunge"); assert.strictEqual(e1.how, "est"); assert.ok(e1.w % 5 === 0 && e1.w >= 75 && e1.w <= 115, "barbell lunge from a 185 squat: " + e1.w);
      const e2 = est("split_squat", 30, "db_rev_lunge"); assert.strictEqual(e2.how, "est"); assert.ok(e2.w % 5 === 0 && e2.w >= 15 && e2.w <= 30, "reverse lunge from a 30 split squat: " + e2.w);
      const e3 = est("goblet_squat", 50, "db_lunge"); assert.strictEqual(e3.how, "est"); assert.ok(e3.w % 5 === 0 && e3.w >= 15 && e3.w <= 35, "forward lunge from a 50 goblet: " + e3.w);
      NEW.forEach(id => { const p = JSON.parse(w.eval("JSON.stringify(plannedW(" + JSON.stringify(id) + "))")); assert.ok(p.w == null || p.w > 0, id + ": " + JSON.stringify(p)); });
    });
    t("sw.js: version 26 everywhere", () => { assert.ok(APPV >= 26 && SWV >= 26, APPV + " / " + SWV); });
    t("no errors during the v26 pass", () => assert.deepStrictEqual(errors.map(String), [], errors.map(String).join(" | ")));
  } finally { dom.window.close(); }
}

/* ------------------------------------------------- v27: joints move the way a body can · a turned camera with perspective */
function runV27Pass() {
  console.log("v27: shortest-arc joints, vertical forearms on every press, three-part moves, turned camera + perspective");
  const LIVE = JSON.parse(read("tests/fixtures/chalk-v1-live.json"));
  const S0 = JSON.parse(LIVE.nick); S0.active = null; const raw = JSON.stringify(S0);
  const { dom, w, errors } = boot({ real: true, store: { "chalk.v1": raw, "chalk.bak.d": "2000-01-01" } });
  const dirs = (p, t) => JSON.parse(w.eval("JSON.stringify(rigJoints(PAT." + p + ",poseAt(PAT." + p + "," + t + "),'side').D)"));
  const ang = (A, B) => Math.acos(Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2]))) * 180 / Math.PI;
  const elbow = (D, far) => 180 - ang(far ? D.U2 : D.U, far ? D.F2 : D.F), knee = (D, far) => 180 - ang(far ? D.T2 : D.T, far ? D.S2 : D.S);
  const hand = (p, t) => { const J = JSON.parse(w.eval("JSON.stringify((()=>{ const J=rigJoints(PAT." + p + ",poseAt(PAT." + p + "," + t + "),'side'); return {h:J.arm[2],e:J.arm[1],s:J.arm[0]}; })())")); return J; };
  try {
    t("the close-grip bench and the Arnold press have figures of their own; every press, the pulldown, the pull-up and the skull crusher were rebuilt", () => {
      assert.strictEqual(w.eval("getEx('cg_bench').p"), "cgpress");
      assert.strictEqual(w.eval("getEx('arnold').p"), "arnold");
      assert.strictEqual(w.eval("getEx('bench').p"), "hpress");
      ["hpress", "cgpress", "hpressdb", "ipress", "ipressbar", "decpress", "floorpress", "chestpress", "opress", "opressdb", "arnold", "mcpress", "skull", "dbfly", "thruster", "jump", "upright", "snatch", "pushpress"].forEach(p => assert.ok(w.eval("!!(PAT." + p + "&&PAT." + p + ".m)"), p + " is a three-part move (a → m → b)"));
      assert.ok(w.eval("PAT.arnold.a.u<60 && PAT.arnold.a.ua<20 && PAT.arnold.m.ua>50 && PAT.arnold.b.u===180"), "Arnold: bells in front, elbows swing out, then overhead");
    });
    t("bench press: the forearms stay vertical, the elbows start out to the sides and below the bench, the arms lock out straight up, and the hands never slide along the bar", () => {
      const z0 = hand("hpress", 0).h[2];
      for (let i = 0; i <= 20; i++) { const t = i / 20, D = dirs("hpress", t), H = hand("hpress", t);
        assert.ok(D.F[1] > 0.85, "t=" + t + " forearm points up (" + D.F[1].toFixed(2) + ")");
        assert.ok(Math.abs(H.h[2] - z0) < 7, "t=" + t + " grip width held: " + H.h[2].toFixed(1) + " vs " + z0.toFixed(1));
        assert.ok(elbow(D) >= 50 && elbow(D) <= 181, "t=" + t + " elbow " + elbow(D).toFixed(0) + "°");
        assert.ok(H.h[1] >= H.e[1] - 1, "t=" + t + " the hand is above the elbow");
      }
      const D0 = dirs("hpress", 0), D1 = dirs("hpress", 1);
      assert.ok(D0.U[1] < -0.3 && D0.U[2] > 0.7, "bottom: upper arm out and below the bench " + JSON.stringify(D0.U));
      assert.ok(D1.U[1] > 0.8 && D1.F[1] > 0.8 && elbow(D1) > 170, "top: straight up");
      assert.ok(hand("hpress", 1).h[1] - hand("hpress", 0).h[1] > 40, "the bar rises");
      ["cgpress", "hpressdb", "floorpress"].forEach(p => { for (let i = 0; i <= 20; i++) { const D = dirs(p, i / 20); assert.ok(D.F[1] > 0.8, p + " forearm up at t=" + i / 20); } });
      ["ipress", "ipressbar", "decpress"].forEach(p => { for (let i = 0; i <= 20; i++) { const D = dirs(p, i / 20); assert.ok(elbow(D) >= 55, p + " elbow " + elbow(D).toFixed(0) + " at t=" + i / 20); } });
    });
    t("no elbow or knee ever folds past what a body can do, and no limb jumps between frames — every pattern, every phase", () => {
      const names = JSON.parse(w.eval("JSON.stringify(Object.keys(PAT))"));
      assert.ok(names.length >= 110, names.length + " patterns");
      const bad = [];
      names.forEach(p => { let prev = null; for (let i = 0; i <= 40; i++) { const t = i / 40, D = dirs(p, t);
        [["elbow", elbow(D)], ["elbow2", elbow(D, 1)], ["knee", knee(D)], ["knee2", knee(D, 1)]].forEach(([n, a]) => { if (a < 12) bad.push(p + " t=" + t.toFixed(2) + " " + n + " " + a.toFixed(0) + "°"); });
        if (prev) ["U", "F", "U2", "F2", "T", "S", "T2", "S2"].forEach(k => { const d = ang(prev[k], D[k]); if (d > 14) bad.push(p + " t=" + t.toFixed(2) + " " + k + " jumps " + d.toFixed(0) + "°"); });
        prev = D; } });
      assert.deepStrictEqual(bad, []);
    });
    t("the forearm takes the short way round: the skull crusher never dips below the bench, the overhead extension never swings through the face, the chest pass never swings through the floor", () => {
      for (let i = 0; i <= 20; i++) { const t = i / 20;
        { const H = hand("skull", t); assert.ok(H.h[1] > 8 && H.h[0] < 0, "skull t=" + t + " the bar stays above the face, toward the head: " + JSON.stringify(H.h)); assert.ok(dirs("skull", t).U[1] > 0.9, "skull t=" + t + " upper arms stay vertical"); }
        assert.ok(dirs("ohext", t).F[0] < 0.25, "ohext t=" + t);
        assert.ok(dirs("chestpass", t).F[1] > -0.2, "chestpass t=" + t);
        assert.ok(dirs("facepull", t).F[1] > -0.5, "facepull t=" + t); }
    });
    t("a forearm or shin can have its own abduction (fa / sa), the far side copies the near side, and a mid pose is hit exactly at t = 0.5", () => {
      const fp = JSON.parse(w.eval("JSON.stringify(fullPose({u:30,ua:54,f:180,fa:0,th:10,ta:20}))"));
      assert.deepStrictEqual([fp.fa, fp.fa2, fp.ua2, fp.sa, fp.sa2, fp.u2, fp.f2], [0, 0, 54, 20, 20, 30, 180]);
      const fp2 = JSON.parse(w.eval("JSON.stringify(fullPose({u:30,ua:54,f:180}))"));
      assert.deepStrictEqual([fp2.fa, fp2.fa2], [54, 54], "no fa: the forearm keeps the upper arm's abduction");
      const mid = JSON.parse(w.eval("JSON.stringify((()=>{ const p=poseAt(PAT.arnold,0.5); return [p.u,p.ua,p.f,p.fa]; })())"));
      assert.deepStrictEqual(mid, [w.eval("PAT.arnold.m.u"), w.eval("PAT.arnold.m.ua"), w.eval("PAT.arnold.m.f"), w.eval("PAT.arnold.m.fa")]);
      const D = JSON.parse(w.eval("JSON.stringify(limbDirs({u:0,ua:0,f:180,fa:0}))"));
      assert.ok(Math.abs(D.F[1] - 1) < 1e-9 && Math.abs(D.U[1] + 1) < 1e-9, "f 180 / fa 0 is straight up");
      const S = JSON.parse(w.eval("JSON.stringify(slerp([1,0,0],[0,1,0],0.5,[0,0,1]))"));
      assert.ok(Math.abs(S[0] - Math.SQRT1_2) < 1e-6 && Math.abs(S[1] - Math.SQRT1_2) < 1e-6, "slerp halfway");
      assert.deepStrictEqual(JSON.parse(w.eval("JSON.stringify(slerp([1,0,0],[-1,0,0],0.5,[0,0,1]))")), [0, 0, 1], "antipodal falls back to the hint");
    });
    t("the camera is turned a little and has perspective: the far arm peeks out in the side view, the near bar plate draws bigger than the far one, benches are real boxes", () => {
      assert.ok(w.eval("VIEW.side[1]<-0.1 && VIEW.side[1]>-0.5 && VIEW.front[0]>0.1 && VIEW.front[0]<0.5"), "both views are off-axis");
      const sv = w.eval("animFrame(PAT.hpress,1,'torso','side')");
      const rs = [...sv.matchAll(/<circle class="eq" cx="[-\d.]+" cy="[-\d.]+" r="([\d.]+)"\/>/g)].map(m => +m[1]).filter(r => r > 10);
      assert.strictEqual(rs.length, 2, "two plates");
      assert.ok(Math.abs(rs[0] - rs[1]) > 1.5 && Math.abs(rs[0] - rs[1]) < 6, "plates differ by perspective: " + rs.join(" / "));
      const fur = (sv.match(/<polygon class="fur"/g) || []).length; assert.ok(fur >= 9 && fur % 3 === 0, "three faces per box: " + fur);
      const pts = JSON.parse(w.eval("JSON.stringify(rigPoints(PAT.squat,0,'side'))"));
      assert.ok(Math.abs(pts.arm[1][0] - pts.arm2[1][0]) > 4, "the far elbow is offset from the near one in the side view");
    });
    t("sw.js: version 27 everywhere", () => { assert.ok(APPV >= 27 && SWV >= 27, APPV + " / " + SWV); });
    t("no errors during the v27 pass", () => assert.deepStrictEqual(errors.map(String), [], errors.map(String).join(" | ")));
  } finally { dom.window.close(); }
}

/* ------------------------------------------------- v28: more on push and pull days · moderately more rotation */
function runV28Pass() {
  console.log("v28: push day +1–2, pull day +1, coprime rotation strides, one-time patch of an older program");
  const LIVE = JSON.parse(read("tests/fixtures/chalk-v1-live.json")), OLD = JSON.parse(read("tests/fixtures/chalk-v1-live-v27.json"));
  t("a fresh Weights program: push day has nine moves (the last every other session), pull day eight; HIIT and Functional days are as they were", () => {
    const { dom, w } = boot({ real: true, store: {} });
    try {
      const P = JSON.parse(w.eval("JSON.stringify(buildProgram('weights',{ball:1,balance:0,box:1},0,3,'hotel'))"));
      assert.strictEqual(P.ver, 6);
      assert.strictEqual(P.workouts.PUSH.items.length, 9); assert.strictEqual(P.workouts.PULL.items.length, 8); assert.strictEqual(P.workouts.LEGS.items.length, 7);
      const px = P.workouts.PUSH.items.slice(-2), pl = P.workouts.PULL.items.slice(-1)[0];
      assert.deepStrictEqual(px[0].pool, JSON.parse(w.eval("JSON.stringify(POOLS.chestIso)"))); assert.ok(!px[0].alt);
      assert.deepStrictEqual(px[1].pool, JSON.parse(w.eval("JSON.stringify(POOLS.pushX)"))); assert.strictEqual(px[1].alt, 2);
      assert.deepStrictEqual(pl.pool, JSON.parse(w.eval("JSON.stringify(POOLS.lat2)"))); assert.ok(!pl.alt);
      [px[0], px[1], pl].forEach(it => { assert.ok(it.rot && it.sets === 3 && it.lo >= 8 && it.hi >= 12, JSON.stringify(it)); assert.ok(it.pool.includes(it.ex)); });
      const ids = P.workouts.PUSH.items.map(it => it.ex); assert.strictEqual(new Set(ids).size, ids.length, "no move twice on push day: " + ids.join(","));
      const H = JSON.parse(w.eval("JSON.stringify(buildProgram('hiit',{ball:1,balance:0,box:1},0,3,'hotel'))"));
      assert.strictEqual(H.workouts.PUSH.items.filter(it => it.t === "lift").length, 3); assert.strictEqual(H.workouts.PULL.items.filter(it => it.t === "lift").length, 3);
      const F = JSON.parse(w.eval("JSON.stringify(buildProgram('functional',{ball:3,balance:3,box:2},0,4,'hotel'))"));
      assert.deepStrictEqual(F.order, ["LOWER", "UPPER", "FULL", "ATHL"]); assert.strictEqual(F.workouts.UPPER.items.length, 5);
      assert.ok(!F.workouts.ATHL.items.some(it => it.alt || it.x28), "the Athletic day is untouched");
    } finally { dom.window.close(); }
  });
  t("Nick's pre-v28 save: boot adds the three moves at the end of his push and pull days (and to the day already planned), bumps the program once, and changes nothing else; Katerina's save is untouched", () => {
    const S0 = JSON.parse(OLD.nick), K0 = OLD.kat;
    const { dom, w, errors } = boot({ real: true, store: { "chalk.v1": OLD.nick, "chalk.bak.d": "2000-01-01" } });
    try {
      const S1 = JSON.parse(w.localStorage.getItem("chalk.v1"));
      assert.strictEqual(S1.program.ver, 6); assert.strictEqual(S1.program.rev, S0.program.rev + 1);
      assert.strictEqual(S1.program.workouts.PUSH.items.length, S0.program.workouts.PUSH.items.length + 2);
      assert.strictEqual(S1.program.workouts.PULL.items.length, S0.program.workouts.PULL.items.length + 1);
      const added = ["PUSH", "PULL"].map(k => S1.program.workouts[k].items.filter(it => it.x28));
      assert.deepStrictEqual(added.map(a => a.length), [2, 1]);
      assert.ok(added[0][1].alt === 2 && !added[0][0].alt && !added[1][0].alt);
      added.flat().forEach(it => assert.ok(it.id && it.rot && it.pool.includes(it.ex), JSON.stringify(it)));
      /* strip what v28 added and the two numbers it bumped: the rest of the program is byte for byte the old one */
      const strip = P => { const c = JSON.parse(JSON.stringify(P)); ["PUSH", "PULL"].forEach(k => { c.workouts[k].items = c.workouts[k].items.filter(it => !it.x28); }); delete c.ver; delete c.rev; return c; };
      const old = JSON.parse(JSON.stringify(S0.program)); delete old.ver; delete old.rev;
      assert.deepStrictEqual(strip(S1.program), old);
      /* today's plan kept its items and gained the new pull move before the abs */
      assert.strictEqual(S1.plan.wid, S0.plan.wid); assert.strictEqual(S1.plan.rev, S1.program.rev);
      const oldIds = S0.plan.items.map(it => it.id), newIds = S1.plan.items.map(it => it.id);
      assert.deepStrictEqual(newIds.filter(id => oldIds.includes(id)), oldIds, "every planned item is still there, in order");
      const extra = S1.plan.items.filter(it => !oldIds.includes(it.id)); assert.strictEqual(extra.length, S1.plan.wid === "PUSH" ? 2 : 1);
      const absAt = S1.plan.items.findIndex(it => it.abs); if (absAt >= 0) extra.forEach(it => assert.ok(S1.plan.items.indexOf(it) < absAt, "before the abs"));
      /* nothing else moved */
      const a = JSON.parse(JSON.stringify(S0)), b = JSON.parse(JSON.stringify(S1)); [a, b].forEach(x => { delete x.program; delete x.plan; delete x.updatedAt; });
      assert.deepStrictEqual(b, a);
      assert.deepStrictEqual(errors.map(String), []);
      /* the save on the phone now (the migrated fixture) has the same shape as what this boot produced (ids differ: uid), and a second boot leaves it alone */
      const L1 = JSON.parse(LIVE.nick); const shape = S => JSON.stringify(["PUSH", "PULL"].map(k => S.program.workouts[k].items.map(it => [it.ex, it.pool, it.alt || 0, it.x28 || 0]))) + S.program.ver + S.program.rev + S.plan.rev;
      assert.strictEqual(shape(L1), shape(S1));
    } finally { dom.window.close(); }
    const { dom: d2, w: w2 } = boot({ real: true, store: { "chalk.v1": K0, "chalk.bak.d": "2000-01-01" } });
    try { assert.strictEqual(w2.localStorage.getItem("chalk.v1"), K0, "Katerina's functional program is not a weights program: untouched"); assert.strictEqual(JSON.parse(K0).program.ver, 5); }
    finally { d2.window.close(); }
  });
  t("the every-other-session push move: on the plan one session, off the next; the Settings editor labels it", () => {
    const S0 = JSON.parse(LIVE.nick); S0.active = null; S0.plan = null;
    const { dom, w, d } = boot({ real: true, store: { "chalk.v1": JSON.stringify(S0), "chalk.bak.d": "2000-01-01" } });
    try {
      const lifts = c => { w.eval("S.cyc.PUSH=" + c + "; S.plan=null"); return JSON.parse(w.eval("JSON.stringify(planFor('PUSH').items.filter(it=>!it.abs).map(it=>it.ex))")); };
      const on = lifts(0), off = lifts(1), on2 = lifts(2);
      assert.strictEqual(on.length, 9); assert.strictEqual(off.length, 8); assert.strictEqual(on2.length, 9);
      assert.strictEqual(new Set(on).size, 9, "no move twice: " + on.join(","));
      w.eval("S.cyc.PUSH=1; S.plan=null;");
      click(w, q(d, '#tabs [data-tab="settings"]'));
      const txt = d.getElementById("app").textContent;
      assert.ok(/every other session/.test(txt), "the editor says which move is every other session");
      assert.strictEqual((txt.match(/every other session/g) || []).length, 1);
    } finally { dom.window.close(); }
  });
  t("rotation: every pool still comes fully round, but with a coprime stride so neighbours change partners; small pools step one at a time", () => {
    const { dom, w } = boot({ real: true, store: {} });
    try {
      const gcd = (a, b) => b ? gcd(b, a % b) : a;
      for (let n = 2; n <= 20; n++) { const st = w.eval("stride(" + n + ")"); assert.ok(st >= 1 && st < Math.max(2, n) && gcd(st, n) === 1, "stride(" + n + ")=" + st); if (n < 5) assert.strictEqual(st, 1); else assert.ok(st > 1, "stride(" + n + ") moves more than one"); }
      assert.strictEqual(w.eval("stride(10)"), 7); assert.strictEqual(w.eval("stride(6)"), 5); assert.strictEqual(w.eval("stride(8)"), 5);
      /* the two biceps slots on a fresh pull day, 10 sessions: all ten curls appear, never the same curl twice in a day, and the two are not just pool neighbours */
      w.eval("S.profile='nick'; S.program=buildProgram('weights',{ball:1,balance:0,box:1},0,3,'hotel'); S.cyc={}; rotateAll();");
      const bi = JSON.parse(w.eval("JSON.stringify(POOLS.bi)"));
      const seen = new Set(); let adjacent = 0;
      for (let c = 0; c < bi.length; c++) { w.eval("S.cyc.PULL=" + c + "; rotateDay('PULL')"); const ex = JSON.parse(w.eval("JSON.stringify(S.program.workouts.PULL.items.filter(it=>it.pool&&it.pool.length===" + bi.length + "&&it.pool[0]==='db_curl').map(it=>it.ex))"));
        assert.strictEqual(ex.length, 2); assert.notStrictEqual(ex[0], ex[1]); ex.forEach(e => seen.add(e)); if (Math.abs(bi.indexOf(ex[0]) - bi.indexOf(ex[1])) === 1) adjacent++; }
      assert.strictEqual(seen.size, bi.length, "all " + bi.length + " curls came round");
      assert.ok(adjacent <= 3, "pool neighbours paired together in only " + adjacent + " of " + bi.length + " sessions");
      /* a pool of three (traps) still goes 0,1,2 */
      const tr = []; for (let c = 0; c < 3; c++) { w.eval("S.cyc.PULL=" + c + "; rotateDay('PULL')"); tr.push(w.eval("S.program.workouts.PULL.items.find(it=>it.pool&&it.pool[0]==='shrug').ex")); }
      assert.deepStrictEqual(tr, JSON.parse(w.eval("JSON.stringify(POOLS.traps)")));
    } finally { dom.window.close(); }
  });
  t("sw.js: version 28 everywhere", () => { assert.ok(APPV >= 28 && SWV >= 28, APPV + " / " + SWV); });
}

runPass("pass 1: stub M.ui (integration wiring)", false);
const realFiles = ["m-ui.js", "m-trends.js"].filter(exists);
if (realFiles.length) runPass("pass 2: real " + realFiles.join(" + ") + (realFiles.length < 2 ? " (stub fills the rest)" : ""), true);
else console.log("pass 2 skipped: m-ui.js / m-trends.js not present yet");
runLiveDataPass();
runPlanStashPass();
runReplacePass();
runNarrowPass();
runFourDayPass();
runBodyweightPass();
runV24Pass();
runV27Pass();
runV28Pass();
runV26Pass();

(async () => {
  await runSwPass();
  await runDraftPass();
  if (realFiles.length === 2) await runF6Pass();
  if (realFiles.length === 2 && exists("m-sync.js")) await runSyncPass();
  else console.log("pass 3 skipped: needs m-ui.js, m-trends.js and m-sync.js");
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
