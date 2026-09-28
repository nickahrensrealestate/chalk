const CACHE = "chalk-v13";
const CORE = ["./", "index.html", "manifest.json", "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const NET_MS = 3000;
async function shell(req) {
  const cache = await caches.open(CACHE);
  let netErr = null;
  // only an OK response may become the cached shell — never a 404/500 or a captive-portal page
  const net = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()).catch(() => {}); return res; }).catch(err => { netErr = err; return null; });
  const first = await Promise.race([net, new Promise(r => setTimeout(() => r(null), NET_MS))]);
  if (first && first.ok) return first;
  const hit = await cache.match(req);
  if (hit && hit.ok) return hit;
  if (req.mode === "navigate") { const index = await cache.match("index.html"); if (index && index.ok) return index; }
  const late = await net;               // nothing usable cached: hand back whatever the network says, however slow
  if (late) return late;
  throw netErr || new Error("offline");
}
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // App shell: network first with a 3 s budget so updates land; a slow or dead network falls back to the cached copy.
  if (url.origin === location.origin) {
    e.respondWith(shell(req));
    return;
  }
  // Fonts: cache first, refresh in the background.
  if (url.hostname.endsWith("googleapis.com") || url.hostname.endsWith("gstatic.com")) {
    e.respondWith(
      caches.open(CACHE).then(async c => {
        const hit = await c.match(req);
        const net = fetch(req).then(res => { c.put(req, res.clone()); return res; }).catch(() => hit);
        return hit || net;
      })
    );
  }
});
