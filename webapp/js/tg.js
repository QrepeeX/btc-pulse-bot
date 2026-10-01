const BG = '#0A0A0F';

export function initTelegram(win = window) {
  const wa = win.Telegram && win.Telegram.WebApp;
  const params = new URLSearchParams(win.location.search);
  const ua = (win.navigator && win.navigator.userAgent) || '';
  const lowPerf = params.get('lowperf') === '1' || /Telegram-Android\/.*\bLOW\b/.test(ua);

  if (!wa) {
    return {
      isTelegram: false,
      lowPerf,
      selectionChanged() {},
      onActivated() {},
    };
  }

  const at = (v) => {
    try {
      return wa.isVersionAtLeast(v);
    } catch {
      return false;
    }
  };

  try {
    wa.ready();
    wa.expand();
    if (at('6.1')) {
      wa.setHeaderColor(BG);
      wa.setBackgroundColor(BG);
    }
    if (at('7.7')) wa.disableVerticalSwipes();
  } catch {}

  return {
    isTelegram: true,
    lowPerf,
    selectionChanged() {
      try {
        if (at('6.1')) wa.HapticFeedback.selectionChanged();
      } catch {}
    },
    onActivated(cb) {
      try {
        if (at('8.0')) wa.onEvent('activated', cb);
      } catch {}
    },
  };
}
