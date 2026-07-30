import test from 'node:test';
import assert from 'node:assert/strict';
import { createWidgetEventBus } from '../src/renderer/widget-event-bus.js';

test('event source port enriches emitted events with source context', () => {
  const bus = createWidgetEventBus({ now: () => 1000 });
  const events = [];
  bus.subscribe('chart.pointClick', (event) => events.push(event));
  const port = bus.registerSource({
    tabId: 'tab-1',
    widgetId: 'widget-1',
    widgetType: 'ndate-skew-put-line',
    contracts: [{ type: 'chart.pointClick' }]
  });

  assert.equal(port.emit('chart.pointClick', { strike: 7100 }), true);
  assert.deepEqual(events, [{
    type: 'chart.pointClick',
    tabId: 'tab-1',
    widgetId: 'widget-1',
    widgetType: 'ndate-skew-put-line',
    timestamp: '1970-01-01T00:00:01.000Z',
    payload: { strike: 7100 }
  }]);
});

test('source port only has interest for declared events with live subscribers', () => {
  const bus = createWidgetEventBus();
  const port = bus.registerSource({ contracts: [{ type: 'chart.pointClick' }] });

  assert.equal(port.hasInterest('chart.pointClick'), false);
  const unsubscribe = bus.subscribe('chart.pointClick', () => {});
  assert.equal(port.hasInterest('chart.pointClick'), true);
  assert.equal(port.hasInterest('other.event'), false);
  unsubscribe();
  assert.equal(port.hasInterest('chart.pointClick'), false);
});

test('interest listeners receive active and inactive changes', () => {
  const bus = createWidgetEventBus();
  const port = bus.registerSource({ contracts: [{ type: 'chart.pointClick' }] });
  const changes = [];
  port.onInterestChange((type, active) => changes.push({ type, active }));

  const unsubscribe = bus.subscribe('chart.pointClick', () => {});
  unsubscribe();

  assert.deepEqual(changes, [
    { type: 'chart.pointClick', active: true },
    { type: 'chart.pointClick', active: false }
  ]);
});

test('destroyed source stops interest notifications and emits', () => {
  const bus = createWidgetEventBus();
  const events = [];
  const changes = [];
  const port = bus.registerSource({ contracts: [{ type: 'chart.pointClick' }] });
  port.onInterestChange((type, active) => changes.push({ type, active }));
  port.destroy();

  bus.subscribe('chart.pointClick', (event) => events.push(event));

  assert.deepEqual(changes, []);
  assert.equal(port.hasInterest('chart.pointClick'), false);
  assert.equal(port.emit('chart.pointClick', { strike: 7100 }), false);
  assert.deepEqual(events, []);
});

test('throwing subscribers and interest listeners do not stop delivery', () => {
  const errors = [];
  const bus = createWidgetEventBus({ onError: (...args) => errors.push(args) });
  const port = bus.registerSource({ contracts: [{ type: 'chart.pointClick' }] });
  const events = [];
  const changes = [];
  port.onInterestChange(() => { throw new Error('interest failed'); });
  port.onInterestChange((type, active) => changes.push({ type, active }));

  bus.subscribe('chart.pointClick', () => { throw new Error('subscriber failed'); });
  bus.subscribe('chart.pointClick', (event) => events.push(event));

  assert.equal(port.emit('chart.pointClick', { strike: 7100 }), true);
  assert.equal(changes.length, 1);
  assert.equal(events.length, 1);
  assert.equal(errors.length, 2);
});

