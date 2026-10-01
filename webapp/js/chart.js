import { bucketCandles, windowBars, WINDOW_SEC } from './calc.js';

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const shortFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

const toLine = (b) => ({ time: Math.floor(b.t / 1000), value: b.c });
const toCandle = (k) => ({ time: Math.floor(k.t / 1000), open: k.o, high: k.h, low: k.l, close: k.c });

export function createChart(el, { up = '#34E39A', down = '#FF5A6E', accent = '#2F7BFF' } = {}) {
  const LW = window.LightweightCharts;
  if (!LW) throw new Error('lightweight-charts not loaded');

  const chart = LW.createChart(el, {
    autoSize: false,
    width: el.clientWidth,
    height: el.clientHeight,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: 'rgba(255,255,255,0.56)',
      fontFamily: 'inherit',
      attributionLogo: true,
    },
    grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(255,255,255,0.06)' } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
    timeScale: {
      borderVisible: false,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 0,
      tickMarkFormatter: (t) => shortFmt.format(new Date(t * 1000)),
    },
    localization: { timeFormatter: (t) => timeFmt.format(new Date(t * 1000)) },
    handleScroll: false,
    handleScale: false,
    crosshair: { mode: LW.CrosshairMode.Magnet },
  });

  const area = chart.addSeries(LW.AreaSeries, {
    lineColor: accent,
    topColor: 'rgba(47,123,255,0.38)',
    bottomColor: 'rgba(47,123,255,0)',
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: true,
  });
  const candles = chart.addSeries(LW.CandlestickSeries, {
    upColor: up,
    downColor: down,
    borderUpColor: up,
    borderDownColor: down,
    wickUpColor: up,
    wickDownColor: down,
    priceLineVisible: false,
    visible: false,
  });

  let mode = 'line';
  let baseLine = null;
  const active = () => (mode === 'line' ? area : candles);

  const setRange = (nowSec) => {
    chart.timeScale().setVisibleRange({ from: nowSec - WINDOW_SEC, to: nowSec });
  };

  function setBaseLine(price) {
    if (baseLine) {
      area.removePriceLine(baseLine);
      baseLine = null;
    }
    if (price == null) return;
    baseLine = area.createPriceLine({
      price,
      color: 'rgba(255,255,255,0.4)',
      lineWidth: 1,
      lineStyle: LW.LineStyle.Dashed,
      axisLabelVisible: false,
      title: '5 мин назад',
    });
  }

  function setData(series, nowMs) {
    const bars = windowBars(series, nowMs);
    const seen = new Set();
    const line = [];
    for (const b of bars) {
      const p = toLine(b);
      if (!seen.has(p.time)) {
        seen.add(p.time);
        line.push(p);
      }
    }
    area.setData(line);
    candles.setData(bucketCandles(bars, 10, 30).map(toCandle));
    setRange(Math.floor(nowMs / 1000));
  }

  // update() throws on out-of-order times, so a failed update falls back to a full reload.
  function pushBar(series, nowMs) {
    const last = series[series.length - 1];
    if (!last) return;
    try {
      if (mode === 'line') {
        area.update(toLine(last));
      } else {
        const tail = bucketCandles(series.slice(-12), 10, 1);
        if (tail[0]) candles.update(toCandle(tail[0]));
      }
      setRange(Math.floor(nowMs / 1000));
    } catch {
      setData(series, nowMs);
    }
  }

  function setMode(next) {
    mode = next;
    area.applyOptions({ visible: next === 'line' });
    candles.applyOptions({ visible: next === 'candle' });
  }

  const ro = new ResizeObserver(() => {
    chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
  });
  ro.observe(el);

  return {
    setData,
    pushBar,
    setMode,
    setBaseLine,
    destroy() {
      ro.disconnect();
      chart.remove();
    },
    get mode() {
      return mode;
    },
    active,
  };
}
