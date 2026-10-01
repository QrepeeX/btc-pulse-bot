export const WINDOW_SEC = 300;
export const FLAT_PCT = 0.01;
const MINUS = '−';

export function upsertBar(series, bar) {
  const n = series.length;
  if (n === 0 || bar.t > series[n - 1].t) {
    series.push(bar);
    return series;
  }
  for (let i = n - 1; i >= 0; i--) {
    if (series[i].t === bar.t) {
      series[i] = bar;
      return series;
    }
    if (series[i].t < bar.t) {
      series.splice(i + 1, 0, bar);
      return series;
    }
  }
  series.unshift(bar);
  return series;
}

export function pickBaseBar(series, cutoffMs) {
  let lo = 0;
  let hi = series.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= cutoffMs) {
      found = series[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function windowBars(series, nowMs, windowSec = WINDOW_SEC) {
  const cutoff = nowMs - windowSec * 1000;
  return series.filter((b) => b.t > cutoff && b.t <= nowMs);
}

// Keeps the base bar (last one at or before the cutoff): the change is measured against its close.
export function trimWindow(series, nowMs, windowSec = WINDOW_SEC) {
  const base = pickBaseBar(series, nowMs - windowSec * 1000);
  if (!base) return series;
  const keepFrom = series.indexOf(base);
  if (keepFrom > 0) series.splice(0, keepFrom);
  return series;
}

export function windowStats(series, nowMs, windowSec = WINDOW_SEC) {
  const bars = windowBars(series, nowMs, windowSec);
  if (bars.length === 0) return null;
  const last = bars[bars.length - 1].c;
  let base = pickBaseBar(series, nowMs - windowSec * 1000);
  const partial = base === null;
  if (partial) base = bars[0];
  const baseClose = partial ? base.o : base.c;
  let high = -Infinity;
  let low = Infinity;
  let volBase = 0;
  let volQuote = 0;
  for (const b of bars) {
    if (b.h > high) high = b.h;
    if (b.l < low) low = b.l;
    volBase += b.v || 0;
    volQuote += b.q || 0;
  }
  const changeAbs = last - baseClose;
  const changePct = baseClose ? (changeAbs / baseClose) * 100 : 0;
  const direction = Math.abs(changePct) < FLAT_PCT ? 'flat' : changePct > 0 ? 'up' : 'down';
  return { last, base: baseClose, baseT: base.t, partial, changeAbs, changePct, high, low, volBase, volQuote, direction };
}

export function bucketCandles(series, sec = 10, count = 30) {
  const size = sec * 1000;
  const out = [];
  let cur = null;
  for (const b of series) {
    const t = Math.floor(b.t / size) * size;
    if (cur && cur.t === t) {
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.c = b.c;
      cur.v += b.v || 0;
      cur.q += b.q || 0;
    } else {
      cur = { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, q: b.q || 0 };
      out.push(cur);
    }
  }
  return out.slice(-count);
}

// trades: [{t, p, q}] in time order; seed: the in-progress bar from the previous call, if it is the same second.
export function tradesToSecondBars(trades, seed = null) {
  const bars = [];
  let cur = seed ? { ...seed } : null;
  for (const tr of trades) {
    const t = Math.floor(tr.t / 1000) * 1000;
    if (!cur || cur.t !== t) {
      cur = { t, o: tr.p, h: tr.p, l: tr.p, c: tr.p, v: 0, q: 0 };
      bars.push(cur);
    } else if (bars[bars.length - 1] !== cur) {
      bars.push(cur);
    }
    if (tr.p > cur.h) cur.h = tr.p;
    if (tr.p < cur.l) cur.l = tr.p;
    cur.c = tr.p;
    cur.v += tr.q;
    cur.q += tr.q * tr.p;
  }
  return bars;
}

export function nextBackoff(attempt, random = Math.random) {
  const base = Math.min(30000, 1000 * 2 ** attempt);
  return Math.min(30000, Math.round(base * (0.8 + 0.4 * random())));
}

const fmt2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt3 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const fmtCompact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 2 });

const sign = (n) => (n > 0 ? '+' : n < 0 ? MINUS : '');

export const formatPrice = (n) => fmt2.format(n);
export const formatAbs = (n) => `${sign(n)}$${fmt2.format(Math.abs(n))}`;
export const formatPct = (n) => `${sign(n)}${fmt3.format(Math.abs(n))}%`;
export const formatVolume = (n) => fmtCompact.format(n);
