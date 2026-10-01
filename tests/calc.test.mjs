import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  upsertBar, trimWindow, pickBaseBar, windowBars, windowStats, bucketCandles,
  tradesToSecondBars, nextBackoff, formatPrice, formatPct, formatAbs, formatVolume,
} from '../webapp/js/calc.js';

const rows = JSON.parse(readFileSync(new URL('./fixtures/klines_1s_301.json', import.meta.url)));
const toBar = (r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], q: +r[7] });
const bars = rows.map(toBar);
const NOW = bars[bars.length - 1].t + 500;
const flat = (s) => s.replace(/[  ]/g, ' ');

test('fixture is 301 sorted unique 1s bars', () => {
  assert.equal(bars.length, 301);
  for (let i = 1; i < bars.length; i++) assert.ok(bars[i].t > bars[i - 1].t);
});

test('upsertBar appends, replaces, inserts sorted, no duplicates', () => {
  const s = [];
  upsertBar(s, { t: 2000, c: 1 });
  upsertBar(s, { t: 4000, c: 2 });
  upsertBar(s, { t: 3000, c: 3 });
  upsertBar(s, { t: 1000, c: 4 });
  upsertBar(s, { t: 3000, c: 5 });
  assert.deepEqual(s.map((b) => b.t), [1000, 2000, 3000, 4000]);
  assert.equal(s[2].c, 5);
});

test('pickBaseBar picks the last bar with t <= cutoff', () => {
  const s = [{ t: 1000 }, { t: 2000 }, { t: 4000 }];
  assert.equal(pickBaseBar(s, 3999).t, 2000);
  assert.equal(pickBaseBar(s, 4000).t, 4000);
  assert.equal(pickBaseBar(s, 999), null);
});

test('base bar on fixture is looked up by timestamp (gaps tolerated)', () => {
  const cutoff = NOW - 300000;
  const base = pickBaseBar(bars, cutoff);
  assert.ok(base.t <= cutoff);
  assert.ok(bars.every((b) => b.t > cutoff || b.t <= base.t));
});

test('windowStats matches independent computation on fixture', () => {
  const st = windowStats(bars, NOW);
  const cutoff = NOW - 300000;
  const base = [...bars].filter((b) => b.t <= cutoff).pop();
  const inWin = bars.filter((b) => b.t > cutoff);
  const last = inWin[inWin.length - 1].c;
  assert.equal(st.last, last);
  assert.equal(st.base, base.c);
  assert.ok(Math.abs(st.changeAbs - (last - base.c)) < 1e-9);
  assert.ok(Math.abs(st.changePct - ((last - base.c) / base.c) * 100) < 1e-9);
  assert.equal(st.high, Math.max(...inWin.map((b) => b.h)));
  assert.equal(st.low, Math.min(...inWin.map((b) => b.l)));
  assert.ok(Math.abs(st.volBase - inWin.reduce((a, b) => a + b.v, 0)) < 1e-9);
  assert.ok(Math.abs(st.volQuote - inWin.reduce((a, b) => a + b.q, 0)) < 1e-6);
  assert.equal(st.partial, false);
});

test('direction: up, down, flat below 0.01%', () => {
  const mk = (base, last) => [
    { t: 0, o: base, h: base, l: base, c: base, v: 1, q: 1 },
    { t: 299000, o: last, h: last, l: last, c: last, v: 1, q: 1 },
  ];
  assert.equal(windowStats(mk(100000, 100020), 300500).direction, 'up');
  assert.equal(windowStats(mk(100000, 99980), 300500).direction, 'down');
  assert.equal(windowStats(mk(100000, 100005), 300500).direction, 'flat');
  assert.equal(windowStats(mk(100000, 100010), 300500).direction, 'up');
  assert.equal(windowStats(mk(100000, 100000), 300500).changePct, 0);
});

test('partial window when no bar older than 300 s', () => {
  const st = windowStats(bars.slice(-100), NOW);
  assert.equal(st.partial, true);
});

test('windowStats on empty series is null', () => {
  assert.equal(windowStats([], NOW), null);
});

test('trimWindow keeps the base bar plus the trailing window, drops the rest', () => {
  const s = bars.map((b) => ({ ...b }));
  const now = NOW + 60000;
  const cutoff = now - 300000;
  trimWindow(s, now);
  const base = pickBaseBar(bars, cutoff);
  assert.equal(s[0].t, base.t);
  assert.ok(s.slice(1).every((b) => b.t > cutoff));
  assert.equal(s[s.length - 1].t, bars[bars.length - 1].t);
});

test('windowBars is exactly the trailing 300 s', () => {
  const w = windowBars(bars, NOW);
  assert.ok(w.every((b) => b.t > NOW - 300000 && b.t <= NOW));
  assert.ok(w.length <= 300);
});

test('bucketCandles aggregates OHLCV into aligned 10 s buckets, max 30', () => {
  const c = bucketCandles(bars, 10, 30);
  assert.ok(c.length <= 30);
  for (const k of c) {
    assert.equal(k.t % 10000, 0);
    const src = bars.filter((b) => b.t >= k.t && b.t < k.t + 10000);
    assert.equal(k.o, src[0].o);
    assert.equal(k.c, src[src.length - 1].c);
    assert.equal(k.h, Math.max(...src.map((b) => b.h)));
    assert.equal(k.l, Math.min(...src.map((b) => b.l)));
  }
});

test('tradesToSecondBars aggregates and continues a seed bar', () => {
  const trades = [
    { t: 1000, p: 10, q: 1 }, { t: 1500, p: 12, q: 2 }, { t: 1999, p: 9, q: 1 }, { t: 2100, p: 11, q: 1 },
  ];
  const out = tradesToSecondBars(trades);
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].o, out[0].h, out[0].l, out[0].c, out[0].v], [10, 12, 9, 9, 4]);
  assert.equal(out[0].q, 10 + 24 + 9);
  const more = tradesToSecondBars([{ t: 2900, p: 13, q: 1 }], out[1]);
  assert.equal(more.length, 1);
  assert.equal(more[0].t, 2000);
  assert.equal(more[0].h, 13);
  assert.equal(more[0].v, 2);
});

test('nextBackoff grows 1 s to 30 s with jitter and caps', () => {
  assert.equal(nextBackoff(0, () => 0.5), 1000);
  assert.equal(nextBackoff(1, () => 0.5), 2000);
  assert.equal(nextBackoff(3, () => 0.5), 8000);
  assert.equal(nextBackoff(10, () => 1), 30000);
  assert.ok(nextBackoff(0, () => 0) >= 800);
  assert.ok(nextBackoff(0, () => 1) <= 1200);
});

test('formatters: ru-RU, U+2212 minus, signs', () => {
  assert.equal(flat(formatPrice(84318.01)), '84 318,01');
  assert.equal(formatPct(0.1234), '+0,123%');
  assert.equal(formatPct(-0.1234), '−0,123%');
  assert.equal(formatPct(0), '0,000%');
  assert.equal(flat(formatAbs(-1234.5)), '−$1 234,50');
  assert.equal(formatAbs(12), '+$12,00');
  assert.match(flat(formatVolume(1234.5)), /^1,23 тыс/);
});
