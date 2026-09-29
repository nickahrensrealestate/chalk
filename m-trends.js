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
  const signed = (v, dp) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(dp);
  function keyDate(key) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || "")); return m ? new Date(+m[1], +m[2] - 1, +m[3], 12) : null; }
  const fmtShort = key => { const d = keyDate(key); return d ? MON[d.getMonth()] + " " + d.getDate() : String(key || ""); };
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
  const fmtRate = (lbwk, u) => (u === "metric" ? signed(M.units.lb2kg(lbwk), 2) + " kg/wk" : signed(lbwk, 1) + " lb/wk");
  const paceLabel = (p, u) => {
    if (u !== "metric") return M.calc.PACE_LABEL[String(p)] || "Maintain";
    if (!p) return "Maintain";
    return (p < 0 ? "Lose " : "Gain ") + (Math.round(Math.abs(p) * 0.4536 * 100) / 100) + " kg/wk";
  };

  /* ================================================================= charts */
  /* Nice ticks (1 / 2 / 2.5 / 5 × 10^n) inside [lo, hi]. */
  function niceTicks(lo, hi, n) {
    n = n || 3;
    if (!(hi > lo)) hi = lo + 1;
    const raw = (hi - lo) / n;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }
  const fmtTick = v => (Math.abs(v) >= 1000 ? fmtN(v) : String(+v.toFixed(1)));
  const f1 = v => (+v).toFixed(1);

  M.charts = M.charts || {};
  /* line(series, opts) — series [{date:"YYYY-MM-DD", v}] daily points.
     opts: { avg:[{date,v}] (7-day average line), goal:number|null (dashed),
             from, to (x domain date keys; default first..last point),
             unit:"lb", label:"Weight", tone:"acc"|"mus", w:340, h:180 }
     Returns "" for no points, otherwise an <svg> string. */
  M.charts.line = function (series, opts) {
    opts = opts || {};
    const W = num(opts.w, 340), H = num(opts.h, 180), padL = 40, padR = 14, padT = 16, padB = 22;
    const pts = (Array.isArray(series) ? series : []).filter(p => p && isNum(p.v) && p.date).slice().sort(byDate);
    if (!pts.length) return "";
    const from = opts.from || pts[0].date, to = opts.to || pts[pts.length - 1].date;
    const avg = (Array.isArray(opts.avg) ? opts.avg : []).filter(a => a && isNum(a.v) && a.date >= from && a.date <= to).slice().sort(byDate);
    const goal = isNum(opts.goal) ? opts.goal : null;
    const unit = opts.unit ? " " + opts.unit : "";
    const tone = opts.tone === "mus" ? " mus" : "";
    const span = Math.max(0, M.daysBetween(from, to));
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const X = d => (span === 0 ? padL + innerW / 2 : padL + innerW * clamp(M.daysBetween(from, d), 0, span) / span);

    /* y domain: the data (+ the average), the goal when it is near enough to matter */
    const vals = pts.map(p => p.v).concat(avg.map(a => a.v));
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    let goalIn = false;
    if (goal != null) {
      const ext = Math.max((hi - lo) * 1.5, 6);
      if (goal >= lo - ext && goal <= hi + ext) { lo = Math.min(lo, goal); hi = Math.max(hi, goal); goalIn = true; }
    }
    const pad = Math.max((hi - lo) * 0.12, 1);
    lo -= pad; hi += pad;
    const Y = v => padT + innerH * (1 - (v - lo) / (hi - lo));

    let s = "";
    /* grid + y ticks (only values the data reaches) */
    niceTicks(lo, hi, 3).forEach(t => {
      const y = f1(Y(t));
      s += `<line class="g" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/><text x="${padL - 6}" y="${f1(Y(t) + 3.5)}" text-anchor="end">${fmtTick(t)}</text>`;
    });
    s += `<line class="ax" x1="${padL}" x2="${W - padR}" y1="${f1(H - padB)}" y2="${f1(H - padB)}"/>`;
    /* goal */
    if (goal != null) {
      const gy = goalIn ? Y(goal) : (goal > hi ? padT : H - padB);
      const arrow = goalIn ? "" : (goal > hi ? " ↑" : " ↓");
      s += `<line class="goal" x1="${padL}" x2="${W - padR}" y1="${f1(gy)}" y2="${f1(gy)}"/>`;
      s += `<text class="gl" x="${W - padR}" y="${f1(gy - 4)}" text-anchor="end">Goal ${fmtTick(goal)}${arrow}</text>`;
    }
    /* 7-day average line */
    if (avg.length >= 2) s += `<path class="avg" d="${avg.map((a, i) => (i ? "L" : "M") + f1(X(a.date)) + " " + f1(Y(a.v))).join(" ")}"/>`;
    /* daily points */
    const r = pts.length > 120 ? 2 : pts.length > 45 ? 2.5 : 3;
    pts.forEach((p, i) => {
      const last = i === pts.length - 1;
      s += `<circle class="${last ? "last" : "pt"}" cx="${f1(X(p.date))}" cy="${f1(Y(p.v))}" r="${last ? 5 : r}"><title>${esc(fmtShort(p.date))}: ${fmtTick(p.v)}${esc(unit)}</title></circle>`;
    });
    /* last value, labelled */
    const lp = pts[pts.length - 1], lx = X(lp.date), ly = Y(lp.v);
    const above = ly - 10 > padT + 4;
    const anchor = lx > W - padR - 24 ? "end" : lx < padL + 24 ? "start" : "middle";
    s += `<text class="ll" x="${f1(lx)}" y="${f1(above ? ly - 10 : ly + 16)}" text-anchor="${anchor}">${fmtTick(lp.v)}</text>`;
    /* x labels */
    s += `<text x="${padL}" y="${H - 6}">${esc(fmtShort(from))}</text>`;
    if (span > 0) s += `<text x="${W - padR}" y="${H - 6}" text-anchor="end">${esc(fmtShort(to))}</text>`;
    if (span >= 20) { const mid = M.addDays(from, Math.round(span / 2)); s += `<text x="${f1(X(mid))}" y="${H - 6}" text-anchor="middle">${esc(fmtShort(mid))}</text>`; }
    return `<svg class="mt-chart${tone}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || "Trend")}">${s}</svg>`;
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
    let s = "";
    niceTicks(0, max, 3).forEach(t => {
      const y = f1(Y(t));
      s += `<line class="g" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/><text x="${padL - 6}" y="${f1(Y(t) + 3.5)}" text-anchor="end">${fmtTick(t)}</text>`;
    });
    s += `<line class="ax" x1="${padL}" x2="${W - padR}" y1="${f1(y0)}" y2="${f1(y0)}"/>`;
    vals.forEach((v, i) => {
      const x = padL + band * i + (band - bw) / 2;
      const val = num(v && v.v);
      const title = `<title>${esc(v && v.title != null ? v.title : (v && v.label ? v.label + ": " : "") + (v && v.empty ? "not logged" : fmtTick(val) + unit))}</title>`;
      if (!v || v.empty || !(val > 0)) {
        s += `<g>${title}<rect class="bar-e" x="${f1(x)}" y="${f1(y0 - 6)}" width="${bw}" height="6" rx="2"/></g>`;
      } else {
        const y = Y(val), h = y0 - y, rr = Math.min(4, h / 2);
        s += `<g>${title}<path class="bar" d="M${f1(x)} ${f1(y0)} L${f1(x)} ${f1(y + rr)} Q${f1(x)} ${f1(y)} ${f1(x + rr)} ${f1(y)} L${f1(x + bw - rr)} ${f1(y)} Q${f1(x + bw)} ${f1(y)} ${f1(x + bw)} ${f1(y + rr)} L${f1(x + bw)} ${f1(y0)} Z"/></g>`;
      }
      const longLabels = vals.some(o => o && o.label && String(o.label).length > 2);
      const every = band < (longLabels ? 48 : 22) ? 2 : 1;
      if (v && v.label && (n - 1 - i) % every === 0) s += `<text x="${f1(x + bw / 2)}" y="${H - 6}" text-anchor="middle">${esc(v.label)}</text>`;
    });
    if (target != null) {
      const ty = Y(target);
      s += `<line class="tgt" x1="${padL}" x2="${W - padR}" y1="${f1(ty)}" y2="${f1(ty)}"/>`;
      s += `<text class="gl" x="${W - padR}" y="${f1(ty - padT < 12 ? ty + 11 : ty - 4)}" text-anchor="end">Target ${fmtTick(target)}</text>`;
    }
    return `<svg class="mt-chart${tone}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || "Bars")}">${s}</svg>`;
  };

  /* ================================================================= trends */
  M.trends = M.trends || {};
  M.trends.state = { range: 90 };

  const tile = (v, k, small, sub) => `<div class="stat"><div class="v num">${v}${small ? `<small>${small}</small>` : ""}</div><div class="k">${k}</div>${sub ? `<div class="mt-sub">${sub}</div>` : ""}</div>`;

  function weightCard(id, p) {
    const u = units(p), range = M.trends.state.range;
    const all = M.body.series(id, "w", 0);
    const avgAll = M.body.avg7(all);
    const chips = [[30, "30"], [90, "90"], [0, "All"]].map(([v, l]) => `<button class="${range === v ? "on" : ""}" data-m="t-range" data-v="${v}">${l}</button>`).join("");
    let body;
    if (!all.length) {
      body = `<div class="mt-empty">No weigh-ins yet. Tap <b>Log weight / heart rate</b> to add one.</div>`;
    } else {
      const latest = all[all.length - 1];
      const a7 = avgAll[avgAll.length - 1].v;
      const rate = M.body.ratePerWeek(id);
      const goal = isNum(p.goalWeightLb) && p.goalWeightLb > 0 ? p.goalWeightLb : null;
      const stats = `<div class="stats">
        ${tile(toDispW(latest.v, u), "Latest", wUnit(u), esc(fmtShort(latest.date)))}
        ${tile(signed(u === "metric" ? M.units.lb2kg(latest.v - a7) : latest.v - a7, 1), "vs 7-day avg", wUnit(u), "avg " + toDispW(a7, u))}
        ${tile(rate == null ? "—" : signed(u === "metric" ? M.units.lb2kg(rate) : rate, u === "metric" ? 2 : 1), "Per week", rate == null ? "" : wUnit(u), rate == null ? "needs 2 wks" : "trend")}
      </div>`;
      let goalLine;
      if (goal == null) goalLine = `<p class="hint">Set a goal weight in <b>You</b> to see how far you are.</p>`;
      else {
        const diff = latest.v - goal;
        const dir = diff > 0 ? "to lose" : diff < 0 ? "to gain" : "";
        const onTrack = rate != null && rate !== 0 && Math.abs(diff) >= 0.05 && (rate < 0) === (diff > 0);
        goalLine = `<p class="hint mt-goalline">Goal <b>${esc(fmtW(goal, u))}</b> · ${Math.abs(diff) < 0.05 ? "you're there" : "<b>" + esc(fmtW(Math.abs(diff), u)) + "</b> " + dir}${onTrack ? " · about " + Math.max(1, Math.round(Math.abs(diff / rate))) + " wk at " + esc(fmtRate(rate, u)) : ""}</p>`;
      }
      const from = range > 0 ? M.addDays(M.today(), -(range - 1)) : all[0].date;
      const to = range > 0 ? M.today() : all[all.length - 1].date;
      const win = all.filter(x => x.date >= from);
      const conv = arr => (u === "metric" ? arr.map(x => ({ date: x.date, v: r1(M.units.lb2kg(x.v)) })) : arr);
      const chart = win.length
        ? M.charts.line(conv(win), { avg: conv(avgAll), goal: goal == null ? null : (u === "metric" ? r1(M.units.lb2kg(goal)) : goal), from, to, unit: wUnit(u), label: "Weight", tone: "acc" })
        : `<div class="mt-empty">No weigh-ins in the last ${range} days. Tap <b>All</b> to see older ones.</div>`;
      body = stats + goalLine + chart;
    }
    return `<div class="card mt-card"><div class="hd"><h3>Weight</h3><div class="seg mt-range">${chips}</div></div><div class="bd">${body}</div></div>`;
  }

  function rhrCard(id, p) {
    const range = M.trends.state.range;
    const all = M.body.series(id, "rhr", 0);
    let body;
    if (!all.length) {
      body = `<div class="mt-empty">No resting heart rate yet. Log it with your weight — first thing in the morning is best.</div>`;
    } else {
      const latest = all[all.length - 1];
      const last7 = all.slice(-7);
      const avg = r0(last7.reduce((t, x) => t + x.v, 0) / last7.length);
      const stats = `<div class="stats">
        ${tile(r0(latest.v), "Latest", "bpm", esc(fmtShort(latest.date)))}
        ${tile(avg, "Avg of last " + last7.length, "bpm")}
        ${tile(signed(latest.v - avg, 0), "vs that avg", "bpm")}
      </div>`;
      const from = range > 0 ? M.addDays(M.today(), -(range - 1)) : all[0].date;
      const to = range > 0 ? M.today() : all[all.length - 1].date;
      const win = all.filter(x => x.date >= from);
      const chart = win.length
        ? M.charts.line(win, { avg: M.body.avg7(all), from, to, unit: "bpm", label: "Resting heart rate", tone: "mus" })
        : `<div class="mt-empty">Nothing in the last ${range} days. Tap <b>All</b> to see older entries.</div>`;
      body = stats + chart;
    }
    return `<div class="card mt-card"><div class="hd"><h3>Resting heart rate</h3></div><div class="bd">${body}</div></div>`;
  }

  function weekCard(id) {
    const ws = M.weekSummary(id, 0);
    const t = ws.target || {};
    const vals = ws.daily.map(d => ({ label: dow(d.date), v: d.cal, empty: !d.logged, title: fmtShort(d.date) + (d.logged ? ": " + fmtN(d.cal) + " kcal · P " + r0(d.p) + " g" : ": not logged") }));
    const stats = `<div class="stats">
      ${tile(ws.logged, "Logged", "/ 7", "days")}
      ${tile(ws.logged ? fmtN(ws.avgCal) : "—", "Avg kcal", "", "of " + fmtN(t.cal))}
      ${tile(ws.logged ? r0(ws.avgP) : "—", "Protein", "g", "of " + r0(t.p) + " g")}
    </div>`;
    const chart = M.charts.bars(vals, { target: t.cal, unit: "kcal", label: "This week's calories", h: 150 });
    const note = ws.logged ? "" : `<p class="hint">Log a day of food and the bars fill in.</p>`;
    return `<div class="card mt-card"><div class="hd"><h3>This week</h3><span class="small mut">${esc(fmtShort(ws.start))} – ${esc(fmtShort(ws.end))}</span></div><div class="bd">${stats}${note}${chart}</div></div>`;
  }

  function weeksCard(id) {
    const vals = [];
    let target = null, any = 0;
    for (let i = 7; i >= 0; i--) {
      const ws = M.weekSummary(id, i);
      if (target == null && ws.target) target = ws.target.cal;
      if (ws.logged) any++;
      vals.push({ label: fmtShort(ws.start), v: ws.avgCal, empty: !ws.logged, title: fmtShort(ws.start) + " – " + fmtShort(ws.end) + (ws.logged ? ": avg " + fmtN(ws.avgCal) + " kcal (" + ws.logged + " days)" : ": nothing logged") });
    }
    const chart = M.charts.bars(vals, { target, unit: "kcal", label: "Average calories per week", h: 150 });
    const note = any ? `<p class="hint">Average kcal on the days you logged, one bar per week.</p>` : `<p class="hint">Weeks with no food logged stay empty.</p>`;
    return `<div class="card mt-card"><div class="hd"><h3>Last 8 weeks</h3></div><div class="bd">${note}${chart}</div></div>`;
  }

  M.ui.views.trends = function () {
    const id = pid();
    if (!id) return `<div class="card"><div class="empty">Pick a person first.</div></div>`;
    const p = person(id);
    return `<button class="btn primary block" data-m="t-log-body">Log weight / heart rate</button>`
      + weightCard(id, p) + rhrCard(id, p) + weekCard(id) + weeksCard(id);
  };

  /* ---------------------------------------------------- log body sheet */
  function bodyListHTML(id, u) {
    const rows = M.body.list(id).slice(-10).reverse();
    if (!rows.length) return `<div class="mt-empty">Nothing logged yet.</div>`;
    return rows.map(b => `<div class="mt-brow"><span class="d">${esc(fmtShort(b.date))}</span><span class="v num">${isNum(b.w) ? esc(fmtW(b.w, u)) : "—"}</span><span class="v num">${isNum(b.rhr) ? b.rhr + " bpm" : "—"}</span><button class="icon mt-x" data-m="t-del-body" data-date="${esc(b.date)}" aria-label="Delete">×</button></div>`).join("");
  }
  function bodySheetHTML(id, p) {
    const u = units(p);
    const lw = M.body.latest(id, "w"), lr = M.body.latest(id, "rhr");
    const today = M.today();
    return `<div class="mt-form">
      <div class="entry">
        <div><span class="lbl">Weight (${wUnit(u)})</span><input class="mini" id="mt-w" type="number" step="0.1" min="0" inputmode="decimal" placeholder="${lw ? toDispW(lw.value, u) : (u === "metric" ? "80.0" : "180.0")}"></div>
        <div><span class="lbl">Resting HR (bpm)</span><input class="mini" id="mt-rhr" type="number" min="0" max="250" inputmode="numeric" placeholder="${lr ? r0(lr.value) : "60"}"></div>
      </div>
      <div class="mt-daterow"><span class="lbl">Date</span><input class="mini mt-date" id="mt-date" type="date" value="${today}" max="${today}"></div>
      <button class="btn primary block mt-savebtn" data-m="t-save-body">Save</button>
      <p class="hint">Weigh in first thing in the morning, before eating. Same time each day keeps the line honest.</p>
      <h2 class="sec">Last 10</h2>
      <div class="mt-list" id="mt-body-list">${bodyListHTML(id, u)}</div>
    </div>`;
  }

  /* ============================================================ numbers UI */
  /* Shared field block for "Your numbers" (mode "you") and the setup card (mode "setup").
     `p` is a Profile in "you" mode, the draft object in "setup" mode. */
  function numbersFieldsHTML(p, mode) {
    const u = units(p);
    const IN = mode === "setup" ? "t-setup" : "t-num";
    const segAttr = f => (mode === "setup" ? `data-m="t-setup-seg" data-f="${f}"` : `data-m="t-${f}"`);
    const { ft, inch } = ftIn(p.heightIn);
    const cm = isNum(p.heightIn) ? r0(M.units.in2cm(p.heightIn)) : "";
    const height = u === "metric"
      ? `<input class="mini" type="number" inputmode="numeric" min="50" max="260" data-m="${IN}" data-f="hcm" value="${cm}" placeholder="178"><span class="mt-u">cm</span>`
      : `<input class="mini" type="number" inputmode="numeric" min="1" max="8" data-m="${IN}" data-f="hft" value="${ft}" placeholder="5"><span class="mt-u">ft</span><input class="mini" type="number" inputmode="numeric" min="0" max="11" data-m="${IN}" data-f="hin" value="${inch}" placeholder="10"><span class="mt-u">in</span>`;
    const actOpts = Object.keys(M.calc.ACT).map(k => `<option value="${k}" ${p.activity === k ? "selected" : ""}>${esc(M.calc.ACT_LABEL[k] || k)}</option>`).join("");
    const paceOpts = M.calc.PACES.map(v => `<option value="${v}" ${num(p.pace) === v ? "selected" : ""}>${esc(paceLabel(v, u))}</option>`).join("");
    return `<div class="srow"><div class="l">Sex</div><div class="seg"><button class="${p.sex === "m" ? "on" : ""}" ${segAttr("sex")} data-v="m">Male</button><button class="${p.sex === "f" ? "on" : ""}" ${segAttr("sex")} data-v="f">Female</button></div></div>
      <div class="srow"><div class="l">Age</div><div class="mt-ctl"><input class="mini" type="number" inputmode="numeric" min="5" max="120" data-m="${IN}" data-f="age" value="${isNum(p.age) ? p.age : ""}" placeholder="35"><span class="mt-u">yrs</span></div></div>
      <div class="srow"><div class="l">Height</div><div class="mt-ctl mt-hgt">${height}</div></div>
      <div class="srow"><div><div class="l">Weight</div><div class="s">${mode === "setup" ? "Today's weight" : "Changing it logs today's weigh-in"}</div></div><div class="mt-ctl"><input class="mini" type="number" step="0.1" min="0" inputmode="decimal" data-m="${IN}" data-f="weight" value="${toDispW(p.weightLb, u)}" placeholder="${u === "metric" ? "80" : "180"}"><span class="mt-u">${wUnit(u)}</span></div></div>
      <div class="srow"><div class="l">Goal weight</div><div class="mt-ctl"><input class="mini" type="number" step="0.1" min="0" inputmode="decimal" data-m="${IN}" data-f="goal" value="${toDispW(p.goalWeightLb, u)}" placeholder="${u === "metric" ? "75" : "170"}"><span class="mt-u">${wUnit(u)}</span></div></div>
      <div class="mt-field"><div class="l">Activity</div><select class="sel" data-m="${IN}" data-f="activity">${actOpts}</select></div>
      <div class="mt-field"><div class="l">Pace</div><select class="sel" data-m="${IN}" data-f="pace">${paceOpts}</select></div>
      <div class="srow"><div class="l">Units</div><div class="seg"><button class="${u === "us" ? "on" : ""}" ${segAttr("units")} data-v="us">lb · ft</button><button class="${u === "metric" ? "on" : ""}" ${segAttr("units")} data-v="metric">kg · cm</button></div></div>`;
  }
  M.ui.calculatorHTML = function (profile) { return numbersFieldsHTML(profile || person(), "you"); };

  /* Write one field from an input element into a profile / draft. Returns true when it changed something. */
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
        const lb = M.units.parseW(v, u); if (!lb) return false;
        if (live) { p.weightLb = lb; return true; }
        M.body.add({ date: M.today(), w: lb, pid: p.id }); p.weightLb = lb; return true;
      }
      case "goal": { const lb = M.units.parseW(v, u); p.goalWeightLb = lb || null; return true; }
      case "activity": if (M.calc.ACT[v]) { p.activity = v; return true; } return false;
      case "pace": { const n = num(v, 0); p.pace = M.calc.PACES.indexOf(n) >= 0 ? n : 0; return true; }
    }
    return false;
  }

  /* ==================================================================== you */
  function targetsCard(p) {
    const cur = p.split || "highprotein";
    const opts = Object.keys(M.calc.SPLITS).map(k => {
      const sp = M.calc.SPLITS[k];
      return `<button class="opt mt-opt ${cur === k ? "cur" : ""}" data-m="t-split" data-v="${k}"><span><b>${esc(sp.label)}</b><span class="small mut">${esc(sp.desc)}</span></span><span class="m">${cur === k ? "✓" : ""}</span></button>`;
    }).join("");
    let custom = "";
    if (cur === "custom") {
      const c = p.custom || { p: 30, c: 40, f: 30 };
      const sum = r0(num(c.p) + num(c.c) + num(c.f));
      custom = `<div class="mt-custom">
        ${["p", "c", "f"].map(k => `<div><span class="lbl">${k === "p" ? "Protein" : k === "c" ? "Carbs" : "Fat"} %</span><input class="mini" type="number" inputmode="numeric" min="0" max="100" data-m="t-custom" data-f="${k}" value="${r0(num(c[k]))}"></div>`).join("")}
      </div>
      <div class="mt-sumrow"><span class="small ${sum === 100 ? "mut" : "mt-warn"}" id="mt-csum">${sum === 100 ? "Adds up to 100%" : "Adds up to " + sum + "% — must be 100%"}</span><button class="btn" id="mt-capply" data-m="t-custom-apply" ${sum === 100 ? "" : "disabled"}>Apply</button></div>`;
    }
    return `<div class="card mt-card"><div class="hd"><h3>Macro targets</h3></div>
      <div class="mt-opts">${opts}</div>${custom}
      <div class="mt-tbox" id="mt-tbox">${targetsBoxHTML(p)}</div>
      <div class="srow"><div><div class="l">Edit targets manually</div><div class="s">Type your own numbers. Turn off to go back to the calculator.</div></div><button class="toggle ${p.targetsManual ? "on" : ""}" data-m="t-manual" role="switch" aria-checked="${!!p.targetsManual}"><i></i></button></div>
    </div>`;
  }
  /* The targets grid + the line under it: everything a change in "Your numbers" can move. */
  function targetsBoxHTML(p) {
    const t = p.targets || {};
    const complete = M.calc.complete(p);
    const manual = !!p.targetsManual;
    const u = units(p);
    const cell = (k, label, unit) => `<div class="stat"><div class="v num">${manual ? `<input class="mini" type="number" inputmode="numeric" min="0" data-m="t-target" data-f="${k}" value="${r0(num(t[k]))}">` : fmtN(t[k])}${manual ? "" : `<small>${unit}</small>`}</div><div class="k">${manual && k === "cal" ? "kcal" : label + (manual ? " " + unit : "")}</div></div>`;
    const grid = `<div class="stats mt-tgrid">${cell("cal", "Calories", "kcal")}${cell("p", "Protein", "g")}${cell("c", "Carbs", "g")}${cell("f", "Fat", "g")}${cell("fiber", "Fiber", "g")}${cell("water", "Water", "oz")}</div>`;
    let note = "";
    if (manual) note = `<p class="hint">You're setting these by hand. Water is in oz${u === "metric" ? " (" + fmtN(t.water) + " oz ≈ " + fmtN(M.units.oz2ml(num(t.water))) + " ml)" : ""}.</p>`;
    else if (!complete) note = `<p class="hint">Fill in sex, age, height and weight above and these update on their own.</p>`;
    else { const c = M.calc.calories(p); note = `<p class="hint">Worked out from your numbers${c.floored ? " and held at the " + fmtN(c.cal) + " kcal minimum" : ""}. Changes above update these.</p>`; }
    return grid + note;
  }

  function ciNumHTML(p) {
    const setupAge = p.setupAt ? Math.floor((now() - num(p.setupAt)) / DAY) : null;
    const setupS = p.setupAt ? `Set ${esc(fmtTs(p.setupAt))} (${setupAge} day${setupAge === 1 ? "" : "s"} ago)${setupAge >= 60 ? ' <span class="tag warn">60+ days</span>' : ""}` : "Not set yet";
    return setupS + ". We ask again after 60 days.";
  }
  function ciBodyHTML(id, p) {
    const t = now();
    const lastBody = Math.max(num(p.lastBody), num(p.setupAt));
    const lw = M.body.latest(id, "w");
    let bodyS;
    if (!lastBody && !lw) bodyS = "No weigh-in yet";
    else {
      const due = lastBody + 14 * DAY;
      bodyS = (lw ? "Last weigh-in " + esc(fmtShort(lw.date)) : "Last check-in " + esc(fmtTs(lastBody))) + " · " + (due <= t ? '<span class="tag warn">due now</span>' : "next " + esc(fmtTs(due)));
    }
    return bodyS + ". Every 2 weeks.";
  }
  function checkinsCard(id, p) {
    return `<div class="card mt-card"><div class="hd"><h3>Check-ins</h3></div>
      <div class="srow"><div><div class="l">Your numbers</div><div class="s" id="mt-ci-num">${ciNumHTML(p)}</div></div><button class="btn" data-m="t-reviewed">Reviewed</button></div>
      <div class="srow"><div><div class="l">Weight &amp; heart rate</div><div class="s" id="mt-ci-body">${ciBodyHTML(id, p)}</div></div><button class="btn" data-m="t-log-body">Log now</button></div>
    </div>`;
  }

  function aiCard(p) {
    const ai = M.ai || null;
    const mode = ai && typeof ai.mode === "function" ? ai.mode() : null;
    const hasKey = !!(ai && typeof ai.getKey === "function" && ai.getKey());
    let status, ok = false;
    if (mode === "sample") { status = "Claude ready — you're inside claude.ai."; ok = true; }
    else if (mode === "key") { status = "Key saved on this phone."; ok = true; }
    else status = "No Claude yet. Paste an Anthropic API key to turn on photo logging, label reading and meal ideas.";
    const models = [["claude-sonnet-5-5", "Claude Sonnet 5.5 (default)"], ["claude-haiku-4-5-20251001", "Claude Haiku 4.5 (cheaper)"]];
    const cur = p.aiModel || "claude-sonnet-5-5";
    return `<div class="card mt-card"><div class="hd"><h3>AI (Claude)</h3></div><div class="bd">
      <div class="mt-status ${ok ? "ok" : ""}"><i></i><span>${esc(status)}</span></div>
      <div class="mt-key"><input type="password" id="mt-key" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${hasKey ? "Key saved — paste a new one to replace" : "sk-ant-…"}"><button class="btn" data-m="t-ai-save">Save</button>${hasKey ? `<button class="btn danger" data-m="t-ai-remove">Remove</button>` : ""}</div>
      <div class="mt-field mt-field-flat"><div class="l">Model</div><select class="sel" data-m="t-ai-model">${models.map(([v, l]) => `<option value="${v}" ${cur === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="mt-row"><button class="btn" data-m="t-ai-test">Test</button><span class="small mut" id="mt-ai-msg"></span></div>
      <p class="hint">Your key stays on this phone. It's only used for photos, labels and meal ideas.</p>
    </div></div>`;
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
  let trainCheckAt = 0;
  function syncCardHTML() {
    const head = `<div class="hd"><h3>Sync &amp; backup</h3></div>`;
    const C = cloud();
    if (!C || !C.configured()) return `<div class="card mt-card mt-sync" id="mt-sync">${head}<div class="bd"><p class="mt-text mt-quiet">Cloud sync isn't set up yet.</p></div></div>`;
    const s = C.status();
    if (!s.on) {
      return `<div class="card mt-card mt-sync" id="mt-sync">${head}<div class="bd">
        <p class="mt-text">Share foods and meals between your phones and keep a backup.</p>
        <div class="mt-row mt-wrap"><button class="btn primary" data-m="t-sync-on">Turn on</button><button class="btn" data-m="t-sync-joinshow">Join with a code</button></div>
        <div class="mt-join" id="mt-join" hidden>
          <p class="hint">Type the code shown on the other phone.</p>
          <div class="mt-joinrow"><input id="mt-join-code" type="text" inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" maxlength="32" placeholder="ABCD-EFGH-JKLM-NPQR-STUV" aria-label="Code from the other phone"><button class="btn primary" data-m="t-sync-join">Join</button></div>
          <p class="small mt-warn" id="mt-join-msg" hidden></p>
        </div>
      </div></div>`;
    }
    /* now and then, ask the cloud whether this person has a training backup */
    if (now() - trainCheckAt > 60e3 && typeof C.hasTrainingBackup === "function") {
      trainCheckAt = now();
      setTimeout(() => { try { Promise.resolve(C.hasTrainingBackup()).then(patchSync, () => {}); } catch (e) {} }, 0);
    }
    const line = syncLine(s);
    return `<div class="card mt-card mt-sync" id="mt-sync">${head}<div class="bd">
      <div class="mt-code" id="mt-code">${esc(C.fmtCode(s.code))}</div>
      <div class="mt-coderow"><p class="hint">Type this code on the other phone. Keep a copy in Notes: a new phone needs it to get your data back.</p><button class="btn" data-m="t-sync-copy">Copy</button></div>
      <div class="mt-syncrow"><div class="mt-status ${line.cls}" id="mt-sync-status"><i></i><span>${esc(line.text)}</span></div><button class="btn" data-m="t-sync-now">Sync now</button></div>
      <p class="hint">Foods and saved meals are shared. Diaries, weight and training are backed up.</p>
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

  M.ui.views.you = function () {
    const id = pid();
    if (!id) return `<div class="card"><div class="empty">Pick a person first.</div></div>`;
    const p = person(id);
    const numbers = `<div class="card mt-card"><div class="hd"><h3>Your numbers</h3></div>${numbersFieldsHTML(p, "you")}</div>`;
    const who = `<div class="card mt-card"><div class="hd"><h3>Person</h3></div><div class="srow"><div><div class="l">Now: ${esc(p.name || id)}</div><div class="s">Macros and workouts follow the same person.</div></div><button class="btn" data-a="switch-profile">Switch</button></div></div>`;
    const data = `<div class="card mt-card"><div class="hd"><h3>Data</h3></div><div class="bd"><p class="hint">Backup lives in Train → Settings and now includes Macros.</p></div></div>`;
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
    return `<div class="mt-preview"><div class="mt-pv"><b>${fmtN(t.cal)}</b><span>kcal / day</span></div><div class="mt-pv"><b>${t.p}</b><span>protein g</span></div><div class="mt-pv"><b>${t.c}</b><span>carbs g</span></div><div class="mt-pv"><b>${t.f}</b><span>fat g</span></div>${c.floored ? `<span class="small mut mt-pvnote">Held at the ${fmtN(c.cal)} kcal minimum.</span>` : ""}</div>`;
  }

  M.ui.setupCardHTML = function () {
    const id = pid(); if (!id) return "";
    const d = draft();
    const splits = Object.keys(M.calc.SPLITS).filter(k => k !== "custom").map(k => {
      const sp = M.calc.SPLITS[k];
      return `<button class="opt mt-opt ${d.split === k ? "cur" : ""}" data-m="t-setup-split" data-v="${k}"><span><b>${esc(sp.label)}</b><span class="small mut">${esc(sp.desc)}</span></span><span class="m">${d.split === k ? "✓" : ""}</span></button>`;
    }).join("");
    return `<div class="card mt-card mt-setup first" id="mt-setup">
      <div class="hd"><h3>Let's set your targets</h3></div>
      <div class="bd"><p class="hint">Takes 30 seconds. You can change any of it later in <b>You</b>.</p></div>
      ${numbersFieldsHTML(d, "setup")}
      <div class="mt-field"><div class="l">Macro split</div></div>
      <div class="mt-opts">${splits}</div>
      <div class="bd" id="mt-preview">${previewHTML(d)}</div>
      <div class="bd"><button class="btn primary block" data-m="t-save-setup">Save my targets</button></div>
    </div>`;
  };

  function refresh60HTML() {
    return `<div class="card mt-card mt-banner"><div class="hd"><h3>Still accurate?</h3></div><div class="bd">
      <p class="mt-text">It's been 60+ days since you set your numbers. Weight, activity and goal can drift.</p>
      <div class="mt-row mt-wrap"><button class="btn primary" data-m="tab" data-v="you">Update</button><button class="btn" data-m="t-reviewed">They're the same</button><button class="btn ghost" data-m="t-snooze" data-kind="refresh60" data-days="7">Skip for now</button></div>
    </div></div>`;
  }
  function body14HTML(id, p) {
    const u = units(p);
    const lw = M.body.latest(id, "w"), lr = M.body.latest(id, "rhr");
    return `<div class="card mt-card mt-banner"><div class="hd"><h3>Quick check-in</h3></div><div class="bd">
      <p class="mt-text">It's been two weeks. Log your weight and resting heart rate — either one is fine.</p>
      <div class="mt-b14">
        <div><span class="lbl">Weight (${wUnit(u)})</span><input class="mini" id="mt-b14-w" type="number" step="0.1" min="0" inputmode="decimal" placeholder="${lw ? toDispW(lw.value, u) : ""}"></div>
        <div><span class="lbl">Resting HR</span><input class="mini" id="mt-b14-rhr" type="number" min="0" max="250" inputmode="numeric" placeholder="${lr ? r0(lr.value) : "bpm"}"></div>
      </div>
      <div class="mt-row"><button class="btn primary" data-m="t-save-body14">Save</button><button class="btn ghost" data-m="t-snooze" data-kind="body14" data-days="14">Skip</button></div>
    </div></div>`;
  }
  M.ui.bannerHTML = function () {
    const id = pid(); if (!id) return "";
    let due = null;
    try { due = M.checkins.due(id); } catch (e) { return ""; }
    if (due === "refresh60") return refresh60HTML();
    if (due === "body14") return body14HTML(id, person(id));
    return "";
  };

  /* ================================================================ actions */
  const A = M.ui.actions, I = M.ui.inputs, C = M.ui.changes;

  /* --- trends --- */
  A["t-range"] = el => { const v = num(el && el.dataset ? el.dataset.v : 90, 90); M.trends.state.range = v === 30 || v === 90 ? v : 0; rerender(); };
  A["t-log-body"] = () => { const id = pid(); if (!id) return; openSheet("Log weight / heart rate", bodySheetHTML(id, person(id))); };
  A["t-save-body"] = () => {
    const id = pid(); if (!id) return;
    const p = person(id), u = units(p);
    const wEl = $("mt-w"), rEl = $("mt-rhr"), dEl = $("mt-date");
    const w = M.units.parseW(wEl ? wEl.value : "", u);
    const rhr = rEl && rEl.value !== "" ? r0(num(rEl.value)) : null;
    if (!w && !(rhr > 0)) { toast("Enter a weight or heart rate"); return; }
    let date = dEl && dEl.value ? dEl.value : M.today();
    if (!keyDate(date) || date > M.today()) date = M.today();
    M.body.add({ date, w: w || null, rhr: rhr > 0 ? rhr : null, pid: id });
    if (w && !p.targetsManual) M.calc.applyTargets(p);
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
    M.body.remove(el.dataset.date, id);
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
    const d = doc(), u = units(p), h = ftIn(p.heightIn);
    const set = (f, v) => {
      const i = card.querySelector('input[data-m="t-num"][data-f="' + f + '"]');
      if (i && (!d || i !== d.activeElement) && String(i.value) !== String(v)) i.value = v;
    };
    set("age", isNum(p.age) ? p.age : "");
    if (u === "metric") set("hcm", isNum(p.heightIn) ? r0(M.units.in2cm(p.heightIn)) : "");
    else { set("hft", h.ft); set("hin", h.inch); }
    set("weight", toDispW(p.weightLb, u));
    set("goal", toDispW(p.goalWeightLb, u));
  }
  function patchYou(id, p) {
    const box = $("mt-tbox");
    if (box && !p.targetsManual) box.innerHTML = targetsBoxHTML(p);   /* manual mode: the grid holds inputs, and numbers don't move it */
    const a = $("mt-ci-num"); if (a) a.innerHTML = ciNumHTML(p);
    const b = $("mt-ci-body"); if (b) b.innerHTML = ciBodyHTML(id, p);
  }
  C["t-num"] = el => {
    const id = pid(); if (!id || !el) return;
    const p = person(id);
    if (applyField(p, el.dataset.f, el, false)) { touchP(p); M.calc.applyTargets(p); }
    showNumbers(el, p);
    patchYou(id, p);
  };
  A["t-sex"] = el => { const id = pid(); if (!id) return; const p = person(id); const v = el.dataset.v; if (v !== "m" && v !== "f") return; p.sex = v; touchP(p); M.calc.applyTargets(p); rerender(); };
  A["t-units"] = el => { const id = pid(); if (!id) return; const p = person(id); p.units = el.dataset.v === "metric" ? "metric" : "us"; touchP(p); M.save(); rerender(); };

  /* --- you: split + targets --- */
  A["t-split"] = el => {
    const id = pid(); if (!id) return;
    const p = person(id), v = el.dataset.v;
    if (!M.calc.SPLITS[v]) return;
    p.split = v; p.targetsManual = false;
    touchP(p);
    M.calc.applyTargets(p);
    rerender();
  };
  function customSum(el) {
    const d = doc(); const box = el && el.closest ? el.closest(".card") : null;
    const root = box || d;
    if (!root) return null;
    const g = k => { const i = root.querySelector('input[data-m="t-custom"][data-f="' + k + '"]'); return i ? r0(num(i.value)) : 0; };
    const c = { p: g("p"), c: g("c"), f: g("f") };
    const sum = c.p + c.c + c.f;
    const lbl = root.querySelector("#mt-csum"); if (lbl) { lbl.textContent = sum === 100 ? "Adds up to 100%" : "Adds up to " + sum + "% — must be 100%"; lbl.classList.toggle("mt-warn", sum !== 100); lbl.classList.toggle("mut", sum === 100); }
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
    touchP(p);
    M.calc.applyTargets(p);
    toast("Targets updated");
    rerender();
  };
  A["t-manual"] = () => {
    const id = pid(); if (!id) return;
    const p = person(id);
    p.targetsManual = !p.targetsManual;
    touchP(p);
    if (!p.targetsManual) M.calc.applyTargets(p); else M.save();
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
  };

  /* --- you: check-ins --- */
  A["t-reviewed"] = () => {
    const id = pid(); if (!id) return;
    const p = person(id);
    if (!M.calc.complete(p)) { toast("Fill in your numbers first"); return; }
    touchP(p);
    M.checkins.done(id, "refresh60");
    toast("Thanks — see you in 60 days");
    rerender();
  };
  A["t-snooze"] = el => {
    const id = pid(); if (!id) return;
    const kind = el.dataset.kind === "body14" ? "body14" : "refresh60";
    touchP(person(id));
    M.checkins.snooze(id, kind, num(el.dataset.days, kind === "body14" ? 14 : 7));
    toast("OK, later");
    rerender();
  };
  A["t-save-body14"] = () => {
    const id = pid(); if (!id) return;
    const p = person(id), u = units(p);
    const wEl = $("mt-b14-w"), rEl = $("mt-b14-rhr");
    const w = M.units.parseW(wEl ? wEl.value : "", u);
    const rhr = rEl && rEl.value !== "" ? r0(num(rEl.value)) : null;
    if (!w && !(rhr > 0)) { toast("Enter a weight or heart rate, or Skip"); return; }
    M.body.add({ date: M.today(), w: w || null, rhr: rhr > 0 ? rhr : null, pid: id });
    M.checkins.done(id, "body14");
    if (w && !p.targetsManual) M.calc.applyTargets(p);
    toast("Saved");
    rerender();
  };

  /* --- you: AI --- */
  A["t-ai-save"] = () => {
    if (!M.ai) { toast("AI isn't loaded"); return; }
    const el = $("mt-key"); const k = el ? String(el.value || "").trim() : "";
    if (!k) { toast("Paste your key first"); return; }
    M.ai.setKey(k);
    toast("Key saved on this phone");
    rerender();
  };
  A["t-ai-remove"] = () => { if (!M.ai) return; M.ai.setKey(""); toast("Key removed"); rerender(); };
  C["t-ai-model"] = el => { const id = pid(); if (!id || !el) return; const p = person(id); p.aiModel = el.value || "claude-sonnet-5-5"; touchP(p); M.save(); };
  A["t-ai-test"] = el => {
    if (!M.ai || typeof M.ai.json !== "function") { toast("AI isn't loaded"); return; }
    const msg = $("mt-ai-msg");
    if (msg) msg.textContent = "Asking Claude…";
    if (el) { el.disabled = true; el.textContent = "Testing…"; }
    const done = () => { if (el) { el.disabled = false; el.textContent = "Test"; } };
    let pr;
    try { pr = typeof M.ai.test === "function" ? M.ai.test() : M.ai.json('Reply with {"ok":true}'); } catch (e) { pr = Promise.reject(e); }
    return Promise.resolve(pr).then(v => {
      const ok = v === true || (v && v.ok === true);
      if (msg) msg.textContent = ok ? "Claude answered. You're set." : "Claude replied, but not as expected.";
      toast(ok ? "Claude works" : "Odd reply from Claude");
      done();
    }, e => {
      if (msg) msg.textContent = (e && e.message) || "Couldn't reach Claude.";
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
    if (!v.trim()) { joinMsg("Type the code from the other phone."); return; }
    joinMsg("");
    try { if (inp) inp.blur(); } catch (e) {}   /* keyboard away; the card re-renders when the join lands */
    const reset = () => { if (el && el.dataset) { el.disabled = false; el.textContent = "Join"; } };
    if (el && el.dataset) { el.disabled = true; el.textContent = "Joining…"; }
    let pr;
    try { pr = Cl.join(v); } catch (e) { pr = null; }
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
    toast("Sync is off. Your data stays on this phone.");
    rerender();
  };

  /* --- setup card --- */
  function setupField(el) {
    if (!el) return;
    const d = draft();
    applyField(d, el.dataset.f, el, true);
    const pv = $("mt-preview"); if (pv) pv.innerHTML = previewHTML(d);
  }
  I["t-setup"] = setupField;
  C["t-setup"] = setupField;
  A["t-setup-seg"] = el => {
    const d = draft(), f = el.dataset.f, v = el.dataset.v;
    if (f === "sex" && (v === "m" || v === "f")) d.sex = v;
    else if (f === "units") d.units = v === "metric" ? "metric" : "us";
    else return;
    rerender();
  };
  A["t-setup-split"] = el => { const d = draft(); if (M.calc.SPLITS[el.dataset.v]) d.split = el.dataset.v; rerender(); };
  A["t-save-setup"] = () => {
    const id = pid(); if (!id) return;
    const d = draft();
    const missing = [];
    if (d.sex !== "m" && d.sex !== "f") missing.push("sex");
    if (!(num(d.age) >= 5)) missing.push("age");
    if (!(num(d.heightIn) > 0)) missing.push("height");
    if (!(num(d.weightLb) > 0)) missing.push("weight");
    if (missing.length) {
      toast("Fill in " + missing.join(", "));
      const pv = $("mt-preview"); if (pv) pv.innerHTML = `<div class="mt-preview"><span class="small mt-warn">Still need: ${esc(missing.join(", "))}.</span></div>`;
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
  };
})(window.M);
