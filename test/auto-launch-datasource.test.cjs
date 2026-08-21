const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAutoLaunchLifecycle,
  createScheduledRefreshLifecycle,
  isInsideWindow,
  normalizeTimeList,
  normalizeTimeValue,
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
    },
    refreshOnce: async () => {
      calls.push('refresh');
    }
  };
}

test('parses HH:mm control values', () => {
  assert.equal(parseTimeToMinutes('09:30'), 570);
  assert.equal(parseTimeToMinutes('09:30:00'), 570);
  assert.equal(parseTimeToMinutes('23:59'), 1439);
  assert.equal(parseTimeToMinutes('24:00'), null);
  assert.equal(parseTimeToMinutes('bad'), null);
  assert.equal(normalizeTimeValue('9:30:00'), '09:30');
  assert.equal(normalizeTimeValue('bad'), '');
});

test('normalizes time lists by filtering, deduplicating and sorting', () => {
  assert.deepEqual(normalizeTimeList(['12:00', '9:30:00', 'bad', '09:30', '08:00']), ['08:00', '09:30', '12:00']);
  assert.deepEqual(normalizeTimeList('10:00, 09:00 bad 10:00:00'), ['09:00', '10:00']);
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

test('scheduled refresh does nothing when disabled or empty', async () => {
  const lifecycle = createScheduledRefreshLifecycle().create();
  const dataSource = runtime(false);

  await lifecycle.tick({
    dataSource,
    settings: { enabled: false, times: ['09:30'] },
    now: new Date('2026-08-20T09:30:00')
  });
  await lifecycle.tick({
    dataSource,
    settings: { enabled: true, times: [] },
    now: new Date('2026-08-20T09:30:00')
  });

  assert.deepEqual(dataSource.calls, []);
});

test('scheduled refresh fires once for a matching minute', async () => {
  const lifecycle = createScheduledRefreshLifecycle().create();
  const dataSource = runtime(false);
  const args = {
    dataSource,
    settings: { enabled: true, times: ['09:30'] },
    now: new Date('2026-08-20T09:30:10')
  };

  await lifecycle.tick(args);
  await lifecycle.tick({ ...args, now: new Date('2026-08-20T09:30:45') });

  assert.deepEqual(dataSource.calls, ['refresh']);
});

test('scheduled refresh can fire the same time on the next local date', async () => {
  const lifecycle = createScheduledRefreshLifecycle().create();
  const dataSource = runtime(false);

  await lifecycle.tick({
    dataSource,
    settings: { enabled: true, times: ['09:30'] },
    now: new Date('2026-08-20T09:30:00')
  });
  await lifecycle.tick({
    dataSource,
    settings: { enabled: true, times: ['09:30'] },
    now: new Date('2026-08-21T09:30:00')
  });

  assert.deepEqual(dataSource.calls, ['refresh', 'refresh']);
});

test('scheduled refresh ignores non-matching minutes', async () => {
  const lifecycle = createScheduledRefreshLifecycle().create();
  const dataSource = runtime(false);

  await lifecycle.tick({
    dataSource,
    settings: { enabled: true, times: ['09:30'] },
    now: new Date('2026-08-20T09:31:00')
  });

  assert.deepEqual(dataSource.calls, []);
});
