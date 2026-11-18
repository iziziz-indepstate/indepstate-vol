const { parentPort, workerData } = require('worker_threads');

(async () => {
  const { calculateHarForecast, matureHarForecast } = await import('../shared/correlation-har-calculations.mjs');
  const { inputs, records, makeForecast } = workerData;
  const matured = records.map((record) => matureHarForecast(record, inputs.calendarRows, inputs.prices));
  let forecast = null, error = null;
  if (makeForecast) {
    try { forecast = calculateHarForecast(inputs); }
    catch (err) { error = err.message; }
  }
  parentPort.postMessage({ records: matured, forecast, error });
})().catch((error) => { throw error; });
