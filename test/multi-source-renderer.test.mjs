import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { collectExpiryPlaceholderKeys } from '../src/shared/expiry-placeholders.mjs';
import * as sources from '../src/shared/data-sources.mjs';
import { getWidgetDefinition, widgetDefinitions } from '../src/renderer/widgets/index.js';
import { createMcpRuntimeStore } from '../src/shared/mcp-runtime-store.mjs';
import { trimSnapshotForWidgets } from '../src/shared/snapshot-trim.mjs';
import { createSkewHistorySession } from '../src/renderer/skew-history.js';

function harness(fetchers = {}) {
  const timers = new Map();
  const calls = [];
  const point = (provider) => ({ provider, time: '2026-10-23T12:00:00Z', px: 100, byExpiry: {}, rows: [] });
  const bridge = {
    getTradingViewSnapshot: async () => { calls.push('tradingview'); return point('tradingview'); },
    getTheBlockSnapshot: async () => { calls.push('theblock'); return point('theblock'); },
    getDataSourceSnapshot: async () => { calls.push('tape-contract'); return point('tape-contract'); },
    saveRawSnapshot: async () => {}, saveUiState: async () => {}, appendHistoryPoint: async () => {},
    syncDataSources: async () => ({}), ...fetchers
  };
  let seq = 0;
  const context = vm.createContext({
    ...sources, getWidgetDefinition, widgetDefinitions, createMcpRuntimeStore, trimSnapshotForWidgets,
    skewHistorySession: createSkewHistorySession(() => bridge),
    createWidgetEventBus: () => ({}), createWidgetDataPublishBus: () => ({}),
    window: { appBridge: bridge }, console, performance, skewMetrics: [], collectExpiryPlaceholderKeys,
    document: { getElementById: () => ({ classList: { remove() {} }, setAttribute() {} }) },
    setTimeout, clearTimeout,
    setInterval: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearInterval: (id) => timers.delete(id)
  });
  let code = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
  code = code.replace(/^import[\s\S]*?;[ \t]*$/gm, '').replace(/init\(\);\s*$/, '');
  vm.runInContext(code, context);
  vm.runInContext(`
    renderWidgets = () => {};
    refreshCharts = () => {};
    setStatus = () => {};
    showSourceStatuses = () => {};
    applyTabToForm = () => {};
    updatePollingControlsForActiveTab = () => {};
    renderDataSourceLifecycleControls = () => {};
  `, context);
  const api = vm.runInContext(`({ state, addWidget, executeDataSourceCommand, clearActiveTabSnapshot,
    invalidateSource, tickTab, tabTimers, tabTickInFlight, latestBySource, widgetHistory, widgetLatest,
    sourceForWidget, getWidgetDefinition, selectedSourceByTab })`, context);
  const tab = { id: 'tab', title: 'Mixed', widgets: [
    { id: 'tv', type: 'iv-dynamics' }, { id: 'tape', type: 'option-flow-tick' },
    { id: 'block', type: 'theblock-cme-btc-options' }
  ] };
  sources.normalizeTabDataSources(tab, getWidgetDefinition);
  api.state.tabs = [tab]; api.state.activeTabId = tab.id;
  return { ...api, tab, bridge, timers, calls };
}

test('tab commands poll all providers independently and route each snapshot to its widgets', async () => {
  const h = harness();
  h.tab.dataSources.forEach((s, i) => { s.providerConfig.pollSec = i + 2; });
  await h.executeDataSourceCommand('tab', 'start');
  await new Promise(setImmediate);
  assert.equal(h.tabTimers.size, 3);
  assert.deepEqual([...h.timers.values()].map((t) => t.ms), [2000, 3000, 4000]);
  assert.deepEqual(h.calls.sort(), ['tape-contract', 'theblock', 'tradingview']);
  for (const w of h.tab.widgets) {
    assert.equal(h.widgetLatest(h.tab, w).provider, getWidgetDefinition(w.type).providerKey);
    assert.equal(h.widgetHistory(h.tab, w).length, 1);
  }
  await h.executeDataSourceCommand('tab', 'stop');
  assert.equal(h.tabTimers.size, 0);
  await h.executeDataSourceCommand('tab', 'refresh');
  assert.equal(h.calls.length, 6);
  assert.equal(h.tabTimers.size, 0);
});

test('Skew points are captured on an inactive tab before compact history is trimmed', async () => {
  const saves = [];
  const quotes = [
    { type: 'put', strike: 90, delta: -0.25, iv: 0.24, bid: 1, ask: 2 },
    { type: 'call', strike: 110, delta: 0.25, iv: 0.2, bid: 1, ask: 2 }
  ];
  const h = harness({
    getTradingViewSnapshot: async () => ({ time: '2026-10-26T15:00:00Z', px: 100, byExpiry: { '20261030': { px: 100, optionQuotes: quotes } } }),
    saveSkewHistory: async (payload) => { saves.push(payload); return { ok: true }; }
  });
  h.tab.widgets.push({ id: 'skew', type: 'multi-expiry-skew', config: { expirations: ['20261030'], targetDelta: 0.25 } });
  h.state.activeTabId = 'another-tab';
  await h.tickTab(h.tab.dataSources.find((s) => s.providerKey === 'tradingview').id);
  assert.equal(saves.length, 1);
  assert.ok(Math.abs(saves[0].points[0].skew - 0.04) < 1e-9);
  assert.equal(saves[0].identity.expiration, '20261030');
  assert.equal(h.widgetHistory(h.tab, h.tab.widgets.at(-1))[0].byExpiry['20261030'].optionQuotes.length, 2);
});

