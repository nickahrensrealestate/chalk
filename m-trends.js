window.M = window.M || {}; M.ui = M.ui || {}; M.ui.actions = M.ui.actions || {}; M.ui.inputs = M.ui.inputs || {}; M.ui.changes = M.ui.changes || {}; M.ui.views = M.ui.views || {};
/* ============================================================================
   Chalk · Macros — Trends + You + check-ins (m-trends.js)
   Trends view (weight / resting-heart-rate charts, weekly macro bars), You view
   (numbers, calculator, split, targets, units, AI key, person), the first-day
   setup card, the 60-day refresh card and the 2-week body check-in card.
   Charts are pure functions (M.charts.line / M.charts.bars → SVG strings).
   Extends M.ui.{actions,inputs,changes,views}; every action is prefixed "t-".
   Never throws at load. Chalk globals are read lazily inside functions.
   ========================================================================== */
(function (M) {
  "use strict";

  /* ---------------------------------------------------------------- helpers */
  const isNum = v => typeof v === "number" && isFinite(v);
  function num(v, d) { if (d === undefined) d = 0; if (typeof v === "string") v = parseFloat(v.replace(",", ".")); return isNum(v) ? v : d; }
  const r0 = v => Math.round(v);
  const r1 = v => Math.round(v * 10 + (v >= 0 ? 1e-9 : -1e-9)) / 10;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const esc = s => (typeof M.esc === "function" ? M.esc(s) : String(s == null ? "" : s));
  const DAY = 864e5;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DOW = ["S", "M", "T", "W", "T", "F", "S"];
  const now = () => (typeof M.now === "function" ? M.now() : Date.now());

  const pid = () => { try { return M.pid ? M.pid() : null; } catch (e) { return null; } };
  const person = id => M.person(id === undefined ? pid() : id);
  const doc = () => (typeof document !== "undefined" ? document : null);
  const $ = id => { const d = doc(); return d ? d.getElementById(id) : null; };
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  const rerender = () => { try { (M.ui.rerender || M.ui.render || function () {})(); } catch (e) {} };
  const toast = m => {
    try {
      if (typeof M.ui.toast === "function") return M.ui.toast(m);
      if (typeof window.toast === "function") return window.toast(m);
    } catch (e) {}
  };
  const openSheet = (t, h) => {
    try {
      if (typeof M.ui.sheet === "function") return M.ui.sheet(t, h);
      if (typeof window.openSheet === "function") return window.openSheet(t, h);
    } catch (e) {}
  };
  const closeSheet = () => {
    try {
      if (typeof M.ui.close === "function") return M.ui.close();
      if (typeof window.closeSheet === "function") return window.closeSheet();
    } catch (e) {}
  };

  const fmtN = n => String(Math.round(num(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  /* Rounds first, so a tiny change never reads "−0.0". */
  const signed = (v, dp) => { const f = Math.pow(10, dp), x = Math.round(num(v) * f) / f; return (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(dp); };
  function keyDate(key) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || "")); return m ? new Date(+m[1], +m[2] - 1, +m[3], 12) : null; }
  const fmtShort = key => { const d = keyDate(key); return d ? MON[d.getMonth()] + " " + d.getDate() : String(key || ""); };
  /* "Jun '25" style, for charts that span more than one year */
  const fmtMonYr = key => { const d = keyDate(key); return d ? MON[d.getMonth()] + " '" + String(d.getFullYear()).slice(2) : String(key || ""); };
  const fmtTs = ts => { const d = new Date(num(ts)); return isNum(d.getTime()) && ts ? MON[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear() : "—"; };
  const dow = key => { const d = keyDate(key); return d ? DOW[d.getDay()] : ""; };

  /* Stamp a person's numbers as edited now (the cloud sync keeps the newer edit). */
  const touchP = p => { if (p) p.updatedAt = now(); return p; };
  /* 71.6 in → 6 ft 0 in, never "5 ft 12 in" */
  const ftIn = h => { if (!isNum(h)) return { ft: "", inch: "" }; let ft = Math.floor(h / 12), inch = r0(h - ft * 12); if (inch >= 12) { ft++; inch = 0; } return { ft, inch }; };
  const units = p => (p && p.units === "metric" ? "metric" : "us");
  const wUnit = u => (u === "metric" ? "kg" : "lb");
  const toDispW = (lb, u) => (isNum(lb) ? (u === "metric" ? r1(M.units.lb2kg(lb)) : r1(lb)) : "");
  const fmtW = (lb, u) => M.units.fmtW(lb, u);
  /* a rate as plain words: "0.5 lb a week" (the sign is said by "lose" / "gain" around it) */
  const rateWords = (lbwk, u) => (u === "metric" ? Math.abs(M.units.lb2kg(num(lbwk))).toFixed(2).replace(/0$/, "") + " kg a week" : Math.abs(r1(num(lbwk))) + " lb a week");
  /* lb per week → round, plain labels. Metric uses round kg (0.25 / 0.5 / 0.75 / 1). */
  const HALF = { "0.5": "½", "1.5": "1½" };
  const KG_PACE = { "0.5": "0.25", "1": "0.5", "1.5": "0.75", "2": "1" };
  const paceLabel = (p, u) => {
    p = num(p);
    if (!p) return "Keep my weight";
    const a = String(Math.abs(p));
    const amt = u === "metric" ? (KG_PACE[a] || String(r1(Math.abs(p) * 0.4536))) + " kg" : (HALF[a] || a) + " lb";
    return (p < 0 ? "Lose " : "Gain ") + amt + " a week";
  };
  /* Steady under 0.1 lb a week */
  const STEADY = 0.1;

  /* F1's M.body.check when m-core has it; the same ranges here until then.
     `value` is in the person's units (kg when metric). */
  function bodyCheck(value, kind, u) {
    try {
      if (M.body && typeof M.body.check === "function") {
        const r = M.body.check(value, kind, u);
        if (r && typeof r.ok === "boolean") return { ok: r.ok, msg: r.ok ? "" : String(r.msg || "Check that number.") };
      }
    } catch (e) {}
    const v = typeof value === "number" ? value : parseFloat(String(value == null ? "" : value).replace(",", "."));
    if (kind === "rhr") return v >= 25 && v <= 220 ? { ok: true, msg: "" } : { ok: false, msg: "Resting heart rate should be 25 to 220 beats a minute." };
    const lo = u === "metric" ? 23 : 50, hi = u === "metric" ? 320 : 700;
    return v >= lo && v <= hi ? { ok: true, msg: "" } : { ok: false, msg: "Weight should be " + lo + " to " + hi + " " + wUnit(u) + "." };
  }
  /* The weight a new one is compared with, when the new one is more than 15% away from it. */
  function jumpFrom(id, lb) {
    let ref = 0;
    try { const lw = M.body.latest(id, "w"); ref = lw ? num(lw.value) : num(person(id).weightLb); } catch (e) { ref = 0; }
    return ref > 0 && isNum(lb) && Math.abs(lb - ref) / ref > 0.15 ? ref : null;
  }
  const jumpText = (ref, lb, u, again) => "That's a big change from " + fmtW(ref, u) + ". If " + fmtW(lb, u) + " is right, " + again + ".";
  /* A message line under a form (sheets hide toasts, so forms say it in place). */
  function say(idName, text) { const m = $(idName); if (!m) { if (text) toast(text); return; } m.textContent = text || ""; m.hidden = !text; }
  function blurActive() { try { const d = doc(), a = d && d.activeElement; if (a && a !== d.body && typeof a.blur === "function") a.blur(); } catch (e) {} }
  /* Chalk's workout in progress (index.html's S.active) */
  const trainBusy = () => { try { return typeof S !== "undefined" && !!S && !!S.active; } catch (e) { return false; } };
  const inTrain = () => { try { return typeof M.mode === "function" && M.mode() !== "macros"; } catch (e) { return false; } };
  /* After an edit in You: finishes first-day setup, clears the 60-day card (F1's M.checkins.numbersChanged; same rule here until it lands). */
  function numbersChanged(id) {
    try { if (M.checkins && typeof M.checkins.numbersChanged === "function") { M.checkins.numbersChanged(id); return; } } catch (e) {}
    try {
      const p = person(id);
      if (!p.setupAt) { if (M.calc.complete(p)) M.checkins.done(id, "setup"); }
      else if (now() - num(p.setupAt) > 60 * DAY) M.checkins.done(id, "refresh60");
    } catch (e) {}
  }

  /* ================================================================= charts */
  /* Nice ticks (1 / 2 / 2.5 / 5 × 10^n) inside [lo, hi]: about 4, never fewer than 3. */
  function niceTicks(lo, hi, n) {
    n = n || 4;
    if (!(hi > lo)) hi = lo + 1;
    const make = k => {
      const raw = (hi - lo) / k;
      const mag = Math.pow(10, Math.floor(Math.log10(raw)));
      const norm = raw / mag;
      const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
      const out = [];
      for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
      return out;
    };
    let out = make(n);
    for (let k = n + 1; out.length < 3 && k <= n + 8; k++) out = make(k);
    return out;
  }
  const fmtTick = v => (Math.abs(v) >= 1000 ? fmtN(v) : String(+(+v).toFixed(1)));
  const f1 = v => (+v).toFixed(1);
  /* A label on a small rounded plate (goal / target), so lines never run through the words. */
  function pill(x, y, text, cls, H) {
    const w = Math.round(String(text).length * 6.1 + 12), h = 16;
    const top = clamp(y - h / 2, 0, Math.max(0, H - h));
    return `<g class="mt-pill ${cls}"><rect x="${f1(x)}" y="${f1(top)}" width="${w}" height="${h}" rx="8"/><text x="${f1(x + 6)}" y="${f1(top + 11.5)}">${esc(text)}</text></g>`;
  }
  /* Tap readout data: "x~y~text|…" — the page shows the nearest point's date and value. */
  const tipData = arr => esc(arr.map(p => f1(p.x) + "~" + f1(p.y) + "~" + String(p.t).replace(/[|~]/g, " ")).join("|"));

  M.charts = M.charts || {};
  /* line(series, opts) — series [{date:"YYYY-MM-DD", v}] daily points.
     opts: { avg:[{date,v}] (7-day average line), goal:number|null (dashed),
             goalNear: how far (in the chart's unit) the goal may sit from the data and still be drawn (20),
             from, to (x domain date keys; default first..last point),
             unit:"lb", label:"Weight", tone:"acc"|"mus", w:340, h:180 }
     More than 90 days of daily points are drawn as weekly averages (the latest stays a real point).
     Returns "" for no points, otherwise an <svg> string. */
  M.charts.line = function (series, opts) {
    opts = opts || {};
    const W = num(opts.w, 340), H = num(opts.h, 180), padL = 40, padR = 14, padT = 18, padB = 22;
    const pts = (Array.isArray(series) ? series : []).filter(p => p && isNum(p.v) && p.date).slice().sort(byDate);
    if (!pts.length) return "";
    const from = opts.from || pts[0].date, to = opts.to || pts[pts.length - 1].date;
    const avg = (Array.isArray(opts.avg) ? opts.avg : []).filter(a => a && isNum(a.v) && a.date >= from && a.date <= to).slice().sort(byDate);
    const goal = isNum(opts.goal) ? opts.goal : null;
    const near = isNum(opts.goalNear) ? opts.goalNear : 20;
    const unit = opts.unit ? " " + opts.unit : "";
    const tone = opts.tone === "mus" ? " mus" : "";
    const span = Math.max(0, M.daysBetween(from, to));
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const X = d => (span === 0 ? padL + innerW / 2 : padL + innerW * clamp(M.daysBetween(from, d), 0, span) / span);

    /* long ranges: one point per week (mean), plus the real latest point */
    let shown = pts;
    if (span > 90 && pts.length > 90) {
      const b = new Map();
      pts.slice(0, -1).forEach(p => {
        const k = Math.floor(M.daysBetween(from, p.date) / 7);
        const o = b.get(k) || { n: 0, t: 0, date: p.date, first: p.date };
        o.n++; o.t += p.v; o.date = p.date; b.set(k, o);
      });
      shown = Array.from(b.values()).map(o => ({ date: o.date, v: Math.round(o.t / o.n * 10) / 10, wk: o.first })).concat([pts[pts.length - 1]]);
    }

    /* y domain: the data (+ the average); the goal joins only when it is near the data */
    const vals = shown.map(p => p.v).concat(avg.map(a => a.v));
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const goalIn = goal != null && goal >= lo - near && goal <= hi + near;
    if (goalIn) { lo = Math.min(lo, goal); hi = Math.max(hi, goal); }
    const pad = Math.max((hi - lo) * 0.12, 1);
    lo -= pad; hi += pad;
    const Y = v => padT + innerH * (1 - (v - lo) / (hi - lo));

    let s = "";
    /* grid + y ticks (only values the data reaches) */
    niceTicks(lo, hi, 4).forEach(t => {
      const y = f1(Y(t));
      s += `<line class="g" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/><text x="${padL - 6}" y="${f1(Y(t) + 3.5)}" text-anchor="end">${fmtTick(t)}</text>`;
    });
    s += `<line class="ax" x1="${padL}" x2="${W - padR}" y1="${f1(H - padB)}" y2="${f1(H - padB)}"/>`;
    /* goal: a dashed line with its label on a plate at the left. Far off the data: the label only, at that edge. */
    if (goal != null) {
      if (goalIn) {
        const gy = Y(goal);
        s += `<line class="goal" x1="${padL}" x2="${W - padR}" y1="${f1(gy)}" y2="${f1(gy)}"/>` + pill(padL + 4, gy, "Goal " + fmtTick(goal), "gl", H - padB);
      } else {
        s += pill(padL + 4, goal > hi ? padT + 8 : H - padB - 10, "Goal " + fmtTick(goal) + (goal > hi ? " ↑" : " ↓"), "gl off", H - padB);
      }
    }
    /* 7-day average line, broken where there is a gap of more than 10 days */
    if (avg.length >= 2) {
      let d = "", prev = null;
      avg.forEach(a => { d += (!prev || M.daysBetween(prev.date, a.date) > 10 ? "M" : "L") + f1(X(a.date)) + " " + f1(Y(a.v)) + " "; prev = a; });
      s += `<path class="avg" d="${d.trim()}"/>`;
    }
    /* points (small), the latest one big */
    const r = shown.length > 120 ? 2 : shown.length > 45 ? 2.5 : 3;
    const tips = [];
    shown.forEach((p, i) => {
      const last = i === shown.length - 1, x = X(p.date), y = Y(p.v);
      const text = (p.wk ? "Week of " + fmtShort(p.wk) + ": " + fmtTick(p.v) + unit + " average" : fmtShort(p.date) + ": " + fmtTick(p.v) + unit);
      tips.push({ x, y, t: text });
      s += last ? `<circle class="last" cx="${f1(x)}" cy="${f1(y)}" r="5"><title>${esc(text)}</title></circle>` : `<circle class="pt" cx="${f1(x)}" cy="${f1(y)}" r="${r}"/>`;
    });
    /* last value, labelled */
    const lp = shown[shown.length - 1], lx = X(lp.date), ly = Y(lp.v);
    const above = ly - 12 > padT + 2;
    const anchor = lx > W - padR - 24 ? "end" : lx < padL + 24 ? "start" : "middle";
    s += `<text class="ll" x="${f1(anchor === "end" ? lx + 4 : lx)}" y="${f1(above ? ly - 10 : ly + 17)}" text-anchor="${anchor}">${fmtTick(lp.v)}</text>`;
    /* x labels: the year too when the chart spans more than one; a single day sits under its point */
    const fy = keyDate(from), ty = keyDate(to);
    const xl = k => esc(fy && ty && fy.getFullYear() !== ty.getFullYear() ? fmtMonYr(k) : fmtShort(k));
    if (span === 0) s += `<text x="${f1(X(from))}" y="${H - 6}" text-anchor="middle">${xl(from)}</text>`;
    else {
      s += `<text x="${padL}" y="${H - 6}">${xl(from)}</text>`;
      s += `<text x="${W - padR}" y="${H - 6}" text-anchor="end">${xl(to)}</text>`;
      if (span >= 20) { const mid = M.addDays(from, Math.round(span / 2)); s += `<text x="${f1(X(mid))}" y="${H - 6}" text-anchor="middle">${xl(mid)}</text>`; }
    }
    const said = (opts.label || "Trend") + ", " + fmtShort(from) + (span ? " to " + fmtShort(to) : "") + ". Latest " + fmtTick(pts[pts.length - 1].v) + unit + ". Tap the chart to read a day.";
    return `<svg class="mt-chart${tone}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(said)}" data-top="${padT}" data-bot="${H - padB}" data-pts="${tipData(tips)}">${s}</svg>`;
  };

  /* bars(values, opts) — values [{label, v, empty?:bool, title?}] ; opts { target, unit, label, tone, w, h }.
     Empty (no data) bands are drawn as a dashed hollow stub on the baseline. */
  M.charts.bars = function (values, opts) {
    opts = opts || {};
    const vals = Array.isArray(values) ? values : [];
    if (!vals.length) return "";
    const W = num(opts.w, 340), H = num(opts.h, 150), padL = 40, padR = 14, padT = 14, padB = 20;
    const target = isNum(opts.target) && opts.target > 0 ? opts.target : null;
    const unit = opts.unit ? " " + opts.unit : "";
    const tone = opts.tone === "mus" ? " mus" : "";
    let max = Math.max.apply(null, vals.map(v => num(v && v.v)).concat([target || 0, 0]));
    if (!(max > 0)) max = 100;
    max *= 1.08;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const Y = v => padT + innerH * (1 - clamp(v, 0, max) / max);
    const y0 = Y(0);
    const n = vals.length, band = innerW / n, bw = Math.min(24, Math.round(band * 0.62));
    const longLabels = vals.some(o => o && o.label && String(o.label).length > 2);
    const every = band < (longLabels ? 48 : 22) ? 2 : 1;
    let s = "";
    niceTicks(0, max, 4).forEach(t => {
      const y = f1(Y(t));
      s += `<line class="g" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/><text x="${padL - 6}" y="${f1(Y(t) + 3.5)}" text-anchor="end">${fmtTick(t)}</text>`;
    });
    s += `<line class="ax" x1="${padL}" x2="${W - padR}" y1="${f1(y0)}" y2="${f1(y0)}"/>`;
    const tips = [];
    vals.forEach((v, i) => {
      const x = padL + band * i + (band - bw) / 2;
      const val = num(v && v.v);
      const text = v && v.title != null ? v.title : (v && v.label ? v.label + ": " : "") + (v && v.empty ? "not logged" : fmtTick(val) + unit);
      const title = `<title>${esc(text)}</title>`;
      if (!v || v.empty || !(val > 0)) {
        s += `<g>${title}<rect class="bar-e" x="${f1(x)}" y="${f1(y0 - 6)}" width="${bw}" height="6" rx="2"/></g>`;
        tips.push({ x: x + bw / 2, y: y0 - 6, t: text });
      } else {
        const y = Y(val), h = y0 - y, rr = Math.min(4, h / 2);
        s += `<g>${title}<path class="bar" d="M${f1(x)} ${f1(y0)} L${f1(x)} ${f1(y + rr)} Q${f1(x)} ${f1(y)} ${f1(x + rr)} ${f1(y)} L${f1(x + bw - rr)} ${f1(y)} Q${f1(x + bw)} ${f1(y)} ${f1(x + bw)} ${f1(y + rr)} L${f1(x + bw)} ${f1(y0)} Z"/></g>`;
        tips.push({ x: x + bw / 2, y, t: text });
      }
      if (v && v.label && (n - 1 - i) % every === 0) s += `<text x="${f1(x + bw / 2)}" y="${H - 6}" text-anchor="middle">${esc(v.label)}</text>`;
    });
    if (target != null) {
      const ty = Y(target);
      s += `<line class="tgt" x1="${padL}" x2="${W - padR}" y1="${f1(ty)}" y2="${f1(ty)}"/>` + pill(padL + 4, ty, "Target " + fmtTick(target), "gl", y0);
    }
    return `<svg class="mt-chart${tone}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || "Bars")}" data-top="${padT}" data-bot="${f1(y0)}" data-pts="${tipData(tips)}">${s}</svg>`;
  };

  /* Tap a chart: a thin line, a dot and the date + value of the nearest point. */
  function chartTip(svg, clientX) {
    const raw = svg.getAttribute("data-pts"); if (!raw) return;
    const pts = raw.split("|").map(s => { const a = s.split("~"); return { x: +a[0], y: +a[1], t: a.slice(2).join(" ") }; }).filter(p => isFinite(p.x) && isFinite(p.y));
    if (!pts.length) return;
    const vb = String(svg.getAttribute("viewBox") || "").split(/\s+/).map(Number), W = vb[2] || 340;
    const r = svg.getBoundingClientRect ? svg.getBoundingClientRect() : { left: 0, width: 0 };
    const x = r.width > 0 ? (clientX - r.left) / r.width * W : pts[pts.length - 1].x;
    let best = pts[0];
    pts.forEach(p => { if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p; });
    const NS = "http://www.w3.org/2000/svg", d = svg.ownerDocument;
    const old = svg.querySelector(".mt-tip"); if (old) old.parentNode.removeChild(old);
    const top = num(svg.getAttribute("data-top"), 16), bot = num(svg.getAttribute("data-bot"), 150);
    const g = d.createElementNS(NS, "g"); g.setAttribute("class", "mt-tip");
    const mk = (tag, at) => { const e = d.createElementNS(NS, tag); Object.keys(at).forEach(k => e.setAttribute(k, at[k])); g.appendChild(e); return e; };
    mk("line", { x1: f1(best.x), x2: f1(best.x), y1: f1(top), y2: f1(bot) });
    mk("circle", { cx: f1(best.x), cy: f1(best.y), r: "5" });
    const w = Math.min(W - 4, Math.round(best.t.length * 6.3 + 14));
    const bx = clamp(best.x - w / 2, 2, W - 2 - w);
    mk("rect", { x: f1(bx), y: "0", width: String(w), height: "17", rx: "8.5" });
    const tx = mk("text", { x: f1(bx + w / 2), y: "12.5", "text-anchor": "middle" });
    tx.textContent = best.t;
    svg.appendChild(g);
    const live = $("mt-chart-live"); if (live) live.textContent = best.t;
  }
  try {
    const d0 = doc();
    if (d0 && typeof d0.addEventListener === "function" && !d0.__mtCharts) {
      d0.__mtCharts = true;
      d0.addEventListener("click", e => { try { const t = e.target; const svg = t && t.closest ? t.closest("svg.mt-chart[data-pts]") : null; if (svg) chartTip(svg, e.clientX); } catch (x) {} });
    }
  } catch (e) {}
  M.charts.tip = chartTip;

  /* ================================================================= trends */
  M.trends = M.trends || {};
  M.trends.state = { range: 90 };

  const DOW2 = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const dow2 = key => { const d = keyDate(key); return d ? DOW2[d.getDay()] : ""; };
  /* kg always with one decimal; lb as typed (185, 185.5) */
  const dispW = (lb, u) => (!isNum(lb) ? "—" : u === "metric" ? M.units.lb2kg(lb).toFixed(1) : String(r1(lb)));
  const tile = (v, k, small, sub) => `<div class="stat"><div class="v num">${v}${small ? `<small>${small}</small>` : ""}</div><div class="k">${k}</div>${sub ? `<div class="mt-sub">${sub}</div>` : ""}</div>`;
  /* the chart window: the chosen range, but never before the first point (short history fills the width) */
  function chartFrom(all, range) {
    if (!(range > 0)) return all[0].date;
    const start = M.addDays(M.today(), -(range - 1));
    return all[0].date > start ? all[0].date : start;
  }

  function weightCard(id, p) {
    const u = units(p), range = M.trends.state.range;
    const all = M.body.series(id, "w", 0);
    const avgAll = M.body.avg7(all);
    let body;
    if (!all.length) {
      body = `<div class="mt-empty">No weigh-ins yet. Tap <b>Log weight or heart rate</b> to add one.</div>`;
    } else {
      const latest = all[all.length - 1];
      const a7 = avgAll[avgAll.length - 1].v;
      const rate = M.body.ratePerWeek(id);
      const steady = rate != null && Math.abs(rate) < STEADY;
      const goal = isNum(p.goalWeightLb) && p.goalWeightLb > 0 ? p.goalWeightLb : null;
      const conv1 = lb => (u === "metric" ? M.units.lb2kg(lb) : lb);
      const stats = `<div class="stats">
        ${tile(dispW(latest.v, u), "Latest", wUnit(u), esc(fmtShort(latest.date)))}
        ${tile(dispW(a7, u), "7-day average", wUnit(u), "latest " + signed(conv1(latest.v - a7), 1))}
        ${tile(rate == null ? "—" : steady ? "Steady" : signed(conv1(rate), u === "metric" ? 2 : 1), "Per week", rate == null || steady ? "" : wUnit(u), rate == null ? "needs 2 weeks" : "trend")}
      </div>`;
      let goalLine;
      if (goal == null) goalLine = `<p class="hint">Set a goal weight in <b>You</b> to see how far you are.</p>`;
      else {
        const diff = latest.v - goal;
        const dir = diff > 0 ? "to lose" : diff < 0 ? "to gain" : "";
        const weeks = rate != null && !steady ? Math.abs(diff / rate) : Infinity;
        const onTrack = rate != null && !steady && Math.abs(diff) >= 0.05 && (rate < 0) === (diff > 0) && weeks <= 104;
        goalLine = `<p class="hint mt-goalline">Goal <b>${esc(fmtW(goal, u))}</b> · ${Math.abs(diff) < 0.05 ? "you're there" : "<b>" + esc(fmtW(Math.abs(diff), u)) + "</b> " + dir}${onTrack ? " · about " + Math.max(1, Math.round(weeks)) + " week" + (Math.round(weeks) > 1 ? "s" : "") + " at " + esc(rateWords(rate, u)) : ""}</p>`;
      }
      const from = chartFrom(all, range);
      const to = range > 0 ? M.today() : all[all.length - 1].date;
      const win = all.filter(x => x.date >= from);
      const conv = arr => (u === "metric" ? arr.map(x => ({ date: x.date, v: r1(M.units.lb2kg(x.v)) })) : arr);
      const chart = win.length
        ? M.charts.line(conv(win), { avg: conv(avgAll), goal: goal == null ? null : (u === "metric" ? r1(M.units.lb2kg(goal)) : goal), goalNear: u === "metric" ? 9 : 20, from, to, unit: wUnit(u), label: "Weight", tone: "acc" })
        : `<div class="mt-empty">No weigh-ins in the last ${range} days. Tap <b>All</b> to see older ones.</div>`;
      body = stats + goalLine + chart;
    }
    return `<div class="card mt-card"><div class="hd"><h3>Weight</h3></div><div class="bd">${body}</div></div>`;
  }

  function rhrCard(id) {
    const range = M.trends.state.range;
    const all = M.body.series(id, "rhr", 0);
    let body;
    if (!all.length) {
      body = `<div class="mt-empty">No resting heart rate yet. Log it with your weight. First thing in the morning is best.</div>`;
    } else {
      const latest = all[all.length - 1];
      const week = all.filter(x => M.daysBetween(x.date, latest.date) <= 6);
      const avg = r0(week.reduce((t, x) => t + x.v, 0) / week.length);
      const stats = `<div class="stats">
        ${tile(r0(latest.v), "Latest", "bpm", esc(fmtShort(latest.date)))}
        ${tile(avg, "7-day average", "bpm", week.length + " reading" + (week.length === 1 ? "" : "s"))}
        ${tile(signed(latest.v - avg, 0), "Vs average", "bpm")}
      </div>`;
      const from = chartFrom(all, range);
      const to = range > 0 ? M.today() : all[all.length - 1].date;
      const win = all.filter(x => x.date >= from);
      const chart = win.length
        ? M.charts.line(win, { avg: M.body.avg7(all), from, to, unit: "bpm", label: "Resting heart rate", tone: "mus" })
        : `<div class="mt-empty">Nothing in the last ${range} days. Tap <b>All</b> to see older ones.</div>`;
      body = stats + `<p class="hint mt-goalline">Beats a minute, at rest. Lower usually means fitter.</p>` + chart;
    }
    return `<div class="card mt-card"><div class="hd"><h3>Resting heart rate</h3></div><div class="bd">${body}</div></div>`;
  }

  function weekCard(id) {
    const ws = M.weekSummary(id, 0);
    const t = ws.target || {};
    const today = M.today();
    const vals = ws.daily.map(d => ({ label: dow2(d.date), v: d.cal, empty: !d.logged,
      title: fmtShort(d.date) + (d.logged ? ": " + fmtN(d.cal) + " cal · " + r0(d.p) + " g protein" + (d.date === today ? " so far" : "") : ": not logged") }));
    const none = !ws.logged;
    const stats = `<div class="stats">
      ${tile(ws.logged, "Days logged", "of 7")}
      ${tile(none ? "—" : fmtN(ws.avgCal), "Avg calories", "", "of " + fmtN(t.cal))}
      ${tile(none ? "—" : r0(ws.avgP), "Avg protein", none ? "" : "g", "of " + r0(t.p) + " g")}
    </div>`;
    const chart = M.charts.bars(vals, { target: t.cal, unit: "cal", label: "Calories each day, last 7 days", h: 150 });
    const note = ws.logged ? "" : `<p class="hint">Log a day of food and the bars fill in.</p>`;
    return `<div class="card mt-card"><div class="hd"><h3>Last 7 days</h3><span class="small mut">${esc(fmtShort(ws.start))} to ${esc(fmtShort(ws.end))}</span></div><div class="bd">${stats}${note}${chart}</div></div>`;
  }

  function weeksCard(id) {
    const vals = [];
    let target = null, any = 0;
    for (let i = 7; i >= 0; i--) {
      const ws = M.weekSummary(id, i);
      if (target == null && ws.target) target = ws.target.cal;
      if (ws.logged) any++;
      vals.push({ label: fmtShort(ws.start), v: ws.avgCal, empty: !ws.logged, title: fmtShort(ws.start) + " to " + fmtShort(ws.end) + (ws.logged ? ": " + fmtN(ws.avgCal) + " cal a day (" + ws.logged + " day" + (ws.logged === 1 ? "" : "s") + ")" : ": nothing logged") });
    }
    const chart = M.charts.bars(vals, { target, unit: "cal", label: "Average calories a day, each of the last 8 weeks", h: 150 });
    const note = any ? `<p class="hint">Average calories on the days you logged. One bar per week.</p>` : `<p class="hint">Weeks with no food logged stay empty.</p>`;
    return `<div class="card mt-card"><div class="hd"><h3>Last 8 weeks</h3></div><div class="bd">${note}${chart}</div></div>`;
  }

  /* one range row above both charts (it sets both) */
  function rangeRow() {
    const range = M.trends.state.range;
    const chips = [[30, "30 days"], [90, "90 days"], [0, "All"]].map(([v, l]) => `<button class="${range === v ? "on" : ""}" data-m="t-range" data-v="${v}" aria-pressed="${range === v}">${l}</button>`).join("");
    return `<div class="mt-rangebar"><span class="mt-rl">Charts show</span><div class="seg mt-range" role="group" aria-label="Chart range">${chips}</div></div>`;
  }

  M.ui.views.trends = function () {
    const id = pid();
    if (!id) return `<div class="card"><div class="empty">Pick a person first.</div></div>`;
    const p = person(id);
    return `<button class="btn primary block" data-m="t-log-body">Log weight or heart rate</button>`
      + rangeRow() + weightCard(id, p) + rhrCard(id) + weekCard(id) + weeksCard(id)
      + `<p class="mt-sr" id="mt-chart-live" aria-live="polite"></p>`;
  };

  /* ---------------------------------------------------- log body sheet */
  let bodyShow = 10;
  /* weight and heart rate are separate items: each one can be deleted on its own */
  function bodyItems(id) {
    const out = [];
    M.body.list(id).slice().reverse().forEach(b => {
      if (isNum(b.w)) out.push({ date: b.date, f: "w", v: b.w });
      if (isNum(b.rhr)) out.push({ date: b.date, f: "rhr", v: b.rhr });
    });
    return out;
  }
  function bodyListHTML(id, u) {
    const all = bodyItems(id);
    if (!all.length) return `<div class="mt-empty">Nothing logged yet.</div>`;
    const rows = all.slice(0, bodyShow).map(b => {
      const what = b.f === "w" ? "Weight" : "Heart rate";
      const val = b.f === "w" ? fmtW(b.v, u) : r0(b.v) + " bpm";
      return `<div class="mt-brow"><span class="d">${esc(fmtShort(b.date))}</span><span class="k">${what}</span><span class="v num">${esc(val)}</span><button class="icon mt-x" data-m="t-del-body" data-date="${esc(b.date)}" data-f="${b.f}" aria-label="Delete ${what.toLowerCase()} ${esc(val)}, ${esc(fmtShort(b.date))}">×</button></div>`;
    }).join("");
    const more = all.length > bodyShow ? `<button class="btn ghost block mt-older" data-m="t-body-more">Show older (${all.length - bodyShow})</button>` : "";
    return rows + more;
  }
  function bodySheetHTML(id, p) {
    const u = units(p);
    const lw = M.body.latest(id, "w"), lr = M.body.latest(id, "rhr");
    const today = M.today();
    const last = lw ? `<p class="hint mt-last">Last weigh-in: ${esc(fmtW(lw.value, u))}, ${esc(fmtShort(lw.date))}.</p>` : "";
    return `<div class="mt-form">
      <div class="entry">
        <div><label class="lbl" for="mt-w">Weight (${wUnit(u)})</label><input class="mini" id="mt-w" type="number" step="0.1" min="0" inputmode="decimal" enterkeyhint="done" placeholder="${lw ? toDispW(lw.value, u) : "e.g. " + (u === "metric" ? "80.5" : "180.5")}"></div>
        <div><label class="lbl" for="mt-rhr">Resting heart rate</label><input class="mini" id="mt-rhr" type="number" min="0" inputmode="numeric" enterkeyhint="done" placeholder="${lr ? r0(lr.value) : "e.g. 60"}"></div>
      </div>
      ${last}
      <div class="mt-daterow"><label class="lbl" for="mt-date">Date</label><input class="mini mt-date" id="mt-date" type="date" value="${today}" max="${today}"></div>
      <p class="mt-msg" id="mt-body-msg" role="status" hidden></p>
      <button class="btn primary block mt-savebtn" data-m="t-save-body">Save</button>
      <p class="hint">Weigh in first thing in the morning, before you eat. The same time each day keeps the line true. Heart rate is in beats a minute.</p>
      <h2 class="sec">Recent</h2>
      <div class="mt-list" id="mt-body-list">${bodyListHTML(id, u)}</div>
    </div>`;
  }
  /* The profile weight follows the latest weigh-in that is left, and the targets follow it
     (F1's M.body.remove does this too once it lands; doing it again changes nothing). */
  function followLatest(id, weighed) {
    const p = person(id), lw = M.body.latest(id, "w");
    let moved = !!weighed;
    if (lw && isNum(lw.value) && p.weightLb !== lw.value) { p.weightLb = lw.value; touchP(p); moved = true; }
    if (moved && !p.targetsManual) { M.calc.applyTargets(p); return; }
    M.save();
  }
  /* Delete one value of a day (its weight or its heart rate), keeping the other. */
  function removeBody(id, date, f) {
    const rec = M.body.list(id).find(b => b.date === date);
    if (!rec) return false;
    const other = f === "rhr" ? "w" : "rhr";
    const keep = isNum(rec[other]) ? rec[other] : null;
    const p = person(id), lastBody = p.lastBody;
    if (!M.body.remove(date, id)) return false;
    if (keep != null) { const r = { date, pid: id }; r[other] = keep; M.body.add(r); p.lastBody = lastBody; }
    followLatest(id);
    return true;
  }
  M.trends.removeBody = removeBody;

  /* ============================================================ numbers UI */
  const ACT_WORDS = { sedentary: "Desk job, little exercise", light: "Light exercise 1 to 3 days a week", moderate: "Exercise 3 to 5 days a week", active: "Hard training 6 to 7 days a week", very: "Athlete or a physical job" };
  const actLabel = k => ACT_WORDS[k] || (M.calc.ACT_LABEL && M.calc.ACT_LABEL[k]) || k;
  /* A hint when the goal and the pace point different ways. */
  function paceHint(p) {
    const w = num(p.weightLb), g = num(p.goalWeightLb), pace = num(p.pace);
    if (!(w > 0 && g > 0)) return "";
    if (g < w - 1 && pace >= 0) return "Your goal is below your weight. Pick a Lose pace to get there.";
    if (g > w + 1 && pace <= 0) return "Your goal is above your weight. Pick a Gain pace to get there.";
    return "";
  }
  /* Shared field block for "Your numbers" (mode "you") and the setup card (mode "setup").
     `p` is a Profile in "you" mode, the draft object in "setup" mode. */
  function numbersFieldsHTML(p, mode) {
    const u = units(p);
    const IN = mode === "setup" ? "t-setup" : "t-num";
    const segAttr = f => (mode === "setup" ? `data-m="t-setup-seg" data-f="${f}"` : `data-m="t-${f}"`);
    const pressed = on => `class="${on ? "on" : ""}" aria-pressed="${on}"`;
    const { ft, inch } = ftIn(p.heightIn);
    const cm = isNum(p.heightIn) ? r0(M.units.in2cm(p.heightIn)) : "";
    const box = (f, attrs, value, ph, label) => `<input class="mini" type="number" ${attrs} data-m="${IN}" data-f="${f}" value="${value}" placeholder="${ph}" aria-label="${label}">`;
    const height = u === "metric"
      ? box("hcm", 'inputmode="numeric" min="50" max="260"', cm, "e.g. 178", "Height in centimeters") + `<span class="mt-u">cm</span>`
      : box("hft", 'inputmode="numeric" min="1" max="8"', ft, "e.g. 5", "Height, feet") + `<span class="mt-u">ft</span>` + box("hin", 'inputmode="numeric" min="0" max="11"', inch, "e.g. 10", "Height, inches") + `<span class="mt-u">in</span>`;
    const actOpts = Object.keys(M.calc.ACT).map(k => `<option value="${k}" ${p.activity === k ? "selected" : ""}>${esc(actLabel(k))}</option>`).join("");
    const paceOpts = M.calc.PACES.map(v => `<option value="${v}" ${num(p.pace) === v ? "selected" : ""}>${esc(paceLabel(v, u))}</option>`).join("");
    const hint = paceHint(p);
    return `<div class="srow"><div class="l">Units</div><div class="seg" role="group" aria-label="Units"><button ${pressed(u === "us")} ${segAttr("units")} data-v="us">lb · ft</button><button ${pressed(u === "metric")} ${segAttr("units")} data-v="metric">kg · cm</button></div></div>
      <div class="srow" data-row="sex"><div class="l">Sex</div><div class="seg" role="group" aria-label="Sex"><button ${pressed(p.sex === "m")} ${segAttr("sex")} data-v="m">Male</button><button ${pressed(p.sex === "f")} ${segAttr("sex")} data-v="f">Female</button></div></div>
      <div class="srow" data-row="age"><div class="l">Age</div><div class="mt-ctl">${box("age", 'inputmode="numeric" min="5" max="120"', isNum(p.age) ? p.age : "", "e.g. 35", "Age in years")}<span class="mt-u">years</span></div></div>
      <div class="srow" data-row="height"><div class="l">Height</div><div class="mt-ctl mt-hgt">${height}</div></div>
      <div class="srow" data-row="weight"><div><div class="l">Weight</div><div class="s">${mode === "setup" ? "Today's weight" : "Changing it logs today's weigh-in"}</div></div><div class="mt-ctl">${box("weight", 'step="0.1" min="0" inputmode="decimal"', toDispW(p.weightLb, u), u === "metric" ? "e.g. 80" : "e.g. 180", "Weight in " + (u === "metric" ? "kilograms" : "pounds"))}<span class="mt-u">${wUnit(u)}</span></div></div>
      ${mode === "setup" ? "" : `<p class="mt-msg mt-wmsg" id="mt-wmsg" role="status" hidden></p>`}
      <div class="srow"><div class="l">Goal weight</div><div class="mt-ctl">${box("goal", 'step="0.1" min="0" inputmode="decimal"', toDispW(p.goalWeightLb, u), u === "metric" ? "e.g. 75" : "e.g. 170", "Goal weight in " + (u === "metric" ? "kilograms" : "pounds"))}<span class="mt-u">${wUnit(u)}</span></div></div>
      <div class="mt-field"><label class="l" for="mt-act-${mode}">Activity</label><select class="sel" id="mt-act-${mode}" data-m="${IN}" data-f="activity">${actOpts}</select></div>
      <div class="mt-field"><label class="l" for="mt-pace-${mode}">Pace</label><select class="sel" id="mt-pace-${mode}" data-m="${IN}" data-f="pace">${paceOpts}</select><p class="hint mt-pacehint" id="mt-pacehint-${mode}"${hint ? "" : " hidden"}>${esc(hint)}</p></div>`;
  }
  M.ui.calculatorHTML = function (profile) { return numbersFieldsHTML(profile || person(), "you"); };

  /* Write one field from an input element into a profile / draft. Returns true when it changed something.
     The draft (setup, live) clears a value whose box is empty or not a number, so Save never keeps an old one. */
  function applyField(p, f, el, live) {
    const u = units(p), v = el ? el.value : "";
    switch (f) {
      case "age": { const n = r0(num(v)); p.age = n > 0 ? clamp(n, 5, 120) : null; return true; }
      case "hft": case "hin": {
        const box = el && el.closest ? el.closest(".mt-hgt") : null;
        const g = k => { const i = box ? box.querySelector('[data-f="' + k + '"]') : null; return i ? num(i.value) : (f === k ? num(v) : 0); };
        const h = g("hft") * 12 + g("hin");
        p.heightIn = h > 0 ? r1(h) : null; return true;
      }
      case "hcm": { const c = num(v); p.heightIn = c > 0 ? r1(M.units.cm2in(c)) : null; return true; }
      case "weight": {
        const lb = M.units.parseW(v, u);
        if (live) { p.weightLb = lb || null; return true; }
        if (!lb) return false;
        M.body.add({ date: M.today(), w: lb, pid: p.id }); p.weightLb = lb; return true;
      }
      case "goal": { const lb = M.units.parseW(v, u); p.goalWeightLb = lb || null; return true; }
      case "activity": if (M.calc.ACT[v]) { p.activity = v; return true; } return false;
      case "pace": { const n = num(v, 0); p.pace = M.calc.PACES.indexOf(n) >= 0 ? n : 0; return true; }
    }
    return false;
  }
  /* Put the cleaned-up values back in the boxes. Never the one being typed in, and never fill a
     box the person left empty (typing "11" into an inches box that suddenly holds "0" gives "110"). */
  function writeBack(root, dm, p, changed) {
    if (!root) return;
    const d = doc(), u = units(p), h = ftIn(p.heightIn);
    const set = (f, v) => {
      const i = root.querySelector('input[data-m="' + dm + '"][data-f="' + f + '"]');
      if (!i || (d && i === d.activeElement) || (i.value === "" && i !== changed)) return;
      if (String(i.value) !== String(v)) i.value = v;
    };
    set("age", isNum(p.age) ? p.age : "");
    if (u === "metric") set("hcm", isNum(p.heightIn) ? r0(M.units.in2cm(p.heightIn)) : "");
    else { set("hft", h.ft); set("hin", h.inch); }
    set("weight", toDispW(p.weightLb, u));
    set("goal", toDispW(p.goalWeightLb, u));
  }
  function showPaceHint(root, p, mode) {
    const el = root && root.querySelector ? root.querySelector("#mt-pacehint-" + mode) : $("mt-pacehint-" + mode);
    if (!el) return;
    const h = paceHint(p);
    el.textContent = h; el.hidden = !h;
  }

  /* ==================================================================== you */
  function targetsCard(p) {
    const cur = p.split || "highprotein";
    const manual = !!p.targetsManual;
    const opts = Object.keys(M.calc.SPLITS).map(k => {
      const sp = M.calc.SPLITS[k];
      return `<button class="opt mt-opt ${cur === k ? "cur" : ""}" data-m="t-split" data-v="${k}" aria-pressed="${cur === k}"><span><b>${esc(sp.label)}</b><span class="small mut">${esc(sp.desc)}</span></span><span class="m" aria-hidden="true">${cur === k ? "✓" : ""}</span></button>`;
    }).join("");
    let custom = "";
    if (cur === "custom" && !manual) {
      const c = p.custom || { p: 30, c: 40, f: 30 };
      const sum = r0(num(c.p) + num(c.c) + num(c.f));
      custom = `<div class="mt-custom">
        ${["p", "c", "f"].map(k => { const nm = k === "p" ? "Protein" : k === "c" ? "Carbs" : "Fat"; return `<div><span class="lbl">${nm} %</span><input class="mini" type="number" inputmode="numeric" min="0" max="100" data-m="t-custom" data-f="${k}" value="${r0(num(c[k]))}" aria-label="${nm} percent"></div>`; }).join("")}
      </div>
      <div class="mt-sumrow"><span class="small ${sum === 100 ? "mut" : "mt-warn"}" id="mt-csum" role="status">${sumText(sum)}</span><button class="btn" id="mt-capply" data-m="t-custom-apply" ${sum === 100 ? "" : "disabled"}>Apply</button></div>`;
    }
    const splits = manual
      ? `<p class="hint mt-mhint">Turn off <b>Type my own targets</b> to pick a split again.</p>`
      : `<div class="mt-opts">${opts}</div>${custom}`;
    return `<div class="card mt-card"><div class="hd"><h3>Macro targets</h3></div>
      ${splits}
      <div class="mt-tbox" id="mt-tbox">${targetsBoxHTML(p)}</div>
      <div class="srow mt-manrow"><div><div class="l" id="mt-man-l">Type my own targets</div><div class="s">Turn off to go back to the calculator.</div></div><button class="toggle ${manual ? "on" : ""}" data-m="t-manual" role="switch" aria-checked="${manual}" aria-labelledby="mt-man-l"><i></i></button></div>
    </div>`;
  }
  const sumText = sum => (sum === 100 ? "Adds up to 100%" : "Adds up to " + sum + "%. It must be 100%.");
  /* The line under the hand-typed targets: says when protein, carbs and fat don't match the calories. */
  function manualNote(t, u) {
    const mc = r0(num(t.p) * 4 + num(t.c) * 4 + num(t.f) * 9), cal = num(t.cal);
    const off = cal > 0 && Math.abs(mc - cal) / cal > 0.05;
    const water = "Water is in oz" + (u === "metric" ? " (" + fmtN(t.water) + " oz is about " + fmtN(M.units.oz2ml(num(t.water))) + " ml)" : "") + ".";
    return `<p class="hint${off ? " mt-warn" : ""}" id="mt-tnote" role="status">${off ? "Protein, carbs and fat add up to " + fmtN(mc) + " cal. Your calorie target is " + fmtN(cal) + ". " : "You're typing these yourself. "}${water}</p>`;
  }
  /* The targets grid + the line under it: everything a change in "Your numbers" can move. */
  function targetsBoxHTML(p) {
    const t = p.targets || {};
    const complete = M.calc.complete(p);
    const manual = !!p.targetsManual;
    const u = units(p);
    const cell = (k, label, unit) => `<div class="stat"><div class="v num">${manual ? `<input class="mini" type="number" inputmode="numeric" min="0" data-m="t-target" data-f="${k}" value="${r0(num(t[k]))}" aria-label="${label} target in ${unit === "g" ? "grams" : unit}">` : fmtN(t[k])}${manual ? "" : `<small>${unit}</small>`}</div><div class="k">${label + (manual ? " " + unit : "")}</div></div>`;
    const grid = `<div class="stats mt-tgrid">${cell("cal", "Calories", "cal")}${cell("p", "Protein", "g")}${cell("c", "Carbs", "g")}${cell("f", "Fat", "g")}${cell("fiber", "Fiber", "g")}${cell("water", "Water", "oz")}</div>`;
    let note = "";
    if (manual) note = manualNote(t, u);
    else if (!complete) note = `<p class="hint">Fill in sex, age, height and weight above and these update on their own.</p>`;
    else { const c = M.calc.calories(p); note = `<p class="hint">Worked out from your numbers${c.floored ? ". Held at the " + fmtN(c.cal) + " calorie minimum" : ""}. Changes above update these.</p>`; }
    return grid + note;
  }

  function ciNumHTML(p) {
    const sn = num(p.snooze && p.snooze.refresh60);
    if (!p.setupAt) return "Not set yet.";
    const age = Math.floor((now() - num(p.setupAt)) / DAY);
    const when = age <= 0 ? "Set today." : "Set " + esc(fmtTs(p.setupAt)) + " (" + age + " day" + (age === 1 ? "" : "s") + " ago).";
    const next = sn > now() ? " Skipped until " + esc(fmtTs(sn)) + "." : age >= 60 ? ' <span class="tag warn">Time to check</span>' : " We'll ask again in " + (60 - age) + " day" + (60 - age === 1 ? "" : "s") + ".";
    return when + next;
  }
  function ciBodyHTML(id, p) {
    const t = now();
    const lastBody = Math.max(num(p.lastBody), num(p.setupAt));
    const lw = M.body.latest(id, "w");
    const sn = num(p.snooze && p.snooze.body14);
    if (!lastBody && !lw) return "No weigh-in yet. Every 2 weeks.";
    const due = lastBody + 14 * DAY;
    const next = sn > t ? "skipped until " + esc(fmtTs(sn)) : due <= t ? '<span class="tag warn">due now</span>' : "next " + esc(fmtTs(due));
    return (lw ? "Last weigh-in " + esc(fmtShort(lw.date)) : "Last check-in " + esc(fmtTs(lastBody))) + " · " + next + ". Every 2 weeks.";
  }
  function checkinsCard(id, p) {
    return `<div class="card mt-card"><div class="hd"><h3>Check-ins</h3></div>
      <div class="srow"><div><div class="l">Your numbers</div><div class="s" id="mt-ci-num">${ciNumHTML(p)}</div></div><button class="btn mt-nowrap" data-m="t-reviewed">Still right</button></div>
      <div class="srow"><div><div class="l">Weight and heart rate</div><div class="s" id="mt-ci-body">${ciBodyHTML(id, p)}</div></div><button class="btn mt-nowrap" data-m="t-log-body">Log now</button></div>
    </div>`;
  }

  /* after a failed Test: {ok:false, msg}; cleared when the key changes */
  let aiState = null;
  function aiStatus() {
    const ai = M.ai || null;
    const mode = ai && typeof ai.mode === "function" ? ai.mode() : null;
    const hasKey = !!(ai && typeof ai.getKey === "function" && ai.getKey());
    if (mode === "sample") return { cls: "ok", text: "Claude is ready. You're inside claude.ai.", hasKey };
    if (hasKey && aiState && aiState.ok === false) return { cls: "warn", text: "Key saved, but it didn't work. " + aiState.msg, hasKey };
    if (hasKey || mode === "key") return { cls: "ok", text: "Key saved on this phone.", hasKey: true };
    return { cls: "", text: "Scan label, Describe and meal ideas work without a key. Add a key to log food from a photo and get smarter answers.", hasKey };
  }
  function aiCard(p) {
    const st = aiStatus();
    const models = [["claude-sonnet-5-5", "Claude Sonnet 5.5 (default)"], ["claude-haiku-4-5-20251001", "Claude Haiku 4.5 (cheaper)"]];
    const cur = p.aiModel || "claude-sonnet-5-5";
    return `<div class="card mt-card"><div class="hd"><h3>AI (Claude)</h3></div><div class="bd">
      <div class="mt-status ${st.cls}" id="mt-ai-status"><i aria-hidden="true"></i><span>${esc(st.text)}</span></div>
      <div class="mt-key"><input type="password" id="mt-key" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Anthropic API key" placeholder="${st.hasKey ? "Paste a new key" : "Paste key"}"><button class="btn" data-m="t-ai-save">Save</button>${st.hasKey ? `<button class="btn danger" data-m="t-ai-remove">Remove</button>` : ""}</div>
      <p class="hint mt-keyhint">Get a key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>. Your key stays on this phone.</p>
      <div class="mt-field mt-field-flat"><label class="l" for="mt-ai-model">Model</label><select class="sel" id="mt-ai-model" data-m="t-ai-model">${models.map(([v, l]) => `<option value="${v}" ${cur === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="mt-row mt-testrow"><button class="btn" data-m="t-ai-test">Test</button><span class="small mut" id="mt-ai-msg" role="status"></span></div>
    </div></div>`;
  }
  function patchAi() {
    const box = $("mt-ai-status"); if (!box) return;
    const st = aiStatus();
    box.className = "mt-status " + st.cls;
    const sp = box.querySelector("span"); if (sp) sp.textContent = st.text;
  }
  /* Claude's error, without "in You → AI" (this is You → AI). */
  function aiErr(e) {
    const m = String((e && e.message) || "Couldn't reach Claude.");
    return m.replace(/\s*(Check it|Pick another model) in You → AI\.?/g, "").replace(/\s+in You → AI/g, "").trim() || "Couldn't reach Claude.";
  }

  /* ------------------------------------------------------ sync & backup */
  /* M.cloud comes from m-sync.js (loaded after this file), so always look it up lazily. */
  const cloud = () => (M.cloud && typeof M.cloud.status === "function" && typeof M.cloud.configured === "function" ? M.cloud : null);
  function agoText(ts) {
    const d = now() - num(ts);
    if (d < 45e3) return "just now";
    if (d < 90e3) return "1 min ago";
    if (d < 3600e3) return Math.round(d / 60e3) + " min ago";
    if (d < 86400e3) return Math.round(d / 3600e3) + " hr ago";
    return "on " + fmtTs(ts);
  }
  function syncLine(s) {
    if (s.busy) return { cls: "", text: "Syncing…" };
    if (s.lastError) return { cls: "warn", text: s.lastError + (s.pending > 0 ? " " + s.pending + " change" + (s.pending === 1 ? "" : "s") + " waiting." : "") };
    if (s.lastSync > 0) return { cls: "ok", text: "Synced " + agoText(s.lastSync) };
    return { cls: "", text: "Not synced yet" };
  }
  /* A code from anything pasted: "Here it is: ABCD-EFGH-JKLM-NPQR-STUV" → "ABCDEFGHJKLMNPQRSTUV".
     Codes use A–Z and 2–9 but never I, O, 0 or 1. */
  const CODE_CH = "[A-HJ-NP-Z2-9]";
  function pickCode(text) {
    const s = String(text == null ? "" : text).toUpperCase();
    const clean = (m, i) => !/[A-Z0-9]/.test(i > 0 ? s[i - 1] : "") && !/[A-Z0-9]/.test(s[i + m.length] || "");
    const tight = new RegExp(CODE_CH + "{4}(?:[-–—]?" + CODE_CH + "{4}){4}", "g");
    let m;
    while ((m = tight.exec(s))) { if (clean(m[0], m.index)) return m[0].replace(/[^A-Z0-9]/g, ""); tight.lastIndex = m.index + 1; }
    const loose = new RegExp(CODE_CH + "{4}(?:[-–—.\\s]{1,3}" + CODE_CH + "{4}){4}", "g");
    let last = null;
    while ((m = loose.exec(s))) { if (clean(m[0], m.index)) last = m[0]; loose.lastIndex = m.index + 1; }
    if (last) return last.replace(/[^A-Z0-9]/g, "");
    return s.replace(/[^A-Z0-9]/g, "");
  }
  M.trends.pickCode = pickCode;
  /* Only when there is something to get back: a copy from another phone, with workouts in it.
     This phone's own backup (or one identical to it) needs no button. */
  function restoreHTML() {
    const C = cloud();
    const tr = C && typeof C.training === "function" ? C.training() : null;
    if (!tr || tr.mine || tr.same || !(tr.n > 0)) return "";
    const n = tr.n + " workout" + (tr.n === 1 ? "" : "s");
    const lead = tr.missing > 0
      ? `<b>${tr.missing} workout${tr.missing === 1 ? "" : "s"}</b> in the cloud ${tr.missing === 1 ? "isn't" : "aren't"} on this phone.`
      : `Training backup: ${esc(n)}${tr.t ? ", saved " + esc(fmtTs(tr.t)) : ""}.`;
    return `<div class="mt-restore" id="mt-restore">
      <p class="mt-text">${lead}</p>
      <button class="btn block" data-m="t-sync-restore"${tr.busy ? " disabled" : ""}>Restore training backup</button>
      <p class="hint">${tr.busy ? "Finish today's workout first. " : ""}This replaces the training history on this phone with the backup (${esc(n)}).</p>
    </div>`;
  }
  let trainCheckAt = 0, justOn = false;
  function syncCardHTML() {
    const head = `<div class="hd"><h3>Sync &amp; backup</h3></div>`;
    const C = cloud();
    if (!C || !C.configured()) return `<div class="card mt-card mt-sync" id="mt-sync">${head}<div class="bd"><p class="mt-text mt-quiet">Cloud sync isn't set up yet.</p></div></div>`;
    const s = C.status();
    if (!s.on) {
      justOn = false;
      return `<div class="card mt-card mt-sync" id="mt-sync">${head}<div class="bd">
        <p class="mt-text">Share foods and meals between your phones and keep a backup.</p>
        <div class="mt-syncbtns"><button class="btn primary block" data-m="t-sync-on">First phone: start sync</button><button class="btn block" data-m="t-sync-joinshow">Other phone: join with code</button></div>
        <div class="mt-join" id="mt-join" hidden>
          <p class="hint">Type or paste the code from the first phone. Codes never use the letters I or O, or the numbers 0 or 1.</p>
          <div class="mt-joinrow"><input id="mt-join-code" type="text" inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" placeholder="20 letters and numbers" aria-label="Code from the first phone"><button class="btn primary" data-m="t-sync-join">Join</button></div>
          <p class="small mt-warn" id="mt-join-msg" role="status" hidden></p>
        </div>
      </div></div>`;
    }
    /* now and then, ask the cloud whether this person has a training backup */
    if (now() - trainCheckAt > 60e3 && typeof C.hasTrainingBackup === "function") {
      trainCheckAt = now();
      setTimeout(() => { try { Promise.resolve(C.hasTrainingBackup()).then(patchSync, () => {}); } catch (e) {} }, 0);
    }
    const line = syncLine(s);
    const next = justOn ? `<p class="mt-next"><b>Next:</b> on the other phone, open Macros → You and tap <b>Other phone: join with code</b>. Then type this code.</p>` : "";
    return `<div class="card mt-card mt-sync" id="mt-sync">${head}<div class="bd">
      <div class="mt-code" id="mt-code">${esc(C.fmtCode(s.code))}</div>
      ${next}
      <div class="mt-coderow"><p class="hint">Type this code on the other phone. Keep a copy in Notes: a new phone needs it to get your data back.</p><button class="btn" data-m="t-sync-copy">Copy</button></div>
      <div class="mt-syncrow"><div class="mt-status ${line.cls}" id="mt-sync-status" role="status"><i aria-hidden="true"></i><span>${esc(line.text)}</span></div><button class="btn" data-m="t-sync-now">Sync now</button></div>
      <p class="hint">Foods and saved meals are shared. Food logs, weight and training are backed up.</p>
      ${restoreHTML()}
      <button class="btn block ghost danger mt-off" data-m="t-sync-off">Turn off sync</button>
    </div></div>`;
  }
  /* Refresh the status line and the restore part in place (no full re-render: nobody loses their keyboard). */
  function patchSync() {
    const C = cloud(), box = $("mt-sync");
    if (!C || !box) return;
    const s = C.status();
    const st = $("mt-sync-status");
    if (st) {
      const line = syncLine(s);
      st.className = "mt-status " + line.cls;
      const span = st.querySelector("span"); if (span) span.textContent = line.text;
    }
    if (!s.on) return;
    const cur = $("mt-restore");
    const btn = cur ? cur.querySelector('[data-m="t-sync-restore"]') : null;
    if (btn && (btn.dataset.arm === "1" || btn.dataset.busy === "1")) return;   /* mid two-tap / restoring */
    const html = restoreHTML();
    if (cur && !html) cur.remove();
    else if (cur) cur.outerHTML = html;
    else if (html) { const off = box.querySelector(".mt-off"); if (off) off.insertAdjacentHTML("beforebegin", html); }
  }
  M.trends.syncCardHTML = syncCardHTML;
  M.trends.patchSync = patchSync;
  try { if (typeof window !== "undefined" && window && typeof window.addEventListener === "function") window.addEventListener("chalk-sync", () => { try { patchSync(); } catch (e) {} }); } catch (e) {}
  /* After a training restore the page reloads; m-sync leaves the workout count in a one-time flag. */
  function restoredNote() {
    let n = null;
    try {
      if (typeof localStorage === "undefined") return null;
      const v = localStorage.getItem("chalk.sync.restored");
      if (v == null) return null;
      localStorage.removeItem("chalk.sync.restored");
      n = parseInt(v, 10);
    } catch (e) { return null; }
    const text = n > 0 ? "Training restored: " + n + " workout" + (n === 1 ? "" : "s") : "Training restored";
    setTimeout(() => toast(text), 900);
    return text;
  }
  M.trends.restoredNote = restoredNote;
  try { restoredNote(); } catch (e) {}

  M.ui.views.you = function () {
    const id = pid();
    if (!id) return `<div class="card"><div class="empty">Pick a person first.</div></div>`;
    const p = person(id);
    const numbers = `<div class="card mt-card"><div class="hd"><h3>Your numbers</h3></div>${numbersFieldsHTML(p, "you")}</div>`;
    const busy = trainBusy();
    const who = `<div class="card mt-card"><div class="hd"><h3>Person</h3></div><div class="srow"><div><div class="l">Now: ${esc(p.name || id)}</div><div class="s">${busy ? "Finish your workout first. Then you can switch." : "Switching also changes the workout plan on this phone."}</div></div>${busy ? "" : `<button class="btn" data-a="switch-profile">Switch</button>`}</div></div>`;
    const data = `<div class="card mt-card"><div class="hd"><h3>Data</h3></div><div class="bd"><p class="hint">To save a backup file of everything, go to Train → Settings. It has your food logs too.</p></div></div>`;
    return numbers + targetsCard(p) + checkinsCard(id, p) + aiCard(p) + syncCardHTML() + who + data;
  };

  /* ============================================================== check-ins */
  let setupDraft = null;
  function draft() {
    const id = pid();
    if (setupDraft && setupDraft.pid === id) return setupDraft;
    const p = person(id);
    setupDraft = { pid: id, id, sex: p.sex || null, age: p.age, heightIn: p.heightIn, weightLb: p.weightLb, goalWeightLb: p.goalWeightLb, activity: p.activity || "moderate", pace: num(p.pace, 0), units: units(p), split: p.split || "highprotein" };
    return setupDraft;
  }
  M.trends.draft = draft;
  M.trends.resetDraft = () => { setupDraft = null; };

  function previewHTML(d) {
    if (!M.calc.complete(d)) return `<div class="mt-preview"><span class="small mut">Fill in sex, age, height and weight to see your targets.</span></div>`;
    const t = M.calc.targets(d);
    const c = M.calc.calories(d);
    return `<div class="mt-preview"><div class="mt-pv"><b>${fmtN(t.cal)}</b><span>cal a day</span></div><div class="mt-pv"><b>${t.p}</b><span>protein g</span></div><div class="mt-pv"><b>${t.c}</b><span>carbs g</span></div><div class="mt-pv"><b>${t.f}</b><span>fat g</span></div>${c.floored ? `<span class="small mut mt-pvnote">Held at the ${fmtN(c.cal)} calorie minimum.</span>` : ""}</div>`;
  }

  M.ui.setupCardHTML = function () {
    const id = pid(); if (!id) return "";
    const d = draft();
    const splits = Object.keys(M.calc.SPLITS).filter(k => k !== "custom").map(k => {
      const sp = M.calc.SPLITS[k];
      return `<button class="opt mt-opt ${d.split === k ? "cur" : ""}" data-m="t-setup-split" data-v="${k}" aria-pressed="${d.split === k}"><span><b>${esc(sp.label)}</b><span class="small mut">${esc(sp.desc)}</span></span><span class="m" aria-hidden="true">${d.split === k ? "✓" : ""}</span></button>`;
    }).join("");
    return `<div class="card mt-card mt-setup first" id="mt-setup">
      <div class="hd"><h3>Let's set your targets</h3></div>
      <div class="bd"><p class="hint">Takes 30 seconds. You can change any of it later in <b>You</b>.</p></div>
      ${numbersFieldsHTML(d, "setup")}
      <div class="mt-field"><div class="l">Macro split</div></div>
      <div class="mt-opts">${splits}</div>
      <div class="bd" id="mt-preview" role="status">${previewHTML(d)}</div>
      <div class="bd"><button class="btn primary block" data-m="t-save-setup">Save my targets</button></div>
    </div>`;
  };

  function refresh60HTML() {
    return `<div class="card mt-card mt-banner"><div class="hd"><h3>Still right?</h3></div><div class="bd">
      <p class="mt-text">You set your numbers over 60 days ago. Weight, activity and goal can change.</p>
      <div class="mt-row mt-wrap"><button class="btn primary" data-m="mode" data-v="macros" data-tab="you">Update</button><button class="btn" data-m="t-reviewed">Still right</button><button class="btn ghost" data-m="t-snooze" data-kind="refresh60" data-days="7">Skip for now</button></div>
    </div></div>`;
  }
  function body14HTML(id, p) {
    const u = units(p);
    const lw = M.body.latest(id, "w"), lr = M.body.latest(id, "rhr");
    return `<div class="card mt-card mt-banner"><div class="hd"><h3>Time to weigh in</h3></div><div class="bd">
      <p class="mt-text">It's been 2 weeks. Log your weight and resting heart rate. Either one is fine.</p>
      <div class="mt-b14">
        <div><label class="lbl" for="mt-b14-w">Weight (${wUnit(u)})</label><input class="mini" id="mt-b14-w" type="number" step="0.1" min="0" inputmode="decimal" enterkeyhint="done" placeholder="${lw ? toDispW(lw.value, u) : "e.g. " + (u === "metric" ? "80" : "180")}"></div>
        <div><label class="lbl" for="mt-b14-rhr">Heart rate at rest</label><input class="mini" id="mt-b14-rhr" type="number" min="0" inputmode="numeric" enterkeyhint="done" placeholder="${lr ? r0(lr.value) : "e.g. 60"}"></div>
      </div>
      <p class="mt-msg" id="mt-b14-msg" role="status" hidden></p>
      <div class="mt-row"><button class="btn primary" data-m="t-save-body14">Save</button><button class="btn ghost" data-m="t-snooze" data-kind="body14" data-days="14">Skip</button></div>
    </div></div>`;
  }
  /* Train → Today before first-day setup: a small card that opens Macros. */
  function setupNoteHTML() {
    return `<div class="card mt-card mt-banner mt-setnote"><div class="bd"><p class="mt-text"><b>Set your food targets.</b> It takes 30 seconds.</p><button class="btn primary block" data-m="mode" data-v="macros" data-tab="diary">Set my targets</button></div></div>`;
  }
  M.ui.bannerHTML = function () {
    const id = pid(); if (!id) return "";
    let due = null;
    try { due = M.checkins.due(id); } catch (e) { return ""; }
    if (due === "setup") return inTrain() ? setupNoteHTML() : "";   /* the Diary shows the full setup card */
    if (due === "refresh60") return refresh60HTML();
    if (due === "body14") return body14HTML(id, person(id));
    return "";
  };

  /* ================================================================ actions */
  const A = M.ui.actions, I = M.ui.inputs, C = M.ui.changes;

  /* --- trends --- */
  A["t-range"] = el => { const v = num(el && el.dataset ? el.dataset.v : 90, 90); M.trends.state.range = v === 30 || v === 90 ? v : 0; rerender(); };
  A["t-log-body"] = () => {
    const id = pid(); if (!id) return;
    bodyShow = 10;
    openSheet("Log weight or heart rate", bodySheetHTML(id, person(id)));
    const w = $("mt-w"); if (w) { try { w.focus(); } catch (e) {} }
  };
  A["t-body-more"] = () => {
    const id = pid(); if (!id) return;
    bodyShow += 30;
    const list = $("mt-body-list"); if (list) list.innerHTML = bodyListHTML(id, units(person(id)));
  };
  /* Reads a weight box + a heart-rate box. Out of range → a message; a big jump → a message and a second tap. */
  function readBody(id, u, wEl, rEl, msgId, btn, again) {
    const wRaw = wEl ? String(wEl.value == null ? "" : wEl.value).trim() : "";
    const rRaw = rEl ? String(rEl.value == null ? "" : rEl.value).trim() : "";
    if (!wRaw && !rRaw) return { err: "Type a weight or a heart rate." };
    let w = null, rhr = null;
    if (wRaw) {
      const c = bodyCheck(wRaw, "w", u);
      if (!c.ok) { if (wEl) try { wEl.focus(); } catch (e) {} return { err: c.msg }; }
      w = M.units.parseW(wRaw, u);
    }
    if (rRaw) {
      const c = bodyCheck(rRaw, "rhr", u);
      if (!c.ok) { if (rEl) try { rEl.focus(); } catch (e) {} return { err: c.msg }; }
      rhr = r0(num(rRaw));
    }
    if (w != null) {
      const ref = jumpFrom(id, w);
      const key = String(w);
      if (ref != null && !(btn && btn.dataset && btn.dataset.sure === key)) {
        if (btn && btn.dataset) btn.dataset.sure = key;
        return { err: jumpText(ref, w, u, again), wait: true };
      }
    }
    if (btn && btn.dataset) delete btn.dataset.sure;
    return { w, rhr };
  }
  A["t-save-body"] = el => {
    const id = pid(); if (!id) return;
    const p = person(id), u = units(p);
    const dEl = $("mt-date");
    const r = readBody(id, u, $("mt-w"), $("mt-rhr"), "mt-body-msg", el, "tap Save again");
    if (r.err) { say("mt-body-msg", r.err); return; }
    say("mt-body-msg", "");
    let date = dEl && dEl.value ? dEl.value : M.today();
    if (!keyDate(date) || date > M.today()) date = M.today();
    M.body.add({ date, w: r.w, rhr: r.rhr, pid: id });
    if (r.w != null) followLatest(id, true);
    blurActive();   /* keyboard away with the sheet */
    toast("Saved");
    closeSheet();
    rerender();
  };
  A["t-del-body"] = el => {
    const id = pid(); if (!id || !el) return;
    if (el.dataset.arm !== "1") {
      el.dataset.arm = "1"; el.textContent = "Delete?"; el.classList.add("mt-arm");
      setTimeout(() => { try { if (el.dataset.arm === "1") { delete el.dataset.arm; el.textContent = "×"; el.classList.remove("mt-arm"); } } catch (e) {} }, 3000);
      return;
    }
    removeBody(id, el.dataset.date, el.dataset.f === "rhr" ? "rhr" : "w");
    const list = $("mt-body-list"); if (list) list.innerHTML = bodyListHTML(id, units(person(id)));
    toast("Deleted");
    rerender();
  };

  /* --- you: numbers --- */
  /* Text / number / select changes never re-render the view: on iPhone that would throw away
     the field the person just tapped (and the keyboard with it). Update the profile, put the
     cleaned-up values back in the boxes, and patch only what depends on them. */
  function showNumbers(el, p) {
    const card = el && el.closest ? el.closest(".card") : null;
    if (!card) return;
    writeBack(card, "t-num", p, el);
    showPaceHint(card, p, "you");
  }
  function patchYou(id, p) {
    const box = $("mt-tbox");
    if (box && !p.targetsManual) box.innerHTML = targetsBoxHTML(p);   /* manual mode: the grid holds inputs, and numbers don't move it */
    const a = $("mt-ci-num"); if (a) a.innerHTML = ciNumHTML(p);
    const b = $("mt-ci-body"); if (b) b.innerHTML = ciBodyHTML(id, p);
  }
  /* Everything that follows an edit in You. */
  function edited(id, p) { touchP(p); M.calc.applyTargets(p); numbersChanged(id); setupDraft = null; }
  /* The weight box in You: range check, a second tap for a big jump, then today's weigh-in. */
  function youWeight(el, id, p, lbSure) {
    const u = units(p);
    say("mt-wmsg", "");
    let lb = lbSure;
    if (lb == null) {
      const raw = String(el && el.value != null ? el.value : "").trim();
      if (!raw) return "no";                                   /* a blank box keeps the last weight */
      const c = bodyCheck(raw, "w", u);
      if (!c.ok) { say("mt-wmsg", c.msg); return "no"; }
      lb = M.units.parseW(raw, u);
      if (!lb || lb === p.weightLb) return "no";
      const ref = jumpFrom(id, lb);
      const m = $("mt-wmsg");
      if (ref != null && m) {
        m.innerHTML = esc(jumpText(ref, lb, u, "tap the button")) + ` <button class="btn mt-wsure" data-m="t-wsure" data-lb="${lb}">Save ${esc(fmtW(lb, u))}</button>`;
        m.hidden = false;
        return "wait";
      }
    }
    M.body.add({ date: M.today(), w: lb, pid: id }); p.weightLb = lb;
    return "ok";
  }
  C["t-num"] = el => {
    const id = pid(); if (!id || !el) return;
    const p = person(id), f = el.dataset.f;
    let changed;
    if (f === "weight") {
      const r = youWeight(el, id, p, null);
      if (r === "wait") return;             /* the box keeps what they typed until they confirm */
      changed = r === "ok";
    } else changed = applyField(p, f, el, false);
    if (changed) edited(id, p);
    showNumbers(el, p);
    patchYou(id, p);
  };
  A["t-wsure"] = el => {
    const id = pid(); if (!id || !el) return;
    const p = person(id), lb = num(el.dataset.lb, 0);
    if (!(lb > 0)) return;
    const u = units(p);
    if (!bodyCheck(u === "metric" ? M.units.lb2kg(lb) : lb, "w", u).ok) return;
    if (youWeight(null, id, p, lb) === "ok") edited(id, p);
    say("mt-wmsg", "");
    const d = doc(), inp = d ? d.querySelector('input[data-m="t-num"][data-f="weight"]') : null;
    if (inp) { inp.value = toDispW(p.weightLb, u); showNumbers(inp, p); }
    patchYou(id, p);
    toast("Saved " + fmtW(lb, u));
  };
  A["t-sex"] = el => { const id = pid(); if (!id) return; const p = person(id); const v = el.dataset.v; if (v !== "m" && v !== "f") return; p.sex = v; edited(id, p); rerender(); };
  A["t-units"] = el => { const id = pid(); if (!id) return; const p = person(id); p.units = el.dataset.v === "metric" ? "metric" : "us"; touchP(p); setupDraft = null; M.save(); rerender(); };

  /* --- you: split + targets --- */
  A["t-split"] = el => {
    const id = pid(); if (!id) return;
    const p = person(id), v = el.dataset.v;
    if (!M.calc.SPLITS[v]) return;
    p.split = v; p.targetsManual = false;
    edited(id, p);
    rerender();
  };
  function customSum(el) {
    const d = doc(); const box = el && el.closest ? el.closest(".card") : null;
    const root = box || d;
    if (!root) return null;
    const g = k => { const i = root.querySelector('input[data-m="t-custom"][data-f="' + k + '"]'); return i ? r0(num(i.value)) : 0; };
    const c = { p: g("p"), c: g("c"), f: g("f") };
    const sum = c.p + c.c + c.f;
    const lbl = root.querySelector("#mt-csum"); if (lbl) { lbl.textContent = sumText(sum); lbl.classList.toggle("mt-warn", sum !== 100); lbl.classList.toggle("mut", sum === 100); }
    const btn = root.querySelector("#mt-capply"); if (btn) btn.disabled = sum !== 100;
    return { c, sum };
  }
  I["t-custom"] = el => { customSum(el); };
  C["t-custom"] = el => { customSum(el); };
  A["t-custom-apply"] = el => {
    const id = pid(); if (!id) return;
    const r = customSum(el); if (!r) return;
    if (r.sum !== 100) { toast("Percentages must add up to 100"); return; }
    const p = person(id);
    p.custom = r.c; p.split = "custom"; p.targetsManual = false;
    edited(id, p);
    toast("Targets updated");
    rerender();
  };
  A["t-manual"] = () => {
    const id = pid(); if (!id) return;
    const p = person(id);
    p.targetsManual = !p.targetsManual;
    touchP(p);
    if (!p.targetsManual) M.calc.applyTargets(p); else M.save();
    numbersChanged(id);
    rerender();
  };
  C["t-target"] = el => {
    const id = pid(); if (!id || !el) return;
    const p = person(id), f = el.dataset.f;
    if (["cal", "p", "c", "f", "fiber", "water"].indexOf(f) < 0) return;
    p.targets[f] = Math.max(0, r0(num(el.value)));
    p.targetsManual = true;
    touchP(p);
    M.save();
    numbersChanged(id);
    const note = $("mt-tnote"); if (note) note.outerHTML = manualNote(p.targets, units(p));
  };

  /* --- you: check-ins --- */
  A["t-reviewed"] = () => {
    const id = pid(); if (!id) return;
    const p = person(id);
    if (!M.calc.complete(p)) { toast("Fill in your numbers first"); return; }
    touchP(p);
    M.checkins.done(id, "refresh60");
    toast("Got it. We'll ask again in 60 days.");
    rerender();
  };
  A["t-snooze"] = el => {
    const id = pid(); if (!id) return;
    const kind = el.dataset.kind === "body14" ? "body14" : "refresh60";
    const days = num(el.dataset.days, kind === "body14" ? 14 : 7);
    touchP(person(id));
    M.checkins.snooze(id, kind, days);
    toast(days === 7 ? "OK. We'll ask again in a week." : days === 14 ? "OK. We'll ask again in 2 weeks." : "OK. We'll ask again later.");
    rerender();
  };
  A["t-save-body14"] = el => {
    const id = pid(); if (!id) return;
    const p = person(id), u = units(p);
    const r = readBody(id, u, $("mt-b14-w"), $("mt-b14-rhr"), "mt-b14-msg", el, "tap Save again");
    if (r.err) { say("mt-b14-msg", r.err === "Type a weight or a heart rate." ? "Type a weight or a heart rate, or tap Skip." : r.err); return; }
    say("mt-b14-msg", "");
    M.body.add({ date: M.today(), w: r.w, rhr: r.rhr, pid: id });
    M.checkins.done(id, "body14");
    if (r.w != null) followLatest(id, true);
    blurActive();
    toast("Saved");
    rerender();
  };

  /* --- you: AI --- */
  A["t-ai-save"] = () => {
    if (!M.ai) { toast("AI isn't loaded"); return; }
    const el = $("mt-key"); const k = el ? String(el.value || "").trim() : "";
    if (!k) { toast("Paste your key first"); return; }
    M.ai.setKey(k);
    aiState = null;
    toast("Key saved on this phone");
    rerender();
  };
  A["t-ai-remove"] = () => { if (!M.ai) return; M.ai.setKey(""); aiState = null; toast("Key removed"); rerender(); };
  C["t-ai-model"] = el => { const id = pid(); if (!id || !el) return; const p = person(id); p.aiModel = el.value || "claude-sonnet-5-5"; touchP(p); M.save(); };
  A["t-ai-test"] = el => {
    if (!M.ai || typeof M.ai.json !== "function") { toast("AI isn't loaded"); return; }
    const msg = $("mt-ai-msg");
    if (msg) msg.textContent = "Asking Claude…";
    if (el) { el.disabled = true; el.textContent = "Testing…"; }
    const done = () => { if (el) { el.disabled = false; el.textContent = "Test"; } patchAi(); };
    let pr;
    try { pr = typeof M.ai.test === "function" ? M.ai.test() : M.ai.json('Reply with {"ok":true}'); } catch (e) { pr = Promise.reject(e); }
    return Promise.resolve(pr).then(v => {
      const ok = v === true || (v && v.ok === true);
      aiState = ok ? { ok: true } : { ok: false, msg: "Claude answered in an odd way." };
      if (msg) msg.textContent = ok ? "Claude answered. You're set." : "Claude replied, but not as expected.";
      toast(ok ? "Claude works" : "Odd reply from Claude");
      done();
    }, e => {
      const text = aiErr(e);
      aiState = { ok: false, msg: text };
      if (msg) msg.textContent = text;
      toast("Claude test failed");
      done();
    });
  };

  /* --- you: sync & backup --- */
  /* Two taps for anything that can't be undone: the first tap only arms the button. */
  function armTap(el, label) {
    if (!el || !el.dataset) return true;
    if (el.dataset.arm === "1") { clearTimeout(el._mtArm); delete el.dataset.arm; el.classList.remove("mt-armed"); return true; }
    const old = el.textContent;
    el.dataset.arm = "1"; el.textContent = label; el.classList.add("mt-armed");
    el._mtArm = setTimeout(() => { try { if (el.dataset.arm === "1") { delete el.dataset.arm; el.textContent = old; el.classList.remove("mt-armed"); } } catch (e) {} }, 4000);
    return false;
  }
  function joinMsg(text) { const m = $("mt-join-msg"); if (!m) return; m.textContent = text || ""; m.hidden = !text; }
  A["t-sync-on"] = () => {
    const Cl = cloud();
    if (!Cl || !Cl.configured()) { toast("Cloud sync isn't set up yet"); return; }
    if (!Cl.create()) { toast("Couldn't turn on sync. Try again."); return; }
    justOn = true;
    toast("Sync is on");
    rerender();
  };
  A["t-sync-joinshow"] = el => {
    const box = $("mt-join"); if (!box) return;
    box.hidden = false;
    if (el && el.dataset) el.hidden = true;
    const inp = $("mt-join-code"); if (inp) { try { inp.focus(); } catch (e) {} }
  };
  A["t-sync-join"] = el => {
    const Cl = cloud(); if (!Cl) return;
    const inp = $("mt-join-code"), v = inp ? String(inp.value || "") : "";
    if (!v.trim()) { joinMsg("Type the code from the first phone."); return; }
    const code = pickCode(v);
    if (inp && /^[A-HJ-NP-Z2-9]{20}$/.test(code) && typeof Cl.fmtCode === "function") inp.value = Cl.fmtCode(code);   /* show what will be used */
    joinMsg("");
    try { if (inp) inp.blur(); } catch (e) {}   /* keyboard away; the card re-renders when the join lands */
    const reset = () => { if (el && el.dataset) { el.disabled = false; el.textContent = "Join"; } };
    if (el && el.dataset) { el.disabled = true; el.textContent = "Joining…"; }
    let pr;
    try { pr = Cl.join(code); } catch (e) { pr = null; }
    return Promise.resolve(pr).then(r => {
      if (r && r.ok) { toast("Joined. Your data is syncing."); rerender(); return; }
      reset(); joinMsg((r && r.error) || "That didn't work. Try again.");
    }, () => { reset(); joinMsg("That didn't work. Try again."); });
  };
  A["t-sync-copy"] = () => {
    const Cl = cloud(); if (!Cl) return;
    const code = Cl.fmtCode(Cl.status().code); if (!code) return;
    const fallback = () => {
      try {
        const d = doc(), n = $("mt-code");
        if (d && n && d.createRange && typeof window.getSelection === "function") { const r = d.createRange(); r.selectNodeContents(n); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); }
      } catch (e) {}
      toast("Press and hold the code to copy it");
    };
    try {
      const nav = typeof navigator !== "undefined" ? navigator : null;
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") return Promise.resolve(nav.clipboard.writeText(code)).then(() => toast("Code copied"), fallback);
    } catch (e) {}
    fallback();
  };
  A["t-sync-now"] = el => {
    const Cl = cloud(); if (!Cl || !Cl.status().on) return;
    const reset = () => { if (el && el.dataset) { el.disabled = false; el.textContent = "Sync now"; } };
    if (el && el.dataset) { el.disabled = true; el.textContent = "Syncing…"; }
    let pr;
    try { pr = Cl.syncNow(); } catch (e) { pr = null; }
    return Promise.resolve(pr).then(r => { reset(); patchSync(); toast(r && r.ok ? "Synced" : "Couldn't sync"); }, () => { reset(); patchSync(); toast("Couldn't sync"); });
  };
  A["t-sync-restore"] = el => {
    const Cl = cloud(); if (!Cl || !Cl.status().on || typeof Cl.restoreTraining !== "function") return;
    if (!armTap(el, "Tap again to replace")) return;
    const fail = () => {
      if (el && el.dataset) { delete el.dataset.busy; el.disabled = false; el.textContent = "Restore training backup"; }
      toast("Couldn't restore. Try again.");
      patchSync();
    };
    if (el && el.dataset) { el.dataset.busy = "1"; el.disabled = true; el.textContent = "Restoring…"; }
    let pr;
    try { pr = Cl.restoreTraining(); } catch (e) { pr = null; }
    return Promise.resolve(pr).then(ok => { if (ok) toast("Training restored"); else fail(); }, fail);   /* on success the page reloads */
  };
  A["t-sync-off"] = el => {
    const Cl = cloud(); if (!Cl || !Cl.status().on) return;
    if (!armTap(el, "Tap again to turn off")) return;
    Cl.leave();
    justOn = false;
    toast("Sync is off. Your data stays on this phone.");
    rerender();
  };

  /* --- setup card --- */
  /* goal below (above) today's weight with pace "Keep my weight" → preselect lose (gain) ½ lb a week,
     until the person picks a pace themselves */
  function autoPace(d) {
    if (d.paceSet) return;                                   /* the person picked a pace: leave it */
    const w = num(d.weightLb), g = num(d.goalWeightLb);
    const want = w > 0 && g > 0 ? (g < w - 1 ? -0.5 : g > w + 1 ? 0.5 : 0) : 0;
    if (num(d.pace) === want) return;
    if (num(d.pace) !== 0 && !d.paceAuto) return;           /* a pace saved before: leave it */
    d.pace = want; d.paceAuto = true;
    const card = $("mt-setup"), sel = card ? card.querySelector('select[data-f="pace"]') : null;
    if (sel) sel.value = String(want);
  }
  function setupField(el, commit) {
    if (!el) return;
    const d = draft(), f = el.dataset.f;
    applyField(d, f, el, true);
    if (f === "pace") { d.paceSet = true; d.paceAuto = false; }
    else autoPace(d);
    const card = $("mt-setup");
    if (commit && card) writeBack(card, "t-setup", d, el);
    if (card) {
      showPaceHint(card, d, "setup");
      const row = el.closest ? el.closest("[data-row]") : null;
      if (row) row.classList.remove("mt-need");
    }
    const pv = $("mt-preview"); if (pv) pv.innerHTML = previewHTML(d);
  }
  I["t-setup"] = el => setupField(el, false);
  C["t-setup"] = el => setupField(el, true);
  A["t-setup-seg"] = el => {
    const d = draft(), f = el.dataset.f, v = el.dataset.v;
    if (f === "sex" && (v === "m" || v === "f")) d.sex = v;
    else if (f === "units") d.units = v === "metric" ? "metric" : "us";
    else return;
    rerender();
  };
  A["t-setup-split"] = el => { const d = draft(); if (M.calc.SPLITS[el.dataset.v]) d.split = el.dataset.v; rerender(); };
  const listWords = a => (a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);
  A["t-save-setup"] = () => {
    const id = pid(); if (!id) return;
    const d = draft();
    /* read every box again: what is on screen is what gets saved */
    const card = $("mt-setup");
    if (card) Array.prototype.forEach.call(card.querySelectorAll('input[data-m="t-setup"], select[data-m="t-setup"]'), i => applyField(d, i.dataset.f, i, true));
    autoPace(d);
    const u = units(d);
    const missing = [];
    if (d.sex !== "m" && d.sex !== "f") missing.push("sex");
    if (!(num(d.age) >= 5)) missing.push("age");
    if (!(num(d.heightIn) >= 36 && num(d.heightIn) <= 108)) missing.push("height");
    let bad = "";
    if (!(num(d.weightLb) > 0)) missing.push("weight");
    else { const c = bodyCheck(u === "metric" ? r1(M.units.lb2kg(d.weightLb)) : d.weightLb, "w", u); if (!c.ok) { bad = c.msg; missing.push("weight"); } }
    if (missing.length) {
      const text = bad && missing.length === 1 ? bad : "Still need: " + listWords(missing) + "." + (bad ? " " + bad : "");
      toast("Fill in " + listWords(missing));
      const pv = $("mt-preview"); if (pv) pv.innerHTML = `<div class="mt-preview"><span class="small mt-warn">${esc(text)}</span></div>`;
      if (card) {
        Array.prototype.forEach.call(card.querySelectorAll("[data-row]"), r => r.classList.toggle("mt-need", missing.indexOf(r.dataset.row) >= 0));
        const first = card.querySelector('[data-row="' + missing[0] + '"]');
        if (first) {
          try { if (first.scrollIntoView) first.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
          const box = first.querySelector("input");
          if (box) { try { box.focus({ preventScroll: true }); } catch (e) {} }
        }
      }
      return;
    }
    const p = person(id);
    p.sex = d.sex; p.age = r0(num(d.age)); p.heightIn = r1(num(d.heightIn)); p.weightLb = r1(num(d.weightLb));
    p.goalWeightLb = num(d.goalWeightLb) > 0 ? r1(num(d.goalWeightLb)) : null;
    p.activity = M.calc.ACT[d.activity] ? d.activity : "moderate";
    p.pace = M.calc.PACES.indexOf(num(d.pace)) >= 0 ? num(d.pace) : 0;
    p.units = d.units === "metric" ? "metric" : "us";
    p.split = M.calc.SPLITS[d.split] ? d.split : "highprotein";
    p.targetsManual = false;
    touchP(p);
    M.calc.applyTargets(p);
    M.body.add({ date: M.today(), w: p.weightLb, pid: id });
    M.checkins.done(id, "setup");
    setupDraft = null;
    toast("Targets set");
    rerender();
    const sc = $("scroll"); if (sc) sc.scrollTop = 0;
  };
})(window.M);
