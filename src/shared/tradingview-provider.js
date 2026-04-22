import { findStrikesAroundPrice } from './option-chain-utils.js';

const toNum = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

function buildUrl(apiBase, path) {
  return `${apiBase.replace(/\/+$/, '')}${path}?label-product=options-builder`;
}

async function tvPostOptions(apiBase, bodyText) {
  const res = await fetch(buildUrl(apiBase, '/options/scan2'), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'text/plain;charset=UTF-8'
    },
    body: bodyText
  });

  return res.json();
}

function buildOptionsBody({ root, expiry, ticker }) {
  return JSON.stringify({
    columns: ['ask', 'bid', 'currency', 'delta', 'expiration', 'gamma', 'iv', 'option-type', 'pricescale', 'rho', 'root', 'strike', 'theoPrice', 'theta', 'vega', 'bid_iv', 'ask_iv'],
    filter: [
      { left: 'type', operation: 'equal', right: 'option' },
      { left: 'expiration', operation: 'equal', right: Number(expiry) },
      { left: 'root', operation: 'equal', right: String(root) }
    ],
    ignore_unknown_fields: false,
    index_filters: [{ name: 'underlying_symbol', values: [String(ticker)] }]
  });
}

function buildIndex(fields) {
  const idx = {};
  fields.forEach((f, i) => { idx[f] = i; });
  return idx;
}

function parseOptions(json) {
  if (!json || !Array.isArray(json.fields) || !Array.isArray(json.symbols)) {
    return { strikesSorted: [], byTypeStrike: new Map() };
  }

  const idx = buildIndex(json.fields);
  const byTypeStrike = new Map();
  const strikesSet = new Set();

  for (const row of json.symbols) {
    const f = row?.f;
    if (!Array.isArray(f)) continue;

    const strike = toNum(f[idx.strike]);
    const type = String(f[idx['option-type']] || '').toLowerCase();
    if (strike == null || (type !== 'call' && type !== 'put')) continue;

    byTypeStrike.set(`${type}:${strike}`, {
      strike,
      type,
      bid: toNum(f[idx.bid]),
      iv: toNum(f[idx.iv]),
      bid_iv: toNum(f[idx.bid_iv])
    });
    strikesSet.add(strike);
  }

  return {
    strikesSorted: Array.from(strikesSet).sort((a, b) => a - b),
    byTypeStrike
  };
}

async function fetchYahooLastClose(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
  const res = await fetch(url);
  const json = await res.json();

  const result = json?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close;
  if (Array.isArray(closes)) {
    for (let i = closes.length - 1; i >= 0; i -= 1) {
      const v = toNum(closes[i]);
      if (v != null) return v;
    }
  }

  return toNum(result?.meta?.regularMarketPrice);
}

function getRow(map, type, strike) {
  if (strike == null) return null;
  return map.get(`${type}:${strike}`) || null;
}

function buildPutBidIvByStrike(byTypeStrike) {
  const out = {};
  for (const [key, row] of byTypeStrike.entries()) {
    if (!key.startsWith('put:')) continue;
    if (row?.strike == null) continue;
    out[row.strike] = row?.bid_iv ?? null;
  }
  return out;
}

function buildPutBidByStrike(byTypeStrike) {
  const out = {};
  for (const [key, row] of byTypeStrike.entries()) {
    if (!key.startsWith('put:')) continue;
    if (row?.strike == null) continue;
    out[row.strike] = row?.bid ?? null;
  }
  return out;
}


function buildPutIvByStrike(byTypeStrike) {
  const out = {};
  for (const [key, row] of byTypeStrike.entries()) {
    if (!key.startsWith('put:')) continue;
    if (row?.strike == null) continue;
    out[row.strike] = row?.iv ?? null;
  }
  return out;
}

function buildCallIvByStrike(byTypeStrike) {
  const out = {};
  for (const [key, row] of byTypeStrike.entries()) {
    if (!key.startsWith('call:')) continue;
    if (row?.strike == null) continue;
    out[row.strike] = row?.iv ?? null;
  }
  return out;
}

function buildCallBidIvByStrike(byTypeStrike) {
  const out = {};
  for (const [key, row] of byTypeStrike.entries()) {
    if (!key.startsWith('call:')) continue;
    if (row?.strike == null) continue;
    out[row.strike] = row?.bid_iv ?? null;
  }
  return out;
}

function buildCallBidByStrike(byTypeStrike) {
  const out = {};
  for (const [key, row] of byTypeStrike.entries()) {
    if (!key.startsWith('call:')) continue;
    if (row?.strike == null) continue;
    out[row.strike] = row?.bid ?? null;
  }
  return out;
}

