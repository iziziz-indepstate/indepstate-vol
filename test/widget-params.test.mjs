import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWidgetParamValue,
  shouldRefreshOnWidgetParamChange,
  WIDGET_PARAM_NAMES
} from '../src/renderer/widgets/widget-params.js';
import { parseOptionFlowStrikeWindow } from '../src/shared/option-flow-strike-window.mjs';

test('strike windows preserve direction and normalize ALL across saved config round trips', () => {
  for (const [raw, expected] of [
    ['3', 3], [' +03 ', '+3'], ['-5', '-5'], [-5, '-5'],
    ['0', 0], ['+0', '+0'], ['-0', '-0'], [' all ', 'ALL']
  ]) {
    const value = normalizeWidgetParamValue(WIDGET_PARAM_NAMES.STRIKE_WINDOW, raw, 3);
    assert.equal(value, expected);
    assert.equal(parseOptionFlowStrikeWindow(JSON.parse(JSON.stringify(value))), expected);
  }
  for (const raw of ['', ' ', 'bad', '+3 ATM', '1.5', '1e2', 'Infinity', '9007199254740992']) {
    assert.equal(normalizeWidgetParamValue(WIDGET_PARAM_NAMES.STRIKE_WINDOW, raw, '+2'), '+2');
    assert.equal(parseOptionFlowStrikeWindow(raw), null);
  }
  assert.equal(normalizeWidgetParamValue(WIDGET_PARAM_NAMES.STRIKE_WINDOW, '', undefined), 3);
  assert.equal(shouldRefreshOnWidgetParamChange(WIDGET_PARAM_NAMES.STRIKE_WINDOW), true);
});

test('normalizes option flow display mode widget param', () => {
  assert.equal(
    normalizeWidgetParamValue(WIDGET_PARAM_NAMES.FLOW_DISPLAY_MODE, 'linear', 'cumulative'),
    'linear'
  );
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
