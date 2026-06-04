const fs = require('fs');
const path = require('path');
const { loadLocalMarketSeries } = require('./local-market-data.cjs');

const SYMBOL_MAP = {
  fred: { SPX: 'SP500', VIX: 'VIXCLS' },
  yahoo: { SPX: '^GSPC', VIX: '^VIX', VIX9D: '^VIX9D' },
  cboe: { VIX: 'VIX', VIX9D: 'VIX9D' }
};

const FALLBACK_PROVIDERS = {
  SPX: ['fred', 'yahoo'],
  VIX: ['cboe', 'fred', 'yahoo'],
  VIX9D: ['cboe', 'yahoo']
};
const DEFAULT_CACHE_TTL_MINUTES = 1440;

function field(row, names) {
  for (const name of names) {
    if (row?.[name] != null && String(row[name]).trim() !== '') return row[name];
  }
  return null;
}

function normalizeDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const usDate = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const dateText = usDate
    ? `${usDate[3]}-${usDate[1].padStart(2, '0')}-${usDate[2].padStart(2, '0')}`
    : text.slice(0, 10);
  const parsed = new Date(`${dateText}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function normalizeBars(rows, symbol, source) {
  const byDate = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = normalizeDate(field(row, ['date', 'Date', 'DATE', 'observation_date']));
    const close = Number(field(row, ['close', 'Close', 'CLOSE', 'Last', 'last', 'value', 'Value']));
    if (!date || !Number.isFinite(close) || close <= 0) continue;
    const numberOrUndefined = (names) => {
      const rawValue = field(row, names);
      if (rawValue == null) return undefined;
      const value = Number(rawValue);
      return Number.isFinite(value) ? value : undefined;
    };
    byDate.set(date, {
      date,
      symbol,
      open: numberOrUndefined(['open', 'Open', 'OPEN']),
      high: numberOrUndefined(['high', 'High', 'HIGH']),
      low: numberOrUndefined(['low', 'Low', 'LOW']),
      close,
      source,
      updated_at: row?.updated_at || row?.updatedAt || undefined
    });
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function parseCsv(raw) {
  const lines = String(raw).split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const split = (line) => {
    const values = [];
    let value = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') {
        if (quoted && line[index + 1] === '"') {
          value += '"';
          index += 1;
        } else quoted = !quoted;
      } else if (char === ',' && !quoted) {
        values.push(value.trim());
        value = '';
      } else value += char;
    }
    values.push(value.trim());
    return values;
  };
  const headers = split(lines[0]).map((value) => value.replace(/^\uFEFF/, '').trim());
  return lines.slice(1).map((line) => {
    const values = split(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

function isoToUnix(date, fallback) {
  if (!date) return fallback;
  const value = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
  return Number.isFinite(value) ? value : fallback;
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { 'User-Agent': 'IS-VOL/1.0' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return response.text();
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { 'User-Agent': 'IS-VOL/1.0' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return response.json();
}

async function getFredHistory(params, fetchImpl) {
  const providerSymbol = SYMBOL_MAP.fred[params.symbol];
  if (!providerSymbol) throw new Error(`FRED does not support ${params.symbol}`);
  const query = new URLSearchParams({ id: providerSymbol });
  if (params.startDate) query.set('cosd', params.startDate);
  if (params.endDate) query.set('coed', params.endDate);
  const raw = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?${query}`, fetchImpl);
  const rows = parseCsv(raw).map((row) => ({ ...row, close: row[providerSymbol] }));
  return normalizeBars(rows, params.symbol, 'fred');
}

async function getYahooHistory(params, fetchImpl) {
  const providerSymbol = SYMBOL_MAP.yahoo[params.symbol];
  if (!providerSymbol) throw new Error(`Yahoo does not support ${params.symbol}`);
  const now = Math.floor(Date.now() / 1000);
  const query = new URLSearchParams({
    period1: String(isoToUnix(params.startDate, 0)),
    period2: String(isoToUnix(params.endDate, now) + 86400),
    interval: '1d',
    events: 'history'
  });
  const data = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(providerSymbol)}?${query}`, fetchImpl);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(data?.chart?.error?.description || `Yahoo symbol not found: ${providerSymbol}`);
  const quote = result.indicators?.quote?.[0] || {};
  const rows = (result.timestamp || []).map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString().slice(0, 10),
    open: quote.open?.[index],
    high: quote.high?.[index],
    low: quote.low?.[index],
    close: quote.close?.[index]
  }));
  return normalizeBars(rows, params.symbol, 'yahoo');
}

async function getCboeHistory(params, fetchImpl) {
  const providerSymbol = SYMBOL_MAP.cboe[params.symbol];
  if (!providerSymbol) throw new Error(`Cboe does not support ${params.symbol}`);
  const raw = await fetchText(`https://cdn.cboe.com/api/global/us_indices/daily_prices/${providerSymbol}_History.csv`, fetchImpl);
  const bars = normalizeBars(parseCsv(raw), params.symbol, 'cboe');
  return bars.filter((bar) => (!params.startDate || bar.date >= params.startDate) && (!params.endDate || bar.date <= params.endDate));
}

