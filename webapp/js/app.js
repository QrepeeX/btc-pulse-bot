import {
  upsertBar, trimWindow, windowStats, formatPrice, formatPct, formatAbs, formatVolume,
} from './calc.js';
import { createFeed } from './feed.js';
import { createChart } from './chart.js';
import { initTelegram } from './tg.js';

const STALE_MS = 5000;
const RENDER_MIN_MS = 250;
const FULL_REFRESH_MS = 30000;

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), priceVal: $('price-val'), badge: $('badge'), pct: $('pct'), abs: $('abs'),
  staleText: $('stale-text'), banner: $('banner'), overlayText: $('overlay-text'), retry: $('retry'),
  toggle: $('toggle'), high: $('t-high'), low: $('t-low'), vbase: $('t-vbase'), vquote: $('t-vquote'),
  source: $('source'), updated: $('updated'),
};

const tg = initTelegram();
if (tg.lowPerf) document.documentElement.classList.add('low-perf');

const series = [];
let status = { state: 'connecting', source: '', fallback: false };
let chart = null;
let baseLinePrice = null;
let hasData = false;

try {
  chart = createChart($('chart'));
} catch (e) {
  console.error(e);
}

const feedNow = () => (series.length ? series[series.length - 1].t + 999 : Date.now());
const clockFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function render() {
  const st = series.length ? windowStats(series, feedNow()) : null;
  const lastTick = feed.getLastTick();
  const age = lastTick ? Date.now() - lastTick : 0;
  const stale = status.state === 'error' || status.state === 'stale' || (lastTick > 0 && age > STALE_MS);

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

const feed = createFeed(new URLSearchParams(location.search), {
  onBars(bars, { replace }) {
    if (replace) series.length = 0;
    for (const b of bars) upsertBar(series, b);
    trimWindow(series, feedNow());
    if (chart) chart.setData(series, feedNow());
    scheduleRender();
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
  if (chart && series.length && !document.hidden) chart.setData(series, feedNow());
}, FULL_REFRESH_MS);

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
  if (!document.hidden) resume();
});
window.addEventListener('online', resume);
tg.onActivated(resume);

feed.start();
