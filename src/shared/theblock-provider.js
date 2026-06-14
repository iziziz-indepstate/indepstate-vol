export const THE_BLOCK_CHARTS = Object.freeze({
  cmeBtcOptionsVolumeOi: {
    id: 'cmeBtcOptionsVolumeOi',
    title: 'Volume and OI of CME Bitcoin Options',
    url: 'https://data.tbstat.com/dashboard/markets_options_volumeofcmebitcoinoptions_monthly_coinglass.json'
  },
  btcDvolVolOfVol: {
    id: 'btcDvolVolOfVol',
    title: 'BTC DVol Index Vol of Vol',
    url: 'https://data.tbstat.com/dashboard/markets_options_btcdvolvolofvol_daily_other.json'
  },
  btcDvolVariancePremium: {
    id: 'btcDvolVariancePremium',
    title: 'BTC DVol Index Variance Premium',
    url: 'https://data.tbstat.com/dashboard/markets_options_btcdvolvariancepremium_daily_other.json'
  },
  btcAtmImpliedVolatility: {
    id: 'btcAtmImpliedVolatility',
    title: 'BTC ATM Implied Volatility',
    url: 'https://data.tbstat.com/dashboard/markets_options_btcatmimpliedvolatility_daily_other.json'
  },
  btcOptionSkewDelta5: {
    id: 'btcOptionSkewDelta5',
    title: 'BTC Option Skew Delta 5',
    url: 'https://data.tbstat.com/dashboard/markets_options_btcfivedeltaoptionskew_daily_other.json'
  },
  btcOptionSkewDelta25: {
    id: 'btcOptionSkewDelta25',
    title: 'BTC Option Skew Delta 25',
    url: 'https://data.tbstat.com/dashboard/markets_options_btctwentyfivedeltaoptionskew_daily_other.json'
  }
});

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizePoint(point) {
  const timestamp = toNumber(point?.Timestamp ?? point?.timestamp);
  const result = toNumber(point?.Result ?? point?.result ?? point?.value);
  if (!Number.isFinite(timestamp) || !Number.isFinite(result)) return null;
  return {
    timestamp,
    date: new Date(timestamp * 1000).toISOString().slice(0, 10),
    value: result
  };
}

export function normalizeTheBlockChart(raw, definition) {
  const seriesSource = raw?.Series || raw?.series || {};
  const series = Object.fromEntries(
    Object.entries(seriesSource)
      .map(([name, value]) => {
        const points = (Array.isArray(value?.Data) ? value.Data : [])
          .map(normalizePoint)
          .filter(Boolean)
          .sort((a, b) => a.timestamp - b.timestamp);
        return [name, {
          name,
          yAxis: value?.YAxis || value?.yAxis || '',
          yAxisFormat: value?.YAxisFormat || value?.yAxisFormat || '',
          type: value?.Type || value?.type || 'line',
          points
        }];
      })
      .filter(([, value]) => value.points.length)
  );

  return {
    id: definition.id,
    title: raw?.Description || definition.title,
    category: raw?.Category || '',
    sub: raw?.Sub || '',
    chart: raw?.Chart || '',
    frequency: raw?.Frequency || '',
    source: raw?.Source || '',
    runtime: raw?.Runtime || null,
    url: definition.url,
    series
  };
}

export class TheBlockProvider {
  key = 'theblock';

  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetchImpl = fetchImpl;
  }

  async fetchChart(definition) {
    const response = await this.fetchImpl(definition.url, {
      headers: {
        accept: 'application/json',
        'User-Agent': 'IS-VOL/1.0'
      }
    });
    if (!response?.ok) {
      throw new Error(`The Block ${definition.title} failed: HTTP ${response?.status || 'unknown'}`);
    }
    return normalizeTheBlockChart(await response.json(), definition);
  }

  async fetchSnapshot(config = {}) {
    const ids = Array.isArray(config.chartIds) && config.chartIds.length
      ? config.chartIds
      : Object.keys(THE_BLOCK_CHARTS);
    const definitions = ids.map((id) => THE_BLOCK_CHARTS[id]).filter(Boolean);
    if (!definitions.length) throw new Error('No The Block charts configured');

    const loaded = await Promise.all(definitions.map((definition) => this.fetchChart(definition)));
    const charts = Object.fromEntries(loaded.map((chart) => [chart.id, chart]));
    const latestTimestamps = loaded.flatMap((chart) => (
      Object.values(chart.series || {}).map((series) => series.points.at(-1)?.timestamp).filter(Number.isFinite)
    ));
    const latestTimestamp = latestTimestamps.length ? Math.max(...latestTimestamps) : null;

    return {
      time: new Date().toISOString(),
      provider: this.key,
      theBlock: {
        source: 'The Block',
        latestDate: latestTimestamp ? new Date(latestTimestamp * 1000).toISOString().slice(0, 10) : null,
        charts
      }
    };
  }
}
