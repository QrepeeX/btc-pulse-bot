export const WINDOW_SEC = 300;
export const FLAT_PCT = 0.01;
export const HORIZON_SEC = 300;
export const FC_MIN_BARS = 120;
export const FC_RECORD_MIN_BARS = 240;
export const TREND_DAMP = 0.25;
export const Z68 = 1;
export const Z95 = 1.96;
export const CANDLE_SEC = 15;
export const CANDLE_COUNT = 20;
const FC_MAX_GAP_SEC = 5;
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

export function bucketCandles(series, sec = CANDLE_SEC, count = CANDLE_COUNT) {
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

// Abramowitz-Stegun 7.1.26, abs error < 1.5e-7.
function erf(x) {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return s * (1 - poly * Math.exp(-a * a));
}
export const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

const bandAt = (p0, drift, sigma, h) => {
  const mu = drift * h;
  const w = sigma * Math.sqrt(h);
  return {
    mid: p0 * Math.exp(mu),
    lo68: p0 * Math.exp(mu - Z68 * w),
    hi68: p0 * Math.exp(mu + Z68 * w),
    lo95: p0 * Math.exp(mu - Z95 * w),
    hi95: p0 * Math.exp(mu + Z95 * w),
  };
};

// Statistical estimate, not a trading signal: damped log-trend plus a sqrt-time volatility corridor.
export function forecast(series, nowMs) {
  const bars = windowBars(series, nowMs).filter((b) => !b.coarse && b.c > 0);
  const n = bars.length;
  if (n < FC_MIN_BARS) return null;
  const last = bars[n - 1];
  const x = bars.map((b) => (b.t - last.t) / 1000);
  const y = bars.map((b) => Math.log(b.c));
  const mx = x.reduce((a, v) => a + v, 0) / n;
  const my = y.reduce((a, v) => a + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  const slopePerSec = sxx > 0 ? sxy / sxx : 0;

  // Residuals around the fitted drift, scaled by sqrt(dt): a gap in the feed must not inflate sigma.
  const z = [];
  for (let i = 1; i < n; i++) {
    const dt = x[i] - x[i - 1];
    if (dt > 0 && dt <= FC_MAX_GAP_SEC) z.push((y[i] - y[i - 1] - slopePerSec * dt) / Math.sqrt(dt));
  }
  if (z.length < 2) return null;
  const mz = z.reduce((a, v) => a + v, 0) / z.length;
  const sigma = Math.sqrt(z.reduce((a, v) => a + (v - mz) ** 2, 0) / (z.length - 1));
  if (!Number.isFinite(sigma) || !Number.isFinite(slopePerSec)) return null;

  const p0 = last.c;
  const drift = TREND_DAMP * slopePerSec;
  const h = HORIZON_SEC;
  const band = bandAt(p0, drift, sigma, h);
  const spread = sigma * Math.sqrt(h);
  const pUp = spread > 0 ? normCdf((drift * h) / spread) : drift > 0 ? 1 : drift < 0 ? 0 : 0.5;
  const movePct = (band.mid / p0 - 1) * 100;
  const direction = Math.abs(movePct) < FLAT_PCT ? 'flat' : movePct > 0 ? 'up' : 'down';
  return {
    t0: last.t, p0, targetT: last.t + h * 1000, ...band, pUp, direction, slopePerSec, drift, sigma, n,
  };
}

export function forecastPoints(fc, anchorSec, stepSec) {
  const count = Math.round(HORIZON_SEC / stepSec) + 1;
  const out = [];
  for (let i = 0; i < count; i++) {
    const time = anchorSec + i * stepSec;
    out.push(fc ? { time, ...bandAt(fc.p0, fc.drift, fc.sigma, i * stepSec) } : { time });
  }
  return out;
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
const fmt0 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtCompact =new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 2 });

const sign = (n) => (n > 0 ? '+' : n < 0 ? MINUS : '');

export const formatPrice = (n) => fmt2.format(n);
export const formatAbs = (n) => `${sign(n)}$${fmt2.format(Math.abs(n))}`;
export const formatPct = (n) => `${sign(n)}${fmt3.format(Math.abs(n))}%`;
export const formatVolume = (n) => fmtCompact.format(n);
export const formatPrice0 = (n) => fmt0.format(n);
export const formatProb = (p) => `${Math.round(p * 100)}%`;
