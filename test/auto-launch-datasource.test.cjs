const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAutoLaunchLifecycle,
  isInsideWindow,
  parseTimeToMinutes
} = require('../src/plugins/auto-launch-datasource/lifecycle.cjs');

function runtime(running = false) {
  const calls = [];
  return {
    calls,
    isRunning: () => running,
    start: async () => {
      calls.push('start');
      running = true;
    },
    stop: async () => {
      calls.push('stop');
      running = false;
    }
  };
}

test('parses HH:mm control values', () => {
  assert.equal(parseTimeToMinutes('09:30'), 570);
  assert.equal(parseTimeToMinutes('09:30:00'), 570);
  assert.equal(parseTimeToMinutes('23:59'), 1439);
  assert.equal(parseTimeToMinutes('24:00'), null);
  assert.equal(parseTimeToMinutes('bad'), null);
});

test('detects normal and overnight windows', () => {
  assert.equal(isInsideWindow(600, 570, 960), true);
  assert.equal(isInsideWindow(1000, 570, 960), false);
  assert.equal(isInsideWindow(1410, 1320, 120), true);
  assert.equal(isInsideWindow(60, 1320, 120), true);
  assert.equal(isInsideWindow(600, 1320, 120), false);
});

test('disabled or incomplete settings do nothing', async () => {
  const lifecycle = createAutoLaunchLifecycle().create();
  const dataSource = runtime(false);

  await lifecycle.tick({
    dataSource,
    settings: { enabled: false, startTime: '09:00', stopTime: '10:00' },
    now: new Date('2026-08-20T09:30:00')
  });
  await lifecycle.tick({
    dataSource,
    settings: { enabled: true, startTime: '09:00', stopTime: '' },
    now: new Date('2026-08-20T09:30:00')
  });

  assert.deepEqual(dataSource.calls, []);
});

test('starts inside the configured window and is idempotent', async () => {
  const lifecycle = createAutoLaunchLifecycle().create();
  const dataSource = runtime(false);
  const args = {
    dataSource,
    settings: { enabled: true, startTime: '09:00', stopTime: '10:00' },
    now: new Date('2026-08-20T09:30:00')
  };

  await lifecycle.tick(args);
  await lifecycle.tick(args);

  assert.deepEqual(dataSource.calls, ['start']);
});

test('stops outside the configured window and supports overnight windows', async () => {
  const lifecycle = createAutoLaunchLifecycle().create();
  const dataSource = runtime(true);

  await lifecycle.tick({
    dataSource,
    settings: { enabled: true, startTime: '22:00', stopTime: '02:00' },
    now: new Date('2026-08-20T12:00:00')
  });
  await lifecycle.tick({
    dataSource,
    settings: { enabled: true, startTime: '22:00', stopTime: '02:00' },
    now: new Date('2026-08-20T23:00:00')
  });

  assert.deepEqual(dataSource.calls, ['stop', 'start']);
});
