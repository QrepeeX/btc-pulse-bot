import test from 'node:test';
import assert from 'node:assert/strict';
import { createForecastLog, evaluate, formatScore } from '../webapp/js/forecast-log.js';

const memStore = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};
const T = 1_700_000_040_000;
const fc = (over = {}) => ({
  t0: T, targetT: T + 300000, p0: 100, mid: 101, lo68: 99, hi68: 103, direction: 'up', n: 300, ...over,
});
const bar = (t, c) => ({ t, o: c, h: c, l: c, c, v: 1, q: c });

test('shouldRecord: needs n >= 240 and one record per wall-clock minute', () => {
  let now = T;
  const log = createForecastLog({ storage: memStore(), key: 'k', now: () => now });
  assert.equal(log.shouldRecord(null), false);
  assert.equal(log.shouldRecord(fc({ n: 239 })), false);
  assert.equal(log.shouldRecord(fc({ n: 240 })), true);
  log.record(fc());
  now = T + 59000;
  assert.equal(log.shouldRecord(fc()), false);
  now = T + 60000;
  assert.equal(log.shouldRecord(fc()), true);
});

test('evaluate: hit, miss, flat gives null, in68 inclusive', () => {
  const e = fc();
  assert.equal(evaluate(e, 100.5).hit, true);
  assert.equal(evaluate(e, 99.5).hit, false);
  assert.equal(evaluate(e, 100).hit, false);
  assert.equal(evaluate({ ...e, direction: 'down' }, 99).hit, true);
  assert.equal(evaluate({ ...e, direction: 'flat' }, 105).hit, null);
  assert.equal(evaluate(e, 99).in68, true);
  assert.equal(evaluate(e, 103).in68, true);
  assert.equal(evaluate(e, 98.99).in68, false);
  assert.equal(evaluate(e, 103.01).in68, false);
});

test('resolveFromSeries: only after a later bar exists, within 5 s guard', () => {
  const log = createForecastLog({ storage: memStore(), key: 'k', now: () => T });
  log.record(fc());
  const target = T + 300000;
  assert.equal(log.resolveFromSeries([bar(target - 1000, 102), bar(target, 102)]), 0);
  assert.equal(log.score().resolved, 0);
  assert.equal(log.resolveFromSeries([bar(target - 1000, 102), bar(target, 102.5), bar(target + 1000, 150)]), 1);
  const s = log.score();
  assert.deepEqual(s, { resolved: 1, dirN: 1, dirHit: 1, in68Hit: 1 });
  assert.equal(log.entries[0].actual, 102.5);
});

test('resolveFromSeries: no bar within 5 s before target stays pending', () => {
  const log = createForecastLog({ storage: memStore(), key: 'k', now: () => T });
  log.record(fc());
  const target = T + 300000;
  assert.equal(log.resolveFromSeries([bar(target - 6000, 102), bar(target + 1000, 102)]), 0);
  assert.equal(log.entries[0].resolved, false);
  assert.equal(log.resolveFromSeries([bar(target - 5000, 102), bar(target + 1000, 102)]), 1);
});

test('flat estimate is excluded from direction but counts toward corridor', () => {
  const log = createForecastLog({ storage: memStore(), key: 'k', now: () => T });
  log.record(fc({ direction: 'flat' }));
  const target = T + 300000;
  log.resolveFromSeries([bar(target, 100), bar(target + 1000, 100)]);
  assert.deepEqual(log.score(), { resolved: 1, dirN: 0, dirHit: 0, in68Hit: 1 });
});

test('discardExpired drops pending entries that matured outside the window, keeps resolved', () => {
  let now = T;
  const log = createForecastLog({ storage: memStore(), key: 'k', now: () => now });
  log.record(fc());
  now = T + 60000;
  log.record(fc({ t0: T + 60000, targetT: T + 360000 }));
  const target = T + 300000;
  log.resolveFromSeries([bar(target, 101), bar(target + 1000, 101)]);
  assert.equal(log.discardExpired(T + 400000), 1);
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].resolved, true);
});

test('storage: persists across instances, cap 200 keeps newest', () => {
  const storage = memStore();
  let now = T;
  const a = createForecastLog({ storage, key: 'k', now: () => now });
  for (let i = 0; i < 205; i++) {
    now = T + i * 60000;
    a.record(fc({ t0: now, targetT: now + 300000 }));
  }
  assert.equal(a.entries.length, 200);
  const b = createForecastLog({ storage, key: 'k', now: () => now });
  assert.equal(b.entries.length, 200);
  assert.equal(b.entries[0].t0, T + 5 * 60000);
  assert.equal(b.entries[199].t0, T + 204 * 60000);
});

test('storage: corrupt JSON, wrong shape and throwing storage do not crash', () => {
  assert.equal(createForecastLog({ storage: memStore({ k: '{bad' }), key: 'k' }).entries.length, 0);
  assert.equal(createForecastLog({ storage: memStore({ k: '{"a":1}' }), key: 'k' }).entries.length, 0);
  const mixed = JSON.stringify([{ t0: 'x' }, null, 5, { ...fc(), resolved: false }]);
  assert.equal(createForecastLog({ storage: memStore({ k: mixed }), key: 'k' }).entries.length, 1);
  const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const log = createForecastLog({ storage: boom, key: 'k', now: () => T });
  log.record(fc());
  assert.equal(log.entries.length, 1);
  assert.equal(log.score().resolved, 0);
});

test('storage: keys are isolated', () => {
  const storage = memStore();
  const a = createForecastLog({ storage, key: 'btcpulse:v1:fc', now: () => T });
  const m = createForecastLog({ storage, key: 'btcpulse:v1:fc:mock', now: () => T });
  a.record(fc());
  assert.equal(m.entries.length, 0);
  assert.equal(createForecastLog({ storage, key: 'btcpulse:v1:fc:mock' }).entries.length, 0);
  assert.equal(createForecastLog({ storage, key: 'btcpulse:v1:fc' }).entries.length, 1);
});

test('formatScore strings and baselines', () => {
  const none = formatScore({ resolved: 0, dirN: 0, dirHit: 0, in68Hit: 0 });
  assert.equal(none.main, 'Счёт появится через 5 мин');
  assert.match(none.base, /монетка ≈ 50% · диапазон ≈ 68%/);
  const few = formatScore({ resolved: 5, dirN: 4, dirHit: 3, in68Hit: 4 });
  assert.equal(few.main, 'Угадано 3 из 4 ↑/↓ · в диапазоне 4 из 5');
  assert.match(few.base, /мало данных/);
  const many = formatScore({ resolved: 30, dirN: 28, dirHit: 15, in68Hit: 20 });
  assert.doesNotMatch(many.base, /мало данных/);
  assert.match(many.base, /монетка ≈ 50% · диапазон ≈ 68%/);
});
