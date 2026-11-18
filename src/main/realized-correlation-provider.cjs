const fs = require('fs');
const path = require('path');
const { createMarketDataService, parseCsv } = require('./market-data-providers.cjs');

const HOLDINGS_URL = 'https://www.ishares.com/us/products/239726/ishares-core-s-p-500-etf/latest-holdings.csv';
const TTL = 24 * 60 * 60 * 1000;

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function completedSessionDate(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (Number(parts.hour) * 60 + Number(parts.minute) >= 16 * 60 + 15) return date;
  return new Date(Date.parse(date) - 86400000).toISOString().slice(0, 10);
}

function parseHoldings(raw) {
  const lines = String(raw).replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = lines.findIndex((line) => /^Ticker,/.test(line));
  if (header < 0) throw new Error('IVV holdings CSV header not found');
  const asOfRaw = lines.find((line) => /^Fund Holdings as of,/.test(line));
  const asOfValue = asOfRaw?.slice(asOfRaw.indexOf(',') + 1).replaceAll('"', '').trim();
  const asOfTime = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(asOfValue) ? `${asOfValue}T00:00:00Z` : `${asOfValue} UTC`);
  if (!Number.isFinite(asOfTime)) throw new Error('IVV holdings date not found');
  const rows = parseCsv(lines.slice(header).join('\n'));
  const seen = new Set();
  const basket = rows.filter((row) => row['Asset Class'] === 'Equity' && (!row.Type || row.Type === 'EQUITY'))
    .map((row) => ({ symbol: row.Ticker, name: row.Name, indexWeight: Number(row['Market Weight'] ?? row['Weight (%)']) }))
    .filter((row) => /^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(row.symbol) && row.indexWeight > 0)
    .sort((a, b) => b.indexWeight - a.indexWeight || a.symbol.localeCompare(b.symbol))
    .filter((row) => { if (seen.has(row.symbol)) return false; seen.add(row.symbol); return true; })
    .slice(0, 50);
  if (basket.length !== 50) throw new Error(`IVV returned only ${basket.length} valid equities; expected 50`);
  const total = basket.reduce((sum, row) => sum + row.indexWeight, 0);
  return { asOf: new Date(asOfTime).toISOString().slice(0, 10), basket: basket.map((row) => ({ ...row, weight: row.indexWeight / total })) };
}

