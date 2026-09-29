window.M = window.M || {};
/* ============================================================================
   Chalk · Macros — food + AI (M.ai, M.img, M.food)
   Open Food Facts (barcode + packaged search), barcode scanner (html5-qrcode,
   lazy), Nutrition Facts label reader (Claude vision or tesseract.js OCR +
   a noise-tolerant parser), Claude provider (claude.use("sample") inside
   claude.ai, or an Anthropic API key kept on the device), photo + text
   estimation, and the meal-suggestion engine.
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
  const lc = s => String(s == null ? "" : s).toLowerCase();
  const NUT = ["cal", "p", "c", "f", "fiber", "sugar", "sodium"];
  const uid = () => { try { if (M.uid) return M.uid(); } catch (e) {} return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); };
  const win = () => (typeof window !== "undefined" ? window : {});
  const nav = () => { try { return typeof navigator !== "undefined" ? navigator : {}; } catch (e) { return {}; } };

  /* One error shape everywhere: a plain object, never an Error subclass. */
  function E(code, message, extra) {
    const o = { code: code || "error", message: message || "Something went wrong." };
    if (extra !== undefined) o.detail = extra;
    return o;
  }
  const isE = e => isObj(e) && typeof e.code === "string";
  const wrapErr = (e, code, message) => (isE(e) ? e : E(code, message, e && e.message ? e.message : String(e)));

  function withTimeout(promise, ms, code, message) {
    let t;
    const timer = new Promise((_, rej) => { t = setTimeout(() => rej(E(code || "timeout", message || "That took too long. Try again.")), ms); });
    return Promise.race([Promise.resolve(promise), timer]).then(v => { clearTimeout(t); return v; }, e => { clearTimeout(t); throw e; });
  }

  /* fetch + JSON with an AbortController timeout. Rejects {code:"network"|"http"}. */
  async function fetchJSON(url, opts, ms, what) {
    what = what || "the server";
    if (typeof fetch !== "function") throw E("network", "No network access here.");
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const t = setTimeout(() => { try { ctl && ctl.abort(); } catch (e) {} }, ms || 8000);
    let res;
    try {
      res = await fetch(url, Object.assign({}, opts || {}, ctl ? { signal: ctl.signal } : {}));
    } catch (e) {
      clearTimeout(t);
      const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e.message)));
      throw E("network", aborted ? "Reaching " + what + " took too long. Check your connection and try again." : "Couldn't reach " + what + ". Check your connection.");
    }
    clearTimeout(t);
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    return { ok: res.ok, status: res.status, body };
  }

  /* Lazy <script> loader (one load per URL, shared promise). */
  const scriptLoads = {};
  function loadScript(url, ready, ms, code, message) {
    try { if (ready()) return Promise.resolve(true); } catch (e) {}
    if (scriptLoads[url]) return scriptLoads[url];
    scriptLoads[url] = new Promise((resolve, reject) => {
      if (typeof document === "undefined") { delete scriptLoads[url]; return reject(E(code, message)); }
      const s = document.createElement("script");
      s.src = url; s.async = true; s.crossOrigin = "anonymous";
      let done = false;
      const fail = () => { if (done) return; done = true; delete scriptLoads[url]; try { s.remove(); } catch (e) {} reject(E(code, message)); };
      const t = setTimeout(fail, ms || 15000);
      s.onload = () => { clearTimeout(t); done = true; try { if (ready()) resolve(true); else fail(); } catch (e) { fail(); } };
      s.onerror = () => { clearTimeout(t); fail(); };
      document.head.appendChild(s);
    });
    return scriptLoads[url];
  }

  /* Tolerant JSON extraction: whole text, then fenced block, then first {…} / […]. */
  function parseJSONText(text) {
    let s = String(text == null ? "" : text).trim();
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
    if (fence) s = fence[1].trim();
    try { return JSON.parse(s); } catch (e) {}
    const a = s.search(/[{[]/);
    if (a >= 0) {
      const b = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
      if (b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
    }
    throw E("bad_json", "Claude sent back something that wasn't JSON. Try again.");
  }

  /* AI per-block → Food per-block (sodium_mg → sodium). Missing → 0. */
  function perFromAI(p) {
    p = isObj(p) ? p : {};
    const sod = p.sodium_mg !== undefined ? p.sodium_mg : p.sodium;
    return { cal: r0(num(p.cal)), p: r1(num(p.p)), c: r1(num(p.c)), f: r1(num(p.f)), fiber: r1(num(p.fiber)), sugar: r1(num(p.sugar)), sodium: r0(num(sod)) };
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
  const sumPer = list => {
    const o = {}; NUT.forEach(k => { o[k] = 0; });
    (list || []).forEach(it => { const s = num(it && it.servings, 1) || 1; NUT.forEach(k => { o[k] += num(it && it.per && it.per[k]) * s; }); });
    NUT.forEach(k => { o[k] = k === "cal" || k === "sodium" ? r0(o[k]) : r1(o[k]); });
    return o;
  };

  /* ======================================================================== */
  /* M.ai — Claude via claude.use("sample") (inside claude.ai) or an API key   */
  /* ======================================================================== */
  const KEY_LS = "chalk.ai.key";
  const DEFAULT_MODEL = "claude-sonnet-5-5";
  const FALLBACK_MODEL = "claude-haiku-4-5-20251001";
  let sampleFn = null, sampleProbed = false, sampleProbe = null;

  function probeSample() {
    if (sampleProbe) return sampleProbe;
    const w = win();
    if (!(w.claude && typeof w.claude.use === "function")) { sampleProbed = true; return (sampleProbe = Promise.resolve(null)); }
    sampleProbe = Promise.resolve().then(() => w.claude.use("sample")).then(s => { sampleFn = typeof s === "function" ? s : null; sampleProbed = true; return sampleFn; }, () => { sampleFn = null; sampleProbed = true; return null; });
    return sampleProbe;
  }
  function lsGet(k) { try { return typeof localStorage !== "undefined" ? localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (typeof localStorage !== "undefined") localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { if (typeof localStorage !== "undefined") localStorage.removeItem(k); } catch (e) {} }

  const AI_MSG = {
    no_ai: "Claude isn't set up. Open Chalk inside claude.ai, or add your Anthropic key in You → AI.",
    auth: "Your Anthropic key was rejected. Check it in You → AI.",
    rate_limited: "Claude is busy or your key hit its limit. Wait a minute and try again.",
    network: "Couldn't reach Claude. Check your connection and try again.",
    bad_json: "Claude sent back something that wasn't JSON. Try again."
  };
  /* sample-capability error → our five codes */
  function mapSampleErr(e) {
    if (!isObj(e)) return E("network", AI_MSG.network);
    const c = String(e.code || "");
    if (/not_granted|sampling_disabled|not_declared|capability_disabled|capability_removed|images_unavailable|tools_unavailable/.test(c)) return E("no_ai", c === "images_unavailable" ? "Photos can't be sent to Claude here. Add your Anthropic key in You → AI." : "Claude isn't allowed for this page. Allow it when asked, or add your Anthropic key in You → AI.");
    if (c === "rate_limited") return E("rate_limited", AI_MSG.rate_limited);
    if (c === "invalid_json" || c === "empty_completion" || c === "refused") return E("bad_json", c === "refused" ? "Claude couldn't answer that. Try different wording or another photo." : AI_MSG.bad_json);
    if (c === "session_expired") return E("auth", "Your claude.ai session expired. Sign in again.");
    if (c === "image_rejected") return E("bad_json", "That image couldn't be used. Try a JPEG or PNG under 20 MB.");
    if (c === "prompt_too_large") return E("bad_json", "That's too much text for one request. Try less at a time.");
    if (c === "cancelled") return E("network", "Cancelled.");
    return E("network", AI_MSG.network);
  }

  async function sampleJSON(s, prompt, opt) {
    let images = Array.isArray(opt.images) ? opt.images.filter(Boolean) : [];
    if (images.length) {
      let lim = null;
      try { lim = await withTimeout(s.limits(), 5000, "network", AI_MSG.network); } catch (e) { lim = null; }
      if (!(lim && lim.images)) throw E("no_ai", "Photos can't be sent to Claude here. Add your Anthropic key in You → AI.");
      if (lim.images.maxCount > 0) images = images.slice(0, lim.images.maxCount);
    }
    const o = { modelTier: opt.tier === "quick" ? "quick" : "default", cache: false };
    if (images.length) o.images = images;
    if (opt.signal) o.signal = opt.signal;
    try {
      const v = await s.json(prompt, o);
      if (v === undefined || v === null) throw E("bad_json", AI_MSG.bad_json);
      return v;
    } catch (e) { throw mapSampleErr(e); }
  }

  async function keyJSON(key, prompt, opt) {
    const blocks = [];
    const images = Array.isArray(opt.images) ? opt.images.filter(Boolean) : [];
    for (const img of images) {
      let blob = img, type = "image/jpeg";
      try { blob = await M.img.downscale(img, 1280, 0.85); } catch (e) { blob = img; type = (img && img.type) || "image/jpeg"; }
      const data = await M.img.toBase64(blob);
      blocks.push({ type: "image", source: { type: "base64", media_type: type, data } });
    }
    blocks.push({ type: "text", text: String(prompt) });
    let model = opt.model || M.ai.model();
    let retried = false;
    for (;;) {
      const body = JSON.stringify({ model, max_tokens: 1500, messages: [{ role: "user", content: blocks }] });
      const r = await fetchJSON("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body
      }, 45000, "Claude");
      const err = r.body && r.body.error ? r.body.error : null;
      const etype = err ? String(err.type || "") : "";
      if (r.ok) {
        const content = r.body && Array.isArray(r.body.content) ? r.body.content : [];
        const tb = content.find(b => b && b.type === "text" && typeof b.text === "string");
        if (!tb) throw E("bad_json", AI_MSG.bad_json);
        return parseJSONText(tb.text);
      }
      if ((r.status === 404 || etype === "not_found_error") && !retried && model !== FALLBACK_MODEL) { retried = true; model = FALLBACK_MODEL; continue; }
      if (r.status === 401 || r.status === 403 || etype === "authentication_error" || etype === "permission_error") throw E("auth", AI_MSG.auth);
      if (r.status === 429 || etype === "rate_limit_error") throw E("rate_limited", AI_MSG.rate_limited);
      if (r.status === 404 || etype === "not_found_error") throw E("network", "The model \"" + model + "\" isn't available on this key. Pick another model in You → AI.");
      if (r.status === 400 || etype === "invalid_request_error") throw E("bad_json", "Claude rejected the request" + (err && err.message ? ": " + err.message : ".") );
      if (r.status === 413) throw E("bad_json", "That photo is too big to send. Try a smaller one.");
      throw E("network", r.status === 529 || r.status === 503 ? "Claude is overloaded right now. Try again in a minute." : "Claude returned an error (" + r.status + "). Try again.");
    }
  }

  M.ai = {
    mode() {
      if (sampleFn) return "sample";
      const k = lsGet(KEY_LS);
      return k && k.trim() ? "key" : null;
    },
    ready() { return M.ai.mode() !== null; },
    /* Resolves once the sample probe has settled (so the UI can wait for a real answer). */
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
    /* Can this AI path look at photos? (key: yes; sample: only if limits().images) */
    async images() {
      const m = M.ai.mode();
      if (m === "key") return true;
      if (m !== "sample") return false;
      try { const lim = await withTimeout(sampleFn.limits(), 5000); return !!(lim && lim.images); } catch (e) { return false; }
    },
    /* json(prompt, {images?:Blob[], tier?:"quick"|"default", signal?, timeout?:ms}) → parsed JSON.
       Never throws synchronously. The key path always stops after 45 s; pass `timeout` to also
       cap the sample path (the call is aborted so the viewer stops paying for it). */
    json(prompt, opt) {
      opt = isObj(opt) ? Object.assign({}, opt) : {};
      let ctl = null, timer = null;
      const run = Promise.resolve().then(async () => {
        if (!prompt || !String(prompt).trim()) throw E("bad_json", "Nothing to ask.");
        if (!sampleProbed) { try { await withTimeout(probeSample(), 2000); } catch (e) {} }
        const mode = M.ai.mode();
        if (mode === "sample") {
          if (num(opt.timeout) > 0 && !opt.signal && typeof AbortController === "function") { ctl = new AbortController(); opt.signal = ctl.signal; }
          return sampleJSON(sampleFn, String(prompt), opt);
        }
        if (mode === "key") return keyJSON(M.ai.getKey(), String(prompt), opt);
        throw E("no_ai", AI_MSG.no_ai);
      });
      const guarded = num(opt.timeout) > 0
        ? Promise.race([run, new Promise((_, rej) => { timer = setTimeout(() => { try { ctl && ctl.abort(); } catch (e) {} rej(E("network", "Claude took too long. Try again.")); }, num(opt.timeout)); })])
        : run;
      return guarded.then(v => { clearTimeout(timer); return v; }, e => { clearTimeout(timer); throw wrapErr(e, "network", AI_MSG.network); });
    },
    /* Cheap round-trip used by the You tab's "Test" button. */
    test() { return M.ai.json('Reply with exactly this JSON and nothing else: {"ok":true}', { tier: "quick", timeout: 30000 }).then(v => !!(v && v.ok === true)); },
    parseJSONText,
    messages: AI_MSG
  };
  try { probeSample(); } catch (e) {}

  /* ======================================================================== */
  /* M.img — canvas downscale + base64                                         */
  /* ======================================================================== */
  function decodeImage(file) {
    /* → {src, w, h, close()} where src is drawable by canvas. */
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
    if (typeof w.createImageBitmap === "function") {
      return viaBitmap({ imageOrientation: "from-image" }).catch(() => viaBitmap(undefined)).catch(() => viaImg());
    }
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
  M.img = {
    /* downscale(file, maxPx=1280, quality=0.85) → JPEG Blob, EXIF orientation applied. */
    downscale(file, maxPx, quality) {
      maxPx = num(maxPx, 1280) || 1280; quality = num(quality, 0.85) || 0.85;
      return Promise.resolve().then(async () => {
        if (!file) throw E("image", "No image given.");
        if (typeof document === "undefined") throw E("image", "No canvas here.");
        const im = await withTimeout(decodeImage(file), 20000, "image", "Reading that image took too long.");
        try {
          const scale = Math.min(1, maxPx / Math.max(im.w, im.h, 1));
          const cw = Math.max(1, Math.round(im.w * scale)), ch = Math.max(1, Math.round(im.h * scale));
          const c = document.createElement("canvas"); c.width = cw; c.height = ch;
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(im.src, 0, 0, cw, ch);
          return await canvasBlob(c, "image/jpeg", quality);
        } finally { im.close(); }
      });
    },
    /* Grayscale + contrast-stretched canvas for OCR. → {canvas, blob} */
    prepOCR(file, maxPx) {
      maxPx = num(maxPx, 1600) || 1600;
      return Promise.resolve().then(async () => {
        if (typeof document === "undefined") throw E("image", "No canvas here.");
        const im = await withTimeout(decodeImage(file), 20000, "image", "Reading that image took too long.");
        try {
          const scale = Math.min(1, maxPx / Math.max(im.w, im.h, 1));
          const cw = Math.max(1, Math.round(im.w * scale)), ch = Math.max(1, Math.round(im.h * scale));
          const c = document.createElement("canvas"); c.width = cw; c.height = ch;
          const ctx = c.getContext("2d", { willReadFrequently: true });
          ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(im.src, 0, 0, cw, ch);
          const id = ctx.getImageData(0, 0, cw, ch), d = id.data;
          const hist = new Uint32Array(256);
          for (let i = 0; i < d.length; i += 4) { const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0; d[i] = g; hist[g]++; }
          /* stretch between the 1st and 99th percentile */
          const total = cw * ch; let lo = 0, hi = 255, acc = 0;
          for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * 0.01) { lo = i; break; } }
          acc = 0; for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= total * 0.01) { hi = i; break; } }
          const span = Math.max(1, hi - lo);
          for (let i = 0; i < d.length; i += 4) { let g = (d[i] - lo) * 255 / span; g = g < 0 ? 0 : g > 255 ? 255 : g; d[i] = d[i + 1] = d[i + 2] = g; d[i + 3] = 255; }
          ctx.putImageData(id, 0, 0);
          const blob = await canvasBlob(c, "image/png");
          return { canvas: c, blob, width: cw, height: ch };
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
  /* M.food — Open Food Facts                                                  */
  /* ======================================================================== */
  M.food = M.food || {};
  const OFF_FIELDS = "code,product_name,product_name_en,generic_name,generic_name_en,abbreviated_product_name,brands,serving_size,serving_quantity,serving_quantity_unit,quantity,nutrition_data_per,nutriments";
  const normCode = c => String(c == null ? "" : c).replace(/\D/g, "");
  /* OFF's serving_quantity is usually grams (or ml for liquids, which we treat as grams);
     a few products store it in oz / lb / fl oz with serving_quantity_unit set. → grams | null */
  function servingGrams(sq, unit) {
    const q = num(sq, 0);
    if (!(q > 0)) return null;
    const u = lc(unit).replace(/\s+/g, "").replace(/\.$/, "");
    if (/^(oz|ounces?)$/.test(u)) return q * 28.35;
    if (/^(floz|fluidounces?)$/.test(u)) return q * 29.57;
    if (/^(lb|lbs|pounds?)$/.test(u)) return q * 453.6;
    if (/^(kg|kilograms?)$/.test(u)) return q * 1000;
    if (/^(l|liters?|litres?)$/.test(u)) return q * 1000;
    return q; /* g, ml, "", anything else */
  }

  /* "2/3 cup (55g)" / "30 g (1 oz)" / "1 cup (240mL)" / "55g" → {qty, unit, g}
     servingG (grams, already converted) wins over the grams printed in the string. */
  function parseServingSize(str, servingG) {
    const s = String(str || "").trim();
    const parts = [];
    const paren = /\(([^)]*)\)/g; let m, outside = s;
    while ((m = paren.exec(s))) parts.push(m[1].trim());
    outside = s.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    if (outside) parts.unshift(outside);
    const partOf = p => {
      const mm = /^(?:about|approx\.?|approximately)?\s*(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?|[½¼¾⅓⅔])?\s*(.*)$/i.exec(p);
      if (!mm) return null;
      let qty = 1;
      const q = mm[1];
      if (q) {
        const uni = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 0.333, "⅔": 0.667 };
        if (uni[q]) qty = uni[q];
        else if (/\s/.test(q)) { const [a, fr] = q.split(/\s+/); const [n, dn] = fr.split("/"); qty = num(a) + num(n) / (num(dn) || 1); }
        else if (q.includes("/")) { const [n, dn] = q.split("/"); qty = num(n) / (num(dn) || 1); }
        else qty = num(q, 1);
      }
      let unit = (mm[2] || "").replace(/[.,;:]+$/, "").trim();
      /* "28g/1oz" / "30 g (1.06 oz)": keep the first measure only */
      const slash = /^(g|gr|grams?|ml|mL|oz)\s*\/\s*/i.exec(unit);
      if (slash) unit = slash[1];
      const metric = /^(g|gr|grams?|ml|mL|millilit(?:er|re)s?)$/i.test(unit);
      return { qty: qty > 0 ? +qty.toFixed(3) : 1, unit, metric, hasQty: !!q };
    };
    const parsed = parts.map(partOf).filter(Boolean);
    const metricPart = parsed.find(p => p.metric && p.hasQty);
    const house = parsed.find(p => !p.metric && p.unit);
    let g = num(servingG, null);
    if (!(isNum(g) && g > 0)) g = metricPart ? metricPart.qty : null;
    if (house) return { qty: house.qty, unit: house.unit, g: isNum(g) && g > 0 ? r1(g) : null };
    if (metricPart) return { qty: metricPart.qty, unit: /ml|milli/i.test(metricPart.unit) ? "ml" : "g", g: isNum(g) && g > 0 ? r1(g) : r1(metricPart.qty) };
    if (isNum(g) && g > 0) return { qty: 1, unit: "serving", g: r1(g) };
    return { qty: 1, unit: "serving", g: null };
  }

  /* Pure: OFF product JSON → Food | null
     Returns null only when there is no usable name or no energy field at all (a product with
     0 kcal — water, diet soda, black coffee — is kept: energy is PRESENT, it's just zero). */
  M.food.fromOFF = function (product) {
    if (!isObj(product)) return null;
    const N = isObj(product.nutriments) ? product.nutriments : {};
    const get = k => { const v = N[k]; return v === undefined || v === null || v === "" ? null : num(v, null); };
    const name = ["product_name", "product_name_en", "generic_name", "generic_name_en", "abbreviated_product_name"]
      .map(k => String(product[k] || "").trim()).find(Boolean) || "";
    if (!name) return null;
    let kcal100 = get("energy-kcal_100g");
    if (kcal100 === null) { const kj = get("energy_100g"); if (kj !== null) kcal100 = kj / 4.184; }
    if (kcal100 === null) { const kc = get("energy-kcal"); if (kc !== null) kcal100 = kc; }
    let kcalServ = get("energy-kcal_serving");
    if (kcalServ === null) { const kj = get("energy_serving"); if (kj !== null) kcalServ = kj / 4.184; }
    if (kcal100 === null && kcalServ === null) return null;
    let sod100 = get("sodium_100g"); let sodServ = get("sodium_serving");
    if (sod100 !== null) sod100 = sod100 * 1000; else { const salt = get("salt_100g"); if (salt !== null) sod100 = salt / 2.5 * 1000; }
    if (sodServ !== null) sodServ = sodServ * 1000; else { const salt = get("salt_serving"); if (salt !== null) sodServ = salt / 2.5 * 1000; }
    const per100g = kcal100 === null ? null : {
      cal: r0(kcal100), p: r1(num(get("proteins_100g"))), c: r1(num(get("carbohydrates_100g"))), f: r1(num(get("fat_100g"))),
      fiber: r1(num(get("fiber_100g"))), sugar: r1(num(get("sugars_100g"))), sodium: r0(num(sod100))
    };
    /* grams per serving: serving_quantity (+unit) first, else the grams printed in serving_size */
    const sqG = servingGrams(product.serving_quantity, product.serving_quantity_unit);
    const serving = parseServingSize(product.serving_size, sqG);
    const hasServ = kcalServ !== null || ["proteins", "carbohydrates", "fat"].some(k => get(k + "_serving") !== null);
    let per;
    if (sqG > 0 || (hasServ && serving.g)) {
      const sg = sqG > 0 ? sqG : serving.g;
      const sv = { cal: kcalServ, p: get("proteins_serving"), c: get("carbohydrates_serving"), f: get("fat_serving"), fiber: get("fiber_serving"), sugar: get("sugars_serving"), sodium: sodServ };
      per = {};
      NUT.forEach(k => {
        let v = sv[k];
        if (v === null && per100g) v = per100g[k] * sg / 100;
        per[k] = v === null ? 0 : (k === "cal" || k === "sodium" ? r0(v) : r1(v));
      });
      if (!serving.g) serving.g = r1(sg);
    } else if (serving.g && per100g) {
      per = M.foodMath ? M.foodMath.fromPer100(per100g, serving.g) : null;
      if (!per) { per = {}; NUT.forEach(k => { per[k] = per100g[k] * serving.g / 100; }); }
      per.cal = r0(per.cal); per.sodium = r0(per.sodium);
    } else if (per100g) {
      per = Object.assign({}, per100g);
      serving.qty = 100; serving.unit = "g"; serving.g = 100;
    } else {
      /* only per-serving data and no serving size: keep the serving values as "1 serving" */
      per = { cal: r0(num(kcalServ)), p: r1(num(get("proteins_serving"))), c: r1(num(get("carbohydrates_serving"))), f: r1(num(get("fat_serving"))), fiber: r1(num(get("fiber_serving"))), sugar: r1(num(get("sugars_serving"))), sodium: r0(num(sodServ)) };
    }
    const brand = String(product.brands || "").split(",")[0].trim();
    const code = normCode(product.code || product._id || product.id);
    const alts = [];
    if (per100g) { alts.push({ label: "100 g", g: 100 }); alts.push({ label: "1 oz", g: 28.35 }); }
    const now = Date.now();
    return {
      id: code ? "off_" + code : uid(), name, brand, barcode: code, source: "off",
      serving, per, per100g, alts, quantity: String(product.quantity || "").trim(),
      createdAt: now, updatedAt: now, uses: 0, lastUsed: 0, pid: null
    };
  };

  M.food.barcode = function (code) {
    return Promise.resolve().then(async () => {
      const c = normCode(code);
      if (!c || c.length < 6) throw E("barcode", "That doesn't look like a barcode. Type the numbers under the bars.");
      try { const local = M.foods && M.foods.findByBarcode ? M.foods.findByBarcode(c) : null; if (local) return local; } catch (e) {}
      const tries = [c];
      if (c.length === 12) tries.push("0" + c);
      else if (c.length === 13 && c[0] === "0") tries.push(c.slice(1));
      else if (c.length === 8) tries.push("00000" + c);
      let lastNet = null;
      for (const t of tries) {
        let r;
        try {
          r = await fetchJSON("https://world.openfoodfacts.org/api/v2/product/" + encodeURIComponent(t) + ".json?fields=" + OFF_FIELDS, { method: "GET", headers: { accept: "application/json" } }, 8000, "Open Food Facts");
        } catch (e) { lastNet = e; continue; }
        if (r.status === 404 || !r.body) continue;
        const p = r.body.product;
        if (r.body.status === 0 || !isObj(p)) continue;
        const f = M.food.fromOFF(p);
        if (f) { if (!f.barcode) f.barcode = c; return f; }
      }
      if (lastNet) throw lastNet;
      return null;
    });
  };

  M.food.searchOFF = function (q) {
    return Promise.resolve().then(async () => {
      const s = String(q == null ? "" : q).trim();
      if (s.length < 2) return [];
      const url = "https://world.openfoodfacts.org/cgi/search.pl?search_terms=" + encodeURIComponent(s) +
        "&search_simple=1&action=process&json=1&page_size=15&fields=" + OFF_FIELDS +
        "&tagtype_0=countries&tag_contains_0=contains&tag_0=united-states";
      const r = await fetchJSON(url, { method: "GET", headers: { accept: "application/json" } }, 8000, "Open Food Facts");
      if (!r.ok || !r.body) throw E("network", "Open Food Facts didn't answer. Try again.");
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
  /* M.food.scanner — html5-qrcode, lazy                                        */
  /* ======================================================================== */
  const QR_URL = "https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js";
  const qrReady = () => typeof win().Html5Qrcode === "function";
  const loadQR = () => loadScript(QR_URL, qrReady, 15000, "scanner_load", "The barcode scanner couldn't load. Check your connection, or type the barcode numbers.");
  function qrFormats() {
    const F = win().Html5QrcodeSupportedFormats || {};
    return ["EAN_13", "EAN_8", "UPC_A", "UPC_E", "CODE_128"].map(k => F[k]).filter(v => v !== undefined);
  }
  const CAMERA_MSG = "Camera blocked. Allow the camera in Settings, or take a photo of the barcode.";
  function cameraErr(e) {
    const s = lc(e && (e.name || e.message || e));
    if (/notallowed|permission|denied|notreadable|securityerror|not allowed/.test(s)) return E("camera", CAMERA_MSG);
    if (/notfound|no camera|devices|overconstrained/.test(s)) return E("camera", "No camera found. Take a photo of the barcode or type the numbers.");
    return E("camera", CAMERA_MSG);
  }
  let scanInst = null, scanEl = null, scanLast = { code: "", at: 0 }, scanStarting = null;

  M.food.scanner = {
    running() { return !!scanInst; },
    /* start(containerEl, onCode) → resolves once the camera is live. */
    start(containerEl, onCode) {
      return Promise.resolve().then(async () => {
        if (!containerEl || typeof document === "undefined") throw E("scanner", "Nowhere to show the camera.");
        if (scanStarting) { try { await scanStarting; } catch (e) {} }
        await M.food.scanner.stop();
        await loadQR();
        const H = win().Html5Qrcode;
        if (!containerEl.id) containerEl.id = "m-scan-" + uid();
        scanEl = containerEl;
        const inst = new H(containerEl.id, { formatsToSupport: qrFormats(), verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
        scanInst = inst;
        scanLast = { code: "", at: 0 };
        const hit = text => {
          const code = normCode(text);
          if (!code) return;
          const now = Date.now();
          if (code === scanLast.code && now - scanLast.at < 3000) return;
          scanLast = { code, at: now };
          try { const n = nav(); if (typeof n.vibrate === "function") n.vibrate(60); } catch (e) {}
          try { if (typeof onCode === "function") onCode(code); } catch (e) {}
        };
        const cfg = { fps: 10, qrbox: { width: 260, height: 140 }, aspectRatio: 1.7778, experimentalFeatures: { useBarCodeDetectorIfSupported: true }, formatsToSupport: qrFormats() };
        scanStarting = withTimeout(inst.start({ facingMode: "environment" }, cfg, hit, () => {}), 20000, "camera", "The camera took too long to start. Try again, or take a photo of the barcode.");
        try { await scanStarting; }
        catch (e) {
          scanStarting = null;
          scanInst = null; scanEl = null;
          try { await inst.clear(); } catch (x) {}
          try { containerEl.innerHTML = ""; } catch (x) {}
          throw isE(e) && e.code === "camera" && e.message !== CAMERA_MSG ? e : cameraErr(e);
        }
        scanStarting = null;
        return true;
      });
    },
    /* Safe to call twice; always clears the container. */
    stop() {
      const inst = scanInst, el = scanEl;
      scanInst = null; scanEl = null;
      return Promise.resolve().then(async () => {
        if (inst) {
          try { if (typeof inst.getState === "function" ? inst.getState() === 2 || inst.getState() === 3 : true) await withTimeout(inst.stop(), 4000); } catch (e) {}
          try { inst.clear(); } catch (e) {}
        }
        if (el) { try { el.innerHTML = ""; } catch (e) {} }
        return true;
      });
    },
    /* fromImage(file) → code string | null */
    fromImage(file) {
      return Promise.resolve().then(async () => {
        if (!file) return null;
        if (typeof document === "undefined") throw E("scanner", "No canvas here.");
        await loadQR();
        const H = win().Html5Qrcode;
        let host = document.getElementById("m-scan-file");
        if (!host) { host = document.createElement("div"); host.id = "m-scan-file"; host.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden"; document.body.appendChild(host); }
        const inst = new H("m-scan-file", { formatsToSupport: qrFormats(), verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
        try {
          let f = file;
          try { const b = await M.img.downscale(file, 1600, 0.92); f = new File([b], "barcode.jpg", { type: "image/jpeg" }); } catch (e) { f = file; }
          const text = await withTimeout(inst.scanFileV2 ? inst.scanFileV2(f, false).then(r => (r && r.decodedText) || "") : inst.scanFile(f, false), 15000, "scanner", "Reading that photo took too long.");
          const code = normCode(text);
          return code || null;
        } catch (e) {
          if (isE(e)) throw e;
          return null; /* html5-qrcode rejects when it finds nothing */
        } finally { try { inst.clear(); } catch (e) {} }
      });
    }
  };

  /* ======================================================================== */
  /* M.food.label — Nutrition Facts parser (pure) + reader (AI or OCR)         */
  /* ======================================================================== */
  /* Fix common OCR digit confusions inside a numeric token. */
  function fixNum(tok) {
    let s = String(tok || "");
    s = s.replace(/[Oo]/g, "0").replace(/[lI|]/g, "1").replace(/[Ss]/g, "5").replace(/[Bb]/g, "8").replace(/,/g, ".").replace(/[^\d.\/]/g, "");
    if (s.includes("/")) { const [a, b] = s.split("/"); const d = num(b); return d ? num(a) / d : num(a, NaN); }
    const v = parseFloat(s);
    return isNum(v) ? v : NaN;
  }
  /* A numeric-ish token as OCR might write it: digits with O/l/I/S/B confusions, optional decimal. */
  const NUMTOK = "((?:\\d|[OolI|])+(?:[.,](?:\\d|[OolI|])+)?)";
  const UNIT = "\\s*(mg|mcg|µg|g|9|q|kcal|cal)?";
  /* Field spec: label regex → key. Order matters (Total Sugars before Sugars etc.). */
  const FIELDS = [
    { key: "cal", re: /\b(?:calories|cal(?:orie)?s?|kcal)\b(?!\s*from)/i },
    { key: "f", re: /\btotal\s*fat\b|\bfat,?\s*total\b/i, unit: "g" },
    { key: "sodium", re: /\bsodium\b/i, unit: "mg" },
    { key: "c", re: /\btotal\s*carb(?:ohydrate|ohydrates|s|\.)?\b|\bcarbohydrates?,?\s*total\b|\btotal\s*carb\b/i, unit: "g" },
    { key: "fiber", re: /\b(?:dietary\s*)?fib(?:er|re)\b/i, unit: "g" },
    { key: "sugar", re: /\b(?:total\s*)?sugars?\b/i, unit: "g" },
    { key: "p", re: /\bprotein\b/i, unit: "g" }
  ];
  const IGNORE_LINE = /\b(added\s*sugars?|includes\b|saturated|trans\s*fat|cholesterol|potassium|calcium|iron\b|vitamin|daily\s*value|%\s*dv|from\s*fat|per\s*container|servings?\s*per)/i;

  function findValue(line, unitHint) {
    /* Return the first plausible number after the label; handle "Protein 3g", "Protein 39", "Calories 140", "Sodium 160mg 7%". */
    const rest = line;
    const re = new RegExp(NUMTOK + UNIT + "(?:\\s*(?:\\d+%|%))?", "g");
    let m, best = null;
    while ((m = re.exec(rest))) {
      const raw = m[1], unit = lc(m[2] || "");
      /* skip percentages */
      const after = rest.slice(m.index + m[0].length, m.index + m[0].length + 2);
      if (/^\s*%/.test(after) && !unit) continue;
      let v = fixNum(raw);
      if (!isNum(v)) continue;
      let u = unit;
      /* "39" for "3g": a trailing 9 (or q) misread as g → the unit hint decides */
      if ((u === "9" || u === "q") && unitHint === "g") { u = "g"; }
      else if (u === "9") { v = fixNum(raw + "9"); u = ""; }
      best = { v, unit: u, raw };
      break;
    }
    return best;
  }
  function sanityFix(key, val, unit, per, rawTok) {
    /* "39" → 3 when the OCR glued a 9 for g and the value is absurd. */
    if (!isNum(val)) return val;
    const cal = per.cal;
    if (key === "cal") return val;
    if (key === "sodium") return unit === "g" && val < 10 ? val * 1000 : val;
    const KCAL = { p: 4, c: 4, f: 9, fiber: 0, sugar: 0 };
    /* calories already accounted for by the other macros parsed so far */
    const others = ["p", "c", "f"].filter(k => k !== key).reduce((t, k) => t + num(per[k]) * KCAL[k], 0);
    const absurd = v => {
      if (v > 200) return true;
      if (!(isNum(cal) && cal > 0)) return false;
      if (v * KCAL[key] > cal * 1.1 + 20) return true;                       /* this macro alone beats the calories */
      if (KCAL[key] && others + v * KCAL[key] > cal * 1.15 + 20) return true; /* macros together beat the calories */
      if (key === "fiber" || key === "sugar") return v > num(per.c) * 1.2 + 5 && num(per.c) > 0; /* fiber/sugar can't beat total carbs */
      return false;
    };
    if (absurd(val) && !unit && /9$/.test(String(rawTok || "")) && String(val).length >= 2 && Number.isInteger(val)) {
      const alt = Math.floor(val / 10);
      if (!absurd(alt)) return alt;
    }
    if (absurd(val) && val >= 100 && Number.isInteger(val)) {
      /* "3g" read as "39"; "8g" as "89"; also "12g" → "129" */
      const alt = Math.floor(val / 10);
      if (!absurd(alt)) return alt;
    }
    return val;
  }
  function parseServingLine(text) {
    const lines = String(text).split("\n");
    const si = lines.findIndex(l => /serving\s*size/i.test(l));
    let cand = null;
    const looks = l => /(\d|[½¼¾⅓⅔])\s*[a-zA-Z(]|\(\s*[\dOolI|.,]+\s*(g|9|ml)/i.test(l) && !/calories|servings?\s*per|per\s*container|amount/i.test(l);
    if (si >= 0) {
      const same = lines[si].replace(/.*serving\s*size[:\s]*/i, "").trim();
      if (looks(same)) cand = same;
      /* new-style labels put "1 bar (60g)" on the line ABOVE or BELOW "Serving size" */
      if (!cand && si + 1 < lines.length && looks(lines[si + 1])) cand = lines[si + 1];
      if (!cand && si > 0 && looks(lines[si - 1])) cand = lines[si - 1];
    }
    if (!cand) { const m = /per\s+([^\n]*?\(\s*\d+\s*g\)[^\n]*)/i.exec(text); if (m) cand = m[1]; }
    if (!cand) return null;
    let s = cand.replace(/\s+/g, " ").trim();
    /* grams / mL in parens */
    let g = null;
    const gm = /\(\s*(?:about\s*)?([\dOolI|.,]+)\s*(g|grams?|9|ml|mL|mi)\s*\)/i.exec(s) || /([\dOolI|.,]+)\s*(g|grams?)\b/i.exec(s);
    if (gm) { const v = fixNum(gm[1]); if (isNum(v) && v > 0) g = /ml|mi/i.test(gm[2]) ? r1(v) : r1(v); }
    s = s.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    let qty = 1, unit = "serving";
    const qm = /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?|[½¼¾⅓⅔])\s*([a-zA-Z][a-zA-Z .]*)?/.exec(s);
    if (qm) {
      const q = qm[1];
      const uni = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 0.333, "⅔": 0.667 };
      if (uni[q]) qty = uni[q];
      else if (/\s/.test(q)) { const [a, fr] = q.split(/\s+/); const [n, d] = fr.split("/"); qty = num(a) + num(n) / (num(d) || 1); }
      else if (q.includes("/")) { const [n, d] = q.split("/"); qty = num(n) / (num(d) || 1); }
      else qty = num(q.replace(",", "."), 1);
      unit = (qm[2] || "").replace(/\b(about|approx\.?)\b/gi, "").replace(/[.\s]+$/, "").trim() || (g ? "g" : "serving");
      if (unit === "g" && g == null) g = qty;
    } else if (/^[a-z]/i.test(s)) {
      unit = s.split(/\s+/).slice(0, 3).join(" ").replace(/[.,;:]+$/, "");
    }
    unit = unit.replace(/\b(cups?)\b/i, m0 => m0.toLowerCase()).replace(/\s{2,}/g, " ");
    if (/^\d/.test(unit)) unit = "serving";
    return { qty: +qty.toFixed(3) || 1, unit, g: isNum(g) && g > 0 ? g : null };
  }

  M.food.label = M.food.label || {};
  M.food.label.parse = function (text) {
    const raw = String(text == null ? "" : text);
    const per = { cal: 0, p: 0, c: 0, f: 0, fiber: 0, sugar: 0, sodium: 0 };
    const fields = [];
    const lines = raw.replace(/\r/g, "").split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    const found = {};
    /* pass 1: calories first (needed for sanity checks) */
    const order = ["cal", "f", "sodium", "c", "fiber", "sugar", "p"];
    for (const key of order) {
      const spec = FIELDS.find(f => f.key === key);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (found[key] !== undefined) break;
        if (!spec.re.test(line)) continue;
        if (key !== "cal" && IGNORE_LINE.test(line) && !/^\s*(total|dietary)/i.test(line)) continue;
        if (key === "sugar" && /added/i.test(line)) continue;
        if (key === "sugar" && /total\s*sugars?/i.test(raw) && !/total/i.test(line)) continue; /* prefer the Total Sugars line */
        if (key === "c" && /net\s*carb/i.test(line)) continue;
        if (key === "cal" && /from\s*fat|per\s*serving\s*$/i.test(line) && !/\d/.test(line)) continue;
        const idx = line.search(spec.re);
        let tail = line.slice(idx).replace(spec.re, "").trim();
        /* the value may sit on the NEXT line ("Calories" / "140") */
        let hit = findValue(tail, spec.unit);
        if (!hit && i + 1 < lines.length && /^[\dOolI|.,]+\s*(mg|g|9|kcal)?\s*(\d+%)?$/i.test(lines[i + 1])) hit = findValue(lines[i + 1], spec.unit);
        if (!hit) continue;
        let v = hit.v;
        if (key === "cal" && v > 2000 && v % 10 === 0 && String(hit.raw).length >= 4) v = Math.floor(v / 10); /* "1409" → 140 rare glue */
        v = sanityFix(key, v, hit.unit, per, hit.raw);
        if (key === "sodium" && hit.unit === "g" && v < 10) v = v * 1000;
        if (!isNum(v) || v < 0) continue;
        found[key] = key === "cal" || key === "sodium" ? r0(v) : r1(v);
        per[key] = found[key];
        fields.push(key);
      }
    }
    /* calorie sanity: if missing, estimate from macros */
    if (found.cal === undefined && (found.p || found.c || found.f)) { per.cal = r0(num(per.p) * 4 + num(per.c) * 4 + num(per.f) * 9); }
    const found_serving = parseServingLine(raw);
    const serving = found_serving || { qty: 1, unit: "serving", g: null };
    if (found_serving) fields.push("serving");
    /* name: first line above "Nutrition Facts" that looks like words, else none */
    let name;
    const nfIdx = lines.findIndex(l => /nutrition\s*facts/i.test(l));
    for (let i = 0; i < (nfIdx > 0 ? nfIdx : 0); i++) { const l = lines[i]; if (/^[A-Za-z][A-Za-z '&-]{2,40}$/.test(l) && !/serving|calories|amount/i.test(l)) { name = l; break; } }
    const out = { serving, per, fields, source: "label" };
    if (name) out.name = name;
    return out;
  };

  const TESS_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  const tessReady = () => !!(win().Tesseract && typeof win().Tesseract.createWorker === "function");
  const LABEL_PROMPT = 'This is a photo of a US Nutrition Facts label. Read it carefully. Reply with ONLY this JSON, no prose, no code fences:\n' +
    '{"name": string (product name if visible, else ""), "brand": string ("" if unknown), "serving": {"qty": number, "unit": string, "g": number|null (grams per serving, or null)}, ' +
    '"per": {"cal": number, "p": number, "c": number, "f": number, "fiber": number, "sugar": number, "sodium_mg": number}}\n' +
    'Rules: values are per ONE serving as printed. p = Protein grams, c = Total Carbohydrate grams, f = Total Fat grams, fiber = Dietary Fiber grams, sugar = Total Sugars grams (not Added Sugars), sodium_mg = Sodium in milligrams. Use 0 for anything not printed. Numbers only, no units.';

  async function ocrText(file, onProgress) {
    const say = m => { try { if (typeof onProgress === "function") onProgress(m); } catch (e) {} };
    say("Loading the reader…");
    await loadScript(TESS_URL, tessReady, 15000, "ocr_load", "The label reader couldn't load. Check your connection, or add your Anthropic key in You → AI.");
    say("Preparing the photo…");
    const prep = await M.img.prepOCR(file, 1600);
    say("Reading label…");
    const T = win().Tesseract;
    let worker = null;
    try {
      worker = await withTimeout(T.createWorker("eng", 1, { logger: m => { if (m && m.status === "recognizing text" && isNum(m.progress)) say("Reading label… " + Math.round(m.progress * 100) + "%"); } }), 60000, "ocr", "The label reader took too long to start.");
      try { await worker.setParameters({ preserve_interword_spaces: "1" }); } catch (e) {}
      const res = await withTimeout(worker.recognize(prep.blob), 60000, "ocr", "Reading the label took too long. Try a closer, brighter photo.");
      return String(res && res.data && res.data.text || "");
    } catch (e) {
      throw wrapErr(e, "ocr", "The label couldn't be read. Try a closer, brighter photo, or type it in.");
    } finally {
      if (worker) { try { await worker.terminate(); } catch (e) {} }
    }
  }

  /* fromImage(file, {onProgress}) → {food, method, rawText} */
  M.food.label.fromImage = function (file, opt) {
    opt = isObj(opt) ? opt : {};
    const say = m => { try { if (typeof opt.onProgress === "function") opt.onProgress(m); } catch (e) {} };
    return Promise.resolve().then(async () => {
      if (!file) throw E("image", "Pick a photo of the label first.");
      if (!M.ai.probed()) { try { await withTimeout(M.ai.probe(), 2000); } catch (e) {} }
      const canAI = M.ai.ready() && (opt.method !== "ocr") && await M.ai.images();
      if (canAI) {
        say("Reading label with Claude…");
        try {
          const j = await M.ai.json(LABEL_PROMPT, { images: [file], timeout: 90000 });
          const o = isObj(j) ? j : {};
          const per = perFromAI(o.per);
          const serving = servingFromAI(o.serving, null);
          const food = { name: String(o.name || "").trim(), brand: String(o.brand || "").trim(), serving, per, per100g: serving.g ? scaleTo100(per, serving.g) : null, alts: serving.g ? [{ label: "100 g", g: 100 }] : [], source: "label" };
          return { food, method: "ai", rawText: "" };
        } catch (e) {
          /* AI failed: fall through to OCR only if it was not an auth problem worth surfacing */
          if (isE(e) && (e.code === "auth" || e.code === "rate_limited")) throw e;
          say("Claude couldn't read it. Trying OCR…");
        }
      }
      const rawText = await ocrText(file, say);
      const parsed = M.food.label.parse(rawText);
      if (!parsed.fields.length || (!parsed.per.cal && !parsed.per.p && !parsed.per.c && !parsed.per.f)) throw E("ocr", "Couldn't find the numbers on that label. Try a closer, brighter photo, or type them in.", rawText);
      const food = { name: parsed.name || "", brand: "", serving: parsed.serving, per: parsed.per, per100g: parsed.serving.g ? scaleTo100(parsed.per, parsed.serving.g) : null, alts: parsed.serving.g ? [{ label: "100 g", g: 100 }] : [], source: "label" };
      return { food, method: "ocr", rawText, fields: parsed.fields };
    });
  };
  function scaleTo100(per, g) {
    if (!(g > 0)) return null;
    const o = {}; NUT.forEach(k => { const v = num(per && per[k]) * 100 / g; o[k] = k === "cal" || k === "sodium" ? r0(v) : r1(v); });
    return o;
  }

  /* ======================================================================== */
  /* M.food.photo / describe / estimateByName — Claude estimation              */
  /* ======================================================================== */
  const ITEMS_SHAPE = '{"items":[{"name": string, "servingLabel": string like "1 cup (240 g)" or "4 oz (113 g)", "g": number (grams of this portion) or null, ' +
    '"per": {"cal": number, "p": number, "c": number, "f": number, "fiber": number, "sugar": number, "sodium_mg": number}}], "note": string (one short plain sentence about how sure you are)}';
  const ITEMS_RULES = 'Rules: "per" is for the WHOLE portion listed in servingLabel (one line per food). Calories in kcal; p c f fiber sugar in grams; sodium_mg in milligrams. Use realistic US home / restaurant portions. Numbers only, no units, no ranges. Reply with ONLY the JSON, no prose, no code fences.';
  const slotHint = slot => (slot ? " This is for " + slot + "." : "");
  function itemsFromAI(j, source) {
    const list = isObj(j) && Array.isArray(j.items) ? j.items : Array.isArray(j) ? j : [];
    const items = list.filter(isObj).map(it => itemFromAI(it, source)).filter(it => it.name);
    return { items, note: isObj(j) && j.note ? String(j.note) : "" };
  }

  M.food.photo = {
    /* estimate(file, {slot}) → {items:[{name, servingLabel, g, per, servings:1, source:"photo"}], note} */
    estimate(file, opt) {
      opt = isObj(opt) ? opt : {};
      return Promise.resolve().then(async () => {
        if (!file) throw E("image", "Pick a photo first.");
        if (!M.ai.probed()) { try { await withTimeout(M.ai.probe(), 2000); } catch (e) {} }
        if (!M.ai.ready()) throw E("no_ai", "Photo logging needs Claude. Open Chalk inside claude.ai or add your Anthropic key in You → AI.");
        if (!(await M.ai.images())) throw E("no_ai", "Photos can't be sent to Claude here. Add your Anthropic key in You → AI.");
        const prompt = "Look at this photo of food. Identify each food you can see and estimate a realistic portion for each (home or restaurant size), then estimate its nutrition." + slotHint(opt.slot) +
          "\nReply with ONLY this JSON:\n" + ITEMS_SHAPE + "\n" + ITEMS_RULES + " If it is not food, return {\"items\":[],\"note\":\"No food found.\"}.";
        const j = await M.ai.json(prompt, { images: [file], timeout: 90000 });
        const out = itemsFromAI(j, "photo");
        if (!out.items.length && !out.note) out.note = "No food found in that photo.";
        return out;
      });
    }
  };

  /* ---- describe fallback (no AI): "2 eggs, 1 cup white rice, 4 oz chicken breast" ---- */
  const UNIT_WORDS = {
    g: ["g", "gram", "grams", "gr"], oz: ["oz", "ounce", "ounces"], lb: ["lb", "lbs", "pound", "pounds"],
    cup: ["cup", "cups", "c"], tbsp: ["tbsp", "tbsps", "tablespoon", "tablespoons", "tb"], tsp: ["tsp", "tsps", "teaspoon", "teaspoons"],
    ml: ["ml", "milliliter", "milliliters", "millilitre"], "fl oz": ["floz", "fl", "fluid"],
    slice: ["slice", "slices"], piece: ["piece", "pieces", "pc", "pcs"], scoop: ["scoop", "scoops"], serving: ["serving", "servings", "portion", "portions"],
    small: ["small"], medium: ["medium", "med"], large: ["large", "lg"], can: ["can", "cans"], bottle: ["bottle", "bottles"], bar: ["bar", "bars"], egg: ["egg", "eggs"], handful: ["handful", "handfuls"], bag: ["bag", "bags"], packet: ["packet", "packets", "pack"]
  };
  const UNIT_LOOKUP = {}; Object.keys(UNIT_WORDS).forEach(u => UNIT_WORDS[u].forEach(w => { UNIT_LOOKUP[w] = u; }));
  const WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5, quarter: 0.25, "a half": 0.5, couple: 2, few: 3 };
  const FRACS = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 0.333, "⅔": 0.667, "⅛": 0.125 };
  const STOP = /^(of|the|some|with|and|a|an|my|plain|cooked|raw|fresh|whole)$/i;

  /* "1.5 cups rice" → {qty:1.5, unit:"cup", words:"rice", raw} */
  M.food.parseQuantity = function (phrase) {
    let s = String(phrase == null ? "" : phrase).trim().replace(/\s+/g, " ");
    const raw = s;
    let qty = null, unit = null;
    const m = /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?|[½¼¾⅓⅔⅛]|a half|half a|half an|half|quarter|a couple of|a couple|a few|couple|few|one|two|three|four|five|six|seven|eight|nine|ten|an|a)\b\s*/i.exec(s);
    if (m) {
      const q = lc(m[1]);
      if (FRACS[q]) qty = FRACS[q];
      else if (/^\d+\s+\d+\/\d+$/.test(q)) { const [a, fr] = q.split(/\s+/); const [n, d] = fr.split("/"); qty = num(a) + num(n) / (num(d) || 1); }
      else if (/^\d+\/\d+$/.test(q)) { const [n, d] = q.split("/"); qty = num(n) / (num(d) || 1); }
      else if (/^\d/.test(q)) qty = num(q.replace(",", "."), 1);
      else if (/half/.test(q)) qty = 0.5;
      else if (/quarter/.test(q)) qty = 0.25;
      else if (/couple/.test(q)) qty = 2;
      else if (/few/.test(q)) qty = 3;
      else qty = WORD_NUM[q] !== undefined ? WORD_NUM[q] : 1;
      s = s.slice(m[0].length);
    }
    /* "x2" / "2x" suffix */
    const xm = /\s*[x×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(s);
    if (xm) { qty = (qty == null ? 1 : qty) * num(xm[1], 1); s = s.slice(0, xm.index); }
    /* trailing quantity: "chicken thigh 8 oz", "rice 1 cup", "banana (1 medium)" */
    if (qty == null) {
      const tm = /\s*\(?\s*(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)?\s*\)?\s*$/.exec(s);
      if (tm && tm.index > 0) {
        const q = tm[1];
        if (/^\d+\s+\d+\/\d+$/.test(q)) { const [a, fr] = q.split(/\s+/); const [n, d] = fr.split("/"); qty = num(a) + num(n) / (num(d) || 1); }
        else if (/^\d+\/\d+$/.test(q)) { const [n, d] = q.split("/"); qty = num(n) / (num(d) || 1); }
        else qty = num(q.replace(",", "."), 1);
        const uw = lc(tm[2] || "");
        if (uw && UNIT_LOOKUP[uw] && UNIT_LOOKUP[uw] !== "egg") unit = UNIT_LOOKUP[uw];
        s = s.slice(0, tm.index);
      }
    }
    const um = /^([a-zA-Z]+)\.?\s*(oz\b)?\s*/.exec(s);
    if (um) {
      const w = lc(um[1]);
      const u = UNIT_LOOKUP[w];
      if (u && !(u === "egg" && !/^eggs?\s*$/i.test(s.trim()) && s.trim().split(/\s+/).length > 1 && !/^eggs?\s+(white|whites|yolk)/i.test(s))) {
        if (u !== "egg") { unit = u === "fl oz" || (w === "fl" && um[2]) ? "fl oz" : u; s = s.slice(um[0].length); }
      }
    }
    /* "4oz" glued */
    const gm = /^(\d+(?:\.\d+)?)(g|oz|ml|lb)\b\s*/i.exec(s);
    if (gm && qty == null) { qty = num(gm[1]); unit = UNIT_LOOKUP[lc(gm[2])]; s = s.slice(gm[0].length); }
    let words = s.replace(/^of\s+/i, "").replace(/[.,;]+$/, "").trim();
    return { qty: qty == null ? 1 : qty, unit, words, raw, explicitQty: qty != null };
  };

  const GRAMS_PER = { g: 1, oz: 28.35, lb: 453.6, ml: 1, "fl oz": 29.57 };
  const VOL_CUPS = { cup: 1, tbsp: 1 / 16, tsp: 1 / 48, ml: 1 / 240, "fl oz": 1 / 8 };
  const UNIT_ALIAS = { cup: /^cups?$/i, tbsp: /^(tbsp|tablespoons?)$/i, tsp: /^(tsp|teaspoons?)$/i, oz: /^(oz|ounces?)$/i, g: /^(g|grams?)$/i, slice: /^slices?$/i, piece: /^pieces?$/i, scoop: /^scoops?$/i, serving: /^servings?$/i, egg: /^(large\s+)?eggs?$/i, bar: /^bars?$/i, can: /^cans?$/i, ml: /^ml$/i, "fl oz": /^fl\s*oz$/i };
  function unitMatches(u, label) { const re = UNIT_ALIAS[u]; return re ? re.test(String(label || "").trim()) : lc(u) === lc(label).replace(/s$/, ""); }

  /* Given a Food-ish (serving, per, per100g, alts) and a parsed quantity, return
     {servings, servingLabel, g, per} where per is for ONE servingLabel. */
  function scaleToQuantity(food, q) {
    const sv = food.serving || { qty: 1, unit: "serving", g: null };
    const svQty = num(sv.qty, 1) || 1, svUnit = String(sv.unit || "serving"), svG = num(sv.g, null) > 0 ? num(sv.g) : null;
    const per100 = food.per100g && food.per100g.cal > 0 ? food.per100g : null;
    const alts = Array.isArray(food.alts) ? food.alts : [];
    const label = (qty, unit, g) => (M.fmtServing ? M.fmtServing({ qty, unit, g }) : qty + " " + unit + (g ? " (" + g + " g)" : ""));
    const perForGrams = grams => {
      if (per100) return M.foodMath ? M.foodMath.fromPer100(per100, grams) : null;
      if (svG) return M.foodMath ? M.foodMath.scale(food.per, grams / svG) : null;
      return null;
    };
    const own = servings => ({ servings, servingLabel: label(svQty, svUnit, svG), g: svG ? r1(svG * servings) : null, per: food.per });
    /* an exact gram amount → "100 g" rows when we know per100g, else a fraction of the food's own serving */
    const grams = g => {
      if (per100) return { servings: r1(g / 100) || +(g / 100).toFixed(2), servingLabel: "100 g", g: r1(g), per: per100 };
      if (svG) return own(g / svG);
      return null;
    };
    const u = q.unit;
    if (!u) {
      /* "2 eggs" / "2 chicken breast": a count of the food's own serving, or of one unit when the serving is "4 oz" etc. */
      if (/^(g|oz|ml|lb)$/i.test(svUnit) && svG) return own(q.qty);
      return own(q.qty / svQty);
    }
    /* same unit as the food's serving: "1 cup rice" on a "1 cup" food */
    if (unitMatches(u, svUnit)) return own(q.qty / svQty);
    /* an alt with that unit ("1 oz", "1/2 cup", "1 slice") becomes the serving row */
    const alt = alts.find(a => { const p = M.parseServing ? M.parseServing(a.label) : null; return p && a.g && unitMatches(u, p.unit); });
    if (alt) {
      const p = M.parseServing(alt.label);
      const per = perForGrams(alt.g);
      if (per) return { servings: q.qty / (p.qty || 1), servingLabel: label(p.qty || 1, p.unit, alt.g), g: r1(alt.g * q.qty / (p.qty || 1)), per };
    }
    /* weight units without a matching alt */
    if (GRAMS_PER[u]) { const r = grams(q.qty * GRAMS_PER[u]); if (r) return r; }
    /* volume ↔ volume when the food's serving is a volume */
    const svVol = VOL_CUPS[lc(svUnit).replace(/s$/, "")];
    if (VOL_CUPS[u] && svVol) return own((q.qty * VOL_CUPS[u]) / (svQty * svVol));
    /* volume unit on a weight-based food that has a cup alt */
    const cupAlt = alts.find(a => /cup/i.test(a.label) && a.g);
    if (VOL_CUPS[u] && cupAlt) {
      const p = M.parseServing(cupAlt.label);
      const r = grams(cupAlt.g * (q.qty * VOL_CUPS[u]) / ((p.qty || 1) * VOL_CUPS.cup));
      if (r) return r;
    }
    /* size words / unknown units → servings of the food's own size */
    const sizeMul = { small: 0.75, medium: 1, large: 1.25 }[u];
    return own(q.qty * (sizeMul || 1));
  }

  const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
  const DESCRIPTOR = /^(large|medium|small|whole|plain|old|fashioned|style|cooked|raw|dry|fresh|frozen|canned|drained|boneless|skinless|lean|light|reduced|fat|free|low|nonfat|unsweetened|sweetened|creamy|crunchy|organic|regular|original|classic|with|no|in|water|oil|and|of|the|a|an|per|kirkland|kroger|brand|slice|slices|cup|oz|g|lb|large)$/i;
  const toks = s => lc(s).split(WORD_SPLIT).filter(w => w && !STOP.test(w));
  const singular = w => (w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.replace(/(ie)s$/, "y").replace(/(o|ch|sh|x)es$/, "$1").replace(/s$/, "") : w);
  function nameScore(qWords, food) {
    const full = lc(food.name), b = lc(food.brand || "");
    const main = full.replace(/\([^)]*\)/g, " ");          /* drop "(Kirkland)" notes for the penalty */
    const head = main.split(/[,(]/)[0];                     /* "Taco" of "Taco, street style" */
    const allWords = full.split(WORD_SPLIT).filter(Boolean).map(singular);
    const mainWords = main.split(WORD_SPLIT).filter(Boolean).map(singular);
    const headWords = head.split(WORD_SPLIT).filter(Boolean).map(singular);
    const qs = qWords.map(singular);
    let s = 0, hits = 0;
    for (const w of qs) {
      if (allWords.includes(w)) { hits++; s += 20; if (headWords.includes(w)) s += 6; }
      else if (allWords.some(x => (x.startsWith(w) && w.length >= 3) || (w.startsWith(x) && x.length > 3))) { hits++; s += 10; }
      else if (b.includes(w)) { hits++; s += 5; }
      else s -= 8;
    }
    if (!hits) return -1;
    /* Unmatched name words cost: a real food word ("milk" in "Oat milk") costs more than a descriptor ("old", "large"). */
    let pen = 0;
    mainWords.forEach(w => { if (qs.includes(w)) return; pen += DESCRIPTOR.test(w) ? 0.5 : 4; });
    s -= Math.min(10, pen);
    /* the head noun is fully covered ("Egg" for "2 eggs", "Peanut butter" for "peanut butter") */
    if (headWords.length && headWords.every(w => qs.includes(w) || DESCRIPTOR.test(w))) s += 12;
    /* cooked over raw when the person didn't say */
    if (/\braw\b|uncooked/.test(full) && !qs.some(w => /raw|dry|uncooked/.test(w))) s -= 6;
    if (/\bcooked\b/.test(full)) s += 2;
    if (food.source === "generic" && food.brand) s -= 2;
    if (food.uses) s += Math.min(8, Math.log2(food.uses + 1) * 2);
    return s;
  }
  function localCandidates() {
    let list = [];
    try { if (M.foods && M.foods.list) list = list.concat(M.foods.list()); } catch (e) {}
    try { const g = M.DB && M.DB.generic; if (Array.isArray(g)) list = list.concat(g); } catch (e) {}
    return list;
  }
  M.food.matchLocal = function (words) {
    const qw = toks(words);
    if (!qw.length) return null;
    let best = null, bestS = -1;
    localCandidates().forEach(f => {
      if (!f || !f.name) return;
      const s = nameScore(qw, f);
      if (s > bestS) { bestS = s; best = f; }
    });
    return best && bestS >= 8 ? best : null;
  };
  M.food.describeLocal = function (text) {
    const raw = String(text == null ? "" : text);
    const parts = raw.split(/\n|,|;|\s+(?:and|plus|with)\s+|\s*\+\s*|\s+&\s+/i).map(s => s.trim()).filter(Boolean);
    const items = [], unmatched = [];
    parts.forEach(part => {
      const q = M.food.parseQuantity(part);
      let words = q.words;
      /* "2 tacos" / "a scoop of whey": the unit word may be the food itself */
      let food = words ? M.food.matchLocal(words) : null;
      if (!food && q.unit && !/^(g|oz|lb|ml|fl oz|cup|tbsp|tsp|small|medium|large|serving|piece)$/.test(q.unit)) { food = M.food.matchLocal(q.unit + " " + words); if (food) q.unit = null; }
      if (!food && !words && q.unit) { food = M.food.matchLocal(q.unit); if (food) q.unit = null; }
      if (!food && words) food = M.food.matchLocal(part);
      if (!food) { unmatched.push(part); return; }
      const sc = scaleToQuantity(food, q);
      const per = M.foodMath ? M.foodMath.scale(sc.per || food.per, 1) : (sc.per || food.per);
      const servings = Math.max(0.05, r1(sc.servings) || +(+sc.servings).toFixed(2));
      items.push({ name: food.name, brand: food.brand || "", servings, servingLabel: sc.servingLabel, g: sc.g, per, foodId: food.id, source: food.source === "generic" ? "generic" : "custom", text: part });
    });
    return { items, unmatched };
  };

  M.food.describe = function (text, opt) {
    opt = isObj(opt) ? opt : {};
    return Promise.resolve().then(async () => {
      const s = String(text == null ? "" : text).trim();
      if (!s) return { items: [], unmatched: [], method: "local" };
      if (!M.ai.probed()) { try { await withTimeout(M.ai.probe(), 2000); } catch (e) {} }
      if (M.ai.ready() && opt.method !== "local") {
        try {
          const prompt = "Someone described what they ate: \"" + s.replace(/"/g, "'").slice(0, 2000) + "\"." + slotHint(opt.slot) +
            "\nList each food with the portion they said (or a realistic default if they gave none) and estimate its nutrition.\nReply with ONLY this JSON:\n" + ITEMS_SHAPE + "\n" + ITEMS_RULES;
          const j = await M.ai.json(prompt, { tier: opt.tier || "quick", timeout: 60000 });
          const out = itemsFromAI(j, "ai");
          if (out.items.length) return { items: out.items, unmatched: [], note: out.note, method: "ai" };
        } catch (e) {
          if (isE(e) && e.code === "auth") throw e;
          /* fall through to the local parser */
        }
      }
      const loc = M.food.describeLocal(s);
      return { items: loc.items, unmatched: loc.unmatched, method: "local" };
    });
  };

  M.food.estimateByName = function (name) {
    return Promise.resolve().then(async () => {
      const s = String(name == null ? "" : name).trim();
      if (!s) return null;
      if (!M.ai.probed()) { try { await withTimeout(M.ai.probe(), 2000); } catch (e) {} }
      if (!M.ai.ready()) throw E("no_ai", AI_MSG.no_ai);
      const prompt = "Estimate the nutrition of this food: \"" + s.replace(/"/g, "'").slice(0, 300) + "\". Use its typical single serving in the US (a label serving for packaged foods, a normal portion otherwise).\n" +
        'Reply with ONLY this JSON, no prose, no code fences:\n{"name": string (clean name), "brand": string ("" if generic), "serving": {"qty": number, "unit": string, "g": number|null}, ' +
        '"per": {"cal": number, "p": number, "c": number, "f": number, "fiber": number, "sugar": number, "sodium_mg": number}, "alts": [{"label": string like "1 oz", "g": number}]}\n' +
        "per is for ONE serving. Calories kcal; p c f fiber sugar grams; sodium_mg milligrams. Numbers only. If this is not a food, reply {\"name\":\"\"}.";
      const j = await M.ai.json(prompt, { tier: "quick", timeout: 45000 });
      if (!isObj(j) || !String(j.name || "").trim()) return null;
      const per = perFromAI(j.per);
      const serving = servingFromAI(j.serving, null);
      const alts = (Array.isArray(j.alts) ? j.alts : []).filter(a => isObj(a) && a.label && num(a.g) > 0).map(a => ({ label: String(a.label), g: r1(num(a.g)) })).slice(0, 4);
      if (serving.g && !alts.some(a => a.g === 100)) alts.push({ label: "100 g", g: 100 });
      const now = Date.now();
      return { id: uid(), name: String(j.name).trim(), brand: String(j.brand || "").trim(), barcode: "", source: "ai", serving, per, per100g: serving.g ? scaleTo100(per, serving.g) : null, alts, createdAt: now, updatedAt: now, uses: 0, lastUsed: 0, pid: null };
    });
  };

  /* ======================================================================== */
  /* M.food.suggest — built-ins scored to remaining macros, plus Claude ideas  */
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
    if (over > 0) s -= 60 + over / 5;            /* heavy penalty past remaining+150 */
    const want = { cal: Math.max(150, rem.cal), p: Math.max(10, rem.p), c: Math.max(0, rem.c), f: Math.max(0, rem.f) };
    /* closeness: 0 = perfect. Protein counts twice. Meals that use a big share of what's left are good, tiny meals less so. */
    const calDiff = Math.abs(per.cal - Math.min(want.cal, 900)) / Math.max(150, Math.min(want.cal, 900));
    const pDiff = Math.abs(per.p - Math.min(want.p, 60)) / Math.max(15, Math.min(want.p, 60));
    const cDiff = want.c > 0 ? Math.max(0, per.c - want.c) / Math.max(30, want.c) : per.c / 60;
    const fDiff = want.f > 0 ? Math.max(0, per.f - want.f) / Math.max(15, want.f) : per.f / 30;
    s -= 20 * calDiff + 2 * 20 * pDiff + 8 * cDiff + 8 * fDiff;
    if (per.p >= 25) s += 6;
    if (Array.isArray(sug.tags)) {
      if (prefs && prefs.quick && sug.tags.includes("quick")) s += 8;
      if (prefs && prefs.noCook && sug.tags.includes("no-cook")) s += 8;
      if (prefs && prefs.lowCarb && sug.tags.includes("low-carb")) s += 8;
    }
    if (prefs && prefs.store && sug.store && sug.store !== "Either" && sug.store !== prefs.store) s -= 4;
    if (prefs && prefs.maxPrep && num(sug.prepMin) > num(prefs.maxPrep)) s -= 10;
    s += (jitter === undefined ? Math.random() : jitter) * 6;
    return s;
  };
  M.food.suggestBuiltin = function (opt) {
    opt = isObj(opt) ? opt : {};
    const list = (() => { try { const s = M.DB && M.DB.suggest; return Array.isArray(s) ? s : []; } catch (e) { return []; } })();
    const remaining = remainingOf(opt);
    const n = num(opt.n, 6) || 6;
    const exclude = new Set(Array.isArray(opt.exclude) ? opt.exclude : []);
    const scored = list.filter(s => s && s.id && !exclude.has(s.id)).map(s => ({ s, score: M.food.scoreSuggestion(s, opt.slot, remaining, opt.prefs, opt.jitter) }));
    scored.sort((a, b) => b.score - a.score);
    /* If enough fit, drop the ones that blow the calorie budget. */
    const cap = Math.max(0, remaining.cal) + 150;
    const fits = scored.filter(x => (x.s.per || sumPer(x.s.items)).cal <= cap);
    const pool = fits.length >= n ? fits : scored;
    return pool.slice(0, n).map(x => Object.assign({}, x.s, { per: x.s.per || sumPer(x.s.items), source: "builtin", score: r1(x.score), items: (x.s.items || []).map(it => Object.assign({ servings: 1 }, it)) }));
  };
  const SUGGEST_PROMPT = (slot, rem, prefs) =>
    "Suggest 3 " + (slot ? slot.toLowerCase() + " " : "") + "meals for someone in Denver who shops at King Soopers and Costco. Goal: high protein, quick to make, realistic, mostly whole foods or common branded items (Kirkland, Fairlife, Fage, Dave's Killer Bread, Kodiak, Just Bare, Quest, Premier Protein).\n" +
    "They have about " + r0(rem.cal) + " kcal, " + r0(rem.p) + " g protein, " + r0(rem.c) + " g carbs and " + r0(rem.f) + " g fat left today; each meal should use a good share of the protein and stay under the calories." +
    (prefs && prefs.noCook ? " No cooking." : "") + (prefs && prefs.lowCarb ? " Keep carbs low." : "") + (prefs && prefs.quick ? " Under 10 minutes." : "") +
    '\nReply with ONLY this JSON, no prose, no code fences:\n{"suggestions":[{"name": string, "desc": string (one plain sentence a middle-schooler gets), "store": "King Soopers"|"Costco"|"Either", "prepMin": number, ' +
    '"items":[{"name": string, "servingLabel": string like "6 oz (170 g)", "g": number|null, "per": {"cal": number, "p": number, "c": number, "f": number, "fiber": number, "sugar": number, "sodium_mg": number}}]}]}\n' +
    "per is for that item's whole portion. Calories kcal; p c f fiber sugar grams; sodium_mg milligrams. Numbers only.";
  M.food.suggest = function (opt) {
    opt = isObj(opt) ? opt : {};
    return Promise.resolve().then(async () => {
      const builtins = M.food.suggestBuiltin(opt);
      if (opt.ai === false) return builtins;
      if (!M.ai.probed()) { try { await withTimeout(M.ai.probe(), 1500); } catch (e) {} }
      if (!M.ai.ready()) return builtins;
      const remaining = remainingOf(opt);
      let ai = [];
      try {
        const j = await M.ai.json(SUGGEST_PROMPT(opt.slot, remaining, opt.prefs), { tier: "quick", timeout: 45000 });
        const list = isObj(j) && Array.isArray(j.suggestions) ? j.suggestions : [];
        ai = list.filter(isObj).map(sg => {
          const items = (Array.isArray(sg.items) ? sg.items : []).filter(isObj).map(it => itemFromAI(it, "ai"));
          if (!items.length || !String(sg.name || "").trim()) return null;
          return { id: "ai_" + uid(), name: String(sg.name).trim(), desc: String(sg.desc || "").trim(), slot: opt.slot || "Any", store: /costco/i.test(sg.store) ? "Costco" : /soopers|kroger/i.test(sg.store) ? "King Soopers" : "Either", prepMin: r0(num(sg.prepMin)), items, per: sumPer(items), tags: ["high-protein"], source: "ai" };
        }).filter(Boolean).slice(0, 3);
      } catch (e) { ai = []; }
      return ai.concat(builtins);
    }).catch(() => M.food.suggestBuiltin(opt));
  };

  /* Exposed for tests / other modules. */
  M.food._ = { E, withTimeout, parseJSONText, parseServingSize, scaleToQuantity, sumPer, perFromAI, itemFromAI, fixNum };
})(window.M);
