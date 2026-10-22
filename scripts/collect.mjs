// Daily crypto briefing collector. Runs on GitHub Actions (unrestricted egress) and writes
// data/latest.json (+ data/latest-<slot>.json, data/charts/*.svg, data/log.csv) for the Claude cloud
// scheduled tasks, which cannot reach these sites themselves.
//
// Env:
//   SLOT        morning | followup (default: by KST time, 06:00-08:59 = followup, otherwise morning;
//               a run after the 09:00 daily close counts as the next day's morning)
//   LOCAL_DIR   test mode: read {id,d0,c} daily-close files (wma0.3-screenshot data/daily format)
//               instead of TradingView, and skip HTTP sources
//   SKIP        comma list of sections to skip (ledger,snapshot,ma,top10,cptra,igv,movers,deriv,scan,sectors,charts)
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { createTV } from './lib/tv.mjs';
import { report, ratio, sum, splitClosed, scan365, median, r2, iso, sma, DAY } from './lib/ind.mjs';
import { chartSVG, cptraSVG } from './lib/chart.mjs';

const OUT = process.env.OUT_DIR || 'data';
const LOCAL = process.env.LOCAL_DIR || null;
const SKIP = new Set((process.env.SKIP || '').split(',').map((s) => s.trim()).filter(Boolean));
const NOW = Date.now();
const kstHour = new Date(NOW + 9 * 3600e3).getUTCHours() + new Date(NOW + 9 * 3600e3).getUTCMinutes() / 60;
const SLOT = process.env.SLOT || (kstHour >= 6 && kstHour < 9 ? 'followup' : 'morning');
// the 06:10 brief this run feeds: after the 09:00 KST close it is tomorrow's
const BRIEF_DATE = new Date(NOW + 9 * 3600e3 + (kstHour >= 9 ? DAY * 1000 : 0)).toISOString().slice(0, 10);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const out = {
  meta: { generatedAt: new Date(NOW).toISOString(), generatedKST: new Date(NOW + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16), slot: SLOT, briefDate: BRIEF_DATE, local: !!LOCAL, sections: {}, failures: [] },
};
const fail = (section, what, err) => { out.meta.failures.push({ section, what, error: String(err?.message || err).slice(0, 200) }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await mkdir(OUT, { recursive: true });

// ---------------- sources ----------------
const tv = LOCAL ? localTV(LOCAL) : createTV();
const tvPool = LOCAL ? [tv] : [tv, createTV(), createTV()];

function localTV(dir) {
  return {
    async daily(symbol, { count = 2000 } = {}) {
      const fileOf = (x) => path.join(dir, x.replace(/[^A-Za-z0-9.]+/g, '_') + '.json');
      let d;
      try { d = JSON.parse(await readFile(fileOf(symbol), 'utf8')); }
      catch { d = JSON.parse(await readFile(fileOf(symbol.replace(/^BITSTAMP:/, 'CRYPTO:')), 'utf8')); }
      const t = [], c = [];
      d.c.forEach((v, i) => { if (v != null) { t.push((d.d0 + i) * DAY); c.push(v); } });
      const k = Math.max(0, t.length - count);
      const tt = t.slice(k), cc = c.slice(k);
      const o = cc.map((v, i) => (i ? cc[i - 1] : v));
      return { symbol, t: tt, c: cc, o, h: cc.map((v, i) => Math.max(v, o[i]) * 1.01), l: cc.map((v, i) => Math.min(v, o[i]) * 0.99), v: cc.map(() => null) };
    },
    close() {},
  };
}

async function http(url, { json = true, tries = 3, timeout = 20000, headers = {}, method = 'GET', body } = {}) {
  if (LOCAL) throw new Error('offline (LOCAL_DIR test mode)');
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { method, body, headers: { 'user-agent': UA, accept: json ? 'application/json' : '*\/*', ...headers }, signal: AbortSignal.timeout(timeout) });
      if (r.status === 429 || r.status === 418 || r.status >= 500) { last = new Error(`HTTP ${r.status}`); await sleep(4000 * (i + 1) * (r.status === 429 ? 4 : 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 80)}`);
      return json ? await r.json() : await r.text();
    } catch (e) { last = e; if (String(e.message).startsWith('HTTP 4')) break; await sleep(1500 * (i + 1)); }
  }
  throw last;
}

async function section(name, fn) {
  if (SKIP.has(name)) { out.meta.sections[name] = 'skipped'; return; }
  const t0 = Date.now();
  try { await fn(); out.meta.sections[name] = `ok ${((Date.now() - t0) / 1000).toFixed(1)}s`; }
  catch (e) { out.meta.sections[name] = 'failed'; fail(name, 'section', e); console.error(`[${name}]`, e); }
  console.log(`[${name}] ${out.meta.sections[name]}`);
}

const series = {}; // symbol -> daily series (kept for charts / ratios)
async function getSeries(symbol, opts = {}, pool = tv) {
  if (series[symbol] && (series[symbol].t.length >= (opts.count || 0) || series[symbol].full)) return series[symbol];
  const s = await pool.daily(symbol, opts);
  if (!s.t.length) throw new Error('no bars');
  series[symbol] = s;
  return s;
}

// ---------------- 1. dominance ledger (천하삼분 원장) ----------------
const DOM = ['BTC.D', 'USDT.D', 'USDC.D', 'OTHERS.D', 'OTHERS', 'TOTALE50.D', 'TOTALE100.D', 'TOTAL', 'TOTAL3ESBTC'];
await section('ledger', async () => {
  out.ledger = {};
  const lines = ['sma50', 'hma144', 'sma200', 'sma365', 'sma1461'];
  for (const k of DOM) {
    const sym = `CRYPTOCAP:${k}`;
    try {
      const s = await getSeries(sym, { count: 5000, more: true });
      out.ledger[k] = report(s, { lines, multiples: ['1D', '3D', '1W'], pp: k.endsWith('.D'), nowMs: NOW });
    } catch (e) { fail('ledger', sym, e); out.ledger[k] = { err: String(e.message) }; }
  }
  const a = series['CRYPTOCAP:USDT.D'], b = series['CRYPTOCAP:USDC.D'];
  if (a && b) out.ledger['ΣSTABLECOIN.D'] = { ...report(sum(a, b), { lines, multiples: ['1D', '1W'], pp: true, nowMs: NOW }), note: 'USDT.D + USDC.D (구성 지표 합)' };
  const bd = series['CRYPTOCAP:BTC.D'], od = series['CRYPTOCAP:OTHERS.D'];
  if (bd && od) out.ledger['BTC.D/OTHERS.D'] = { ...report(ratio(bd, od), { lines: ['sma50', 'hma144', 'sma365'], multiples: ['1D'], nowMs: NOW }), note: '구성 지표 비' };
  // B alert (BTC.D 급락 감시): 1d <= -0.5%p or 7d <= -1.5%p AND BTCUSD up (filled after ma section)
});

// ---------------- 2. current snapshot (scanner API, 09:00 KST-based change) ----------------
const WATCH = ['XMRUSD', 'ZECUSD', 'RUNEUSD', 'HYPEHUSD', 'ARBIUSD', 'UNIUSD', 'USELESSUSD', 'SPX6USD'];
await section('snapshot', async () => {
  out.snapshot = {};
  const syms = [...DOM.map((k) => `CRYPTOCAP:${k}`), 'BITSTAMP:BTCUSD', 'BITSTAMP:ETHUSD', ...WATCH.map((k) => `CRYPTO:${k}`)];
  for (const s of syms) {
    try {
      const j = await http(`https://scanner.tradingview.com/symbol?symbol=${encodeURIComponent(s)}&fields=close,change,change_abs,Perf.W,Perf.1M,Perf.3M&no_404=true`, { tries: 2 });
      out.snapshot[s] = { close: j.close, change: r2(j.change, 3), change_abs: j.change_abs, perfW: r2(j['Perf.W'], 3), perf1M: r2(j['Perf.1M'], 3), perf3M: r2(j['Perf.3M'], 3) };
    } catch (e) { fail('snapshot', s, e); }
    await sleep(150);
  }
  out.snapshot._note = 'change = 09:00 KST(00:00 UTC) 기준 당일 변동률. 도미넌스는 %이며 %p가 아니다(%p는 ledger의 liveChg).';
});

