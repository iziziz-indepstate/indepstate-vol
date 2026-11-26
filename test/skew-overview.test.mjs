import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSkewOverview, normalizeSkewOverviewConfig, skewOverviewWindow } from '../src/shared/skew-overview.mjs';
import { calculateZeroDteSkewPoint } from '../src/shared/zero-dte-skew-calculations.mjs';
import { trimSnapshotForWidgets } from '../src/shared/snapshot-trim.mjs';
import { getWidgetDefinition } from '../src/renderer/widgets/index.js';
import { buildSmileChart } from '../src/renderer/widgets/skew-overview-widget.js';

const SESSION = '20261125';
const NEAR = '20261126';
const MIDDLE = '20261130';
const FAR = '20261226';
const quote = (type, strike, delta, iv) => ({ type, strike, delta, iv, bid: 1, ask: 1.25 });
const near = (actual, expected) => {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
};

function chain(atmIV = 0.2) {
  return {
    px: 100,
    putBidIvByStrike: { 94: 0.28, 98: 0 }, callBidIvByStrike: { 106: 0.18 },
    optionQuotes: [
      quote('call', 112, 0.1, 0.38), quote('put', 88, -0.1, 0.35),
      quote('put', 94, -0.2, 0.3), quote('put', 98, -0.3, 0.26),
      quote('call', 106, 0.2, 0.25), quote('call', 104, 0.3, 0.21),
      quote('put', 99, -0.5, atmIV - 0.02), quote('call', 99, 0.5, atmIV + 0.02),
      quote('put', 101, -0.5, 0.4), quote('call', 101, 0.5, 0.4)
    ]
  };
}

function snapshot(byExpiry = { [SESSION]: chain() }) {
  return { time: '2026-11-26T01:00:00Z', px: 100, expiry: Object.keys(byExpiry)[0], byExpiry };
}

test('joins the OTM lines at spot and ATM IV while retaining real endpoints', () => {
  for (const spot of [100, 99]) {
    const strip = { ...chain(), px: spot };
    const { smile } = calculateSkewOverview(snapshot({ [SESSION]: strip }));
    const originalQuotes = structuredClone(smile.quotes);
    const chart = buildSmileChart(smile, skewOverviewWindow(smile, 'auto'));
    const put = chart.datasets.find(({ label }) => label === 'OTM Puts');
    const call = chart.datasets.find(({ label }) => label === 'OTM Calls');
    assert.equal(chart.atmJoin.x, spot);
    near(chart.atmJoin.y, 20);
    assert.deepEqual(put.data.at(-1), chart.atmJoin);
    assert.deepEqual(call.data[0], chart.atmJoin);
    assert.equal(put.data.at(-2).x, 99);
    assert.equal(call.data[1].x, spot === 99 ? 99 : 101);
    near(put.data.at(-2).y, 18);
    near(call.data[1].y, spot === 99 ? 22 : 40);
    assert.equal(put.data.at(-2).quote.type, 'put');
    assert.equal(call.data[1].quote.type, 'call');
    assert.equal(put.pointHitRadius({ raw: chart.atmJoin }), 0);
    assert.deepEqual(smile.quotes, originalQuotes);
  }
});

test('leaves the smile disconnected when ATM, a side, or an edge quote is unavailable', () => {
  const invalidEdge = chain();
  invalidEdge.optionQuotes.find((q) => q.type === 'put' && q.strike === 99).bid = null;
  const withoutAtm = chain();
  withoutAtm.optionQuotes = withoutAtm.optionQuotes.filter(({ strike }) => strike !== 99 && strike !== 101);
  const withoutOtmCall = chain();
  withoutOtmCall.optionQuotes = withoutOtmCall.optionQuotes.filter((q) => q.type !== 'call' || q.strike < 100);
  for (const strip of [invalidEdge, withoutAtm, withoutOtmCall]) {
    const { smile } = calculateSkewOverview(snapshot({ [SESSION]: strip }));
    const chart = buildSmileChart(smile, skewOverviewWindow(smile, 'auto'));
    assert.equal(chart.atmJoin, null);
    if (strip === invalidEdge) {
      const put = chart.datasets.find(({ label }) => label === 'OTM Puts');
      near(chart.atmIV, 0.4);
      assert.equal(put.data.at(-1).x, 99);
      assert.equal(put.data.at(-1).y, null);
    }
  }
});

