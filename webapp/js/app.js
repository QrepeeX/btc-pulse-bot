import {
  upsertBar, trimWindow, windowStats, forecast, formatPrice, formatPrice0, formatProb, formatPct, formatAbs,
  formatVolume,
} from './calc.js';
import { createForecastLog, formatScore } from './forecast-log.js';
import { createFeed } from './feed.js';
import { createChart } from './chart.js';
import { initTelegram } from './tg.js';

const STALE_MS = 5000;
const RENDER_MIN_MS = 250;
const FORECAST_MS = 5000;

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), priceVal: $('price-val'), badge: $('badge'), pct: $('pct'), abs: $('abs'),
  staleText: $('stale-text'), banner: $('banner'), overlayText: $('overlay-text'), retry: $('retry'),
  toggle: $('toggle'), high: $('t-high'), low: $('t-low'), vbase: $('t-vbase'), vquote: $('t-vquote'),
  source: $('source'), updated: $('updated'),
  fc: $('fc'), fcTitle: $('fc-title'), fcMid: $('fc-mid'), fcRange: $('fc-range'), fcProb: $('fc-prob'),
  fcScore: $('fc-score'), fcBase: $('fc-base'), fcCalib: $('fc-calib'),
};

const tg = initTelegram();
if (tg.lowPerf) document.documentElement.classList.add('low-perf');

const series = [];
let status = { state: 'connecting', source: '', fallback: false };
let chart = null;
let baseLinePrice = null;
let hasData = false;
let lastFc = null;
let expiredDropped = false;

const params = new URLSearchParams(location.search);
const fcKey = params.get('mock') === '1' ? 'btcpulse:v1:fc:mock' : 'btcpulse:v1:fc';

function pickStorage() {
  try {
    const probe = '__btcpulse_probe';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
  }
}

const storage = pickStorage();
if (params.get('resetfc') === '1') {
  try {
    if (storage.removeItem) storage.removeItem(fcKey);
    else storage.setItem(fcKey, '[]');
  } catch {}
}

// The github.io origin is shared with other projects, hence the namespace; mock data never mixes with live.
const fcLog = createForecastLog({ storage, key: fcKey });

try {
  chart = createChart($('chart'));
} catch (e) {
  console.error(e);
}

const feedNow = () => (series.length ? series[series.length - 1].t + 999 : Date.now());
const clockFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const hmFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

function isStale() {
  const lastTick = feed.getLastTick();
  const age = lastTick ? Date.now() - lastTick : 0;
  return status.state === 'error' || status.state === 'stale' || (lastTick > 0 && age > STALE_MS);
}

function renderForecast(stale) {
  const fc = lastFc;
  el.fc.classList.remove('up', 'down', 'flat');
  el.fc.classList.toggle('pending', !fc);
  el.fc.classList.toggle('stale', stale || !fc);
  const score = formatScore(fcLog.score());
  el.fcScore.textContent = score.main;
  el.fcBase.textContent = score.base;
  const cal = fcLog.calibration();
  el.fcCalib.hidden = !cal.active;
  if (cal.active) el.fcCalib.textContent = `калибровка ×${cal.k.toFixed(1).replace(".", ",")}`;
  if (!fc) {
    el.fcTitle.textContent = 'Оценка через 5 мин';
    el.fcMid.textContent = stale ? 'Нет связи' : 'Накопление данных';
    el.fcRange.textContent = '—';
    el.fcProb.textContent = '—';
    return;
  }
  el.fc.classList.add(fc.direction);
  el.fcTitle.textContent = `Оценка через 5 мин · на ${hmFmt.format(new Date(fc.targetT))}`;
  el.fcMid.textContent = `≈ $${formatPrice0(fc.mid)}`;
  el.fcRange.textContent = `$${formatPrice0(fc.lo68)} – $${formatPrice0(fc.hi68)}`;
  el.fcProb.textContent = formatProb(fc.pUp);
}

