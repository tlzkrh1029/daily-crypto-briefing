// Inline SVG charts for the briefing.
// chartSVG: daily candles + SMA 50/100/150/200/365 lines + HMA 89/144/233 cross markers, log price axis
//           (style of crypto-screener-365-4sma v9 build_chart). The price axis is fitted to the candles;
//           lines far away are clipped at the plot edge and flagged in the legend instead of squashing the candles.
// cptraSVG: BTC cost per transaction (pinescript/cost-per-transaction, "BTC %ex") SMA 5/50/200 of the
//           100-bar normalized value, on a 0..1 axis.
import { sma, hma } from './ind.mjs';

const MA = [[50, '#FF9800'], [100, '#4CAF50'], [150, '#00BCD4'], [200, '#2196F3'], [365, '#E91E63']];
const HM = [[233, '#9C27B0'], [144, '#2962FF'], [89, '#E8C300']];
const STRIDE = { 30: 1, 90: 2, 120: 3, 180: 3 };
const FONT = 'font-family:ui-monospace,Menlo,Consolas,monospace';
const UP = '#16a34a', DOWN = '#dc2626';

const esc = (s) => String(s).replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
const f1 = (v) => v.toFixed(1);
function fmt(v) {
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(4);
  return v.toPrecision(3);
}
const textW = (s, px = 9.5) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2000 ? px * 1.3 : px * 0.61), 0);

function monthTicks(times, x, yTop, yBot, height) {
  const out = [];
  let prevM = null;
  times.forEach((t, k) => {
    const d = new Date(t * 1000), m = d.getUTCMonth();
    if (prevM !== null && m !== prevM) {
      out.push(`<line x1="${f1(x(k))}" x2="${f1(x(k))}" y1="${yTop}" y2="${yBot}" stroke="currentColor" stroke-opacity="0.07"/>`);
      out.push(`<text x="${f1(x(k))}" y="${height - 6}" font-size="10" text-anchor="middle" fill="currentColor" fill-opacity="0.55">${d.getUTCFullYear() % 100}.${m + 1}</text>`);
    }
    prevM = m;
  });
  return out;
}

// right-axis value tags that do not overlap: items [{y, label, bg, fg, cls}]
function tags(items, xLeft, w, yMin, yMax, h = 15) {
  const s = items.filter((t) => t.y != null).sort((a, b) => a.y - b.y);
  for (let i = 0; i < s.length; i++) s[i].ty = Math.max(yMin + h / 2, i ? Math.max(s[i].y, s[i - 1].ty + h) : s[i].y);
  for (let i = s.length - 1; i >= 0; i--) s[i].ty = Math.min(s[i].ty, i < s.length - 1 ? s[i + 1].ty - h : yMax - h / 2);
  return s.flatMap((t) => [
    `<rect x="${xLeft + 1}" y="${f1(t.ty - h / 2 + 0.5)}" width="${w - 2}" height="${h - 1}" rx="2" fill="${t.bg}"${t.bgOpacity ? ` fill-opacity="${t.bgOpacity}"` : ''}/>`,
    `<text x="${xLeft + 5}" y="${f1(t.ty + 3.8)}" font-size="10.5" font-weight="600"${t.cls ? ` class="${t.cls}"` : ` fill="${t.fg}"`}>${esc(t.label)}</text>`,
  ]);
}

