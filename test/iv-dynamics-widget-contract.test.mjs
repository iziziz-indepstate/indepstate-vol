import test from 'node:test';
import assert from 'node:assert/strict';
import { getWidgetDefinition, widgetDefinitions } from '../src/renderer/widgets/index.js';
import { comparisonDeltaForCell } from '../src/renderer/widgets/iv-dynamics-widget.js';

test('IV Dynamics widget is registered', () => {
  const definition = getWidgetDefinition('iv-dynamics');
  assert.ok(definition);
  assert.equal(definition.defaultTitle, 'IV Dynamics');
  assert.equal(definition.mode, 'table');
  assert.equal(definition.requiresHistory, true);
  assert.equal(definition.defaultConfig.showBA, false);
  assert.equal(definition.defaultConfig.compareMode, 'previous');
  assert.ok(widgetDefinitions.includes(definition));
});

test('IV Dynamics color comparison helper selects previous or session delta', () => {
  const cell = { comparisons: { previous: 0.01, session: -0.03 } };
  assert.equal(comparisonDeltaForCell(cell), 0.01);
  assert.equal(comparisonDeltaForCell(cell, 'previous'), 0.01);
  assert.equal(comparisonDeltaForCell(cell, 'session'), -0.03);
});
