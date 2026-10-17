// Indicators. Arrays are oldest -> newest. All functions are pure.
export const DAY = 86400;

export function sma(a, n) {
  const o = new Array(a.length).fill(null);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i];
    if (i >= n) s -= a[i - n];
    if (i >= n - 1) o[i] = s / n;
  }
  return o;
}

// Linear WMA: newest bar weight n, oldest weight 1. null input inside the window -> null.
export function wma(a, n) {
  const o = new Array(a.length).fill(null);
  if (n < 1) return o;
  const den = (n * (n + 1)) / 2;
  for (let i = n - 1; i < a.length; i++) {
    let s = 0, ok = true;
    for (let j = 0; j < n; j++) {
      const x = a[i - j];
      if (x == null || !Number.isFinite(x)) { ok = false; break; }
      s += x * (n - j);
    }
    o[i] = ok ? s / den : null;
  }
  return o;
}

// Hull MA, TradingView ta.hma: WMA(2*WMA(n/2) - WMA(n), floor(sqrt(n)))
export function hma(a, n) {
  const w1 = wma(a, Math.floor(n / 2)), w2 = wma(a, n);
  const raw = a.map((_, i) => (w1[i] == null || w2[i] == null ? null : 2 * w1[i] - w2[i]));
  return wma(raw, Math.floor(Math.sqrt(n)));
}

const pct = (x, y) => (x == null || y == null || y === 0 ? null : (x / y - 1) * 100);
export const r2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));
export const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);

// Split a series into closed bars and the in-progress bar (daily bars open at 00:00 UTC).
export function splitClosed(s, nowMs = Date.now()) {
  const n = s.t.length;
  const liveOpen = n && s.t[n - 1] * 1000 + DAY * 1000 > nowMs;
  const k = liveOpen ? n - 1 : n;
  return {
    t: s.t.slice(0, k), c: s.c.slice(0, k),
    o: s.o?.slice(0, k), h: s.h?.slice(0, k), l: s.l?.slice(0, k),
    live: liveOpen ? s.c[n - 1] : null, liveT: liveOpen ? s.t[n - 1] : null,
  };
}

// Consecutive closed bars on the current side of a line (the latest bar counts as 1).
function sideAge(c, line) {
  const n = c.length;
  let i = n - 1;
  if (line[i] == null) return { side: null, days: null, since: null };
  const above = c[i] > line[i];
  let days = 0;
  while (i >= 0 && line[i] != null && (c[i] > line[i]) === above) { days++; i--; }
  return { side: above ? 'above' : 'below', days, sinceIdx: n - days, complete: i >= 0 && line[i] != null };
}

// One line (SMA n / HMA n) against a closed series, plus "if today closed at the live price".
function lineReport(kind, n, cl, t, live) {
  const f = kind === 'hma' ? hma : sma;
  const line = f(cl, n);
  const i = cl.length - 1;
  if (line[i] == null) return null;
  const a = sideAge(cl, line);
  const out = {
    line: line[i], dist: r2(pct(cl[i], line[i])), side: a.side, days: a.days,
    since: a.sinceIdx != null ? iso(t[a.sinceIdx]) : null,
  };
  if (kind === 'hma' && line[i - 5] != null) out.slope5 = r2(pct(line[i], line[i - 5]));
  if (kind === 'sma' && n >= 200 && line[i - 20] != null) out.slope20 = r2(pct(line[i], line[i - 20]));
  if (live != null) {
    const ext = cl.concat([live]);
    const l2 = f(ext, n), j = ext.length - 1;
    if (l2[j] != null) {
      out.liveLine = l2[j];
      out.liveDist = r2(pct(live, l2[j]));
      const liveSide = live > l2[j] ? 'above' : 'below';
      out.crossIfClose = liveSide !== a.side;
    }
  }
  return out;
}

// TradingView-style buckets for WMA200 multiples (nD restart every Jan 1; 1W Monday-based).
function bucketKey(tf, day) {
  const m = /^(\d+)([DW])$/.exec(tf), k = Number(m[1]), u = m[2];
  if (u === 'D' && k === 1) return day;
  const t = new Date(day * DAY * 1000), y = t.getUTCFullYear(), jan1 = Date.UTC(y, 0, 1) / (DAY * 1000);
  if (u === 'D') return y * 1000 + Math.floor((day - jan1) / k);
  if (k === 1) return Math.floor((day + 3) / 7);
  const firstMon = (yy) => { const j = Date.UTC(yy, 0, 1) / (DAY * 1000); return j + ((1 - ((j + 4) % 7) + 7) % 7); };
  const cy = day >= firstMon(y) ? y : y - 1;
  return cy * 100 + Math.floor(Math.floor((day - firstMon(cy)) / 7) / k);
}

