window.M = window.M || {};
/* ============================================================================
   Chalk · Macros — food + AI (M.ai, M.img, M.food)
   - Barcode scanner: the phone's own BarcodeDetector when it reads retail codes,
     else barcode-detector 3.2.2 (ZXing C++ in WebAssembly, pinned on jsdelivr)
     in a Web Worker so decoding never blocks the page. Reads a center band at
     ~12 frames a second, accepts a code only when the check digit passes and
     the same code reads on two frames in a row.
   - Open Food Facts lookups (UPC-A / EAN-13 / UPC-E / EAN-8), saved to My foods.
   - Nutrition Facts label reader: Claude vision, or tesseract.js OCR + a
     noise-tolerant parser.
   - Claude: claude.use("sample") inside claude.ai, or an Anthropic key kept on
     this phone. Photo / text estimates and meal ideas.
   Every network / AI / library call has a timeout and rejects with a plain
   {code, message} object whose message is plain English for the UI.
   Nothing here throws at load. Chalk / M.core globals are read lazily.
   ========================================================================== */
(function (M) {
  "use strict";

  /* ---------------------------------------------------------------- helpers */
  const isNum = v => typeof v === "number" && isFinite(v);
  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  function num(v, d) {
    if (d === undefined) d = 0;
    if (typeof v === "string") v = parseFloat(v.replace(",", "."));
    return isNum(v) ? v : d;
  }
  const r0 = v => Math.round(v + (v >= 0 ? 1e-9 : -1e-9));
  const r1 = v => Math.round(v * 10 + (v >= 0 ? 1e-9 : -1e-9)) / 10;
  const r2 = v => Math.round(v * 100 + (v >= 0 ? 1e-9 : -1e-9)) / 100;
  const lc = s => String(s == null ? "" : s).toLowerCase();
  const NUT = ["cal", "p", "c", "f", "fiber", "sugar", "sodium"];
  const uid = () => { try { if (M.uid) return M.uid(); } catch (e) {} return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); };
  const win = () => (typeof window !== "undefined" ? window : {});
  const nav = () => { try { return typeof navigator !== "undefined" ? navigator : {}; } catch (e) { return {}; } };
  const doc = () => (typeof document !== "undefined" ? document : null);
  const now = () => Date.now();
  const isOffline = () => { try { return nav().onLine === false; } catch (e) { return false; } };
  const toList = v => (v == null ? [] : Array.isArray(v) ? v.filter(Boolean) : typeof v === "object" && typeof v.length === "number" ? Array.prototype.slice.call(v).filter(Boolean) : [v]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  /* Names and brands from Open Food Facts, labels and Claude: one line, at most 120 letters. */
  const cap = (s, n) => { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); n = n || 120; return s.length > n ? s.slice(0, n).trim() : s; };

  /* One error shape everywhere: a plain object, never an Error subclass. */
  function E(code, message, extra) {
    const o = { code: code || "error", message: message || "Something went wrong. Try again." };
    if (extra !== undefined) o.detail = extra;
    return o;
  }
  const isE = e => isObj(e) && typeof e.code === "string" && typeof e.message === "string";
  const wrapErr = (e, code, message) => (isE(e) ? e : E(code, message, e && e.message ? e.message : String(e)));

  function withTimeout(promise, ms, code, message) {
    let t;
    const timer = new Promise((_, rej) => { t = setTimeout(() => rej(E(code || "timeout", message || "That took too long. Try again.")), ms); });
    return Promise.race([Promise.resolve(promise), timer]).then(v => { clearTimeout(t); return v; }, e => { clearTimeout(t); throw e; });
  }

  /* fetch + JSON with a hard timeout that covers the body too.
     → {ok, status, body} (body null when it isn't JSON, e.g. an HTML 429 page).
     Rejects {code:"offline"|"timeout"|"network"|"cancelled"}. */
  async function fetchJSON(url, opts, ms, what) {
    what = what || "the server";
    if (typeof fetch !== "function") throw E("network", "No network access here.");
    if (isOffline()) throw E("offline", "You're offline. Check your connection and try again.");
    opts = Object.assign({}, opts || {});
    const outer = opts.signal || null; delete opts.signal;
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    let t = 0, timedOut = false;
    /* Online but no answer: the other side is slow or down (a CORS-blocked 503 looks like a
       network error). Only an offline phone is told to check its connection. */
    const slowMsg = "Reaching " + what + " took too long. Try again in a minute.";
    const timer = new Promise((_, rej) => { t = setTimeout(() => { timedOut = true; try { if (ctl) ctl.abort(); } catch (e) {} rej(E("timeout", slowMsg)); }, ms || 8000); });
    const onOuter = () => { try { if (ctl) ctl.abort(); } catch (e) {} };
    if (outer && typeof outer.addEventListener === "function") { if (outer.aborted) onOuter(); else outer.addEventListener("abort", onOuter); }
    try {
      let res;
      try { res = await Promise.race([fetch(url, Object.assign(opts, ctl ? { signal: ctl.signal } : {})), timer]); }
      catch (e) {
        if (outer && outer.aborted) throw E("cancelled", "Stopped.");
        if (timedOut || (isE(e) && e.code === "timeout")) throw E("timeout", slowMsg);
        if (isOffline()) throw E("offline", "You're offline. Check your connection and try again.");
        throw E("network", what + " isn't answering right now. Try again in a minute.");
      }
      let body = null;
      try { body = await Promise.race([Promise.resolve().then(() => res.json()).catch(() => null), timer]); }
      catch (e) { throw E("timeout", slowMsg); }
      return { ok: !!res.ok, status: num(res.status), body };
    } finally {
      clearTimeout(t);
      if (outer && typeof outer.removeEventListener === "function") outer.removeEventListener("abort", onOuter);
    }
  }

  /* Lazy <script> loader (one load per URL, shared promise). `integrity` (SRI): the browser runs
     the file only when its bytes match that hash. `message` may be a function (read on failure). */
  const scriptLoads = {};
  function loadScript(url, ready, ms, code, message, integrity) {
    try { if (ready()) return Promise.resolve(true); } catch (e) {}
    if (scriptLoads[url]) return scriptLoads[url];
    const msgOf = () => (typeof message === "function" ? message() : message);
    scriptLoads[url] = new Promise((resolve, reject) => {
      const d = doc();
      if (!d) { delete scriptLoads[url]; return reject(E(code, msgOf())); }
      const s = d.createElement("script");
      s.src = url; s.async = true; s.crossOrigin = "anonymous";
      if (integrity) s.integrity = integrity;
      let done = false;
      const fail = () => { if (done) return; done = true; delete scriptLoads[url]; try { s.remove(); } catch (e) {} reject(E(code, msgOf())); };
      const t = setTimeout(fail, ms || 15000);
      s.onload = () => { clearTimeout(t); if (done) return; done = true; try { if (ready()) resolve(true); else { delete scriptLoads[url]; reject(E(code, msgOf())); } } catch (e) { delete scriptLoads[url]; reject(E(code, msgOf())); } };
      s.onerror = () => { clearTimeout(t); fail(); };
      d.head.appendChild(s);
    });
    return scriptLoads[url];
  }

  /* ---------------------------------------------------------- JSON from Claude
     Whole reply → each ``` fence → each balanced {…} / […] scanning left to right
     (strings respected), each tried as-is and with trailing commas / smart quotes fixed. */
  function matchBracket(s, i) {
    const close = s[i] === "{" ? "}" : "]";
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === "\"") inStr = false; continue; }
      if (c === "\"") inStr = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") { depth--; if (depth === 0) return c === close ? j : -1; if (depth < 0) return -1; }
    }
    return -1;
  }
  function tryJSON(s) {
    try { return { ok: true, v: JSON.parse(s) }; } catch (e) {}
    const fixed = s.replace(/[“”]/g, "\"").replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, "$1");
    if (fixed !== s) { try { return { ok: true, v: JSON.parse(fixed) }; } catch (e) {} }
    return { ok: false };
  }
  function parseJSONText(text) {
    const s = String(text == null ? "" : text).trim();
    if (s) {
      let r = tryJSON(s); if (r.ok) return r.v;
      const fence = /```[a-zA-Z]*[ \t]*\n?([\s\S]*?)```/g; let m;
      while ((m = fence.exec(s))) { r = tryJSON(m[1].trim()); if (r.ok) return r.v; }
      const open = /```[a-zA-Z]*[ \t]*\n?([\s\S]*)$/.exec(s);           /* a fence that never closed (cut-off reply) */
      const body = open ? open[1] : s;
      for (let i = 0; i < body.length; i++) {
        const ch = body[i]; if (ch !== "{" && ch !== "[") continue;
        const end = matchBracket(body, i); if (end < 0) continue;
        r = tryJSON(body.slice(i, end + 1)); if (r.ok && r.v !== null && typeof r.v === "object") return r.v;
      }
    }
    throw E("bad_json", "Claude's answer couldn't be read. Try again.");
  }

  /* AI per-block → Food per-block (sodium_mg → sodium). Missing → 0. "<1" style strings → 0.5. */
  function aiNum(v) {
    if (typeof v === "string") { const s = v.trim(); if (/^(<|less than)\s*1\b/i.test(s)) return 0.5; return num(s.replace(/[^\d.,-]/g, ""), 0); }
    return num(v, 0);
  }
  function perFromAI(p) {
    p = isObj(p) ? p : {};
    const sod = p.sodium_mg !== undefined ? p.sodium_mg : p.sodium;
    return { cal: r0(aiNum(p.cal)), p: r1(aiNum(p.p)), c: r1(aiNum(p.c)), f: r1(aiNum(p.f)), fiber: r1(aiNum(p.fiber)), sugar: r1(aiNum(p.sugar)), sodium: r0(aiNum(sod)) };
  }
  function servingFromAI(s, fallbackG) {
    s = isObj(s) ? s : {};
    const g = num(s.g, null);
    return { qty: num(s.qty, 1) > 0 ? num(s.qty, 1) : 1, unit: String(s.unit || "serving").trim() || "serving", g: isNum(g) && g > 0 ? r1(g) : (isNum(fallbackG) && fallbackG > 0 ? r1(fallbackG) : null) };
  }
  const gOf = it => { const g = num(it && it.g, null); if (isNum(g) && g > 0) return r1(g); const p = M.parseServing ? M.parseServing(it && it.servingLabel) : null; return p && p.g ? p.g : null; };
  function itemFromAI(it, source) {
    it = isObj(it) ? it : {};
    const g = gOf(it);
    const label = String(it.servingLabel || (M.fmtServing ? M.fmtServing({ qty: 1, unit: "serving", g }) : "1 serving")).trim();
    return { name: cap(it.name) || "Food", brand: cap(it.brand), servings: 1, servingLabel: cap(label, 60) || "1 serving", g, per: perFromAI(it.per), source: source || "ai" };
  }
  const sumPer = items => {
    const o = {}; NUT.forEach(k => { o[k] = 0; });
    (items || []).forEach(it => { const s = it && it.servings != null ? num(it.servings, 1) : 1; NUT.forEach(k => { o[k] += num(it && it.per && it.per[k]) * s; }); });
    NUT.forEach(k => { o[k] = k === "cal" || k === "sodium" ? r0(o[k]) : r1(o[k]); });
    return o;
  };
  function scaleTo100(per, g) {
    if (!(g > 0)) return null;
    const o = {}; NUT.forEach(k => { const v = num(per && per[k]) * 100 / g; o[k] = k === "cal" || k === "sodium" ? r0(v) : r1(v); });
    return o;
  }

  /* ======================================================================== */
  /* M.ai — Claude via claude.use("sample") (inside claude.ai) or an API key   */
  /* ======================================================================== */
  const KEY_LS = "chalk.ai.key";
  const API_URL = "https://api.anthropic.com/v1/messages";
  const DEFAULT_MODEL = "claude-sonnet-5-5";
  const FALLBACK_MODEL = "claude-haiku-4-5-20251001";
  const AI_TIMEOUT = 30000;
  let sampleFn = null, sampleProbed = false, sampleProbe = null, sampleOff = false, sampleNoImages = false;

  const AI_MSG = {
    no_ai: "Claude isn't set up. Open Chalk inside claude.ai, or add your Anthropic key in You → AI.",
    no_images: "Photos can't be sent to Claude here. Add your Anthropic key in You → AI.",
    auth: "Your Anthropic key is wrong. Check it in You → AI.",
    forbidden: "Your Anthropic key isn't allowed to do this. Check your Anthropic account.",
    rate_limited: "Too many requests. Try again in a minute.",
    overloaded: "Claude is busy right now. Try again in a minute.",
    server: "Claude had a problem. Try again.",
    timeout: "Claude took too long to answer. Try again.",
    offline: "You're offline. Check your connection and try again.",
    network: "Claude isn't answering right now. Try again in a minute.",
    model: "That Claude model isn't available on your key. Pick another model in You → AI.",
    billing: "Your Anthropic account is out of credits. Add credits at console.anthropic.com.",
    bad_json: "Claude's answer couldn't be read. Try again."
  };

  function lsGet(k) { try { return typeof localStorage !== "undefined" ? localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (typeof localStorage !== "undefined") localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { if (typeof localStorage !== "undefined") localStorage.removeItem(k); } catch (e) {} }

  /* claude.use("sample") resolves the function once the viewer runtime starts, or null
     where it never can (decided ~10 s after load). Asking the viewer nothing. */
  function probeSample() {
    if (sampleProbe) return sampleProbe;
    const c = win().claude;
    if (!(c && typeof c.use === "function")) { sampleProbed = true; return (sampleProbe = Promise.resolve(null)); }
    sampleProbe = Promise.resolve().then(() => c.use("sample")).then(
      s => { sampleFn = typeof s === "function" ? s : null; sampleProbed = true; return sampleFn; },
      () => { sampleFn = null; sampleProbed = true; return null; });
    return sampleProbe;
  }
  /* Wait for the probe when it matters: long when claude.ai is the only way, short when a key is saved. */
  async function settleProbe() {
    if (sampleProbed) return;
    const w = win();
    if (!(w.claude && typeof w.claude.use === "function")) { probeSample(); return; }
    try { await withTimeout(probeSample(), M.ai.getKey() ? 1500 : 11000); } catch (e) {}
  }

  /* sample error codes (see sample.d.ts) → our codes and plain words.
     fallback:true = the feature is off in this view; use the saved key if there is one. */
  function mapSampleErr(e) {
    const c = isObj(e) ? String(e.code || "") : "";
    const x = (code, msg, fb) => { const o = E(code, msg); if (fb) o.fallback = true; return o; };
    switch (c) {
      case "cancelled": return x("cancelled", "Stopped.");
      case "not_granted": sampleOff = true; return x("no_ai", "Claude isn't allowed for Chalk here. Allow it when asked, or add your Anthropic key in You → AI.", true);
      case "sampling_disabled": case "not_declared": case "capability_disabled": case "capability_removed": case "tools_unavailable":
        sampleOff = true; return x("no_ai", "Claude isn't available here. Add your Anthropic key in You → AI.", true);
      case "images_unavailable": sampleNoImages = true; return x("no_ai", AI_MSG.no_images, true);
      case "rate_limited": return x("rate_limited", AI_MSG.rate_limited);
      case "session_expired": return x("auth", "Your claude.ai sign-in ended. Sign in again.");
      case "image_rejected": return x("image", "That photo couldn't be used. Try another photo.");
      case "refused": return x("refused", "Claude couldn't help with that. Try other words or another photo.");
      case "prompt_too_large": return x("too_large", "That's too much for one request. Try less at a time.");
      case "empty_completion": case "invalid_json": return x("bad_json", AI_MSG.bad_json);
      case "invalid_request": case "transform_error": case "queue_overflow": return x("bad_request", "Claude couldn't take that request. Try again.");
      default: return x("network", "Claude had a problem. Try again.");
    }
  }

  async function sampleJSON(s, prompt, opt) {
    const o = { modelTier: opt.tier === "quick" ? "quick" : opt.tier === "complex" ? "complex" : "default" };
    if (opt.cache === false) o.cache = false;
    if (opt.signal) o.signal = opt.signal;
    let images = toList(opt.images);
    if (images.length) {
      let lim = null;
      try { lim = typeof s.limits === "function" ? await withTimeout(s.limits(), 5000) : null; } catch (e) { lim = null; }
      if (!(lim && lim.images) || sampleNoImages) { const er = E("no_ai", AI_MSG.no_images); er.fallback = true; throw er; }
      const types = Array.isArray(lim.images.mediaTypes) ? lim.images.mediaTypes : [];
      const maxBytes = num(lim.images.maxInputBytes, 0);
      if (num(lim.images.maxCount) > 0) images = images.slice(0, num(lim.images.maxCount));
      /* HEIC or very large photos → JPEG first; the platform downsizes the rest itself */
      images = await Promise.all(images.map(b => ((types.length && b.type && types.indexOf(b.type) < 0) || (maxBytes > 0 && num(b.size) > maxBytes)
        ? M.img.downscale(b, 1600, 0.9).catch(() => b) : b)));
      o.images = images;
    }
    if (typeof s.json !== "function") { sampleOff = true; const er = E("no_ai", "Claude isn't available here. Add your Anthropic key in You → AI."); er.fallback = true; throw er; }
    let v;
    try { v = await s.json(prompt, o); } catch (e) { throw mapSampleErr(e); }
    if (v === undefined || v === null) throw E("bad_json", AI_MSG.bad_json);
    return v;
  }

  async function keyJSON(key, prompt, opt) {
    const content = [];
    for (const img of toList(opt.images)) {
      let blob = null;
      try { blob = await M.img.downscale(img, 1280, 0.85); } catch (e) { blob = null; }
      let type = "image/jpeg";
      if (!blob) {
        type = String(img && img.type || "image/jpeg");
        if (!/^image\/(jpeg|png|gif|webp)$/i.test(type)) throw E("image", "That photo type can't be sent. Try a JPEG or PNG photo.");
        blob = img;
      }
      content.push({ type: "image", source: { type: "base64", media_type: type, data: await M.img.toBase64(blob) } });
    }
    content.push({ type: "text", text: String(prompt) });
    let model = opt.model || M.ai.model(), retried = false;
    const deadline = now() + (num(opt.timeout) > 0 ? num(opt.timeout) : AI_TIMEOUT);
    for (;;) {
      const left = deadline - now();
      if (left < 300) throw E("timeout", AI_MSG.timeout);
      let r;
      try {
        r = await fetchJSON(API_URL, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({ model, max_tokens: num(opt.maxTokens) > 0 ? num(opt.maxTokens) : 1500, messages: [{ role: "user", content }] }),
          signal: opt.signal
        }, left, "Claude");
      } catch (e) {
        if (isE(e) && e.code === "timeout") throw E("timeout", AI_MSG.timeout);
        if (isE(e) && (e.code === "offline" || e.code === "cancelled")) throw e;
        throw E("network", AI_MSG.network);
      }
      const err = r.body && isObj(r.body.error) ? r.body.error : null;
      const etype = err ? String(err.type || "") : "";
      const emsg = err ? String(err.message || "") : "";
      if (r.ok) {
        const blocks = r.body && Array.isArray(r.body.content) ? r.body.content : [];
        const text = blocks.filter(b => b && b.type === "text" && typeof b.text === "string").map(b => b.text).join("\n");
        if (!text.trim()) throw E("bad_json", AI_MSG.bad_json);
        return parseJSONText(text);
      }
      if ((r.status === 404 || etype === "not_found_error") && !retried && model !== FALLBACK_MODEL) { retried = true; model = FALLBACK_MODEL; continue; }
      if (r.status === 401 || etype === "authentication_error") throw E("auth", AI_MSG.auth);
      if (r.status === 403 || etype === "permission_error") throw E("forbidden", AI_MSG.forbidden);
      if (r.status === 429 || etype === "rate_limit_error") throw E("rate_limited", AI_MSG.rate_limited);
      if (r.status === 529 || etype === "overloaded_error") throw E("overloaded", AI_MSG.overloaded);
      if (r.status === 404 || etype === "not_found_error") throw E("model", AI_MSG.model);
      if (r.status === 413 || etype === "request_too_large") throw E("too_large", "That photo is too big. Try a smaller one.");
      if (/credit balance/i.test(emsg)) throw E("billing", AI_MSG.billing);
      if (r.status === 400 || etype === "invalid_request_error") throw E("bad_request", "Claude couldn't take that request. Try again.");
      if (r.status === 503) throw E("overloaded", AI_MSG.overloaded);
      if (r.status >= 500 || etype === "api_error") throw E("server", AI_MSG.server);
      throw E("server", AI_MSG.server);
    }
  }

  M.ai = {
    mode() {
      if (sampleFn && !sampleOff) return "sample";
      const k = lsGet(KEY_LS);
      return k && k.trim() ? "key" : null;
    },
    ready() { return M.ai.mode() !== null; },
    /* Resolves once the claude.ai probe has settled (so the UI can wait for a real answer). */
    probe() { return probeSample().then(() => M.ai.mode()); },
    probed() { return sampleProbed; },
    getKey() { const k = lsGet(KEY_LS); return k ? k.trim() : ""; },
    setKey(k) {
      k = String(k == null ? "" : k).trim();
      if (!k) { lsDel(KEY_LS); return ""; }
      lsSet(KEY_LS, k);
      return k;
    },
    model() {
      try { const p = M.person ? M.person() : null; if (p && p.aiModel) return p.aiModel; } catch (e) {}
      return DEFAULT_MODEL;
    },
    models: [DEFAULT_MODEL, FALLBACK_MODEL],
    timeoutMs: AI_TIMEOUT,
    /* Can this AI path look at photos? (key: yes; sample: only if limits().images) */
    async images() {
      const m = M.ai.mode();
      if (m === "key") return true;
      if (m !== "sample" || sampleNoImages) return !!(M.ai.getKey());
      try { const lim = await withTimeout(sampleFn.limits(), 5000); if (lim && lim.images) return true; } catch (e) {}
      return !!(M.ai.getKey());
    },
    /* json(prompt, {images?:Blob[], tier?:"quick"|"default"|"complex", cache?:false, signal?, timeout?:ms, model?, maxTokens?})
       → parsed JSON. Asks for JSON only. Never throws synchronously; rejects {code, message}.
       Key path: 30 s timeout (opt.timeout overrides). claude.ai path: no page-side timer — the
       platform ends long calls and the consent dialog must not count against us. */
    json(prompt, opt) {
      opt = isObj(opt) ? Object.assign({}, opt) : {};
      return Promise.resolve().then(async () => {
        if (!prompt || !String(prompt).trim()) throw E("bad_request", "Nothing to ask.");
        await settleProbe();
        if (M.ai.mode() === "sample") {
          try { return await sampleJSON(sampleFn, String(prompt), opt); }
          catch (e) { if (!(e && e.fallback && M.ai.getKey())) throw e; }
        }
        const key = M.ai.getKey();
        if (key) return keyJSON(key, String(prompt), opt);
        throw E("no_ai", AI_MSG.no_ai);
      }).catch(e => { throw wrapErr(e, "network", AI_MSG.network); });
    },
    /* Cheap round-trip used by the You tab's "Test" button. */
    test() { return M.ai.json("Reply with exactly this JSON and nothing else: {\"ok\":true}", { tier: "quick", cache: false, maxTokens: 50 }).then(v => !!(v && v.ok === true)); },
    parseJSONText,
    messages: AI_MSG
  };
  try { probeSample(); } catch (e) {}

  /* ======================================================================== */
  /* M.img — canvas downscale / OCR prep / base64                              */
  /* ======================================================================== */
  function decodeImage(file) {
    /* → {src, w, h, close()} where src is drawable by canvas, EXIF orientation applied. */
    const w = win();
    const viaBitmap = opts => w.createImageBitmap(file, opts).then(bm => ({ src: bm, w: bm.width, h: bm.height, close() { try { bm.close(); } catch (e) {} } }));
    const viaImg = () => new Promise((resolve, reject) => {
      if (typeof Image !== "function" || !w.URL || !w.URL.createObjectURL) return reject(E("image", "This browser can't read that image."));
      const url = w.URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => resolve({ src: im, w: im.naturalWidth || im.width, h: im.naturalHeight || im.height, close() { try { w.URL.revokeObjectURL(url); } catch (e) {} } });
      im.onerror = () => { try { w.URL.revokeObjectURL(url); } catch (e) {} reject(E("image", "That image couldn't be read. Try a JPEG or PNG.")); };
      im.src = url;
    });
    if (typeof w.createImageBitmap === "function") return viaBitmap({ imageOrientation: "from-image" }).catch(() => viaBitmap(undefined)).catch(() => viaImg());
    return viaImg();
  }
  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      const done = b => (b ? resolve(b) : reject(E("image", "Couldn't process that image.")));
      try {
        if (typeof canvas.toBlob === "function") canvas.toBlob(done, type, quality);
        else {
          const du = canvas.toDataURL(type, quality);
          const bin = atob(du.split(",")[1]); const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          done(new Blob([arr], { type }));
        }
      } catch (e) { reject(E("image", "Couldn't process that image.")); }
    });
  }
  function newCanvas(w, h) { const c = doc().createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }

  /* Target size for OCR: small photos are scaled UP (Tesseract wants ~20-30 px letters),
     big ones down. → scale factor */
  function ocrScale(w, h, minPx, maxPx) {
    const m = Math.max(w, h, 1);
    if (m < minPx) return Math.min(2.5, minPx / m);
    if (m > maxPx) return maxPx / m;
    return 1;
  }
  M.img = {
    /* downscale(file, maxPx=1280, quality=0.85) → JPEG Blob, EXIF orientation applied. */
    downscale(file, maxPx, quality) {
      maxPx = num(maxPx, 1280) || 1280; quality = num(quality, 0.85) || 0.85;
      return Promise.resolve().then(async () => {
        if (!file) throw E("image", "No image given.");
        if (!doc()) throw E("image", "No canvas here.");
        const im = await withTimeout(decodeImage(file), 20000, "image", "Reading that image took too long.");
        try {
          const scale = Math.min(1, maxPx / Math.max(im.w, im.h, 1));
          const c = newCanvas(im.w * scale, im.h * scale);
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(im.src, 0, 0, c.width, c.height);
          return await canvasBlob(c, "image/jpeg", quality);
        } finally { im.close(); }
      });
    },
    /* prepOCR(file, {min=1600, max=2200}|maxPx) → {canvas, blob, width, height}
       Grayscale, contrast stretched between the 1st and 99th percentile, resized so text
       is big enough for Tesseract (small photos are upscaled). */
    prepOCR(file, opt) {
      const o = isObj(opt) ? opt : { max: num(opt, 2200) || 2200 };
      const minPx = num(o.min, 1600) || 1600, maxPx = Math.max(minPx, num(o.max, 2200) || 2200);
      return Promise.resolve().then(async () => {
        if (!doc()) throw E("image", "No canvas here.");
        const im = await withTimeout(decodeImage(file), 20000, "image", "Reading that image took too long.");
        try {
          const k = ocrScale(im.w, im.h, minPx, maxPx);
          const c = newCanvas(im.w * k, im.h * k);
          const ctx = c.getContext("2d", { willReadFrequently: true });
          ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
          ctx.imageSmoothingEnabled = true; try { ctx.imageSmoothingQuality = "high"; } catch (e) {}
          ctx.drawImage(im.src, 0, 0, c.width, c.height);
          const id = ctx.getImageData(0, 0, c.width, c.height), d = id.data;
          const hist = new Uint32Array(256);
          for (let i = 0; i < d.length; i += 4) { const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0; d[i] = g; hist[g]++; }
          const total = c.width * c.height; let lo = 0, hi = 255, acc = 0;
          for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * 0.01) { lo = i; break; } }
          acc = 0; for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= total * 0.01) { hi = i; break; } }
          const span = Math.max(1, hi - lo);
          for (let i = 0; i < d.length; i += 4) { let g = (d[i] - lo) * 255 / span; g = g < 0 ? 0 : g > 255 ? 255 : g; d[i] = d[i + 1] = d[i + 2] = g; d[i + 3] = 255; }
          ctx.putImageData(id, 0, 0);
          const blob = await canvasBlob(c, "image/png");
          return { canvas: c, blob, width: c.width, height: c.height, scale: k };
        } finally { im.close(); }
      });
    },
    /* Blob → base64 string, no data: prefix. */
    toBase64(blob) {
      return new Promise((resolve, reject) => {
        if (!blob) return reject(E("image", "No image given."));
        if (typeof FileReader === "function") {
          const fr = new FileReader();
          fr.onload = () => { const s = String(fr.result || ""); const i = s.indexOf(","); resolve(i >= 0 ? s.slice(i + 1) : s); };
          fr.onerror = () => reject(E("image", "Couldn't read that image."));
          fr.readAsDataURL(blob);
          return;
        }
        Promise.resolve(blob.arrayBuffer()).then(buf => {
          const bytes = new Uint8Array(buf);
          if (typeof Buffer !== "undefined") return resolve(Buffer.from(bytes).toString("base64"));
          let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          resolve(btoa(bin));
        }, () => reject(E("image", "Couldn't read that image.")));
      });
    }
  };

  /* ======================================================================== */
  /* Barcodes: GTIN check digits, UPC-E ↔ UPC-A, one canonical form           */
  /* ======================================================================== */
  M.food = M.food || {};
  const digitsOf = c => String(c == null ? "" : c).replace(/\D/g, "");
  function gtinCheck(body) {
    let s = 0;
    for (let i = 0; i < body.length; i++) s += (body.charCodeAt(body.length - 1 - i) - 48) * (i % 2 === 0 ? 3 : 1);
    return (10 - (s % 10)) % 10;
  }
  const gtinOk = c => /^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(c) && gtinCheck(c.slice(0, -1)) === c.charCodeAt(c.length - 1) - 48;
  /* 8-digit UPC-E (number system 0/1) → 12-digit UPC-A, or "" when it isn't a valid UPC-E. */
  function upceToUpca(e) {
    e = digitsOf(e);
    if (!/^[01]\d{7}$/.test(e)) return "";
    const ns = e[0], d = e.slice(1, 7), l = d[5];
    let b;
    if (l <= "2") b = ns + d[0] + d[1] + l + "0000" + d[2] + d[3] + d[4];
    else if (l === "3") b = ns + d[0] + d[1] + d[2] + "00000" + d[3] + d[4];
    else if (l === "4") b = ns + d[0] + d[1] + d[2] + d[3] + "00000" + d[4];
    else b = ns + d.slice(0, 5) + "0000" + l;
    const a = b + gtinCheck(b);
    return a[11] === e[7] ? a : "";
  }
  /* 12-digit UPC-A → 8-digit UPC-E when it can be zero-suppressed, else "". */
  function upcaToUpce(a) {
    a = digitsOf(a);
    if (!/^[01]\d{11}$/.test(a)) return "";
    const ns = a[0], m = a.slice(1, 6), p = a.slice(6, 11);
    let d = "";
    if (/^\d\d[012]00$/.test(m) && /^00\d{3}$/.test(p)) d = m[0] + m[1] + p[2] + p[3] + p[4] + m[2];
    else if (/^\d{3}00$/.test(m) && /^000\d\d$/.test(p)) d = m.slice(0, 3) + p[3] + p[4] + "3";
    else if (/^\d{4}0$/.test(m) && /^0000\d$/.test(p)) d = m.slice(0, 4) + p[4] + "4";
    else if (/^0000[5-9]$/.test(p)) d = m + p[4];
    if (!d) return "";
    const e = ns + d + a[11];
    return upceToUpca(e) === a ? e : "";
  }
  /* A decoded or typed barcode → the digits as printed on the package, or "" when the check
     digit fails. UPC-A comes back as 12 digits (scanners often report it as EAN-13 "0…"),
     UPC-E as 8 digits (zxing reports it expanded), EAN-13 / EAN-8 as is. */
  function normalizeCode(raw, format) {
    let c = digitsOf(raw);
    const f = lc(format).replace(/[^a-z0-9]/g, "");
    if (!c) return "";
    if (f === "upce") {
      if (c.length === 13 && c[0] === "0") c = c.slice(1);
      if (c.length === 12) return upcaToUpce(c) || (gtinOk(c) ? c : "");
      return c.length === 8 && upceToUpca(c) ? c : "";
    }
    if (c.length === 14 && c[0] === "0") c = c.slice(1);
    if (c.length === 13 && c[0] === "0") c = c.slice(1);
    if (c.length === 12 || c.length === 13) return gtinOk(c) ? c : "";
    if (c.length === 8) return f === "ean8" ? (gtinOk(c) ? c : "") : (gtinOk(c) || upceToUpca(c) ? c : "");
    if (c.length === 11 && gtinOk("0" + c)) return "0" + c;       /* a UPC-A typed without its leading 0 */
    return "";
  }
  /* The keys to try, in order, for one code (Open Food Facts keeps most products under the
     13-digit GTIN, some UPC-E / EAN-8 products under the 8 printed digits). */
  function codeVariants(code) {
    const c = digitsOf(code), out = [];
    const add = v => { if (v && out.indexOf(v) < 0) out.push(v); };
    if (c.length === 8) {
      add(c);
      const a = upceToUpca(c); if (a) { add("0" + a); add(a); }
      if (gtinOk(c)) add("00000" + c);
    } else if (c.length === 11) {
      if (gtinOk("0" + c)) { add("00" + c); add("0" + c); }
      add(c);
    } else if (c.length === 12) {
      add("0" + c); add(c);
      const e = upcaToUpce(c); if (e) add(e);
    } else if (c.length === 13) {
      add(c);
      if (c[0] === "0") { add(c.slice(1)); const e = upcaToUpce(c.slice(1)); if (e) add(e); }
    } else if (c.length === 14) {
      add(c); if (c[0] === "0") add(c.slice(1));
    } else if (c) add(c);
    return out;
  }
  M.food.gtin = { check: gtinCheck, valid: gtinOk, upceToUpca, upcaToUpce, normalize: normalizeCode, variants: codeVariants };

  /* ======================================================================== */
  /* Open Food Facts                                                           */
  /* ======================================================================== */
  const OFF_BASE = "https://world.openfoodfacts.org";
  const OFF_FIELDS = "code,product_name,product_name_en,generic_name,generic_name_en,abbreviated_product_name,brands,serving_size,serving_quantity,serving_quantity_unit,quantity,nutrition_data_per,nutriments";
  const OFF_MSG = {
    busy: "Open Food Facts is busy. Try again in a minute, or scan the label.",
    down: "Open Food Facts isn't answering right now. Try again in a minute, or scan the label.",
    slow: "Open Food Facts is slow right now. Try again in a minute, or scan the label.",
    notFound: "This barcode isn't in Open Food Facts yet. Scan the label to add it.",
    store: "This is a store price sticker. Scan the label or type it in once. After that, this sticker finds it.",
    noNutrition: "Open Food Facts knows this item but has no nutrition numbers for it. Scan the label to add them.",
    noMacros: "Open Food Facts has calories but no protein, carbs or fat for this. Check them against the label.",
    offline: "No internet, so this barcode can't be looked up. Add it by hand now."
  };
  /* GET from Open Food Facts. When OFF is overloaded it answers 503 without CORS headers, which
     the browser reports as a network error. So while the phone is online, a failed request or a
     5xx is tried again after ~0.8 s (retries times), then reported as OFF being down — never as
     the person's connection. Slow requests are not repeated. → {ok, status, body} */
  async function offGet(url, ms, retries, deadline) {
    let last = null;
    for (let i = 0; i <= retries; i++) {
      if (i) {
        if (deadline && deadline - now() < 800 + 1500) break;
        await sleep(800 * i);
      }
      let r;
      try { r = await fetchJSON(url, { method: "GET", headers: { accept: "application/json" } }, deadline ? Math.min(ms, Math.max(1000, deadline - now())) : ms, "Open Food Facts"); }
      catch (e) {
        if (e.code === "offline" || e.code === "cancelled") throw e;
        if (e.code === "timeout") throw E("timeout", OFF_MSG.slow);
        if (isOffline()) throw E("offline", "You're offline. Check your connection and try again.");
        last = E("off_down", OFF_MSG.down);
        continue;
      }
      if (r.status >= 500) { last = E("off_down", OFF_MSG.down); continue; }
      return r;
    }
    throw last || E("off_down", OFF_MSG.down);
  }

  /* OFF's serving_quantity is grams (or ml, treated as grams); a few products store oz / lb / fl oz. */
  function servingGrams(sq, unit) {
    const q = num(sq, 0);
    if (!(q > 0)) return null;
    const u = lc(unit).replace(/\s+/g, "").replace(/\.$/, "");
    if (/^(oz|ounces?)$/.test(u)) return q * 28.35;
    if (/^(floz|fluidounces?)$/.test(u)) return q * 29.57;
    if (/^(lb|lbs|pounds?)$/.test(u)) return q * 453.6;
    if (/^(kg|kilograms?)$/.test(u)) return q * 1000;
    if (/^(l|liters?|litres?)$/.test(u)) return q * 1000;
    return q;
  }
  const FRAC = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 0.333, "⅔": 0.667, "⅛": 0.125 };
  function qtyOf(q) {
    q = String(q || "").trim();
    if (!q) return 1;
    if (FRAC[q]) return FRAC[q];
    let m = /^(\d+)\s*([½¼¾⅓⅔⅛])$/.exec(q); if (m) return num(m[1]) + FRAC[m[2]];
    m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(q); if (m) return num(m[1]) + num(m[2]) / (num(m[3]) || 1);
    m = /^(\d+)\/(\d+)$/.exec(q); if (m) return num(m[1]) / (num(m[2]) || 1);
    return num(q.replace(",", "."), 1);
  }
  /* "2/3 cup (55g)" / "30 g (1 oz)" / "1 cup (240mL)" / "55g" / "2/3 cup (55g/1.9 oz)" → {qty, unit, g}
     servingG (grams, already converted) wins over the grams printed in the string. */
  function parseServingSize(str, servingG) {
    const s = String(str || "").replace(/\s+/g, " ").trim();
    const parts = [];
    /* "(55g/1.9 oz)" holds two measures; "(1/4 cup)" is one fraction. Split only at a slash
       that follows a letter, or one with spaces around it. (No regex lookbehind: iOS 16.0–16.3.) */
    const measures = t => t.replace(/([A-Za-z.])\s*\/\s*/g, "$1\u0001").replace(/\s+\/\s+/g, "\u0001").split("\u0001").map(x => x.trim()).filter(Boolean);
    const paren = /\(([^)]*)\)/g; let m;
    while ((m = paren.exec(s))) measures(m[1]).forEach(x => parts.push(x));
    const outside = s.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    if (outside) measures(outside).forEach((x, i) => parts.splice(i, 0, x));
    const partOf = p => {
      const mm = /^(?:about|approx\.?|approximately|abt\.?)?\s*(\d+\s+\d+\/\d+|\d+\s*[½¼¾⅓⅔⅛]|\d+\/\d+|\d+(?:[.,]\d+)?|[½¼¾⅓⅔⅛])?\s*(.*)$/i.exec(p);
      if (!mm) return null;
      const qty = mm[1] ? qtyOf(mm[1]) : 1;
      let unit = (mm[2] || "").replace(/[.,;:]+$/, "").trim();
      const metric = /^(g|gr|grams?|ml|millilit(?:er|re)s?)$/i.test(unit);
      return { qty: qty > 0 ? +qty.toFixed(3) : 1, unit, metric, hasQty: !!mm[1] };
    };
    const parsed = parts.map(partOf).filter(Boolean);
    const metricPart = parsed.find(p => p.metric && p.hasQty);
    const house = parsed.find(p => !p.metric && p.unit && !/^(oz|ounces?|fl\.? ?oz)$/i.test(p.unit) ) || parsed.find(p => !p.metric && p.unit);
    let g = num(servingG, null);
    if (!(isNum(g) && g > 0)) g = metricPart ? metricPart.qty : null;
    if (!(isNum(g) && g > 0)) { const oz = parsed.find(p => /^(oz|ounces?)$/i.test(p.unit) && p.hasQty); if (oz) g = oz.qty * 28.35; }
    if (house) return { qty: house.qty, unit: tidyUnit(house.unit), g: isNum(g) && g > 0 ? r1(g) : null };
    if (metricPart) return { qty: metricPart.qty, unit: /ml|milli/i.test(metricPart.unit) ? "ml" : "g", g: isNum(g) && g > 0 ? r1(g) : r1(metricPart.qty) };
    if (isNum(g) && g > 0) return { qty: 1, unit: "serving", g: r1(g) };
    return { qty: 1, unit: "serving", g: null };
  }
  /* "BAR" → "bar"; "Tbsp" and "cup" stay as printed. */
  function tidyUnit(u) {
    u = String(u || "").replace(/\s+/g, " ").trim();
    if (!u) return "serving";
    const letters = u.replace(/[^A-Za-z]/g, "");
    return letters.length >= 2 && letters === letters.toUpperCase() ? u.toLowerCase() : u;
  }
  /* "5.3oz" / "14 fl oz (414 mL)" / "500 g" → grams of ONE package; null for multipacks. */
  function packageGrams(q) {
    const s = lc(q).replace(/,/g, ".");
    if (!s || /\d\s*[x×]\s*\d/.test(s) || /\b(pack|ct|count|pieces|bars|cups)\b/.test(s)) return null;
    const m = /(\d+(?:\.\d+)?)\s*(kg|g|gr|grams?|ml|l|cl|fl\.?\s*oz|oz|lbs?|pounds?)\b/.exec(s);
    if (!m) return null;
    const v = num(m[1]), u = m[2].replace(/\s+/g, "");
    const g = /^kg$/.test(u) ? v * 1000 : /^(g|gr|grams?|ml)$/.test(u) ? v : /^l$/.test(u) ? v * 1000 : /^cl$/.test(u) ? v * 10 : /^fl\.?oz$/.test(u) ? v * 29.57 : /^oz$/.test(u) ? v * 28.35 : v * 453.6;
    return g > 0 && g <= 5000 ? g : null;
  }
  const SMALL_WORD = /^(a|an|and|as|at|by|for|in|of|on|or|the|to|with|oz|lb|lbs|g|kg|mg|ml|l|fl|ct|pk)$/i;
  function tidyText(s) { return String(s == null ? "" : s).replace(/[®™©]/g, "").replace(/\s+/g, " ").replace(/^[\s\-–—,;:.]+|[\s\-–—,;:]+$/g, "").trim(); }
  const allCaps = s => { const l = String(s).replace(/[^A-Za-z]/g, ""); return l.length >= 3 && l.replace(/[^A-Z]/g, "").length / l.length >= 0.8; };
  function tidyCase(s) {
    s = String(s == null ? "" : s);
    const letters = s.replace(/[^A-Za-z]/g, "");
    if (letters.length < 3) return s;
    if (allCaps(s)) {
      /* word by word, also inside "COCA-COLA", "SA/NV", "ST.JOHN" */
      let n = 0;
      return s.replace(/[A-Za-z0-9']+/g, (w, at) => {
        const first = n++ === 0;
        if (/\d/.test(w)) return w.toLowerCase();
        if (!first && SMALL_WORD.test(w) && /[\s-]/.test(s.charAt(at - 1))) return w.toLowerCase();
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      });
    }
    /* SC-08: a few shouting words in a normal name ("Organic GREEK YOGURT plain · KIRKLAND
       Signature") read like the rest; short and known letter names (BBQ, USDA) stay */
    s = s.replace(/\b[A-Z][A-Z']{2,}\b/g, w => (KEEP_CAPS.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()));
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const KEEP_CAPS = /^(BBQ|USDA|USA|US|GMO|NON|DHA|EPA|MCT|UHT|XL|XXL|BLT|PB|PBJ|OJ|IPA|TV|UK|RTD|HTST|ESL|CBD|THC|KFC|IHOP|DQ|AB|JIF|ALDI|IGA|HEB|BJ'S|BJS|RX|RXBAR|CLIF|KIND|OREO|PAM|SPAM|NOW|OLLY)$/;
  function offBrand(p) { return cap(tidyCase(tidyText(String((p && p.brands) || "").split(",")[0]))); }
  /* English names first. A name that is only the brand ("Nutella") is swapped for the generic
     name only when that one reads as English ("Greek yogurt, vanilla", not "Pâte à tartiner"). */
  function offName(p, brand) {
    const get = k => tidyText(p && p[k]);
    const english = x => !!x && /^[\x20-\x7E]*$/.test(x);
    let name = get("product_name_en") || get("product_name") || get("abbreviated_product_name");
    const generic = get("generic_name_en") || (english(get("generic_name")) ? get("generic_name") : "");
    if (!name) name = get("generic_name_en") || get("generic_name");
    else if (brand && lc(name) === lc(brand) && generic && lc(generic) !== lc(brand)) name = generic;
    return cap(tidyCase(name));
  }

  /* Pure: OFF product JSON → Food | null (null = no nutrition numbers, or nothing to call it). */
  M.food.fromOFF = function (product) {
    if (!isObj(product)) return null;
    const N = isObj(product.nutriments) ? product.nutriments : {};
    const get = k => { const v = N[k]; if (v === undefined || v === null || v === "") return null; const n = num(v, null); return isNum(n) ? n : null; };
    const pos = v => (v !== null && v > 0 ? v : null);
    const code = digitsOf(product.code || product._id || product.id);
    const brand = offBrand(product);
    let name = offName(product, brand);
    /* energy: kcal first, then kJ ÷ 4.184; a stated 0 kcal (water, diet soda) is kept */
    const kcalOf = sfx => {
      const kc = get("energy-kcal" + sfx);
      if (kc !== null && kc > 0) return kc;
      const kj = pos(get("energy-kj" + sfx)) !== null ? get("energy-kj" + sfx) : pos(get("energy" + sfx));
      if (kj !== null) return kj / 4.184;
      if (kc === 0 || get("energy" + sfx) === 0) return 0;
      return null;
    };
    const mac = sfx => ({ p: get("proteins" + sfx), c: get("carbohydrates" + sfx), f: get("fat" + sfx), fiber: get("fiber" + sfx), sugar: get("sugars" + sfx) });
    const sodOf = sfx => { let v = get("sodium" + sfx); if (v === null) { const salt = get("salt" + sfx); if (salt !== null) v = salt / 2.5; } return v === null ? null : v * 1000; };
    const m100 = mac("_100g"), mS = mac("_serving");
    const est = m => ([m.p, m.c, m.f].filter(v => v !== null).length >= 2 ? num(m.p) * 4 + num(m.c) * 4 + num(m.f) * 9 : null);
    let kcal100 = kcalOf("_100g"), kcalS = kcalOf("_serving");
    if (kcal100 === null) kcal100 = est(m100);
    if (kcalS === null) kcalS = est(mS);
    if (kcal100 === null && kcalS === null) return null;
    if (!name) name = brand ? brand + " product" : code ? "Product " + code : "";
    if (!name) return null;
    const sod100 = sodOf("_100g"), sodS = sodOf("_serving");
    let per100g = kcal100 === null ? null : {
      cal: r0(kcal100), p: r1(num(m100.p)), c: r1(num(m100.c)), f: r1(num(m100.f)), fiber: r1(num(m100.fiber)), sugar: r1(num(m100.sugar)), sodium: r0(num(sod100))
    };
    const sqG = servingGrams(product.serving_quantity, product.serving_quantity_unit);
    const serving = parseServingSize(product.serving_size, sqG);
    const sg = sqG > 0 ? sqG : serving.g > 0 ? serving.g : null;
    let per;
    if (sg) {
      /* the label's own per-serving numbers when OFF has them, else per 100 g scaled */
      const sv = { cal: kcalS, p: mS.p, c: mS.c, f: mS.f, fiber: mS.fiber, sugar: mS.sugar, sodium: sodS };
      per = {};
      NUT.forEach(k => {
        let v = sv[k];
        if (v === null && per100g) v = per100g[k] * sg / 100;
        per[k] = v === null ? 0 : (k === "cal" || k === "sodium" ? r0(v) : r1(v));
      });
      if (!(serving.g > 0)) serving.g = r1(sg);
      if (!per100g) per100g = scaleTo100(per, sg);
    } else if (kcalS !== null) {
      /* serving numbers but no serving weight ("1 bar") */
      per = { cal: r0(kcalS), p: r1(num(mS.p)), c: r1(num(mS.c)), f: r1(num(mS.f)), fiber: r1(num(mS.fiber)), sugar: r1(num(mS.sugar)), sodium: r0(num(sodS)) };
    } else {
      per = Object.assign({}, per100g);
      serving.qty = 100; serving.unit = "g"; serving.g = 100;
    }
    const alts = [];
    if (per100g) { alts.push({ label: "100 g", g: 100 }); alts.push({ label: "1 oz", g: 28.35 }); }
    /* "1 package" only for a package someone eats in a sitting or two (not a 144 fl oz case) */
    const pg = packageGrams(product.quantity);
    /* SC-11: a package smaller than one serving is a wrong size ("100 g" on a 12 fl oz can) */
    if (pg && per100g && pg <= 1000 && !(serving.g > 0 && (Math.abs(pg - serving.g) <= 5 || pg > serving.g * 8 || pg < serving.g * 0.9))) alts.push({ label: "1 package", g: r1(pg) });
    const t = now();
    const food = {
      id: code ? "off_" + code : uid(), name, brand, barcode: code, source: "off",
      serving, per, per100g, alts, quantity: tidyText(product.quantity),
      createdAt: t, updatedAt: t, uses: 0, lastUsed: 0, pid: null
    };
    /* BEF-11: calories but no protein, carbs or fat means Open Food Facts is missing numbers */
    if (num(per.cal) >= 20 && num(per.p) + num(per.c) + num(per.f) < 1) food.warning = OFF_MSG.noMacros;
    return food;
  };

  function localByCode(code) {
    try { return M.foods && typeof M.foods.findByBarcode === "function" ? M.foods.findByBarcode(code) : null; } catch (e) { return null; }
  }
  /* K3: a built-in food they buy, by the codes on its package (`barcodes`), or a code they
     linked to a food ("Pick one of my foods": M.MS.codes[code] = foodId). UPC-A and EAN-13
     differ only by a leading 0, so codes are compared without leading zeros. */
  const codeKey = c => digitsOf(c).replace(/^0+/, "");
  function builtInByCode(code) {
    try {
      const k = codeKey(code);
      if (!k) return null;
      /* m-core's own lookup when it has one (same order: linked codes, then built-in codes) */
      if (M.foods && typeof M.foods.byCode === "function") { const f = M.foods.byCode(code); return isObj(f) && f.name ? f : null; }
      const codes = M.MS && isObj(M.MS.codes) ? M.MS.codes : null;
      if (codes) {
        for (const key of Object.keys(codes)) {
          if (codeKey(key) !== k) continue;
          const id = codes[key];
          const f = typeof id === "string" && M.foods && typeof M.foods.get === "function" ? M.foods.get(id) : null;
          if (isObj(f) && f.name) return f;
        }
      }
      const g = M.DB && Array.isArray(M.DB.generic) ? M.DB.generic : [];
      return g.find(f => f && Array.isArray(f.barcodes) && f.barcodes.some(b => codeKey(b) === k)) || null;
    } catch (e) { return null; }
  }
  M.food.builtInByCode = builtInByCode;
  /* "2" + 5-digit item number (+ price + check digits) → the first 6 digits, else "". */
  function priceItem(code) {
    let c = digitsOf(code);
    if (c.length === 13 && c[0] === "0") c = c.slice(1);
    return c.length === 12 && c[0] === "2" && gtinOk(c) ? c.slice(0, 6) : "";
  }
  function storeFood(item) {
    try {
      const list = M.foods && typeof M.foods.list === "function" ? M.foods.list() : [];
      return list.filter(f => f && priceItem(f.barcode) === item).sort((a, b) => num(b.lastUsed) - num(a.lastUsed) || num(b.updatedAt) - num(a.updatedAt))[0] || null;
    } catch (e) { return null; }
  }
  /* Scanned raw meat / fish or dry rice / pasta / quinoa takes the cook info (y, raw|dry) of
     the matching built-in food, so the servings screen offers raw AND cooked amounts. Its own
     label is the raw (or dry) profile; cooked = raw ÷ y. Already-cooked products are left
     alone. The rules below pick the built-in food for the tricky names; any other built-in
     food with cook info (cod, shrimp, scallops, quinoa …) matches when its main words are all
     in the product's name. */
  const COOK_RULES = [
    [/\bchicken\b.*\b(breasts?|tenders?|tenderloins?|cutlets?)\b|\b(breasts?|tenders?|tenderloins?)\b.*\bchicken\b/, "chicken_breast"],
    [/\bchicken\b.*\bthighs?\b|\bthighs?\b.*\bchicken\b/, "chicken_thigh"],
    [/\bground\b.*\bturkey\b|\bturkey\b.*\bground\b/, "ground_turkey_93"],
    [/\b(ground|minced?)\b.*\bbeef\b|\bbeef\b.*\bground\b|\bhamburger\b/, "ground_beef"],
    [/\bpork\b.*\b(tenderloins?|loins?|chops?)\b/, "pork_tenderloin"],
    [/\bsalmon\b/, "salmon"],
    [/\brice\b/, "white_rice"],
    [/\b(pasta|spaghetti|penne|rotini|macaroni|fettuccine|linguine|rigatoni|farfalle|fusilli|ziti|orzo|angel hair|lasagna|egg noodles|bowties?|elbows?)\b/, "pasta"]
  ];
  const NOT_RAW = /\b(cooked|precooked|pre-cooked|grilled|roasted|rotisserie|smoked|deli|sliced|lunch|jerky|canned|pouch|nuggets?|breaded|fried|crispy|sausages?|meatballs?|patty|patties|burgers?|broth|stock|soup|salad|sauce|dip|spread|bites|snacks?|chips|crackers?|cakes?|cereal|flour|milk|vinegar|pudding|krispies|bran|ramen|instant|ready|microwav\w*|minute|steamed|bowls?|meals?|dinner|entree|kit|mix|helper|cheese|strips|popcorn|stuffed|ravioli|tortellini|gnocchi|oil|cauliflower|broccoli|veggie|vegetable|cocktail|scampi|tempura|battered|puffs?|bars?|pilaf|risotto)\b/;
  /* the built-in food (with cook info) a scanned name stands for, or null */
  function cookBase(name) {
    const foods = builtInFoods().filter(f => isObj(f.cook) && num(f.cook.y) > 0);
    const rule = COOK_RULES.find(r => r[0].test(name));
    if (rule) {
      let slug = rule[1];
      if (slug === "ground_beef") { const m = /\b(\d{2})\s*(%|\/)/.exec(name); const lean = m ? num(m[1]) : 80; slug = lean >= 93 ? "ground_beef_93" : lean >= 90 ? "ground_beef_90" : lean >= 85 ? "ground_beef_85" : "ground_beef_80"; }
      /* ids m-data merged away (the plain chicken breast → the Kirkland breast) resolve
         through M.DB.alias; the chicken breast also by its alwaysRaw flag */
      const id = "g_" + slug, al = M.DB && isObj(M.DB.alias) ? M.DB.alias[id] : null;
      const hit = foods.find(f => f.id === id) || (isObj(al) && al.id ? foods.find(f => f.id === al.id) : null) ||
        (slug === "chicken_breast" ? foods.find(f => f === chickenBreast()) : null);
      if (hit) return hit;
    }
    const have = new Set(wordsOf(name));
    let best = null, bestN = 0;
    foods.forEach(f => {
      if (f.brand) return;
      const main = nameParts(f).head.filter(w => !/\d/.test(w) && !DESCRIPTOR.test(w) && !PACK_WORD.test(w) && !STATE_WORD.test(w));
      if (!main.length || !main.every(w => have.has(w))) return;
      if (main.length > bestN) { best = f; bestN = main.length; }
    });
    return best;
  }
  function cookFor(food) {
    try {
      if (!isObj(food) || !isObj(food.per100g) || !(num(food.per100g.cal) > 0)) return null;
      if (M.cook && typeof M.cook.of === "function" && M.cook.of(food)) return null;
      const name = lc(food.name).replace(/&/g, " and ");
      if (NOT_RAW.test(name)) return null;
      const base = cookBase(name);
      const bc = base && isObj(base.cook) ? base.cook : null;
      const y = bc ? num(bc.y) : 0;
      if (!(y > 0.05 && y < 20)) return null;
      /* "Ready rice" and friends: the label already reads like the cooked food */
      const rawCal = num(base.per100g && base.per100g.cal), ckCal = num(bc.per100gCooked && bc.per100gCooked.cal), cal = num(food.per100g.cal);
      if (rawCal > 0 && ckCal > 0 && Math.abs(cal - ckCal) < Math.abs(cal - rawCal) * 0.6) return null;
      const per100gCooked = {}; NUT.forEach(k => { per100gCooked[k] = r2(num(food.per100g[k]) / y); });
      const cook = { y, word: bc.word === "dry" ? "dry" : "raw", per100gCooked };
      if (cook.word === "dry" && Array.isArray(bc.alts) && bc.alts.length) cook.alts = bc.alts.map(a => Object.assign({}, a));
      return cook;
    } catch (e) { return null; }
  }
  M.food.cookFor = cookFor;
  function saveFound(f) {
    try {
      if (!f.cook) { const c = cookFor(f); if (c) f.cook = c; }
      /* Nick's rule: a scanned raw chicken breast (their Kirkland pack) is weighed raw, like the
         built-in breast (alwaysRaw: the servings screen, meals and recents read it raw) */
      if (isObj(f.cook) && f.cook.word === "raw" && /\bchicken\b/i.test(f.name) && /\bbreasts?\b/i.test(f.name)) f.alwaysRaw = true;
      if (!M.foods || typeof M.foods.add !== "function") return f;
      const have = f.barcode ? localByCode(f.barcode) : null;
      if (have) return have;
      if (M.MS && M.MS.foods && M.MS.foods[f.id]) return M.MS.foods[f.id];
      return M.foods.add(f);
    } catch (e) { return f; }
  }

  /* lookup(code) → {status:"found", food, saved:boolean}            (saved = it was already on this phone)
                  | {status:"no_nutrition", product:{name, brand, barcode, quantity}, message}
                  | {status:"not_found", message}
     Found products are saved to My foods (source "off", barcode set), so the next scan of
     the same item is instant and works offline. Rejects {code:"barcode"|"busy"|"off_down"|
     "offline"|"timeout"|"network", message}. */
  M.food.lookup = function (code, opt) {
    const reqMs = num(opt && opt.timeout) > 0 ? num(opt.timeout) : 8000;
    return Promise.resolve().then(async () => {
      const raw = digitsOf(code);
      if (raw.length < 6 || raw.length > 14) throw E("barcode", "That doesn't look like a barcode. Type the numbers under the bars.");
      if ([8, 12, 13].indexOf(raw.length) >= 0 && !gtinOk(raw) && !(raw.length === 8 && upceToUpca(raw))) throw E("barcode", "Those numbers don't match a real barcode. Check them and try again.");
      const vars = codeVariants(raw);
      for (const v of vars) { const f = localByCode(v); if (f) return (M.food.lastLookup = { status: "found", code: raw, food: f, saved: true }); }
      /* K3: then the built-in foods they buy (no internet needed) */
      for (const v of vars) {
        const f = builtInByCode(v);
        /* a second code linked to one of My foods comes back here too: that one isn't built in */
        const mine = !!(f && M.MS && isObj(M.MS.foods) && Object.prototype.hasOwnProperty.call(M.MS.foods, f.id));
        if (f) return (M.food.lastLookup = mine ? { status: "found", code: raw, food: f, saved: true } : { status: "found", code: raw, food: f, saved: true, builtIn: true });
      }
      /* A store's own price sticker (UPC-A starting with 2: item number, then the price). Open
         Food Facts can't know it; the same item keeps its first 6 digits whatever it costs. */
      const item = priceItem(raw);
      if (item) {
        const f = storeFood(item);
        if (f) return (M.food.lastLookup = { status: "found", code: raw, food: f, saved: true });
        return (M.food.lastLookup = { status: "not_found", code: raw, store: true, message: OFF_MSG.store });
      }
      /* OF-01: offline, don't try Open Food Facts; code "offline" (with the code) so the
         scanner stops and the sheet offers Add by hand / Scan label */
      if (isOffline()) throw E("offline", OFF_MSG.offline, { barcode: raw });
      const deadline = now() + Math.max(15000, reqMs * 2);
      let noNut = null, lastErr = null;
      for (const v of vars.slice(0, 3)) {
        const left = deadline - now(); if (left < Math.min(1500, reqMs)) break;
        let r;
        try {
          r = await offGet(OFF_BASE + "/api/v2/product/" + encodeURIComponent(v) + ".json?fields=" + OFF_FIELDS, Math.min(reqMs, left), 1, deadline);
        } catch (e) { lastErr = isE(e) && e.code === "offline" ? E("offline", OFF_MSG.offline, { barcode: raw }) : e; break; }
        if (r.status === 429) { lastErr = E("busy", OFF_MSG.busy); break; }
        lastErr = null;
        const p = r.body && isObj(r.body.product) ? r.body.product : null;
        if (!p || r.body.status === 0 || r.status === 404) continue;
        const f = M.food.fromOFF(p);
        if (f) {
          if (!f.barcode) { f.barcode = v; f.id = "off_" + v; }
          const warning = f.warning; delete f.warning;
          const out = { status: "found", code: raw, food: saveFound(f), saved: false };
          if (warning) out.warning = warning;
          return (M.food.lastLookup = out);
        }
        if (!noNut) { const brand = offBrand(p); noNut = { name: offName(p, brand), brand, barcode: digitsOf(p.code) || v, quantity: tidyText(p.quantity) }; }
      }
      if (noNut) return (M.food.lastLookup = { status: "no_nutrition", code: raw, product: noNut, message: OFF_MSG.noNutrition });
      if (lastErr) throw lastErr;
      return (M.food.lastLookup = { status: "not_found", code: raw, message: OFF_MSG.notFound });
    });
  };
  /* barcode(code) → Food | null (null = not in Open Food Facts, or no nutrition there;
     M.food.lastLookup says which). */
  M.food.barcode = function (code, opt) {
    return M.food.lookup(code, opt).then(r => (r.status === "found" ? r.food : null));
  };

  M.food.searchOFF = function (q) {
    return Promise.resolve().then(async () => {
      const s = String(q == null ? "" : q).trim();
      if (s.length < 2) return [];
      const url = OFF_BASE + "/cgi/search.pl?search_terms=" + encodeURIComponent(s) +
        "&search_simple=1&action=process&json=1&page_size=15&fields=" + OFF_FIELDS +
        "&tagtype_0=countries&tag_contains_0=contains&tag_0=united-states";
      const r = await offGet(url, 8000, 2, now() + 20000);
      if (r.status === 429) throw E("busy", "Open Food Facts is busy. Try again in a minute.");
      if (!r.ok || !r.body) throw E("off_down", OFF_MSG.down);
      const list = Array.isArray(r.body.products) ? r.body.products : [];
      const out = [], seen = new Set();
      list.forEach(p => {
        const f = M.food.fromOFF(p);
        if (!f || !(f.per.cal > 0 || (f.per100g && f.per100g.cal > 0))) return;
        const k = lc(f.name) + "|" + lc(f.brand);
        if (seen.has(k)) return;
        seen.add(k); out.push(f);
      });
      /* BEF-11: entries missing their macros go last; the flag isn't kept on a saved food */
      const good = out.filter(f => !f.warning), weak = out.filter(f => f.warning);
      weak.forEach(f => { delete f.warning; });
      return good.concat(weak);
    });
  };

  /* ======================================================================== */
  /* M.food.scanner — live camera barcode scanning                             */
  /* ======================================================================== */
  const SCAN = {
    bd: "https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/iife/ponyfill.js",
    /* the ponyfill runs only if its bytes match: SRI on the page, SHA-256 in the worker */
    bdSri: "sha384-KJVUIUGb4pmfpWXfD8j3y9ARn6KoGC2vPC/wNUX1O1ZkYemh0BsuvsmdEU2+wS7O",
    bdSha256: "e3aa2057178b8ea71dd97003270331bbcb46499197b68bc0c7dd18e40c0863ea",
    wasm: "https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.3/dist/reader/zxing_reader.wasm",
    formats: ["ean_13", "upc_a", "upc_e", "ean_8"],
    frameMs: 80,       /* ≈12 frames a second */
    agreeMs: 1500,     /* the second matching read must come this soon */
    dedupeMs: 3000,
    maxBandW: 1280,
    pageAfterMs: 3000, /* worker not ready by then → start the page engine as well */
    loadMs: 10000      /* give up loading the engine after this long */
  };
  const CAM = { audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } };
  const SCAN_MSG = {
    load: "The scanner couldn't load. Try again, or type the numbers under the bars.",
    loadOffline: "The scanner needs internet the first time. Add the food by hand for now.",
    loading: "Loading the scanner…",
    insecure: "The camera only works on a secure (https) page. Take a photo of the barcode or type the numbers.",
    noCamera: "This browser can't open the camera. Take a photo of the barcode or type the numbers.",
    blocked: "Chalk can't use the camera. Swipe Chalk closed, open it again, and tap Allow. Or turn on Camera in Settings → Apps → Safari → Camera.",
    none: "No camera found. Take a photo of the barcode or type the numbers.",
    busy: "The camera is busy. Close other apps that use it and try again, or take a photo of the barcode.",
    slow: "The camera took too long to start. Try again, or take a photo of the barcode.",
    failed: "The camera didn't start. Take a photo of the barcode or type the numbers."
  };
  function cameraErr(e) {
    if (isE(e) && e.code === "camera") return e;
    const name = String((e && e.name) || ""), msg = lc(e && (e.message || e));
    if (/NotAllowed|Permission|Security/i.test(name) || /denied|not allowed|permission/.test(msg)) return E("camera", SCAN_MSG.blocked);
    if (/NotFound|DevicesNotFound|Overconstrained/i.test(name) || /no camera|not found|requested device/.test(msg)) return E("camera", SCAN_MSG.none);
    if (/NotReadable|TrackStart|Abort/i.test(name) || /in use|could not start|not readable/.test(msg)) return E("camera", SCAN_MSG.busy);
    return E("camera", SCAN_MSG.failed);
  }

  /* ---- engines: {kind, detect(src) → Promise<[{rawValue, format}]>, close()} ---- */
  let enginePromise = null, engineKind = null, engineState = "none";
  const mapCodes = rs => (Array.isArray(rs) ? rs : []).map(r => ({ rawValue: String((r && r.rawValue) || ""), format: String((r && r.format) || "") }));
  function nativeEngine() {
    const BD = win().BarcodeDetector;
    if (typeof BD !== "function" || typeof BD.getSupportedFormats !== "function") return Promise.resolve(null);
    return withTimeout(Promise.resolve().then(() => BD.getSupportedFormats()), 2500).then(have => {
      have = Array.isArray(have) ? have : [];
      if (!SCAN.formats.every(f => have.indexOf(f) >= 0)) return null;
      const det = new BD({ formats: SCAN.formats });
      return { kind: "native", detect: src => Promise.resolve().then(() => det.detect(src)).then(mapCodes, () => []), close() {} };
    }).catch(() => null);
  }
  /* The worker fetches the ponyfill, checks its SHA-256, and only then runs it (importScripts
     has no SRI). No crypto.subtle (not a secure page) → the worker fails and the page engine,
     which has SRI, is used. The .wasm it loads can only do what this checked script lets it. */
  const WORKER_SRC = [
    "var det = null, boot = null;",
    "function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }",
    "function init() {",
    "  if (!boot) boot = fetch(" + JSON.stringify(SCAN.bd) + ", { mode: 'cors', credentials: 'omit' }).then(function (r) {",
    "    if (!r.ok) throw new Error('http ' + r.status);",
    "    return r.arrayBuffer();",
    "  }).then(function (buf) {",
    "    return self.crypto.subtle.digest('SHA-256', buf).then(function (h) {",
    "      if (hex(h) !== " + JSON.stringify(SCAN.bdSha256) + ") throw new Error('ponyfill hash mismatch');",
    "      var u = URL.createObjectURL(new Blob([buf], { type: 'text/javascript' }));",
    "      try { importScripts(u); } finally { URL.revokeObjectURL(u); }",
    "    });",
    "  }).then(function () {",
    "    var api = self.BarcodeDetectionAPI;",
    "    api.setZXingModuleOverrides({ locateFile: function (p, pre) { return /\\.wasm$/.test(p) ? " + JSON.stringify(SCAN.wasm) + " : pre + p; } });",
    "    det = new api.BarcodeDetector({ formats: " + JSON.stringify(SCAN.formats) + " });",
    "    return api.prepareZXingModule({ fireImmediately: true });",
    "  });",
    "  return boot;",
    "}",
    "self.onmessage = function (ev) {",
    "  var m = ev.data || {};",
    "  if (m.type === 'init') { init().then(function () { self.postMessage({ type: 'ready' }); }, function (e) { self.postMessage({ type: 'fail', message: String(e && e.message || e) }); }); return; }",
    "  if (m.type !== 'detect') return;",
    "  init().then(function () { return det.detect(new ImageData(new Uint8ClampedArray(m.buf), m.w, m.h)); }).then(",
    "    function (rs) { self.postMessage({ type: 'result', id: m.id, codes: (rs || []).map(function (r) { return { rawValue: r.rawValue, format: r.format }; }) }); },",
    "    function (e) { self.postMessage({ type: 'result', id: m.id, codes: [], error: String(e && e.message || e) }); });",
    "};"
  ].join("\n");
  function workerEngine() {
    const w = win();
    if (typeof w.Worker !== "function" || typeof Blob !== "function" || !w.URL || typeof w.URL.createObjectURL !== "function") return Promise.resolve(null);
    let url = "", worker = null;
    try { url = w.URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" })); worker = new w.Worker(url); }
    catch (e) { try { if (url) w.URL.revokeObjectURL(url); } catch (x) {} return Promise.resolve(null); }
    return new Promise(resolve => {
      let settled = false, seq = 0;
      const waits = new Map();
      const kill = () => { try { worker.terminate(); } catch (e) {} try { w.URL.revokeObjectURL(url); } catch (e) {} waits.forEach(cb => cb([])); waits.clear(); };
      const engine = {
        kind: "worker", misses: 0,
        detect(img, opt) {
          return new Promise(res => {
            if (!img || !img.data || !img.data.buffer) return res([]);
            const id = ++seq;
            const to = setTimeout(() => { if (waits.delete(id)) { engine.misses++; res([]); } }, num(opt && opt.timeout, 0) || 4000);
            waits.set(id, codes => { clearTimeout(to); engine.misses = 0; res(mapCodes(codes)); });
            try { worker.postMessage({ type: "detect", id, w: img.width, h: img.height, buf: img.data.buffer }, [img.data.buffer]); }
            catch (e) { waits.delete(id); clearTimeout(to); res([]); }
          });
        },
        close: kill
      };
      const t = setTimeout(() => { if (!settled) { settled = true; kill(); resolve(null); } }, 20000);
      worker.onerror = ev => { try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) {} if (!settled) { settled = true; clearTimeout(t); kill(); resolve(null); } };
      worker.onmessage = ev => {
        const m = (ev && ev.data) || {};
        if (m.type === "ready") { if (!settled) { settled = true; clearTimeout(t); resolve(engine); } return; }
        if (m.type === "fail") { if (!settled) { settled = true; clearTimeout(t); kill(); resolve(null); } return; }
        if (m.type === "result") { const cb = waits.get(m.id); if (cb) { waits.delete(m.id); cb(m.codes || []); } }
      };
      try { worker.postMessage({ type: "init" }); } catch (e) { settled = true; clearTimeout(t); kill(); resolve(null); }
    });
  }
  function mainEngine() {
    const ready = () => !!(win().BarcodeDetectionAPI && typeof win().BarcodeDetectionAPI.BarcodeDetector === "function");
    return loadScript(SCAN.bd, ready, 20000, "scanner_load", SCAN_MSG.load, SCAN.bdSri).then(() => {
      const api = win().BarcodeDetectionAPI;
      api.setZXingModuleOverrides({ locateFile: (p, pre) => (/\.wasm$/.test(p) ? SCAN.wasm : pre + p) });
      const det = new api.BarcodeDetector({ formats: SCAN.formats });
      return withTimeout(api.prepareZXingModule({ fireImmediately: true }), 25000, "scanner_load", SCAN_MSG.load)
        .then(() => ({ kind: "wasm", detect: src => Promise.resolve().then(() => det.detect(src)).then(mapCodes, () => []), close() {} }));
    });
  }
  const loadErr = () => E("scanner_load", isOffline() ? SCAN_MSG.loadOffline : SCAN_MSG.load);
  /* The worker engine starts at once; if it isn't ready after ~3 s (or fails) the page engine
     starts too. The first one ready wins, a late one is closed. Everything is given up after
     ~10 s. No offline check here: a cached copy (service worker) loads fine without a network,
     and the timeouts cover a dead one. */
  function raceEngines() {
    return new Promise((resolve, reject) => {
      let done = false, running = 0, pageOn = false, tPage = 0, tCap = 0;
      const finish = e => {
        if (done) { if (e) { try { e.close(); } catch (x) {} } return; }
        done = true; clearTimeout(tPage); clearTimeout(tCap);
        if (e) resolve(e); else reject(loadErr());
      };
      const failed = () => { running--; if (!pageOn) startPage(); else if (running <= 0) finish(null); };
      const startPage = () => { if (pageOn || done) return; pageOn = true; running++; mainEngine().then(finish, failed); };
      running++;
      workerEngine().then(e => (e ? finish(e) : failed()), failed);
      tPage = setTimeout(startPage, SCAN.pageAfterMs);
      tCap = setTimeout(() => finish(null), SCAN.loadMs);
    });
  }
  function getEngine() {
    if (!enginePromise) {
      engineState = "loading";
      enginePromise = Promise.resolve().then(async () => (await nativeEngine()) || raceEngines())
        .then(e => { engineKind = e.kind; engineState = "ready"; return e; }, err => { enginePromise = null; engineState = "failed"; throw isE(err) ? err : loadErr(); });
    }
    return enginePromise;
  }
  /* The worker went quiet (crashed / suspended): fall back to decoding on the page. */
  function demoteEngine(s) {
    if (!s.engine || s.engine.kind !== "worker" || s.demoting) return;
    s.demoting = true;
    try { s.engine.close(); } catch (e) {}
    enginePromise = mainEngine().then(e => { engineKind = e.kind; return e; }, err => { enginePromise = null; throw err; });
    enginePromise.then(e => { s.engine = e; s.demoting = false; }, () => { s.demoting = false; setMsg(s, SCAN_MSG.load); });
  }

  /* ---- what part of the video to decode ---- */
  /* The part of the video the person sees (object-fit: cover in a cw×ch box), then the middle
     band of it: full visible width, 60% of the visible height. Scaled to ≤1280 px wide. */
  function bandRect(vw, vh, cw, ch) {
    vw = num(vw); vh = num(vh);
    if (!(vw > 0 && vh > 0)) return null;
    let visW = vw, visH = vh;
    if (num(cw) > 0 && num(ch) > 0) { const k = Math.max(cw / vw, ch / vh); visW = Math.min(vw, cw / k); visH = Math.min(vh, ch / k); }
    const bw = visW, bh = Math.min(visH, Math.max(visH * 0.6, visW * 0.3));
    const k2 = Math.min(1, SCAN.maxBandW / bw);
    return { sx: Math.round((vw - bw) / 2), sy: Math.round((vh - bh) / 2), sw: Math.round(bw), sh: Math.round(bh), dw: Math.max(1, Math.round(bw * k2)), dh: Math.max(1, Math.round(bh * k2)) };
  }

  /* ---- accept rule: valid code, read on two decoded frames in a row, 3 s dedupe ---- */
  function makeAcceptor(opt) {
    opt = isObj(opt) ? opt : {};
    const agree = num(opt.agreeMs, SCAN.agreeMs), dedupe = num(opt.dedupeMs, SCAN.dedupeMs);
    let prev = [], prevAt = -1e15, hit = { code: "", at: -1e15 };
    return {
      /* codes = normalized codes read on this frame → [code] to hand over now (0 or 1) */
      frame(codes, at) {
        const cur = [];
        (codes || []).forEach(c => { if (c && cur.indexOf(c) < 0) cur.push(c); });
        if (!cur.length) return [];
        let out = null;
        if (at - prevAt <= agree) out = cur.find(c => prev.indexOf(c) >= 0 && !(hit.code === c && at - hit.at < dedupe)) || null;
        prev = cur; prevAt = at;
        if (!out) return [];
        hit = { code: out, at };
        prev = []; prevAt = -1e15;
        return [out];
      },
      reset() { prev = []; prevAt = -1e15; hit = { code: "", at: -1e15 }; }
    };
  }

  /* ---- beep (WebAudio, unlocked inside the tap that opened the scanner). Follows Chalk's own
     Sound setting (Settings → Sound), like its rest-timer beeps. ---- */
  let actx = null;
  const soundOn = () => { try { return !(typeof S !== "undefined" && S && S.settings && S.settings.sound === false); } catch (e) { return true; } };
  function primeAudio() {
    if (!soundOn()) return;
    try {
      const AC = win().AudioContext || win().webkitAudioContext;
      if (!AC) return;
      if (!actx) actx = new AC();
      if (actx.state === "suspended" && typeof actx.resume === "function") actx.resume().catch(() => {});
      const b = actx.createBuffer(1, 1, 22050), src = actx.createBufferSource();
      src.buffer = b; src.connect(actx.destination); src.start(0);
    } catch (e) {}
  }
  function beep() {
    try {
      if (!actx || !soundOn()) return;
      const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
      o.type = "sine"; o.frequency.value = 1760;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + 0.14);
    } catch (e) {}
  }

  /* ---- camera session ---- */
  let cur = null, startSeq = 0;
  function caps(track) { try { return track && typeof track.getCapabilities === "function" ? (track.getCapabilities() || {}) : {}; } catch (e) { return {}; } }
  function stopTracks(stream) { try { (stream && typeof stream.getTracks === "function" ? stream.getTracks() : []).forEach(t => { try { t.stop(); } catch (e) {} }); } catch (e) {} }
  const css = (el, s) => { el.style.cssText = s; return el; };
  function setMsg(s, m) {
    if (!s || !s.msg) return;
    m = m || "";
    if (s.msg.textContent !== m) s.msg.textContent = m;
    if (s.msgRow) s.msgRow.style.display = m ? "block" : "none";
  }

  function newSession(id, el, onCode, opt) {
    const d = doc();
    const s = { id, el, onCode, opt, stopped: false, live: false, stream: null, track: null, engine: null, timer: 0, acc: makeAcceptor(opt),
      canvas: null, ctx: null, torchOn: false, zoomed: false, prevStyle: el.getAttribute("style"), started: now(), lastRead: 0, frames: 0 };
    el.innerHTML = "";
    el.style.aspectRatio = "4 / 3";
    el.style.overflow = "hidden";
    if (!el.style.position) el.style.position = "relative";
    const root = css(d.createElement("div"), "position:absolute;top:0;left:0;right:0;bottom:0;overflow:hidden;border-radius:inherit;background:#000");
    root.setAttribute("data-scan", "");
    const v = d.createElement("video");
    ["playsinline", "webkit-playsinline", "muted", "autoplay"].forEach(a => v.setAttribute(a, ""));
    v.muted = true; v.autoplay = true; try { v.playsInline = true; } catch (e) {}
    css(v, "position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;display:block");
    const guide = css(d.createElement("div"), "position:absolute;left:7%;right:7%;top:22%;bottom:22%;border:2px solid rgba(255,255,255,.9);border-radius:10px;box-shadow:0 0 0 999px rgba(0,0,0,.28);pointer-events:none;transition:border-color .15s");
    const laser = css(d.createElement("div"), "position:absolute;left:11%;right:11%;top:50%;height:2px;margin-top:-1px;background:rgba(255,70,70,.85);box-shadow:0 0 6px rgba(255,70,70,.8);pointer-events:none");
    const msgRow = css(d.createElement("div"), "position:absolute;left:10px;right:10px;top:8px;text-align:center;pointer-events:none;display:none");
    const msg = css(d.createElement("span"), "display:inline-block;padding:6px 12px;border-radius:14px;background:rgba(0,0,0,.62);color:#fff;font:600 14px/1.3 Barlow,system-ui,sans-serif");
    msgRow.setAttribute("aria-live", "polite");
    msgRow.appendChild(msg);
    const ctl = css(d.createElement("div"), "position:absolute;right:8px;bottom:8px;display:flex;gap:8px");
    [v, guide, laser, msgRow, ctl].forEach(x => root.appendChild(x));
    el.appendChild(root);
    Object.assign(s, { root, video: v, guide, msg, msgRow, ctl });
    s.onVis = () => { const dd = doc(); if (s.stopped || !dd || dd.hidden) return; if (!s.track || s.track.readyState === "ended") revive(s); else { try { const p = s.video.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {} } };
    s.onEnded = () => { const dd = doc(); if (!s.stopped && dd && !dd.hidden) revive(s); };
    return s;
  }
  function paintControls(s) {
    if (!s || !s.ctl || s.stopped) return;
    const cp = caps(s.track), z = cp.zoom;
    const d = doc();
    s.ctl.innerHTML = "";
    const mk = (label, on, fn, aria) => {
      const b = d.createElement("button");
      b.type = "button"; b.textContent = label; b.setAttribute("aria-label", aria); b.setAttribute("aria-pressed", on ? "true" : "false");
      css(b, "min-width:44px;height:44px;padding:0 14px;border-radius:22px;border:1px solid " + (on ? "transparent" : "rgba(255,255,255,.45)") + ";background:" + (on ? "var(--acc,#f2c230)" : "rgba(0,0,0,.55)") + ";color:" + (on ? "var(--acc-ink,#141414)" : "#fff") + ";font:600 15px/1 'Barlow Condensed',Barlow,system-ui,sans-serif;letter-spacing:.03em;text-transform:uppercase;-webkit-tap-highlight-color:transparent");
      b.addEventListener("click", ev => { try { ev.preventDefault(); } catch (e) {} fn(); });
      s.ctl.appendChild(b);
    };
    if (cp.torch) mk("Light", s.torchOn, () => M.food.scanner.torch(!s.torchOn), s.torchOn ? "Turn the light off" : "Turn the light on");
    if (z && num(z.max) >= 1.9) mk("2\u00d7", s.zoomed, () => M.food.scanner.zoom(s.zoomed ? 1 : 2), s.zoomed ? "Zoom out" : "Zoom in 2 times");
  }
  function flash(s) {
    if (!s.guide) return;
    s.guide.style.borderColor = "var(--ok,#3ecf6e)";
    setTimeout(() => { if (s.guide) s.guide.style.borderColor = "rgba(255,255,255,.9)"; }, 450);
  }
  function hint(s) {
    const t = now(), idle = t - Math.max(s.started, s.lastRead);
    let m = "";
    if (idle > 12000) m = caps(s.track).torch && !s.torchOn ? "Blurry or dark? Move back a little, or tap Light." : "Blurry? Move the phone back a little.";
    else if (idle > 6000) m = "Fill the box with the barcode. Hold still.";
    setMsg(s, m);
  }
  async function openCamera() {
    const md = nav().mediaDevices;
    const tries = [CAM, { audio: false, video: { facingMode: { ideal: "environment" } } }, { audio: false, video: true }];
    let last = null;
    for (const c of tries) {
      let p;
      try { p = Promise.resolve(md.getUserMedia(c)); }
      catch (e) { last = e; if (!/Overconstrained|TypeError|NotFound/i.test(String(e && e.name))) break; continue; }
      try { return await withTimeout(p, 30000, "camera", SCAN_MSG.slow); }
      catch (e) {
        last = e;
        if (isE(e)) { p.then(stopTracks, () => {}); break; }       /* timed out: if it opens later, close it */
        if (!/Overconstrained|TypeError|NotFound/i.test(String(e && e.name))) break;
      }
    }
    throw cameraErr(last);
  }
  function attach(s, stream) {
    s.stream = stream;
    s.track = (stream && typeof stream.getVideoTracks === "function" && stream.getVideoTracks()[0]) || null;
    try { s.video.srcObject = stream; } catch (e) {}
    try { const p = s.video.play(); if (p && typeof p.catch === "function") p.catch(() => {}); } catch (e) {}
    if (s.track && typeof s.track.addEventListener === "function") s.track.addEventListener("ended", s.onEnded);
  }
  function autoZoom(s) {
    if (s.opt && s.opt.zoom === false) return Promise.resolve(false);
    const z = caps(s.track).zoom;
    if (!(z && num(z.max) >= 1.9)) return Promise.resolve(false);
    return M.food.scanner.zoom(2);
  }
  async function revive(s) {
    if (s.reviving || s.stopped) return;
    s.reviving = true;
    try {
      const stream = await openCamera();
      if (s.stopped) { stopTracks(stream); return; }
      if (s.track && typeof s.track.removeEventListener === "function") s.track.removeEventListener("ended", s.onEnded);
      stopTracks(s.stream);
      s.torchOn = false; s.zoomed = false;
      attach(s, stream);
      await autoZoom(s);
      paintControls(s);
      setMsg(s, "");
    } catch (e) { setMsg(s, cameraErr(e).message); }
    finally { s.reviving = false; }
  }
  function stopSession(s) {
    if (!s) return Promise.resolve();
    s.stopped = true; s.live = false;
    if (cur === s) cur = null;
    clearTimeout(s.timer);
    try { const d = doc(); if (d) d.removeEventListener("visibilitychange", s.onVis); } catch (e) {}
    try { if (s.track && typeof s.track.removeEventListener === "function") s.track.removeEventListener("ended", s.onEnded); } catch (e) {}
    stopTracks(s.stream); s.stream = null; s.track = null;
    if (s.video) { try { s.video.pause(); } catch (e) {} try { s.video.srcObject = null; } catch (e) {} }
    try { s.el.innerHTML = ""; } catch (e) {}
    try { if (s.prevStyle == null) s.el.removeAttribute("style"); else s.el.setAttribute("style", s.prevStyle); } catch (e) {}
    s.canvas = null; s.ctx = null; s.video = null; s.root = null; s.guide = null; s.msg = null; s.msgRow = null; s.ctl = null;
    return Promise.resolve();
  }
  function grabBand(s) {
    const v = s.video;
    if (!v || !(v.readyState >= 2) || !v.videoWidth || !v.videoHeight) return null;
    const r = bandRect(v.videoWidth, v.videoHeight, s.root ? s.root.clientWidth : 0, s.root ? s.root.clientHeight : 0);
    if (!r) return null;
    if (!s.canvas) { s.canvas = doc().createElement("canvas"); s.ctx = null; }
    const c = s.canvas;
    if (c.width !== r.dw || c.height !== r.dh) { c.width = r.dw; c.height = r.dh; s.ctx = null; }
    if (!s.ctx) { try { s.ctx = c.getContext("2d", { willReadFrequently: true }); } catch (e) { s.ctx = null; } }
    if (!s.ctx) return null;
    s.ctx.drawImage(v, r.sx, r.sy, r.sw, r.sh, 0, 0, r.dw, r.dh);
    return s.engine.kind === "native" ? c : s.ctx.getImageData(0, 0, r.dw, r.dh);
  }
  async function scanFrame(s) {
    const d = doc();
    if (d && d.hidden) return;
    const grab = typeof M.food.scanner._grab === "function" ? M.food.scanner._grab : grabBand;
    const src = grab(s);
    if (!src) return;
    const engine = s.engine;
    const res = await engine.detect(src);
    if (s.stopped) return;
    if (engine.kind === "worker" && engine.misses >= 3) demoteEngine(s);
    const codes = [];
    (res || []).forEach(r => { const c = normalizeCode(r && r.rawValue, r && r.format); if (c) codes.push(c); });
    s.frames++;
    if (codes.length) s.lastRead = now();
    const hits = s.acc.frame(codes, now());
    if (!hits.length) return;
    try { const n = nav(); if (typeof n.vibrate === "function") n.vibrate(60); } catch (e) {}
    beep(); flash(s); setMsg(s, "");
    try { if (typeof s.onCode === "function") s.onCode(hits[0]); } catch (e) {}
  }
  function loop(s) {
    if (s.stopped) return;
    const t0 = now();
    Promise.resolve().then(() => scanFrame(s)).catch(() => {}).then(() => {
      if (s.stopped) return;
      hint(s);
      s.timer = setTimeout(() => loop(s), Math.max(10, SCAN.frameMs - (now() - t0)));
    });
  }

  M.food.scanner = {
    running() { return !!(cur && cur.live && !cur.stopped); },
    /* "native" | "worker" | "wasm" | null (not loaded yet) */
    engine() { return engineKind; },
    /* The decoder: "none" (not asked for yet) | "loading" | "ready" | "failed". While it is
       "loading" the camera box itself shows "Loading the scanner…" (start's opt.onState gets
       "loading" then "ready" too). */
    state() { return engineState; },
    /* Load the decoder ahead of time (e.g. when the Add sheet opens). → kind | null */
    preload() { return getEngine().then(e => e.kind, () => null); },
    /* start(containerEl, onCode, {zoom?:false}) → true once the camera is live and decoding
       (false if stop() was called meanwhile). onCode(code) gets the digits as printed.
       Rejects {code:"camera"} (blocked / no camera / insecure page) or {code:"scanner_load"}. */
    start(containerEl, onCode, opt) {
      opt = isObj(opt) ? opt : {};
      primeAudio();
      const id = ++startSeq;
      let s = null;
      const alive = () => id === startSeq && (!s || !s.stopped);
      return Promise.resolve().then(async () => {
        if (!containerEl || !doc()) throw E("scanner", "Nowhere to show the camera.");
        await stopSession(cur);
        if (!alive()) return false;
        const w = win(), n = nav();
        if (w.isSecureContext === false) throw E("camera", SCAN_MSG.insecure);
        if (!n.mediaDevices || typeof n.mediaDevices.getUserMedia !== "function") throw E("camera", SCAN_MSG.noCamera);
        s = newSession(id, containerEl, onCode, opt);
        cur = s;
        const eng = getEngine(); eng.catch(() => {});
        let stream;
        try { stream = await openCamera(); }
        catch (e) { await stopSession(s); throw cameraErr(e); }
        if (!alive()) { stopTracks(stream); await stopSession(s); return false; }
        attach(s, stream);
        if (engineState !== "ready") {
          setMsg(s, SCAN_MSG.loading);
          try { if (typeof opt.onState === "function") opt.onState("loading"); } catch (e) {}
        }
        let engine;
        try { engine = await eng; }
        catch (e) { await stopSession(s); throw isE(e) ? e : loadErr(); }
        if (!alive()) { await stopSession(s); return false; }
        setMsg(s, "");
        try { if (typeof opt.onState === "function") opt.onState("ready"); } catch (e) {}
        s.engine = engine; s.live = true; s.started = now();
        await autoZoom(s);
        paintControls(s);
        const d = doc(); if (d) d.addEventListener("visibilitychange", s.onVis);
        loop(s);
        return true;
      });
    },
    /* Safe to call any time, any number of times; releases the camera (every track stopped). */
    stop() { startSeq++; return stopSession(cur).then(() => true); },
    hasTorch() { return !!(cur && cur.track && caps(cur.track).torch); },
    torch(on) {
      const s = cur;
      if (!s || !s.track || !caps(s.track).torch) return Promise.resolve(false);
      return Promise.resolve().then(() => s.track.applyConstraints({ advanced: [{ torch: !!on }] }))
        .then(() => { s.torchOn = !!on; paintControls(s); return s.torchOn; }, () => { paintControls(s); return false; });
    },
    hasZoom() { const z = cur && cur.track && caps(cur.track).zoom; return !!(z && num(z.max) >= 1.9); },
    zoom(level) {
      const s = cur, z = s && s.track ? caps(s.track).zoom : null;
      if (!s || !z || !(num(z.max) > num(z.min, 1))) return Promise.resolve(false);
      const v = Math.max(num(z.min, 1), Math.min(num(z.max, 1), num(level, 1)));
      return Promise.resolve().then(() => s.track.applyConstraints({ advanced: [{ zoom: v }] }))
        .then(() => { s.zoomed = v > 1.01; paintControls(s); return true; }, () => false);
    },
    /* fromImage(file) → code string | null. A still photo, tried whole, center 60%, and at two sizes. */
    fromImage(file) {
      return Promise.resolve().then(async () => {
        if (!file) return null;
        if (!doc()) throw E("scanner", "No canvas here.");
        const engine = await getEngine();
        const im = await withTimeout(decodeImage(file), 20000, "image", "Reading that photo took too long.");
        try {
          const tries = [{ crop: 1, max: 1600 }, { crop: 0.6, max: 1600 }, { crop: 1, max: 1000 }, { crop: 1, max: 2400 }];
          for (const t of tries) {
            const cw = im.w * t.crop, ch = im.h * t.crop, k = Math.min(1, t.max / Math.max(cw, ch, 1));
            const c = newCanvas(cw * k, ch * k);
            const ctx = c.getContext("2d", { willReadFrequently: true });
            if (!ctx) return null;
            ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
            ctx.drawImage(im.src, (im.w - cw) / 2, (im.h - ch) / 2, cw, ch, 0, 0, c.width, c.height);
            const src = engine.kind === "native" ? c : ctx.getImageData(0, 0, c.width, c.height);
            const res = await engine.detect(src, { timeout: 10000 });
            for (const r of res || []) { const code = normalizeCode(r.rawValue, r.format); if (code) return code; }
          }
          return null;
        } finally { im.close(); }
      });
    },
    /* test hooks */
    _setEngine(e) {
      if (e && typeof e.then === "function") { enginePromise = e; engineKind = null; engineState = "loading"; e.then(x => { engineKind = x && x.kind; engineState = "ready"; }, () => { engineState = "failed"; }); return; }
      enginePromise = e ? Promise.resolve(e) : null; engineKind = e ? e.kind : null; engineState = e ? "ready" : "none";
    },
    _grab: null,
    _cur() { return cur; }
  };

  /* ======================================================================== */
  /* M.food.label — Nutrition Facts parser (pure) + reader (Claude or OCR)     */
  /* ======================================================================== */
  /* OCR digit confusions inside a number: O→0 l/I/|→1 S→5 B→8 Z→2 */
  const OCR_DIGITS = "0-9OoDQlIi|!SsBZz";
  const ocrDigits = tok => String(tok || "").trim().replace(/[OoDQ]/g, "0").replace(/[lIi|!]/g, "1").replace(/[Ss]/g, "5").replace(/[B]/g, "8").replace(/[Zz]/g, "2");
  function fixNum(tok) {
    let s = ocrDigits(tok);
    if (/^\d{1,3},\d{3}$/.test(s)) s = s.replace(",", "");        /* 1,020 mg */
    s = s.replace(/,/g, ".").replace(/[^\d.\/]/g, "");
    if (s.includes("/")) { const [a, b] = s.split("/"); const d = num(b); return d ? num(a) / d : num(a, NaN); }
    const v = parseFloat(s);
    return isNum(v) ? v : NaN;
  }
  /* A value token as OCR writes it: real digits with O/l/I/S/B confusions (≥1 real digit, or a
     lone O / l / S standing before a unit, as in "Trans Fat Og" or "Protein Sg"), an optional
     decimal, then a unit ("mq" and "rng" are a misread "mg"). */
  const VALUE_RE = new RegExp("(<\\s*|less\\s+than\\s+)?((?:\\d[" + OCR_DIGITS + "]*|[" + OCR_DIGITS + "]*\\d[" + OCR_DIGITS + "]*|[OolI|S](?=\\s*m?g\\b))(?:[.,]\\d+)?)\\s*(mg|mcg|µg|mq|rng|rnq|kcal|kj|cal|g|9|q)?(?![a-z0-9])", "gi");
  function valuesIn(tail) {
    const out = []; let m;
    VALUE_RE.lastIndex = 0;
    while ((m = VALUE_RE.exec(tail))) {
      if (!m[2]) { VALUE_RE.lastIndex++; continue; }
      if (!/\d/.test(m[2]) && m.index > 0 && !/[\s(:]/.test(tail[m.index - 1])) continue;   /* a lone letter must stand alone */
      const after = tail.slice(m.index + m[0].length).replace(/^\s+/, "");
      if (after[0] === "%" && !m[3]) continue;                           /* a % Daily Value */
      const v = m[1] ? 0.5 : fixNum(m[2]);
      if (!isNum(v)) continue;
      let unit = lc(m[3] || ""); if (/^(mq|rng|rnq)$/.test(unit)) unit = "mg";
      out.push({ v, unit, raw: m[2], lt: !!m[1] });
    }
    return out;
  }
  /* Label words end at "not followed by a letter" (not \b) so OCR that drops the space
     ("TotalFat8g", "Sodium160mg", "Protein3g") still matches. "rn" is a misread "m". */
  const T = "t[o0]ta[l1I|]", NL = "(?![a-z])", SOD = "s[o0]d[i1l|]u(?:m|rn)";
  const LINE = {
    footnote: /daily\s*value|daily\s*diet|a\s*day\s*is|calories\s*a\s*day|\bdiet\b|per\s*gram|nutrition\s*advice|contributes|percent\s*daily|not\s*a\s*significant/i,
    cal: new RegExp("\\b(ca[l1I|][o0]r[i1l|]e?s|calor[i1l|]es|energy|[eé]nergie|kcal)" + NL, "i"),
    fat: new RegExp("\\b" + T + "\\s*fat" + NL + "|^\\s*(fat|lipides|l[i1]pids)" + NL, "i"),
    sodium: new RegExp("\\b" + SOD + NL, "i"),
    carb: new RegExp("\\b" + T + "\\s*carb[a-z]*\\.?|^\\s*(carbohydrates?|carbs?|glucides)" + NL, "i"),
    fiber: new RegExp("\\b(dietary\\s*)?f[i1l|]b(er|re)s?" + NL, "i"),
    sugar: new RegExp("\\b" + T + "\\s*sugars?" + NL + "|^\\s*(sugars?|sucres)" + NL + "|\\bof\\s*which\\s*sugars?" + NL, "i"),
    protein: new RegExp("\\bpr[o0]te[i1l|]ns?" + NL + "|\\bprot[eé]ines" + NL, "i"),
    salt: /^\s*salt(?![a-z])/i
  };
  const KEYS = { cal: "cal", fat: "f", sodium: "sodium", carb: "c", fiber: "fiber", sugar: "sugar", protein: "p" };
  const SUBLINE = { fat: /saturated|trans|sat\.|poly|mono|calories\s*from/i, carb: /net\s*carb|sugar/i, fiber: /soluble|insoluble/i, sugar: /added|includes|alcohol|incl\./i, cal: /from\s*fat|per\s*gram/i, protein: /%\s*dv\s*$/i, sodium: /^$/ };
  /* the label word itself, removed before reading the number */
  const LABEL_WORD = {
    cal: new RegExp("^.*?\\b(ca[l1I|][o0]r[i1l|]e?s|calor[i1l|]es|energy|[eé]nergie|kcal)" + NL + "(\\s*/\\s*calories" + NL + ")?", "i"),
    fat: new RegExp("^.*?(" + T + "\\s*fat|fat|lipides|l[i1]pids)" + NL + "(\\s*/\\s*lipides" + NL + ")?", "i"),
    sodium: new RegExp("^.*?\\b" + SOD + NL + "(\\s*/\\s*sodium" + NL + ")?", "i"),
    carb: new RegExp("^.*?(" + T + "\\s*carb[a-z]*\\.?|carbohydrates?|carbs?)(\\s*/\\s*glucides" + NL + ")?|^\\s*glucides" + NL, "i"),
    fiber: new RegExp("^.*?\\b(dietary\\s*)?f[i1l|]b(er|re)s?" + NL + "(\\s*/\\s*fibres?" + NL + ")?", "i"),
    sugar: new RegExp("^.*?(" + T + "\\s*sugars?|sugars?|sucres)" + NL + "(\\s*/\\s*sucres" + NL + ")?", "i"),
    protein: new RegExp("^.*?\\b(pr[o0]te[i1l|]ns?|prot[eé]ines)" + NL + "(\\s*/\\s*prot[eé]ines" + NL + ")?", "i")
  };
  const NUTR_WORD = /calories|\bfat\b|cholest|s[o0]d[i1l|]u(m|rn)|carb|f[i1l|]b(er|re)|sugars?|pr[o0]te[i1l|]n|vitamin|calcium|iron|potassium|\bsalt\b/i;
  const NUTR_COUNT = /calories|total\s*fat|sat(urated|\.)?\s*fat|trans\s*fat|cholest|s[o0]d[i1l|]u(m|rn)|carb|f[i1l|]ber|sugars|pr[o0]te[i1l|]n/gi;
  /* words printed on packages that are not the product's name */
  const PACKAGE = /keep\s*(refrigerated|frozen|cold)|refrigerat|perishable|net\s*w(t|eight)|ingredients|contains|distributed|manufactured|best\s*(by|before)|use\s*by|sell\s*by|product\s*of|thaw|safe\s*handling|cook\s*thoroughly|serving|calories|amount/i;
  function pickValue(field, vals) {
    if (!vals.length) return null;
    if (field === "cal") {
      const kcal = vals.find(v => v.unit === "kcal" || v.unit === "cal");
      if (kcal) return kcal;
      const kj = vals.find(v => v.unit === "kj");
      if (kj && vals.length === 1) return { v: kj.v / 4.184, unit: "kcal", raw: kj.raw };
      return vals.find(v => v.unit !== "kj" && v.unit !== "g" && v.unit !== "mg") || (kj ? { v: kj.v / 4.184, unit: "kcal", raw: kj.raw } : null);
    }
    if (field === "sodium") return vals.find(v => v.unit === "mg" || v.unit === "g") || vals[0];
    return vals.find(v => v.unit !== "mg" && v.unit !== "kcal" && v.unit !== "kj") || null;
  }
  /* Big bold digits OCR'd apart ("Calories 1 9 0"); a fat value that lost its point ("4 5g"). */
  function tidyTail(field, tail) {
    let t = String(tail);
    if (field === "cal") t = t.replace(/^(\s*)(\d)((?:\s\d){1,3})(?!\d)(?!\s*%)/, (m0, sp, a, rest) => sp + a + rest.replace(/\s/g, ""));
    if (field === "fat") t = t.replace(/^(\s*)([0-4])\s(5)\s*g(?![a-z])/i, "$1$2.$3g");
    return t;
  }
  /* A column split by OCR: nutrient names on consecutive lines, then their values on the lines
     after ("Total Fat / Sodium / Protein / 8g / 160mg / 3g"). → {labelLineIndex: valueLineIndex} */
  function columnPairs(lines, numberish) {
    const map = {};
    const label = l => NUTR_WORD.test(l) && !/\d/.test(l) && !LINE.footnote.test(l);
    for (let i = 0; i < lines.length;) {
      if (!label(lines[i])) { i++; continue; }
      let j = i; while (j < lines.length && label(lines[j])) j++;
      let k = j; while (k < lines.length && numberish(lines[k])) k++;
      if (j - i >= 2 && k - j >= j - i) for (let x = 0; x < j - i; x++) map[i + x] = j + x;
      i = j;
    }
    return map;
  }
  function servingPart(text) {
    const lines = String(text).split("\n").map(l => l.replace(/\s+/g, " ").trim());
    const looks = l => /(\d|[½¼¾⅓⅔])\s*[a-zA-Z(]|\(\s*[\dOolI|.,]+\s*(g|9|ml|mL)\b/i.test(l) && !/calories|servings?\s*per|per\s*container|amount\s*per|%/i.test(l);
    const si = lines.findIndex(l => /serv(ing)?\.?\s*size|portion\s*size|^\s*per\s+(\d|[½¼¾⅓⅔]|one\b)/i.test(l));
    let cand = null;
    if (si >= 0) {
      const same = lines[si].replace(/^.*?(serv(ing)?\.?\s*size|portion\s*size)[:\s]*/i, "").replace(/^\s*per\s+/i, "").trim();
      if (same && looks(same)) cand = same;
      if (!cand && si + 1 < lines.length && looks(lines[si + 1])) cand = lines[si + 1];
      if (!cand && si > 0 && looks(lines[si - 1])) cand = lines[si - 1];
    }
    if (!cand) {
      /* "1 tortilla (45g)" anywhere: OCR can move the right half of the row away from "Serving size" */
      const any = /^(?:about\s*)?(\d+\s+\d\/\d|\d+\/\d+|\d+(?:[.,]\d+)?|[½¼¾⅓⅔])\s*[a-zA-Z][a-zA-Z .-]{0,24}\(\s*[\dOolI|.,]+\s*(g|9|q|ml)\s*\)/i;
      const l = lines.find(x => any.test(x) && !/calories|servings?\s*per|per\s*container|amount\s*per|%/i.test(x));
      if (l) cand = any.exec(l)[0];
    }
    if (!cand) return null;
    return cand.replace(/\s*\/\s*(pour|par|por)\b.*$/i, "").replace(/\s*(about|approx\.?)\s*/gi, " ").trim();
  }
  function parseServingLine(text) {
    const cand = servingPart(text);
    if (!cand) return null;
    /* OCR fixes inside numbers: "(55q)" "(5Og)" "l cup" */
    const fixed = cand.replace(/\(\s*([\dOolI|.,]+)\s*(9|q)\s*\)/gi, "($1g)").replace(/(^|[\s(])([OolI|]?\d[\dOolI|]*|[OolI|]\d*)(?=\s*(g|ml|cup|tbsp|tsp|oz|piece|slice|bar|container|package|bottle|can)\b)/gi, (m0, pre, n) => pre + String(fixNum(n)));
    const sv = parseServingSize(fixed, null);
    if (!sv || (!sv.g && sv.unit === "serving")) return null;
    return { qty: sv.qty, unit: sv.unit, g: sv.g };
  }
  const SPC = "serv[i1l|]ngs?\\s+per\\s+c[o0]nta[i1l|]ner";
  function servingsPerContainer(text) {
    const s = String(text);
    let m = new RegExp("(?:about|approx\\.?|abt\\.?)?\\s*([\\d.,]+)\\s+" + SPC, "i").exec(s);
    if (m) return num(m[1], null);
    m = new RegExp(SPC + "[:\\s]*(?:about|approx\\.?|abt\\.?)?\\s*([\\d.,]+)", "i").exec(s);
    return m ? num(m[1], null) : null;
  }
  /* "39" read for "3g" (the 9 is a misread g), "30g" for "3g": each such protein / carb / fat
     number also has a ÷10 reading. The mix of readings whose 4p + 4c + 9f lands close to the
     label's calories wins, but only when the numbers as read are clearly off. Sugar and fiber
     can't be more than the carbs. Every number changed here goes into `check`. */
  function fixGlued(per, found, check, polyols) {
    const cal = num(per.cal);
    const sus = ["p", "c", "f"].filter(k => found[k] && found[k].alt !== null && !(k === "c" && polyols));
    if (sus.length && found.cal && cal >= 20) {
      const kcal = o => num(o.p) * 4 + num(o.c) * 4 + num(o.f) * 9;
      const err = o => Math.abs(kcal(o) - cal) / cal;
      const e0 = err(per);
      let best = null, bestErr = Infinity, bestKeys = [];
      if (e0 > 0.3) {
        for (let mask = 1; mask < (1 << sus.length); mask++) {
          const o = Object.assign({}, per), keys = [];
          let weak = false;
          sus.forEach((k, i) => { if (mask & (1 << i)) { o[k] = found[k].alt; keys.push(k); if (found[k].weak) weak = true; } });
          const e = err(o);
          const ok = weak ? e0 > 0.5 && e <= 0.12 : e <= 0.2;
          if (ok && (e < bestErr - 1e-9 || (Math.abs(e - bestErr) <= 1e-9 && keys.length < bestKeys.length))) { best = o; bestErr = e; bestKeys = keys; }
        }
      }
      if (best) { Object.assign(per, best); bestKeys.forEach(k => { check.push(k); }); }
    }
    ["fiber", "sugar"].forEach(k => {
      if (!found[k] || !found.c || !(num(per[k]) > num(per.c) + 0.5)) return;
      const alt = found[k].alt;
      per[k] = alt !== null && alt <= num(per.c) + 0.5 ? alt : num(per.c);
      check.push(k);
    });
  }
  /* Serving grams that can't be right: more calories than pure fat, one tortilla = 459 g, or a
     solid food lighter than lettuce. A trailing 9 is often a misread g ("(459g)" for "(45g)").
     → null (fine) | {g, was} (g = what to use) */
  const COUNT_UNIT = /^(tortillas?|slices?|bars?|pieces?|pcs?|cookies?|crackers?|eggs?|muffins?|waffles?|pancakes?|links?|sticks?|biscuits?|rolls?|buns?|pitas?|wraps?|patty|patties|nuggets?|pretzels?|scoops?|pouch(es)?|packets?|envelopes?|squares?|cakes?)$/i;
  const SPOON_G = { tbsp: 45, tablespoon: 45, tablespoons: 45, tsp: 15, teaspoon: 15, teaspoons: 15 };
  const LIQUID_UNIT = /(ml|fl|cup|can|bottle|carton|container|jar|glass|drink|box|pint|quart|gallon|lit(er|re))/i;
  function servingCheck(sv, cal) {
    if (!sv || !(num(sv.g) > 0)) return null;
    const unit = lc(sv.unit).trim(), qty = num(sv.qty, 1) > 0 ? num(sv.qty, 1) : 1;
    const bad = g => {
      const d = cal > 0 ? cal / g : null;
      if (d !== null && d > 9.5) return true;
      const lim = SPOON_G[unit] || (COUNT_UNIT.test(unit) ? 250 : 0);
      if (lim && g / qty > lim) return true;
      return d !== null && cal >= 60 && d < 0.3 && !LIQUID_UNIT.test(unit);
    };
    const g = num(sv.g);
    if (!bad(g)) return null;
    const alt = Number.isInteger(g) && g >= 20 && g % 10 === 9 ? Math.floor(g / 10) : null;
    return alt && !bad(alt) ? { g: alt, was: g } : { g, was: g };
  }
  const FIELD_WORD = { cal: "calories", p: "protein", c: "carbs", f: "fat", fiber: "fiber", sugar: "sugar", sodium: "sodium" };
  const andList = a => (a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);
  function parseWarning(out, gFix) {
    const parts = [];
    const sv = out.serving || {};
    const qu = String(+num(sv.qty, 1).toFixed(2)) + " " + (sv.unit || "serving");
    if (gFix) parts.push(gFix.g !== gFix.was ? "Check the grams. We read " + gFix.was + " g for " + qu + " and used " + gFix.g + " g." : "Check the grams: " + qu + " = " + gFix.g + " g?");
    const odd = out.check.filter(k => FIELD_WORD[k]).map(k => FIELD_WORD[k]);
    if (odd.length) parts.push("Check " + andList(odd) + ". " + (odd.length > 1 ? "They" : "It") + " may be wrong.");
    const miss = out.missing.map(k => FIELD_WORD[k]);
    if (miss.length && miss.length < NUT.length) parts.push("Couldn't read " + andList(miss) + ". Type " + (miss.length > 1 ? "them" : "it") + " in.");
    return parts.join(" ");
  }

  M.food.label = M.food.label || {};
  /* parse(text) → {serving:{qty,unit,g}, per:{cal,p,c,f,fiber,sugar,sodium}, fields:[…found keys, "serving"],
     check:[keys that look off, "g" = serving grams], missing:[keys not found], warning?: plain words,
     servingsPerContainer?, name?, source:"label"} — pure, never throws. First column = per serving.
     Keys in `missing` are 0 in per; show them empty, not as 0. */
  M.food.label.parse = function (text) {
    const raw = String(text == null ? "" : text);
    const per = { cal: 0, p: 0, c: 0, f: 0, fiber: 0, sugar: 0, sodium: 0 };
    const fields = [], found = {}, check = [];
    let lines = raw.replace(/\r/g, "").replace(/[‘’`´]/g, "'").replace(/[–—]/g, "-").split("\n")
      .map(l => l.replace(/[*†‡]+/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
    /* a linear label ("Calories 150, Total Fat 2.5g (3% DV), Sodium 90mg, …"): one nutrient per line */
    lines = [].concat.apply([], lines.map(l => ((l.match(NUTR_COUNT) || []).length >= 2 ? l.split(/[,;]\s+(?=[A-Za-z(])/) : [l])))
      .map(l => l.trim()).filter(Boolean);
    /* a footnote run onto a nutrient ("Protein 1g. Not a significant source of …") is cut off */
    lines = lines.map(l => { const m = LINE.footnote.exec(l); if (!m || m.index === 0) return l; const head = l.slice(0, m.index); return /\d/.test(head) && NUTR_WORD.test(head) ? head.replace(/[\s.,;:(]+$/, "") : l; });
    const numberish = l => /^[<]?\s*[\dOolI|.,]+\s*(mg|mq|g|9|kcal|kj|cal)?\s*(\d+\s*%)?$/i.test(l);
    const col = columnPairs(lines, numberish);
    const polyols = /sugar\s*alcohol|erythritol|allulose|maltitol|xylitol|sorbitol|isomalt|glycerin|polyols?|net\s*carb/i.test(raw);
    const order = ["cal", "fat", "sodium", "carb", "fiber", "sugar", "protein"];
    for (const field of order) {
      const key = KEYS[field];
      let pref = -1;
      if (field === "fat") pref = lines.findIndex(l => new RegExp("\\b" + T + "\\s*fat\\b", "i").test(l) && !LINE.footnote.test(l));
      if (field === "carb") pref = lines.findIndex(l => new RegExp("\\b" + T + "\\s*carb", "i").test(l) && !LINE.footnote.test(l));
      if (field === "sugar") pref = lines.findIndex(l => new RegExp("\\b" + T + "\\s*sugar", "i").test(l));
      if (field === "fiber") pref = lines.findIndex(l => /dietary\s*f[i1l|]b/i.test(l));
      const idxs = [];
      if (pref >= 0) idxs.push(pref);
      lines.forEach((l, i) => { if (i !== pref && LINE[field].test(l)) idxs.push(i); });
      for (const i of idxs) {
        const line = lines[i];
        if (LINE.footnote.test(line)) continue;
        const tail = tidyTail(field, line.replace(LABEL_WORD[field], " "));
        if (field === "cal" ? /^\s*from\b/i.test(tail) || /per\s*gram/i.test(line) : SUBLINE[field].test(line) && i !== pref) continue;
        let hit = pickValue(field, valuesIn(tail));
        if (!hit && col[i] !== undefined) hit = pickValue(field, valuesIn(tidyTail(field, lines[col[i]])));
        else if (!hit && i + 1 < lines.length && numberish(lines[i + 1])) hit = pickValue(field, valuesIn(tidyTail(field, lines[i + 1])));
        if (!hit && field === "cal" && i > 0 && numberish(lines[i - 1]) && /^\s*[\dOolI|]{2,4}\s*$/.test(lines[i - 1])) hit = pickValue(field, valuesIn(lines[i - 1]));
        if (!hit) continue;
        let v = hit.v;
        const dig = ocrDigits(hit.raw), gField = field !== "cal" && field !== "sodium";
        if (field === "sodium" && hit.unit === "g") v = v * 1000;
        if (field === "cal" && v > 2000 && v % 10 === 0 && String(hit.raw).length >= 4) v = Math.floor(v / 10);
        let alt = null, odd = false;
        if (gField && !hit.lt) {
          if (hit.unit === "g" && /^0\d$/.test(dig)) v = num("0." + dig[1]);                 /* "05g": the point was lost */
          else if (!hit.unit && /^\d{1,2}[.,]\d9$/.test(dig)) { v = num(dig.replace(",", ".").slice(0, -1)); odd = true; }   /* SC-09 "2.59": 2.5 g, the g read as 9 */
          else if (/^\d{2,}$/.test(dig) && /[09]$/.test(dig)) alt = Math.floor(v / 10);      /* "39", "30g": maybe a misread g */
          if (v > 300 && /^\d{3,}$/.test(dig)) { v = Math.floor(v / 10); alt = null; odd = true; }   /* "379g" → 37 */
        }
        if (!isNum(v) || v < 0 || (gField && v > 300) || (field === "cal" && v > 3000)) continue;
        found[key] = { v, alt, weak: hit.unit === "g" && /0$/.test(dig) };
        per[key] = key === "cal" || key === "sodium" ? r0(v) : r1(v);
        if (odd) check.push(key);
        fields.push(key);
        break;
      }
    }
    /* EU labels give salt instead of sodium: sodium mg = salt g × 400 */
    if (!found.sodium) {
      const si = lines.findIndex(l => LINE.salt.test(l) && !LINE.footnote.test(l));
      const h = si >= 0 ? pickValue("fat", valuesIn(lines[si].replace(LINE.salt, " "))) : null;
      if (h && h.v >= 0 && h.v < 50) { found.sodium = { v: h.v * 400, alt: null }; per.sodium = r0(h.v * 400); fields.push("sodium"); }
    }
    fixGlued(per, found, check, polyols);
    NUT.forEach(k => { per[k] = k === "cal" || k === "sodium" ? r0(per[k]) : r1(per[k]); });
    let calGuess = false;
    if (found.cal === undefined && (found.p || found.c || found.f)) { per.cal = r0(num(per.p) * 4 + num(per.c) * 4 + num(per.f) * 9); calGuess = true; check.push("cal"); }
    const sv = parseServingLine(lines.join("\n"));
    const serving = sv || { qty: 1, unit: "serving", g: null };
    if (sv) fields.push("serving");
    const gFix = sv ? servingCheck(serving, found.cal ? per.cal : 0) : null;
    if (gFix) { serving.g = gFix.g; check.push("g"); }
    const uniq = a => a.filter((k, i) => a.indexOf(k) === i);
    const out = { serving, per, fields, check: uniq(check), missing: NUT.filter(k => fields.indexOf(k) < 0 && !(k === "cal" && calGuess)), source: "label" };
    const spc = servingsPerContainer(raw);
    if (spc && spc > 0) out.servingsPerContainer = spc;
    const nfIdx = lines.findIndex(l => /nutr[i1l|]t[i1l|]on\s*facts|valeur\s*nutritive/i.test(l));
    for (let i = 0; i < (nfIdx > 0 ? nfIdx : 0); i++) { const l = lines[i]; if (/^[A-Za-z][A-Za-z '&-]{2,40}$/.test(l) && !PACKAGE.test(l)) { out.name = cap(tidyCase(l)); break; } }
    if (fields.length) { const w = parseWarning(out, gFix); if (w) out.warning = w; }
    return out;
  };

  /* tesseract.js 5.1.1 — every file pinned on jsdelivr (worker, SIMD/non-SIMD LSTM core, English
     best_int data). The script runs only if its bytes match `sri`. */
  const TESS = {
    script: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js",
    sri: "sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F",
    workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js",
    corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1",
    langPath: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int",
    scriptMs: 20000,   /* the small script */
    startMs: 120000,   /* download (about 7 MB the first time) + start, at most */
    readMs: 60000,     /* one read of one photo: the only step with a short timer */
    idleMs: 90000      /* a reader nobody used this long is closed */
  };
  const OCR_MSG = {
    offline: "You're offline. Type the numbers in, or try again when you're online.",
    load: "The label reader couldn't load. Try again, or type the numbers in.",
    loadNoAI: "The label reader couldn't load. Try again, or type the numbers in. With an Anthropic key (You → AI), Claude can read labels too.",
    slow: "The label reader took too long to download. Try again on Wi-Fi, or type the numbers in.",
    read: "Reading the label took too long. Try a closer, brighter photo.",
    download: "Downloading the label reader… One time only, about 7 MB.",
    starting: "Starting the label reader…"
  };
  /* why the reader couldn't load, in words that fit this phone right now */
  const OCR_SEEN = "chalk.ocr.loaded";
  const ocrLoadMsg = () => (isOffline() ? OCR_MSG.offline : M.ai.ready() ? OCR_MSG.load : OCR_MSG.loadNoAI);
  const tessReady = () => !!(win().Tesseract && typeof win().Tesseract.createWorker === "function");
  /* Nick's rule: chicken breast is always Kirkland organic, weighed raw (one breast ≈ 175 g raw).
     Every Claude prompt (label, photo, describe, suggest) says so. */
  const CHICKEN_NOTE = "Chicken breast is always Kirkland organic chicken breast (Costco). Give chicken breast in RAW (uncooked) grams and say raw in its serving, like \"1 breast (175 g raw)\": one breast is about 175 g raw.";
  /* ...and the three products Nick named: these win over any generic entry. */
  const PRODUCT_NAMES = "Daisy 2% cottage cheese; Smucker's Natural strawberry jam (they also call it jelly); Hillshire Farm oven roasted turkey breast, thin lunch-meat slices (just the slices, no sandwich)";
  const FOOD_NOTE = CHICKEN_NOTE + " They also buy: " + PRODUCT_NAMES + ". When one of these fits, use it with the numbers on its package.";
  const LABEL_PROMPT = "This photo shows a Nutrition Facts label from a food package. Copy the numbers exactly as printed. Do not estimate, round or convert.\n" +
    "Reply with ONLY this JSON, no prose, no code fences:\n" +
    "{\"found\": true, \"name\": string (product name if printed on the photo, else \"\"), \"brand\": string (\"\" if not shown), " +
    "\"servingSize\": string (the serving size text exactly as printed, like \"2/3 cup (55g)\"), " +
    "\"serving\": {\"qty\": number, \"unit\": string, \"g\": number or null (grams or mL in the serving)}, " +
    "\"servingsPerContainer\": number or null, " +
    "\"per\": {\"cal\": number, \"p\": number, \"c\": number, \"f\": number, \"fiber\": number, \"sugar\": number, \"sodium_mg\": number}, " +
    "\"basis\": \"serving\" or \"100g\"}\n" +
    "Rules: \"per\" is for ONE serving. If the label has two columns (per serving and per container), use the per-serving column. " +
    "cal = Calories; f = Total Fat grams; sodium_mg = Sodium in milligrams; c = Total Carbohydrate grams; fiber = Dietary Fiber grams; " +
    "sugar = Total Sugars grams (not Added Sugars); p = Protein grams. \"<1g\" or \"less than 1g\" = 0.5. Use 0 for anything not printed. " +
    "If the label only lists values per 100 g or 100 mL, copy those and set \"basis\" to \"100g\". " +
    "If no nutrition label is visible, reply {\"found\": false}.\n" +
    "If the package is one of the foods they buy (Kirkland organic chicken breast; " + PRODUCT_NAMES + "), use that name. Chicken breast labels are for raw meat (one breast is about 175 g raw). Still copy only the numbers printed.";

  /* One reader (a Tesseract worker) is kept while labels are being read, so a second photo
     doesn't download and start it again. M.food.label.release() closes it (when the label
     screen closes); it also closes itself after TESS.idleMs unused. A reader that finishes
     starting after we gave up on it is closed at once. */
  let ocr = null;   /* {T, p, worker, say, idle, dead} */
  function dropOcr(o) {
    if (!o) return;
    clearTimeout(o.idle);
    o.dead = true;
    if (ocr === o) ocr = null;
    const w = o.worker; o.worker = null;
    if (w) { try { Promise.resolve(w.terminate()).catch(() => {}); } catch (e) {} }
  }
  function ocrWorker(say) {
    const T = win().Tesseract;
    if (ocr && ocr.T === T && !ocr.dead) { clearTimeout(ocr.idle); ocr.say = say; return ocr.p; }
    dropOcr(ocr);
    const o = { T, worker: null, say, idle: 0, dead: false };
    const part = { core: 0, lang: 0 };
    /* OF-03: loaded on this phone before (its files are cached) or offline: nothing to download */
    const cached = isOffline() || lsGet(OCR_SEEN) === "1";
    o.p = new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => fail(E("ocr_load", isOffline() ? OCR_MSG.offline : OCR_MSG.slow)), TESS.startMs);
      function fail(err) { if (done) return; done = true; clearTimeout(t); o.dead = true; if (ocr === o) ocr = null; reject(err); }
      o.say(cached ? OCR_MSG.starting : OCR_MSG.download);
      const logger = m => {
        if (!m || o.dead) return;
        const st = lc(m.status), p = isNum(m.progress) ? Math.max(0, Math.min(1, m.progress)) : 0;
        if (st === "recognizing text") { o.say("Reading label… " + Math.round(p * 100) + "%"); return; }
        if (done) return;
        if (/from cache/.test(st) || (cached && /core|traineddata|language/.test(st))) { o.say(OCR_MSG.starting); return; }
        if (/core/.test(st)) part.core = p;
        else if (/traineddata|language/.test(st)) { part.core = 1; part.lang = p; }
        else return;
        /* the core is ~57% of the download, the English data the rest */
        const pct = Math.round(100 * (0.57 * part.core + 0.43 * part.lang));
        o.say(pct > 0 && pct < 100 ? "Downloading the label reader… " + pct + "%. One time only, about 7 MB." : pct >= 100 ? OCR_MSG.starting : OCR_MSG.download);
      };
      Promise.resolve().then(() => T.createWorker("eng", 1, { workerPath: TESS.workerPath, corePath: TESS.corePath, langPath: TESS.langPath, workerBlobURL: true, logger }))
        .then(w => {
          if (done || o.dead) { try { Promise.resolve(w && w.terminate()).catch(() => {}); } catch (e) {} return; }
          done = true; clearTimeout(t); o.worker = w; lsSet(OCR_SEEN, "1"); resolve(w);
        }, () => fail(E("ocr_load", ocrLoadMsg())));
    });
    o.p.catch(() => {});
    ocr = o;
    return o.p;
  }
  async function ocrText(file, say) {
    say(OCR_MSG.starting);
    await loadScript(TESS.script, tessReady, TESS.scriptMs, "ocr_load", ocrLoadMsg, TESS.sri);
    say("Preparing the photo…");
    const prep = await M.img.prepOCR(file, { min: 1600, max: 2200 });
    const worker = await ocrWorker(say);
    const o = ocr;
    say("Reading label…");
    try {
      const read = async psm => {
        try { await worker.setParameters({ tessedit_pageseg_mode: String(psm), preserve_interword_spaces: "1" }); } catch (e) {}
        const res = await withTimeout(worker.recognize(prep.canvas || prep.blob), TESS.readMs, "ocr", OCR_MSG.read);
        return String((res && res.data && res.data.text) || "");
      };
      /* single column of mixed text sizes first; a uniform block if that finds too little */
      let text = await read(4);
      if (M.food.label.parse(text).fields.length < 5) {
        say("Reading label again…");
        const again = await read(6);
        if (M.food.label.parse(again).fields.length > M.food.label.parse(text).fields.length) text = again;
      }
      return text;
    } catch (e) {
      /* a reader that timed out may still be busy: start a fresh one next time */
      if (o) dropOcr(o);
      throw wrapErr(e, "ocr", "The label couldn't be read. Try a closer, brighter photo, or type it in.");
    } finally {
      if (o && !o.dead) { clearTimeout(o.idle); o.idle = setTimeout(() => dropOcr(o), TESS.idleMs); try { if (o.idle && o.idle.unref) o.idle.unref(); } catch (e) {} }
    }
  }

  function labelFromAI(j) {
    const o = isObj(j) ? j : {};
    if (o.found === false) throw E("no_label", "Couldn't find a Nutrition Facts label in that photo. Try again closer, with the whole label in the frame.");
    let per = perFromAI(o.per);
    const fromText = parseServingSize(String(o.servingSize || ""), null);
    const fromModel = servingFromAI(o.serving, null);
    const serving = fromText.unit !== "serving" || fromText.g ? { qty: fromText.qty, unit: fromText.unit, g: fromText.g || fromModel.g } : fromModel;
    let per100g = null;
    if (lc(o.basis) === "100g") {
      per100g = per;
      if (serving.g > 0 && !(serving.unit === "g" && serving.qty === 100)) { const k = serving.g / 100; per = {}; NUT.forEach(key => { const v = per100g[key] * k; per[key] = key === "cal" || key === "sodium" ? r0(v) : r1(v); }); }
      else { serving.qty = 100; serving.unit = "g"; serving.g = 100; per = Object.assign({}, per100g); }
    } else if (serving.g) per100g = scaleTo100(per, serving.g);
    const food = { name: cap(tidyText(o.name)), brand: cap(tidyText(o.brand)), serving, per, per100g, alts: serving.g ? [{ label: "100 g", g: 100 }] : [], source: "label" };
    if (num(o.servingsPerContainer) > 0) food.servingsPerContainer = num(o.servingsPerContainer);
    return food;
  }
  /* Calories that don't match the macros usually mean a misread number. → plain warning | "" */
  function labelWarning(per) {
    const kcal = num(per.p) * 4 + num(per.c) * 4 + num(per.f) * 9;
    if (!(per.cal > 0) && kcal > 20) return "No calories found. Check the numbers.";
    if (per.cal > 40 && kcal > 0 && Math.abs(kcal - per.cal) / per.cal > 0.35) return "Calories don't match protein, carbs and fat. Check the numbers.";
    return "";
  }

  /* fromImage(file, {onProgress, method?:"ocr"}) → {food, method:"ai"|"ocr", rawText, fields?, warning?} */
  M.food.label.fromImage = function (file, opt) {
    opt = isObj(opt) ? opt : {};
    const say = m => { try { if (typeof opt.onProgress === "function") opt.onProgress(m); } catch (e) {} };
    return Promise.resolve().then(async () => {
      if (!file) throw E("image", "Take a photo of the label first.");
      /* Offline, Claude can't be asked; the phone's own reader still works if it was saved
         on the phone before (the app keeps a copy). If it can't load, the message says offline. */
      const offline = isOffline();
      if (!offline && !M.ai.probed()) { try { await withTimeout(M.ai.probe(), 2000); } catch (e) {} }
      const canAI = !offline && opt.method !== "ocr" && M.ai.ready() && await M.ai.images();
      if (canAI) {
        say("Reading label with Claude…");
        try {
          const food = labelFromAI(await M.ai.json(LABEL_PROMPT, { images: [file] }));
          const warning = labelWarning(food.per);
          return warning ? { food, method: "ai", rawText: "", warning } : { food, method: "ai", rawText: "" };
        } catch (e) {
          if (isE(e) && ["auth", "forbidden", "rate_limited", "billing", "no_label", "cancelled"].indexOf(e.code) >= 0) throw e;
          say(isE(e) && e.code === "offline" ? "You're offline. Reading it on your phone…" : "Claude couldn't read it. Reading it on your phone…");
        }
      } else if (offline && opt.method !== "ocr") say("You're offline. Reading it on your phone…");
      const rawText = await ocrText(file, say);
      const parsed = M.food.label.parse(rawText);
      if (!parsed.fields.length || (!parsed.per.cal && !parsed.per.p && !parsed.per.c && !parsed.per.f)) throw E("ocr", "Couldn't find the numbers on that label. Try a closer, brighter photo, or type them in.", rawText);
      /* numbers the reader couldn't find stay empty (null) in food.per, so the form shows a blank
         box to fill in, not a 0 that looks read */
      const per = Object.assign({}, parsed.per);
      (parsed.missing || []).forEach(k => { per[k] = null; });
      const food = { name: parsed.name || "", brand: "", serving: parsed.serving, per, per100g: parsed.serving.g ? scaleTo100(parsed.per, parsed.serving.g) : null, alts: parsed.serving.g ? [{ label: "100 g", g: 100 }] : [], source: "label" };
      if (parsed.servingsPerContainer) food.servingsPerContainer = parsed.servingsPerContainer;
      const out = { food, method: "ocr", rawText, fields: parsed.fields, check: parsed.check || [], missing: parsed.missing || [] };
      const flagged = out.check.some(k => k === "p" || k === "c" || k === "f" || k === "cal");
      const warning = [parsed.warning, flagged ? "" : labelWarning(parsed.per)].filter(Boolean).join(" ");
      if (warning) out.warning = warning;
      return out;
    });
  };

  /* Close the kept label reader (call when the label screen closes). Safe to call any time. */
  M.food.label.release = function () { dropOcr(ocr); };

  /* ======================================================================== */
  /* M.food.photo / describe / estimateByName                                  */
  /* ======================================================================== */
  const ITEMS_SHAPE = "{\"items\":[{\"name\": string, \"servingLabel\": string like \"1 cup (240 g)\" or \"4 oz (113 g)\", \"g\": number (grams of this portion) or null, " +
    "\"per\": {\"cal\": number, \"p\": number, \"c\": number, \"f\": number, \"fiber\": number, \"sugar\": number, \"sodium_mg\": number}}], \"note\": string (one short plain sentence about how sure you are)}";
  const ITEMS_RULES = "Rules: \"per\" is for the WHOLE portion in servingLabel (one line per food). Calories in kcal; p c f fiber sugar in grams; sodium_mg in milligrams. " +
    "Use realistic US home portions. Numbers only, no units, no ranges. " + FOOD_NOTE + " Reply with ONLY the JSON, no prose, no code fences.";
  const slotHint = slot => (slot ? " This is for " + slot + "." : "");
  function itemsFromAI(j, source) {
    const arr = isObj(j) && Array.isArray(j.items) ? j.items : Array.isArray(j) ? j : [];
    const items = arr.filter(isObj).map(it => snapToOwn(itemFromAI(it, source))).filter(it => it.name);
    return { items, note: isObj(j) && j.note ? cap(j.note, 240) : "" };
  }

  M.food.photo = {
    /* estimate(file, {slot}) → {items:[{name, servingLabel, g, per, servings:1, source:"photo"}], note} */
    estimate(file, opt) {
      opt = isObj(opt) ? opt : {};
      return Promise.resolve().then(async () => {
        if (!file) throw E("image", "Take a photo first.");
        if (!M.ai.probed()) { try { await withTimeout(M.ai.probe(), 2000); } catch (e) {} }
        if (!M.ai.ready()) throw E("no_ai", "Photo logging needs Claude. Open Chalk inside claude.ai or add your Anthropic key in You → AI.");
        if (!(await M.ai.images())) throw E("no_ai", AI_MSG.no_images);
        const prompt = "Look at this photo of food. Name each food you can see and estimate a realistic portion for each, then estimate its nutrition." + slotHint(opt.slot) +
          "\nReply with ONLY this JSON:\n" + ITEMS_SHAPE + "\n" + ITEMS_RULES + " If it is not food, reply {\"items\":[],\"note\":\"No food found.\"}.";
        const out = itemsFromAI(await M.ai.json(prompt, { images: [file] }), "photo");
        if (!out.items.length && !out.note) out.note = "No food found in that photo.";
        return out;
      });
    }
  };

  /* ---- describe without Claude: "2 eggs, 2 slices dave's bread, 1 tbsp butter" ---- */
  const UNIT_WORDS = {
    g: ["g", "gram", "grams", "gr", "gm", "gms"], oz: ["oz", "ounce", "ounces"], lb: ["lb", "lbs", "pound", "pounds"],
    cup: ["cup", "cups", "c"], tbsp: ["tbsp", "tbsps", "tablespoon", "tablespoons", "tb", "tbs"], tsp: ["tsp", "tsps", "teaspoon", "teaspoons"],
    ml: ["ml", "milliliter", "milliliters", "millilitre", "millilitres"], "fl oz": ["floz", "fl", "fluid"],
    slice: ["slice", "slices"], piece: ["piece", "pieces", "pc", "pcs"], scoop: ["scoop", "scoops"], serving: ["serving", "servings", "portion", "portions"],
    small: ["small", "sm"], medium: ["medium", "med"], large: ["large", "lg"], can: ["can", "cans"], bottle: ["bottle", "bottles"], bar: ["bar", "bars"],
    egg: ["egg", "eggs"], handful: ["handful", "handfuls"], bag: ["bag", "bags"], packet: ["packet", "packets", "pack"], link: ["link", "links"], stick: ["stick", "sticks"],
    glass: ["glass", "glasses"], shot: ["shot", "shots"], ear: ["ear", "ears"], spear: ["spear", "spears"], stalk: ["stalk", "stalks"], floret: ["floret", "florets"], clove: ["clove", "cloves"], wedge: ["wedge", "wedges"], strip: ["strip", "strips"]
  };
  /* "6 asparagus spears", "2 garlic cloves": a count word after the food is its unit */
  const TRAIL_COUNT = /\s+(spears?|stalks?|florets?|cloves?|wedges?|strips?|pieces?|shots?)$/i;
  const UNIT_LOOKUP = {}; Object.keys(UNIT_WORDS).forEach(u => UNIT_WORDS[u].forEach(w => { UNIT_LOOKUP[w] = u; }));
  const WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12 };

  /* "1.5 cups rice" → {qty:1.5, unit:"cup", words:"rice", raw, explicitQty} */
  M.food.parseQuantity = function (phrase) {
    let s = String(phrase == null ? "" : phrase).trim().replace(/\s+/g, " ").replace(/^(about|around|roughly|like|maybe)\s+/i, "");
    const raw = s;
    /* "juice of 1 lime" is 1 lime's juice (the "1 lime" is not an amount of juice) */
    s = s.replace(/^juice\s+of\s+(?:(\S+)\s+)?(lemon|lime|orange)(e?s)?\b/i, (m0, n, f) => (n ? n + " " : "") + f + " juice");
    let qty = null, unit = null;
    s = s.replace(/(\d)\s*-\s*(?=(oz|ounce|g|gram|lb|cup|tbsp|tsp|ml)\b)/i, "$1 ");          /* "5-oz" → "5 oz" */
    s = s.replace(/^(\d+(?:\.\d+)?)\s*[x×]\s+(?=[a-z])/i, "$1 ");                            /* "2x chicken breast" → "2 chicken breast" */
    s = s.replace(/^[x×]\s*(\d+(?:\.\d+)?)\s+(?=[a-z])/i, "$1 ");                             /* "x2 eggs" → "2 eggs" */
    /* "2% cottage cheese" and "80/20 ground beef" name the food; they aren't amounts */
    const partOfName = /^\d+(?:[.,]\d+)?\s*%/.test(s) || /^\d{2,}\s*\/\s*\d{1,2}\b/.test(s);
    const m = partOfName ? null : /^(\d+\s*[½¼¾⅓⅔⅛]|[½¼¾⅓⅔⅛])\s*/.exec(s)
      || /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?|a\s+half|half\s+an?|half|a\s+quarter|quarter|a\s+couple\s+of|a\s+couple|couple\s+of|couple|a\s+few|few|a\s+dozen|dozen|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|an|a)\b\s*/i.exec(s);
    if (m) {
      const q = lc(m[1]).replace(/\s+/g, " ");
      if (/^[\d½¼¾⅓⅔⅛]/.test(q)) qty = qtyOf(q);
      else if (/half/.test(q)) qty = 0.5;
      else if (/quarter/.test(q)) qty = 0.25;
      else if (/couple/.test(q)) qty = 2;
      else if (/few/.test(q)) qty = 3;
      else if (/dozen/.test(q)) qty = 12;
      else qty = WORD_NUM[q] !== undefined ? WORD_NUM[q] : 1;
      s = s.slice(m[0].length);
      if (/^(a|an)\s+/i.test(s) && qty === 0.5) s = s.replace(/^(a|an)\s+/i, "");
    }
    /* SD-18: "whole avocado" is 1 avocado (not its usual ½); "whole milk", "whole wheat" are names */
    if (qty == null && /^whole\s+(?!milk|wheat|grains?|foods?|eggs?\b)[a-z]/i.test(s)) qty = 1;
    const xm = /\s*[x×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(s);
    if (xm) { qty = (qty == null ? 1 : qty) * num(xm[1], 1); s = s.slice(0, xm.index); }
    if (qty == null) {                                   /* trailing amount: "chicken thigh 8 oz", "rice (1 cup)", "quinoa 1/4 cup dry" */
      const tm = /\s*\(?\s*(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)?\.?(?:\s+(?:raw|dry|uncooked|cooked))?\s*\)?\s*$/i.exec(s);
      /* "chicken 1 banana" is two foods, not 1 chicken: a word after the number must be a unit */
      const tw = tm ? lc(tm[2] || "") : "";
      /* SD-03: "toast 2 eggs" is toast and 2 eggs ("eggs" after a number is a food, not a unit) */
      if (tm && tm.index > 0 && (!tw || (UNIT_LOOKUP[tw] && UNIT_LOOKUP[tw] !== "egg") || tw === "floz" || /^(breasts?|fillets?|filets?|pieces?|whole|jumbo|big|mini)$/.test(tw))) {
        qty = qtyOf(tm[1]);
        const uw = lc(tm[2] || "");
        if (uw && UNIT_LOOKUP[uw] && UNIT_LOOKUP[uw] !== "egg") unit = UNIT_LOOKUP[uw];
        else if (uw === "floz") unit = "fl oz";
        s = s.slice(0, tm.index);
      }
    }
    if (qty == null) {                                   /* SD-17: "rice half cup", "blueberries a half cup" */
      const hm = /\s+(?:a\s+)?(half|quarter|one|two|three|four|five|six)\s+(?:an?\s+)?([a-z]+)\.?(?:\s+(?:raw|dry|uncooked|cooked))?\s*$/i.exec(s);
      const hu = hm ? lc(hm[2]) : "";
      if (hm && hm.index > 0 && UNIT_LOOKUP[hu] && UNIT_LOOKUP[hu] !== "egg") {
        const w = lc(hm[1]);
        qty = w === "half" ? 0.5 : w === "quarter" ? 0.25 : WORD_NUM[w];
        unit = UNIT_LOOKUP[hu];
        s = s.slice(0, hm.index);
      }
    }
    const gm = /^(\d+(?:\.\d+)?)(g|oz|ml|lb|lbs)\b\.?\s*/i.exec(s);        /* "4oz" glued */
    if (gm && qty == null) { qty = num(gm[1]); unit = UNIT_LOOKUP[lc(gm[2])]; s = s.slice(gm[0].length); }
    if (!unit) {
      const um = /^([a-zA-Z]+)\.?\s*(oz\b)?\s*/.exec(s);
      if (um) {
        const w = lc(um[1]), u = UNIT_LOOKUP[w];
        const rest = s.slice(um[0].length).trim();
        /* "2 eggs" keeps "eggs" as the food; "1 large egg" / "2 cups rice" take the unit off */
        if (u && u !== "egg" && (rest || !/^(small|medium|large|can|bar|stick|link|bag|bottle|scoop|packet)$/.test(u))) {
          unit = u === "fl oz" || (w === "fl" && um[2]) ? "fl oz" : u;
          s = rest;
        }
      }
    }
    let words = s.replace(/^of\s+/i, "").replace(/[.,;:!]+$/, "").trim();
    const tc = TRAIL_COUNT.exec(words);
    /* chicken strips / pieces aren't breasts: leave those words alone */
    if (tc && tc.index > 0 && !(/^(strips?|pieces?)$/i.test(tc[1]) && /\bchicken\b/i.test(words))) {
      words = words.slice(0, tc.index).trim();
      if (!unit && qty != null) unit = UNIT_LOOKUP[lc(tc[1])] || null;
    }
    return { qty: qty == null ? 1 : qty, unit, words, raw, explicitQty: qty != null };
  };

  const GRAMS_PER = { g: 1, oz: 28.35, lb: 453.6, ml: 1, "fl oz": 29.57 };
  const VOL_CUPS = { cup: 1, tbsp: 1 / 16, tsp: 1 / 48, ml: 1 / 240, "fl oz": 1 / 8 };
  const COUNTISH = /^(large|medium|small|whole|each|piece|pieces|slice|slices|egg|eggs|large egg|large eggs|link|links|bar|bars|cake|cakes|stick|sticks|fruit|tomato|tomatoes|patty|patties|breast|thigh|fillet|filet|tortilla|bagel|muffin|banana|apple|orange|potato|can|bottle|container|cup of yogurt|scoop|packet|pouch)$/i;
  const unitBase = u => lc(u).replace(/,.*$/, "").replace(/\(.*$/, "").trim();
  const PKG_UNIT = /^(bottle|can|container|packet|pouch|bag|box|jar|carton|tub)s?\b/i;
  const isWeightUnit = u => /^(g|gram|grams|oz|ounce|ounces|lb|lbs|pound|pounds)$/.test(unitBase(u));
  const isVolUnit = u => VOL_CUPS[volKey(u)] !== undefined;
  function volKey(u) { const b = unitBase(u).replace(/s$/, ""); return b === "tablespoon" ? "tbsp" : b === "teaspoon" ? "tsp" : b === "fl oz" || b === "floz" ? "fl oz" : b; }
  const UNIT_ALIAS = { cup: /^cups?$/i, tbsp: /^(tbsp|tablespoons?)$/i, tsp: /^(tsp|teaspoons?)$/i, oz: /^(oz|ounces?)$/i, g: /^(g|grams?)$/i, slice: /^slices?$/i, piece: /^pieces?$/i, scoop: /^scoops?$/i, serving: /^servings?$/i, bar: /^bars?$/i, can: /^cans?$/i, ml: /^ml$/i, "fl oz": /^fl\.?\s*oz$/i, link: /^links?$/i, stick: /^sticks?$/i, small: /^small$/i, medium: /^medium$/i, large: /^large$/i };
  function unitMatches(u, label) { const b = unitBase(label); const re = UNIT_ALIAS[u]; return re ? re.test(b) : lc(u) === b.replace(/s$/, ""); }
  const fmtLabel = (qty, unit, g) => {
    const q = String(+num(qty, 1).toFixed(2));
    if (/^g$/i.test(unit)) return q + " g";
    return M.fmtServing ? M.fmtServing({ qty, unit, g }) : q + " " + unit + (g ? " (" + String(+(+g).toFixed(1)) + " g)" : "");
  };

  /* A Food-ish (serving, per, per100g, alts) + a parsed quantity → {servings, servingLabel, g, per}
     where per is for ONE servingLabel. Weights become their own exact row ("5 oz (142 g)"). */
  function scaleToQuantity(food, q) {
    const sv = food.serving || { qty: 1, unit: "serving", g: null };
    const svQty = num(sv.qty, 1) || 1, svUnit = String(sv.unit || "serving"), svG = num(sv.g, null) > 0 ? num(sv.g) : null;
    const per100 = food.per100g && (num(food.per100g.cal) > 0 || num(food.per100g.p) > 0) ? food.per100g : null;
    const alts = (Array.isArray(food.alts) ? food.alts : []).filter(a => a && a.label && num(a.g) > 0);
    const perForGrams = grams => {
      if (per100) return M.foodMath ? M.foodMath.fromPer100(per100, grams) : null;
      if (svG) return M.foodMath ? M.foodMath.scale(food.per, grams / svG) : null;
      return null;
    };
    const own = servings => ({ servings, servingLabel: fmtLabel(svQty, svUnit, svG), g: svG ? r1(svG * servings) : null, per: food.per });
    const altRow = (alt, servings) => {
      const p = M.parseServing ? M.parseServing(alt.label) : { qty: 1, unit: alt.label, g: null };
      const per = perForGrams(num(alt.g));
      return per ? { servings, servingLabel: fmtLabel(p.qty || 1, p.unit, num(alt.g)), g: r1(num(alt.g) * servings), per } : null;
    };
    const exact = (grams, qty, unit) => { const per = perForGrams(grams); return per ? { servings: 1, servingLabel: fmtLabel(qty, unit, grams >= 10 ? r0(grams) : r1(grams)), g: r1(grams), per } : null; };
    /* A portion of the thing itself, x times: "1 cucumber" → 1 × "1 cucumber (301 g)" (not 1 cup
       sliced), "½ cucumber" → "½ cucumber", "10 baby carrots" → 1 × "10 baby carrots (100 g)". */
    const whole = x => {
      const w = wholePortion(food, q.words);
      if (!w) return null;
      if (w.own) return own(x / svQty);
      return altRow(w.alt, x / (w.qty || 1));
    };
    const u = q.unit;
    if (!u) {
      if (!q.explicitQty) return own(1);                                  /* "broccoli" → one normal serving */
      { const w = wholePortion(food, q.words, q.qty); if (w) { const r = w.own ? own(q.qty / svQty) : altRow(w.alt, q.qty / (w.qty || 1)); if (r) return r; } }
      if (!isVolUnit(svUnit) && !isWeightUnit(svUnit)) {                /* "2 eggs" on "1 large egg" */
        /* "2 turkey slices" on a "6 slices" food → 2 × "1 slice" (not 0.33 × 6 slices) */
        if (Math.abs(svQty - 1) > 1e-6) {
          const base = u2 => unitBase(u2).replace(/s$/, "");
          const single = alts.find(a => { const p = M.parseServing ? M.parseServing(a.label) : null; return p && Math.abs((p.qty || 1) - 1) < 1e-6 && base(p.unit) === base(svUnit); });
          if (single) { const r = altRow(single, q.qty); if (r) return r; }
        }
        return own(q.qty / svQty);
      }
      /* "10 shrimp" on a "4 oz" food → 10 × "1 large shrimp", not 10 × 4 oz */
      /* SD-06: never a package ("2 wines" isn't 2 bottles) unless they said that word */
      const said = wordsOf(q.words || "");
      const count = alts.find(a => {
        const p = M.parseServing ? M.parseServing(a.label) : null;
        if (!p) return false;
        const b = unitBase(p.unit);
        if (PKG_UNIT.test(b) && said.indexOf(singular(b.split(/\s+/)[0])) < 0) return false;
        return COUNTISH.test(b) || /^(large|medium|small|jumbo)\s+[a-z]/.test(b);
      });
      if (count) { const p = M.parseServing(count.label); const r = altRow(count, q.qty / (p.qty || 1)); if (r) return r; }
      return own(q.qty);
    }
    if (GRAMS_PER[u] && (u === "g" || u === "oz" || u === "lb")) {
      const same = alts.find(a => { const p = M.parseServing ? M.parseServing(a.label) : null; return p && unitMatches(u, p.unit) && Math.abs((p.qty || 1) - q.qty) < 1e-6; });
      if (same) { const r = altRow(same, 1); if (r) return r; }
      if (unitMatches(u, svUnit) && Math.abs(svQty - q.qty) < 1e-6) return own(1);
      const r = exact(q.qty * GRAMS_PER[u], q.qty, u === "g" ? "g" : u);
      if (r) return r;
      if (unitMatches(u, svUnit)) return own(q.qty / svQty);
    }
    if (unitMatches(u, svUnit)) {                                         /* "1.5 cups rice" on a "1 cup" food */
      /* When the food's own size isn't one unit, a size that reads better: "1 cup" on a "1/2 cup"
         food → 1 × 1 cup (not 2 × 1/2 cup); "4 slices" on a "6 slices" food → 4 × 1 slice */
      if (Math.abs(svQty - 1) > 1e-6 && Math.abs(svQty - q.qty) > 1e-6) {
        const sized = k => alts.find(a => { const p = M.parseServing ? M.parseServing(a.label) : null; return p && unitMatches(u, p.unit) && Math.abs((p.qty || 1) - k) < 1e-6; });
        const same = !COUNTISH.test(unitBase(u)) && sized(q.qty);
        if (same) { const r = altRow(same, 1); if (r) return r; }
        const one = sized(1);
        if (one) { const r = altRow(one, q.qty); if (r) return r; }
      }
      return own(q.qty / svQty);
    }
    const alt = alts.find(a => { const p = M.parseServing ? M.parseServing(a.label) : null; return p && unitMatches(u, p.unit); });
    if (alt) { const p = M.parseServing(alt.label); const r = altRow(alt, q.qty / (p.qty || 1)); if (r) return r; }
    if (GRAMS_PER[u]) { const r = exact(q.qty * GRAMS_PER[u], q.qty, u); if (r) return r; }
    if (VOL_CUPS[u] !== undefined && isVolUnit(svUnit)) return own((q.qty * VOL_CUPS[u]) / (svQty * VOL_CUPS[volKey(svUnit)]));
    const cupAlt = alts.find(a => /cup/i.test(a.label));
    if (VOL_CUPS[u] !== undefined && cupAlt) {
      const p = M.parseServing(cupAlt.label);
      const grams = num(cupAlt.g) * (q.qty * VOL_CUPS[u]) / ((p.qty || 1) * VOL_CUPS.cup);
      const r = exact(grams, q.qty, u); if (r) return r;
    }
    const size = { small: 0.75, medium: 1, large: 1.25 }[u];
    if (size) {
      /* the food's own portion already has this size: "1 large egg" on "1 large egg" */
      if (new RegExp("\\b" + u + "\\b", "i").test(svUnit)) return own(q.qty / svQty);
      const sAlt = alts.find(a => new RegExp("\\b" + u + "\\b", "i").test(a.label));
      if (sAlt) { const p = M.parseServing ? M.parseServing(sAlt.label) : null; const r = altRow(sAlt, q.qty / ((p && p.qty) || 1)); if (r) return r; }
      /* no portion of that size: scale the whole thing ("1 small cucumber" → ¾ of 1 cucumber) */
      const r = whole(q.qty * size);
      if (r) return r;
      return own(q.qty * size);
    }
    return own(q.qty);
  }
  const SIZE_WORD = /^(small|medium|large|jumbo|whole|each|sm|med|lg)$/i;
  /* The food's serving or alt that is the thing itself, for the words they said.
     → {own:true} | {alt, qty} | null. A portion counts when every word of its unit (size words
     aside) was said or is the food's main word ("1 cucumber", "10 baby carrots", "large egg").
     A size-only unit ("medium") is one whole item. The one covering the most extra words they
     said wins ("baby"); then the serving when it is one item; then the same count; then one. */
  function wholePortion(food, words, qty) {
    const said = wordsOf(words || "").filter(w => !SIZE_WORD.test(w) && !/\d/.test(w));
    const noun = nameParts(food).noun;
    if (!said.length && !noun) return null;
    const cands = [];
    const look = (label, g, isOwn) => {
      const p = M.parseServing ? M.parseServing(label) : null;
      if (!p || !(num(g) > 0 || isOwn)) return;
      const uw = wordsOf(unitBase(p.unit)).filter(w => !SIZE_WORD.test(w) && !/\d/.test(w));
      if (uw.length && !uw.every(w => said.indexOf(w) >= 0 || w === noun)) return;
      if (!uw.length && !isOwn && !/^(small|medium|large|whole)$/i.test(unitBase(p.unit))) return;
      if (uw.length && !uw.some(w => w === noun || said.indexOf(w) >= 0)) return;
      cands.push({ own: !!isOwn, qty: num(p.qty, 1) || 1, cover: uw.filter(w => w !== noun && said.indexOf(w) >= 0).length, whole: !uw.length || uw.indexOf(noun) >= 0 });
      cands[cands.length - 1].alt = isOwn ? null : { label, g };
    };
    const sv = food.serving || {};
    const svLabel = (num(sv.qty, 1) || 1) + " " + String(sv.unit || "serving");
    /* a serving in plain weight / volume ("1 cup, sliced") is not the thing itself */
    if (!isVolUnit(String(sv.unit || "")) && !isWeightUnit(String(sv.unit || ""))) look(svLabel, sv.g, true);
    (Array.isArray(food.alts) ? food.alts : []).forEach(a => { if (a && a.label && num(a.g) > 0 && !isVolUnit(M.parseServing ? (M.parseServing(a.label) || {}).unit || "" : "") && !isWeightUnit(M.parseServing ? (M.parseServing(a.label) || {}).unit || "" : "")) look(a.label, a.g, false); });
    if (!cands.length) return null;
    const want = num(qty, 0);
    /* a size they said picks that size ("10 jumbo shrimp" → the jumbo one, not large) */
    const sizes = wordsOf(words || "").filter(w => /^(small|medium|large|jumbo)$/.test(w));
    const sizeKey = c => (!sizes.length ? 0 : sizes.some(z => new RegExp("\\b" + z + "\\b", "i").test(c.alt ? c.alt.label : String((food.serving || {}).unit || ""))) ? 0 : 1);
    const key = c => [-c.cover, sizeKey(c), c.own && Math.abs(c.qty - 1) < 1e-6 ? 0 : 1, want && Math.abs(c.qty - want) < 1e-6 ? 0 : 1, Math.abs(c.qty - 1) < 1e-6 ? 0 : 1, c.own ? 0 : 1];
    cands.sort((a, b) => { const ka = key(a), kb = key(b); for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]; return 0; });
    return cands[0];
  }

  const WORD_SPLIT = /[^\p{L}\p{N}%]+/u;
  /* Words that describe a food rather than name it: a name word like this costs little when the
     person didn't say it ("Chicken breast, boneless skinless" for "chicken breast"). Foods' main
     words (oil, water, bacon, seasoning …) are NOT here. */
  const DESCRIPTOR = /^(large|medium|small|whole|plain|old|fashioned|style|cooked|raw|dry|fresh|frozen|canned|drained|boneless|skinless|lean|light|reduced|fat|free|low|nonfat|unsweetened|sweetened|creamy|crunchy|organic|regular|original|classic|with|no|in|and|of|the|a|an|per|kirkland|kroger|signature|brand|slice|slices|cup|oz|g|lb|chopped|sliced|diced|grilled|baked|roasted|steamed|boiled|sauteed|salted|unsalted|natural|pure|simple|fat-free)$/i;
  /* A food whose main word is one of these is a different food ("Avocado oil" is not an avocado,
     "Turkey bacon" is not turkey) unless the person said that word. */
  const OTHER_FOOD = /^(oil|water|bacon|seasoning|sauce|dressing|powder|milk|juice|butter|flour|syrup|spread|dip|jerky|sausage|broth|soup|mix|chip|cracker|cake|bar|cereal|vinegar|paste|jam|jelly|candy|cooky|cookie|creamer|stock|shake|drink|smoothie)$/i;
  const PACK_WORD = /^(packet|package|pack|can|bottle|jar|bag|box|pouch|container|tub|carton|piece|slice)$/i;
  /* How it was served, not what it is ("2 eggs over easy", "a bowl of rice", "big salad"). */
  const STYLE = /^(over|easy|scrambled|hard|soft|sunny|side|up|big|little|hot|cold|iced|warm|homemade|bowl|plate|glass|mug|handful|portion|bit|chunk|bunch|toasted)$/i;
  const STOP = /^(of|the|some|with|and|a|an|my|plain|cooked|fresh|whole|on)$/i;
  const singular = w => (w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.replace(/(ie)s$/, "y").replace(/(o|ch|sh|x)es$/, "$1").replace(/s$/, "") : w);
  /* Words of a name or a phrase: M.searchTokens (m-core) when it is there, so describe and search
     read words the same way; numbers ("2%", "93", "80/20") are kept for the scoring. */
  const wordsOfRaw = s => {
    const own = lc(s).replace(/['’]/g, "").split(WORD_SPLIT).filter(w => w && (w.length > 1 || /\d/.test(w)));
    if (typeof M.searchTokens === "function") {
      try {
        const t = M.searchTokens(String(s == null ? "" : s));
        if (Array.isArray(t)) { const out = t.map(w => singular(lc(w))).filter(w => w && (w.length > 1 || /\d/.test(w))); own.forEach(w => { if (/\d/.test(w) && out.indexOf(w) < 0) out.push(w); }); return out; }
      } catch (e) {}
    }
    return own.map(singular);
  };
  /* SD-05: describe reads the same names thousands of times, so the words of a string and the
     parts of a food's name are worked out once and remembered (read-only arrays: never change
     what these return) */
  const WORDS_MEMO = new Map();
  const wordsOf = s => {
    const key = String(s == null ? "" : s);
    let out = WORDS_MEMO.get(key);
    if (out) return out;
    out = wordsOfRaw(key);
    if (WORDS_MEMO.size > 8000) WORDS_MEMO.clear();
    WORDS_MEMO.set(key, out);
    return out;
  };
  const toks = s => wordsOf(s).filter(w => !STOP.test(w));
  const PARTS_MEMO = new WeakMap();
  const wordsKey = f => (typeof f.words === "string" ? f.words : Array.isArray(f.words) ? f.words.join(" ") : "");
  function nameParts(food) {
    const wk = wordsKey(food), hit = PARTS_MEMO.get(food);
    if (hit && hit.name === food.name && hit.brand === food.brand && hit.wk === wk) return hit.v;
    const v = namePartsRaw(food);
    PARTS_MEMO.set(food, { name: food.name, brand: food.brand, wk, v });
    return v;
  }
  function namePartsRaw(food) {
    const full = lc(food.name), main = full.replace(/\([^)]*\)/g, " "), head = main.split(/[,(]/)[0];
    const mw = main.split(WORD_SPLIT).filter(Boolean);
    const optional = new Set();
    mw.forEach((w, i) => { if (w === "or") { if (mw[i - 1]) optional.add(singular(mw[i - 1])); if (mw[i + 1]) optional.add(singular(mw[i + 1])); } });
    const hw = wordsOf(head);
    /* the food's main word: the last word before the first comma that isn't a number, a
       describing word or a package word ("Taco seasoning packet" → seasoning) */
    let noun = "";
    for (let i = hw.length - 1; i >= 0; i--) { const w = hw[i]; if (/\d/.test(w) || DESCRIPTOR.test(w) || PACK_WORD.test(w)) continue; noun = w; break; }
    const extra = typeof food.words === "string" ? wordsOf(food.words) : Array.isArray(food.words) ? wordsOf(food.words.join(" ")) : [];
    /* the words after the first comma ("Egg bites, bacon and gruyere" → bacon, gruyere) */
    const after = main.indexOf(",") >= 0 ? wordsOf(main.slice(main.indexOf(",") + 1)) : [];
    return { full, all: wordsOf(full), main: wordsOf(main), head: hw, noun, brand: wordsOf(food.brand || ""), optional, extra, after, brandStr: lc(food.brand || "").replace(/['’]/g, "") };
  }
  /* Words that may be missing from a food's name without making it a different food: colors,
     sizes, stores ("red bell pepper" → Bell pepper, "baby carrots" → Carrots). Any other word
     they said must be in the food's name, brand or search words: "string cheese" is not
     cottage cheese, "whipped cream" is not sour cream. */
  const LOOSE = /^(red|green|yellow|orange|white|purple|brown|golden|baby|mini|jumbo|extra|thin|thick|thinly|shredded|cubed|halved|whole|fresh|frozen|leftover|homemade|costco|kroger|king|soopers|trader|joe|walmart|target|safeway|store|bought|pieces?|chunks?)$/i;
  /* A word in the food's name that makes it a different food when they didn't say it:
     "cream" is not sour cream or ice cream, "butter" is not peanut butter. */
  const CHANGER = /^(sour|peanut|almond|cashew|coconut|soy|oat|ice|string|cream|cottage)$/i;
  /* a dish is more than its parts: "a turkey sandwich" isn't turkey slices + a slice of bread */
  const DISH = /^(sandwich|sub|hoagie|wrap|burger|burrito|taco|pizza|soup|stew|casserole|bake|pie|quesadilla|omelet|omelette|lasagna|curry|chili|salad)$/i;
  /* foods that come in kinds named by another food ("banana bread", "grape juice", "banana
     peppers", "corn chips", "strawberry yogurt"): two words like that are one food */
  const KIND_OF = /^(juice|bread|yogurt|pepper|chip|water|smoothie|milk|muffin|cake|sauce|syrup|oil|vinegar|salsa|soda|tea|shake|bar|cookie|pancake|waffle|cracker|cereal|granola|pudding|jerky|broth|stock|noodle|butter|cheese|cream|spread|dressing|dip|seasoning|powder|flour|candy|popsicle|sorbet|gelato|latte|coffee|roll|ring|nugget|tender|wing|bite|ball|meatball|patty|dog|link)$/i;
  const SEASONING = /^(lemon|lime|garlic|honey|ginger|salt|chili|chile|cinnamon|sesame|mustard|maple|sriracha|pesto|buffalo|bbq|cajun|teriyaki|curry|herb|soy|balsamic|jerk|chipotle|smoky|spicy)$/i;
  /* how many times a run-on note ("cod asparagus quinoa") may be cut into foods */
  const SPLIT_DEPTH = 4;
  /* words that only describe: never a food of their own inside a note ("white claw", "diet coke") */
  const ADJ = /^(diet|light|lite|zero|sugar|free|low|fat|nonfat|organic|natural|original|classic|plain|sweet|spicy|hot|cold|iced|mini|big|small|large|medium|jumbo|red|green|black|yellow|brown|dark|golden|fresh|frozen|raw|cooked|extra|lean|baby|whole|half|quarter|unsweetened|sweetened|salted|unsalted|reduced|protein)$/;
  /* raw / cooked words in what they typed → "raw" | "cooked" | null */
  function stateOf(text) {
    const s = String(text == null ? "" : text);
    const raw = /\b(raw|uncooked|dry)\b/i.test(s), cooked = /\b(cooked|grilled|baked|roasted|boiled|steamed|fried|sauteed|sautéed|seared|broiled|poached|smoked|leftovers?)\b/i.test(s);
    return raw && !cooked ? "raw" : cooked && !raw ? "cooked" : null;
  }
  /* the state a food's name says: "Broccoli, raw" → raw, "Broccoli, cooked" → cooked */
  const nameState = f => { const n = lc(f && f.name); return /\braw\b|uncooked|\bdry\b/.test(n) ? "raw" : /\bcooked\b/.test(n) ? "cooked" : null; };
  const hasCook = f => { try { return !!(f && (isObj(f.cook) || (M.cook && typeof M.cook.of === "function" && M.cook.of(f)))); } catch (e) { return false; } };
  /* Name words of the food the person didn't say (describing words and numbers don't count). */
  function unsaid(qWords, food) {
    const n = nameParts(food), qs = qWords.map(singular);
    return n.main.filter(w => qs.indexOf(w) < 0 && !DESCRIPTOR.test(w) && !/^\d/.test(w) && !n.optional.has(w) && w !== "or" && n.brand.indexOf(w) < 0).length;
  }
  /* -1 = not this food; higher is better. The last word they said (the thing they ate:
     "chicken veggie bake" → bake) must be in the name or brand, and a food whose own main
     word is a different food ("Avocado oil") needs that word said. */
  function nameScore(qWords, food, state) {
    const n = nameParts(food), brandStr = n.brandStr;
    /* SD-14: a word that is the start of the food's main word (4+ letters) says it ("mayo"),
       unless it is a food word of its own ("apple" isn't applesauce) */
    const qs = qWords.map(singular).map(w => (w.length >= 4 && n.noun && n.noun !== w && n.noun.startsWith(w) && DCTX && !DCTX.idx.has(w) ? n.noun : w));
    /* search words count, but a dish word there ("sandwich meat") doesn't make the dish */
    const inFood = w => n.all.indexOf(w) >= 0 || n.brand.indexOf(w) >= 0 || (n.extra.indexOf(w) >= 0 && !DISH.test(w)) || (w.length >= 3 && (n.all.some(x => x.startsWith(w) || (w.startsWith(x) && x.length > 3)) || brandStr.indexOf(w) >= 0));
    const words = qs.filter(w => !/\d/.test(w));
    const qHead = words.length ? words[words.length - 1] : "";
    if (qHead && !inFood(qHead)) return -1;
    /* SC-04: every real word they said is in the food */
    if (words.some(w => !inFood(w) && !DESCRIPTOR.test(w) && !LOOSE.test(w) && !STYLE.test(w) && !STATE_WORD.test(w))) return -1;
    if (n.head.some(w => CHANGER.test(w) && qs.indexOf(w) < 0)) return -1;
    let s = 0, hits = 0;
    for (const w of qs) {
      if (n.all.indexOf(w) >= 0) { hits++; s += 20; if (n.head.indexOf(w) >= 0) s += 6; }
      else if (n.all.some(x => (x.startsWith(w) && w.length >= 3) || (w.startsWith(x) && x.length > 3))) { hits++; s += 10; }
      else if (n.brand.indexOf(w) >= 0 || (w.length >= 3 && brandStr.indexOf(w) >= 0)) { hits++; s += 8; }
      else s -= 8;
    }
    if (!hits) return -1;
    if (n.noun && qs.indexOf(n.noun) < 0 && !n.optional.has(n.noun)) {
      /* SD-14: "mayo" is the start of mayonnaise; "fairlife" names their Fairlife milk by brand;
         "ranch", "teriyaki", "marinara" are the first word of a sauce or dressing */
      const nounSaid = qs.some(w => w.length >= 4 && n.noun.startsWith(w));
      const brandSaid = qs.some(w => n.brand.indexOf(w) >= 0 || (w.length >= 3 && brandStr.indexOf(w) >= 0));
      const condiment = /^(sauce|dressing|dip|spread)$/.test(n.noun) && n.head.length >= 2 && qs.indexOf(n.head[0]) >= 0;
      if (!nounSaid) { if (OTHER_FOOD.test(n.noun) && !brandSaid && !condiment) return -1; s -= 6; }
    }
    let pen = 0;
    n.main.forEach(w => { if (qs.indexOf(w) >= 0 || w === "or" || n.optional.has(w) || n.brand.indexOf(w) >= 0) return; pen += DESCRIPTOR.test(w) || /^\d/.test(w) ? 0.5 : 4; });
    s -= Math.min(10, pen);
    if (n.head.length && n.head.every(w => qs.indexOf(w) >= 0 || DESCRIPTOR.test(w) || n.optional.has(w) || n.brand.indexOf(w) >= 0)) s += 12;
    /* raw / cooked twins ("Broccoli, raw" / "Broccoli, cooked"): the one their words say; with
       no word, raw (plain vegetables are eaten raw unless they say cooked) */
    const ns = nameState(food), want = state || (qs.some(w => /^(raw|dry|uncooked)$/.test(w)) ? "raw" : null);
    if (ns) s += want ? (ns === want ? 4 : -6) : ns === "raw" ? 2 : 0;
    else if (want && hasCook(food)) s += 4;             /* rice, meat, fish: raw and cooked in one food */
    return Math.max(0, s);
  }
  /* How a saved food answers the words: 2 = every query word is in its name/brand AND every
     real word of its name was asked for ("chicken breast" → "Organic Chicken Breast");
     1 = every query word is there and at least one only through the brand, i.e. they named
     the product by brand ("dave's bread" → their Dave's Killer Bread loaf); 0 = neither
     (a bare "rice" must not pick their "Rice cakes"). */
  function savedTier(qWords, food) {
    const n = nameParts(food), qs = qWords.map(singular), brandStr = n.brandStr;
    const inName = w => n.all.indexOf(w) >= 0 || (w.length >= 3 && n.all.some(x => x.startsWith(w)));
    const inBrand = w => n.brand.indexOf(w) >= 0 || (w.length >= 3 && brandStr.indexOf(w) >= 0);
    if (!qs.every(w => inName(w) || inBrand(w))) return 0;
    if (n.main.every(w => qs.indexOf(w) >= 0 || DESCRIPTOR.test(w) || /^\d/.test(w) || n.optional.has(w) || w === "or" || n.brand.indexOf(w) >= 0)) return 2;
    return qs.some(w => !inName(w) && inBrand(w)) ? 1 : 0;
  }
  function myFoodsRaw() { try { return M.foods && M.foods.list ? M.foods.list().filter(f => f && f.name) : []; } catch (e) { return []; } }
  function builtInRaw() { try { const g = M.DB && M.DB.generic; return Array.isArray(g) ? g.filter(f => f && f.name) : []; } catch (e) { return []; } }
  function myMealsRaw() { try { return M.meals && M.meals.list ? M.meals.list().filter(m => m && m.id && m.name && Array.isArray(m.items) && m.items.length) : []; } catch (e) { return []; } }
  /* SD-05: one describe call reads the lists once and remembers every answer (DCTX) */
  let DCTX = null;
  function myFoods() { return DCTX ? DCTX.mine : myFoodsRaw(); }
  function builtInFoods() { return DCTX ? DCTX.built : builtInRaw(); }
  function myMeals() { return DCTX ? DCTX.meals : myMealsRaw(); }
  /* the word index is kept between calls while the foods stay the same */
  let IDX_MEMO = null;
  function newCtx() {
    const ctx = { mine: myFoodsRaw(), built: builtInRaw(), meals: myMealsRaw(), local: new Map(), meal: new Map(), cand: new Map(), idx: null, brands: null };
    const all = ctx.mine.concat(ctx.built);
    const sig = all.map(f => (f.id || "") + "\u0001" + f.name + "\u0001" + (f.brand || "") + "\u0001" + wordsKey(f)).join("\u0002");
    if (IDX_MEMO && IDX_MEMO.sig === sig && IDX_MEMO.all.length === all.length && IDX_MEMO.all.every((f, i) => f === all[i])) { ctx.idx = IDX_MEMO.idx; ctx.brands = IDX_MEMO.brands; return ctx; }
    ctx.idx = new Map(); ctx.brands = new Map();
    /* every word of every name / brand / search word → the foods that have it */
    const add = (map, t, f) => { let a = map.get(t); if (!a) map.set(t, a = new Set()); a.add(f); };
    all.forEach(f => {
      const n = nameParts(f);
      n.all.forEach(t => add(ctx.idx, t, f)); n.brand.forEach(t => add(ctx.idx, t, f)); n.extra.forEach(t => add(ctx.idx, t, f));
      if (n.brandStr) add(ctx.brands, n.brandStr, f);
    });
    IDX_MEMO = { sig, all, idx: ctx.idx, brands: ctx.brands };
    return ctx;
  }
  /* The foods that can hold the word w at all (nameScore's test for the last word they said, a
     little wider): a food outside this set can't match, so it isn't scored. */
  function candidates(ctx, w) {
    let set = ctx.cand.get(w);
    if (set) return set;
    set = new Set();
    ctx.idx.forEach((foods, t) => { if (t === w || (w.length >= 3 && t.startsWith(w)) || (t.length > 3 && w.startsWith(t))) foods.forEach(f => set.add(f)); });
    if (w.length >= 3) ctx.brands.forEach((foods, b) => { if (b.indexOf(w) >= 0) foods.forEach(f => set.add(f)); });
    ctx.cand.set(w, set);
    return set;
  }
  const STATE_WORD = /^(raw|uncooked|dry|cooked|grilled|baked|roasted|boiled|steamed|fried|sauteed|sautéed|seared|broiled|poached|smoked|leftover|leftovers|rotisserie|stirfry)$/i;
  const coreWords = words => { let qw = toks(words); const core = qw.filter(w => !STATE_WORD.test(w) && !STYLE.test(w)); if (core.length) qw = core; return qw; };
  /* SD-16: a saved food found only through words after its comma ("Egg bites, bacon and
     gruyere" for "eggs bacon") isn't what they said, unless they named its main word or brand */
  function flavorOnly(qw, f) {
    if (builtIn(f)) return false;
    const n = nameParts(f), qs = qw.map(singular);
    if (!n.after.length || !n.noun || qs.indexOf(n.noun) >= 0) return false;
    if (qs.some(w => n.brand.indexOf(w) >= 0)) return false;
    return qs.some(w => !/\d/.test(w) && !DESCRIPTOR.test(w) && n.after.indexOf(w) >= 0 && n.head.indexOf(w) < 0);
  }
  /* The person's own saved foods first (a full name match wins outright), then everything
     with a small bonus for saved foods; near-ties go to their own saved food, then to a food
     they buy (built-in `staple`), then to the food with fewer name words they didn't say,
     then to the food listed first. `keep` (optional) limits which foods count. */
  function matchFood(words, keep) {
    const qw = coreWords(words);
    if (!qw.length) return null;
    const state = stateOf(words);
    const ctx = DCTX;
    let pool = null;
    if (ctx) {
      const plain = qw.map(singular).filter(w => !/\d/.test(w));
      if (plain.length) pool = candidates(ctx, plain[plain.length - 1]);
    }
    const ok = f => (!pool || pool.has(f)) && (!keep || keep(f));
    const mine = myFoods();
    let bestMine = null, bestMineS = -Infinity;
    mine.forEach(f => { if (!ok(f)) return; const tier = savedTier(qw, f); if (!tier) return; const sc = nameScore(qw, f, state); if (sc < 0 || flavorOnly(qw, f)) return; const s = tier * 100 + sc + Math.min(8, Math.log2(num(f.uses) + 1) * 2); if (s > bestMineS) { bestMineS = s; bestMine = f; } });
    if (bestMine) return bestMine;
    const scored = [];
    /* a saved food with a flavor they didn't say ("Greek yogurt, vanilla" for "greek yogurt")
       gets no saved-food head start */
    const qsx = qw.map(singular);
    const flavorUnsaid = f => nameParts(f).after.some(w => !/\d/.test(w) && !DESCRIPTOR.test(w) && !LOOSE.test(w) && qsx.indexOf(w) < 0);
    mine.forEach((f, i) => { if (!ok(f)) return; const s = nameScore(qw, f, state); if (s < 0 || flavorOnly(qw, f)) return; const fl = flavorUnsaid(f); scored.push({ f, s: s + (fl ? 0 : 8 + Math.min(8, Math.log2(num(f.uses) + 1) * 2)), i: fl ? 50000 + i : i }); });
    /* a food they buy (built-in `staple`) gets a small bonus: "bread" → their Dave's loaf */
    builtInFoods().forEach((f, i) => { if (!ok(f)) return; const s = nameScore(qw, f, state); if (s >= 0) scored.push({ f, s: s - (f.brand ? 1 : 0) + (f.staple === true ? 3 : 0), i: 100000 + i }); });
    if (!scored.length) return null;
    const top = Math.max.apply(null, scored.map(x => x.s));
    if (top < 8) return null;
    const rank = x => (x.i < 50000 ? 0 : x.f.staple === true ? 1 : 2);
    /* DA-02: between raw / cooked twins, the state they said (none said: raw) */
    const want = state || "raw";
    const st = x => { const ns = nameState(x.f); return !ns ? (hasCook(x.f) ? 0 : 1) : ns === want ? 0 : 2; };
    const near = scored.filter(x => x.s >= top - 3).map(x => Object.assign(x, { u: unsaid(qw, x.f) })).sort((a, b) => rank(a) - rank(b) || st(a) - st(b) || a.u - b.u || a.i - b.i);
    return near[0].f;
  }
  M.food.matchLocal = function (words) {
    const key = String(words == null ? "" : words);
    if (DCTX && DCTX.local.has(key)) return DCTX.local.get(key);
    const f = matchFood(words, null);
    if (DCTX) DCTX.local.set(key, f);
    return f;
  };
  /* A saved meal named in the words: every word they said is in its name (two words or more,
     "chicken bake" → "Chicken veggie bake"), or every real word of its name was said. */
  M.food.matchMeal = function (words, strict) {
    const key = (strict ? "1|" : "0|") + String(words == null ? "" : words);
    if (DCTX && DCTX.meal.has(key)) return DCTX.meal.get(key);
    const qs = coreWords(words).filter(w => !/\d/.test(w));
    /* every word said counts toward the meal's name ("greek yogurt bowl" → Greek yogurt bowl) */
    const said = toks(words).filter(w => !/\d/.test(w) && STYLE.test(w));
    let best = null, bestS = 0;
    if (qs.length) {
      const near = (a, b) => a === b || (a.length > 3 && b.length > 3 && (a.startsWith(b) || b.startsWith(a)));
      myMeals().forEach(m => {
        const mw = wordsOf(m.name).filter(w => !STOP.test(w) && !/\d/.test(w));
        if (!mw.length) return;
        const allQuery = qs.every(q => mw.some(w => near(q, w)));
        const allName = mw.every(w => DESCRIPTOR.test(w) || qs.some(q => near(q, w)) || said.indexOf(w) >= 0);
        if (!((allQuery && allName) || (!strict && ((allQuery && qs.length >= 2) || (allName && mw.length >= 2))))) return;
        const s = (allQuery && allName ? 300 : allName ? 200 : 100) + mw.length * 10 + Math.min(9, num(m.uses));
        if (s > bestS) { bestS = s; best = m; }
      });
    }
    if (DCTX) DCTX.meal.set(key, best);
    return best;
  };
  /* A saved meal as a describe item. Batch meals are logged by cooked weight ("9 oz chicken
     veggie bake"); others by servings. */
  function mealItem(m, q, part) {
    const base = { name: m.name, brand: "", mealId: m.id, source: "meal", text: part };
    const b = isObj(m.batch) ? m.batch : null, cg = b ? num(b.cookedG) : 0;
    if (cg > 0) {
      const metric = (() => { try { const p = M.person ? M.person() : null; return !!(p && p.units === "metric"); } catch (e) { return false; } })();
      const u = q.unit === "g" || q.unit === "oz" || q.unit === "lb" ? q.unit : metric ? "g" : "oz";
      const ug = GRAMS_PER[u];
      const made = num(m.servingsMade, 1) > 1 ? num(m.servingsMade, 1) : 0;
      const grams = q.unit === u && q.explicitQty ? q.qty * ug : made ? cg / made : Math.min(cg, 227);
      const per = {}; NUT.forEach(k => { per[k] = r2(num(m.per && m.per[k]) * ug / cg); });
      let cook = null; try { cook = M.cook && typeof M.cook.batchCook === "function" ? M.cook.batchCook(m) : null; } catch (e) { cook = null; }
      const it = Object.assign(base, { servings: Math.max(0.05, r2(grams / ug)), servingLabel: "1 " + u + " cooked", g: r2(ug), per, state: "cooked", batch: true });
      if (cook) it.cook = cook;
      return it;
    }
    let servings = 1;
    if (q.explicitQty && (!q.unit || q.unit === "serving")) servings = q.qty;
    else if (q.explicitQty && GRAMS_PER[q.unit] && q.unit !== "ml" && q.unit !== "fl oz") {
      const made = num(m.servingsMade, 1) > 0 ? num(m.servingsMade, 1) : 1;
      const gs = m.items.map(x => num(x && x.g) * (num(x && x.servings, 1) || 0));
      const one = gs.every(g => g > 0) ? gs.reduce((a, g) => a + g, 0) / made : 0;
      if (one > 0) servings = (q.qty * GRAMS_PER[q.unit]) / one;
    }
    return Object.assign(base, { servings: Math.max(0.05, r2(servings)), servingLabel: "1 serving", g: null, per: Object.assign({}, m.per || {}) });
  }
  /* SC-06: names that hold a split word stay whole ("half and half", "PB&J"): PB&J becomes
     "pbj sandwich" (expanded to bread + peanut butter + jam), half and half one word. */
  const PBJ_RE = /\b(?:pb\s*(?:&|and|n|'n'|’n’)\s*(?:jelly|jam|j)|pbj|pbnj|peanut\s*butter\s*(?:and|&|n|'n'|’n’)?\s*(?:jelly|jam))s?\b(?:\s+sandwich(?:es)?\b)?/gi;
  function protectPhrases(text) {
    return String(text == null ? "" : text)
      .replace(PBJ_RE, "pbj sandwich")
      .replace(/\bpeanut\s*butter\s+sandwich(es)?\b/gi, "pb sandwich")
      .replace(/\b(?:strawberry\s+)?(?:jelly|jam)\s+sandwich(es)?\b/gi, "jam sandwich")
      .replace(/\bhalf\s*(?:and|&|n|'n'|’n’)\s*half\b/gi, "halfnhalf")
      .replace(/\bstir[\s-]*(?:fry|fried|fries)\b/gi, "stirfry")
      .replace(/\bpb\b(?!\s+sandwich)/gi, "peanut butter");
  }
  function splitDescribe(text) {
    return protectPhrases(text)
      .split(/\n|,|;|\s+(?:and|plus|with|w\/)\s+|\s*\+\s*|\s+&\s+|\s+on\s+(?!the\s+(?:cob|side)\b)/i)
      .map(s => s.trim()).filter(Boolean);
  }
  /* Meat, fish, rice and pasta can carry a cooked profile (food.cook, read through M.cook when
     m-core has it). What people describe is what was on the plate, so amounts are cooked
     unless they say raw / dry. The item then says which weight it is (state + cook). A saved
     scanned meat / rice from before cook info existed borrows it here (cookFor). */
  const SAYS_RAW = /\b(raw|uncooked|dry)\b/i;
  const SAYS_COOKED = /\b(cooked|grilled|baked|roasted|boiled|steamed|fried|sauteed|sautéed|seared|broiled|poached|smoked|leftovers?|stirfry)\b/i;
  /* rawFirst (chicken breast, Nick's rule): the grams are raw unless the words say "cooked" */
  const saysCookedWord = part => /\bcooked\b/i.test(part) && !/\b(raw|uncooked)\b/i.test(part);
  function plateView(food, part, rawFirst, q) {
    let c = null;
    try { c = M.cook && typeof M.cook.of === "function" ? M.cook.of(food) : null; } catch (e) { c = null; }
    if (!c && M.cook && typeof M.cook.of === "function") { const cf = cookFor(food); if (cf) { food = Object.assign({}, food, { cook: cf }); c = cf; } }
    if (!c) return { food, extra: null };
    const cook = { y: num(c.y), word: c.word === "dry" ? "dry" : "raw" };
    /* decision 1: meat and fish are raw weights unless they say cooked / grilled / baked …;
       rice, pasta and quinoa are cooked unless they say dry / uncooked */
    const meatRaw = cook.word === "raw" && !SAYS_COOKED.test(part);
    /* MF-02: "2 oz pasta", "¼ cup rice", "50 g quinoa" are dry amounts */
    const dryAmt = cook.word === "dry" && !SAYS_COOKED.test(part) && dryAmount(food, q);
    if ((SAYS_RAW.test(part) && !SAYS_COOKED.test(part)) || (rawFirst && !saysCookedWord(part)) || (!rawFirst && meatRaw) || dryAmt) return { food, extra: { state: "raw", cook } };
    let v = null;
    try { v = typeof M.cook.view === "function" ? M.cook.view(food, "cooked") : null; } catch (e) { v = null; }
    if (!v || v === food) return { food, extra: null };
    return { food: v, extra: { state: "cooked", cook } };
  }
  /* Nick's rule: chicken breast is always the Kirkland organic breast, and the grams they type
     are RAW grams; one breast is about 175 g raw. m-data marks that food `alwaysRaw` (before
     that: the Kirkland food, or the plain breast id through M.DB.alias). "chicken", "chicken
     breast", "2 chicken breasts", "200 g chicken" → that food, raw. Typed grams are cooked only
     when the words say "cooked". Their own saved chicken breast food still wins. */
  const BREAST_G = 175;
  const BREAST_IDS = /^g_(chicken_breast(_raw|_cooked)?|kirkland_organic_chicken)$/;
  function chickenBreast() {
    const foods = builtInFoods();
    const byId = id => foods.find(f => f.id === id) || null;
    const flagged = foods.find(f => f.alwaysRaw === true && /\bchicken\b/i.test(f.name) && /\bbreast/i.test(f.name));
    if (flagged) return flagged;
    let a = null;
    try { a = M.DB && M.DB.alias ? M.DB.alias.g_chicken_breast : null; } catch (e) { a = null; }
    return (isObj(a) && a.id && byId(a.id)) || byId("g_kirkland_organic_chicken") || byId("g_chicken_breast") || null;
  }
  const builtIn = f => !!(f && (f.source === "generic" || /^g_/.test(String(f.id || ""))));
  const isBreastFood = f => !!(f && builtIn(f) && (BREAST_IDS.test(String(f.id || "")) || (f.alwaysRaw === true && /\bchicken\b/i.test(f.name))));
  const BREAST_WORD = /^(chicken|breast|kirkland|organic|boneless|skinless|frozen|fresh|plain|raw|uncooked|cooked|grilled|baked|roasted|seared|leftover|rotisserie)$/;
  const saysChicken = words => { const w = toks(words); return w.indexOf("chicken") >= 0 && w.every(x => BREAST_WORD.test(x)); };
  /* the breast's own "1 breast" serving (m-data), else 1 breast = 175 g */
  function breastServing(food) {
    const sv = isObj(food.serving) ? food.serving : null;
    if (sv && /breast/i.test(String(sv.unit)) && num(sv.g) > 0) return { g: num(sv.g) / (num(sv.qty, 1) || 1) };
    const alt = (Array.isArray(food.alts) ? food.alts : []).find(a => a && /^1\s+breast\b/i.test(String(a.label)) && num(a.g) > 0);
    return { g: alt ? num(alt.g) : BREAST_G };
  }
  /* → a raw describe item for the breast, or null to let the cooked view handle it
     (only typed weights with the word "cooked") */
  function breastItem(food, q, part) {
    const weight = !!q.unit && (q.unit === "g" || q.unit === "oz" || q.unit === "lb");
    if (weight && saysCookedWord(part)) return null;
    let c = null;
    try { c = M.cook && typeof M.cook.of === "function" ? M.cook.of(food) : null; } catch (e) { c = null; }
    if (!c && isObj(food.cook)) c = food.cook;
    let sc;
    if (!q.unit || /^(piece|serving|large|medium|small)$/.test(q.unit)) {
      const one = breastServing(food).g, n = q.explicitQty ? q.qty : 1;
      const r = scaleToQuantity(food, { qty: one, unit: "g", explicitQty: true, words: "" });
      sc = { servings: n, servingLabel: fmtLabel(1, "breast", r0(one)), g: one * n, per: r.per };
    } else sc = scaleToQuantity(food, q);
    const per = M.foodMath ? M.foodMath.scale(sc.per || food.per, 1) : (sc.per || food.per);
    const it = { name: food.name, brand: food.brand || "", servings: Math.max(0.05, r2(num(sc.servings, 1))), servingLabel: sc.servingLabel, g: sc.g != null ? r1(sc.g) : null, per, foodId: food.id, source: "generic", text: part };
    if (c && num(c.y) > 0) Object.assign(it, { state: "raw", cook: { y: num(c.y), word: "raw" } });
    return it;
  }
  /* Nick's named products: the words they use → the product they buy. Found by name / brand /
     `staple` (m-data may still rename ids), else the plain built-in food. Their own saved food
     with that word in its name still wins. "turkey" / "4 slices turkey" / "deli turkey" /
     "lunch meat" → Hillshire Farm slices; "jam" / "jelly" → Smucker's Natural strawberry;
     "cottage cheese" → Daisy 2%. */
  const nameBrand = f => f.name + " " + (f.brand || "");
  const NAMED = [
    { word: /\b(turkey|lunch ?meat)\b/i,
      say: w => (w.indexOf("turkey") >= 0 || w.indexOf("lunchmeat") >= 0 || ((w.indexOf("lunch") >= 0 || w.indexOf("sandwich") >= 0) && w.indexOf("meat") >= 0)) &&
        w.every(x => /^(turkey|slice|sliced|thin|thinly|shaved|deli|lunch|meat|lunchmeat|oven|roasted|hillshire|farm|ultra|breast)$/.test(x) || (x === "sandwich" && w.indexOf("meat") >= 0)) &&
        (w.indexOf("breast") < 0 || w.some(x => /^(slice|sliced|thin|thinly|shaved|deli|lunch|hillshire)$/.test(x))),
      find: fs => fs.find(f => /hillshire/i.test(nameBrand(f)) && /turkey/i.test(f.name)) || fs.find(f => f.staple === true && /\bturkey\b/i.test(f.name) && /slice|deli|lunch/i.test(f.name)) || fs.find(f => /^deli turkey/i.test(f.name)) },
    { word: /\b(jam|jelly|preserves?)\b/i,
      /* any flavor they name ("grape jelly", "blueberry jam") is still their Smucker's jar */
      say: w => w.some(x => /^(jam|jelly|preserve)$/.test(x)) && w.every(x => /^(jam|jelly|preserve|strawberry|smucker|natural|fruit|spread|grape|blueberry|raspberry|blackberry|apricot|peach|cherry|berry|mixed|apple|plum|fig)$/.test(x)),
      find: fs => fs.find(f => /smucker/i.test(nameBrand(f))) || fs.find(f => f.staple === true && /\b(jam|jelly|preserves|fruit spread)\b/i.test(f.name)) || fs.find(f => /^(jam|jelly)\b/i.test(f.name)) },
    { word: /\bcottage\b/i,
      say: w => w.indexOf("cottage") >= 0 && w.every(x => /^(cottage|cheese|daisy|2%|2|low|fat|lowfat|reduced|small|curd)$/.test(x)),
      find: fs => fs.find(f => /daisy/i.test(nameBrand(f)) && /cottage/i.test(f.name)) || fs.find(f => f.staple === true && /cottage cheese/i.test(f.name)) || fs.find(f => /^cottage cheese,? 2%/i.test(f.name)) }
  ];
  /* → {food, word} for the words they said, or null */
  function namedProduct(words) {
    const w = toks(words);
    if (!w.length) return null;
    for (const p of NAMED) {
      if (!p.say(w)) continue;
      const food = p.find(builtInFoods());
      return food ? { food, word: p.word } : null;
    }
    return null;
  }
  /* SC-03: is Claude's chicken weight cooked? Says raw → raw. Says cooked / grilled / baked … →
     cooked. A photo shows food on a plate, so a photo is cooked unless Claude says raw. Else
     Claude's calories per gram decide: closer to cooked chicken → cooked. */
  function chickenCooked(it, txt, rawP100, cookedP100) {
    if (/\b(raw|uncooked)\b/i.test(txt)) return false;
    if (SAYS_COOKED.test(txt)) return true;
    if (it && it.source === "photo") return true;
    const g = num(it && it.g), cal = num(it && it.per && it.per.cal);
    if (!(g > 0) || !(cal > 0) || !isObj(rawP100) || !isObj(cookedP100)) return false;
    const k = cal / g, kr = num(rawP100.cal) / 100, kc = num(cookedP100.cal) / 100;
    return kc > 0 && kr > 0 && Math.abs(k - kc) < Math.abs(k - kr);
  }
  /* Claude's answers follow the same rule: an item that is chicken breast or one of their named
     products takes the app's own numbers for its grams (the Kirkland breast raw, unless its words
     say "cooked"). Anything else, or an item without grams, stays as Claude gave it. */
  function snapToOwn(it) {
    try {
      if (!isObj(it)) return it;
      const words = String(it.name || "");
      let fromCount = false;
      /* "1 breast" / "2 breasts" with no grams: one breast is 175 g raw (Nick's rule) */
      if (!(num(it.g) > 0) && saysChicken(words)) {
        const q = M.food.parseQuantity(String(it.servingLabel || "")), b = chickenBreast();
        if (b && q.qty > 0 && /^(whole\s+)?breasts?\b/i.test(q.words) && !saysCookedWord(String(it.servingLabel || ""))) { it = Object.assign({}, it, { g: r1(q.qty * breastServing(b).g) }); fromCount = true; }
      }
      if (!(num(it.g) > 0)) return it;
      let food = null, chicken = false;
      if (saysChicken(words)) { food = chickenBreast(); chicken = !!food; }
      else { const np = namedProduct(words); if (np) food = np.food; }
      if (!food || !isObj(food.per100g) || !(num(food.per100g.cal) > 0) || !M.foodMath || typeof M.foodMath.fromPer100 !== "function") return it;
      let p100 = food.per100g, extra = null;
      if (chicken) {
        let c = null;
        try { c = M.cook && typeof M.cook.of === "function" ? M.cook.of(food) : null; } catch (e) { c = null; }
        if (!c && isObj(food.cook)) c = food.cook;
        if (c && num(c.y) > 0) {
          const cooked = !fromCount && chickenCooked(it, words + " " + String(it.servingLabel || ""), food.per100g, c.per100gCooked) && isObj(c.per100gCooked);
          if (cooked) p100 = c.per100gCooked;
          extra = { state: cooked ? "cooked" : "raw", cook: { y: num(c.y), word: "raw" } };
        }
      }
      const per = M.foodMath.fromPer100(p100, num(it.g));
      if (!isObj(per)) return it;
      return Object.assign({}, it, { name: food.name, brand: food.brand || "", per, foodId: food.id }, extra || {});
    } catch (e) { return it; }
  }
  /* SP-01: words about the meal or the time aren't food: "lunch: chicken breast", "for
     breakfast 2 eggs", "lunch was a chicken breast", "I had 2 eggs this morning". "Lunch meat",
     "breakfast sausage" and "breakfast burrito" stay. */
  const MEALW = "breakfast|brunch|lunch|dinner|supper|snacks?|dessert";
  const MEAL_KEEP = "(?!\\s*(?:meats?|sausages?|burritos?|sandwich(?:es)?|bars?|packs?|sizes?)\\b)";
  const MEAL_AT = new RegExp("\\b(?:for|at|as|during)\\s+(?:the\\s+|my\\s+|a\\s+)?(?:" + MEALW + ")\\b" + MEAL_KEEP, "gi");
  const MEAL_LEAD = new RegExp("^\\s*(?:" + MEALW + ")\\b" + MEAL_KEEP + "\\s*(?:[:\\-–—]|\\b(?:was|were|is)\\b)?", "i");
  const TIME_WORDS = /\b(?:later|today|tonight|this\s+(?:morning|afternoon|evening)|last\s+night|yesterday|i|we|had|ate|eaten|was|were|just|then|also)\b/gi;
  function stripMealWords(part) {
    let s = String(part == null ? "" : part).replace(MEAL_AT, " ");
    for (let k = 0; k < 2; k++) s = s.replace(TIME_WORDS, " ").replace(/\s+/g, " ").trim().replace(MEAL_LEAD, " ").trim();
    return s.replace(/^[\s:\-–—]+/, "").replace(/\s+/g, " ").trim();
  }
  /* PL-01: a part nothing matched, said back plainly ("a large mocha frappuccino" → "mocha
     frappuccino") so it can become a new food */
  const unfound = p => {
    const s = String(p).replace(/\bhalfnhalf\b/gi, "half and half").replace(/\bpbj sandwich\b/gi, "PB&J");
    return s.replace(/^(?:(?:a|an|some|the|my|large|small|medium|big|little)\s+)+/i, "").trim() || s;
  };
  const PBJ_NAME = /\b(?:pb\s*(?:&|and|n|'n'|’n’)\s*j|pbj|pbnj|peanut\s*butter\s*(?:and|&|n|'n'|’n’)?\s*(?:jelly|jam))\b/i;
  /* SD-01: a meal said loosely ("chicken bake" → "Chicken veggie bake") counts only with a dish word */
  const MEAL_ONLY = /^(bowl|plate|bake|taco|scramble|skillet|casserole|stir|fry|wrap|sandwich|salad|shake|smoothie|burrito|parfait|stew|soup|chili|curry|omelet|omelette|quesadilla|pizza|burger|toast|oat|oatmeal|platter|combo|hash)$/;
  const saysDish = words => toks(words).some(w => MEAL_ONLY.test(w));
  /* SD-07: "1 cup egg whites" is the liquid kind: a food with a cup / spoon portion */
  const hasVolume = f => {
    const sv = f && f.serving ? f.serving : {};
    if (isVolUnit(String(sv.unit || ""))) return true;
    return (Array.isArray(f && f.alts) ? f.alts : []).some(a => { const p = a && a.label && M.parseServing ? M.parseServing(a.label) : null; return !!(p && isVolUnit(String(p.unit || ""))); });
  };
  /* MF-02: pasta weighed is dry pasta (the box's numbers); rice or quinoa at ¼–⅓ cup or 40–60 g
     is dry; more than that is a cooked portion */
  function dryAmount(food, q) {
    if (!q || !q.explicitQty) return false;
    const u = q.unit, n = num(q.qty);
    const pasta = /\b(pasta|spaghetti|penne|noodles?|macaroni|linguine|fettuccine|rotini|fusilli|rigatoni|orzo)\b/i.test(String(food && food.name));
    const g = u === "g" ? n : u === "oz" ? n * 28.35 : u === "lb" ? n * 453.6 : 0;
    if (pasta) return g > 0;
    if (g > 0) return g >= 40 && g <= 60;
    return u === "cup" && n >= 0.2 && n <= 0.34;
  }
  function editDist(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = []; for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = [i]; let low = i;
      for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (cur[j] < low) low = cur[j]; }
      if (low > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }
  /* SD-13: "chiken breast", "brocoli", "bannana": a word (5+ letters) that no food has becomes the
     closest food word that starts with the same 2 letters (1 letter off; 2 for long words) */
  function fixTypos(text) {
    const ctx = DCTX;
    if (!ctx) return text;
    return String(text).replace(/[a-z]{5,}/gi, w => {
      const lw = lc(w), sw = singular(lw);
      if (ctx.idx.has(sw) || ctx.idx.has(lw) || UNIT_LOOKUP[lw] || STOP.test(lw) || STATE_WORD.test(lw) || STYLE.test(lw) || WORD_NUM[lw] !== undefined || /^(half|quarter|couple|dozen|with|plus|juiced|whole|large|small|medium|halfnhalf|sandwich|later|today|tonight)$/.test(lw)) return w;
      const max = lw.length >= 7 ? 2 : 1;
      let best = null, bd = max + 1;
      ctx.idx.forEach((_, t) => { if (t.length < 4 || t.slice(0, 2) !== lw.slice(0, 2) || /\d/.test(t)) return; const d = editDist(lw, t, max); if (d < bd) { bd = d; best = t; } });
      return best && bd <= max ? best : w;
    });
  }
  M.food.describeLocal = function (text) {
    const outer = DCTX;
    if (!outer) DCTX = newCtx();
    try { return describeRun(text); } finally { if (!outer) DCTX = null; }
  };
  function describeRun(text) {
    const items = [], unmatched = [], memo = new Map();
    /* SP-01: meal and time words go first, unless the part is a saved meal's name */
    const parts = splitDescribe(text).map(p => { const q = M.food.parseQuantity(p); return M.food.matchMeal(q.words || p, true) ? p : stripMealWords(p); }).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      /* a saved meal whose name the split cut apart ("eggs and toast"): exact names only, at
         most 3 parts ("salmon and sweet potato") */
      let took = 0;
      for (let j = Math.min(parts.length - 1, i + 2); j > i && !took; j--) {
        const joined = parts.slice(i, j + 1).join(" and "), q = M.food.parseQuantity(joined);
        const m = M.food.matchMeal(q.words || joined, true);
        if (m) { items.push(mealItem(m, q, joined)); took = j - i + 1; }
      }
      if (took) { i += took - 1; continue; }
      let got = build(parts[i], 0);
      /* SD-13: words nothing matched may be typos: try the closest food words */
      const lost = g => (g ? g.filter(it => it.unknown != null).length : Infinity);
      if (lost(got) > 0) {
        const fx = fixTypos(parts[i]);
        if (fx !== parts[i]) { const g2 = build(fx, 0); if (lost(g2) < lost(got)) got = g2; }
      }
      if (got) got.forEach(it => { if (it.unknown != null) unmatched.push(unfound(it.unknown)); else items.push(it); });
      else unmatched.push(unfound(parts[i]));
    }
    return { items, unmatched };
    /* one part → [items] or null (nothing found) */
    function build(part, depth) {
      const q = M.food.parseQuantity(part);
      if (q.words) q.words = q.words.replace(/\bhalfnhalf\b/gi, "half and half");
      part = part.replace(/\bhalfnhalf\b/gi, "half and half");
      /* SC-06: PB&J = 2 slices of bread, 2 tbsp peanut butter, 1 tbsp jam (per sandwich) */
      const sw = lc(q.words).trim();
      if (/^(pbj|pb|jam) sandwich$/.test(sw) && !q.unit) {
        const kind = sw.split(" ")[0];
        /* SD-02: their own PB&J meal, when they saved one */
        if (kind === "pbj") { const m = myMeals().find(x => PBJ_NAME.test(String(x.name))); if (m) return [mealItem(m, q, part)]; }
        const n = q.explicitQty ? q.qty : 1, f = x => String(+(x * n).toFixed(2));
        const bits = [f(2) + " slices bread"];
        if (kind !== "jam") bits.push(f(2) + " tbsp peanut butter");
        if (kind !== "pb") bits.push(f(1) + " tbsp jam");
        const out = [];
        /* the parts are foods only (never a saved meal like "Peanut butter toast") */
        for (const b of bits) { const got = build(b, SPLIT_DEPTH); if (!got) return null; got.forEach(it => out.push(Object.assign(it, { text: part }))); }
        return out;
      }
      const key = (depth < SPLIT_DEPTH ? "s|" : "n|") + part;
      /* the same words are tried more than once while cutting a note into foods: remember the
         answer (items are plain data; each caller gets its own copy) */
      const copy = list => list.map(it => JSON.parse(JSON.stringify(it)));
      if (memo.has(key)) { const hit = memo.get(key); return hit ? copy(hit) : null; }
      const res = buildOne(part, q, depth);
      memo.set(key, res ? copy(res) : null);
      return res;
    }
    function buildOne(part, q, depth) {
      /* SC-05: foods said together ("chicken rice", "avocado toast", quick notes like "greek
         yogurt blueberries agave" or "2 chicken breasts 1 cup rice broccoli"): when the words
         split into parts that are all foods, each is logged */
      const wsW = String(q.words || "").split(/\s+/).filter(Boolean);
      const canSplit = depth < SPLIT_DEPTH && wsW.length >= 2 && wsW.length <= 12 && !wsW.some(w => DISH.test(singular(lc(w).replace(/[^a-z]/g, ""))));
      /* SD-07: an amount left inside the words ("eggs 2 whites", "toast 2 eggs") means more than
         one food: cut first */
      const midNum = canSplit && wsW.some((w, k) => k > 0 && /^\d+(?:[.,]\d+)?[a-z]*$/i.test(w));
      const at = q.words ? lc(part).lastIndexOf(lc(q.words)) : -1;
      const lead = at > 0 ? part.slice(0, at) : "";
      /* an amount at the end ("chicken 200g rice 1 cup") is the last food's: cut the whole part */
      const tail = at === 0 && q.explicitQty ? part.slice(q.words.length).replace(/[()]/g, " ").trim() : "";
      const ws = tail ? wsW.concat(tail.split(/\s+/).filter(Boolean)) : wsW;
      if (midNum) { const sp = split(); if (sp) return sp; }
      const ok = one(part, q, depth);
      if (ok) return [ok];
      if (canSplit && !midNum) { const sp = split(); if (sp) return sp; }
      return null;
      function split() {
        const n = ws.length;
        const isNum = w => /^(\d+(?:[.,\/]\d+)?[a-z]*|[½¼¾⅓⅔⅛])$/i.test(w);
        const bare = w => singular(lc(w).replace(/[^a-z]/g, ""));
        /* SD-04: a note that puts amounts first ("1 cup rice broccoli 6oz salmon"): an amount
           between two foods starts the next food; else it is the amount of the food before it
           ("chicken 200g rice") */
        const amountsFirst = !!lead || isNum(ws[0]);
        /* A piece is one food: a number only at its start ("1 cup rice") or as its last amount
           ("chicken 200g", "pork tenderloin 6 oz"), never in the middle. */
        const pieceOk = (i, j) => {
          for (let k = i; k < j; k++) {
            if (!isNum(ws[k])) continue;
            if (i === 0 && lead) return false;                    /* "2 chicken breasts 1 cup": two amounts */
            if (k === i) continue;
            /* a last amount needs its unit: "chicken 200g", "pork 6 oz" (never "pork 6" + "oz …") */
            const tail = j - k - 1;
            if (!((tail === 0 && /\d[a-z]+$/i.test(ws[k])) || (tail === 1 && (UNIT_LOOKUP[lc(ws[j - 1])] || /^(breasts?|fillets?|filets?)$/i.test(ws[j - 1]))))) return false;
          }
          /* "oz broccoli" after "6", "breasts" after "chicken": that word belongs to the food before */
          if (i > 0 && ((UNIT_LOOKUP[lc(ws[i])] && UNIT_LOOKUP[lc(ws[i])] !== "egg") || /^(breasts?|fillets?|filets?)$/i.test(ws[i]))) return false;
          /* a piece needs a food word, not only an amount ("1 cup") */
          if (!ws.slice(i, j).some(w => !isNum(w) && !(UNIT_LOOKUP[lc(w)] && UNIT_LOOKUP[lc(w)] !== "egg"))) return false;
          const cw = coreWords(ws.slice(i, j).join(" ")).filter(w => !/\d/.test(w));
          if (!cw.length || cw.every(w => ADJ.test(w))) return false;
          /* "cream cheese", "almond milk": that word makes it a different food, not two foods
             (SD-12: only before a word like milk / cheese / butter: "almonds banana" is two) */
          if (j < n && CHANGER.test(bare(ws[j - 1])) && KIND_OF.test(bare(ws[j]))) return false;
          return true;
        };
        /* the fewest foods that cover every word ("turkey slices | cucumber | cottage cheese",
           not "cottage | cheese"); ties by the amount rule above */
        const best = new Array(n + 1).fill(null);
        best[0] = { cost: 0, items: [] };
        for (let j = 1; j <= n; j++) {
          for (let i = j - 1; i >= 0 && j - i <= 6; i--) {      /* on a tie, the longer earlier food ("egg whites | spinach") */
            if (!best[i] || !pieceOk(i, j)) continue;
            if (i === 0 && j === n) continue;                     /* the whole thing: tried apart */
            /* "banana bread", "grape juice", "banana peppers": one word naming the kind of a
               food that comes in kinds is one food, not two */
            if (n === 2 && KIND_OF.test(bare(ws[1]))) continue;
            /* "lemon pepper chicken", "garlic shrimp": a flavor word before a food is how it
               was made, not a food of its own */
            if (j < n && j - i === 1 && SEASONING.test(bare(ws[i]))) continue;
            /* "lemon pepper chicken", "salt and pepper": pepper after a flavor word is the spice */
            if (j < n && bare(ws[i]) === "pepper" && i > 0 && (SEASONING.test(bare(ws[i - 1])) || /^(black|white|salt)$/.test(bare(ws[i - 1])))) continue;
            const text = (i === 0 ? lead : "") + ws.slice(i, j).join(" ");
            const got = build(text.trim(), SPLIT_DEPTH);
            if (!got) continue;
            const trail = ws.slice(i + 1, j).some(isNum);
            const odd = amountsFirst ? (trail ? 1 : 0) : (i > 0 && isNum(ws[i]) && !ws.slice(0, i).some(isNum) ? 1 : 0);
            const cost = best[i].cost + 10 + odd;
            if (!best[j] || cost < best[j].cost) best[j] = { cost, items: best[i].items.concat(got) };
          }
          /* decision 2: a word no food fits is said back as not found, and the rest of the note
             still counts ("greek yogurt blueberries granola" → 2 foods + "granola") */
          if (best[j - 1] && !(n === 2 && KIND_OF.test(bare(ws[1])))) {
            const prev = best[j - 1].items, last = prev[prev.length - 1];
            const w = (j === 1 ? lead : "") + ws[j - 1];
            const items = last && last.unknown != null ? prev.slice(0, -1).concat([{ unknown: last.unknown + " " + w }]) : prev.concat([{ unknown: w }]);
            const cost = best[j - 1].cost + 100;
            if (!best[j] || cost < best[j].cost) best[j] = { cost, items };
          }
        }
        const got = best[n] ? best[n].items : null;
        /* nothing found at all, or a two-word note with one unknown word ("french toast",
           "mashed potatoes", "teriyaki chicken": a dish, not two foods): the whole part is not found */
        if (!got || !got.some(it => it.unknown == null)) return null;
        /* two words: an unknown word after the food ("chicken strips") or a describing word before
           it ("french toast") makes one dish; a plural before it is its own food ("oats banana") */
        if (n === 2 && (got[got.length - 1].unknown != null || (got[0].unknown != null && !/s$/i.test(ws[0])))) return null;
        return got.filter(it => it.unknown == null || coreWords(it.unknown.replace(/^[\d\s.,\/½¼¾⅓⅔⅛]+/, "")).length);
      }
    }
    function one(part, q, depth) {
      const words = q.words;
      /* SD-01: a saved meal only when they said its name, and never for one piece of a note */
      const piece = depth >= SPLIT_DEPTH;
      const meal = piece ? null : M.food.matchMeal(words || part, true);
      if (meal) return mealItem(meal, q, part);
      let food = words ? M.food.matchLocal(words) : null;
      /* "2 tacos" / "a scoop of whey": the unit word may be the food itself */
      if (!food && q.unit && !/^(g|oz|lb|ml|fl oz|cup|tbsp|tsp|small|medium|large|serving|piece|glass)$/.test(q.unit)) { food = M.food.matchLocal(q.unit + " " + words); if (food) q.unit = null; }
      if (!food && !words && q.unit) { food = M.food.matchLocal(q.unit); if (food) q.unit = null; }
      if (!food && words) food = M.food.matchLocal(part);
      /* toast is bread ("2 slices of toast", "sourdough toast") */
      if (!food && /\btoast\b/i.test(words || part)) food = M.food.matchLocal(String(words || part).replace(/\btoast\b/gi, "bread"));
      /* "1 lemon juiced" is lemon juice */
      if (!food && /\bjuiced\b/i.test(words || part)) food = M.food.matchLocal(String(words || part).replace(/\bjuiced\b/gi, "juice"));
      /* "1 cod fillet", "1 large ear of corn": the piece word isn't the food */
      if (!food && words && /\b(fillets?|filets?|ears?)\b/i.test(words)) { const w2 = words.replace(/\b(fillets?|filets?|ears?)\b(\s+of\b)?/gi, " ").replace(/\s+/g, " ").trim(); if (w2) food = M.food.matchLocal(w2); }
      /* SD-07: a cup of a food that only comes by the piece ("1 cup egg whites"): the same food
         that comes by the cup (liquid egg whites) */
      if (food && words && q.unit && isVolUnit(q.unit) && !hasVolume(food)) {
        const noun = nameParts(food).noun;
        const liq = matchFood(words, f => f !== food && hasVolume(f) && nameParts(f).noun === noun);
        if (liq) food = liq;
      }
      /* chicken breast = the Kirkland breast, raw (Nick's rule) */
      if (saysChicken(words || part) && (!food || builtIn(food) || !/\bbreast/i.test(food.name))) { const b = chickenBreast(); if (b) food = b; }
      if (food && isBreastFood(food)) {
        const b = chickenBreast() || food;
        const it = breastItem(b, q, part);
        if (it) return it;
        food = b;
      }
      /* turkey slices, jam / jelly, cottage cheese = the products they buy (Nick's rule) */
      const np = namedProduct(words || part);
      if (np && (!food || builtIn(food) || !np.word.test(nameBrand(food)))) food = np.food;
      if (!food) {
        /* SD-01: a meal said loosely ("chicken bake") only when no food fits and they said a dish word */
        if (!piece && saysDish(words || part)) { const m = M.food.matchMeal(words || part); if (m) return mealItem(m, q, part); }
        return null;
      }
      const pv = plateView(food, part, /\bchicken\b/i.test(food.name) && /\bbreast/i.test(food.name) && saysChicken(words || part), q);
      const sc = scaleToQuantity(pv.food, q);
      const per = M.foodMath ? M.foodMath.scale(sc.per || pv.food.per, 1) : (sc.per || pv.food.per);
      const servings = Math.max(0.05, r2(num(sc.servings, 1)));
      const it = { name: food.name, brand: food.brand || "", servings, servingLabel: sc.servingLabel, g: sc.g != null ? r1(sc.g) : null, per, foodId: food.id, source: food.source === "generic" ? "generic" : "custom", text: part };
      if (pv.extra) Object.assign(it, pv.extra);
      return it;
    }
  }

  /* A promise that gives up (code "slow") after ms; the original keeps running. */
  function capWait(p, ms) {
    let t = 0;
    const stop = v => { clearTimeout(t); return v; };
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(E("slow", AI_MSG.timeout)), ms); })]).then(stop, e => { stop(); throw e; });
  }
  /* One short note per reason Claude's answer is missing (no raw API text). */
  const DESC_NOTE = {
    offline: "You're offline, so this matched your words to your foods.",
    slow: "Claude was slow, so this matched your words to your foods.",
    timeout: "Claude was slow, so this matched your words to your foods.",
    overloaded: "Claude is busy right now, so this matched your words to your foods.",
    rate_limited: "Claude is busy right now, so this matched your words to your foods.",
    other: "Claude didn't answer, so this matched your words to your foods."
  };
  const CLAUDE_CAP_MS = 6000;
  /* describe(text, {slot, method?:"local", claudeMs?}) → {items, unmatched, method:"ai"|"local", note?}
     Your words are matched on the phone first. When that finds every food, Claude gets ~6 s
     to do better; otherwise it gets its full time. Offline, Claude isn't asked at all. */
  M.food.describe = function (text, opt) {
    opt = isObj(opt) ? opt : {};
    return Promise.resolve().then(async () => {
      const s = String(text == null ? "" : text).trim();
      if (!s) return { items: [], unmatched: [], method: "local" };
      const loc = M.food.describeLocal(s);
      const covered = loc.items.length > 0 && !loc.unmatched.length;
      let aiNote = "";
      if (opt.method !== "local") {
        if (!M.ai.probed()) { try { await withTimeout(M.ai.probe(), 2000); } catch (e) {} }
        if (M.ai.ready() && isOffline()) aiNote = DESC_NOTE.offline;
        else if (M.ai.ready()) {
          try {
            const prompt = "Someone described what they ate: \"" + s.replace(/"/g, "'").slice(0, 2000) + "\"." + slotHint(opt.slot) +
              "\nList each food with the portion they said (or a realistic default if they gave none) and estimate its nutrition.\nReply with ONLY this JSON:\n" + ITEMS_SHAPE + "\n" + ITEMS_RULES;
            const ask = M.ai.json(prompt, { tier: opt.tier || "quick" });
            ask.catch(() => {});
            const j = covered ? await capWait(ask, num(opt.claudeMs) > 0 ? num(opt.claudeMs) : CLAUDE_CAP_MS) : await ask;
            const out = itemsFromAI(j, "ai");
            if (out.items.length) return { items: out.items, unmatched: [], note: out.note, method: "ai" };
          } catch (e) {
            if (isE(e) && (e.code === "auth" || e.code === "forbidden" || e.code === "billing")) throw e;
            aiNote = DESC_NOTE[isE(e) && e.code] || DESC_NOTE.other;
          }
        }
      }
      const out = { items: loc.items, unmatched: loc.unmatched, method: "local" };
      if (aiNote) out.note = aiNote;
      return out;
    });
  };

  M.food.estimateByName = function (name) {
    return Promise.resolve().then(async () => {
      const s = String(name == null ? "" : name).trim();
      if (!s) return null;
      if (!M.ai.probed()) { try { await withTimeout(M.ai.probe(), 2000); } catch (e) {} }
      if (!M.ai.ready()) throw E("no_ai", AI_MSG.no_ai);
      const prompt = "Estimate the nutrition of this food: \"" + s.replace(/"/g, "'").slice(0, 300) + "\". Use its typical single serving in the US (the label serving for packaged foods, a normal portion otherwise).\n" +
        "Reply with ONLY this JSON, no prose, no code fences:\n{\"name\": string (clean name), \"brand\": string (\"\" if generic), \"serving\": {\"qty\": number, \"unit\": string, \"g\": number or null}, " +
        "\"per\": {\"cal\": number, \"p\": number, \"c\": number, \"f\": number, \"fiber\": number, \"sugar\": number, \"sodium_mg\": number}, \"alts\": [{\"label\": string like \"1 oz\", \"g\": number}]}\n" +
        "per is for ONE serving. Calories kcal; p c f fiber sugar grams; sodium_mg milligrams. Numbers only. If this is not a food, reply {\"name\":\"\"}.\n" + FOOD_NOTE;
      const j = await M.ai.json(prompt, { tier: "quick" });
      if (!isObj(j) || !String(j.name || "").trim()) return null;
      const per = perFromAI(j.per);
      const serving = servingFromAI(j.serving, null);
      const alts = (Array.isArray(j.alts) ? j.alts : []).filter(a => isObj(a) && a.label && num(a.g) > 0).map(a => ({ label: cap(a.label, 40), g: r1(num(a.g)) })).slice(0, 4);
      if (serving.g && !alts.some(a => a.g === 100)) alts.push({ label: "100 g", g: 100 });
      const t = now();
      return { id: uid(), name: cap(j.name), brand: cap(j.brand), barcode: "", source: "ai", serving, per, per100g: serving.g ? scaleTo100(per, serving.g) : null, alts, createdAt: t, updatedAt: t, uses: 0, lastUsed: 0, pid: null };
    });
  };

  /* ======================================================================== */
  /* M.food.suggest — your meals, your usual combos, built-in ideas, Claude    */
  /* ======================================================================== */
  function remainingOf(opt) {
    const r = isObj(opt.remaining) ? opt.remaining : null;
    /* a missing calorie number means "not known", not "none left" */
    if (r && r.cal !== null && r.cal !== "" && isNum(Number(r.cal))) return { cal: num(r.cal), p: num(r.p), c: num(r.c), f: num(r.f) };
    try {
      const pid = opt.pid || (M.pid ? M.pid() : null);
      const t = M.person ? M.person(pid).targets : null;
      const eaten = M.log && M.log.totals ? M.log.totals(opt.date || (M.today ? M.today() : undefined), pid) : null;
      if (t && num(t.cal) > 0) return { cal: num(t.cal) - num(eaten && eaten.cal), p: num(t.p) - num(eaten && eaten.p), c: num(t.c) - num(eaten && eaten.c), f: num(t.f) - num(eaten && eaten.f) };
    } catch (e) {}
    return { cal: 600, p: 40, c: 60, f: 20 };
  }
  /* Pure scorer, exported for tests. Higher = better. */
  M.food.scoreSuggestion = function (sug, slot, remaining, prefs, jitter) {
    const per = sug.per || sumPer(sug.items);
    const rem = remaining || { cal: 600, p: 40, c: 60, f: 20 };
    let s = 0;
    if (slot && sug.slot === slot) s += 30;
    const over = per.cal - Math.max(0, rem.cal) - 150;
    if (over > 0) s -= 60 + over / 5;
    const want = { cal: Math.max(150, rem.cal), p: Math.max(10, rem.p), c: Math.max(0, rem.c), f: Math.max(0, rem.f) };
    /* a snack is snack sized: a lunch or dinner idea isn't a better snack for having more */
    if (slot === "Snacks") { want.cal = Math.min(want.cal, 350); want.p = Math.min(want.p, 25); }
    const calDiff = Math.abs(per.cal - Math.min(want.cal, 900)) / Math.max(150, Math.min(want.cal, 900));
    const pDiff = Math.abs(per.p - Math.min(want.p, 60)) / Math.max(15, Math.min(want.p, 60));
    const cDiff = want.c > 0 ? Math.max(0, per.c - want.c) / Math.max(30, want.c) : per.c / 60;
    const fDiff = want.f > 0 ? Math.max(0, per.f - want.f) / Math.max(15, want.f) : per.f / 30;
    s -= 20 * calDiff + 2 * 20 * pDiff + 8 * cDiff + 8 * fDiff;
    if (per.p >= 25) s += 6;
    if (Array.isArray(sug.tags)) {
      if (prefs && prefs.quick && sug.tags.indexOf("quick") >= 0) s += 8;
      if (prefs && prefs.noCook && sug.tags.indexOf("no-cook") >= 0) s += 8;
      if (prefs && prefs.lowCarb && sug.tags.indexOf("low-carb") >= 0) s += 8;
    }
    if (prefs && prefs.store && sug.store && sug.store !== "Either" && sug.store !== prefs.store) s -= 4;
    if (prefs && prefs.maxPrep && num(sug.prepMin) > num(prefs.maxPrep)) s -= 10;
    s += (jitter === undefined ? Math.random() : jitter) * 6;
    return s;
  };
  const fits = (per, rem) => num(per && per.cal) <= Math.max(0, rem.cal) + 150;
  /* Share of an idea's foods that they actually buy (built-in foods marked `staple`), 0…1. */
  function stapleShare(s) {
    const items = Array.isArray(s && s.items) ? s.items : [];
    if (!items.length) return 0;
    let byId = null;
    try { byId = new Map(builtInFoods().map(f => [f.id, f])); } catch (e) { return 0; }
    const food = it => {
      if (!it || !it.foodId) return null;
      let f = byId.get(it.foodId);
      if (!f) { try { const a = M.DB && M.DB.alias && M.DB.alias[it.foodId]; if (a && a.id) f = byId.get(a.id); } catch (e) {} }
      return f || null;
    };
    return items.filter(it => { const f = food(it); return !!(f && f.staple === true); }).length / items.length;
  }
  /* (c) built-in ideas from M.DB.suggest. Ideas made of foods they buy score higher. With no
     calories left, only ideas that still fit (≤ 150) come back, lightest first, and the list
     has .over = true so the screen can say why. */
  M.food.suggestBuiltin = function (opt) {
    opt = isObj(opt) ? opt : {};
    let list = [];
    try { const s = M.DB && M.DB.suggest; list = Array.isArray(s) ? s : []; } catch (e) { list = []; }
    const remaining = remainingOf(opt);
    const n = num(opt.n, 6) || 6;
    const exclude = new Set(Array.isArray(opt.exclude) ? opt.exclude : []);
    const scored = list.filter(s => s && s.id && !exclude.has(s.id)).map(s => ({ s, score: M.food.scoreSuggestion(s, opt.slot, remaining, opt.prefs, opt.jitter) + 8 * stapleShare(s) + (opt.slot && s.slot === opt.slot ? 15 : 0) }));
    scored.sort((a, b) => b.score - a.score);
    const cap = Math.max(0, remaining.cal) + 150;
    const kcalOf = x => num((x.s.per || sumPer(x.s.items)).cal);
    const ok = scored.filter(x => kcalOf(x) <= cap);
    const over = remaining.cal <= 0;
    const pool = over ? ok.sort((a, b) => kcalOf(a) - kcalOf(b)) : ok.length >= n ? ok : scored;
    const out = pool.slice(0, n).map(x => Object.assign({}, x.s, { per: x.s.per || sumPer(x.s.items), source: "idea", score: r1(x.score), items: (x.s.items || []).map(it => Object.assign({ servings: 1 }, it)) }));
    if (over) out.over = true;
    return out;
  };
  /* A logged entry / meal item as a suggestion item: every field passed through as is
     (state, cook and anything newer), minus the entry's own id, slot and time. */
  const snap = e => {
    const o = Object.assign({}, e);
    delete o.id; delete o.slot; delete o.at;
    o.name = String(e.name || "Food"); o.brand = String(e.brand || "");
    o.servings = num(e.servings, 1) > 0 ? num(e.servings, 1) : 1;
    o.servingLabel = e.servingLabel || "1 serving";
    o.g = num(e.g) > 0 ? num(e.g) : null;
    o.per = Object.assign({}, e.per || {});
    if (!o.foodId) delete o.foodId;
    if (!o.mealId) delete o.mealId;
    return o;
  };
  /* (a) the person's own saved meals for this slot (or "Any") that fit what's left */
  M.food.suggestMine = function (opt) {
    opt = isObj(opt) ? opt : {};
    const rem = remainingOf(opt), exclude = new Set(Array.isArray(opt.exclude) ? opt.exclude : []);
    let meals = [];
    try { meals = M.meals && M.meals.list ? M.meals.list(opt.slot) : []; } catch (e) { meals = []; }
    /* batch meals (per = the whole batch, logged by cooked weight) are left to the Foods tab */
    /* KJ-04: the person's own meals first; the other person's carry their name ("Nick's meal") */
    let me = null;
    try { me = M.pid ? M.pid() : null; } catch (e) { me = null; }
    const own = m => !m.pid || !me || m.pid === me;
    const whoOf = pid => {
      try { const p = M.MS && M.MS.profiles && M.MS.profiles[pid]; if (p && p.name) return String(p.name).trim().split(/\s+/)[0]; } catch (e) {}
      try { if (typeof PRESETS !== "undefined" && PRESETS && PRESETS[pid] && PRESETS[pid].name) return String(PRESETS[pid].name); } catch (e) {}
      return pid === "kat" ? "Katerina" : "Nick";
    };
    return meals.filter(m => m && m.id && !exclude.has(m.id) && Array.isArray(m.items) && m.items.length && !(isObj(m.batch) && num(m.batch.cookedG) > 0) && fits(m.per, rem))
      .map(m => ({ m, own: own(m), score: M.food.scoreSuggestion({ per: m.per, slot: m.slot }, opt.slot, rem, null, 0) + Math.min(10, Math.log2(num(m.uses) + 1) * 3) + (m.slot === opt.slot ? 5 : 0) }))
      .sort((a, b) => (b.own ? 1 : 0) - (a.own ? 1 : 0) || b.score - a.score).slice(0, num(opt.n, 3) || 3)
      .map(({ m, own: mine }) => {
        const made = num(m.servingsMade, 1) > 0 ? num(m.servingsMade, 1) : 1;
        const items = m.items.map(it => Object.assign(snap(it), { servings: r2(num(it.servings, 1) / made) }));
        const o = { id: m.id, mealId: m.id, name: m.name, desc: m.desc || "", slot: m.slot, items, per: Object.assign({}, m.per || sumPer(items)), tags: [], source: "mine", uses: num(m.uses), pid: m.pid || me || "", own: mine };
        if (!mine) { o.who = whoOf(m.pid); o.whoLabel = o.who + "'s meal"; }
        return o;
      });
  };
  /* (b) foods logged together in this slot, over the last 60 days (a saved meal counts as one
     item). "Together" = logged within an hour of the first one (a snack at 3 pm and another at
     5 pm are two sittings). → [{id, keys, count, last, items}] most frequent first. */
  const COMBO_GAP = 60 * 60 * 1000;
  const entryKey = e => (e.mealId ? "m:" + e.mealId : e.foodId ? "f:" + e.foodId : "n:" + lc(e.name) + "|" + lc(e.brand));
  M.food.combos = function (pid, slot, days) {
    pid = pid || (M.pid ? M.pid() : null);
    if (!pid || !M.MS || !isObj(M.MS.days) || !slot) return [];
    const today = M.today ? M.today() : "", from = M.addDays ? M.addDays(today, -(num(days, 60) - 1)) : "";
    const sets = [];
    Object.keys(M.MS.days).forEach(id => {
      const d = M.MS.days[id];
      if (!d || d.pid !== pid || !(d.date >= from) || !(d.date <= today) || !Array.isArray(d.entries)) return;
      /* sittings: entries by time; one without a time joins the untimed group */
      const rows = [];
      d.entries.forEach((e, i) => { if (isObj(e) && e.slot === slot && e.name) rows.push({ e, i, at: num(e.at) }); });
      rows.sort((a, b) => a.at - b.at || a.i - b.i);
      const groups = [];
      let cur = null;
      rows.forEach(r => {
        if (!(r.at > 0)) { (groups.untimed = groups.untimed || []).push(r); return; }
        if (!cur || r.at - cur.start > COMBO_GAP) { cur = { start: r.at, rows: [] }; groups.push(cur); }
        cur.rows.push(r);
      });
      const all = groups.map(g => g.rows);
      if (groups.untimed) all.push(groups.untimed);
      all.forEach(g => {
        const map = new Map(), pos = new Map();
        g.forEach(({ e, i }) => { const k = entryKey(e); if (!map.has(k) || num(e.at) >= num(map.get(k).at)) { map.set(k, e); pos.set(k, i); } });
        if (map.size >= 2) sets.push({ keys: Array.from(map.keys()).sort(), map, pos, date: d.date });
      });
    });
    const cand = new Map();
    const addCand = keys => { if (keys.length >= 2) cand.set(keys.join("~"), keys); };
    sets.forEach(s => addCand(s.keys));
    for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) addCand(sets[i].keys.filter(k => sets[j].map.has(k)));
    const out = [];
    cand.forEach((keys, id) => {
      const hits = sets.filter(s => keys.every(k => s.map.has(k)));
      if (hits.length < 2) return;
      const latest = hits.reduce((a, b) => (a.date >= b.date ? a : b));
      const inOrder = keys.slice().sort((a, b) => latest.pos.get(a) - latest.pos.get(b));   /* as they were logged */
      out.push({ id, keys, count: hits.length, last: latest.date, items: inOrder.map(k => snap(latest.map.get(k))) });
    });
    const kept = out.filter(c => !out.some(o => o !== c && o.keys.length > c.keys.length && c.keys.every(k => o.keys.indexOf(k) >= 0) && o.count >= c.count));
    const weight = c => c.count * (1 + 0.15 * c.keys.length);
    return kept.sort((a, b) => weight(b) - weight(a) || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
  };
  const shortName = n => { const s = String(n || "").replace(/\s*\([^)]*\)/g, "").split(",")[0].trim(); return s || String(n || "Food"); };
  /* The foods in a list of items, as one key (amounts ignored): "f:id" or "n:name|brand". */
  const foodsKey = items => (Array.isArray(items) ? items : []).filter(isObj).map(it => (it.foodId ? "f:" + it.foodId : "n:" + lc(String(it.name || "").replace(/\s+/g, " ").trim()) + "|" + lc(it.brand))).sort().join("~");
  M.food.suggestOften = function (opt) {
    opt = isObj(opt) ? opt : {};
    const rem = remainingOf(opt), exclude = new Set(Array.isArray(opt.exclude) ? opt.exclude : []);
    /* a combo that is just one of their saved meals (same foods) is already offered as that meal */
    const saved = new Set();
    try { (M.meals && M.meals.list ? M.meals.list(opt.slot) : []).forEach(m => { if (m && Array.isArray(m.items) && m.items.length) saved.add(foodsKey(m.items)); }); } catch (e) {}
    return M.food.combos(opt.pid, opt.slot, 60)
      .map(c => Object.assign(c, { per: sumPer(c.items), sid: "often:" + c.id }))
      .filter(c => !exclude.has(c.sid) && fits(c.per, rem) && !saved.has(foodsKey(c.items)))
      .slice(0, num(opt.n, 3) || 3)
      .map(c => {
        const names = c.items.map(it => shortName(it.name));
        const name = names.slice(0, 3).join(" + ") + (names.length > 3 ? " + " + (names.length - 3) + " more" : "");
        return { id: c.sid, name, desc: "You ate this " + c.count + " times in the last 2 months.", slot: opt.slot, items: c.items, per: c.per, tags: [], source: "often", count: c.count };
      });
  };
  function pantry() {
    const lines = [], seen = new Set();
    const add = (name, brand, label) => { const k = lc(name) + "|" + lc(brand); if (!name || seen.has(k) || lines.length >= 25) return; seen.add(k); lines.push("- " + name + (brand && lc(name).indexOf(lc(brand)) < 0 ? " (" + brand + ")" : "") + (label ? ", " + label : "")); };
    myFoods().forEach(f => add(f.name, f.brand, M.fmtServing ? M.fmtServing(f.serving) : ""));
    try { (M.recents ? M.recents(M.pid ? M.pid() : null, 40) : []).forEach(r => { if (!r.mealId) add(r.name, r.brand, r.servingLabel); }); } catch (e) {}
    return lines;
  }
  /* What Nick and Katerina actually buy, and what they never eat (Claude's ideas follow this). */
  const STAPLES = "Kirkland organic chicken breast (Costco), pork tenderloin (King Soopers), Dave's Killer Bread, cod, shrimp, scallops, Greek yogurt 2%, Daisy 2% cottage cheese, " +
    "Hillshire Farm oven roasted turkey slices, Smucker's Natural strawberry jam, quinoa, zucchini, broccoli, carrots, Roma tomatoes, white onion, sweet onion, bell pepper, " +
    "asparagus, cucumber, corn on the cob, banana, blueberries, strawberries, lemon, lime, agave syrup";
  const NEVER_EAT = "other cheese (Daisy cottage cheese is fine), oats, cereal, protein shakes, protein bars, protein powder, or restaurant food";
  const SUGGEST_PROMPT = (slot, rem, prefs, foods) =>
    "Suggest 3 " + (slot ? slot.toLowerCase() + " " : "") + "meals for someone in Denver who shops at King Soopers and Costco.\n" +
    "They have about " + r0(rem.cal) + " kcal, " + r0(rem.p) + " g protein, " + r0(rem.c) + " g carbs and " + r0(rem.f) + " g fat left today. " +
    "Each meal must be high in protein, use a good share of the protein that's left, and stay under the calories left." +
    (prefs && prefs.noCook ? " No cooking." : "") + (prefs && prefs.lowCarb ? " Keep carbs low." : "") + (prefs && prefs.quick ? " Under 10 minutes." : "") + "\n" +
    (foods.length ? "Build the meals mostly from foods they already eat (their pantry):\n" + foods.join("\n") + "\nYou may add simple King Soopers or Costco staples.\n" : "Use simple whole foods from King Soopers or Costco.\n") +
    "Foods they buy (use these most): " + STAPLES + ". Olive oil, garlic, spices, soy sauce and rice are fine as small add-ons.\n" +
    "They never eat: " + NEVER_EAT + ". Use agave, not honey.\n" + CHICKEN_NOTE + " For the Daisy, Smucker's and Hillshire foods, use the numbers on the package.\n" +
    "Name and describe each meal in plain words a middle-schooler understands.\n" +
    "Reply with ONLY this JSON, no prose, no code fences:\n{\"suggestions\":[{\"name\": string, \"desc\": string (one plain sentence), \"store\": \"King Soopers\" or \"Costco\" or \"Either\", \"prepMin\": number, " +
    "\"items\":[{\"name\": string, \"servingLabel\": string like \"6 oz (170 g)\", \"g\": number or null, \"per\": {\"cal\": number, \"p\": number, \"c\": number, \"f\": number, \"fiber\": number, \"sugar\": number, \"sodium_mg\": number}}]}]}\n" +
    "per is for that item's whole portion. Calories kcal; p c f fiber sugar grams; sodium_mg milligrams. Numbers only.";
  /* (d) Claude ideas → [] when Claude isn't set up; rejects {code, message} when it fails. */
  M.food.suggestClaude = function (opt) {
    opt = isObj(opt) ? opt : {};
    return Promise.resolve().then(async () => {
      if (!M.ai.probed()) { try { await withTimeout(M.ai.probe(), 1500); } catch (e) {} }
      if (!M.ai.ready()) return [];
      const j = await M.ai.json(SUGGEST_PROMPT(opt.slot, remainingOf(opt), opt.prefs, pantry()), { tier: "quick", cache: false, signal: opt.signal });
      const arr = isObj(j) && Array.isArray(j.suggestions) ? j.suggestions : Array.isArray(j) ? j : [];
      return arr.filter(isObj).map(sg => {
        const items = (Array.isArray(sg.items) ? sg.items : []).filter(isObj).map(it => snapToOwn(itemFromAI(it, "ai")));
        if (!items.length || !String(sg.name || "").trim()) return null;
        return { id: "ai_" + uid(), name: cap(sg.name), desc: cap(sg.desc, 240), slot: opt.slot || "Any", store: /costco/i.test(sg.store) ? "Costco" : /soopers|kroger/i.test(sg.store) ? "King Soopers" : "Either", prepMin: r0(num(sg.prepMin)), items, per: sumPer(items), tags: ["high-protein"], source: "claude" };
      }).filter(Boolean).slice(0, 3);
    });
  };
  /* Why Claude's ideas are missing: one short fixed sentence per reason (no raw API text).
     Problems they must fix themselves (wrong key, no credits, model) keep their own message. */
  const SUG_NOTE = {
    offline: "You're offline, so there are no ideas from Claude.",
    slow: "Claude was slow, so there are no ideas from Claude this time.",
    timeout: "Claude was slow, so there are no ideas from Claude this time.",
    overloaded: "Claude is busy right now. Try again in a minute.",
    rate_limited: "Claude is busy right now. Try again in a minute.",
    network: "Claude isn't answering right now. Try again in a minute.",
    other: "Claude didn't answer. Try again."
  };
  const sugNote = e => {
    const code = isE(e) ? e.code : "";
    if (SUG_NOTE[code]) return SUG_NOTE[code];
    if (["auth", "forbidden", "billing", "model"].indexOf(code) >= 0 && e.message) return e.message;
    return SUG_NOTE.other;
  };
  const SUGGEST_CLAUDE_MS = 20000;
  /* suggest({pid, slot, remaining, prefs, exclude, ai?:false, onClaude?, claudeMs?}) → [Suggestion]
     in this order: "mine" (saved meals that fit) · "often" (usual combos in this slot) · "idea"
     (built-in) · "claude". Never rejects. The phone's own ideas never wait long for Claude:
     - with onClaude(list, note): the phone's ideas come back at once (list.claudePending = true
       while Claude is asked), then onClaude gets Claude's ideas, or [] and a plain note;
     - without it: Claude gets up to claudeMs (20 s), then the list comes back without it.
     list.aiError = why Claude's ideas are missing (plain words); list.over = no calories left. */
  M.food.suggest = function (opt) {
    opt = isObj(opt) ? opt : {};
    const safe = f => { try { return f() || []; } catch (e) { return []; } };
    return Promise.resolve().then(async () => {
      const mine = safe(() => M.food.suggestMine(opt));
      const often = safe(() => M.food.suggestOften(opt));
      const n = Math.max(3, (num(opt.n, 6) || 6) - mine.length - often.length);
      const ideas = safe(() => M.food.suggestBuiltin(Object.assign({}, opt, { n })));
      const out = mine.concat(often, ideas);
      if (ideas.over) out.over = true;
      if (opt.ai === false) return out;
      if (!M.ai.probed()) { try { await withTimeout(M.ai.probe(), 1500); } catch (e) {} }
      if (!M.ai.ready()) return out;
      if (isOffline()) { out.aiError = SUG_NOTE.offline; return out; }
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      const ask = M.food.suggestClaude(Object.assign({}, opt, { signal: ctl ? ctl.signal : undefined }));
      ask.catch(() => {});
      if (typeof opt.onClaude === "function") {
        const cb = opt.onClaude;
        out.claudePending = true;
        ask.then(list => { try { cb(Array.isArray(list) ? list : [], ""); } catch (e) {} },
          e => { try { cb([], sugNote(e)); } catch (x) {} });
        return out;
      }
      try {
        const claude = await capWait(ask, num(opt.claudeMs) > 0 ? num(opt.claudeMs) : SUGGEST_CLAUDE_MS);
        const all = out.concat(claude);
        if (out.over) all.over = true;
        return all;
      } catch (e) {
        if (isE(e) && e.code === "slow" && ctl) { try { ctl.abort(); } catch (x) {} }
        out.aiError = sugNote(e);
        return out;
      }
    }).catch(() => safe(() => M.food.suggestBuiltin(opt)));
  };

  /* Exposed for tests / other modules. */
  M.food._ = { E, withTimeout, fetchJSON, parseJSONText, parseServingSize, scaleToQuantity, sumPer, perFromAI, itemFromAI, fixNum, valuesIn, bandRect, makeAcceptor, cameraErr, labelFromAI, labelWarning, tidyCase, packageGrams, SCAN, TESS, CAM, AI_TIMEOUT };
})(window.M);
