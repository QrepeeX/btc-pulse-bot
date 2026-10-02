import { pickBaseBar, FC_RECORD_MIN_BARS } from './calc.js';

export const LOG_CAP = 200;
const RESOLVE_GUARD_MS = 5000;
export const SCORE_MIN_SAMPLE = 30;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const validEntry = (e) =>
  e && typeof e === 'object' &&
  finite(e.t0) && finite(e.targetT) && finite(e.p0) && finite(e.mid) && finite(e.lo68) && finite(e.hi68) &&
  (e.direction === 'up' || e.direction === 'down' || e.direction === 'flat') &&
  (e.resolved === undefined || typeof e.resolved === 'boolean') &&
  (!e.resolved || finite(e.actual));

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
    get entries() {
      return entries;
    },
  };
}