// ---------------- 3. moving averages: BTC, ETH, watchlist, XMR/ZEC ----------------
await section('ma', async () => {
  out.ma = {};
  const lines = ['sma50', 'hma144', 'sma200', 'sma365'];
  const list = [['BTC', 'BITSTAMP:BTCUSD'], ['ETH', 'BITSTAMP:ETHUSD'], ...WATCH.map((k) => [k.replace(/USD$/, '').replace(/^HYPEH$/, 'HYPE').replace(/^ARBI$/, 'ARB').replace(/^SPX6$/, 'SPX6900'), `CRYPTO:${k}`])];
  for (const [name, sym] of list) {
    try {
      const s = await getSeries(sym, { count: 2000 });
      out.ma[name] = { symbol: sym, ...report(s, { lines, multiples: ['1D', '1W'], nowMs: NOW }) };
    } catch (e) { fail('ma', sym, e); out.ma[name] = { symbol: sym, err: String(e.message) }; }
  }
  const x = series['CRYPTO:XMRUSD'], z = series['CRYPTO:ZECUSD'];
  if (x && z) out.ma['XMR/ZEC'] = { symbol: 'CRYPTO:XMRUSD/CRYPTO:ZECUSD', ...report(ratio(x, z), { lines, multiples: ['1D', '2D', '3D', '4D', '1W'], nowMs: NOW }) };
  const b = out.ma.BTC;
  if (b?.sma50) out.premise = { rule: 'BTCUSD 일봉 종가가 SMA50 위 (DONGWOO 관찰의 전제)', closeDate: b.closeDate, close: b.close, sma50: r2(b.sma50.line, 1), dist: b.sma50.dist, liveDist: b.sma50.liveDist ?? null, holds: b.sma50.side === 'above', crossIfClose: !!b.sma50.crossIfClose };
  const L = out.ledger?.['BTC.D'];
  if (L && b) {
    const btcUp1 = (b.chg1d ?? 0) > 0, btcUp7 = (b.chg7d ?? 0) > 0;
    out.btcdAlert = { d1: L.chg1d, d7: L.chg7d, btcChg1d: b.chg1d, btcChg7d: b.chg7d, fired: (L.chg1d <= -0.5 && btcUp1) || (L.chg7d <= -1.5 && btcUp7), rule: 'BTC.D 1일 −0.5%p 이하 또는 1주 −1.5%p 이하 AND BTCUSD 상승' };
  }
});

