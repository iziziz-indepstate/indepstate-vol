const { completedSessionDate } = require('./realized-correlation-provider.cjs');
const { FALLBACK_PROVIDERS } = require('./market-data-providers.cjs');

const DAY = 86400000;
const WARMUP_DAYS = 120;
const FIRST_VIX_DATE = '1990-01-02';

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function threeMonthsBefore(endDate) {
  const date = new Date(endDate);
  const day = date.getUTCDate();
  date.setUTCMonth(date.getUTCMonth() - 3, 1);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return isoDate(date);
}

function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && isoDate(new Date(value)) === value;
}

function tradingSessions(start, cutoff, holidays) {
  const closed = new Set(holidays);
  const sessions = [];
  for (let time = start; time <= cutoff; time += DAY) {
    const day = new Date(time);
    const date = day.toISOString().slice(0, 10);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6 && !closed.has(date)) sessions.push(date);
  }
  return sessions;
}

function createVixResponseService({ marketData, getMarketHolidays, now = () => new Date() }) {
  const inFlight = new Map();

  async function load(spxProvider, ivProvider, startDate, endDate, forceRefresh) {
    const { calculateResidualBands, calculateVixResponse, VIX_RESPONSE_MODEL } = await import('../shared/vix-response-calculations.mjs');
    const end = Date.parse(endDate);
    const start = Date.parse(startDate) - WARMUP_DAYS * DAY;
    const holidays = await getMarketHolidays(new Date(`${endDate}T12:00:00Z`), { startYear: new Date(start).getUTCFullYear() });
    const sessions = tradingSessions(start, end, holidays);
    const firstDisplayIndex = sessions.findIndex((date) => date >= startDate);
    const latestDate = sessions.at(-1);
    if (firstDisplayIndex === -1) {
      return { status: 'error', startDate, endDate, latest: null, series: [], residualBands: null, model: VIX_RESPONSE_MODEL,
        sources: {}, warnings: [], error: 'No completed sessions in the selected date range.' };
    }
    const dates = new Set(sessions);
    const inputs = [['SPX', spxProvider], ['VIX', ivProvider]];
    const results = await Promise.allSettled(inputs.map(([symbol, provider]) => marketData.getDailyHistory({
      symbol, provider, dataMode: 'hybrid', startDate: sessions[0], endDate: latestDate, forceRefresh
    })));
    const warnings = [];
    const bars = [];
    const sources = {};
    for (const [index, [symbol, requestedProvider]] of inputs.entries()) {
      const result = results[index];
      const source = result.status === 'fulfilled' ? result.value : null;
      const history = source ? source.bars.filter(({ date }) => dates.has(date)) : [];
      const lastCloseDate = history.at(-1)?.date ?? null;
      bars.push(history);
      const provider = source?.provider ?? null;
      const fallback = provider !== null && provider !== requestedProvider;
      sources[symbol.toLowerCase()] = {
        provider, requestedProvider, fallback, latestDate: lastCloseDate, updatedAt: source?.updatedAt ?? null,
        cached: source?.cached === true, stale: source?.cached === true && source.cacheFresh === false
      };
      if (!source) warnings.push(`${symbol} unavailable. ${result.reason?.message || result.reason}`);
      if (source?.warning) warnings.push(`${symbol}: ${source.warning}`);
      if (source && lastCloseDate !== latestDate) warnings.push(`${symbol} close for ${latestDate} is unavailable.`);
    }
    const series = calculateVixResponse({ sessions, spxBars: bars[0], vixBars: bars[1] }).slice(firstDisplayIndex);
    const residualBands = calculateResidualBands(series);
    const latest = series.at(-1);
    const hasResponse = series.some((row) => row.residual !== null);
    const stale = Object.values(sources).some((source) => source.stale);
    const status = hasResponse ? (latest.residual === null || stale ? 'partial' : 'ok') : 'error';
    if (status === 'partial' && latest.residual === null && sources.spx.latestDate === latestDate && sources.vix.latestDate === latestDate) {
      warnings.push(`Response unavailable for ${latestDate}. The model requires 60 complete prior sessions with varying SPX returns.`);
    }
    return { status, startDate, endDate, latest, series, residualBands, model: VIX_RESPONSE_MODEL, sources, warnings,
      ...(hasResponse ? {} : { error: 'No response could be calculated from the available daily closes.' }) };
  }

  function getState({ spxProvider, ivProvider, startDate = '', endDate = '', forceRefresh = false } = {}) {
    if ((startDate && !isDate(startDate)) || (endDate && !isDate(endDate))) {
      return Promise.reject(new Error('Enter valid start and end dates.'));
    }
    const cutoff = completedSessionDate(now());
    const end = endDate && endDate < cutoff ? endDate : cutoff;
    const start = startDate || threeMonthsBefore(end);
    if (start > end) return Promise.reject(new Error('Start date must be on or before the last completed date in the range.'));
    if (end < FIRST_VIX_DATE) return Promise.reject(new Error('VIX history starts on 1990-01-02.'));
    const effectiveStart = start < FIRST_VIX_DATE ? FIRST_VIX_DATE : start;
    const spx = FALLBACK_PROVIDERS.SPX.includes(spxProvider) ? spxProvider : 'yahoo';
    const vix = FALLBACK_PROVIDERS.VIX.includes(ivProvider) ? ivProvider : 'cboe';
    const key = `${spx}/${vix}/${effectiveStart}/${end}`;
    const pending = inFlight.get(key);
    if (pending && (pending.forced || !forceRefresh)) return pending.promise;
    const request = { forced: forceRefresh };
    if (forceRefresh) {
      request.promise = Promise.resolve(pending?.promise).catch(() => {}).then(() => load(spx, vix, effectiveStart, end, true));
    } else {
      request.promise = load(spx, vix, effectiveStart, end, false);
    }
    request.promise = request.promise.finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key);
    });
    inFlight.set(key, request);
    return request.promise;
  }

  return { getState };
}

module.exports = { createVixResponseService };
