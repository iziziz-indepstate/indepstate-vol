import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureDataSource, normalizeTabDataSources, sourceForWidget, sourceView } from '../src/shared/data-sources.mjs';
import { getWidgetDefinition, widgetDefinitions } from '../src/renderer/widgets/index.js';

const widget = (type) => ({ id: type, type });

test('legacy mixed tab migrates once, preserving settings and widget identities', () => {
  const widgets = [widget('atm-straddle'), widget('option-flow-tick'), widget('theblock-cme-btc-options')];
  const tab = { id: 'tab', title: 'Mixed', providerKey: 'tradingview', providerConfig: {
    ticker: 'CBOE:SPX', pollSec: 17, lifecycleSettings: { launch: { enabled: true } }
  }, widgets };
  normalizeTabDataSources(tab, getWidgetDefinition);
  assert.equal(tab.dataSources.length, 3);
  assert.equal(tab.widgets, widgets);
  assert.equal(tab.dataSources[0].providerConfig.ticker, 'CBOE:SPX');
  assert.deepEqual(tab.dataSources[0].providerConfig.lifecycleSettings, { launch: { enabled: true } });
  assert.equal(tab.providerConfig, undefined);
  const migrated = JSON.stringify(tab);
  normalizeTabDataSources(tab, getWidgetDefinition);
  assert.equal(JSON.stringify(tab), migrated);
  assert.equal(ensureDataSource(tab, 'tradingview'), tab.dataSources[0]);
});

test('each registered widget declares provider ownership; derived and file widgets need no source', () => {
  for (const definition of widgetDefinitions) assert.ok(Object.hasOwn(definition, 'providerKey'), definition.type);
  for (const type of ['vol-upfront', 'straddle-daily-price', 'straddle-dynamics']) {
    const tab = { id: 'files', widgets: [widget(type)] };
    normalizeTabDataSources(tab, getWidgetDefinition);
    assert.deepEqual(tab.dataSources, []);
    assert.equal(sourceForWidget(tab, tab.widgets[0], getWidgetDefinition), null);
  }
});

test('source views include only their own widgets and retain independent configs', () => {
  const tab = { id: 'tab', title: 'Mixed', widgets: [widget('atm-straddle'), widget('option-flow-tick'), widget('option-flow-gamma-flow')] };
  normalizeTabDataSources(tab, getWidgetDefinition);
  const tape = sourceForWidget(tab, tab.widgets[1], getWidgetDefinition);
  assert.equal(tape.providerKey, 'tape-contract');
  const view = sourceView(tab, tape, getWidgetDefinition);
  assert.deepEqual(view.widgets.map((w) => w.type), ['option-flow-tick', 'option-flow-gamma-flow']);
  view.providerConfig.pollSec = 13;
  assert.equal(tape.providerConfig.pollSec, 13);
  assert.equal(tab.dataSources[0].providerConfig.pollSec, 5);
});