// ---------------- 4. top 10 ex-BTC (CoinGecko market-cap order, stables/wrapped out) ----------------
const STABLE = new Set('USDT USDC USDE DAI USDS FDUSD PYUSD USD1 TUSD USDP RLUSD USDD FRAX USDG USDTB BUIDL USYC SUSDE SUSDS USD0 GHO CRVUSD EURC EURS XAUT PAXG BFUSD USDF USDX'.split(' '));
const WRAPPED = /wrapped|staked|bridged|liquid staking|restaked| lst\b|wbtc|weth|steth|cbbtc|lbtc|jitosol|bnsol|msol|rseth|ezeth|weeth/i;
const cgTop = {};
async function coingeckoTop(pages = 4) {
  if (cgTop[pages]) return cgTop[pages];
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const j = await http(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${p}&price_change_percentage=24h,7d`, { tries: 4 });
    all.push(...j);
    await sleep(2500);
  }
  cgTop[pages] = all;
  return all;
}
let tvMap = null;
async function tickerMap() {
  if (tvMap) return tvMap;
  tvMap = { byCg: {}, bySym: {} };
  try {
    const j = LOCAL ? JSON.parse(await readFile(path.join(LOCAL, '..', 'tickers.json'), 'utf8'))
      : await http('https://raw.githubusercontent.com/tlzkrh1029/wma0.3-screenshot/HEAD/data/tickers.json');
    for (const c of j.coins || []) {
      if (!c.usd) continue;
      tvMap.byCg[c.cg] = c.usd;
      (tvMap.bySym[c.sym.toUpperCase()] ||= []).push({ usd: c.usd, cg: c.cg, rank: c.rank, conf: c.confidence });
    }
  } catch (e) { fail('tickers', 'wma0.3 tickers.json', e); }
  return tvMap;
}
const isStable = (c) => STABLE.has(String(c.symbol).toUpperCase()) || WRAPPED.test(c.name) || WRAPPED.test(c.id);

await section('top10', async () => {
  let coins;
  if (LOCAL) {
    const j = JSON.parse(await readFile(path.join(LOCAL, '..', 'tickers.json'), 'utf8'));
    coins = j.coins.slice(0, 40).map((c) => ({ id: c.cg, symbol: c.sym, name: c.name, market_cap_rank: c.rank }));
  } else coins = await coingeckoTop(1);
  const map = await tickerMap();
  const pick = coins.filter((c) => String(c.symbol).toUpperCase() !== 'BTC' && !isStable(c)).slice(0, 25);
  const rows = [], skipped = [];
  for (const c of pick) {
    if (rows.length >= 10) break;
    const sym = map.byCg[c.id] || `CRYPTO:${String(c.symbol).toUpperCase()}USD`;
    try {
      const s = await getSeries(sym, { count: 900 });
      const r = report(s, { lines: ['sma50', 'hma144', 'sma365'], multiples: [], nowMs: NOW });
      rows.push({ sym: String(c.symbol).toUpperCase(), rank: c.market_cap_rank, tv: sym, close: r.close, sma50: r.sma50 && { dist: r.sma50.dist, side: r.sma50.side, days: r.sma50.days, liveDist: r.sma50.liveDist }, sma365: r.sma365 && { dist: r.sma365.dist, side: r.sma365.side, days: r.sma365.days, liveDist: r.sma365.liveDist }, hma144: r.hma144 && { dist: r.hma144.dist } });
    } catch (e) { skipped.push({ sym: String(c.symbol).toUpperCase(), rank: c.market_cap_rank, tv: sym, err: String(e.message).slice(0, 80) }); }
  }
  const ok = rows.filter((r) => r.sma50);
  out.top10 = {
    rows, skipped,
    summary: {
      below50: ok.filter((r) => r.sma50.side === 'below').length,
      near365: ok.filter((r) => r.sma365 && Math.abs(r.sma365.dist) <= 1).length,
      below365: ok.filter((r) => r.sma365?.side === 'below').length,
      n: ok.length,
    },
    note: 'CoinGecko 시총 순, BTC·스테이블·래핑/스테이킹 토큰 제외. 가격은 TradingView CRYPTO:{SYM}USD 일봉.',
  };
});

// ---------------- 5. cptra (miner revenue USD / tx count) ----------------
// same calculation as tlzkrh1029/pinescript cost-per-transaction/btc_cost_per_transaction.pine ("BTC %ex")
let cptraP = null;
await section('cptra', async () => {
  const rv = await getSeries('COINMETRICS:BTC_MINERREVENUEUSD', { count: 1500 });
  const tx = await getSeries('COINMETRICS:BTC_TXCOUNT', { count: 1500 });
  const m = new Map(tx.t.map((t, i) => [t, tx.c[i]]));
  const t = [], v = [];
  rv.t.forEach((x, i) => { const n = m.get(x); if (n > 0) { t.push(x); v.push(rv.c[i] / n); } });
  const norm = v.map((x, i) => { if (i < 99) return null; const w = v.slice(i - 99, i + 1); const lo = Math.min(...w), hi = Math.max(...w); return hi > lo ? (x - lo) / (hi - lo) : 0.5; });
  const nn = norm.map((x) => x ?? 0), valid = norm.findIndex((x) => x != null);
  const smaN = (n) => sma(nn, n).map((x, i) => (i - n + 1 >= valid ? x : null));
  const s5 = smaN(5), s50 = smaN(50), s200 = smaN(200), i = v.length - 1;
  let crossDate = null, crossDir = null;
  for (let k = i; k > 0; k--) {
    if (s50[k] == null || s200[k] == null || s50[k - 1] == null || s200[k - 1] == null) break;
    if ((s50[k] > s200[k]) !== (s50[k - 1] > s200[k - 1])) { crossDate = iso(t[k]); crossDir = s50[k] > s200[k] ? 'up' : 'down'; break; }
  }
  const last365 = v.slice(-365);
  cptraP = { t: t.map((x) => x), s5, s50, s200, lastCross: crossDate && { date: crossDate, dir: crossDir } };
  out.cptra = {
    date: iso(t[i]), value: r2(v[i]), norm: r2(norm[i], 3), sma5: r2(s5[i], 3), sma50: r2(s50[i], 3), sma200: r2(s200[i], 3),
    sma50AboveSma200: s50[i] > s200[i], lastCross: crossDate && { date: crossDate, dir: crossDir },
    pct365: r2(last365.filter((x) => x <= v[i]).length / last365.length, 3),
    note: 'COINMETRICS:BTC_MINERREVENUEUSD ÷ BTC_TXCOUNT, 100봉 최저·최고 정규화. Coin Metrics 일봉은 하루 늦다. 수준은 BTC 가격과 상관이 높다(1년 0.82, 2026-10-17 계산).',
  };
});

// ---------------- 6. IGV (Yahoo chart API) ----------------
await section('igv', async () => {
  out.igv = {};
  for (const tk of ['IGV', 'SMH', 'SPY']) {
    try {
      const j = await http(`https://query1.finance.yahoo.com/v8/finance/chart/${tk}?range=5y&interval=1d`, { tries: 3 });
      const r0 = j.chart.result[0], q = r0.indicators.quote[0], ac = r0.indicators.adjclose?.[0]?.adjclose || q.close;
      const t = [], c = [];
      r0.timestamp.forEach((x, i) => { if (ac[i] != null) { t.push(x); c.push(ac[i]); } });
      // US daily bars: treat every returned bar as closed (the collector runs outside US hours)
      const s = { t, c, o: c, h: c, l: c };
      const rep = report(s, { lines: ['sma50', 'hma144', 'sma365'], multiples: [], nowMs: (t.at(-1) + 2 * DAY) * 1000 });
      out.igv[tk] = { ...rep, note: '365 SMA는 거래일 365개(약 17개월)' };
    } catch (e) { fail('igv', tk, e); }
  }
});

