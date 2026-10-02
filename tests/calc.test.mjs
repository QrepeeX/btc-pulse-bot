import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  upsertBar, trimWindow, pickBaseBar, windowBars, windowStats, bucketCandles,
  tradesToSecondBars, nextBackoff, formatPrice, formatPct, formatAbs, formatVolume,
  forecast, forecastPoints, formatPrice0, formatProb, normCdf, HORIZON_SEC,
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

test('coarse base far from the cutoff degrades to partial; a close coarse base is trusted', () => {
  const now = 1_000_000_000_000;
  const mk = (baseT) => [
    { t: baseT, o: 100, h: 100, l: 100, c: 100, v: 1, q: 100, coarse: true },
    { t: now - 2000, o: 110, h: 110, l: 110, c: 110, v: 1, q: 110 },
    { t: now, o: 111, h: 111, l: 111, c: 111, v: 1, q: 111 },
  ];
  const far = windowStats(mk(now - 300000 - 40000), now);
  assert.equal(far.partial, true);
  assert.equal(far.base, 110);
  const near = windowStats(mk(now - 300000 - 1000), now);
  assert.equal(near.partial, false);
  assert.equal(near.base, 100);
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

test('bucketCandles aggregates OHLCV into aligned 15 s buckets, max 20', () => {
  const c = bucketCandles(bars);
  assert.ok(c.length <= 20 && c.length >= 19);
  for (const k of c) {
    assert.equal(k.t % 15000, 0);
    const src = bars.filter((b) => b.t >= k.t && b.t < k.t + 15000);
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

const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = (rnd) => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const T0 = 1_700_000_000_000;
const mk = (t, c) => ({ t, o: c, h: c, l: c, c, v: 1, q: c });
const logLinear = (g, n = 300, p = 100000) => Array.from({ length: n }, (_, i) => mk(T0 + i * 1000, p * Math.exp(g * i)));
const noisy = (seed, sigma, n = 300, start = T0) => {
  const rnd = mulberry32(seed);
  let lp = Math.log(84000);
  return Array.from({ length: n }, (_, i) => {
    lp += sigma * gauss(rnd);
    return mk(start + i * 1000, Math.exp(lp));
  });
};
const nowOf = (s) => s[s.length - 1].t + 500;

test('normCdf sanity', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normCdf(1) - 0.8413447) < 1e-5);
  assert.ok(Math.abs(normCdf(-1.96) - 0.025) < 1e-4);
});

test('forecast: flat series has zero width, flat direction', () => {
  const s = logLinear(0);
  const fc = forecast(s, nowOf(s));
  assert.equal(fc.direction, 'flat');
  assert.equal(fc.sigma, 0);
  assert.equal(fc.lo68, fc.hi68);
  assert.equal(fc.pUp, 0.5);
});

test('forecast: exact log-linear trend recovers slope, damped mid, up/down', () => {
  const g = 2e-5;
  const s = logLinear(g);
  const fc = forecast(s, nowOf(s));
  assert.ok(Math.abs(fc.slopePerSec - g) < 1e-12);
  const p0 = s[s.length - 1].c;
  assert.ok(Math.abs(fc.mid - p0 * Math.exp(0.25 * g * 300)) < 1e-6);
  assert.equal(fc.direction, 'up');
  const dn = logLinear(-g);
  assert.equal(forecast(dn, nowOf(dn)).direction, 'down');
});

test('forecast: tiny trend is flat', () => {
  const s = logLinear(1e-9);
  assert.equal(forecast(s, nowOf(s)).direction, 'flat');
});

test('forecast: dropped bars keep slope and sigma ~ 0 (timestamps and dt are used)', () => {
  const g = 2e-5;
  const s = logLinear(g).filter((_, i) => i % 7 !== 6);
  const fc = forecast(s, nowOf(s));
  assert.ok(Math.abs(fc.slopePerSec - g) < 1e-9);
  assert.ok(fc.sigma < 1e-9);
});

test('forecast: noise recovers sigma, ordered bands, 1.96 ratio, deterministic', () => {
  const sig = 1e-4;
  const s = noisy(7, sig);
  const fc = forecast(s, nowOf(s));
  assert.ok(Math.abs(fc.sigma - sig) / sig < 0.15);
  assert.ok(fc.lo95 < fc.lo68 && fc.lo68 < fc.mid && fc.mid < fc.hi68 && fc.hi68 < fc.hi95);
  const r = (Math.log(fc.hi95) - Math.log(fc.mid)) / (Math.log(fc.hi68) - Math.log(fc.mid));
  assert.ok(Math.abs(r - 1.96) < 1e-9);
  assert.deepEqual(forecast(noisy(7, sig), nowOf(s)), fc);
});

test('forecast: empirical 68% coverage over 200 windows', () => {
  const sig = 1e-4;
  let hit = 0;
  const runs = 200;
  for (let k = 0; k < runs; k++) {
    const all = noisy(1000 + k, sig, 600);
    const hist = all.slice(0, 300);
    const fc = forecast(hist, nowOf(hist));
    const actual = all[299 + 300].c;
    if (actual >= fc.lo68 && actual <= fc.hi68) hit++;
  }
  const cov = hit / runs;
  assert.ok(cov >= 0.6 && cov <= 0.76, 'coverage ' + cov);
});

test('forecast: window and input guards', () => {
  const s = noisy(3, 1e-4, 300);
  const old = noisy(4, 1e-4, 100, T0 - 1_000_000);
  const fc = forecast([...old, ...s], nowOf(s));
  assert.equal(fc.n, 300);
  assert.equal(forecast(s.slice(-100), nowOf(s)), null);
  assert.equal(forecast(s.slice(-119), nowOf(s)), null);
  assert.ok(forecast(s.slice(-120), nowOf(s)));
  const coarse = s.map((b, i) => (i % 2 ? { ...b, coarse: true } : b));
  assert.equal(forecast(coarse, nowOf(s)).n, 150);
  const fx = forecast(bars, NOW);
  for (const k of ['p0', 'mid', 'lo68', 'hi68', 'lo95', 'hi95', 'pUp', 'sigma', 'slopePerSec']) assert.ok(Number.isFinite(fx[k]), k);
  assert.equal(fx.targetT, fx.t0 + HORIZON_SEC * 1000);
});

test('forecastPoints: counts, order, origin, whitespace', () => {
  const s = noisy(5, 1e-4);
  const fc = forecast(s, nowOf(s));
  for (const [step, count] of [[1, 301], [15, 21]]) {
    const pts = forecastPoints(fc, 1000, step);
    assert.equal(pts.length, count);
    for (let i = 1; i < pts.length; i++) assert.ok(pts[i].time > pts[i - 1].time);
    assert.equal(pts[0].mid, fc.p0);
    assert.equal(pts[0].lo95, fc.p0);
    assert.ok(Math.abs(pts[count - 1].mid - fc.mid) < 1e-6);
    assert.ok(Math.abs(pts[count - 1].hi68 - fc.hi68) < 1e-6);
    const ws = forecastPoints(null, 1000, step);
    assert.equal(ws.length, count);
    assert.deepEqual(Object.keys(ws[0]), ['time']);
  }
});

test('formatPrice0 / formatProb', () => {
  assert.equal(flat(formatPrice0(84318.6)), '84 319');
  assert.equal(formatProb(0.5149), '51%');
});
