const { completedSessionDate } = require('./realized-correlation-provider.cjs');
const { isDate, threeMonthsBefore, tradingSessions } = require('./trading-calendar-provider.cjs');

const FIRST_VIX_DATE = '1990-01-02';
const WARMUP_MS = 400 * 86_400_000;

function emptyResult(startDate, endDate, error) {
  return { status: 'error', startDate, endDate, series: [], latest: null, sources: {}, warnings: [], summary: '', error };
}

function createVixeqDynamicsService({ marketData, getMarketHolidays, now = () => new Date() }) {
  async function getState({ startDate = '', endDate = '', vixeqLocalSource = '', forceRefresh = false } = {}) {
    if ((startDate && !isDate(startDate)) || (endDate && !isDate(endDate))) {
      throw new Error('Enter valid start and end dates.');
    }
    const cutoff = completedSessionDate(now());
    const end = endDate && endDate < cutoff ? endDate : cutoff;
    const start = startDate || threeMonthsBefore(end);
    if (start > end) throw new Error('Start date must be on or before the last completed date in the range.');
    if (end < FIRST_VIX_DATE) return emptyResult(start, end, 'VIX history starts on 1990-01-02.');

    const effectiveStart = start < FIRST_VIX_DATE ? FIRST_VIX_DATE : start;
    const warmupStart = Math.max(Date.parse(FIRST_VIX_DATE), Date.parse(effectiveStart) - WARMUP_MS);
    const holidays = await getMarketHolidays(new Date(`${end}T12:00:00Z`), { startYear: new Date(warmupStart).getUTCFullYear() });
    const sessions = tradingSessions(warmupStart, Date.parse(end), holidays);
    const firstVisible = sessions.findIndex((date) => date >= effectiveStart);
    if (firstVisible === -1) return emptyResult(effectiveStart, end, 'No completed sessions in the selected date range.');

    const { calculateVixeqDynamics, describeVixeqDynamics, VIXEQ_SERIES } = await import('../shared/vixeq-dynamics-calculations.mjs');
    const latestDate = sessions.at(-1);
    const localSource = typeof vixeqLocalSource === 'string' ? vixeqLocalSource.trim() : '';
    const results = await Promise.allSettled(VIXEQ_SERIES.map(async (key) => marketData.getDailyHistory({
      symbol: key.toUpperCase(), provider: 'cboe', startDate: sessions[0], endDate: latestDate, forceRefresh,
      ...(key === 'vixeq' && localSource ? { dataMode: 'local', localSource } : { dataMode: 'hybrid' })
    })));

    const sessionDates = new Set(sessions);
    const warnings = [];
    const histories = {};
    const sources = {};
    for (const [index, key] of VIXEQ_SERIES.entries()) {
      const result = results[index];
      const source = result.status === 'fulfilled' ? result.value : null;
      const label = key.toUpperCase();
      const requestedProvider = key === 'vixeq' && localSource ? 'local' : 'cboe';
      const bars = source?.bars.filter(({ date }) => sessionDates.has(date)) ?? [];
      const lastCloseDate = bars.at(-1)?.date ?? null;
      histories[key] = bars;
      sources[key] = {
        provider: source?.provider ?? null, requestedProvider, latestDate: lastCloseDate,
        updatedAt: source?.updatedAt ?? null, cached: source?.cached === true,
        stale: source?.cached === true && source.cacheFresh === false
      };
      if (!source) warnings.push(`${label} unavailable. ${result.reason?.message || result.reason}`);
      if (source?.warning) warnings.push(`${label}: ${source.warning}`);
      if (source && lastCloseDate !== latestDate) warnings.push(`${label} close for ${latestDate} is unavailable.`);
    }

    const series = calculateVixeqDynamics(sessions, histories).slice(firstVisible);
    const latest = series.at(-1);
    const hasCloses = series.some((row) => VIXEQ_SERIES.some((key) => row[key] !== null));
    const partial = Object.values(sources).some(({ stale }) => stale)
      || series.some((row) => VIXEQ_SERIES.some((key) => row[key] === null));
    return {
      status: hasCloses ? (partial ? 'partial' : 'ok') : 'error',
      startDate: effectiveStart, endDate: end, series, latest, sources, warnings, summary: describeVixeqDynamics(latest),
      ...(hasCloses ? {} : { error: 'No VIXEQ, VIX or COR1M closes in the selected date range.' })
    };
  }

  return { getState };
}

module.exports = { createVixeqDynamicsService };
