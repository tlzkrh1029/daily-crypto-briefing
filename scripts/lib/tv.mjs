// TradingView chart WebSocket client (anonymous token, no login cookies).
// Adapted from tlzkrh1029/wma0.3-screenshot scripts/fetch-tv.mjs; this version keeps OHLCV.
import WebSocket from 'ws';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const CHUNK = 5000;
const MAX_ROUNDS = 6;

const frame = (payload) => `~m~${payload.length}~m~${payload}`;
function parseFrames(raw) {
  const out = [];
  let i = 0;
  while (i < raw.length) {
    const m = /^~m~(\d+)~m~/.exec(raw.slice(i));
    const end = m ? i + m[0].length + Number(m[1]) : -1;
    if (!m || (end < raw.length && !raw.startsWith('~m~', end))) {
      out.push(...raw.slice(i).split(/~m~\d+~m~/).filter(Boolean));
      break;
    }
    out.push(raw.slice(i + m[0].length, end));
    i = end;
  }
  return out;
}

class TVClient {
  constructor(ws) {
    this.ws = ws;
    this.listeners = new Set();
    this.rejecters = new Set();
    this.closed = null;
    const abort = (reason) => {
      this.closed = reason;
      for (const reject of [...this.rejecters]) reject(new Error(reason));
    };
    ws.on('close', (code) => abort(`connection closed (code ${code})`));
    ws.on('error', (err) => abort(`connection error: ${err.message}`));
    ws.on('message', (data) => {
      for (const payload of parseFrames(data.toString())) {
        if (payload.startsWith('~h~')) { ws.send(frame(payload)); continue; }
        let msg;
        try { msg = JSON.parse(payload); } catch { continue; }
        if ((msg.m === 'protocol_error' || msg.m === 'critical_error') && !String(msg.p?.[0] ?? '').startsWith('cs_')) {
          abort(`${msg.m}: ${JSON.stringify(msg.p).slice(0, 200)}`);
          continue;
        }
        for (const fn of this.listeners) fn(msg);
      }
    });
  }
  send(m, p) { this.ws.send(frame(JSON.stringify({ m, p }))); }
  wait(pick, timeoutMs = 45_000, label = 'message') {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error(this.closed));
      const done = () => { clearTimeout(timer); this.listeners.delete(fn); this.rejecters.delete(fail); };
      const fail = (err) => { done(); reject(err); };
      const timer = setTimeout(() => fail(new Error(`timeout waiting for ${label}`)), timeoutMs);
      const fn = (msg) => {
        let v;
        try { v = pick(msg); } catch (err) { v = err; }
        if (v === undefined) return;
        done();
        v instanceof Error ? reject(v) : resolve(v);
      };
      this.listeners.add(fn);
      this.rejecters.add(fail);
    });
  }
}

let seq = 0;
async function fetchSeries(client, symbol, tf, count, more) {
  const cs = `cs_dcb${++seq}`;
  const bars = new Map(); // time -> [o,h,l,c,v]
  const onData = (msg) => {
    if ((msg.m === 'timescale_update' || msg.m === 'du') && msg.p?.[0] === cs) {
      for (const b of msg.p[1]?.sds_1?.s || []) {
        const v = b.v;
        if (Number.isFinite(v?.[4])) bars.set(v[0], [v[1], v[2], v[3], v[4], Number.isFinite(v[5]) ? v[5] : null]);
      }
    }
  };
  client.listeners.add(onData);
  const failed = (msg) => {
    if (msg.p?.[0] !== cs) return undefined;
    if (['symbol_error', 'series_error', 'critical_error', 'protocol_error'].includes(msg.m)) {
      return new Error(`${msg.m}: ${JSON.stringify(msg.p.slice(1)).slice(0, 200)}`);
    }
    return undefined;
  };
  const completed = (ms) => {
    const p = client.wait((msg) => failed(msg) ?? (msg.m === 'series_completed' && msg.p[0] === cs ? true : undefined), ms, `${symbol} ${tf} data`);
    p.catch(() => {});
    return p;
  };
  try {
    const resolved = client.wait((msg) => failed(msg) ?? (msg.m === 'symbol_resolved' && msg.p[0] === cs ? msg.p[2] : undefined), 45_000, `${symbol} resolve`);
    resolved.catch(() => {});
    let next = completed(60_000);
    client.send('chart_create_session', [cs, '']);
    client.send('switch_timezone', [cs, 'Etc/UTC']);
    client.send('resolve_symbol', [cs, 'sds_sym_1', '=' + JSON.stringify({ symbol, adjustment: 'splits' })]);
    client.send('create_series', [cs, 'sds_1', 's1', 'sds_sym_1', tf, count, '']);
    const meta = await resolved;
    await next;
    let added = more && bars.size >= Math.min(count, CHUNK) ? Infinity : 0;
    for (let round = 1; added > 0 && round <= MAX_ROUNDS; round++) {
      const before = bars.size;
      next = completed(45_000);
      client.send('request_more_data', [cs, 'sds_1', CHUNK]);
      await next;
      added = bars.size - before;
    }
    const sorted = [...bars.entries()].sort((a, b) => a[0] - b[0]);
    return {
      symbol,
      description: meta?.description ?? null,
      t: sorted.map(([t]) => t),
      o: sorted.map(([, v]) => v[0]),
      h: sorted.map(([, v]) => v[1]),
      l: sorted.map(([, v]) => v[2]),
      c: sorted.map(([, v]) => v[3]),
      v: sorted.map(([, v]) => v[4]),
    };
  } finally {
    client.listeners.delete(onData);
    try { client.send('chart_delete_session', [cs]); } catch {}
  }
}

export function createTV({ url = 'wss://data.tradingview.com/socket.io/websocket?type=chart' } = {}) {
  let client = null;
  async function connect() {
    if (client && !client.closed) return client;
    const ws = new WebSocket(url, { headers: { Origin: 'https://www.tradingview.com', 'User-Agent': UA } });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    client = new TVClient(ws);
    client.send('set_auth_token', ['unauthorized_user_token']);
    client.send('set_locale', ['en', 'US']);
    return client;
  }
  // count: bars wanted (whole history when more=true and the first chunk is full)
  async function daily(symbol, { count = 2000, more = false, tf = '1D' } = {}) {
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await fetchSeries(await connect(), symbol, tf, count, more); } catch (err) {
        last = err;
        try { client?.ws.close(); } catch {}
        client = null;
      }
    }
    throw last;
  }
  function close() { try { client?.ws.close(); } catch {} client = null; }
  return { daily, close };
}
