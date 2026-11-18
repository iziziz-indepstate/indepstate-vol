const fs = require('fs/promises');
const path = require('path');
const { Worker } = require('worker_threads');
const { createMarketDataService } = require('./market-data-providers.cjs');
const { parseHoldings, completedSessionDate, HOLDINGS_URL } = require('./realized-correlation-provider.cjs');

const INTERVAL = 15 * 60 * 1000;

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomicJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data), 'utf8');
  await fs.rename(temp, file);
}
function runWorker(data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'correlation-har-worker.cjs'), { workerData: data });
    let received = false;
    worker.once('message', (result) => { received = true; resolve(result); });
    worker.once('error', reject);
    worker.once('exit', (code) => { if (!received) reject(new Error(`HAR worker exited without a result (${code})`)); });
  });
}
function validateArchive(archive) {
  if (archive.version !== 1 || !Array.isArray(archive.records) || archive.records.some((row) =>
    !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(row.forecast) || !row.issuedAt
    || row.model?.version !== 1 || row.model?.horizon !== 21 || !Array.isArray(row.basket) || row.basket.length < 2
    || !(row.fact === null || Number.isFinite(row.fact)))) throw new Error('Invalid HAR forecast archive; restore the archive before updating.');
  if (new Set(archive.records.map((row) => row.date)).size !== archive.records.length) throw new Error('Duplicate dates in HAR archive');
  return archive;
}

