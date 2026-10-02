import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createBinanceFeed, createBybitFeed, createFeedManager, createMockFeed, parseBinanceWsMessage,
} from '../webapp/js/feed.js';

const rows = JSON.parse(readFileSync(new URL('./fixtures/klines_1s_301.json', import.meta.url)));

function fakeClock(start = 1_000_000) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const clock = {
    now: () => now,
    setTimeout: (f, ms) => { timers.set(++seq, { f, at: now + ms }); return seq; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (f, ms) => { timers.set(++seq, { f, at: now + ms, every: ms }); return seq; },
    clearInterval: (id) => timers.delete(id),
  };
  clock.advance = async (ms) => {
    const target = now + ms;
    for (;;) {
      let best = null;
      for (const [id, t] of timers) if (t.at <= target && (!best || t.at < best[1].at)) best = [id, t];
      if (!best) break;
      const [id, t] = best;
      now = t.at;
      if (t.every) t.at += t.every; else timers.delete(id);
      t.f();
      await flush();
    }
    now = target;
    await flush();
  };
  return clock;
}

class FakeWS {
  static instances = [];
  constructor(url) { this.url = url; this.sent = []; FakeWS.instances.push(this); }
  send(m) { this.sent.push(m); }
  close() { this.closedByUs = true; }
}

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

test('parseBinanceWsMessage reads kline payload', () => {
  const bar = parseBinanceWsMessage(JSON.stringify({
    e: 'kline', k: { t: 5000, o: '1', h: '3', l: '0.5', c: '2', v: '10', q: '20', x: false },
  }));
  assert.deepEqual(bar, { t: 5000, o: 1, h: 3, l: 0.5, c: 2, v: 10, q: 20 });
  assert.equal(parseBinanceWsMessage('{"result":null,"id":1}'), null);
});

test('Binance backfill: URL, mapping, gap variant, http error throws', async () => {
  const urls = [];
  const feed = createBinanceFeed({ fetchImpl: async (u) => { urls.push(u); return jsonRes(rows); } });
  const bars = await feed.backfill();
  assert.match(urls[0], /^https:\/\/data-api\.binance\.vision\/api\/v3\/klines\?symbol=BTCUSDT&interval=1s&limit=301$/);
  assert.equal(bars.length, 301);
  assert.equal(bars[0].t, rows[0][0]);
  assert.equal(bars[0].c, +rows[0][4]);
  assert.equal(bars[0].q, +rows[0][7]);
  await feed.backfill(123000);
  assert.match(urls[1], /startTime=123000&limit=1000$/);
  const bad = createBinanceFeed({ fetchImpl: async () => jsonRes({}, false, 451) });
  await assert.rejects(bad.backfill(), /451/);
});

test('Binance subscribe: stream URL, bars forwarded, close reported once', () => {
  FakeWS.instances = [];
  const feed = createBinanceFeed({ WebSocketImpl: FakeWS });
  const got = [];
  let closes = 0;
  feed.subscribe({ onBar: (b) => got.push(b), onClose: () => closes++ });
  const ws = FakeWS.instances[0];
  assert.equal(ws.url, 'wss://data-stream.binance.vision/ws/btcusdt@kline_1s');
  ws.onmessage({ data: JSON.stringify({ k: { t: 1000, o: '1', h: '1', l: '1', c: '1', v: '1', q: '1' } }) });
  ws.onmessage({ data: 'garbage' });
  ws.onerror();
  ws.onclose();
  assert.equal(got.length, 1);
  assert.equal(closes, 1);
});