test('provider failure leaves other sources usable', async () => {
  const h = harness({ getTradingViewSnapshot: async () => { throw new Error('offline'); } });
  await h.executeDataSourceCommand('tab', 'refresh');
  assert.equal(h.widgetLatest(h.tab, h.tab.widgets[0]), null);
  assert.equal(h.widgetLatest(h.tab, h.tab.widgets[1]).provider, 'tape-contract');
  assert.equal(h.widgetLatest(h.tab, h.tab.widgets[2]).provider, 'theblock');
});

test('clear and invalidation reject late responses without unlocking a newer request', async () => {
  const resolvers = [];
  const h = harness({ getTradingViewSnapshot: () => new Promise((resolve) => resolvers.push(resolve)) });
  const id = h.tab.dataSources[0].id;
  const oldRequest = h.tickTab(id);
  h.clearActiveTabSnapshot();
  const newRequest = h.tickTab(id);
  resolvers[0]({ provider: 'tradingview', time: 'old' });
  await oldRequest;
  assert.equal(h.latestBySource.has(id), false);
  assert.equal(h.tabTickInFlight.has(id), true);
  resolvers[1]({ provider: 'tradingview', time: 'new', byExpiry: {} });
  await newRequest;
  assert.equal(h.latestBySource.get(id).time, 'new');
  assert.equal(h.tabTickInFlight.has(id), false);
  h.clearActiveTabSnapshot();
  for (const source of h.tab.dataSources) assert.deepEqual(Array.from(h.state.historyBySource[source.id]), []);
});

test('responses after tab deletion do not restore runtime data', async () => {
  let resolve;
  const h = harness({ getTradingViewSnapshot: () => new Promise((done) => { resolve = done; }) });
  const id = h.tab.dataSources[0].id;
  const pending = h.tickTab(id);
  h.state.tabs = [];
  resolve({ provider: 'tradingview', time: 'old' });
  await pending;
  assert.equal(h.latestBySource.has(id), false);
});

test('new providers are created once, inherit running state, and independent widgets create none', async () => {
  const h = harness();
  h.tab.widgets = [];
  h.tab.dataSources = h.tab.dataSources.slice(0, 1);
  h.addWidget('vol-upfront');
  assert.equal(h.tab.dataSources.length, 1);
  h.addWidget('option-flow-tick');
  assert.equal(h.tab.dataSources.length, 2);
  assert.equal(h.tabTimers.size, 0);
  h.addWidget('option-flow-tick');
  assert.equal(h.tab.dataSources.length, 2);
  await h.executeDataSourceCommand('tab', 'start');
  h.addWidget('theblock-cme-btc-options');
  assert.equal(h.tab.dataSources.length, 3);
  assert.equal(h.tabTimers.size, 3);
  assert.equal(h.selectedSourceByTab.get('tab'), h.tab.dataSources[2].id);
  await h.executeDataSourceCommand('tab', 'stop');
});


test('source-specific lifecycle commands and history limits stay isolated', async () => {
  const h = harness();
  const tv = h.tab.dataSources[0];
  const tape = h.tab.dataSources[1];
  tv.providerConfig.keepPoints = 20;
  tape.providerConfig.keepPoints = 25;
  await h.executeDataSourceCommand('tab', 'start', tv.id);
  await new Promise(setImmediate);
  assert.equal(h.tabTimers.size, 1);
  assert.equal(h.tabTimers.has(tv.id), true);
  assert.equal(h.tabTimers.has(tape.id), false);
  await h.executeDataSourceCommand('tab', 'stop', tv.id);
  for (let i = 0; i < 28; i++) await h.executeDataSourceCommand('tab', 'refresh', tape.id);
  for (let i = 0; i < 22; i++) await h.executeDataSourceCommand('tab', 'refresh', tv.id);
  assert.equal(h.state.historyBySource[tv.id].length, 20);
  assert.equal(h.state.historyBySource[tape.id].length, 25);
  assert.equal(h.widgetLatest(h.tab, h.tab.widgets[2]), null);
});


test('a slow refresh does not block a different source in the same tab', async () => {
  let finish;
  const h = harness({ getTradingViewSnapshot: () => new Promise((resolve) => { finish = resolve; }) });
  const tv = h.tab.dataSources[0].id;
  const tape = h.tab.dataSources[1].id;
  const pending = h.executeDataSourceCommand('tab', 'refresh', tv);
  await h.executeDataSourceCommand('tab', 'refresh', tape);
  assert.equal(h.widgetLatest(h.tab, h.tab.widgets[1]).provider, 'tape-contract');
  assert.equal(h.widgetLatest(h.tab, h.tab.widgets[0]), null);
  finish({ provider: 'tradingview', time: '2026-10-23T12:00:00Z', byExpiry: {} });
  await pending;
  assert.equal(h.widgetLatest(h.tab, h.tab.widgets[0]).provider, 'tradingview');
});