function cacheFile(cacheDir, provider, symbol) {
  return path.join(cacheDir, `${provider}-${symbol}.json`);
}

function readCache(cacheDir, provider, symbol, ttlMinutes) {
  const file = cacheFile(cacheDir, provider, symbol);
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const ageMs = Date.now() - new Date(cached.updatedAt).getTime();
    return { ...cached, fresh: ageMs <= Math.max(0, Number(ttlMinutes) || 0) * 60_000 };
  } catch (_error) {
    return null;
  }
}

function writeCache(cacheDir, provider, symbol, bars) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const payload = { provider, symbol, updatedAt: new Date().toISOString(), bars };
  fs.writeFileSync(cacheFile(cacheDir, provider, symbol), JSON.stringify(payload), 'utf-8');
  return payload;
}

function filterDates(bars, startDate, endDate) {
  return bars.filter((bar) => (!startDate || bar.date >= startDate) && (!endDate || bar.date <= endDate));
}

function cacheCovers(cached, startDate, endDate) {
  const bars = cached?.bars;
  if (!Array.isArray(bars) || !bars.length) return false;
  const first = bars[0]?.date;
  const last = bars.at(-1)?.date;
  return (!startDate || first <= startDate) && (!endDate || last >= endDate);
}

function createMarketDataService({ cacheDir, fetchImpl = global.fetch }) {
  const remoteProviders = {
    fred: getFredHistory,
    yahoo: getYahooHistory,
    cboe: getCboeHistory
  };

  async function loadRemote(provider, params) {
    const loader = remoteProviders[provider];
    if (!loader) throw new Error(`Unknown remote market data provider: ${provider}`);
    const bars = await loader(params, fetchImpl);
    if (!bars.length) throw new Error(`${provider} returned no valid ${params.symbol} data`);
    return bars;
  }

  async function getDailyHistory(params) {
    const mode = params.dataMode || 'remote';
    if (mode === 'local') {
      const bars = normalizeBars(loadLocalMarketSeries(params.localSource), params.symbol, 'local');
      if (!bars.length) throw new Error(`Local provider returned no valid ${params.symbol} data`);
      return { bars: filterDates(bars, params.startDate, params.endDate), provider: 'local', cached: false, fallback: false, updatedAt: null };
    }

    const candidates = Array.from(new Set([params.provider, ...(params.fallbackProviders || FALLBACK_PROVIDERS[params.symbol] || [])].filter(Boolean)));
    const errors = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const provider = candidates[index];
      const cached = params.cache === false
        ? null
        : readCache(cacheDir, provider, params.symbol, DEFAULT_CACHE_TTL_MINUTES);
      if (!params.forceRefresh && cached?.fresh && cacheCovers(cached, params.startDate, params.endDate)) {
        return {
          bars: filterDates(cached.bars, params.startDate, params.endDate),
          provider,
          cached: true,
          cacheFresh: cached.fresh,
          fallback: index > 0,
          updatedAt: cached.updatedAt
        };
      }
      try {
        const bars = await loadRemote(provider, params);
        const saved = params.cache === false ? null : writeCache(cacheDir, provider, params.symbol, bars);
        return { bars, provider, cached: false, fallback: index > 0, updatedAt: saved?.updatedAt || new Date().toISOString() };
      } catch (error) {
        errors.push(`${provider}: ${error?.message || error}`);
        if (mode === 'hybrid' && cached?.bars?.length) {
          return {
            bars: filterDates(cached.bars, params.startDate, params.endDate),
            provider,
            cached: true,
            cacheFresh: false,
            fallback: index > 0,
            updatedAt: cached.updatedAt,
            warning: `Remote refresh failed; using stale cache. ${error?.message || error}`
          };
        }
      }
    }
    throw new Error(`Unable to load ${params.symbol}. ${errors.join(' | ')}`);
  }

  return { getDailyHistory };
}

module.exports = {
  FALLBACK_PROVIDERS,
  SYMBOL_MAP,
  createMarketDataService,
  normalizeBars,
  parseCsv
};