// ---------------- 7. movers (CoinGecko top 1000, 24h) + rotation index ----------------
await section('movers', async () => {
  const all = await coingeckoTop(4);
  const rows = all.filter((c) => !isStable(c) && c.total_volume >= 1e6 && c.price_change_percentage_24h != null).map((c) => ({
    sym: String(c.symbol).toUpperCase(), name: c.name, id: c.id, rank: c.market_cap_rank, price: c.current_price,
    chg24h: r2(c.price_change_percentage_24h), chg7d: r2(c.price_change_percentage_7d_in_currency), mcap: c.market_cap, vol: c.total_volume,
    turnover: c.market_cap ? r2(c.total_volume / c.market_cap, 3) : null,
  }));
  const g = [...rows].sort((a, b) => b.chg24h - a.chg24h), l = [...rows].sort((a, b) => a.chg24h - b.chg24h);
  out.movers = {
    universe: `CoinGecko 시총 1,000위 안, 24h 거래대금 $1M 이상, 스테이블 제외 (${rows.length}종)`,
    gainers: g.slice(0, 15), losers: l.slice(0, 15),
    weekGainers: [...rows].filter((r) => r.chg7d != null).sort((a, b) => b.chg7d - a.chg7d).slice(0, 15),
    turnoverTop: [...rows].filter((r) => r.mcap > 2e7).sort((a, b) => b.turnover - a.turnover).slice(0, 10),
    rotationIndex: { value: median(g.slice(0, 10).map((r) => r.rank)), ranks: g.slice(0, 10).map((r) => r.rank), def: '24h 상승 상위 10종의 시총 순위 중앙값. 100 이내 = 대형주, 300 이상 = 꼬리까지 확산' },
    breadth: { up: rows.filter((r) => r.chg24h > 0).length, down: rows.filter((r) => r.chg24h < 0).length },
  };
  out.ranks = Object.fromEntries(all.map((c) => [String(c.symbol).toUpperCase() + ':' + c.id, c.market_cap_rank]));
});