function createRealizedCorrelationService({ cacheDir, fetchImpl = global.fetch, now = () => new Date() }) {
  const inFlight = new Map();
  let active = 0;
  const queue = [];
  function schedule(work) {
    return new Promise((resolve, reject) => {
      queue.push(async () => {
        active += 1;
        try { resolve(await work()); } catch (error) { reject(error); }
        finally { active -= 1; drain(); }
      });
      drain();
    });
  }
  function drain() { while (active < 4 && queue.length) queue.shift()(); }
  function shared(key, work) {
    if (!inFlight.has(key)) inFlight.set(key, schedule(work).finally(() => inFlight.delete(key)));
    return inFlight.get(key);
  }
  const timedFetch = (url, options) => fetchImpl(url, { ...options, signal: AbortSignal.timeout(20000) });
  const market = createMarketDataService({ cacheDir: path.join(cacheDir, 'histories'), fetchImpl: timedFetch });

  // Store requested coverage separately from actual bars (weekends and holidays have no rows).
  async function cachedLoad(key, request, load) {
    const file = path.join(cacheDir, `${key}.json`);
    let cached;
    try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* Cache miss. */ }
    const covers = cached && (!request.startDate || cached.startDate <= request.startDate)
      && (!request.endDate || cached.endDate >= request.endDate);
    const fresh = covers && now().getTime() - Date.parse(cached.updatedAt) < TTL;
    if (request.cache !== false && !request.forceRefresh && fresh) return { ...cached.data, cached: true, updatedAt: cached.updatedAt };
    try {
      const data = await load();
      const updatedAt = now().toISOString();
      if (request.cache !== false) {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ startDate: request.startDate, endDate: request.endDate, updatedAt, data }));
      }
      return { ...data, cached: false, updatedAt };
    } catch (error) {
      if (request.cache !== false && covers) return { ...cached.data, cached: true, updatedAt: cached.updatedAt,
        warning: `Refresh failed; using cache from ${cached.updatedAt}. ${error.message}` };
      throw error;
    }
  }

  async function history(symbol, request, adjusted = false) {
    const key = `${adjusted ? 'adjusted' : 'raw'}-${symbol}`;
    return shared(JSON.stringify([key, request]), () => cachedLoad(key, request, () => market.getDailyHistory({
      ...request, symbol, provider: symbol === 'COR1M' ? 'cboe' : 'yahoo',
      priceMode: adjusted ? 'adjusted' : undefined, fallbackProviders: [], cache: false
    })));
  }

  async function getInputs(params = {}) {
    const { resolveEwmaConfig } = await import('../shared/realized-correlation-calculations.mjs');
    const ewma = resolveEwmaConfig(params.ewmaHalfLife);
    const today = now();
    const cutoff = completedSessionDate(today);
    const defaultStart = new Date(today);
    defaultStart.setUTCFullYear(defaultStart.getUTCFullYear() - 1);
    const startDate = params.startDate || defaultStart.toISOString().slice(0, 10);
    const endDate = params.endDate || cutoff;
    if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) throw new Error('Invalid correlation date range');
    const effectiveEnd = endDate < cutoff ? endDate : cutoff;
    if (startDate > effectiveEnd) throw new Error('No completed sessions in selected period');
    let warmupDays = Math.max(60, Math.ceil(ewma.lookbackSessions * 365.25 / 252) + 14);
    const request = { endDate: effectiveEnd, cache: params.cache !== false, forceRefresh: Boolean(params.forceRefresh) };
    let calendar;
    let previousFirstDate;
    // Verify actual session coverage rather than assuming a fixed holiday calendar.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      request.startDate = new Date(Date.parse(startDate) - warmupDays * 86400000).toISOString().slice(0, 10);
      calendar = await history('SPX', { ...request });
      const priorDates = new Set(calendar.bars.filter((bar) => bar.date < startDate && bar.date >= request.startDate).map((bar) => bar.date));
      const firstDate = calendar.bars[0]?.date;
      if (priorDates.size >= ewma.lookbackSessions || firstDate === previousFirstDate) break;
      previousFirstDate = firstDate;
      warmupDays *= 2;
    }
    const warmupStart = request.startDate;
    const holdingsRequest = { cache: request.cache, forceRefresh: request.forceRefresh };
    const holdings = await shared(JSON.stringify(['holdings', holdingsRequest]), () => cachedLoad('ivv-holdings', holdingsRequest, async () => {
      const response = await timedFetch(HOLDINGS_URL, { headers: { 'User-Agent': 'IS-VOL/1.0' } });
      if (!response.ok) throw new Error(`IVV holdings: HTTP ${response.status}`);
      return { ...parseHoldings(await response.text()), provider: 'ishares', url: HOLDINGS_URL };
    }));
    const requests = [...holdings.basket.map(async ({ symbol }) => {
      try { return await history(symbol, request, true); }
      catch (error) { throw new Error(`${symbol}: ${error.message}`); }
    }), history('COR1M', request)];
    const results = await Promise.allSettled(requests);
    const failures = results.slice(0, -1).filter((result) => result.status === 'rejected');
    if (failures.length) throw new Error(failures.map((result) => result.reason.message).join(' | '));
    const prices = Object.fromEntries(holdings.basket.map(({ symbol }, i) => [symbol, results[i].value]));
    const impliedResult = results.at(-1);
    const cor1m = impliedResult.status === 'fulfilled' ? impliedResult.value : null;
    const warnings = [holdings.warning, calendar.warning, ...Object.values(prices).map((result) => result.warning),
      cor1m?.warning, cor1m ? null : `COR1M unavailable: ${impliedResult.reason.message}`].filter(Boolean);
    if (new Set(calendar.bars.filter((bar) => bar.date < startDate && bar.date >= warmupStart).map((bar) => bar.date)).size < ewma.lookbackSessions) {
      warnings.push(`Full EWMA warmup (${ewma.lookbackSessions} sessions) is unavailable; initial values use available consecutive history after the 21-return minimum.`);
    }
    // A covering cache can contain later observations. Never expose them beyond the cutoff.
    const trim = (result) => result ? { ...result, bars: result.bars.filter((bar) => bar.date >= warmupStart && bar.date <= effectiveEnd) } : null;
    return { startDate, endDate: effectiveEnd, ewmaHalfLife: ewma.halfLife, holdings, calendar: trim(calendar),
      prices: Object.fromEntries(Object.entries(prices).map(([symbol, result]) => [symbol, trim(result)])),
      cor1m: trim(cor1m), warnings };
  }
  return { getInputs };
}

module.exports = { createRealizedCorrelationService, parseHoldings, completedSessionDate, HOLDINGS_URL };
