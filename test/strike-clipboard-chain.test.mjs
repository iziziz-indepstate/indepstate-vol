import test from 'node:test';
import assert from 'node:assert/strict';
import { createStrikeClipboardChain } from '../src/plugins/ndate-strike-clipboard/chain.js';
import nDateStrikeClipboardPlugin from '../src/plugins/ndate-strike-clipboard/manifest.js';
import { subscribeNDateStrikeClipboard } from '../src/plugins/ndate-strike-clipboard/listener.js';
import { nDateSkewPutWidget } from '../src/renderer/widgets/ndate-put-skew-widget.js';
import { nDateSkewCallWidget } from '../src/renderer/widgets/ndate-call-skew-widget.js';
import { nDateSkewBidIVRatioWidget } from '../src/renderer/widgets/ndate-bidiv-ratio-widget.js';
import { createWidgetEventBus } from '../src/renderer/widget-event-bus.js';

test('first strike click starts a pending chain without clipboard text', () => {
  const chain = createStrikeClipboardChain();

  const result = chain.click({
    widgetId: 'put-1',
    prefix: 'sps',
    strike: 7100,
    now: 1000
  });

  assert.equal(result.text, null);
  assert.equal(result.pending, true);
  assert.equal(result.strike, '7100');
  assert.deepEqual(chain.snapshot(), {
    widgetId: 'put-1',
    prefix: 'sps',
    strike: '7100',
    timestamp: 1000
  });
});

test('second strike click in the same widget completes and clears the chain', () => {
  const chain = createStrikeClipboardChain();

  chain.click({ widgetId: 'call-1', prefix: 'lcs', strike: 7100, now: 1000 });
  const result = chain.click({ widgetId: 'call-1', prefix: 'lcs', strike: 7200, now: 5000 });

  assert.equal(result.text, 'lcs 7100 7200');
  assert.equal(result.pending, false);
  assert.equal(chain.snapshot(), null);
});

test('third strike click starts a new chain after completion', () => {
  const chain = createStrikeClipboardChain();

  chain.click({ widgetId: 'put-1', prefix: 'sps', strike: 7100, now: 1000 });
  chain.click({ widgetId: 'put-1', prefix: 'sps', strike: 7200, now: 2000 });
  const result = chain.click({ widgetId: 'put-1', prefix: 'sps', strike: 7300, now: 3000 });

  assert.equal(result.text, null);
  assert.equal(result.pending, true);
  assert.deepEqual(chain.snapshot(), {
    widgetId: 'put-1',
    prefix: 'sps',
    strike: '7300',
    timestamp: 3000
  });
});

test('click in another widget resets the previous pending chain', () => {
  const chain = createStrikeClipboardChain();

  chain.click({ widgetId: 'put-1', prefix: 'sps', strike: 7100, now: 1000 });
  const result = chain.click({ widgetId: 'put-2', prefix: 'sps', strike: 7200, now: 2000 });

  assert.equal(result.text, null);
  assert.equal(result.pending, true);
  assert.deepEqual(chain.snapshot(), {
    widgetId: 'put-2',
    prefix: 'sps',
    strike: '7200',
    timestamp: 2000
  });
});

test('click after timeout starts a fresh chain', () => {
  const chain = createStrikeClipboardChain(20000);

  chain.click({ widgetId: 'put-1', prefix: 'sps', strike: 7100, now: 1000 });
  const result = chain.click({ widgetId: 'put-1', prefix: 'sps', strike: 7200, now: 21001 });

  assert.equal(result.text, null);
  assert.equal(result.pending, true);
  assert.deepEqual(chain.snapshot(), {
    widgetId: 'put-1',
    prefix: 'sps',
    strike: '7200',
    timestamp: 21001
  });
});

test('clipboard chain is enabled only for side-specific nDate skew widgets', () => {
  assert.equal(nDateSkewPutWidget.eventStrategies.strikeClipboard.prefix, 'sps');
  assert.equal(nDateSkewCallWidget.eventStrategies.strikeClipboard.prefix, 'lcs');
  assert.equal(nDateSkewBidIVRatioWidget.eventStrategies, undefined);
});

test('nDate strike clipboard subscriber writes on second point-click event', async () => {
  const bus = createWidgetEventBus({ now: () => 1000 });
  const writes = [];
  const statuses = [];
  subscribeNDateStrikeClipboard({
    eventBus: bus,
    getWidgetDefinition: (type) => ({
      'ndate-skew-put-line': nDateSkewPutWidget,
      'ndate-skew-bidiv-ratio-line': nDateSkewBidIVRatioWidget
    }[type]),
    writeText: async (text) => writes.push(text),
    setStatus: (text) => statuses.push(text),
    chain: createStrikeClipboardChain()
  });
  const putPort = bus.registerSource({
    widgetId: 'put-1',
    widgetType: 'ndate-skew-put-line',
    contracts: nDateSkewPutWidget.eventContracts
  });

  putPort.emit('chart.pointClick', { strike: 7100 });
  putPort.emit('chart.pointClick', { strike: 7200 });
  await Promise.resolve();

  assert.deepEqual(writes, ['sps 7100 7200']);
  assert.deepEqual(statuses, ['strike selected: sps 7100', 'copied: sps 7100 7200']);
});

test('nDate strike clipboard subscriber ignores unsupported widgets', async () => {
  const bus = createWidgetEventBus();
  const writes = [];
  subscribeNDateStrikeClipboard({
    eventBus: bus,
    getWidgetDefinition: () => nDateSkewBidIVRatioWidget,
    writeText: async (text) => writes.push(text),
    chain: createStrikeClipboardChain()
  });
  const ratioPort = bus.registerSource({
    widgetId: 'ratio-1',
    widgetType: 'ndate-skew-bidiv-ratio-line',
    contracts: [{ type: 'chart.pointClick' }]
  });

  ratioPort.emit('chart.pointClick', { strike: 7100 });
  ratioPort.emit('chart.pointClick', { strike: 7200 });
  await Promise.resolve();

  assert.deepEqual(writes, []);
});

test('nDate strike clipboard plugin manifest activates the event subscriber', async () => {
  const bus = createWidgetEventBus();
  const writes = [];
  nDateStrikeClipboardPlugin.activate({
    eventBus: bus,
    getWidgetDefinition: () => nDateSkewCallWidget,
    clipboard: {
      writeText: async (text) => writes.push(text)
    },
    setStatus: () => {}
  });
  const callPort = bus.registerSource({
    widgetId: 'call-1',
    widgetType: 'ndate-skew-call-line',
    contracts: nDateSkewCallWidget.eventContracts
  });

  callPort.emit('chart.pointClick', { strike: 7100 });
  callPort.emit('chart.pointClick', { strike: 7200 });
  await Promise.resolve();

  assert.deepEqual(writes, ['lcs 7100 7200']);
});