// ---------------- 8. derivatives (Hyperliquid public API) ----------------
await section('deriv', async () => {
  const j = await http('https://api.hyperliquid.xyz/info', { method: 'POST', body: JSON.stringify({ type: 'metaAndAssetCtxs' }), headers: { 'content-type': 'application/json' } });
  const [meta, ctxs] = j;
  const want = new Set(['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'ZEC', 'XMR', 'DOGE']);
  const rows = [];
  meta.universe.forEach((u, i) => {
    if (!want.has(u.name)) return;
    const c = ctxs[i];
    const mark = Number(c.markPx), oi = Number(c.openInterest) * mark;
    rows.push({ coin: u.name, mark, fundingHourly: Number(c.funding), fundingAnnual: r2(Number(c.funding) * 24 * 365 * 100), oiUSD: Math.round(oi), vol24hUSD: Math.round(Number(c.dayNtlVlm)), premium: Number(c.premium), prevDayPx: Number(c.prevDayPx) });
  });
  out.deriv = { source: 'Hyperliquid metaAndAssetCtxs (거래소 하나의 값. 시장 전체 롱숏·청산은 아니다)', rows };
});

// ---------------- 9. 365-line scan (Upbit + Bithumb KRW universe, USD daily) ----------------
const KRW_STABLE = new Set([...STABLE, 'USDT', 'USDC', 'EUR', 'USTC', 'WBTC', 'WBETH', 'BNSOL', 'PAXG', 'XAUT', 'U', 'XUSD', 'KGST', 'EURI', 'JPYC']);
function scanMembers() { return out._scanMembers || []; }
await section('scan', async () => {
  const prev = await readJSON(path.join(OUT, 'latest-morning.json'));
  if (SLOT !== 'morning' && prev?.scan) {
    // follow-up: keep the morning scan, refresh live dist for candidates only
    out.scan = prev.scan;
    out.scan.refreshedLive = [];
    const want = new Set([...(prev.scan.fresh || []).map((r) => r.sym), ...(prev.scan.near || []).map((r) => r.sym), ...(prev.scan.tracked || []).map((r) => r.sym)]);
    for (const r of [...(prev.scan.fresh || []), ...(prev.scan.near || []), ...(prev.scan.tracked || [])]) {
      if (!want.has(r.sym) || !r.tv) continue;
      want.delete(r.sym);
      try {
        const s = await tv.daily(r.tv, { count: 420 });
        const k = splitClosed(s, NOW), v = scan365(k.t, k.c, k.live);
        if (v) out.scan.refreshedLive.push({ sym: r.sym, tv: r.tv, closeDate: v.closeDate, dist: v.dist, live: v.live, age: v.age });
      } catch (e) { fail('scan', r.tv, e); }
    }
    return;
  }
  let universe = [];
  const bySrc = { tv: 0, upbit: 0, bithumb: 0 }, failed = [];
  let usdtKrw = null, refKrw = {};
  if (LOCAL) {
    const j = JSON.parse(await readFile(path.join(LOCAL, '..', 'tickers.json'), 'utf8'));
    universe = j.coins.filter((c) => c.usd && !STABLE.has(c.sym)).slice(0, 150).map((c) => ({ sym: c.sym.toUpperCase(), upbit: true, bithumb: false }));
  } else {
    const up = (await http('https://api.upbit.com/v1/market/all?is_details=true')).filter((m) => m.market.startsWith('KRW-'));
    const bt = (await http('https://api.bithumb.com/v1/market/all?isDetails=false')).filter((m) => m.market.startsWith('KRW-'));
    const U = new Map(up.map((m) => [m.market.slice(4), m])), B = new Map(bt.map((m) => [m.market.slice(4), m]));
    universe = [...new Set([...U.keys(), ...B.keys()])].filter((s) => !KRW_STABLE.has(s)).map((s) => ({ sym: s, name: U.get(s)?.english_name || B.get(s)?.english_name || '', kname: U.get(s)?.korean_name || B.get(s)?.korean_name || '', upbit: U.has(s), bithumb: B.has(s), caution: U.get(s)?.market_event?.warning || false }));
    // reference KRW prices (Upbit ticker in chunks, Bithumb ticker for the rest)
    const upSyms = [...U.keys()];
    for (let i = 0; i < upSyms.length; i += 100) {
      try {
        const tk = await http(`https://api.upbit.com/v1/ticker?markets=${upSyms.slice(i, i + 100).map((s) => 'KRW-' + s).join(',')}`);
        for (const x of tk) refKrw[x.market.slice(4)] = x.trade_price;
      } catch (e) { fail('scan', 'upbit ticker', e); }
      await sleep(150);
    }
    try {
      const all = await http('https://api.bithumb.com/public/ticker/ALL_KRW');
      for (const [s, x] of Object.entries(all.data || {})) if (x?.closing_price && refKrw[s] == null) refKrw[s] = Number(x.closing_price);
    } catch (e) { fail('scan', 'bithumb ticker', e); }
    usdtKrw = refKrw.USDT || null;
    if (!usdtKrw) { try { const tk = await http('https://api.upbit.com/v1/ticker?markets=KRW-USDT'); usdtKrw = tk[0].trade_price; } catch (e) { fail('scan', 'KRW-USDT', e); } }
  }
  const map = await tickerMap();
  const btc = series['BITSTAMP:BTCUSD'] || await getSeries('BITSTAMP:BTCUSD', { count: 1200 });
  const btcClosed = splitClosed(btc, NOW);
  const btcByT = new Map(btcClosed.t.map((t, i) => [t, btcClosed.c[i]]));
  const rows = [];
  let tooShort = 0;

  const plausible = (sym, last) => {
    if (!usdtKrw || refKrw[sym] == null) return true; // nothing to compare against
    const ref = refKrw[sym] / usdtKrw;
    return last / ref > 0.7 && last / ref < 1.3;
  };
  async function krwDaily(x) {
    const host = x.upbit ? 'https://api.upbit.com' : 'https://api.bithumb.com';
    let rowsK = [], to = '';
    for (let p = 0; p < 3; p++) {
      const pg = await http(`${host}/v1/candles/days?market=KRW-${x.sym}&count=200${to}`, { tries: 3 });
      if (!Array.isArray(pg)) throw new Error('NOTARR');
      if (!pg.length) break;
      rowsK = rowsK.concat(pg);
      if (pg.length < 200) break;
      const lastUtc = pg[pg.length - 1].candle_date_time_utc;
      to = x.upbit ? '&to=' + encodeURIComponent(lastUtc + 'Z') : '&to=' + lastUtc.replace('T', '%20'); // Bithumb rejects a trailing Z
      await sleep(300);
    }
    rowsK.reverse();
    const t = rowsK.map((r) => Date.parse(r.candle_date_time_utc + 'Z') / 1000), c = rowsK.map((r) => +r.trade_price);
    return { t, c, unit: 'KRW', src: x.upbit ? 'upbit' : 'bithumb' };
  }

  const queue = universe.slice();
  async function worker(pool) {
    while (queue.length) {
      const x = queue.shift();
      const cands = [];
      const m = map.bySym[x.sym];
      if (m?.length) cands.push(...m.sort((a, b) => a.rank - b.rank).map((e) => e.usd));
      const guess = `CRYPTO:${x.sym}USD`;
      if (!cands.includes(guess)) cands.push(guess);
      let got = null, reason = [];
      for (const tvSym of cands.slice(0, 3)) {
        try {
          const s = await pool.daily(tvSym, { count: 460 });
          const k = splitClosed(s, NOW);
          const last = k.live ?? k.c.at(-1);
          if (!k.c.length) { reason.push(`${tvSym}: no bars`); continue; }
          if (!plausible(x.sym, last)) { reason.push(`${tvSym}: price mismatch`); continue; }
          if (k.t.at(-1) * 1000 < NOW - 3 * DAY * 1000) { reason.push(`${tvSym}: stale`); continue; }
          got = { ...k, unit: 'USD', src: 'tv', tv: tvSym };
          break;
        } catch (e) { reason.push(`${tvSym}: ${String(e.message).slice(0, 60)}`); }
      }
      if (!got && !LOCAL) {
        try {
          const d = await krwDaily(x);
          const k = splitClosed({ t: d.t, c: d.c }, NOW);
          got = { ...k, unit: 'KRW', src: d.src, tv: null };
        } catch (e) { reason.push(`krw: ${String(e.message).slice(0, 60)}`); }
      }
      if (!got) { failed.push({ sym: x.sym, reason: reason.join(' | ') }); continue; }
      bySrc[got.src]++;
      const v = scan365(got.t, got.c, got.live);
      if (!v) { tooShort++; continue; }
      let btcDist = null;
      if (got.unit === 'USD') {
        const tt = [], rc = [];
        got.t.forEach((t, i) => { const b = btcByT.get(t); if (b) { tt.push(t); rc.push(got.c[i] / b); } });
        const rv = scan365(tt, rc, null);
        btcDist = rv?.dist ?? null;
      }
      rows.push({ sym: x.sym, kname: x.kname, ex: (x.upbit ? '업' : '') + (x.bithumb ? '빗' : ''), unit: got.unit, src: got.src, tv: got.tv, caution: x.caution || false, btcDist, ...v });
    }
  }
  await Promise.all(tvPool.map((p) => worker(p)));
  rows.sort((a, b) => a.sym.localeCompare(b.sym));
  out._scanMembers = rows;
  const ev = rows.filter((r) => !r.spliced);
  const dl = (r) => (r.live ?? r.dist);
  const fresh = ev.filter((r) => r.age === 1 && r.dist > 0 && r.dist <= 15).sort((a, b) => a.dist - b.dist);
  const near = ev.filter((r) => r.age >= 2 && r.age <= 4).sort((a, b) => a.age - b.age || a.dist - b.dist);
  const byLive = [...ev].sort((a, b) => dl(b) - dl(a));
  // previous brief's share: an earlier run for the same brief date keeps its own 'previous'
  const prevShare = prev?.meta?.briefDate === BRIEF_DATE ? (prev?.scan?.shareAbovePrev ?? null) : (prev?.scan?.shareAbove ?? null);
  const shareAbove = ev.length ? r2((ev.filter((r) => r.age > 0).length / ev.length) * 100, 1) : null;
  // tracking: candidates from earlier mornings (data/scan-history.json)
  const histFile = path.join(OUT, 'scan-history.json');
  const hist = (await readJSON(histFile)) || [];
  const today = BRIEF_DATE;
  const bySym = new Map(rows.map((r) => [r.sym, r]));
  const tracked = hist.filter((h) => (NOW - Date.parse(h.date)) / 86400e3 <= 30 && h.date !== today).map((h) => {
    const r = bySym.get(h.sym);
    return { ...h, nowDist: r?.dist ?? null, nowLive: r?.live ?? null, nowAge: r?.age ?? null, daysSince: Math.round((NOW - Date.parse(h.date)) / 86400e3), tv: r?.tv ?? h.tv ?? null };
  });
  if (!hist.some((h) => h.date === today)) {
    for (const r of fresh.filter((r) => r.dist <= 10)) hist.push({ date: today, sym: r.sym, dist0: r.dist, src: r.src, unit: r.unit, tv: r.tv });
    await writeFile(histFile, JSON.stringify(hist.filter((h) => (NOW - Date.parse(h.date)) / 86400e3 <= 60), null, 1));
  }
  out.scan = {
    def: '마감 봉 기준. 경과일(age)은 365선 위에서 마감한 첫 봉이 1. dist = 종가/SMA365 − 1. live = 진행 중 봉을 오늘 종가로 가정',
    universe: universe.length, collected: rows.length + tooShort, evaluated: ev.length, tooShort, spliced: rows.length - ev.length,
    bySrc, failedCount: failed.length, failed: failed.slice(0, 80), usdtKrw,
    shareAbove, shareAbovePrev: prevShare,
    fresh: fresh.map(pickScan), near: near.map(pickScan),
    map: {
      top15: byLive.slice(0, 15).map(pickScan),
      band3: ev.filter((r) => Math.abs(dl(r)) <= 3).sort((a, b) => dl(b) - dl(a)).map((r) => ({ ...pickScan(r), d5: r.dist5ago == null ? null : r2(r.dist - r.dist5ago) })),
      bottom10: byLive.slice(-10).reverse().map(pickScan),
    },
    tracked,
  };
});
function pickScan(r) {
  return { sym: r.sym, kname: r.kname, ex: r.ex, unit: r.unit, src: r.src, tv: r.tv, age: r.age, dist: r.dist, live: r.live, btcDist: r.btcDist, slope20: r.slope20, dayRet: r.dayRet, below: r.below, closeDate: r.closeDate, sector: r.sector || null, caution: r.caution || undefined };
}
async function readJSON(f) { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return null; } }

// ---------------- 10. sectors (Upbit UBCS board, v9 sector_board) ----------------
await section('sectors', async () => {
  const members = scanMembers();
  if (!members.length) { if (SLOT !== 'morning') { const prev = await readJSON(path.join(OUT, 'latest-morning.json')); out.sectors = prev?.sectors || null; } return; }
  const cacheF = path.join(OUT, 'ubcs.json');
  const cache = (await readJSON(cacheF)) || { coins: {}, asked: {}, fullAt: 0 };
  // monthly full refresh after the 2nd 09:00 KST (Upbit sector index rebalance)
  const k = new Date(NOW + 9 * 3600e3), mark = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), 2, 0) ;
  const due = (NOW >= mark ? mark : Date.UTC(k.getUTCFullYear(), k.getUTCMonth() - 1, 2, 0));
  const refreshAll = (cache.fullAt || 0) < due;
  const ask = members.filter((m) => m.ex.includes('업') && (refreshAll || (!cache.coins[m.sym] && (NOW - (cache.asked[m.sym] || 0)) > 20 * 3600e3)));
  let okN = 0, failN = 0;
  if (!LOCAL) {
    const q = ask.slice();
    await Promise.all([0, 1, 2, 3].map(async () => {
      while (q.length) {
        const m = q.shift();
        try {
          const j = await http(`https://datalab-api.upbit.com/api/v1/asset/info?symbol=${m.sym}`, { tries: 2, timeout: 10000 });
          const sec = j?.data?.sector || {};
          const p = [1, 2, 3].map((i) => String(sec[`level${i}Name`] || '').replace(/\s+/g, ' ').trim());
          const c = [1, 2, 3].map((i) => String(sec[`level${i}Code`] || '').trim());
          if (p.every(Boolean) && c.every(Boolean)) { cache.coins[m.sym] = { path: p, codes: c }; okN++; } else cache.asked[m.sym] = NOW;
        } catch { cache.asked[m.sym] = NOW; failN++; }
        await sleep(120);
      }
    }));
    if (refreshAll && okN > ask.length * 0.5) cache.fullAt = NOW;
    await writeFile(cacheF, JSON.stringify(cache));
  }
  for (const m of members) { const e = cache.coins[m.sym]; m.sector = e ? e.path.slice(0, 2).join(' > ') : null; }
  const mem = members.filter((m) => cache.coins[m.sym] && !m.spliced).map((m) => ({ ...m, path: cache.coins[m.sym].path, codes: cache.coins[m.sym].codes }));
  const stable = (m) => m.path[1].includes('스테이블');
  const stats = (ms) => {
    const have = ms.filter((m) => m.dist != null);
    if (!have.length) return { n: ms.length, n_data: 0 };
    const fixed = have.filter((m) => m.dist30ago != null);
    const lead = have.reduce((a, b) => (b.dist > a.dist ? b : a)), lag = have.reduce((a, b) => (b.dist < a.dist ? b : a));
    return {
      n: ms.length, n_data: have.length,
      above: r2((100 * have.filter((m) => m.dist > 0).length) / have.length, 1),
      d30: fixed.length ? r2((100 * fixed.filter((m) => m.dist > 0).length) / fixed.length - (100 * fixed.filter((m) => m.dist30ago > 0).length) / fixed.length, 1) : null,
      med_usd: r2(median(have.filter((m) => m.unit === 'USD').map((m) => m.dist))),
      med_btc: r2(median(have.map((m) => m.btcDist))),
      med_ret7: r2(median(have.map((m) => m.ret7))),
      leader: [lead.sym, lead.dist], laggard: [lag.sym, lag.dist],
    };
  };
  const names = {};
  for (const m of mem) for (let i = 0; i < 2; i++) { const c = m.codes[i]; (names[c] ||= {}); names[c][m.path[i]] = (names[c][m.path[i]] || 0) + 1; }
  const nm = (c) => Object.entries(names[c]).sort((a, b) => b[1] - a[1])[0][0];
  const l1 = [...new Set(mem.map((m) => m.codes[0]))].sort().map((c1) => {
    const m1 = mem.filter((m) => m.codes[0] === c1);
    return {
      code: c1, name: nm(c1), stats: stats(m1.filter((m) => !stable(m))),
      children: [...new Set(m1.map((m) => m.codes[1]))].sort().map((c2) => { const m2 = m1.filter((m) => m.codes[1] === c2); return { code: c2, name: nm(c2), stable: stable(m2[0]), stats: stats(m2) }; }),
    };
  });
  out.sectors = {
    source: 'Upbit 디지털 자산 분류(UBCS) 대·중분류. 365선 스캔 종목 가운데 업비트 분류가 있는 것만. 동일가중 통계',
    classified: mem.length, unclassified: members.length - mem.length, asked: ask.length, askOk: okN, askFail: failN,
    all: stats(mem.filter((m) => !stable(m))), l1,
  };
});

