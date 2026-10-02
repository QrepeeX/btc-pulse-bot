import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFrame } from '../webapp/js/chart.js';
import { forecast } from '../webapp/js/calc.js';

const rows = JSON.parse(readFileSync(new URL('./fixtures/klines_1s_301.json', import.meta.url)));
const bars = rows.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], q: +r[7] }));
const NOW = bars[bars.length - 1].t + 500;
const fc = forecast(bars, NOW);

test('buildFrame line: unique history times, 301 future points, range +-300 s', () => {
  const f = buildFrame(bars, NOW, 'line', fc);
  const times = f.history.map((p) => p.time);
  assert.equal(new Set(times).size, times.length);
  assert.ok(typeof f.history[0].value === 'number');
  assert.equal(f.future.length, 301);
  assert.equal(f.stepSec, 1);
  assert.equal(f.range.to - f.range.from, 600);
  assert.equal(f.future[0].time, Math.floor(NOW / 1000));
  assert.equal(f.range.from, f.anchor - 300);
  assert.equal(f.range.to, f.anchor + 300);
});

test('buildFrame candle: <=20 candles of 15 s, union of times <= 41 (thin-candle regression guard)', () => {
  const f = buildFrame(bars, NOW, 'candle', fc);
  assert.ok(f.history.length <= 20);
  for (const c of f.history) assert.equal(c.time % 15, 0);
  assert.equal(f.future.length, 21);
  assert.equal(f.stepSec, 15);
  const union = new Set([...f.history.map((p) => p.time), ...f.future.map((p) => p.time)]);
  assert.ok(union.size <= 41, `union ${union.size}`);
  assert.equal(f.future[0].time, f.history[f.history.length - 1].time);
});

test('buildFrame without forecast: whitespace future keeps the same grid', () => {
  for (const mode of ['line', 'candle']) {
    const a = buildFrame(bars, NOW, mode, fc);
    const b = buildFrame(bars, NOW, mode, null);
    assert.deepEqual(b.future.map((p) => p.time), a.future.map((p) => p.time));
    assert.ok(b.future.every((p) => p.mid === undefined));
  }
});

test('buildFrame on empty series does not throw', () => {
  for (const mode of ['line', 'candle']) {
    const f = buildFrame([], NOW, mode, null);
    assert.equal(f.history.length, 0);
    assert.ok(f.future.length > 0);
  }
});
