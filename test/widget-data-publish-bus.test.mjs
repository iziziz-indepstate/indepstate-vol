import test from 'node:test';
import assert from 'node:assert/strict';
import { createWidgetDataPublishBus } from '../src/renderer/widget-data-publish-bus.js';

test('widget data publish notifies subscribers with widget context and source time', () => {
  const bus = createWidgetDataPublishBus();
  const events = [];
  const tab = { id: 'tab-1' };
  const widget = { id: 'w-1', type: 'atm-straddle' };
  const definition = { type: 'atm-straddle' };
  const output = { type: 'atm-straddle', status: 'ok' };

  bus.subscribe((event) => events.push(event));
  assert.equal(bus.publish({
    tab,
    widget,
    definition,
    output,
    sourceSnapshotTime: '2026-08-24T10:00:00.000Z'
  }), true);

  assert.deepEqual(events, [{
    tab,
    widget,
    definition,
    output,
    sourceSnapshotTime: '2026-08-24T10:00:00.000Z'
  }]);
});

test('widget data publish catches sync and async subscriber failures', async () => {
  const errors = [];
  const events = [];
  const bus = createWidgetDataPublishBus({ onError: (...args) => errors.push(args) });

  bus.subscribe(() => { throw new Error('sync failed'); });
  bus.subscribe(async () => { throw new Error('async failed'); });
  bus.subscribe((event) => events.push(event));

  bus.publish({ output: { type: 'atm-straddle' } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events.length, 1);
  assert.equal(errors.length, 2);
});