test('Bybit: coarse backfill, trades aggregated into 1 s bars, ping every 20 s', async () => {
  FakeWS.instances = [];
  const clock = fakeClock();
  const klines = [['240000', '0', '0', '0', '105', '1', '100'], ['180000', '0', '0', '0', '102', '3', '300'], ['120000', '0', '0', '0', '101', '2', '200'], ['60000', '0', '0', '0', '100', '1', '100']];
  const trades = [
    { price: '103', size: '1', time: '241500' }, { price: '104', size: '1', time: '241900' },
    { price: '102.5', size: '1', time: '240100' },
  ];
  const urls = [];
  const feed = createBybitFeed({
    fetchImpl: async (u) => {
      urls.push(u);
      return u.includes('recent-trade')
        ? jsonRes({ result: { list: trades } })
        : jsonRes({ time: 245000, result: { list: klines } });
    },
    WebSocketImpl: FakeWS, clock,
  });
  const back = await feed.backfill();
  assert.ok(urls.includes('https://api.bybit.com/v5/market/recent-trade?category=spot&symbol=BTCUSDT&limit=1000'));
  assert.ok(urls.includes('https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=1&limit=8'));
  // minute 240000 is still in progress at server time 245000 -> dropped; coarse bars flagged, real 1 s bars follow
  assert.deepEqual(back.map((b) => [b.t, b.c, !!b.coarse]), [[119000, 100, true], [179000, 101, true], [239000, 102, true], [240000, 102.5, false], [241000, 104, false]]);
  assert.deepEqual((await feed.backfill(241000)).map((b) => b.t), [241000]);
  const onlyKl = createBybitFeed({
    fetchImpl: async (u) => (u.includes('recent-trade') ? jsonRes({}, false, 500) : jsonRes({ time: 245000, result: { list: klines } })),
    clock,
  });
  assert.equal((await onlyKl.backfill()).length, 3);
  const dead = createBybitFeed({ fetchImpl: async () => jsonRes({}, false, 403), clock });
  await assert.rejects(dead.backfill(), /403/);

  const got = [];
  feed.subscribe({ onBar: (b) => got.push(b), onClose() {} });
  const ws = FakeWS.instances[0];
  ws.onopen();
  assert.deepEqual(JSON.parse(ws.sent[0]), { op: 'subscribe', args: ['publicTrade.BTCUSDT'] });
  const msg = (data) => ({ data: JSON.stringify({ topic: 'publicTrade.BTCUSDT', data }) });
  ws.onmessage(msg([{ T: 1100, p: '10', v: '1' }, { T: 1900, p: '12', v: '2' }]));
  ws.onmessage(msg([{ T: 1950, p: '11', v: '1' }, { T: 2100, p: '13', v: '1' }]));
  const last = new Map(got.map((b) => [b.t, b]));
  assert.deepEqual([...last.keys()], [1000, 2000]);
  const s = last.get(1000);
  assert.deepEqual([s.o, s.h, s.l, s.c, s.v], [10, 12, 10, 11, 4]);
  await clock.advance(20000);
  assert.deepEqual(JSON.parse(ws.sent[1]), { op: 'ping' });
});

test('feed names carry the market type', () => {
  assert.equal(createBybitFeed().name, 'Bybit (Spot)');
  assert.equal(createBinanceFeed().name, 'Binance (Spot)');
});

test('mock feed is deterministic by seed', async () => {
  const mk = () => createMockFeed({ seed: 7, clock: fakeClock(1_700_000_000_000) });
  const a = await mk().backfill();
  const b = await mk().backfill();
  assert.equal(a.length, 301);
  assert.deepEqual(a, b);
});

function fakeSource(name, bars = []) {
  const s = {
    name, bars, fail: false, backfillCalls: [], subs: [],
    async backfill(since) {
      s.backfillCalls.push(since);
      if (s.fail) throw new Error('down');
      return s.bars.filter((b) => !since || b.t >= since);
    },
    subscribe(h) {
      const sub = { ...h, closed: false, close() { sub.closed = true; } };
      s.subs.push(sub);
      return sub;
    },
  };
  return s;
}
const bar = (t, c = 100) => ({ t, o: c, h: c, l: c, c, v: 1, q: c });

function setup(opts = {}) {
  const clock = fakeClock();
  const primary = fakeSource('Binance (Spot)', [bar(1000), bar(2000)]);
  const fallback = fakeSource('Bybit (Spot)', [bar(1000, 90)]);
  const ev = { bars: [], ticks: [], status: [] };
  const mgr = createFeedManager({
    sources: [primary, fallback], clock, random: () => 0.5,
    onBars: (b, o) => ev.bars.push({ b, ...o }),
    onBar: (b) => ev.ticks.push(b),
    onStatus: (s) => ev.status.push(s),
    ...opts,
  });
  return { clock, primary, fallback, ev, mgr };
}

test('manager: initial backfill replaces, live tick sets state live', async () => {
  const { primary, ev, mgr } = setup();
  await mgr.start();
  assert.equal(ev.bars[0].replace, true);
  assert.equal(ev.bars[0].b.length, 2);
  primary.subs[0].onBar(bar(3000));
  assert.equal(mgr.getState(), 'live');
  assert.equal(ev.status.at(-1).source, 'Binance (Spot)');
  assert.equal(ev.ticks.length, 1);
  mgr.stop();
});

