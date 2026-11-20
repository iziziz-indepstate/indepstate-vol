const fs = require('fs/promises');
const path = require('path');

function appConfigPath(appLike) {
  return path.join(appLike.getPath('documents'), 'IS-VOL', 'config.json');
}

async function ensureAppConfig(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const defaults = {
    tradingview: { cookie: '' },
    _examples: {
      'tradingview.cookie': 'sessionid=YOUR_SESSION_ID; sessionid_sign=YOUR_SESSION_SIGNATURE; device_t=YOUR_DEVICE_TOKEN',
      usage: 'Paste the Cookie header value into tradingview.cookie. Empty means anonymous requests. Changes apply on the next snapshot request.'
    }
  };
  try {
    await fs.writeFile(file, `${JSON.stringify(defaults, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

async function readTradingViewCookie(file) {
  await ensureAppConfig(file);
  let config;
  try {
    // Do not include parser errors: they can contain fragments of the session cookie.
    config = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`Cannot read app configuration: ${file}. Check that it contains valid JSON.`);
  }
  const cookie = config?.tradingview?.cookie;
  if (cookie == null) return '';
  if (typeof cookie !== 'string' || /[\r\n]/.test(cookie)) {
    throw new Error(`Invalid tradingview.cookie in ${file}: expected a single-line string.`);
  }
  return cookie.trim();
}

module.exports = { appConfigPath, ensureAppConfig, readTradingViewCookie };
