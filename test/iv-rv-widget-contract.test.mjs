import test from 'node:test';
import assert from 'node:assert/strict';
import { ivRvWidget } from '../src/renderer/widgets/iv-rv-widget.js';

function marketRows(symbol, closes) {
  return closes.map((close, index) => ({
    date: `2026-01-${String(index + 1).padStart(2, '0')}`,
    symbol,
    close
  }));
}

function createContainer() {
  const statusNode = {
    textContent: '',
    classList: { add: () => {} }
  };
  return {
    html: '',
    set innerHTML(value) {
      this.html = value;
    },
    get innerHTML() {
      return this.html;
    },
    querySelector(selector) {
      if (selector === '.ivrv-status') return statusNode;
      if (selector === '[data-ivrv-load]') return null;
      if (selector.includes('canvas')) return {};
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
}

async function renderWith({ widgetConfig, historyHandler }) {
  const published = [];
  const previousWindow = global.window;
  const previousChart = global.Chart;
  class FakeChart {
    destroy() {}
  }
  global.Chart = FakeChart;
  global.window = {
    Chart: FakeChart,
    appBridge: {
      getDailyMarketHistory: historyHandler
    }
  };

  try {
    await ivRvWidget.render({
      container: createContainer(),
      widget: {
        id: 'w-ivrv',
        type: ivRvWidget.type,
        title: 'SPX IV / RV Test',
        config: widgetConfig
      },
      widgetData: {
        publish: (data) => published.push(data)
      },
      onConfigChange: () => {}
    });
  } finally {
    global.window = previousWindow;
    global.Chart = previousChart;
  }

  return published;
}

test('SPX IV/RV publishes successful widget data contract', async () => {
  const published = await renderWith({
    widgetConfig: {
      horizon: 'custom',
      customDays: 2,
      customIvSymbol: 'VIX',
      annualizationFactor: 252
    },
    historyHandler: async ({ symbol }) => ({
      provider: symbol === 'SPX' ? 'fred' : 'cboe',
      cached: symbol === 'SPX',
      fallback: false,
      updatedAt: `2026-01-04T00:00:00.000Z`,
      bars: symbol === 'SPX'
        ? marketRows('SPX', [100, 101, 100, 102])
        : marketRows('VIX', [10, 11, 12, 13])
    })
  });

  assert.equal(published.length, 1);
  const output = published[0];
  assert.equal(output.type, 'iv-rv-local');
  assert.equal(output.status, 'ok');
  assert.equal(output.title, 'SPX IV / RV Test');
  assert.deepEqual(output.horizon, { days: 2, label: '2d', ivSymbol: null });
  assert.equal(output.sources.spx.provider, 'fred');
  assert.equal(output.sources.spx.symbol, 'SPX');
  assert.equal(output.sources.spx.cached, true);
  assert.equal(output.sources.iv.provider, 'cboe');
  assert.equal(output.sources.iv.symbol, 'VIX');
  assert.equal(output.series.length, 2);
  assert.equal(output.latest.date, '2026-01-04');
  assert.equal(output.latest.iv_symbol, 'VIX');
  assert.deepEqual(output.warnings, []);
});

test('SPX IV/RV publishes waiting status when local sources are missing', async () => {
  const published = await renderWith({
    widgetConfig: {
      dataMode: 'local',
      spxSource: '',
      ivSource: 'C:\\data\\vix.json'
    },
    historyHandler: async () => {
      throw new Error('should not fetch local data without both sources');
    }
  });

  assert.equal(published.length, 1);
  assert.equal(published[0].status, 'waiting_for_local_sources');
  assert.equal(published[0].missingSources.spxSource, true);
  assert.equal(published[0].missingSources.ivSource, false);
});

test('SPX IV/RV publishes error contract when calculation fails', async () => {
  const published = await renderWith({
    widgetConfig: {},
    historyHandler: async () => {
      throw new Error('market data unavailable');
    }
  });

  assert.equal(published.length, 1);
  assert.equal(published[0].status, 'error');
  assert.equal(published[0].title, 'SPX IV / RV Test');
  assert.match(published[0].error, /market data unavailable/);
  assert.equal(published[0].config.horizon, '9d');
});