test('uses the shared quote rules, interpolates wing IV and strike, and reports signed metrics', () => {
  const data = snapshot();
  const overview = calculateSkewOverview(data);
  const { metrics, smile } = overview;
  assert.equal(overview.dte, 0);
  assert.equal(overview.contractCount, 10);
  assert.equal(metrics.atmStrike, 99);
  near(metrics.atmIV, 0.2);
  near(metrics.skew25, 5);
  near(metrics.skew10, -3);
  near(metrics.butterfly25, 5.5);
  near(metrics.skewSlope, -5 / 9);
  assert.equal(metrics.termSlope, null);
  near(smile.wing25.put.strike, 96);
  near(smile.wing25.call.strike, 105);
  const previousSkew = calculateZeroDteSkewPoint(data);
  near(smile.wing25.put.iv, previousSkew.put.iv);
  near(smile.wing25.call.iv, previousSkew.call.iv);
  assert.equal(previousSkew.put.strike, undefined);
  assert.equal(smile.quotes.find((q) => q.strike === 94).bidIV, 0.28);
  assert.equal(smile.quotes.find((q) => q.strike === 98).bidIV, null);
  assert.equal(smile.quotes.find((q) => q.strike === 106).moneyness, 'otm');
  assert.equal(smile.quotes.find((q) => q.strike === 99 && q.type === 'call').moneyness, 'itm');
});

test('builds term structure by New York calendar DTE with missing dates and endpoint slope', () => {
  const data = snapshot({
    [FAR]: chain(0.26), [MIDDLE]: { optionQuotes: [] }, [NEAR]: chain(0.2),
    '20261124': chain(0.18), [SESSION]: { optionQuotes: [] }
  });
  const overview = calculateSkewOverview(data);
  assert.equal(overview.expiration, NEAR);
  assert.deepEqual(overview.term.map(({ dte }) => dte), [0, 1, 5, 31]);
  assert.deepEqual(overview.term[2], { expiration: MIDDLE, dte: 5, atmIV: null, put25IV: null, call25IV: null });
  near(overview.metrics.termSlope, 6);
  const selected = calculateSkewOverview(data, FAR);
  near(selected.metrics.atmIV, 0.26);
  near(selected.metrics.termSlope, 6);
  for (const expiration of [MIDDLE, '20261201']) {
    const missing = calculateSkewOverview(data, expiration);
    assert.equal(missing.status, 'missing_chain');
    assert.equal(missing.expiration, expiration);
    assert.equal(missing.metrics.atmIV, null);
    near(missing.metrics.termSlope, 6);
    assert.equal(missing.smile, null);
  }
});

test('missing ATM or a broken delta bracket only removes dependent metrics', () => {
  const strip = chain();
  strip.optionQuotes = strip.optionQuotes.filter(({ strike }) => strike !== 99 && strike !== 101);
  const data = snapshot({ [SESSION]: strip, [NEAR]: chain() });
  let overview = calculateSkewOverview(data);
  assert.equal(overview.metrics.atmIV, null);
  assert.equal(overview.metrics.butterfly25, null);
  assert.equal(overview.metrics.termSlope, null);
  near(overview.metrics.skew25, 5);
  near(overview.metrics.skewSlope, -5 / 9);

  const bad = strip.optionQuotes.find(({ strike }) => strike === 98);
  bad.ask = 0.5;
  overview = calculateSkewOverview(data);
  assert.equal(overview.smile.quotes.find(({ strike }) => strike === 98).valid, false);
  assert.equal(overview.smile.wing25.put.strike, null);
  assert.equal(overview.metrics.skew25, null);
  assert.equal(overview.metrics.skewSlope, null);
  near(overview.metrics.skew10, -3);
});

test('keeps the full strip in the data contract and applies inclusive display ranges', () => {
  const strip = chain();
  strip.optionQuotes.find(({ strike }) => strike === 106).strike = 110;
  const overview = calculateSkewOverview(snapshot({ [SESSION]: strip }));
  const fixed = skewOverviewWindow(overview.smile, '5');
  const auto = skewOverviewWindow(overview.smile, 'auto');
  assert.deepEqual([fixed.min, fixed.max], [95, 105]);
  assert.deepEqual([auto.min, auto.max], [95, 107]);
  assert.ok(auto.quotes.every(({ strike }) => strike >= 95 && strike <= 107));
  assert.equal(skewOverviewWindow(overview.smile, 'all').quotes.length, overview.contractCount);
  near(overview.metrics.skew25, 5);
});

test('registers a TradingView snapshot widget and waits when its latest input is compact', () => {
  const widget = getWidgetDefinition('skew-overview');
  assert.equal(widget.defaultTitle, 'Skew. Overview');
  assert.equal(widget.providerKey, 'tradingview');
  assert.ok(!widget.requiresHistory);
  assert.deepEqual(normalizeSkewOverviewConfig({ panel: 'term', expiration: '2026-11-26', range: '10' }),
    { panel: 'term', expiration: NEAR, range: '10' });
  assert.deepEqual(normalizeSkewOverviewConfig({ panel: 'bad', expiration: '20260230', range: 'bad' }), widget.defaultConfig);
  const compact = trimSnapshotForWidgets(snapshot(), { widgets: [{ id: 'overview', type: widget.type }] });
  for (const input of [null, compact]) {
    const output = calculateSkewOverview(input);
    assert.equal(output.status, 'waiting_for_snapshot');
    assert.equal(output.smile, null);
    assert.deepEqual(output.term, []);
  }
});
