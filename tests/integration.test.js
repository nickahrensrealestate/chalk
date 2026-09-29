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

/* m-sync.js as shipped (SB_URL / SB_KEY empty), or pointed at a fake Supabase for pass 3.
   The orchestrator fills in exactly this line, so the test insists it is there. */
const SB_LINE = 'const SB_URL = ""; const SB_KEY = "";';
function syncSource(cfg) {
  const src = read("m-sync.js");
  assert.ok(src.includes(SB_LINE), "m-sync.js carries the empty config line");
  return cfg ? src.replace(SB_LINE, "const SB_URL = " + JSON.stringify(cfg.url) + "; const SB_KEY = " + JSON.stringify(cfg.key) + ";") : src;
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
function boot({ real, sync, store }) {
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
t("head links m.css and m-trends.css after Google Fonts", () => {
  const i = HTML.indexOf('href="https://fonts.googleapis.com');
  const a = HTML.indexOf('<link rel="stylesheet" href="m.css">');
  const b = HTML.indexOf('<link rel="stylesheet" href="m-trends.css">');
  assert.ok(i > 0 && a > i && b > a, "order: fonts < m.css < m-trends.css");
  assert.ok(a < HTML.indexOf("<style>"), "links before <style>");
});
t("six module scripts in order (m-sync.js right after m-trends.js), before the inline script", () => {
  const order = ["m-core.js", "m-data.js", "m-food.js", "m-ui.js", "m-trends.js", "m-sync.js"].map(f => HTML.indexOf('<script src="' + f + '"></script>'));
  order.forEach((p, i) => assert.ok(p > 0 && (i === 0 || p > order[i - 1]), "script " + i + " position"));
  assert.ok(/<script src="m-trends\.js"><\/script>\s*<script src="m-sync\.js"><\/script>/.test(HTML), "m-sync.js directly after m-trends.js");
  assert.ok(order[5] < HTML.indexOf("<script>\n/* ================= EXERCISE LIBRARY"), "before Chalk's inline script");
});
t("boot starts cloud sync right after M.sync.init(), before the first render", () => {
  const js = inlineScript(HTML);
  const init = js.indexOf("M.sync.init();"), start = js.indexOf("M.cloud.start();"), first = js.indexOf("applyTheme(); render();", init);
  assert.ok(init > 0 && start > init && first > start, "order: M.sync.init → M.cloud.start → render");
  assert.ok(/if\(window\.M&&M\.cloud&&M\.cloud\.start\) M\.cloud\.start\(\);/.test(js), "guarded call");
});
t("Train Today adds the Macros summary row right after the check-in banner, only when it exists", () => {
  const js = inlineScript(HTML);
  const i = js.indexOf("let h=(window.M&&M.ui&&M.ui.bannerHTML?M.ui.bannerHTML():\"\");");
  const j = js.indexOf('if(window.M&&M.ui&&typeof M.ui.trainSummaryHTML==="function"){ try{ h+=M.ui.trainSummaryHTML()||""; }catch(e){} }');
  assert.ok(i > 0 && j > i && j - i < 120, "summary line follows the banner line");
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
t("sw.js: cache bumped, CORE lists the macro files, other origins not intercepted", () => {
  const sw = read("sw.js");
  const ver = +((sw.match(/const CACHE = "chalk-v(\d+)"/) || [])[1] || 0);
  assert.ok(ver >= 15, "cache bumped for m-sync.js (got v" + ver + ")");
  ["m.css", "m-trends.css", "m-core.js", "m-data.js", "m-food.js", "m-ui.js", "m-trends.js", "m-sync.js"].forEach(f => assert.ok(sw.includes('"' + f + '"'), "CORE has " + f));
  new vm.Script(sw, { filename: "sw.js" });
  /* behavior: run the worker with a fake `self` and check which requests it takes over */
  const listeners = {};
  const fakeSelf = { addEventListener: (type, fn) => { listeners[type] = fn; }, skipWaiting() {}, clients: { claim() {} }, location: { origin: "https://nickahrensrealestate.github.io" } };
  vm.runInNewContext(sw, { self: fakeSelf, location: fakeSelf.location, caches: { open: () => Promise.resolve({ match: () => Promise.resolve(null), put: () => Promise.resolve() }), keys: () => Promise.resolve([]), match: () => Promise.resolve(null) }, fetch: () => Promise.reject(new Error("offline")), URL, Request: function (u) { this.url = u; }, setTimeout, Promise });
  assert.strictEqual(typeof listeners.fetch, "function", "fetch listener registered");
  const takes = (u, method) => { let took = false; listeners.fetch({ request: { url: u, method: method || "GET", mode: "cors" }, respondWith: p => { took = true; if (p && p.catch) p.catch(() => {}); } }); return took; };
  assert.ok(takes("https://nickahrensrealestate.github.io/chalk/m-core.js"), "same-origin app files are served by the worker");
  assert.ok(takes("https://fonts.gstatic.com/s/barlow/v1/x.woff2"), "fonts are cached");
  ["https://world.openfoodfacts.org/api/v2/product/1.json", "https://api.anthropic.com/v1/messages",
    "https://abcdefgh.supabase.co/rest/v1/chalk_sync?select=kind,id&household=eq.X"].forEach(u => assert.ok(!takes(u), "not intercepted: " + u));
  assert.ok(!takes("https://abcdefgh.supabase.co/rest/v1/chalk_sync?on_conflict=household,kind,id", "POST"), "sync uploads pass through");
  assert.ok(!takes("https://nickahrensrealestate.github.io/chalk/index.html", "POST"), "non-GET passes through");
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
        profiles: { nick: { id: "nick", name: "Nick", weightLb: 190 } }, foods: {}, meals: {}, days: {}, body: {} };
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
    t("boot pulls: GET chalk_sync for this household with apikey + x-household", () => {
      const g = fetches[0];
      assert.ok(g && g.method === "GET", "a pull happened at boot");
      assert.ok(g.url.startsWith(URL0 + "/rest/v1/chalk_sync?select=kind,id,data,deleted,client_updated,updated_at&household=eq." + CODE + "&updated_at=gt."), g.url);
      assert.ok(/&order=updated_at\.asc&limit=500$/.test(g.url));
      assert.strictEqual(g.headers.apikey, KEY0);
      assert.strictEqual(g.headers["x-household"], CODE);
      assert.ok(!("Authorization" in g.headers), "no Bearer for a publishable key");
    });
    await sleep(20);
    t("You tab: Sync & backup card shows the code in groups of 4", () => {
      click(w, q(d, '#app [data-a="pick-profile"][data-v="nick"]'));
      w.M.setMode("macros"); w.M.ui.tab = "you"; w.render();
      assert.ok(q(d, "#mt-sync"), "card rendered");
      assert.strictEqual(q(d, "#mt-code").textContent, "ABCD-EFGH-JKLM-NPQR-STUV");
      assert.ok(q(d, '#mt-sync [data-m="t-sync-now"]') && q(d, '#mt-sync [data-m="t-sync-off"]'));
      assert.ok(/Synced just now|Syncing/.test(q(d, "#mt-sync-status").textContent), q(d, "#mt-sync-status").textContent);
    });
    await ta("a macro change is uploaded about 1.5 s later", async () => {
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
      assert.ok(posts.some(p => JSON.parse(p.body).some(row => row.kind === "train" && row.id === "nick")), "Chalk training backed up too");
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

runPass("pass 1: stub M.ui (integration wiring)", false);
const realFiles = ["m-ui.js", "m-trends.js"].filter(exists);
if (realFiles.length) runPass("pass 2: real " + realFiles.join(" + ") + (realFiles.length < 2 ? " (stub fills the rest)" : ""), true);
else console.log("pass 2 skipped: m-ui.js / m-trends.js not present yet");

(async () => {
  if (realFiles.length === 2 && exists("m-sync.js")) await runSyncPass();
  else console.log("pass 3 skipped: needs m-ui.js, m-trends.js and m-sync.js");
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