function createCorrelationHarService({ directory, fetchImpl = global.fetch, now = () => new Date(), compute = runWorker,
  getMarketHolidays = async () => [] }) {
  const archiveFile = path.join(directory, 'forecasts.json');
  const market = createMarketDataService({ cacheDir: path.join(directory, 'unused'), fetchImpl: (url, options) =>
    fetchImpl(url, { ...options, signal: AbortSignal.timeout(20000) }) });
  let inFlight = null, lastState = null, lastAttempt = 0, forceNetwork = false;
  const queues = [];
  let active = 0;
  function drain() {
    while (active < 4 && queues.length) {
      active += 1;
      const { work, resolve, reject } = queues.shift();
      Promise.resolve().then(work).then(resolve, reject).finally(() => { active -= 1; drain(); });
    }
  }
  const schedule = (work) => new Promise((resolve, reject) => { queues.push({ work, resolve, reject }); drain(); });

  async function history(symbol, startDate, endDate, adjusted = false, requiredDates = []) {
    if (!/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(symbol)) throw new Error('Invalid HAR ticker');
    const file = path.join(directory, 'histories', `${adjusted ? 'adjusted' : 'raw'}-${symbol}.json`);
    let cached = null;
    try { cached = await readJson(file); } catch (_) { /* Recoverable price cache; never the forecast archive. */ }
    if (!Array.isArray(cached?.bars) || !cached.startDate || !cached.endDate) cached = null;
    const present = new Set((cached?.bars || []).map((row) => row.date));
    const missing = requiredDates.filter((date) => !present.has(date)).sort();
    if (!forceNetwork && cached && cached.startDate <= startDate && cached.endDate >= endDate
      && !missing.length && now().getTime() - Date.parse(cached.checkedAt) < INTERVAL) return { ...cached, cached: true };
    const provider = symbol === 'COR1M' ? 'cboe' : 'yahoo';
    const load = async (from, to) => (await market.getDailyHistory({ symbol, provider, fallbackProviders: [],
      priceMode: adjusted ? 'adjusted' : undefined, startDate: from, endDate: to, cache: false })).bars;
    try {
      let bars = cached?.bars || [];
      if (!cached) bars = await load(startDate, endDate);
      else {
        if (startDate < cached.startDate) bars = [...bars, ...await load(startDate, cached.startDate)];
        const overlap = cached.bars.at(-22)?.date || cached.startDate;
        let from = overlap < endDate ? overlap : startDate;
        if (missing.length && missing[0] < from) from = missing[0];
        const tail = await load(from, endDate);
        const old = new Map(cached.bars.map((row) => [row.date, row.close]));
        const revised = adjusted && tail.some((row) => old.has(row.date)
          && Math.abs(old.get(row.date) - row.close) > Math.max(1e-8, Math.abs(row.close) * 1e-8));
        if (revised) bars = await load(startDate < cached.startDate ? startDate : cached.startDate, endDate);
        else {
          // Replace the refreshed interval, including observations removed by the source.
          bars = [...bars.filter((row) => row.date < from || row.date > endDate), ...tail];
        }
      }
      bars = [...new Map(bars.map((row) => [row.date, row])).values()].sort((a, b) => a.date.localeCompare(b.date));
      const result = { bars, provider, startDate: cached && cached.startDate < startDate ? cached.startDate : startDate,
        endDate: cached && cached.endDate > endDate ? cached.endDate : endDate, checkedAt: now().toISOString() };
      await atomicJson(file, result);
      return result;
    } catch (error) {
      if (cached && cached.startDate <= startDate && cached.endDate >= endDate) return { ...cached, cached: true,
        stale: true, warning: `${symbol}: refresh failed; cached data from ${cached.checkedAt}. ${error.message}` };
      throw new Error(`${symbol}: ${error.message}`);
    }
  }

  async function holdings() {
    const file = path.join(directory, 'holdings.json');
    let cached;
    try { cached = await readJson(file); } catch (_) { /* Recoverable source cache. */ }
    if (!forceNetwork && cached?.basket?.length === 50 && now().getTime() - Date.parse(cached.checkedAt) < 86400000) return cached;
    const response = await fetchImpl(HOLDINGS_URL, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'IS-VOL/1.0' } });
    if (!response.ok) throw new Error(`IVV holdings: HTTP ${response.status}`);
    const result = { ...parseHoldings(await response.text()), checkedAt: now().toISOString(), provider: 'ishares' };
    await atomicJson(file, result);
    return result;
  }

  async function update() {
    let archive = { version: 1, records: [] };
    let committed = archive;
    const warnings = [];
    let latestSession = null;
    const sources = {};
    try {
      archive = validateArchive(await readJson(archiveFile) || archive);
      archive.records.sort((a, b) => a.date.localeCompare(b.date));
      committed = structuredClone(archive);
      const cutoff = completedSessionDate(now());
      // 1260 labeled examples + 21 forward sessions + 100 EWMA warmup,
      // with a calendar buffer. Expand below when actual session coverage is short.
      let days = 2100;
      const pending = archive.records.filter((row) => row.fact === null);
      let startDate, calendar;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        startDate = new Date(Date.parse(cutoff) - days * 86400000).toISOString().slice(0, 10);
        for (const row of pending) if (row.date < startDate) startDate = row.date;
        calendar = await history('SPX', startDate, cutoff);
        if (calendar.bars.length >= 1382) break;
        days *= 2;
      }
      if (calendar.stale) throw new Error(calendar.warning);
      const calendarRows = calendar.bars.filter((row) => row.date >= startDate && row.date <= cutoff);
      latestSession = calendarRows.at(-1)?.date;
      if (!latestSession) throw new Error('No completed SPX session available');
      const holidays = new Set(await getMarketHolidays(new Date(`${cutoff}T12:00:00Z`)));
      let expected = cutoff;
      while ([0, 6].includes(new Date(`${expected}T12:00:00Z`).getUTCDay()) || holidays.has(expected)) {
        expected = new Date(Date.parse(expected) - 86400000).toISOString().slice(0, 10);
      }
      if (latestSession < expected) throw new Error(`SPX data ends on ${latestSession}; waiting for completed session ${expected}. No historical forecast was issued.`);
      sources.calendar = { provider: 'yahoo', checkedAt: calendar.checkedAt };
      const dates = calendarRows.map((row) => row.date);
      const existing = archive.records.find((row) => row.date === latestSession);
      const due = pending.some((row) => { const i = dates.indexOf(row.date); return i >= 0 && i + 21 < dates.length; });
      if (existing && !due) return state(archive, warnings, null, latestSession, sources);

      let currentHoldings = null;
      let forecastError = null;
      if (!existing) {
        try { currentHoldings = await holdings(); sources.holdings = { provider: 'ishares', checkedAt: currentHoldings.checkedAt, asOf: currentHoldings.asOf }; }
        catch (error) { forecastError = error.message; warnings.push(forecastError); }
      }
      const symbols = new Set([...(currentHoldings?.basket || []), ...pending.flatMap((row) => row.basket)].map((row) => row.symbol));
      const outcomeDates = new Map();
      for (const record of pending) {
        const origin = dates.indexOf(record.date);
        if (origin < 0 || origin + 21 >= dates.length) continue;
        for (const { symbol } of record.basket) outcomeDates.set(symbol, [...(outcomeDates.get(symbol) || []), ...dates.slice(origin, origin + 22)]);
      }
      const prices = {}, unusable = new Set(), latestMissing = new Set();
      await Promise.all([...symbols].map((symbol) => schedule(async () => {
        try {
          const result = await history(symbol, startDate, cutoff, true, outcomeDates.get(symbol) || []);
          prices[symbol] = result.bars.filter((row) => row.date <= latestSession);
          sources[symbol] = { provider: 'yahoo', checkedAt: result.checkedAt, stale: Boolean(result.stale) };
          if (result.stale) { warnings.push(result.warning); unusable.add(symbol); }
          if (currentHoldings?.basket.some((row) => row.symbol === symbol) && !prices[symbol].some((row) => row.date === latestSession)) {
            latestMissing.add(symbol); warnings.push(`${symbol}: latest session ${latestSession} is missing.`);
          }
        } catch (error) { warnings.push(error.message); unusable.add(symbol); }
      })));
      let cor1mRows = [];
      if (!existing && currentHoldings) {
        try {
          const result = await history('COR1M', startDate, cutoff);
          if (result.warning) warnings.push(result.warning);
          cor1mRows = result.bars;
          sources.cor1m = { provider: 'cboe', checkedAt: result.checkedAt, stale: Boolean(result.stale) };
        } catch (error) { warnings.push(error.message); }
      }
      const currentMissing = currentHoldings?.basket.filter((row) => unusable.has(row.symbol) || latestMissing.has(row.symbol)).map((row) => row.symbol) || [];
      if (currentMissing.length) forecastError = `Latest adjusted prices unavailable or stale: ${currentMissing.join(', ')}`;
      // Do not settle outcomes from failed/stale sources; they remain pending.
      const eligible = pending.filter((row) => row.basket.every(({ symbol }) => !unusable.has(symbol)));
      const computed = await compute({ inputs: { basket: currentHoldings?.basket || [], calendarRows, prices, cor1mRows },
        records: eligible, makeForecast: !existing && Boolean(currentHoldings) && !forecastError });
      const matured = new Map(computed.records.map((row) => [row.date, row]));
      archive.records = archive.records.map((row) => matured.get(row.date) || row);
      for (const row of archive.records) if (row.fact === null && row.targetEndDate) warnings.push(`Outcome for ${row.date} is incomplete; missing basket prices or zero pairwise risk.`);
      if (computed.error) forecastError = computed.error;
      if (computed.forecast) {
        const forecast = { ...computed.forecast, issuedAt: now().toISOString(), basketAsOf: currentHoldings.asOf, basket: currentHoldings.basket,
          sources, basketMode: 'current-fixed-weights', priceMode: 'adjusted' };
        if (forecast.date !== latestSession) throw new Error('HAR forecast does not match latest session');
        archive.records.push(forecast);
      }
      await atomicJson(archiveFile, archive);
      return state(archive, warnings, forecastError, latestSession, sources);
    } catch (error) { return state(committed, warnings, error.message, latestSession, sources); }
  }

  function state(archive, warnings, error, latestSession, sources) {
    const records = archive.records || [];
    const latest = records.at(-1) || null;
    if (latest) warnings.push(...(latest.warnings || []));
    if (latest && latest.cor1m === null) warnings.push('COR1M unavailable for the forecast session.');
    if (latest && latest.date !== latestSession) warnings.push(`Showing saved forecast from ${latest.date}; a new forecast is unavailable.`);
    return { type: 'correlation-har', status: error ? (records.length ? 'partial' : 'error') : warnings.length ? 'partial' : 'ok',
      latest, records, latestSession, error: error || null, warnings: [...new Set(warnings)], sources,
      directory, checkedAt: now().toISOString() };
  }
  function getState({ refresh = false } = {}) {
    if (inFlight) return inFlight;
    if (!refresh && lastState && now().getTime() - lastAttempt < INTERVAL) return Promise.resolve(lastState);
    lastAttempt = now().getTime();
    forceNetwork = refresh;
    inFlight = update().then((result) => { lastState = result; return result; }).finally(() => { inFlight = null; });
    return inFlight;
  }
  return { getState };
}

// Poll persisted dashboard membership, not the selected renderer tab.
function createHarScheduler({ service, getTabs, setTimer = setInterval, clearTimer = clearInterval }) {
  let timer = null;
  const tick = () => service.getState().catch((error) => console.warn('HAR update failed', error));
  function sync() {
    const enabled = (getTabs() || []).some((tab) => (tab.widgets || []).some((widget) => widget.type === 'correlation-har'));
    if (enabled && !timer) { timer = setTimer(tick, INTERVAL); timer.unref?.(); tick(); }
    else if (!enabled && timer) { clearTimer(timer); timer = null; }
  }
  return { sync, stop() { if (timer) clearTimer(timer); timer = null; } };
}

module.exports = { createCorrelationHarService, createHarScheduler, validateArchive, INTERVAL };
