import test from 'node:test';
import assert from 'node:assert/strict';
import atmStraddleSnapshotPlugin from '../src/plugins/atm-straddle-snapshot/manifest.js';
import {
  shouldSaveAtmStraddleSnapshotEvent,
  subscribeAtmStraddleSnapshot
} from '../src/plugins/atm-straddle-snapshot/listener.js';
import { createWidgetDataPublishBus } from '../src/renderer/widget-data-publish-bus.js';

function okEvent(overrides = {}) {
  return {
    tab: { id: 'tab-1' },
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
    definition: {
      type: 'atm-straddle',
      defaultTitle: 'Straddle ATM'
    },
    output: {
      type: 'atm-straddle',
      status: 'ok',
      title: 'ATM Test',
      config: { tenor: '1W' },
      snapshot: {
        atmStrike: 6500,
        referencePrice: 6510.5,
        straddle: { mid: 88.25 }
      }
    },
    sourceSnapshotTime: '2026-08-24T10:00:00.000Z',
    ...overrides
  };
}

test('ATM snapshot plugin saves valid enabled ATM straddle output', async () => {
  const bus = createWidgetDataPublishBus();
  const saves = [];
  subscribeAtmStraddleSnapshot({
    widgetDataEvents: bus,
    appBridge: {
      saveAtmStraddleSnapshot: async (payload) => saves.push(payload)
    }
  });

  bus.publish(okEvent());
  await Promise.resolve();

  assert.equal(saves.length, 1);
  assert.equal(saves[0].title, 'ATM Test');
  assert.deepEqual(saves[0].config, { tenor: '1W' });
  assert.equal(saves[0].snapshot.straddle.mid, 88.25);
  assert.equal(saves[0].sourceSnapshotTime, '2026-08-24T10:00:00.000Z');
});

test('ATM snapshot plugin manifest activates the data subscriber', async () => {
  const bus = createWidgetDataPublishBus();
  const saves = [];
  atmStraddleSnapshotPlugin.activate({
    widgetDataEvents: bus,
    appBridge: {
      saveAtmStraddleSnapshot: async (payload) => saves.push(payload)
    }
  });

  bus.publish(okEvent());
  await Promise.resolve();

  assert.equal(saves.length, 1);
});

test('ATM snapshot plugin ignores disabled, wrong, error, and incomplete events', () => {
  const cases = [
    okEvent({
      widget: {
        ...okEvent().widget,
        config: { plugins: { 'atm-straddle-snapshot': { enabled: false } } }
      }
    }),
    okEvent({ widget: { ...okEvent().widget, type: 'iv-rv-local' } }),
    okEvent({ definition: { type: 'iv-rv-local' } }),
    okEvent({ output: { ...okEvent().output, type: 'iv-rv-local' } }),
    okEvent({ output: { ...okEvent().output, status: 'error' } }),
    okEvent({
      output: {
        ...okEvent().output,
        snapshot: { atmStrike: 6500, referencePrice: 6510.5, straddle: {} }
      }
    })
  ];

  for (const event of cases) {
    assert.equal(shouldSaveAtmStraddleSnapshotEvent(event), false);
  }
});
