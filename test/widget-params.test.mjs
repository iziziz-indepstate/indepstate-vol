import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWidgetParamValue,
  shouldRefreshOnWidgetParamChange,
  WIDGET_PARAM_NAMES
} from '../src/renderer/widgets/widget-params.js';

test('normalizes option flow display mode widget param', () => {
  assert.equal(
    normalizeWidgetParamValue(WIDGET_PARAM_NAMES.FLOW_DISPLAY_MODE, 'ma-5m', 'cumulative'),
    'ma-5m'
  );
  assert.equal(
    normalizeWidgetParamValue(WIDGET_PARAM_NAMES.FLOW_DISPLAY_MODE, 'bad', 'ma-3m'),
    'ma-3m'
  );
  assert.equal(
    normalizeWidgetParamValue(WIDGET_PARAM_NAMES.FLOW_DISPLAY_MODE, 'bad', ''),
    'cumulative'
  );
});

test('flow display mode changes refresh widgets', () => {
  assert.equal(shouldRefreshOnWidgetParamChange(WIDGET_PARAM_NAMES.FLOW_DISPLAY_MODE), true);
});

test('normalizes option flow display point window params', () => {
  assert.equal(
    normalizeWidgetParamValue(WIDGET_PARAM_NAMES.DISPLAY_POINT_OFFSET, '12.9', ''),
    12
  );
  assert.equal(
    normalizeWidgetParamValue(WIDGET_PARAM_NAMES.DISPLAY_POINT_LIMIT, '', 25),
    ''
  );
  assert.equal(
    normalizeWidgetParamValue(WIDGET_PARAM_NAMES.DISPLAY_POINT_LIMIT, 'bad', 25),
    25
  );
});

test('display point window changes refresh widgets', () => {
  assert.equal(shouldRefreshOnWidgetParamChange(WIDGET_PARAM_NAMES.DISPLAY_POINT_OFFSET), true);
  assert.equal(shouldRefreshOnWidgetParamChange(WIDGET_PARAM_NAMES.DISPLAY_POINT_LIMIT), true);
});
