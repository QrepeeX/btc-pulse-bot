import { nextBackoff, tradesToSecondBars } from './calc.js';

const defaultClock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (f, ms) => setInterval(f, ms),
  clearInterval: (id) => clearInterval(id),
};

export function parseKlineRow(r) {
  return { t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], q: +r[7] };
}

export function parseBinanceWsMessage(raw) {
  const m = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const k = m && (m.k || (m.data && m.data.k));
  if (!k) return null;
  return { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, q: +k.q };
}

function wrapSocket(ws, handlers, onClose, extraStop) {
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    extraStop();
    onClose();
  };
  ws.onclose = done;
  ws.onerror = done;
  return {
    close() {
      closed = true;
      extraStop();
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {}
    },
  };
}

export function createBinanceFeed({
  fetchImpl = (...a) => fetch(...a),
  WebSocketImpl = globalThis.WebSocket,
  restBase = 'https://data-api.binance.vision',
  wsBase = 'wss://data-stream.binance.vision',
} = {}) {
  return {
    name: 'Binance (Spot)',
    async backfill(sinceMs) {
      const q = sinceMs ? `&startTime=${sinceMs}&limit=1000` : '&limit=301';
      const res = await fetchImpl(`${restBase}/api/v3/klines?symbol=BTCUSDT&interval=1s${q}`);
      if (!res.ok) throw new Error(`binance rest ${res.status}`);
      return (await res.json()).map(parseKlineRow);
    },
    subscribe({ onBar, onClose }) {
      const ws = new WebSocketImpl(`${wsBase}/ws/btcusdt@kline_1s`);
      ws.onmessage = (ev) => {
        let bar;
        try {
          bar = parseBinanceWsMessage(ev.data);
        } catch {
          return;
        }
        if (bar) onBar(bar);
      };
      return wrapSocket(ws, null, onClose, () => {});
    },
  };
}