// s: {t,o,h,l,c} (all bars, the live one included). Lines are computed on the full history, then cut.
export function chartSVG(s, { window = 120, title = '', width = 760, height = 400 } = {}) {
  const N = s.c.length;
  if (N < 20) return null;
  const lines = MA.map(([n, col]) => [n, col, sma(s.c, n)]);
  const hmas = HM.map(([n, col]) => [n, col, hma(s.c, n)]);
  const a = Math.max(0, N - window), idx = [...Array(N - a).keys()].map((k) => k + a);
  const cLo = Math.min(...idx.map((i) => s.l[i])), cHi = Math.max(...idx.map((i) => s.h[i]));
  // axis = candle range, widened only so that a line's latest value close to it (within 8%) stays visible,
  // plus 4% headroom; older stretches of the lines that leave this range are clipped
  let lo = cLo, hi = cHi;
  for (const [, , L] of [...lines, ...hmas]) {
    const v = L[N - 1];
    if (v == null) continue;
    if (v < lo && v >= cLo / 1.08) lo = v;
    if (v > hi && v <= cHi * 1.08) hi = v;
  }
  const span = Math.log(hi) - Math.log(lo);
  lo = Math.exp(Math.log(lo) - span * 0.04); hi = Math.exp(Math.log(hi) + span * 0.04);
  const padT = 44, padB = 22, padL = 6, padR = 74;
  const W = width - padL - padR, H = height - padT - padB;
  const ly = (v) => padT + H - ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * H;
  const bw = W / idx.length, x = (k) => padL + bw * k + bw / 2;
  const clip = 'cp' + [...(title || 'chart')].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(36);
  const parts = [`<defs><clipPath id="${clip}"><rect x="${padL}" y="${padT}" width="${W}" height="${H}"/></clipPath></defs>`];
  // grid: 5 log-spaced price labels
  for (let g = 0; g <= 4; g++) {
    const v = Math.exp(Math.log(lo) + ((Math.log(hi) - Math.log(lo)) * (g + 0.5)) / 5);
    const y = ly(v);
    parts.push(`<line x1="${padL}" x2="${padL + W}" y1="${f1(y)}" y2="${f1(y)}" stroke="currentColor" stroke-opacity="0.1"/>`);
    parts.push(`<text x="${padL + W + 5}" y="${f1(y + 3.5)}" font-size="10" fill="currentColor" fill-opacity="0.6">${fmt(v)}</text>`);
  }
  parts.push(...monthTicks(idx.map((i) => s.t[i]), x, padT, padT + H, height));
  const g = [];
  // SMA lines and HMA crosses go under the candles so the candles stay readable
  for (const [n, col, L] of lines) {
    let d = '';
    idx.forEach((i, k) => { if (L[i] != null) d += `${d ? 'L' : 'M'}${f1(x(k))},${f1(ly(L[i]))}`; });
    if (d) g.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="${n >= 200 ? 1.4 : 1.1}" stroke-opacity="0.85"/>`);
  }
  const step = STRIDE[window] || Math.max(1, Math.round(window / 40));
  for (const [, col, L] of hmas) {
    idx.forEach((i, k) => {
      if ((idx.length - 1 - k) % step !== 0 || L[i] == null) return;
      const cx = x(k), cy = ly(L[i]), r = 1.9;
      g.push(`<path d="M${f1(cx - r)},${f1(cy - r)}L${f1(cx + r)},${f1(cy + r)}M${f1(cx - r)},${f1(cy + r)}L${f1(cx + r)},${f1(cy - r)}" stroke="${col}" stroke-width="1" stroke-opacity="0.9"/>`);
    });
  }
  // candles: body 78% of the slot, wick 1.2px
  const cw = Math.max(1.5, bw * 0.78);
  idx.forEach((i, k) => {
    const up = s.c[i] >= s.o[i], col = up ? UP : DOWN;
    const yo = ly(s.o[i]), yc = ly(s.c[i]);
    g.push(`<line x1="${f1(x(k))}" x2="${f1(x(k))}" y1="${f1(ly(s.h[i]))}" y2="${f1(ly(s.l[i]))}" stroke="${col}" stroke-width="1.2"/>`);
    g.push(`<rect x="${f1(x(k) - cw / 2)}" y="${f1(Math.min(yo, yc))}" width="${f1(cw)}" height="${f1(Math.max(1, Math.abs(yc - yo)))}" fill="${col}"/>`);
  });
  parts.push(`<g clip-path="url(#${clip})">${g.join('')}</g>`);
  // last price tag (colored by the live bar's direction)
  const lastC = s.c[N - 1], upNow = s.c[N - 1] >= s.o[N - 1];
  parts.push(...tags([{ y: ly(lastC), label: fmt(lastC), bg: upNow ? UP : DOWN, fg: '#fff' }], padL + W, padR, padT, padT + H));
  if (title) parts.push(`<text x="${padL}" y="15" font-size="13" font-weight="700" fill="currentColor">${esc(title)}</text>`);
  // legend row with the latest value of every line; arrows mark lines outside the visible range
  const legend = [...lines.map(([n, c, L]) => [`SMA${n}`, c, L[N - 1]]), ...hmas.slice().reverse().map(([n, c, L]) => [`HMA${n}`, c, L[N - 1]])];
  let lx = padL, ly2 = 33;
  for (const [name, col, v] of legend) {
    if (v == null) continue;
    const flag = v > hi ? ' ↑' : v < lo ? ' ↓' : '';
    const label = `${name} ${fmt(v)}${flag}`;
    const w = textW(label) + 12;
    if (lx + w > width - 4) { lx = padL; ly2 += 13; }
    parts.push(`<text x="${f1(lx)}" y="${ly2}" font-size="9.5" fill="${col}"><tspan font-weight="700">${name}</tspan> ${fmt(v)}${flag}</text>`);
    lx += w;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(title)} 일봉 ${window}일" style="max-width:${width}px;${FONT}"><style>.tag{fill:Canvas}</style>${parts.join('')}</svg>`;
}

// p: {t (unix sec), s5, s50, s200} aligned arrays (null before warm-up); lastCross {date,dir}
export function cptraSVG(p, { window = 240, width = 760, height = 280, title = 'BTC %ex 5 50 200 SMA', lastCross = null, staleDays = 3, now = Date.now() } = {}) {
  const N = p.t.length;
  if (N < 210) return null;
  const a = Math.max(0, N - window), idx = [...Array(N - a).keys()].map((k) => k + a);
  const S = [
    { key: 's5', name: 'SMA5', col: '#4CAF50', w: 2 },
    { key: 's50', name: 'SMA50', col: '#2962FF', w: 1.3 },
    { key: 's200', name: 'SMA200', col: 'currentColor', w: 1.3, cls: 'tag' },
  ];
  let mx = 0;
  for (const s of S) for (const i of idx) if (p[s.key][i] != null) mx = Math.max(mx, p[s.key][i]);
  const lo = 0, hi = Math.min(1, Math.max(0.9, Math.ceil(mx * 10 + 0.2) / 10));
  const padT = 40, padB = 22, padL = 6, padR = 58;
  const W = width - padL - padR, H = height - padT - padB;
  const y = (v) => padT + H - ((v - lo) / (hi - lo)) * H;
  const bw = W / idx.length, x = (k) => padL + bw * k + bw / 2;
  const parts = [];
  for (let v = 0; v <= hi + 1e-9; v += 0.1) {
    parts.push(`<line x1="${padL}" x2="${padL + W}" y1="${f1(y(v))}" y2="${f1(y(v))}" stroke="currentColor" stroke-opacity="${Math.abs(v - 0.5) < 1e-9 ? 0.22 : 0.09}"/>`);
    parts.push(`<text x="${padL + W + 5}" y="${f1(y(v) + 3.5)}" font-size="10" fill="currentColor" fill-opacity="0.6">${v.toFixed(1)}</text>`);
  }
  parts.push(...monthTicks(idx.map((i) => p.t[i]), x, padT, padT + H, height));
  // last SMA50/SMA200 cross inside the window
  if (lastCross) {
    const ct = Date.parse(lastCross.date) / 1000, k = idx.findIndex((i) => p.t[i] >= ct);
    if (k >= 0) {
      parts.push(`<line x1="${f1(x(k))}" x2="${f1(x(k))}" y1="${padT}" y2="${padT + H}" stroke="currentColor" stroke-opacity="0.45" stroke-dasharray="3 3"/>`);
      const lab = `${lastCross.dir === 'up' ? '50↑200' : '50↓200'} ${lastCross.date.slice(5).replace('-', '/')}`;
      parts.push(`<text x="${f1(x(k) + 4)}" y="${padT + 11}" font-size="9.5" fill="currentColor" fill-opacity="0.75">${lab}</text>`);
    }
  }
  for (const s of S) {
    let d = '';
    idx.forEach((i, k) => { const v = p[s.key][i]; if (v != null) d += `${d ? 'L' : 'M'}${f1(x(k))},${f1(y(v))}`; });
    if (d) parts.push(`<path d="${d}" fill="none" stroke="${s.col}" stroke-width="${s.w}" stroke-linejoin="round"/>`);
  }
  const last = N - 1;
  parts.push(...tags(S.map((s) => ({ y: p[s.key][last] == null ? null : y(p[s.key][last]), label: p[s.key][last]?.toFixed(2), bg: s.col, fg: '#fff', cls: s.cls })), padL + W, padR, padT, padT + H));
  const lastDate = new Date(p.t[last] * 1000).toISOString().slice(0, 10);
  parts.push(`<text x="${padL}" y="15" font-size="13" font-weight="700" fill="currentColor">${esc(title)}</text>`);
  let lx = padL;
  for (const s of S) {
    const v = p[s.key][last];
    if (v == null) continue;
    const label = `${s.name} ${v.toFixed(3)}`;
    parts.push(`<text x="${f1(lx)}" y="32" font-size="9.5"${s.cls ? ' fill="currentColor"' : ` fill="${s.col}"`}><tspan font-weight="700">${s.name}</tspan> ${v.toFixed(3)}</text>`);
    lx += textW(label) + 14;
  }
  parts.push(`<text x="${f1(lx)}" y="32" font-size="9.5" fill="currentColor" fill-opacity="0.6">기준일 ${lastDate} · Coin Metrics 채굴자 수익 ÷ 트랜잭션 수, 100봉 정규화</text>`);
  // same warning as the Pine script: the feed has stopped updating
  if ((now / 1000 - p.t[last]) / 86400 > staleDays + 1) {
    const msg = `Data not updated since ${lastDate}`, w = textW(msg, 10.5) + 12;
    parts.push(`<rect x="${f1(padL + W - w)}" y="${padT + 2}" width="${f1(w)}" height="16" rx="2" fill="#dc2626"/><text x="${f1(padL + W - w + 6)}" y="${padT + 14}" font-size="10.5" fill="#fff">${msg}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(title)} ${window}일" style="max-width:${width}px;${FONT}"><style>.tag{fill:Canvas}</style>${parts.join('')}</svg>`;
}