// value / WMA200 of bucket closes, the current (possibly partial) bucket included. t: unix seconds.
export function wmaMultiple(t, c, tf, n = 200) {
  const closes = [];
  let prev = null;
  for (let i = 0; i < t.length; i++) {
    const k = bucketKey(tf, Math.floor(t[i] / DAY));
    if (k !== prev) { closes.push(c[i]); prev = k; } else closes[closes.length - 1] = c[i];
  }
  if (closes.length < n) return null;
  const w = wma(closes, n).at(-1);
  return w ? r2(closes.at(-1) / w, 3) : null;
}

// Full report for one daily series. opts.lines: e.g. ['sma50','hma144','sma365','sma1461'].
export function report(s, { lines = ['sma50', 'hma144', 'sma200', 'sma365'], multiples = ['1D', '1W'], pp = false, nowMs = Date.now() } = {}) {
  const k = splitClosed(s, nowMs);
  const cl = k.c, t = k.t, n = cl.length;
  if (!n) return { err: 'no closed bars' };
  const last = cl[n - 1];
  const ch = (back) => (n > back ? (pp ? r2(last - cl[n - 1 - back], 3) : r2(pct(last, cl[n - 1 - back]))) : null);
  const out = {
    bars: n, first: iso(t[0]), closeDate: iso(t[n - 1]), close: last, live: k.live,
    liveChg: k.live == null ? null : (pp ? r2(k.live - last, 3) : r2(pct(k.live, last))),
    chg1d: ch(1), chg7d: ch(7), chg30d: ch(30), unit: pp ? '%p' : '%',
  };
  const w40 = cl.slice(-41, -1);
  if (w40.length >= 20) { out.range40 = { hi: Math.max(...w40), lo: Math.min(...w40) }; }
  for (const spec of lines) {
    const m = /^(sma|hma)(\d+)$/.exec(spec);
    if (!m) continue;
    out[spec] = lineReport(m[1], Number(m[2]), cl, t, k.live);
  }
  // multiples use every bar including the live one
  out.wma200x = {};
  for (const tf of multiples) out.wma200x[tf] = wmaMultiple(s.t, s.c, tf);
  return out;
}

// Ratio of two series on common timestamps.
export function ratio(a, b) {
  const mb = new Map(b.t.map((t, i) => [t, b.c[i]]));
  const t = [], c = [];
  a.t.forEach((x, i) => { const y = mb.get(x); if (y) { t.push(x); c.push(a.c[i] / y); } });
  return { t, c, o: c, h: c, l: c };
}

// Sum of two series on common timestamps (e.g. USDT.D + USDC.D).
export function sum(a, b) {
  const mb = new Map(b.t.map((t, i) => [t, b.c[i]]));
  const t = [], c = [];
  a.t.forEach((x, i) => { const y = mb.get(x); if (y != null) { t.push(x); c.push(a.c[i] + y); } });
  return { t, c, o: c, h: c, l: c };
}

export const median = (a) => {
  const w = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!w.length) return null;
  const m = w.length >> 1;
  return w.length % 2 ? w[m] : (w[m - 1] + w[m]) / 2;
};

// 365-line scan values for one closed series (v7/v9 definitions: the bar that closed above is age 1).
export function scan365(t, c, live) {
  const n = c.length;
  if (n < 366) return null;
  const line = sma(c, 365), i = n - 1;
  let age = 0;
  for (let k = n - 1; k >= 364; k--) {
    const ab = c[k] > line[k];
    if (k === n - 1) age = ab ? 1 : -1;
    else if ((age > 0) === ab) age += ab ? 1 : -1;
    else break;
  }
  let below = 0;
  if (age > 0) for (let k = i - age; k >= 364 && c[k] <= line[k]; k--) below++;
  const lineLive = live == null ? null : (line[i] * 365 - c[n - 365] + live) / 365;
  const ago = (d) => (i - d >= 364 && line[i - d] ? (c[i - d] / line[i - d] - 1) * 100 : null);
  return {
    age, below,
    dist: r2(pct(c[i], line[i])),
    live: live == null ? null : r2(pct(live, lineLive)),
    slope20: i - 20 >= 364 ? r2(pct(line[i], line[i - 20])) : null,
    dayRet: r2(pct(c[i], c[i - 1])),
    dist5ago: r2(ago(5)), dist30ago: r2(ago(30)),
    ret7: r2(pct(c[i], c[i - 7])), ret30: r2(pct(c[i], c[i - 30])),
    closeDate: iso(t[i]),
    spliced: (() => { const w = c.slice(-365); const lo = Math.min(...w); return lo > 0 && Math.max(...w) / lo > 100; })(),
  };
}
