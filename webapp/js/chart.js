import {
  bucketCandles, windowBars, forecastPoints, HORIZON_SEC, CANDLE_SEC, CANDLE_COUNT,
} from './calc.js';

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const shortFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

const toLine = (b) => ({ time: Math.floor(b.t / 1000), value: b.c });
const toCandle = (k) => ({ time: Math.floor(k.t / 1000), open: k.o, high: k.h, low: k.l, close: k.c });

// One frame = everything the chart shows: history for the active mode, the future grid, the visible range.
export function buildFrame(series, nowMs, mode, fc) {
  const bars = windowBars(series, nowMs);
  let history;
  let stepSec;
  let anchor;
  if (mode === 'candle') {
    const candles = bucketCandles(bars, CANDLE_SEC, CANDLE_COUNT);
    history = candles.map(toCandle);
    stepSec = CANDLE_SEC;
    anchor = candles.length ? history[history.length - 1].time : Math.floor(nowMs / 1000 / CANDLE_SEC) * CANDLE_SEC;
  } else {
    const seen = new Set();
    history = [];
    for (const b of bars) {
      const p = toLine(b);
      if (!seen.has(p.time)) {
        seen.add(p.time);
        history.push(p);
      }
    }
    stepSec = 1;
    anchor = Math.floor(nowMs / 1000);
  }
  return {
    history,
    future: forecastPoints(fc, anchor, stepSec),
    range: { from: anchor - HORIZON_SEC, to: anchor + HORIZON_SEC },
    stepSec,
    anchor,
  };
}

class FanRenderer {
  constructor() {
    this.data = null;
    this.options = null;
  }

  update(data, options) {
    this.data = data;
    this.options = options;
  }

  draw(target, priceConverter) {
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const d = this.data;
      if (!d || !d.visibleRange) return;
      const pts = [];
      for (let i = d.visibleRange.from; i < d.visibleRange.to; i++) {
        const b = d.bars[i];
        const o = b.originalData;
        if (o.mid === undefined) continue;
        pts.push({
          x: b.x * hr,
          mid: priceConverter(o.mid) * vr,
          lo68: priceConverter(o.lo68) * vr,
          hi68: priceConverter(o.hi68) * vr,
          lo95: priceConverter(o.lo95) * vr,
          hi95: priceConverter(o.hi95) * vr,
        });
      }
      if (pts.length < 2) return;
      const band = (lo, hi, fill) => {
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p[hi]) : ctx.moveTo(p.x, p[hi])));
        for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].x, pts[i][lo]);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
      };
      band('lo95', 'hi95', this.options.band95);
      band('lo68', 'hi68', this.options.band68);

      ctx.save();
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.mid) : ctx.moveTo(p.x, p.mid)));
      ctx.setLineDash([6 * hr, 4 * hr]);
      ctx.lineWidth = 2 * hr;
      ctx.strokeStyle = this.options.midColor;
      ctx.shadowColor = this.options.midColor;
      ctx.shadowBlur = 8 * hr;
      ctx.stroke();
      ctx.restore();
    });
  }
}

class FanView {
  constructor() {
    this.r = new FanRenderer();
  }

  renderer() {
    return this.r;
  }

  update(data, options) {
    this.r.update(data, options);
  }

  priceValueBuilder(d) {
    return [d.lo68, d.hi68, d.mid];
  }

  isWhitespace(d) {
    return d.mid === undefined;
  }

  defaultOptions() {
    return {
      band95: 'rgba(47,123,255,0.10)',
      band68: 'rgba(47,123,255,0.22)',
      midColor: 'rgba(255,255,255,0.7)',
    };
  }
}

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
  const fan = chart.addCustomSeries(new FanView(), {
    lastValueVisible: false,
    priceLineVisible: false,
  });

  let mode = 'line';
  let baseLine = null;
  let baseOwner = null;
  let basePrice = null;
  let lastFc = null;
  const active = () => (mode === 'line' ? area : candles);
  const inactive = () => (mode === 'line' ? candles : area);
  const midColors = { up, down, flat: 'rgba(255,255,255,0.7)' };

  function placeBaseLine() {
    if (baseLine) {
      baseOwner.removePriceLine(baseLine);
      baseLine = null;
      baseOwner = null;
    }
    if (basePrice == null) return;
    baseOwner = active();
    baseLine = baseOwner.createPriceLine({
      price: basePrice,
      color: 'rgba(255,255,255,0.4)',
      lineWidth: 1,
      lineStyle: LW.LineStyle.Dashed,
      axisLabelVisible: false,
      title: '5 мин назад',
    });
  }

  function setBaseLine(price) {
    basePrice = price;
    placeBaseLine();
  }

  function setData(series, nowMs) {
    const frame = buildFrame(series, nowMs, mode, lastFc);
    // The time scale is the union of time points over ALL series, hidden ones included. A hidden series
    // still holding 300 one-second points would squeeze the 15 s candles to ~1 px, so it must stay empty.
    inactive().setData([]);
    active().setData(frame.history);
    fan.applyOptions({ midColor: midColors[lastFc ? lastFc.direction : 'flat'] });
    fan.setData(frame.future);
    chart.timeScale().setVisibleRange(frame.range);
  }

  function setForecast(fc, series, nowMs) {
    lastFc = fc;
    if (series && series.length) setData(series, nowMs);
  }

  // update() throws on out-of-order times, so a failed update falls back to a full reload.
  function pushBar(series, nowMs) {
    const last = series[series.length - 1];
    if (!last) return;
    try {
      if (mode === 'line') {
        area.update(toLine(last));
      } else {
        const tail = bucketCandles(series.slice(-(CANDLE_SEC + 2)), CANDLE_SEC, 1);
        if (tail[0]) candles.update(toCandle(tail[0]));
      }
    } catch {
      setData(series, nowMs);
    }
  }

  function setMode(next) {
    mode = next;
    area.applyOptions({ visible: next === 'line' });
    candles.applyOptions({ visible: next === 'candle' });
    placeBaseLine();
  }

  const ro = new ResizeObserver(() => {
    chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
  });
  ro.observe(el);

  return {
    setData,
    setForecast,
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