// ---------------- 11. charts ----------------
await section('charts', async () => {
  await mkdir(path.join(OUT, 'charts'), { recursive: true });
  out.charts = {};
  for (const [name, sym] of [['BTC', 'BITSTAMP:BTCUSD'], ['ETH', 'BITSTAMP:ETHUSD']]) {
    const s = series[sym];
    if (!s) { fail('charts', sym, 'series missing'); continue; }
    const svg = chartSVG(s, { window: 120, title: `${name}USD · 1D · 120일` });
    if (!svg) continue;
    const f = path.join(OUT, 'charts', `${name}.svg`);
    await writeFile(f, svg);
    out.charts[name] = { file: f, bytes: svg.length };
  }
  if (!cptraP) { fail('charts', 'CPTRA', 'cptra series missing'); return; }
  const svg = cptraSVG(cptraP, { window: 240, lastCross: cptraP.lastCross, now: NOW });
  if (svg) {
    const f = path.join(OUT, 'charts', 'CPTRA.svg');
    await writeFile(f, svg);
    out.charts.CPTRA = { file: f, bytes: svg.length };
  }
});

for (const p of tvPool) p.close();

// ---------------- write ----------------
delete out._scanMembers;
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'latest.json'), JSON.stringify(out, null, 1));
await writeFile(path.join(OUT, `latest-${SLOT}.json`), JSON.stringify(out, null, 1));
// one-line log of key values: one row per brief date and slot, the latest run replaces the earlier one
try {
  const logF = path.join(OUT, 'log.csv');
  const prevLog = await readFile(logF, 'utf8').catch(() => '');
  const date = BRIEF_DATE;
  if (!prevLog) await writeFile(logF, 'kst_date,slot,generated_utc,btc_d,usdt_d,usdc_d,stable_d,stable_1m_pp,others_d,others_d_1m_pp,btc_close,btc_sma50_dist,btc_1m_pct,scan_share_above,cptra_norm\n');
  {
    const L = out.ledger || {}, b = out.ma?.BTC || {};
    const row = [date, SLOT, out.meta.generatedAt, L['BTC.D']?.close, L['USDT.D']?.close, L['USDC.D']?.close, r2(L['ΣSTABLECOIN.D']?.close, 3), L['ΣSTABLECOIN.D']?.chg30d, L['OTHERS.D']?.close, L['OTHERS.D']?.chg30d, b.close, b.sma50?.dist, b.chg30d, out.scan?.shareAbove, out.cptra?.norm];
    const line = row.map((v) => (v == null ? '' : v)).join(',');
    const rows = (await readFile(logF, 'utf8')).split('\n').filter(Boolean);
    const k = rows.findIndex((r) => r.startsWith(`${date},${SLOT},`));
    if (k > 0) rows[k] = line; else rows.push(line);
    await writeFile(logF, rows.join('\n') + '\n');
  }
} catch (e) { console.error('log', e); }
console.log(`done: slot=${SLOT} failures=${out.meta.failures.length}`);
console.log(JSON.stringify(out.meta.sections));
// fail the run (so the owner is notified) only when the core sections all failed
const core = ['ledger', 'ma'].filter((s) => out.meta.sections[s] !== 'failed' && Object.values(out[s] || {}).some((v) => v && !v.err));
if (!core.length) { console.error('core sections failed'); process.exit(1); }