test('manager: >5 s without ticks fails over to fallback with replace', async () => {
  const { clock, primary, fallback, ev, mgr } = setup();
  await mgr.start();
  primary.subs[0].onBar(bar(3000));
  await clock.advance(4000);
  assert.equal(mgr.getSourceIndex(), 0);
  await clock.advance(2500);
  assert.equal(mgr.getSourceIndex(), 1);
  assert.ok(primary.subs[0].closed);
  assert.equal(ev.status.at(-1).fallback, true);
  assert.equal(ev.status.at(-1).source, 'Bybit (Spot)');
  assert.equal(ev.bars.at(-1).replace, true);
  assert.equal(fallback.subs.length, 1);
  fallback.subs[0].onBar(bar(7000, 95));
  assert.equal(mgr.getState(), 'live');
  mgr.stop();
});

test('manager: both sources dead -> error; retry() recovers', async () => {
  const { clock, primary, fallback, ev, mgr } = setup();
  await mgr.start();
  await clock.advance(6000);
  assert.equal(mgr.getSourceIndex(), 1);
  await clock.advance(6000);
  assert.equal(mgr.getState(), 'error');
  assert.equal(ev.status.at(-1).state, 'error');
  await mgr.retry();
  assert.equal(mgr.getSourceIndex(), 0);
  primary.subs.at(-1).onBar(bar(9000));
  assert.equal(mgr.getState(), 'live');
  assert.ok(fallback.subs[0].closed);
  mgr.stop();
});

test('manager: socket close -> backoff reconnect with gap backfill, no duplicate bars', async () => {
  const { clock, primary, ev, mgr } = setup();
  await mgr.start();
  primary.subs[0].onBar(bar(3000));
  primary.bars = [bar(2000), bar(3000), bar(4000), bar(5000)];
  primary.subs[0].onClose();
  await clock.advance(999);
  assert.equal(primary.subs.length, 1);
  await clock.advance(2);
  assert.equal(primary.subs.length, 2);
  assert.equal(primary.backfillCalls.at(-1), 3001);
  const gap = ev.bars.at(-1);
  assert.equal(gap.replace, false);
  assert.deepEqual(gap.b.map((b) => b.t), [4000, 5000]);
  mgr.stop();
});

test('manager: backoff grows on repeated failures', async () => {
  const { clock, primary, mgr } = setup();
  await mgr.start();
  primary.subs[0].onClose();
  await clock.advance(1000);
  assert.equal(primary.subs.length, 2);
  primary.subs[1].onClose();
  await clock.advance(1999);
  assert.equal(primary.subs.length, 2);
  await clock.advance(2);
  assert.equal(primary.subs.length, 3);
  mgr.stop();
});

test('manager: primary retried every 60 s while on fallback, switches back', async () => {
  const { clock, primary, fallback, mgr } = setup();
  await mgr.start();
  await clock.advance(6000);
  assert.equal(mgr.getSourceIndex(), 1);
  fallback.subs[0].onBar(bar(8000, 95));
  primary.fail = true;
  await clock.advance(60000);
  assert.equal(mgr.getSourceIndex(), 1);
  fallback.subs[0].onBar(bar(9000, 95));
  primary.fail = false;
  await clock.advance(60000);
  assert.equal(mgr.getSourceIndex(), 0);
  assert.ok(fallback.subs.at(-1).closed);
  mgr.stop();
});

test('manager: resume() reconnects and backfills the gap', async () => {
  const { primary, ev, mgr } = setup();
  await mgr.start();
  primary.subs[0].onBar(bar(3000));
  primary.bars = [bar(3000), bar(4000), bar(5000)];
  await mgr.resume();
  assert.ok(primary.subs[0].closed);
  assert.equal(primary.subs.length, 2);
  assert.deepEqual(ev.bars.at(-1).b.map((b) => b.t), [4000, 5000]);
  mgr.stop();
});

test('manager: stop() ignores late callbacks', async () => {
  const { primary, ev, mgr } = setup();
  await mgr.start();
  mgr.stop();
  const n = ev.ticks.length;
  primary.subs[0].onBar(bar(3000));
  assert.equal(ev.ticks.length, n);
});
