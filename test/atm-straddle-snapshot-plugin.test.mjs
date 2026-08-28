import test from 'node:test';
import assert from 'node:assert/strict';
import atmStraddleSnapshotPlugin from '../src/plugins/atm-straddle-snapshot/manifest.js';
import {
  ATM_STRADDLE_POINT_EVENT,
  shouldSaveAtmStraddlePointEvent,
  subscribeAtmStraddleSnapshot
} from '../src/plugins/atm-straddle-snapshot/listener.js';
import { createWidgetDataPublishBus } from '../src/renderer/widget-data-publish-bus.js';
import { createWidgetEventBus } from '../src/renderer/widget-event-bus.js';

function okPointEvent(overrides = {}) {
  return {
    type: ATM_STRADDLE_POINT_EVENT,
    tabId: 'tab-1',
    widgetId: 'w-atm',
    widgetType: 'atm-straddle',
    timestamp: '2026-08-24T10:00:01.000Z',
    payload: {
      time: '2026-08-24T10:00:00.000Z',
      atmStrike: 6500,
      referencePrice: 6510.5,
      spot: 6510.5,
      straddlePts: 88.25,
      title: 'ATM Test',
      config: { tenor: '1W' },
      widget: {
        id: 'w-atm',
        type: 'atm-straddle',
        title: 'ATM Test',
        config: {
          tenor: '1W',
          plugins: {
            'atm-straddle-snapshot': {
              enabled: true
            }
          }
        }
      },
      snapshot: {
        atmStrike: 6500,
        referencePrice: 6510.5,
        straddle: { mid: 88.25 }
      }
    },
    ...overrides
  };
}

test('ATM snapshot plugin saves valid enabled ATM straddle point events', async () => {
  const bus = createWidgetEventBus();
  const source = bus.registerSource({
    tabId: 'tab-1',
    widgetId: 'w-atm',
    widgetType: 'atm-straddle',
    contracts: [ATM_STRADDLE_POINT_EVENT]
  });
  const saves = [];
  subscribeAtmStraddleSnapshot({
    eventBus: bus,
    appBridge: {
      saveAtmStraddleSnapshot: async (payload) => saves.push(payload)
    }
  });

  source.emit(ATM_STRADDLE_POINT_EVENT, okPointEvent().payload);
  await Promise.resolve();

  assert.equal(saves.length, 1);
  assert.equal(saves[0].title, 'ATM Test');
  assert.deepEqual(saves[0].config, { tenor: '1W' });
  assert.equal(saves[0].snapshot.straddle.mid, 88.25);
  assert.equal(saves[0].sourceSnapshotTime, '2026-08-24T10:00:00.000Z');
});

test('ATM snapshot plugin manifest activates the point event subscriber', async () => {
  const bus = createWidgetEventBus();
  const source = bus.registerSource({
    tabId: 'tab-1',
    widgetId: 'w-atm',
    widgetType: 'atm-straddle',
    contracts: [ATM_STRADDLE_POINT_EVENT]
  });
  const saves = [];
  atmStraddleSnapshotPlugin.activate({
    eventBus: bus,
    appBridge: {
      saveAtmStraddleSnapshot: async (payload) => saves.push(payload)
    }
  });

  source.emit(ATM_STRADDLE_POINT_EVENT, okPointEvent().payload);
  await Promise.resolve();

  assert.equal(saves.length, 1);
});

test('ATM snapshot plugin ignores disabled, wrong, and incomplete point events', () => {
  const cases = [
    okPointEvent({
      payload: {
        ...okPointEvent().payload,
        widget: {
          ...okPointEvent().payload.widget,
          config: { plugins: { 'atm-straddle-snapshot': { enabled: false } } }
        }
      }
    }),
    okPointEvent({ widgetType: 'iv-rv-local' }),
    okPointEvent({ type: 'chart.pointClick' }),
    okPointEvent({
      payload: {
        ...okPointEvent().payload,
        straddlePts: null,
        snapshot: { atmStrike: 6500, referencePrice: 6510.5, straddle: {} }
      }
    })
  ];

  for (const event of cases) {
    assert.equal(shouldSaveAtmStraddlePointEvent(event), false);
  }
});

test('ATM snapshot plugin no longer saves from generic widget data publish events', async () => {
  const dataBus = createWidgetDataPublishBus();
  const eventBus = createWidgetEventBus();
  const saves = [];
  subscribeAtmStraddleSnapshot({
    eventBus,
    appBridge: {
      saveAtmStraddleSnapshot: async (payload) => saves.push(payload)
    }
  });

  dataBus.publish({
    widget: okPointEvent().payload.widget,
    definition: { type: 'atm-straddle' },
    output: {
      type: 'atm-straddle',
      status: 'ok',
      snapshot: okPointEvent().payload.snapshot
    },
    sourceSnapshotTime: '2026-08-24T10:00:00.000Z'
  });
  await Promise.resolve();

  assert.equal(saves.length, 0);
});
