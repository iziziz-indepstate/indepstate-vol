import test from 'node:test';
import assert from 'node:assert/strict';
import { ATM_STRADDLE_POINT_EVENT } from '../src/shared/atm-straddle-point.mjs';
import { emitAtmStraddlePointEvent } from '../src/renderer/widgets/atm-straddle-widget.js';

function result(overrides = {}) {
  return {
    snapshotTime: '2026-08-24T10:00:00.000Z',
    atmStrike: 6500,
    referencePrice: 6510.5,
    straddle: {
      mid: 88.25,
      impliedMovePct: 0.0135
    },
    atmIv: 0.16,
    ...overrides
  };
}

test('Straddle ATM emits atm-straddle point event for a graph-eligible current point', () => {
  const events = [];
  const emitted = emitAtmStraddlePointEvent({
    emit: (type, payload) => {
      events.push({ type, payload });
      return true;
    }
  }, {
    result: result(),
    config: { tenor: '1W' },
    widget: {
      id: 'w-atm',
      type: 'atm-straddle',
      title: 'ATM Test',
      config: { tenor: '1W' }
    }
  });

  assert.equal(emitted, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, ATM_STRADDLE_POINT_EVENT);
  assert.equal(events[0].payload.time, '2026-08-24T10:00:00.000Z');
  assert.equal(events[0].payload.atmStrike, 6500);
  assert.equal(events[0].payload.referencePrice, 6510.5);
  assert.equal(events[0].payload.straddlePts, 88.25);
  assert.equal(events[0].payload.snapshot.straddle.mid, 88.25);
  assert.deepEqual(events[0].payload.config, { tenor: '1W' });
});

test('Straddle ATM does not emit atm-straddle point event for incomplete current points', () => {
  const events = [];
  const eventPort = {
    emit: (type, payload) => events.push({ type, payload })
  };

  assert.equal(emitAtmStraddlePointEvent(eventPort, {
    result: result({ straddle: {} }),
    config: { tenor: '1W' },
    widget: { id: 'w-atm', type: 'atm-straddle', config: { tenor: '1W' } }
  }), false);
  assert.equal(emitAtmStraddlePointEvent(eventPort, {
    result: result({ atmStrike: null }),
    config: { tenor: '1W' },
    widget: { id: 'w-atm', type: 'atm-straddle', config: { tenor: '1W' } }
  }), false);
  assert.equal(emitAtmStraddlePointEvent(eventPort, {
    result: result({ referencePrice: null }),
    config: { tenor: '1W' },
    widget: { id: 'w-atm', type: 'atm-straddle', config: { tenor: '1W' } }
  }), false);

  assert.deepEqual(events, []);
});
