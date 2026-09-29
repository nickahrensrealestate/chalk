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
    const timer = new Promise((_, rej) => { t = setTimeout(() => { timedOut = true; try { if (ctl) ctl.abort(); } catch (e) {} rej(E("timeout", "Reaching " + what + " took too long. Check your connection and try again.")); }, ms || 8000); });
    const onOuter = () => { try { if (ctl) ctl.abort(); } catch (e) {} };
    if (outer && typeof outer.addEventListener === "function") { if (outer.aborted) onOuter(); else outer.addEventListener("abort", onOuter); }
    try {
      let res;
      try { res = await Promise.race([fetch(url, Object.assign(opts, ctl ? { signal: ctl.signal } : {})), timer]); }
      catch (e) {
        if (outer && outer.aborted) throw E("cancelled", "Stopped.");
        if (timedOut || (isE(e) && e.code === "timeout")) throw E("timeout", "Reaching " + what + " took too long. Check your connection and try again.");
        if (isOffline()) throw E("offline", "You're offline. Check your connection and try again.");
        throw E("network", "Couldn't reach " + what + ". Check your connection and try again.");
      }
      let body = null;
      try { body = await Promise.race([Promise.resolve().then(() => res.json()).catch(() => null), timer]); }
      catch (e) { throw E("timeout", "Reaching " + what + " took too long. Check your connection and try again."); }
      return { ok: !!res.ok, status: num(res.status), body };
    } finally {
      clearTimeout(t);
      if (outer && typeof outer.removeEventListener === "function") outer.removeEventListener("abort", onOuter);
    }
  }

  /* Lazy <script> loader (one load per URL, shared promise). */
  const scriptLoads = {};
  function loadScript(url, ready, ms, code, message) {
    try { if (ready()) return Promise.resolve(true); } catch (e) {}
    if (scriptLoads[url]) return scriptLoads[url];
    scriptLoads[url] = new Promise((resolve, reject) => {
      const d = doc();
      if (!d) { delete scriptLoads[url]; return reject(E(code, message)); }
      const s = d.createElement("script");
      s.src = url; s.async = true; s.crossOrigin = "anonymous";
      let done = false;
      const fail = () => { if (done) return; done = true; delete scriptLoads[url]; try { s.remove(); } catch (e) {} reject(E(code, message)); };
      const t = setTimeout(fail, ms || 15000);
      s.onload = () => { clearTimeout(t); if (done) return; done = true; try { if (ready()) resolve(true); else { delete scriptLoads[url]; reject(E(code, message)); } } catch (e) { delete scriptLoads[url]; reject(E(code, message)); } };
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
    return { name: String(it.name || "Food").trim(), brand: String(it.brand || "").trim(), servings: 1, servingLabel: label, g, per: perFromAI(it.per), source: source || "ai" };
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
    overloaded: "Claude is overloaded right now. Try again in a minute.",
    server: "Claude had a problem on its end. Try again.",
    timeout: "Claude took too long to answer. Try again.",
    offline: "You're offline. Check your connection and try again.",
    network: "Couldn't reach Claude. Check your connection and try again.",
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
      if (r.status === 413 || etype === "request_too_large") throw E("too_large", "That photo is too big to send. Try a smaller one.");
      if (/credit balance/i.test(emsg)) throw E("billing", AI_MSG.billing);
      if (r.status === 400 || etype === "invalid_request_error") throw E("bad_request", "Claude couldn't use that request." + (emsg ? " (" + emsg.slice(0, 140) + ")" : ""));
      if (r.status === 503) throw E("overloaded", AI_MSG.overloaded);
      if (r.status >= 500 || etype === "api_error") throw E("server", AI_MSG.server);
      throw E("network", "Claude answered with an error (" + r.status + "). Try again.");
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
    down: "Open Food Facts isn't answering right now. Try again soon, or scan the label.",
    notFound: "This barcode isn't in Open Food Facts yet. Scan the label to add it.",
    noNutrition: "Open Food Facts knows this item but has no nutrition numbers for it. Scan the label to add them."
  };

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
  function tidyCase(s) {
    const letters = s.replace(/[^A-Za-z]/g, "");
    if (letters.length < 3) return s;
    const up = letters.replace(/[^A-Z]/g, "").length;
    if (up / letters.length >= 0.8) {
      return s.split(" ").map((w, i) => w.split("-").map((p, j) => (!p ? p : /\d/.test(p) ? p.toLowerCase() : (i + j > 0 && SMALL_WORD.test(p)) ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())).join("-")).join(" ");
    }
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function offBrand(p) { return tidyCase(tidyText(String((p && p.brands) || "").split(",")[0])); }
  function offName(p, brand) {
    const cands = ["product_name", "product_name_en", "generic_name", "generic_name_en", "abbreviated_product_name"].map(k => tidyText(p && p[k])).filter(Boolean);
    let name = cands[0] || "";
    if (name && brand && lc(name) === lc(brand)) { const better = cands.find(c => lc(c) !== lc(brand)); if (better) name = better; }
    return tidyCase(name);
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
    const pg = packageGrams(product.quantity);
    if (pg && per100g && !(serving.g > 0 && Math.abs(pg - serving.g) <= 5)) alts.push({ label: "1 package", g: r1(pg) });
    const t = now();
    return {
      id: code ? "off_" + code : uid(), name, brand, barcode: code, source: "off",
      serving, per, per100g, alts, quantity: tidyText(product.quantity),
      createdAt: t, updatedAt: t, uses: 0, lastUsed: 0, pid: null
    };
  };

  function localByCode(code) {
    try { return M.foods && typeof M.foods.findByBarcode === "function" ? M.foods.findByBarcode(code) : null; } catch (e) { return null; }
  }
  function saveFound(f) {
    try {
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
      const deadline = now() + Math.max(15000, reqMs * 2);
      let noNut = null, lastErr = null;
      for (const v of vars.slice(0, 3)) {
        const left = deadline - now(); if (left < Math.min(1500, reqMs)) break;
        let r;
        try {
          r = await fetchJSON(OFF_BASE + "/api/v2/product/" + encodeURIComponent(v) + ".json?fields=" + OFF_FIELDS, { method: "GET", headers: { accept: "application/json" } }, Math.min(reqMs, left), "Open Food Facts");
        } catch (e) { lastErr = e; if (e.code === "offline" || e.code === "timeout") break; continue; }
        if (r.status === 429) { lastErr = E("busy", OFF_MSG.busy); break; }
        if (r.status >= 500) { lastErr = E("off_down", OFF_MSG.down); break; }
        lastErr = null;
        const p = r.body && isObj(r.body.product) ? r.body.product : null;
        if (!p || r.body.status === 0 || r.status === 404) continue;
        const f = M.food.fromOFF(p);
        if (f) {
          if (!f.barcode) { f.barcode = v; f.id = "off_" + v; }
          return (M.food.lastLookup = { status: "found", code: raw, food: saveFound(f), saved: false });
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
      const r = await fetchJSON(url, { method: "GET", headers: { accept: "application/json" } }, 8000, "Open Food Facts");
      if (r.status === 429) throw E("busy", "Open Food Facts is busy. Try again in a minute.");
      if (!r.ok || !r.body) throw E("off_down", "Open Food Facts search isn't answering. Try again, or scan the barcode.");
      const list = Array.isArray(r.body.products) ? r.body.products : [];
      const out = [], seen = new Set();
      list.forEach(p => {
        const f = M.food.fromOFF(p);
        if (!f || !(f.per.cal > 0 || (f.per100g && f.per100g.cal > 0))) return;
        const k = lc(f.name) + "|" + lc(f.brand);
        if (seen.has(k)) return;
        seen.add(k); out.push(f);
      });
      return out;
    });
  };

  /* ======================================================================== */
  /* M.food.scanner — live camera barcode scanning                             */
  /* ======================================================================== */
  const SCAN = {
    bd: "https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/iife/ponyfill.js",
    wasm: "https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.3/dist/reader/zxing_reader.wasm",
    formats: ["ean_13", "upc_a", "upc_e", "ean_8"],
    frameMs: 80,       /* ≈12 frames a second */
    agreeMs: 1500,     /* the second matching read must come this soon */
    dedupeMs: 3000,
    maxBandW: 1280
  };
  const CAM = { audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } };
  const SCAN_MSG = {
    load: "The scanner couldn't load. Check your connection, or type the numbers under the bars.",
    insecure: "The camera only works on a secure (https) page. Take a photo of the barcode or type the numbers.",
    noCamera: "This browser can't open the camera. Take a photo of the barcode or type the numbers.",
    blocked: "Camera is blocked. Allow it when your phone asks, or in Settings → Safari → Camera. You can also take a photo of the barcode.",
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
  let enginePromise = null, engineKind = null;
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
  const WORKER_SRC = [
    "var det = null, boot = null;",
    "function init() {",
    "  if (!boot) boot = new Promise(function (res, rej) {",
    "    try {",
    "      importScripts(" + JSON.stringify(SCAN.bd) + ");",
    "      var api = self.BarcodeDetectionAPI;",
    "      api.setZXingModuleOverrides({ locateFile: function (p, pre) { return /\\.wasm$/.test(p) ? " + JSON.stringify(SCAN.wasm) + " : pre + p; } });",
    "      det = new api.BarcodeDetector({ formats: " + JSON.stringify(SCAN.formats) + " });",
    "      api.prepareZXingModule({ fireImmediately: true }).then(function () { res(true); }, rej);",
    "    } catch (e) { rej(e); }",
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
    return loadScript(SCAN.bd, ready, 20000, "scanner_load", SCAN_MSG.load).then(() => {
      const api = win().BarcodeDetectionAPI;
      api.setZXingModuleOverrides({ locateFile: (p, pre) => (/\.wasm$/.test(p) ? SCAN.wasm : pre + p) });
      const det = new api.BarcodeDetector({ formats: SCAN.formats });
      return withTimeout(api.prepareZXingModule({ fireImmediately: true }), 25000, "scanner_load", SCAN_MSG.load)
        .then(() => ({ kind: "wasm", detect: src => Promise.resolve().then(() => det.detect(src)).then(mapCodes, () => []), close() {} }));
    });
  }
  function getEngine() {
    if (!enginePromise) {
      enginePromise = Promise.resolve().then(async () => {
        if (isOffline() && typeof win().BarcodeDetector !== "function") throw E("scanner_load", SCAN_MSG.load);
        return (await nativeEngine()) || (await workerEngine()) || mainEngine();
      }).then(e => { engineKind = e.kind; return e; }, err => { enginePromise = null; throw isE(err) ? err : E("scanner_load", SCAN_MSG.load); });
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
        let engine;
        try { engine = await eng; }
        catch (e) { await stopSession(s); throw isE(e) ? e : E("scanner_load", SCAN_MSG.load); }
        if (!alive()) { await stopSession(s); return false; }
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
      if (e && typeof e.then === "function") { enginePromise = e; engineKind = null; return; }
      enginePromise = e ? Promise.resolve(e) : null; engineKind = e ? e.kind : null;
    },
    _grab: null,
    _cur() { return cur; }
  };

  /* ======================================================================== */
  /* M.food.label — Nutrition Facts parser (pure) + reader (Claude or OCR)     */
  /* ======================================================================== */
  /* OCR digit confusions inside a number: O→0 l/I/|→1 S→5 B→8 Z→2 */
  const OCR_DIGITS = "0-9OoDQlIi|!SsBZz";
  function fixNum(tok) {
    let s = String(tok || "").trim();
    s = s.replace(/[OoDQ]/g, "0").replace(/[lIi|!]/g, "1").replace(/[Ss]/g, "5").replace(/[B]/g, "8").replace(/[Zz]/g, "2");
    if (/^\d{1,3},\d{3}$/.test(s)) s = s.replace(",", "");        /* 1,020 mg */
    s = s.replace(/,/g, ".").replace(/[^\d.\/]/g, "");
    if (s.includes("/")) { const [a, b] = s.split("/"); const d = num(b); return d ? num(a) / d : num(a, NaN); }
    const v = parseFloat(s);
    return isNum(v) ? v : NaN;
  }
  /* A value token as OCR writes it: real digits with O/l/I/S/B confusions (≥1 real digit,
     or a lone O / o before a unit, as in "Trans Fat Og"), an optional decimal, then a unit. */
  const VALUE_RE = new RegExp("(<\\s*|less\\s+than\\s+)?((?:\\d[" + OCR_DIGITS + "]*|[" + OCR_DIGITS + "]*\\d[" + OCR_DIGITS + "]*|[OolI|](?=\\s*m?g\\b))(?:[.,]\\d+)?)\\s*(mg|mcg|µg|kcal|kj|cal|g|9|q)?(?![a-z0-9])", "gi");
  function valuesIn(tail) {
    const out = []; let m;
    VALUE_RE.lastIndex = 0;
    while ((m = VALUE_RE.exec(tail))) {
      if (!m[2]) { VALUE_RE.lastIndex++; continue; }
      const after = tail.slice(m.index + m[0].length).replace(/^\s+/, "");
      if (after[0] === "%" && !m[3]) continue;                           /* a % Daily Value */
      const v = m[1] ? 0.5 : fixNum(m[2]);
      if (!isNum(v)) continue;
      out.push({ v, unit: lc(m[3] || ""), raw: m[2], lt: !!m[1] });
    }
    return out;
  }
  /* Label words end at "not followed by a letter" (not \b) so OCR that drops the space
     ("TotalFat8g", "Sodium160mg", "Protein3g") still matches. */
  const T = "t[o0]ta[l1I|]", NL = "(?![a-z])";
  const LINE = {
    footnote: /daily\s*value|daily\s*diet|a\s*day\s*is|calories\s*a\s*day|\bdiet\b|per\s*gram|nutrition\s*advice|contributes|percent\s*daily|not\s*a\s*significant/i,
    cal: new RegExp("\\b(ca[l1I|][o0]r[i1l|]e?s|calor[i1l|]es|energy|[eé]nergie|kcal)" + NL, "i"),
    fat: new RegExp("\\b" + T + "\\s*fat" + NL + "|^\\s*(fat|lipides|l[i1]pids)" + NL, "i"),
    sodium: new RegExp("\\bs[o0]d[i1l|]um" + NL, "i"),
    carb: new RegExp("\\b" + T + "\\s*carb[a-z]*\\.?|^\\s*(carbohydrates?|carbs?|glucides)" + NL, "i"),
    fiber: new RegExp("\\b(dietary\\s*)?f[i1l|]b(er|re)s?" + NL, "i"),
    sugar: new RegExp("\\b" + T + "\\s*sugars?" + NL + "|^\\s*(sugars?|sucres)" + NL, "i"),
    protein: new RegExp("\\bpr[o0]te[i1l|]ns?" + NL + "|\\bprot[eé]ines" + NL, "i")
  };
  const KEYS = { cal: "cal", fat: "f", sodium: "sodium", carb: "c", fiber: "fiber", sugar: "sugar", protein: "p" };
  const SUBLINE = { fat: /saturated|trans|sat\.|poly|mono|calories\s*from/i, carb: /net\s*carb|sugar/i, fiber: /soluble|insoluble/i, sugar: /added|includes|alcohol|incl\./i, cal: /from\s*fat|per\s*gram/i, protein: /%\s*dv\s*$/i, sodium: /^$/ };
  /* the label word itself, removed before reading the number */
  const LABEL_WORD = {
    cal: new RegExp("^.*?\\b(ca[l1I|][o0]r[i1l|]e?s|calor[i1l|]es|energy|[eé]nergie|kcal)" + NL + "(\\s*/\\s*calories" + NL + ")?", "i"),
    fat: new RegExp("^.*?(" + T + "\\s*fat|fat|lipides|l[i1]pids)" + NL + "(\\s*/\\s*lipides" + NL + ")?", "i"),
    sodium: new RegExp("^.*?\\bs[o0]d[i1l|]um" + NL + "(\\s*/\\s*sodium" + NL + ")?", "i"),
    carb: new RegExp("^.*?(" + T + "\\s*carb[a-z]*\\.?|carbohydrates?|carbs?)(\\s*/\\s*glucides" + NL + ")?|^\\s*glucides" + NL, "i"),
    fiber: new RegExp("^.*?\\b(dietary\\s*)?f[i1l|]b(er|re)s?" + NL + "(\\s*/\\s*fibres?" + NL + ")?", "i"),
    sugar: new RegExp("^.*?(" + T + "\\s*sugars?|sugars?|sucres)" + NL + "(\\s*/\\s*sucres" + NL + ")?", "i"),
    protein: new RegExp("^.*?\\b(pr[o0]te[i1l|]ns?|prot[eé]ines)" + NL + "(\\s*/\\s*prot[eé]ines" + NL + ")?", "i")
  };
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
  function servingsPerContainer(text) {
    const s = String(text);
    let m = /(?:about|approx\.?|abt\.?)?\s*([\d.,]+)\s+servings?\s+per\s+container/i.exec(s);
    if (m) return num(m[1], null);
    m = /servings?\s+per\s+container[:\s]*(?:about|approx\.?|abt\.?)?\s*([\d.,]+)/i.exec(s);
    return m ? num(m[1], null) : null;
  }
  /* "39" read for "3g": the 9 is a misread g. Try dropping it on suspects when that makes
     4p + 4c + 9f land much closer to the label's calories. */
  function fixGlued9(per, found, cal) {
    const sus = ["p", "c", "f"].filter(k => found[k] && found[k].glued);
    if (sus.length && cal > 0) {
      const kcal = o => num(o.p) * 4 + num(o.c) * 4 + num(o.f) * 9;
      const err = o => Math.abs(kcal(o) - cal) / cal;
      let best = null, bestErr = err(per);
      for (let mask = 1; mask < (1 << sus.length); mask++) {
        const o = Object.assign({}, per);
        sus.forEach((k, i) => { if (mask & (1 << i)) o[k] = Math.floor(per[k] / 10); });
        const e = err(o);
        if (e < bestErr - 0.15) { best = o; bestErr = e; }
      }
      if (best && err(per) > 0.3) Object.assign(per, best);
    }
    ["fiber", "sugar"].forEach(k => { if (found[k] && found[k].glued && per[k] > num(per.c) + 1 && Math.floor(per[k] / 10) <= num(per.c) + 1) per[k] = Math.floor(per[k] / 10); });
  }

  M.food.label = M.food.label || {};
  /* parse(text) → {serving:{qty,unit,g}, per:{cal,p,c,f,fiber,sugar,sodium}, fields:[…found keys, "serving"],
     servingsPerContainer?, name?, source:"label"} — pure, never throws. First column = per serving. */
  M.food.label.parse = function (text) {
    const raw = String(text == null ? "" : text);
    const per = { cal: 0, p: 0, c: 0, f: 0, fiber: 0, sugar: 0, sodium: 0 };
    const fields = [], found = {};
    const lines = raw.replace(/\r/g, "").replace(/[‘’`´]/g, "'").replace(/[–—]/g, "-").split("\n")
      .map(l => l.replace(/[*†‡]+/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
    const numberish = l => /^[<]?\s*[\dOolI|.,]+\s*(mg|g|9|kcal|kj|cal)?\s*(\d+\s*%)?$/i.test(l);
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
        const tail = line.replace(LABEL_WORD[field], " ");
        if (field === "cal" ? /^\s*from\b/i.test(tail) || /per\s*gram/i.test(line) : SUBLINE[field].test(line) && i !== pref) continue;
        let hit = pickValue(field, valuesIn(tail));
        if (!hit && i + 1 < lines.length && numberish(lines[i + 1])) hit = pickValue(field, valuesIn(lines[i + 1]));
        if (!hit && field === "cal" && i > 0 && numberish(lines[i - 1]) && /^\s*[\dOolI|]{2,4}\s*$/.test(lines[i - 1])) hit = pickValue(field, valuesIn(lines[i - 1]));
        if (!hit) continue;
        let v = hit.v;
        if (field === "sodium" && hit.unit === "g") v = v * 1000;
        if (field === "cal" && v > 2000 && v % 10 === 0 && String(hit.raw).length >= 4) v = Math.floor(v / 10);
        if (!isNum(v) || v < 0 || (field !== "sodium" && field !== "cal" && v > 300) || (field === "cal" && v > 3000)) continue;
        const glued = !hit.unit && !hit.lt && /9$/.test(String(hit.raw)) && String(hit.raw).replace(/\D/g, "").length >= 2 && field !== "cal" && field !== "sodium";
        found[key] = { v, glued };
        per[key] = key === "cal" || key === "sodium" ? r0(v) : r1(v);
        fields.push(key);
        break;
      }
    }
    fixGlued9(per, found, per.cal);
    NUT.forEach(k => { per[k] = k === "cal" || k === "sodium" ? r0(per[k]) : r1(per[k]); });
    if (found.cal === undefined && (found.p || found.c || found.f)) per.cal = r0(num(per.p) * 4 + num(per.c) * 4 + num(per.f) * 9);
    const sv = parseServingLine(raw);
    const serving = sv || { qty: 1, unit: "serving", g: null };
    if (sv) fields.push("serving");
    const out = { serving, per, fields, source: "label" };
    const spc = servingsPerContainer(raw);
    if (spc && spc > 0) out.servingsPerContainer = spc;
    const nfIdx = lines.findIndex(l => /nutr[i1l|]t[i1l|]on\s*facts|valeur\s*nutritive/i.test(l));
    for (let i = 0; i < (nfIdx > 0 ? nfIdx : 0); i++) { const l = lines[i]; if (/^[A-Za-z][A-Za-z '&-]{2,40}$/.test(l) && !/serving|calories|amount/i.test(l)) { out.name = tidyCase(l); break; } }
    return out;
  };

  /* tesseract.js 5.1.1 — every file pinned on jsdelivr (worker, SIMD/non-SIMD LSTM core, English best_int data). */
  const TESS = {
    script: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js",
    workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js",
    corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1",
    langPath: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int"
  };
  const tessReady = () => !!(win().Tesseract && typeof win().Tesseract.createWorker === "function");
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
    "If no nutrition label is visible, reply {\"found\": false}.";

  async function ocrText(file, say) {
    say("Loading the reader…");
    await loadScript(TESS.script, tessReady, 20000, "ocr_load", "The label reader couldn't load. Check your connection, or add your Anthropic key in You → AI.");
    say("Preparing the photo…");
    const prep = await M.img.prepOCR(file, { min: 1600, max: 2200 });
    say("Reading label…");
    const Tess = win().Tesseract;
    let worker = null;
    try {
      worker = await withTimeout(Tess.createWorker("eng", 1, {
        workerPath: TESS.workerPath, corePath: TESS.corePath, langPath: TESS.langPath, workerBlobURL: true,
        logger: m => { if (m && m.status === "recognizing text" && isNum(m.progress)) say("Reading label… " + Math.round(m.progress * 100) + "%"); }
      }), 60000, "ocr", "The label reader took too long to start. Check your connection and try again.");
      const read = async psm => {
        try { await worker.setParameters({ tessedit_pageseg_mode: String(psm), preserve_interword_spaces: "1" }); } catch (e) {}
        const res = await withTimeout(worker.recognize(prep.canvas || prep.blob), 60000, "ocr", "Reading the label took too long. Try a closer, brighter photo.");
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
      throw wrapErr(e, "ocr", "The label couldn't be read. Try a closer, brighter photo, or type it in.");
    } finally {
      if (worker) { try { await worker.terminate(); } catch (e) {} }
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
    const food = { name: tidyText(o.name), brand: tidyText(o.brand), serving, per, per100g, alts: serving.g ? [{ label: "100 g", g: 100 }] : [], source: "label" };
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
      if (!M.ai.probed()) { try { await withTimeout(M.ai.probe(), 2000); } catch (e) {} }
      const canAI = opt.method !== "ocr" && M.ai.ready() && await M.ai.images();
      if (canAI) {
        say("Reading label with Claude…");
        try {
          const food = labelFromAI(await M.ai.json(LABEL_PROMPT, { images: [file] }));
          const warning = labelWarning(food.per);
          return warning ? { food, method: "ai", rawText: "", warning } : { food, method: "ai", rawText: "" };
        } catch (e) {
          if (isE(e) && ["auth", "forbidden", "rate_limited", "billing", "no_label", "cancelled"].indexOf(e.code) >= 0) throw e;
          say("Claude couldn't read it. Trying the built-in reader…");
        }
      }
      const rawText = await ocrText(file, say);
      const parsed = M.food.label.parse(rawText);
      if (!parsed.fields.length || (!parsed.per.cal && !parsed.per.p && !parsed.per.c && !parsed.per.f)) throw E("ocr", "Couldn't find the numbers on that label. Try a closer, brighter photo, or type them in.", rawText);
      const food = { name: parsed.name || "", brand: "", serving: parsed.serving, per: parsed.per, per100g: parsed.serving.g ? scaleTo100(parsed.per, parsed.serving.g) : null, alts: parsed.serving.g ? [{ label: "100 g", g: 100 }] : [], source: "label" };
      if (parsed.servingsPerContainer) food.servingsPerContainer = parsed.servingsPerContainer;
      const out = { food, method: "ocr", rawText, fields: parsed.fields };
      const warning = labelWarning(parsed.per);
      if (warning) out.warning = warning;
      return out;
    });
  };

  /* ======================================================================== */
  /* M.food.photo / describe / estimateByName                                  */
  /* ======================================================================== */
  const ITEMS_SHAPE = "{\"items\":[{\"name\": string, \"servingLabel\": string like \"1 cup (240 g)\" or \"4 oz (113 g)\", \"g\": number (grams of this portion) or null, " +
    "\"per\": {\"cal\": number, \"p\": number, \"c\": number, \"f\": number, \"fiber\": number, \"sugar\": number, \"sodium_mg\": number}}], \"note\": string (one short plain sentence about how sure you are)}";
  const ITEMS_RULES = "Rules: \"per\" is for the WHOLE portion in servingLabel (one line per food). Calories in kcal; p c f fiber sugar in grams; sodium_mg in milligrams. " +
    "Use realistic US home portions. Numbers only, no units, no ranges. Reply with ONLY the JSON, no prose, no code fences.";
  const slotHint = slot => (slot ? " This is for " + slot + "." : "");
  function itemsFromAI(j, source) {
    const arr = isObj(j) && Array.isArray(j.items) ? j.items : Array.isArray(j) ? j : [];
    const items = arr.filter(isObj).map(it => itemFromAI(it, source)).filter(it => it.name);
    return { items, note: isObj(j) && j.note ? String(j.note) : "" };
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
    egg: ["egg", "eggs"], handful: ["handful", "handfuls"], bag: ["bag", "bags"], packet: ["packet", "packets", "pack"], link: ["link", "links"], stick: ["stick", "sticks"]
  };
  const UNIT_LOOKUP = {}; Object.keys(UNIT_WORDS).forEach(u => UNIT_WORDS[u].forEach(w => { UNIT_LOOKUP[w] = u; }));
  const WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12 };

  /* "1.5 cups rice" → {qty:1.5, unit:"cup", words:"rice", raw, explicitQty} */
  M.food.parseQuantity = function (phrase) {
    let s = String(phrase == null ? "" : phrase).trim().replace(/\s+/g, " ").replace(/^(about|around|roughly|like|maybe)\s+/i, "");
    const raw = s;
    let qty = null, unit = null;
    s = s.replace(/(\d)\s*-\s*(?=(oz|ounce|g|gram|lb|cup|tbsp|tsp|ml)\b)/i, "$1 ");          /* "5-oz" → "5 oz" */
    const m = /^(\d+\s*[½¼¾⅓⅔⅛]|[½¼¾⅓⅔⅛])\s*/.exec(s)
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
    const xm = /\s*[x×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(s);
    if (xm) { qty = (qty == null ? 1 : qty) * num(xm[1], 1); s = s.slice(0, xm.index); }
    if (qty == null) {                                   /* trailing amount: "chicken thigh 8 oz", "rice (1 cup)" */
      const tm = /\s*\(?\s*(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)?\.?\s*\)?\s*$/.exec(s);
      if (tm && tm.index > 0) {
        qty = qtyOf(tm[1]);
        const uw = lc(tm[2] || "");
        if (uw && UNIT_LOOKUP[uw] && UNIT_LOOKUP[uw] !== "egg") unit = UNIT_LOOKUP[uw];
        else if (uw === "floz") unit = "fl oz";
        s = s.slice(0, tm.index);
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
    const words = s.replace(/^of\s+/i, "").replace(/[.,;:!]+$/, "").trim();
    return { qty: qty == null ? 1 : qty, unit, words, raw, explicitQty: qty != null };
  };

  const GRAMS_PER = { g: 1, oz: 28.35, lb: 453.6, ml: 1, "fl oz": 29.57 };
  const VOL_CUPS = { cup: 1, tbsp: 1 / 16, tsp: 1 / 48, ml: 1 / 240, "fl oz": 1 / 8 };
  const COUNTISH = /^(large|medium|small|whole|each|piece|pieces|slice|slices|egg|eggs|large egg|large eggs|link|links|bar|bars|cake|cakes|stick|sticks|fruit|tomato|tomatoes|patty|patties|breast|thigh|fillet|filet|tortilla|bagel|muffin|banana|apple|orange|potato|can|bottle|container|cup of yogurt|scoop|packet|pouch)$/i;
  const unitBase = u => lc(u).replace(/,.*$/, "").replace(/\(.*$/, "").trim();
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
    const u = q.unit;
    if (!u) {
      if (!q.explicitQty) return own(1);                                  /* "broccoli" → one normal serving */
      if (!isVolUnit(svUnit) && !isWeightUnit(svUnit)) return own(q.qty / svQty);   /* "2 eggs" on "1 large egg" */
      const count = alts.find(a => { const p = M.parseServing ? M.parseServing(a.label) : null; return p && COUNTISH.test(unitBase(p.unit)); });
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
    if (unitMatches(u, svUnit)) return own(q.qty / svQty);               /* "1.5 cups rice" on a "1 cup" food */
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
      const sAlt = alts.find(a => new RegExp("\\b" + u + "\\b", "i").test(a.label));
      if (sAlt) { const r = altRow(sAlt, q.qty); if (r) return r; }
      return own(q.qty * size);
    }
    return own(q.qty);
  }

  const WORD_SPLIT = /[^\p{L}\p{N}%]+/u;
  const DESCRIPTOR = /^(large|medium|small|whole|plain|old|fashioned|style|cooked|raw|dry|fresh|frozen|canned|drained|boneless|skinless|lean|light|reduced|fat|free|low|nonfat|unsweetened|sweetened|creamy|crunchy|organic|regular|original|classic|with|no|in|water|oil|and|of|the|a|an|per|kirkland|kroger|signature|brand|slice|slices|cup|oz|g|lb|chopped|sliced|diced|grilled|baked|roasted|steamed|boiled|sauteed|salted|unsalted|natural|pure|simple|fat-free)$/i;
  const STOP = /^(of|the|some|with|and|a|an|my|plain|cooked|fresh|whole)$/i;
  const toks = s => lc(s).split(WORD_SPLIT).filter(w => w && (w.length > 1 || /\d/.test(w)) && !STOP.test(w));
  const singular = w => (w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.replace(/(ie)s$/, "y").replace(/(o|ch|sh|x)es$/, "$1").replace(/s$/, "") : w);
  const wordsOf = s => lc(s).split(WORD_SPLIT).filter(w => w && (w.length > 1 || /\d/.test(w))).map(singular);
  function nameParts(food) {
    const full = lc(food.name), main = full.replace(/\([^)]*\)/g, " "), head = main.split(/[,(]/)[0];
    const mw = main.split(WORD_SPLIT).filter(Boolean);
    const optional = new Set();
    mw.forEach((w, i) => { if (w === "or") { if (mw[i - 1]) optional.add(singular(mw[i - 1])); if (mw[i + 1]) optional.add(singular(mw[i + 1])); } });
    return { full, all: wordsOf(full), main: wordsOf(main), head: wordsOf(head), brand: wordsOf(food.brand || ""), optional };
  }
  /* -1 = no word matches; higher is better. */
  function nameScore(qWords, food) {
    const n = nameParts(food), qs = qWords.map(singular), brandStr = lc(food.brand || "");
    let s = 0, hits = 0;
    for (const w of qs) {
      if (n.all.indexOf(w) >= 0) { hits++; s += 20; if (n.head.indexOf(w) >= 0) s += 6; }
      else if (n.all.some(x => (x.startsWith(w) && w.length >= 3) || (w.startsWith(x) && x.length > 3))) { hits++; s += 10; }
      else if (n.brand.indexOf(w) >= 0 || (w.length >= 3 && brandStr.indexOf(w) >= 0)) { hits++; s += 8; }
      else s -= 8;
    }
    if (!hits) return -1;
    let pen = 0;
    n.main.forEach(w => { if (qs.indexOf(w) >= 0 || w === "or" || n.optional.has(w) || n.brand.indexOf(w) >= 0) return; pen += DESCRIPTOR.test(w) || /^\d/.test(w) ? 0.5 : 4; });
    s -= Math.min(10, pen);
    if (n.head.length && n.head.every(w => qs.indexOf(w) >= 0 || DESCRIPTOR.test(w) || n.optional.has(w) || n.brand.indexOf(w) >= 0)) s += 12;
    if (/\braw\b|uncooked|\bdry\b/.test(n.full) && !qs.some(w => /^(raw|dry|uncooked)$/.test(w))) s -= 6;
    if (/\bcooked\b/.test(n.full)) s += 2;
    return s;
  }
  /* How a saved food answers the words: 2 = every query word is in its name/brand AND every
     real word of its name was asked for ("chicken breast" → "Organic Chicken Breast");
     1 = every query word is there and at least one only through the brand, i.e. they named
     the product by brand ("dave's bread" → their Dave's Killer Bread loaf); 0 = neither
     (a bare "rice" must not pick their "Rice cakes"). */
  function savedTier(qWords, food) {
    const n = nameParts(food), qs = qWords.map(singular), brandStr = lc(food.brand || "");
    const inName = w => n.all.indexOf(w) >= 0 || (w.length >= 3 && n.all.some(x => x.startsWith(w)));
    const inBrand = w => n.brand.indexOf(w) >= 0 || (w.length >= 3 && brandStr.indexOf(w) >= 0);
    if (!qs.every(w => inName(w) || inBrand(w))) return 0;
    if (n.main.every(w => qs.indexOf(w) >= 0 || DESCRIPTOR.test(w) || /^\d/.test(w) || n.optional.has(w) || w === "or" || n.brand.indexOf(w) >= 0)) return 2;
    return qs.some(w => !inName(w) && inBrand(w)) ? 1 : 0;
  }
  function myFoods() { try { return M.foods && M.foods.list ? M.foods.list().filter(f => f && f.name) : []; } catch (e) { return []; } }
  function builtInFoods() { try { const g = M.DB && M.DB.generic; return Array.isArray(g) ? g.filter(f => f && f.name) : []; } catch (e) { return []; } }
  /* The person's own saved foods first (a full name match wins outright), then everything
     with a small bonus for saved foods; near-ties go to the food listed first. */
  const STATE_WORD = /^(raw|uncooked|dry|cooked|grilled|baked|roasted|boiled|steamed|fried|sauteed|sautéed|seared|broiled|poached|smoked|leftover|leftovers)$/i;
  M.food.matchLocal = function (words) {
    let qw = toks(words);
    const core = qw.filter(w => !STATE_WORD.test(w));
    if (core.length) qw = core;          /* "grilled chicken breast" matches "Chicken breast" */
    if (!qw.length) return null;
    const mine = myFoods();
    let bestMine = null, bestMineS = -Infinity;
    mine.forEach(f => { const tier = savedTier(qw, f); if (!tier) return; const s = tier * 100 + nameScore(qw, f) + Math.min(8, Math.log2(num(f.uses) + 1) * 2); if (s > bestMineS) { bestMineS = s; bestMine = f; } });
    if (bestMine) return bestMine;
    const scored = [];
    mine.forEach((f, i) => { const s = nameScore(qw, f); if (s >= 0) scored.push({ f, s: s + 8 + Math.min(8, Math.log2(num(f.uses) + 1) * 2), i }); });
    builtInFoods().forEach((f, i) => { const s = nameScore(qw, f); if (s >= 0) scored.push({ f, s: s - (f.brand ? 1 : 0), i: 100000 + i }); });
    if (!scored.length) return null;
    const top = Math.max.apply(null, scored.map(x => x.s));
    if (top < 8) return null;
    const near = scored.filter(x => x.s >= top - 3).sort((a, b) => a.i - b.i);
    return near[0].f;
  };
  function splitDescribe(text) {
    return String(text == null ? "" : text)
      .split(/\n|,|;|\s+(?:and|plus|with|w\/)\s+|\s*\+\s*|\s+&\s+/i)
      .map(s => s.trim()).filter(Boolean);
  }
  /* Meat, fish, rice and pasta can carry a cooked profile (food.cook, read through M.cook when
     m-core has it). What people describe is what was on the plate, so amounts are cooked
     unless they say raw / dry. The item then says which weight it is (state + cook). */
  const SAYS_RAW = /\b(raw|uncooked|dry)\b/i;
  const SAYS_COOKED = /\b(cooked|grilled|baked|roasted|boiled|steamed|fried|sauteed|sautéed|seared|broiled|poached|smoked|leftovers?)\b/i;
  function plateView(food, part) {
    let c = null;
    try { c = M.cook && typeof M.cook.of === "function" ? M.cook.of(food) : null; } catch (e) { c = null; }
    if (!c) return { food, extra: null };
    const cook = { y: num(c.y), word: c.word === "dry" ? "dry" : "raw" };
    if (SAYS_RAW.test(part) && !SAYS_COOKED.test(part)) return { food, extra: { state: "raw", cook } };
    let v = null;
    try { v = typeof M.cook.view === "function" ? M.cook.view(food, "cooked") : null; } catch (e) { v = null; }
    if (!v || v === food) return { food, extra: null };
    return { food: v, extra: { state: "cooked", cook } };
  }
  M.food.describeLocal = function (text) {
    const items = [], unmatched = [];
    splitDescribe(text).forEach(part => {
      const q = M.food.parseQuantity(part);
      const words = q.words;
      let food = words ? M.food.matchLocal(words) : null;
      /* "2 tacos" / "a scoop of whey": the unit word may be the food itself */
      if (!food && q.unit && !/^(g|oz|lb|ml|fl oz|cup|tbsp|tsp|small|medium|large|serving|piece)$/.test(q.unit)) { food = M.food.matchLocal(q.unit + " " + words); if (food) q.unit = null; }
      if (!food && !words && q.unit) { food = M.food.matchLocal(q.unit); if (food) q.unit = null; }
      if (!food && words) food = M.food.matchLocal(part);
      if (!food) { unmatched.push(part); return; }
      const pv = plateView(food, part);
      const sc = scaleToQuantity(pv.food, q);
      const per = M.foodMath ? M.foodMath.scale(sc.per || pv.food.per, 1) : (sc.per || pv.food.per);
      const servings = Math.max(0.05, r2(num(sc.servings, 1)));
      const it = { name: food.name, brand: food.brand || "", servings, servingLabel: sc.servingLabel, g: sc.g != null ? r1(sc.g) : null, per, foodId: food.id, source: food.source === "generic" ? "generic" : "custom", text: part };
      if (pv.extra) Object.assign(it, pv.extra);
      items.push(it);
    });
    return { items, unmatched };
  };

  M.food.describe = function (text, opt) {
    opt = isObj(opt) ? opt : {};
    return Promise.resolve().then(async () => {
      const s = String(text == null ? "" : text).trim();
      if (!s) return { items: [], unmatched: [], method: "local" };
      if (!M.ai.probed()) { try { await withTimeout(M.ai.probe(), 2000); } catch (e) {} }
      let aiNote = "";
      if (M.ai.ready() && opt.method !== "local") {
        try {
          const prompt = "Someone described what they ate: \"" + s.replace(/"/g, "'").slice(0, 2000) + "\"." + slotHint(opt.slot) +
            "\nList each food with the portion they said (or a realistic default if they gave none) and estimate its nutrition.\nReply with ONLY this JSON:\n" + ITEMS_SHAPE + "\n" + ITEMS_RULES;
          const out = itemsFromAI(await M.ai.json(prompt, { tier: opt.tier || "quick" }), "ai");
          if (out.items.length) return { items: out.items, unmatched: [], note: out.note, method: "ai" };
        } catch (e) {
          if (isE(e) && (e.code === "auth" || e.code === "forbidden" || e.code === "billing")) throw e;
          aiNote = "Claude didn't answer" + (isE(e) && e.message ? " (" + e.message.replace(/\.$/, "") + ")" : "") + ", so this matched your words to your foods and the built-in list.";
        }
      }
      const loc = M.food.describeLocal(s);
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
        "per is for ONE serving. Calories kcal; p c f fiber sugar grams; sodium_mg milligrams. Numbers only. If this is not a food, reply {\"name\":\"\"}.";
      const j = await M.ai.json(prompt, { tier: "quick" });
      if (!isObj(j) || !String(j.name || "").trim()) return null;
      const per = perFromAI(j.per);
      const serving = servingFromAI(j.serving, null);
      const alts = (Array.isArray(j.alts) ? j.alts : []).filter(a => isObj(a) && a.label && num(a.g) > 0).map(a => ({ label: String(a.label), g: r1(num(a.g)) })).slice(0, 4);
      if (serving.g && !alts.some(a => a.g === 100)) alts.push({ label: "100 g", g: 100 });
      const t = now();
      return { id: uid(), name: String(j.name).trim(), brand: String(j.brand || "").trim(), barcode: "", source: "ai", serving, per, per100g: serving.g ? scaleTo100(per, serving.g) : null, alts, createdAt: t, updatedAt: t, uses: 0, lastUsed: 0, pid: null };
    });
  };

  /* ======================================================================== */
  /* M.food.suggest — your meals, your usual combos, built-in ideas, Claude    */
  /* ======================================================================== */
  function remainingOf(opt) {
    const r = isObj(opt.remaining) ? opt.remaining : null;
    if (r) return { cal: num(r.cal), p: num(r.p), c: num(r.c), f: num(r.f) };
    try {
      const pid = opt.pid || (M.pid ? M.pid() : null);
      const t = M.person ? M.person(pid).targets : null;
      const eaten = M.log && M.log.totals ? M.log.totals(opt.date || (M.today ? M.today() : undefined), pid) : null;
      if (t) return { cal: num(t.cal) - num(eaten && eaten.cal), p: num(t.p) - num(eaten && eaten.p), c: num(t.c) - num(eaten && eaten.c), f: num(t.f) - num(eaten && eaten.f) };
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
  /* (c) built-in ideas from M.DB.suggest */
  M.food.suggestBuiltin = function (opt) {
    opt = isObj(opt) ? opt : {};
    let list = [];
    try { const s = M.DB && M.DB.suggest; list = Array.isArray(s) ? s : []; } catch (e) { list = []; }
    const remaining = remainingOf(opt);
    const n = num(opt.n, 6) || 6;
    const exclude = new Set(Array.isArray(opt.exclude) ? opt.exclude : []);
    const scored = list.filter(s => s && s.id && !exclude.has(s.id)).map(s => ({ s, score: M.food.scoreSuggestion(s, opt.slot, remaining, opt.prefs, opt.jitter) }));
    scored.sort((a, b) => b.score - a.score);
    const cap = Math.max(0, remaining.cal) + 150;
    const ok = scored.filter(x => (x.s.per || sumPer(x.s.items)).cal <= cap);
    const pool = ok.length >= n ? ok : scored;
    return pool.slice(0, n).map(x => Object.assign({}, x.s, { per: x.s.per || sumPer(x.s.items), source: "idea", score: r1(x.score), items: (x.s.items || []).map(it => Object.assign({ servings: 1 }, it)) }));
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
    return meals.filter(m => m && m.id && !exclude.has(m.id) && Array.isArray(m.items) && m.items.length && !(isObj(m.batch) && num(m.batch.cookedG) > 0) && fits(m.per, rem))
      .map(m => ({ m, score: M.food.scoreSuggestion({ per: m.per, slot: m.slot }, opt.slot, rem, null, 0) + Math.min(10, Math.log2(num(m.uses) + 1) * 3) + (m.slot === opt.slot ? 5 : 0) }))
      .sort((a, b) => b.score - a.score).slice(0, num(opt.n, 3) || 3)
      .map(({ m }) => {
        const made = num(m.servingsMade, 1) > 0 ? num(m.servingsMade, 1) : 1;
        const items = m.items.map(it => Object.assign(snap(it), { servings: r2(num(it.servings, 1) / made) }));
        return { id: m.id, mealId: m.id, name: m.name, desc: m.desc || "", slot: m.slot, items, per: Object.assign({}, m.per || sumPer(items)), tags: [], source: "mine", uses: num(m.uses) };
      });
  };
  /* (b) foods logged together in this slot on the same day, over the last 60 days (a saved
     meal counts as one item). → [{id, keys, count, last, items}] most frequent first. */
  M.food.combos = function (pid, slot, days) {
    pid = pid || (M.pid ? M.pid() : null);
    if (!pid || !M.MS || !isObj(M.MS.days) || !slot) return [];
    const today = M.today ? M.today() : "", from = M.addDays ? M.addDays(today, -(num(days, 60) - 1)) : "";
    const sets = [];
    Object.keys(M.MS.days).forEach(id => {
      const d = M.MS.days[id];
      if (!d || d.pid !== pid || !(d.date >= from) || !(d.date <= today) || !Array.isArray(d.entries)) return;
      const map = new Map(), pos = new Map();
      d.entries.forEach((e, i) => {
        if (!e || e.slot !== slot || !e.name) return;
        const k = e.mealId ? "m:" + e.mealId : e.foodId ? "f:" + e.foodId : "n:" + lc(e.name) + "|" + lc(e.brand);
        if (!map.has(k) || num(e.at) >= num(map.get(k).at)) { map.set(k, e); pos.set(k, i); }
      });
      if (map.size >= 2) sets.push({ keys: Array.from(map.keys()).sort(), map, pos, date: d.date });
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
  M.food.suggestOften = function (opt) {
    opt = isObj(opt) ? opt : {};
    const rem = remainingOf(opt), exclude = new Set(Array.isArray(opt.exclude) ? opt.exclude : []);
    return M.food.combos(opt.pid, opt.slot, 60)
      .map(c => Object.assign(c, { per: sumPer(c.items), sid: "often:" + c.id }))
      .filter(c => !exclude.has(c.sid) && fits(c.per, rem))
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
  const SUGGEST_PROMPT = (slot, rem, prefs, foods) =>
    "Suggest 3 " + (slot ? slot.toLowerCase() + " " : "") + "meals for someone in Denver who shops at King Soopers and Costco.\n" +
    "They have about " + r0(rem.cal) + " kcal, " + r0(rem.p) + " g protein, " + r0(rem.c) + " g carbs and " + r0(rem.f) + " g fat left today. " +
    "Each meal must be high in protein, use a good share of the protein that's left, and stay under the calories left." +
    (prefs && prefs.noCook ? " No cooking." : "") + (prefs && prefs.lowCarb ? " Keep carbs low." : "") + (prefs && prefs.quick ? " Under 10 minutes." : "") + "\n" +
    (foods.length ? "Build the meals mostly from foods they already eat (their pantry):\n" + foods.join("\n") + "\nYou may add simple King Soopers or Costco staples.\n" : "Use simple whole foods from King Soopers or Costco.\n") +
    "Skip cereal, oats, cheese, protein shakes, protein bars and restaurant food. Name and describe each meal in plain words a middle-schooler understands.\n" +
    "Reply with ONLY this JSON, no prose, no code fences:\n{\"suggestions\":[{\"name\": string, \"desc\": string (one plain sentence), \"store\": \"King Soopers\" or \"Costco\" or \"Either\", \"prepMin\": number, " +
    "\"items\":[{\"name\": string, \"servingLabel\": string like \"6 oz (170 g)\", \"g\": number or null, \"per\": {\"cal\": number, \"p\": number, \"c\": number, \"f\": number, \"fiber\": number, \"sugar\": number, \"sodium_mg\": number}}]}]}\n" +
    "per is for that item's whole portion. Calories kcal; p c f fiber sugar grams; sodium_mg milligrams. Numbers only.";
  /* (d) Claude ideas → [] on any problem (never throws) */
  M.food.suggestClaude = function (opt) {
    opt = isObj(opt) ? opt : {};
    return Promise.resolve().then(async () => {
      if (!M.ai.probed()) { try { await withTimeout(M.ai.probe(), 1500); } catch (e) {} }
      if (!M.ai.ready()) return [];
      const j = await M.ai.json(SUGGEST_PROMPT(opt.slot, remainingOf(opt), opt.prefs, pantry()), { tier: "quick", cache: false });
      const arr = isObj(j) && Array.isArray(j.suggestions) ? j.suggestions : Array.isArray(j) ? j : [];
      return arr.filter(isObj).map(sg => {
        const items = (Array.isArray(sg.items) ? sg.items : []).filter(isObj).map(it => itemFromAI(it, "ai"));
        if (!items.length || !String(sg.name || "").trim()) return null;
        return { id: "ai_" + uid(), name: String(sg.name).trim(), desc: String(sg.desc || "").trim(), slot: opt.slot || "Any", store: /costco/i.test(sg.store) ? "Costco" : /soopers|kroger/i.test(sg.store) ? "King Soopers" : "Either", prepMin: r0(num(sg.prepMin)), items, per: sumPer(items), tags: ["high-protein"], source: "claude" };
      }).filter(Boolean).slice(0, 3);
    });
  };
  /* suggest({pid, slot, remaining, prefs, exclude, ai?:false}) → [Suggestion] in this order:
     "mine" (saved meals that fit) · "often" (usual combos in this slot) · "idea" (built-in) · "claude".
     Never rejects. When Claude fails the list has .aiError (plain words). */
  M.food.suggest = function (opt) {
    opt = isObj(opt) ? opt : {};
    const safe = f => { try { return f() || []; } catch (e) { return []; } };
    return Promise.resolve().then(async () => {
      const mine = safe(() => M.food.suggestMine(opt));
      const often = safe(() => M.food.suggestOften(opt));
      const n = Math.max(3, (num(opt.n, 6) || 6) - mine.length - often.length);
      const ideas = safe(() => M.food.suggestBuiltin(Object.assign({}, opt, { n })));
      let claude = [], aiError = "";
      if (opt.ai !== false) {
        try { claude = await M.food.suggestClaude(opt); }
        catch (e) { claude = []; aiError = isE(e) ? e.message : AI_MSG.network; }
      }
      const out = mine.concat(often, ideas, claude);
      if (aiError) out.aiError = aiError;
      return out;
    }).catch(() => safe(() => M.food.suggestBuiltin(opt)));
  };

  /* Exposed for tests / other modules. */
  M.food._ = { E, withTimeout, fetchJSON, parseJSONText, parseServingSize, scaleToQuantity, sumPer, perFromAI, itemFromAI, fixNum, valuesIn, bandRect, makeAcceptor, cameraErr, labelFromAI, labelWarning, tidyCase, packageGrams, SCAN, TESS, CAM, AI_TIMEOUT };
})(window.M);
