/* Chalk service worker.
   App shell: cache first, straight from this version's cache, so the app opens at once with no signal.
   One version per launch: index.html asks for "m-core.js?v=18" etc. and CORE lists exactly those URLs, so a page
   never mixes files from two versions. A new version arrives as a new sw.js (CACHE bumped): install downloads the
   whole set (all or nothing), activate swaps it in and tells open pages, and the page reloads at a safe moment.
   To ship a change to any CORE file: bump VERSION here, APP_VERSION and every ?v= in index.html (a test checks).
   Anything not cached: network with a hard 8 s budget for the whole body, else 504. Never a cut-off file.
   Pinned CDN files (scanner, label reader) and fonts are kept after first use, so they work offline. */
const VERSION = 21;
const CACHE = "chalk-v" + VERSION;
const CDN = "chalk-cdn";      /* pinned jsdelivr files never change, so they outlive app versions */
const FONTS = "chalk-fonts";
const V = "?v=" + VERSION;
const CORE = ["index.html", "manifest.json", "icon-180.png", "icon-192.png", "icon-512.png",
  "m.css" + V, "m-trends.css" + V, "m-core.js" + V, "m-data.js" + V, "m-food.js" + V, "m-ui.js" + V, "m-trends.js" + V, "m-sync.js" + V];
const NET_MS = 8000;
const SCOPE = new URL("./", self.location.href);

/* fetch + read the whole body inside the budget; null on timeout, network error or a body cut off halfway */
function netWhole(req, ms) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  const timeout = new Promise(r => { timer = setTimeout(() => { try { if (ctl) ctl.abort(); } catch (e) {} r(null); }, ms); });
  const run = (async () => {
    const r = req.mode === "navigate"
      ? new Request(req.url, { credentials: "same-origin", signal: ctl ? ctl.signal : undefined })
      : (ctl ? new Request(req, { signal: ctl.signal }) : req);
    const res = await fetch(r);
    const body = await res.arrayBuffer();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  })().catch(() => null);
  return Promise.race([run, timeout]).then(v => { clearTimeout(timer); return v; });
}
const put = (cache, key, res) => cache.put(key, res).catch(() => {});
const okToKeep = res => !!res && res.ok && res.type !== "opaque" && res.type !== "opaqueredirect";

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const got = await Promise.all(CORE.map(async u => {
      const res = await netWhole(new Request(u, { cache: "reload" }), 60000);
      if (!res || !res.ok) throw new Error("couldn't download " + u);
      /* right after a deploy the CDN can still hand out the last index.html for a minute. That page would ask for the
         last version's files, so this install fails and the browser tries again at the next check. */
      if (u === "index.html") {
        const m = /const APP_VERSION\s*=\s*(\d+)/.exec(await res.clone().text());
        if (!m || +m[1] !== VERSION) throw new Error("index.html is not version " + VERSION + " yet");
      }
      return [u, res];
    }));
    const cache = await caches.open(CACHE);
    await Promise.all(got.map(([u, res]) => cache.put(u, res)));
    await self.skipWaiting();
  })());
});

/* chalk-v15 → 15; other names → null */
const verOf = k => { const m = /^chalk-v(\d+)$/.exec(k); return m ? +m[1] : null; };
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    /* The origin hosts other apps: only ever touch Chalk's own caches. The newest older version stays one more round,
       so a page that started loading it a moment ago still gets every one of its own files. */
    const keys = await caches.keys();
    const prev = Math.max(-1, ...keys.map(verOf).filter(n => n != null && n < VERSION));
    await Promise.all(keys.filter(k => k.startsWith("chalk-") && k !== CACHE && k !== CDN && k !== FONTS && verOf(k) !== prev).map(k => caches.delete(k)));
    await self.clients.claim();
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    list.forEach(c => { try { c.postMessage({ type: "chalk-updated", cache: CACHE }); } catch (x) {} });
  })());
});

/* The worker never reloads a page itself. Pages from v16 on reload themselves at a quiet moment (never mid-workout,
   with a sheet open or while typing) and still say "chalk-self"; there is nothing for the worker to do with it.
   A v15 page has no update listener: it gets the new version the next time Chalk is opened. */
self.addEventListener("message", e => {
  if (e.data && e.data.type === "chalk-version?" && e.source) { try { e.source.postMessage({ type: "chalk-version", cache: CACHE }); } catch (x) {} }
});

let lastCheck = 0;
function checkForUpdate() {
  if (Date.now() - lastCheck < 60000 || !self.registration || !self.registration.update) return Promise.resolve();
  lastCheck = Date.now();
  return self.registration.update().catch(() => {});
}

const OFFLINE = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Chalk</title>' +
  '<body style="margin:0;padding:64px 24px;font:17px/1.4 -apple-system,Helvetica,Arial,sans-serif;text-align:center;background:#111417;color:#F2EFE8">' +
  '<h1 style="font-size:26px;margin:0 0 10px">Chalk didn\'t load</h1><p style="color:#8E949C;margin:0 0 24px">The signal is too weak right now.</p>' +
  '<button onclick="location.reload()" style="font:inherit;font-weight:600;padding:12px 28px;border:0;border-radius:12px;background:#F2B33D;color:#1A1400">Try again</button></body></html>';

async function shell(req, url, e) {
  const isPage = req.mode === "navigate" || url.pathname === SCOPE.pathname || url.pathname === SCOPE.pathname + "index.html";
  const cache = await caches.open(CACHE);
  if (isPage) {
    const hit = await cache.match("index.html");
    if (hit) { if (req.mode === "navigate") e.waitUntil(checkForUpdate()); return hit; }
  } else {
    /* versioned URLs make every cache safe to read: "m-ui.js?v=18" is only ever version 18 */
    const hit = (await cache.match(req, { ignoreVary: true })) || (await caches.match(req, { ignoreVary: true }));
    if (hit) return hit;
  }
  /* nothing cached yet (first launch, or a file this version doesn't have): network, whole body, hard budget.
     Not stored: only install fills the shell, so an old cache never holds a newer page. */
  const res = await netWhole(req, NET_MS);
  if (res) return res;
  if (req.mode === "navigate") return new Response(OFFLINE, { status: 504, statusText: "Gateway Timeout", headers: { "content-type": "text/html; charset=utf-8" } });
  return new Response("", { status: 504, statusText: "Gateway Timeout" });
}

async function keepFirst(name, req, e, refresh) {
  const cache = await caches.open(name);
  const hit = await cache.match(req.url, { ignoreVary: true });
  const net = () => fetch(req.url, { mode: "cors", credentials: "omit" }).then(res => { if (okToKeep(res)) return put(cache, req.url, res.clone()).then(() => res); return res; });
  if (hit) { if (refresh) e.waitUntil(net().catch(() => {})); return hit; }
  return net();
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (!url.href.startsWith(SCOPE.href)) return;          /* another app on this origin */
    e.respondWith(shell(req, url, e));
    return;
  }
  /* scanner + label reader: pinned versions on jsdelivr never change → keep the first good copy */
  if (url.hostname === "cdn.jsdelivr.net" && /@\d/.test(url.pathname)) { e.respondWith(keepFirst(CDN, req, e, false)); return; }
  /* fonts: kept, the stylesheet refreshed in the background */
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") { e.respondWith(keepFirst(FONTS, req, e, url.hostname === "fonts.googleapis.com")); return; }
});
