import test from 'node:test';
import assert from 'node:assert/strict';
import { ATM_STRADDLE_POINT_EVENT } from '../src/shared/atm-straddle-point.mjs';
import {
  emitAtmStraddlePointEvent,
  emitAtmStraddlePriceHistoryEvents
} from '../src/renderer/widgets/atm-straddle-widget.js';

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

test('Straddle ATM emits point events for all graph-eligible price history points', () => {
  const events = [];
  const eventPort = {
    emit: (type, payload) => {
      events.push({ type, payload });
      return true;
    }
  };
  const points = [
    {
      time: '2026-08-24T10:00:00.000Z',
      value: 88.25,
      straddlePts: 88.25,
      atmStrike: 6500,
      referencePrice: 6510.5,
      spot: 6510.5,
      snapshot: result({ snapshotTime: '2026-08-24T10:00:00.000Z' })
    },
    {
      time: '2026-08-24T10:05:00.000Z',
      value: 89.1,
      straddlePts: 89.1,
      atmStrike: 6500,
      referencePrice: 6512,
      spot: 6512,
      snapshot: result({
        snapshotTime: '2026-08-24T10:05:00.000Z',
        referencePrice: 6512,
        straddle: { mid: 89.1 }
      })
    }
  ];

  const emitted = emitAtmStraddlePriceHistoryEvents(eventPort, {
    points,
    config: { tenor: '1W' },
    widget: { id: 'w-atm', type: 'atm-straddle', config: { tenor: '1W' } }
  });

  assert.equal(emitted, 2);
  assert.deepEqual(events.map((event) => event.type), [ATM_STRADDLE_POINT_EVENT, ATM_STRADDLE_POINT_EVENT]);
  assert.deepEqual(events.map((event) => event.payload.time), [
    '2026-08-24T10:00:00.000Z',
    '2026-08-24T10:05:00.000Z'
  ]);
});

test('Straddle ATM does not re-emit the same price history point in one runtime session', () => {
  const events = [];
  const emittedKeys = new Set();
  const eventPort = {
    emit: (type, payload) => {
      events.push({ type, payload });
      return true;
    }
  };
  const point = {
    time: '2026-08-24T10:00:00.000Z',
    value: 88.25,
    straddlePts: 88.25,
    atmStrike: 6500,
    referencePrice: 6510.5,
    spot: 6510.5,
    snapshot: result({ snapshotTime: '2026-08-24T10:00:00.000Z', tenor: '1W', expiry: '2026-08-31' })
  };
  const args = {
    points: [point],
    config: { tenor: '1W', referencePriceMode: 'spot', quoteMode: 'mid' },
    widget: { id: 'w-atm', type: 'atm-straddle', config: { tenor: '1W' } },
    emittedKeys
  };

  assert.equal(emitAtmStraddlePriceHistoryEvents(eventPort, args), 1);
  assert.equal(emitAtmStraddlePriceHistoryEvents(eventPort, args), 0);
  assert.equal(events.length, 1);
});

test('Straddle ATM emits previously missed historical points when they appear later', () => {
  const events = [];
  const emittedKeys = new Set();
  const eventPort = {
    emit: (type, payload) => {
      events.push({ type, payload });
      return true;
    }
  };
  const first = {
    time: '2026-08-24T10:00:00.000Z',
    value: 88.25,
    straddlePts: 88.25,
    atmStrike: 6500,
    referencePrice: 6510.5,
    spot: 6510.5,
    snapshot: result({ snapshotTime: '2026-08-24T10:00:00.000Z', tenor: '1W', expiry: '2026-08-31' })
  };
  const missed = {
    time: '2026-08-24T10:05:00.000Z',
    value: 89.1,
    straddlePts: 89.1,
    atmStrike: 6500,
    referencePrice: 6512,
    spot: 6512,
    snapshot: result({
      snapshotTime: '2026-08-24T10:05:00.000Z',
      tenor: '1W',
      expiry: '2026-08-31',
      referencePrice: 6512,
      straddle: { mid: 89.1 }
    })
  };

  assert.equal(emitAtmStraddlePriceHistoryEvents(eventPort, {
    points: [first],
    config: { tenor: '1W', referencePriceMode: 'spot', quoteMode: 'mid' },
    widget: { id: 'w-atm', type: 'atm-straddle', config: { tenor: '1W' } },
    emittedKeys
  }), 1);
  assert.equal(emitAtmStraddlePriceHistoryEvents(eventPort, {
    points: [first, missed],
    config: { tenor: '1W', referencePriceMode: 'spot', quoteMode: 'mid' },
    widget: { id: 'w-atm', type: 'atm-straddle', config: { tenor: '1W' } },
    emittedKeys
  }), 1);

  assert.deepEqual(events.map((event) => event.payload.time), [
    '2026-08-24T10:00:00.000Z',
    '2026-08-24T10:05:00.000Z'
  ]);
});
