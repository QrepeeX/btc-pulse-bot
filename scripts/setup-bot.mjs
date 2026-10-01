import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MENU_TEXT = 'Открыть график';
export const DESCRIPTION = 'Показываю, как изменился BTC за последние 5 минут, и рисую график. Нажми «Открыть график» внизу.';
export const SHORT_DESCRIPTION = 'Нажми «Открыть график» внизу';

const TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let val = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/.test(val)) val = val.slice(1, -1);
    out[line.slice(0, eq).trim()] = val;
  }
  return out;
}

function loadEnv(envPath, processEnv) {
  let file = {};
  try {
    file = parseEnv(readFileSync(envPath, 'utf8'));
  } catch {}
  return {
    BOT_TOKEN: file.BOT_TOKEN || processEnv.BOT_TOKEN || '',
    WEBAPP_URL: file.WEBAPP_URL || processEnv.WEBAPP_URL || '',
  };
}

class ApiError extends Error {}

export async function run({
  envPath = fileURLToPath(new URL('../.env', import.meta.url)),
  processEnv = process.env,
  fetchImpl = (...a) => fetch(...a),
  log = console.log,
  logError = console.error,
} = {}) {
  const { BOT_TOKEN: token, WEBAPP_URL: url } = loadEnv(envPath, processEnv);
  const mask = (s) => (token ? String(s).split(token).join('***') : String(s));
  const out = (m) => log(mask(m));
  const fail = (m) => logError(mask(m));

  if (!token || !url) {
    fail('Нужны BOT_TOKEN и WEBAPP_URL в .env (см. .env.example).');
    return 1;
  }
  if (!TOKEN_RE.test(token)) {
    fail('BOT_TOKEN выглядит неверно. Формат: 123456789:AA... из @BotFather.');
    return 1;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail('WEBAPP_URL не похож на ссылку.');
    return 1;
  }
  if (parsed.protocol !== 'https:') {
    fail('WEBAPP_URL должен начинаться с https:// (Telegram не открывает http).');
    return 1;
  }

  const call = async (method, payload = {}) => {
    let res;
    try {
      res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new ApiError(`${method}: сеть недоступна (${e.message})`);
    }
    let body = null;
    try {
      body = await res.json();
    } catch {}
    if (!res.ok || !body || body.ok !== true) {
      throw new ApiError(`${method}: ${(body && body.description) || `HTTP ${res.status}`}`);
    }
    return body.result;
  };

  try {
    const me = await call('getMe');
    out(`Бот: @${me.username}`);
    const menu = { type: 'web_app', text: MENU_TEXT, web_app: { url } };
    await call('setChatMenuButton', { menu_button: menu });
    await call('setMyDescription', { description: DESCRIPTION });
    await call('setMyShortDescription', { short_description: SHORT_DESCRIPTION });
    await call('setMyCommands', { commands: [] });

    const check = await call('getChatMenuButton');
    if (check.type !== 'web_app' || check.text !== MENU_TEXT || !check.web_app || check.web_app.url !== url) {
      throw new ApiError('getChatMenuButton: кнопка не совпадает с ожидаемой.');
    }
    out(`Готово. Кнопка «${MENU_TEXT}» -> ${url}`);
    return 0;
  } catch (e) {
    fail(e instanceof ApiError ? e.message : `Неожиданная ошибка: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await run();
}
