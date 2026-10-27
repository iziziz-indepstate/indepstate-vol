import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateWidgetTitles } from '../src/renderer/widget-title-migrations.mjs';
import { getWidgetDefinition } from '../src/renderer/widgets/index.js';

const renames = [
  ['zero-dte-skew', '0DTE Skew', 'Skew. 0DTE'],
  ['multi-expiry-skew', 'Multi-Expiry Skew', 'Skew. Multi-Expiry'],
  ['atm-straddle', 'Straddle ATM', 'Straddle. ATM'],
  ['straddle-daily-price', 'Straddle Daily Price', 'Straddle. Daily Price'],
  ['straddle-dynamics', 'Straddle Dynamics', 'Straddle. Dynamics'],
  ['option-flow-tick', 'Option Flow TICK', 'Flow. TICK'],
  ['option-flow-balanced-tick', 'Option Flow Balanced TICK', 'Flow. Balanced TICK'],
  ['option-flow-gamma-flow', 'Option Flow Gamma Flow', 'Flow. Gamma Flow'],
  ['option-flow-gamma-imbalance', 'Option Flow Gamma Imbalance', 'Flow. Gamma Imbalance'],
  ['theblock-cme-btc-options', 'Volume and OI of CME Bitcoin Options', 'BTC. Volume and OI of CME Bitcoin Options'],
  ['theblock-btc-dvol-vol-of-vol', 'BTC DVol Index Vol of Vol', 'BTC. DVol Index Vol of Vol'],
  ['theblock-btc-dvol-variance-premium', 'BTC DVol Index Variance Premium', 'BTC. DVol Index Variance Premium'],
  ['theblock-btc-atm-iv', 'BTC ATM Implied Volatility', 'BTC. ATM Implied Volatility'],
  ['theblock-btc-option-skew-delta-5', 'BTC Option Skew Delta 5', 'BTC. Option Skew Delta 5'],
  ['theblock-btc-option-skew-delta-25', 'BTC Option Skew Delta 25', 'BTC. Option Skew Delta 25']
];

test('legacy widget titles migrate across tabs without changing settings or identities', () => {
  const tabs = renames.map(([type, title], index) => ({
    id: `tab-${index}`,
    widgets: [{ id: `w-${index}`, type, title, config: { expiration: '20261027', custom: true } }]
  }));
  const expected = structuredClone(tabs);
  expected.forEach((tab, index) => { tab.widgets[0].title = renames[index][2]; });
  const widgets = tabs.map((tab) => tab.widgets[0]);
  migrateWidgetTitles(tabs);
  assert.deepEqual(tabs, expected);
  tabs.forEach((tab, index) => assert.equal(tab.widgets[0], widgets[index]));
  migrateWidgetTitles(tabs);
  assert.deepEqual(tabs, expected);
  const reloaded = JSON.parse(JSON.stringify(tabs));
  migrateWidgetTitles(reloaded);
  assert.deepEqual(reloaded, expected);
});

test('custom, missing and unrelated widget titles remain unchanged', () => {
  const tabs = [{ widgets: renames.flatMap(([type, oldTitle, newTitle]) => [
    { type, title: `${oldTitle} custom` },
    { type, title: newTitle },
    { type, title: '' },
    { type },
    { type: 'other-widget', title: oldTitle },
    { type, title: renames.find(([otherType]) => otherType !== type)[1] }
  ]) }, {}];
  const expected = structuredClone(tabs);
  migrateWidgetTitles(tabs);
  assert.deepEqual(tabs, expected);
  migrateWidgetTitles(undefined);
});

test('new widgets use the renamed default titles with existing technical types', () => {
  for (const [type, , title] of renames) {
    assert.equal(getWidgetDefinition(type).defaultTitle, title);
  }
});
