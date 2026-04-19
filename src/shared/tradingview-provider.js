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

function findBrackets(strikesSorted, price) {
  if (!strikesSorted.length || price == null) {
    return { lower: null, upper: null, lowerIdx: -1, upperIdx: -1 };
  }

  let lo = 0;
  let hi = strikesSorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strikesSorted[mid] < price) lo = mid + 1;
    else hi = mid;
  }

  let upperIdx = lo < strikesSorted.length ? lo : -1;
  let lowerIdx = lo - 1 >= 0 ? lo - 1 : -1;

  if (upperIdx !== -1 && strikesSorted[upperIdx] === price) {
    lowerIdx = upperIdx;
    upperIdx = upperIdx + 1 < strikesSorted.length ? upperIdx + 1 : -1;
  }

  return {
    lower: lowerIdx !== -1 ? strikesSorted[lowerIdx] : null,
    upper: upperIdx !== -1 ? strikesSorted[upperIdx] : null,
    lowerIdx,
    upperIdx
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

function buildCallBidIvByStrike(byTypeStrike) {
  const out = {};
  for (const [key, row] of byTypeStrike.entries()) {
    if (!key.startsWith('call:')) continue;
    if (row?.strike == null) continue;
    out[row.strike] = row?.bid_iv ?? null;
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

export class TradingViewProvider {
  key = 'tradingview';

  async fetchSnapshot(config, metricDefinitions = []) {
    const px = await fetchYahooLastClose(config.yahooSymbol || 'SPY');
    if (px == null) {
      throw new Error('Could not fetch underlying price from Yahoo');
    }

    const options = await tvPostOptions(config.apiBase, buildOptionsBody(config));
    const { strikesSorted, byTypeStrike } = parseOptions(options);
    const { lower, upper, lowerIdx, upperIdx } = findBrackets(strikesSorted, px);

    const atmPut = getRow(byTypeStrike, 'put', lower);
    const atmCall = getRow(byTypeStrike, 'call', upper);

    const tailSteps = Math.max(1, Number(config.tailSteps) || 3);
    const putTailStrike = lowerIdx - tailSteps >= 0 ? strikesSorted[lowerIdx - tailSteps] : null;
    const callTailStrike = upperIdx + tailSteps < strikesSorted.length ? strikesSorted[upperIdx + tailSteps] : null;

    const putTail = getRow(byTypeStrike, 'put', putTailStrike);
    const callTail = getRow(byTypeStrike, 'call', callTailStrike);

    const basePoint = {
      time: new Date().toISOString(),
      px,
      lower,
      upper,
      atmPutIv: atmPut?.iv ?? null,
      atmCallIv: atmCall?.iv ?? null,
      putTailIv: putTail?.bid_iv ?? null,
      callTailIv: callTail?.bid_iv ?? null,
      putBidIvByStrike: buildPutBidIvByStrike(byTypeStrike),
      putStrikesAsc: buildPutStrikesAsc(byTypeStrike),
      putStrikesDesc: buildPutStrikesDesc(byTypeStrike),
      callBidIvByStrike: buildCallBidIvByStrike(byTypeStrike),
      callStrikesAsc: buildCallStrikesAsc(byTypeStrike)
    };

    const metrics = computeMetrics(metricDefinitions, basePoint);

    return {
      ...basePoint,
      ...metrics,
      metrics
    };
  }
}