// Never per WS bar: the estimate, the fan and the log move every FORECAST_MS and on backfill.
function recalcForecast() {
  const stale = isStale();
  lastFc = stale || !series.length ? null : forecast(series, feedNow(), { k: fcLog.calibration().k });
  if (chart) chart.setForecast(lastFc, series, feedNow());
  if (lastFc && !document.hidden) {
    fcLog.resolveFromSeries(series);
    if (fcLog.shouldRecord(lastFc)) fcLog.record(lastFc);
  }
  scheduleRender();
}

function render() {
  const st = series.length ? windowStats(series, feedNow()) : null;
  const lastTick = feed.getLastTick();
  const age = lastTick ? Date.now() - lastTick : 0;
  const stale = isStale();
  renderForecast(stale);

  el.app.classList.toggle('has-error', status.state === 'error');
  el.source.textContent = status.source ? `Источник: ${status.source}` : 'Источник: —';
  el.updated.textContent = lastTick ? `Обновлено: ${clockFmt.format(new Date(lastTick))}` : 'Обновлено: —';

  if (!st) {
    el.badge.classList.toggle('stale', stale);
    return;
  }
  if (!hasData) {
    hasData = true;
    el.app.classList.remove('loading');
  }

  el.priceVal.textContent = formatPrice(st.last);
  el.pct.textContent = formatPct(st.changePct);
  el.abs.textContent = formatAbs(st.changeAbs);
  el.badge.classList.remove('up', 'down', 'flat');
  el.badge.classList.add(st.direction);
  el.badge.classList.toggle('stale', stale);
  el.staleText.textContent = lastTick
    ? `Нет связи · обновлено ${Math.max(0, Math.round(age / 1000))} с назад`
    : 'Нет связи';

  el.high.textContent = formatPrice(st.high);
  el.low.textContent = formatPrice(st.low);
  el.vbase.textContent = formatVolume(st.volBase);
  el.vquote.textContent = formatVolume(st.volQuote);

  el.banner.textContent = st.partial ? 'Накопление данных: изменение считается с первой точки' : '';
  el.banner.classList.toggle('show', st.partial);

  if (chart && st.base !== baseLinePrice) {
    baseLinePrice = st.base;
    chart.setBaseLine(st.partial ? null : st.base);
  }
}

let queued = false;
let renderedAt = 0;
function scheduleRender() {
  if (queued) return;
  queued = true;
  const wait = Math.max(0, RENDER_MIN_MS - (performance.now() - renderedAt));
  setTimeout(() => {
    requestAnimationFrame(() => {
      queued = false;
      renderedAt = performance.now();
      render();
    });
  }, wait);
}

const feed = createFeed(params, {
  onBars(bars, { replace }) {
    if (replace) series.length = 0;
    for (const b of bars) upsertBar(series, b);
    trimWindow(series, feedNow());
    if (!expiredDropped && series.length) {
      expiredDropped = true;
      fcLog.discardExpired(series[0].t);
    }
    if (chart) recalcForecast();
    else scheduleRender();
  },
  onBar(bar) {
    upsertBar(series, bar);
    if (chart) chart.pushBar(series, feedNow());
    scheduleRender();
  },
  onStatus(s) {
    status = s;
    scheduleRender();
  },
});

setInterval(() => {
  trimWindow(series, feedNow());
  scheduleRender();
}, 1000);

setInterval(() => {
  if (series.length && !document.hidden) recalcForecast();
}, FORECAST_MS);

el.toggle.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-mode]');
  if (!btn) return;
  const mode = btn.dataset.mode;
  if (mode === el.toggle.dataset.mode) return;
  el.toggle.dataset.mode = mode;
  for (const b of el.toggle.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
  if (chart) {
    chart.setMode(mode);
    if (series.length) chart.setData(series, feedNow());
  }
  tg.selectionChanged();
});

el.retry.addEventListener('click', () => feed.retry());

const resume = () => feed.resume();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    resume();
    if (series.length) recalcForecast();
  }
});
window.addEventListener('online', resume);
tg.onActivated(resume);

feed.start();
