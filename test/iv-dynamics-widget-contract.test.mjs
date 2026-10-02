import test from 'node:test';
import assert from 'node:assert/strict';
import { getWidgetDefinition, widgetDefinitions } from '../src/renderer/widgets/index.js';

test('IV Dynamics widget is registered', () => {
  const definition = getWidgetDefinition('iv-dynamics');
  assert.ok(definition);
  assert.equal(definition.defaultTitle, 'IV Dynamics');
  assert.equal(definition.mode, 'table');
  assert.equal(definition.requiresHistory, true);
  assert.equal(definition.defaultConfig.showBA, false);
  assert.ok(widgetDefinitions.includes(definition));
});
