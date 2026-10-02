import { pickBaseBar, FC_RECORD_MIN_BARS } from './calc.js';

export const LOG_CAP = 200;
const RESOLVE_GUARD_MS = 5000;
export const SCORE_MIN_SAMPLE = 30;
export const CALIB_MIN = 20;
export const CALIB_WINDOW = 100;
export const K_MIN = 0.7;
export const K_MAX = 2.5;
const COVERAGE_Q = 0.6827;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const validEntry = (e) =>
  e && typeof e === 'object' &&
  finite(e.t0) && finite(e.targetT) && finite(e.p0) && finite(e.mid) && finite(e.lo68) && finite(e.hi68) &&
  (e.direction === 'up' || e.direction === 'down' || e.direction === 'flat') &&
  (e.resolved === undefined || typeof e.resolved === 'boolean') &&
  (!e.resolved || finite(e.actual)) &&
  (e.z === undefined || (finite(e.z) && e.z >= 0)) &&
  (e.sigmaBase === undefined || finite(e.sigmaBase)) &&
  (e.k === undefined || finite(e.k));

// Normalised miss |ln(actual/mid)| / (sigmaBase*sqrt(h)): independent of the k used when the entry was made.
export function zScore(entry, actual) {
  const h = (entry.targetT - entry.t0) / 1000;
  const w = entry.sigmaBase * Math.sqrt(h);
  if (!(w > 0) || !(entry.mid > 0) || !(actual > 0)) return undefined;
  const z = Math.abs(Math.log(actual / entry.mid)) / w;
  return Number.isFinite(z) ? z : undefined;
}

// k = empirical 68.27th percentile of |z| over the last CALIB_WINDOW resolved entries that carry z.
export function calibrationFactor(entries) {
  const zs = [];
  for (let i = entries.length - 1; i >= 0 && zs.length < CALIB_WINDOW; i--) {
    const e = entries[i];
    if (e && e.resolved && finite(e.z) && e.z >= 0) zs.push(e.z);
  }
  if (zs.length < CALIB_MIN) return 1;
  zs.sort((a, b) => a - b);
  const pos = COVERAGE_Q * (zs.length - 1);
  const lo = Math.floor(pos);
  const q = zs[lo] + (zs[Math.min(lo + 1, zs.length - 1)] - zs[lo]) * (pos - lo);
  return Math.min(K_MAX, Math.max(K_MIN, q));
}

// hit: null for a flat estimate (no direction to judge); in68: corridor bounds are inclusive.
export function evaluate(entry, actual) {
  const hit =
    entry.direction === 'flat' ? null : entry.direction === 'up' ? actual > entry.p0 : actual < entry.p0;
  return { hit, in68: actual >= entry.lo68 && actual <= entry.hi68 };
}

export function formatScore(score) {
  const base = 'монетка ≈ 50% · диапазон ≈ 68%' + (score.resolved < SCORE_MIN_SAMPLE ? ' · мало данных' : '');
  const main = score.resolved === 0
    ? 'Счёт появится через 5 мин'
    : `Угадано ${score.dirHit} из ${score.dirN} ↑/↓ · в диапазоне ${score.in68Hit} из ${score.resolved}`;
  return { main, base };
}

export function createForecastLog({ storage, key, cap = LOG_CAP, now = Date.now }) {
  let entries = [];
  let memOnly = false;

  try {
    const raw = storage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) entries = parsed.filter(validEntry).slice(-cap);
    }
  } catch {
    entries = [];
  }

  function save() {
    if (memOnly) return;
    try {
      storage.setItem(key, JSON.stringify(entries));
    } catch {
      memOnly = true;
    }
  }

  const minuteOf = (ms) => Math.floor(ms / 60000);

  return {
    shouldRecord(fc) {
      if (!fc || fc.n < FC_RECORD_MIN_BARS) return false;
      const last = entries[entries.length - 1];
      return !last || last.m !== minuteOf(now());
    },
    record(fc) {
      entries.push({
        m: minuteOf(now()), t0: fc.t0, targetT: fc.targetT, p0: fc.p0, mid: fc.mid, lo68: fc.lo68, hi68: fc.hi68,
        direction: fc.direction, resolved: false,
        ...(finite(fc.sigma) ? { sigmaBase: fc.sigma } : {}), ...(finite(fc.k) ? { k: fc.k } : {}),
      });
      if (entries.length > cap) entries = entries.slice(-cap);
      save();
    },
    resolveFromSeries(series) {
      const lastT = series.length ? series[series.length - 1].t : -Infinity;
      let changed = 0;
      for (const e of entries) {
        if (e.resolved || lastT <= e.targetT) continue;
        const bar = pickBaseBar(series, e.targetT);
        if (!bar || bar.t < e.targetT - RESOLVE_GUARD_MS) continue;
        e.actual = bar.c;
        e.resolved = true;
        const ev = evaluate(e, bar.c);
        e.hit = ev.hit;
        e.in68 = ev.in68;
        const z = finite(e.sigmaBase) ? zScore(e, bar.c) : undefined;
        if (z !== undefined) e.z = z;
        changed++;
      }
      if (changed) save();
      return changed;
    },
    discardExpired(windowStartMs) {
      const before = entries.length;
      entries = entries.filter((e) => e.resolved || e.targetT >= windowStartMs);
      if (entries.length !== before) save();
      return before - entries.length;
    },
    score() {
      const s = { resolved: 0, dirN: 0, dirHit: 0, in68Hit: 0 };
      for (const e of entries) {
        if (!e.resolved) continue;
        s.resolved++;
        if (e.in68) s.in68Hit++;
        if (e.hit !== null && e.hit !== undefined) {
          s.dirN++;
          if (e.hit) s.dirHit++;
        }
      }
      return s;
    },
    calibration() {
      let n = 0;
      for (const e of entries) if (e.resolved && finite(e.z)) n++;
      return { k: calibrationFactor(entries), n: Math.min(n, CALIB_WINDOW), active: n >= CALIB_MIN };
    },
    get entries() {
      return entries;
    },
  };
}
