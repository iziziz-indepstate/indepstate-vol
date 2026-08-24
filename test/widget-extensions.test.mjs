import test from 'node:test';
import assert from 'node:assert/strict';
import atmStraddleSnapshotPlugin from '../src/plugins/atm-straddle-snapshot/manifest.js';
import {
  applicableWidgetExtensions,
  createWidgetExtensionControlsHtml,
  normalizeWidgetPluginConfig,
  writeWidgetExtensionControlValue
} from '../src/renderer/widget-extensions.js';

const manifests = [atmStraddleSnapshotPlugin];
const atmDefinition = { type: 'atm-straddle' };
const otherDefinition = { type: 'iv-rv-local' };

test('extension controls render only for ATM straddle widgets', () => {
  const atmWidget = { id: 'w-atm', type: 'atm-straddle', config: {} };
  const otherWidget = { id: 'w-other', type: 'iv-rv-local', config: {} };

  const atmExtensions = applicableWidgetExtensions(manifests, atmWidget, atmDefinition);
  const otherExtensions = applicableWidgetExtensions(manifests, otherWidget, otherDefinition);

  assert.equal(atmExtensions.length, 1);
  assert.equal(otherExtensions.length, 0);
  assert.match(createWidgetExtensionControlsHtml(atmWidget, atmExtensions), /Save snapshot/);
  assert.equal(createWidgetExtensionControlsHtml(otherWidget, otherExtensions), '');
});

test('toggling extension writes plugin scoped widget settings', () => {
  const widget = { id: 'w-atm', type: 'atm-straddle', config: {} };
  const [extension] = applicableWidgetExtensions(manifests, widget, atmDefinition);

  assert.equal(writeWidgetExtensionControlValue(widget, extension, 'enabled', true), true);

  assert.deepEqual(widget.config.plugins, {
    'atm-straddle-snapshot': {
      enabled: true
    }
  });
});

test('legacy saveSnapshot true migrates to ATM snapshot plugin settings', () => {
  const widget = { id: 'w-atm', type: 'atm-straddle', config: { saveSnapshot: true } };

  normalizeWidgetPluginConfig(widget, manifests);

  assert.equal(widget.config.saveSnapshot, undefined);
  assert.deepEqual(widget.config.plugins['atm-straddle-snapshot'], { enabled: true });
});

test('legacy saveSnapshot false is removed without enabling the plugin', () => {
  const widget = { id: 'w-atm', type: 'atm-straddle', config: { saveSnapshot: false } };

  normalizeWidgetPluginConfig(widget, manifests);

  assert.equal(widget.config.saveSnapshot, undefined);
  assert.deepEqual(widget.config.plugins, {});
});
