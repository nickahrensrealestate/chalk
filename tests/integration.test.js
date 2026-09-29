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

runPass("pass 1: stub M.ui (integration wiring)", false);
const realFiles = ["m-ui.js", "m-trends.js"].filter(exists);
if (realFiles.length) runPass("pass 2: real " + realFiles.join(" + ") + (realFiles.length < 2 ? " (stub fills the rest)" : ""), true);
else console.log("pass 2 skipped: m-ui.js / m-trends.js not present yet");
runLiveDataPass();
runPlanStashPass();
runReplacePass();
runNarrowPass();

(async () => {
  await runSwPass();
  await runDraftPass();
  if (realFiles.length === 2) await runF6Pass();
  if (realFiles.length === 2 && exists("m-sync.js")) await runSyncPass();
  else console.log("pass 3 skipped: needs m-ui.js, m-trends.js and m-sync.js");
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