function buildCallStrikesAsc(byTypeStrike) {
  const strikes = [];
  for (const [key, row] of byTypeStrike.entries()) {
    if (!key.startsWith('call:')) continue;
    if (row?.strike == null) continue;
    strikes.push(row.strike);
  }

  return strikes.sort((a, b) => a - b);
}

function buildPutStrikesAsc(byTypeStrike) {
  const strikes = [];
  for (const [key, row] of byTypeStrike.entries()) {
    if (!key.startsWith('put:')) continue;
    if (row?.strike == null) continue;
    strikes.push(row.strike);
  }

  return strikes.sort((a, b) => a - b);
}

function buildPutStrikesDesc(byTypeStrike) {
  const strikes = [];
  for (const [key, row] of byTypeStrike.entries()) {
    if (!key.startsWith('put:')) continue;
    if (row?.strike == null) continue;
    strikes.push(row.strike);
  }

  return strikes.sort((a, b) => b - a);
}

function computeMetrics(metricDefinitions, basePoint) {
  const values = {};
  for (const metric of metricDefinitions) {
    if (!metric?.key || typeof metric.compute !== 'function') continue;
    try {
      values[metric.key] = metric.compute(basePoint);
    } catch (_err) {
      values[metric.key] = null;
    }
  }

  return values;
}

function parseExpiryDate(value) {
  const raw = String(value || '').trim();
  if (!/^\d{8}$/.test(raw)) return null;

  const y = Number(raw.slice(0, 4));
  const m = Number(raw.slice(4, 6));
  const d = Number(raw.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

function fmtExpiryDate(dt) {
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, '0'),
    String(dt.getUTCDate()).padStart(2, '0')
  ].join('');
}

function expandExpiryRange(startValue, endValue) {
  const start = parseExpiryDate(startValue);
  if (!start) return [];

  const parsedEnd = parseExpiryDate(endValue);
  const end = parsedEnd && parsedEnd >= start ? parsedEnd : start;
  const out = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    out.push(fmtExpiryDate(cursor));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return out;
}

function buildBasePoint(px, byTypeStrike, nowIso) {
  const strikesSorted = Array.from(new Set([
    ...buildCallStrikesAsc(byTypeStrike),
    ...buildPutStrikesAsc(byTypeStrike)
  ])).sort((a, b) => a - b);
  const { lower, upper, lowerIdx, upperIdx } = findStrikesAroundPrice(strikesSorted, px);

  const atmPut = getRow(byTypeStrike, 'put', lower);
  const atmCall = getRow(byTypeStrike, 'call', upper);

  return {
    time: nowIso,
    px,
    lower,
    upper,
    atmPutIv: atmPut?.iv ?? null,
    atmCallIv: atmCall?.iv ?? null,
    putBidIvByStrike: buildPutBidIvByStrike(byTypeStrike),
    putBidByStrike: buildPutBidByStrike(byTypeStrike),
    putIvByStrike: buildPutIvByStrike(byTypeStrike),
    putStrikesAsc: buildPutStrikesAsc(byTypeStrike),
    putStrikesDesc: buildPutStrikesDesc(byTypeStrike),
    callBidIvByStrike: buildCallBidIvByStrike(byTypeStrike),
    callBidByStrike: buildCallBidByStrike(byTypeStrike),
    callIvByStrike: buildCallIvByStrike(byTypeStrike),
    callStrikesAsc: buildCallStrikesAsc(byTypeStrike)
  };
}

export class TradingViewProvider {
  key = 'tradingview';

  async fetchSnapshot(config, metricDefinitions = []) {
    const px = await fetchYahooLastClose(config.yahooSymbol || 'SPY');
    if (px == null) {
      throw new Error('Could not fetch underlying price from Yahoo');
    }

    const nowIso = new Date().toISOString();
    const expiryStart = String(config.expiryStart || config.expiry || '').trim();
    const expiryEnd = String(config.expiryEnd || '').trim();
    const expiries = expandExpiryRange(expiryStart, expiryEnd || expiryStart);
    const expiryList = expiries.length ? expiries : [expiryStart].filter(Boolean);
    if (!expiryList.length) throw new Error('Expiry start is required');

    const byExpiry = {};
    for (const expiry of expiryList) {
      const options = await tvPostOptions(config.apiBase, buildOptionsBody({ ...config, expiry }));
      const { byTypeStrike } = parseOptions(options);
      byExpiry[expiry] = buildBasePoint(px, byTypeStrike, nowIso);
    }

    const primaryExpiry = expiryList[0];
    const primarySnapshot = byExpiry[primaryExpiry] || byExpiry[expiryList[0]];
    const basePoint = {
      ...primarySnapshot,
      expiry: primaryExpiry,
      byExpiry
    };

    const metrics = computeMetrics(metricDefinitions, basePoint);

    return {
      ...basePoint,
      ...metrics,
      metrics
    };
  }
}