export function createBybitFeed({
  fetchImpl = (...a) => fetch(...a),
  WebSocketImpl = globalThis.WebSocket,
  restBase = 'https://api.bybit.com',
  wsUrl = 'wss://stream.bybit.com/v5/public/spot',
  clock = defaultClock,
} = {}) {
  return {
    name: 'Bybit (Spot)',
    // Bybit has no 1 s klines: the last ~60 trades give real 1 s bars for the latest seconds, completed 1m
    // klines (stamped at their last second, coarse) cover older minutes. Never mixed with another venue.
    async backfill(sinceMs) {
      const get = async (path) => {
        const res = await fetchImpl(`${restBase}${path}`);
        if (!res.ok) throw new Error(`bybit rest ${res.status}`);
        return res.json();
      };
      const [tr, kl] = await Promise.allSettled([
        get('/v5/market/recent-trade?category=spot&symbol=BTCUSDT&limit=1000'),
        get('/v5/market/kline?category=spot&symbol=BTCUSDT&interval=1&limit=8'),
      ]);
      if (tr.status === 'rejected' && kl.status === 'rejected') throw tr.reason;
      let real = [];
      if (tr.status === 'fulfilled') {
        const list = (tr.value && tr.value.result && tr.value.result.list) || [];
        const trades = list
          .map((d) => ({ t: +d.time, p: +d.price, q: +d.size }))
          .filter((d) => d.t > 0 && d.p > 0)
          .sort((a, b) => a.t - b.t);
        real = tradesToSecondBars(trades);
      }
      let coarse = [];
      if (kl.status === 'fulfilled') {
        const body = kl.value || {};
        const serverNow = +body.time || clock.now();
        const firstReal = real.length ? real[0].t : Infinity;
        coarse = ((body.result && body.result.list) || [])
          .filter((r) => +r[0] + 60000 <= serverNow)
          .map((r) => {
            const c = +r[4];
            return { t: +r[0] + 59000, o: c, h: c, l: c, c, v: +r[5], q: +r[6], coarse: true };
          })
          .filter((b) => b.t < firstReal);
      }
      return [...coarse, ...real].filter((b) => !sinceMs || b.t >= sinceMs).sort((a, b) => a.t - b.t);
    },
    subscribe({ onBar, onClose }) {
      const ws = new WebSocketImpl(wsUrl);
      let cur = null;
      let ping = null;
      const stopPing = () => {
        if (ping !== null) clock.clearInterval(ping);
        ping = null;
      };
      ws.onopen = () => {
        ws.send(JSON.stringify({ op: 'subscribe', args: ['publicTrade.BTCUSDT'] }));
        ping = clock.setInterval(() => {
          try {
            ws.send(JSON.stringify({ op: 'ping' }));
          } catch {}
        }, 20000);
      };
      ws.onmessage = (ev) => {
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!m || m.topic !== 'publicTrade.BTCUSDT' || !Array.isArray(m.data)) return;
        const trades = m.data.map((d) => ({ t: +d.T, p: +d.p, q: +d.v })).sort((a, b) => a.t - b.t);
        for (const bar of tradesToSecondBars(trades, cur)) {
          cur = bar;
          onBar({ ...bar });
        }
      };
      return wrapSocket(ws, null, onClose, stopPing);
    },
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createMockFeed({ seed = 42, start = 84000, clock = defaultClock } = {}) {
  const rnd = mulberry32(seed);
  let price = start;
  const step = (t) => {
    const o = price;
    price = Math.max(1, price + (rnd() - 0.5) * 24 + (rnd() - 0.5) * 6);
    const c = price;
    const v = rnd() * 0.5;
    return { t, o, h: Math.max(o, c) + rnd() * 3, l: Math.min(o, c) - rnd() * 3, c, v, q: v * c };
  };
  return {
    name: 'Mock',
    async backfill(sinceMs) {
      const end = Math.floor(clock.now() / 1000) * 1000;
      const from = sinceMs ? Math.max(sinceMs, end - 1000 * 1000) : end - 300 * 1000;
      const out = [];
      for (let t = Math.ceil(from / 1000) * 1000; t <= end; t += 1000) out.push(step(t));
      return out;
    },
    subscribe({ onBar }) {
      const id = clock.setInterval(() => onBar(step(Math.floor(clock.now() / 1000) * 1000)), 1000);
      return { close: () => clock.clearInterval(id) };
    },
  };
}

export function createFeedManager({
  sources,
  clock = defaultClock,
  random = Math.random,
  staleMs = 5000,
  retryPrimaryMs = 60000,
  onBars = () => {},
  onBar = () => {},
  onStatus = () => {},
}) {
  let idx = 0;
  let sub = null;
  let generation = 0;
  let lastTick = 0;
  let connectAt = 0;
  let lastBarT = 0;
  let attempt = 0;
  let state = 'connecting';
  let running = false;
  let reconnectTimer = null;
  let watchdog = null;
  let primaryTimer = null;
  let failed = sources.map(() => false);

  const emit = () => onStatus({ state, source: sources[idx].name, fallback: idx > 0, lastTickAt: lastTick });
  const setState = (next) => {
    state = next;
    emit();
  };

  const teardown = () => {
    if (sub) sub.close();
    sub = null;
    if (reconnectTimer !== null) clock.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  async function connect(i, fresh) {
    teardown();
    const gen = ++generation;
    const sourceChanged = i !== idx;
    idx = i;
    connectAt = clock.now();
    if (fresh) lastBarT = 0;
    if (sourceChanged) emit();
    const src = sources[i];
    try {
      const bars = await src.backfill(lastBarT ? lastBarT + 1 : undefined);
      if (gen !== generation) return;
      if (bars.length) {
        onBars(bars, { replace: fresh });
        for (const b of bars) if (b.t > lastBarT) lastBarT = b.t;
      }
    } catch {
      if (gen !== generation) return;
    }
    sub = src.subscribe({
      onBar(b) {
        if (gen !== generation) return;
        lastTick = clock.now();
        attempt = 0;
        failed[idx] = false;
        if (b.t > lastBarT) lastBarT = b.t;
        if (state !== 'live') setState('live');
        onBar(b);
      },
      onClose() {
        if (gen !== generation) return;
        reconnectTimer = clock.setTimeout(() => {
          reconnectTimer = null;
          if (gen === generation) connect(idx, false);
        }, nextBackoff(attempt++, random));
      },
    });
  }

  function onWatchdog() {
    if (!running || state === 'error') return;
    if (clock.now() - Math.max(lastTick, connectAt) <= staleMs) return;
    failed[idx] = true;
    const other = sources.findIndex((_, k) => !failed[k]);
    if (other !== -1) {
      setState('stale');
      connect(other, true);
    } else {
      setState('error');
    }
  }

  function probePrimary() {
    if (!running || idx === 0) return;
    sources[0]
      .backfill()
      .then((bars) => {
        if (running && idx !== 0 && bars.length) {
          failed[0] = false;
          connect(0, true);
        }
      })
      .catch(() => {});
  }

  const api = {
    start() {
      if (running) return Promise.resolve();
      running = true;
      failed = sources.map(() => false);
      state = 'connecting';
      watchdog = clock.setInterval(onWatchdog, 1000);
      primaryTimer = clock.setInterval(probePrimary, retryPrimaryMs);
      return connect(0, true);
    },
    stop() {
      running = false;
      generation++;
      teardown();
      if (watchdog !== null) clock.clearInterval(watchdog);
      if (primaryTimer !== null) clock.clearInterval(primaryTimer);
      watchdog = primaryTimer = null;
    },
    // visibilitychange -> visible, Telegram `activated`, browser `online`: fill the gap and resubscribe.
    resume() {
      if (!running) return Promise.resolve();
      if (state === 'error') return api.retry();
      attempt = 0;
      return connect(idx, false);
    },
    retry() {
      if (!running) return Promise.resolve();
      failed = sources.map(() => false);
      attempt = 0;
      setState('connecting');
      return connect(0, true);
    },
    getLastTick: () => lastTick,
    getState: () => state,
    getSourceIndex: () => idx,
  };
  return api;
}

export function createFeed(params, handlers) {
  const sources =
    params.get('mock') === '1' ? [createMockFeed()] : [createBinanceFeed(), createBybitFeed()];
  return createFeedManager({ sources, ...handlers });
}
