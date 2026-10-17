// Inline SVG daily chart in the style of crypto-screener-365-4sma v9 build_chart:
// candles + SMA 50/100/150/200/365 lines + HMA 89/144/233 cross markers, log price axis.
import { sma, hma } from './ind.mjs';

const MA = [[50, '#FF9800'], [100, '#4CAF50'], [150, '#00BCD4'], [200, '#2196F3'], [365, '#E91E63']];
const HM = [[233, '#9C27B0'], [144, '#2962FF'], [89, '#FFEB3B']];
const STRIDE = { 30: 1, 90: 2, 180: 3 };

const esc = (s) => String(s).replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
function fmt(v) {
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(4);
  return v.toPrecision(3);
}

// s: {t,o,h,l,c} (all bars, the live one included). Lines are computed on the full history, then cut.
export function chartSVG(s, { window = 180, title = '', width = 720, height = 260 } = {}) {
  const N = s.c.length;
  if (N < 20) return null;
  const lines = MA.map(([n, col]) => [n, col, sma(s.c, n)]);
  const hmas = HM.map(([n, col]) => [n, col, hma(s.c, n)]);
  const a = Math.max(0, N - window), idx = [...Array(N - a).keys()].map((k) => k + a);
  const lows = idx.map((i) => s.l[i]), highs = idx.map((i) => s.h[i]);
  let lo = Math.min(...lows), hi = Math.max(...highs);
  for (const [, , L] of lines) for (const i of idx) if (L[i] != null) { lo = Math.min(lo, L[i]); hi = Math.max(hi, L[i]); }
  // keep lines that sit far outside the candles from flattening the chart
  lo = Math.max(lo, Math.min(...lows) / 1.6); hi = Math.min(hi, Math.max(...highs) * 1.6);
  const padT = title ? 22 : 8, padB = 18, padL = 6, padR = 64;
  const W = width - padL - padR, H = height - padT - padB;
  const ly = (v) => padT + H - ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * H;
  const bw = W / idx.length, x = (k) => padL + bw * k + bw / 2;
  const inRange = (v) => v != null && v >= lo && v <= hi;
  const parts = [];
  // grid: 4 log-spaced price labels
  for (let g = 0; g <= 3; g++) {
    const v = Math.exp(Math.log(lo) + ((Math.log(hi) - Math.log(lo)) * g) / 3);
    const y = ly(v);
    parts.push(`<line x1="${padL}" x2="${padL + W}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="currentColor" stroke-opacity="0.12"/>`);
    parts.push(`<text x="${padL + W + 4}" y="${(y + 3).toFixed(1)}" font-size="10" fill="currentColor" fill-opacity="0.6">${fmt(v)}</text>`);
  }
  // month ticks
  let prevM = null;
  idx.forEach((i, k) => {
    const d = new Date(s.t[i] * 1000), m = d.getUTCMonth();
    if (prevM !== null && m !== prevM) {
      parts.push(`<line x1="${x(k).toFixed(1)}" x2="${x(k).toFixed(1)}" y1="${padT}" y2="${padT + H}" stroke="currentColor" stroke-opacity="0.06"/>`);
      parts.push(`<text x="${x(k).toFixed(1)}" y="${height - 5}" font-size="10" text-anchor="middle" fill="currentColor" fill-opacity="0.55">${d.getUTCFullYear() % 100}.${m + 1}</text>`);
    }
    prevM = m;
  });
  // candles
  const cw = Math.max(1, bw * 0.7);
  idx.forEach((i, k) => {
    const up = s.c[i] >= s.o[i], col = up ? '#16a34a' : '#dc2626';
    const yo = ly(Math.min(Math.max(s.o[i], lo), hi)), yc = ly(Math.min(Math.max(s.c[i], lo), hi));
    const yh = ly(Math.min(s.h[i], hi)), yl = ly(Math.max(s.l[i], lo));
    parts.push(`<line x1="${x(k).toFixed(1)}" x2="${x(k).toFixed(1)}" y1="${yh.toFixed(1)}" y2="${yl.toFixed(1)}" stroke="${col}" stroke-width="1"/>`);
    parts.push(`<rect x="${(x(k) - cw / 2).toFixed(1)}" y="${Math.min(yo, yc).toFixed(1)}" width="${cw.toFixed(1)}" height="${Math.max(0.8, Math.abs(yc - yo)).toFixed(1)}" fill="${col}"/>`);
  });
  // SMA lines
  for (const [n, col, L] of lines) {
    let d = '', pen = false;
    idx.forEach((i, k) => {
      if (inRange(L[i])) { d += `${pen ? 'L' : 'M'}${x(k).toFixed(1)},${ly(L[i]).toFixed(1)}`; pen = true; } else pen = false;
    });
    if (d) parts.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="${n >= 200 ? 1.8 : 1.3}"/>`);
  }
  // HMA crosses every STRIDE bars counted back from today
  const step = STRIDE[window] || Math.max(1, Math.round(window / 60));
  for (const [, col, L] of hmas) {
    idx.forEach((i, k) => {
      if ((idx.length - 1 - k) % step !== 0 || !inRange(L[i])) return;
      const cx = x(k), cy = ly(L[i]), r = 2.6;
      parts.push(`<path d="M${(cx - r).toFixed(1)},${(cy - r).toFixed(1)}L${(cx + r).toFixed(1)},${(cy + r).toFixed(1)}M${(cx - r).toFixed(1)},${(cy + r).toFixed(1)}L${(cx + r).toFixed(1)},${(cy - r).toFixed(1)}" stroke="${col}" stroke-width="1.2"/>`);
    });
  }
  // last price tag
  const lastC = s.c[N - 1];
  if (inRange(lastC)) {
    const y = ly(lastC);
    parts.push(`<rect x="${padL + W + 1}" y="${(y - 7).toFixed(1)}" width="${padR - 2}" height="14" rx="2" fill="currentColor" fill-opacity="0.85"/>`);
    parts.push(`<text x="${padL + W + 4}" y="${(y + 3.5).toFixed(1)}" font-size="10" font-weight="600" class="tag">${fmt(lastC)}</text>`);
  }
  if (title) parts.push(`<text x="${padL}" y="14" font-size="12" font-weight="600" fill="currentColor">${esc(title)}</text>`);
  const legend = [...MA.map(([n, c]) => [`SMA${n}`, c, 'line']), ...HM.slice().reverse().map(([n, c]) => [`HMA${n}`, c, 'x'])];
  let lx = title ? padL + 14 + [...title].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2000 ? 12.5 : 7.4), 0) : padL;
  for (const [name, col] of legend) {
    parts.push(`<text x="${lx.toFixed(0)}" y="14" font-size="9.5" fill="${col}">${name}</text>`);
    lx += name.length * 6 + 8;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(title)} 일봉 ${window}일" style="max-width:${width}px;font-family:ui-monospace,Menlo,Consolas,monospace"><style>.tag{fill:Canvas}</style>${parts.join('')}</svg>`;
}
