import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildMultiExpirySeries, calculateMultiExpiryPoints, mergeSkewPoints, normalizeSkewExpirations, skewIdentity, migrateMultiExpirySkewConfig, normalizeRthStartOffset } from '../src/shared/multi-expiry-skew.mjs';
import { createSkewHistorySession } from '../src/renderer/skew-history.js';
import { multiExpirySkewWidget, multiExpiryVisibilityOptions } from '../src/renderer/widgets/multi-expiry-skew-widget.js';
import { getWidgetDefinition } from '../src/renderer/widgets/index.js';
import { trimSnapshotForWidgets } from '../src/shared/snapshot-trim.mjs';
import store from '../src/main/skew-history-store.cjs';

const source = { id: 'source-1', providerConfig: { ticker: 'AMEX:SPY' } };
const config = { expirations: ['20261030', '20261106'], targetDelta: 0.25 };
const widget = { id: 'w1', type: 'multi-expiry-skew', config };
const q = (type, strike, delta, iv) => ({ type, strike, delta, iv, bid: 1, ask: 2 });
function snapshot(time = '2026-10-26T15:00:00Z') {
  const chain = (iv) => ({ px: 100, optionQuotes: [q('put', 90, -0.25, iv), q('call', 110, 0.25, 0.2),
    q('put', 85, -0.1, iv + 0.01), q('call', 115, 0.1, 0.21)] });
  return { time, px: 100, byExpiry: { '20261030': chain(0.24), '20261106': chain(0.23) } };
}
const point = (time = '2026-10-26T15:00:00Z', skew = 0.04) => ({ timestamp: time, skew });
const identity = skewIdentity(source, '20261030', 0.25);
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'is-vol-skew-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('registered widget is routed to TradingView and starts without expirations', () => {
  assert.equal(getWidgetDefinition(widget.type), multiExpirySkewWidget);
  assert.equal(multiExpirySkewWidget.providerKey, 'tradingview');
  assert.deepEqual(multiExpirySkewWidget.defaultConfig.expirations, []);
  assert.equal(multiExpirySkewWidget.defaultConfig.targetDelta, 0.25);
  assert.deepEqual(normalizeSkewExpirations(['2026-10-30', '20261030', 'today', '', '20260230']), ['20261030']);
});

test('multiple expirations share delta, retain compact quotes and preserve the legacy spread', () => {
  const s = snapshot();
  const compact = trimSnapshotForWidgets(s, { widgets: [widget] });
  for (const expiry of config.expirations) assert.equal(compact.byExpiry[expiry].optionQuotes.length, 4);
  const lines = calculateMultiExpiryPoints([compact], config);
  const series = buildMultiExpirySeries(lines);
  assert.equal(series.lines.length, 2);
  assert.ok(Math.abs(series.lines[0].data[0] - 4) < 1e-9);
  assert.ok(Math.abs(series.lines[1].data[0] - 3) < 1e-9);
  assert.equal(lines[0].points[0].targetDelta, lines[1].points[0].targetDelta);
  assert.equal(lines[0].points[0].putWing, null);
  assert.equal(calculateMultiExpiryPoints([compact], { ...config, targetDelta: 0.01 })[0].points[0].skew, null);
});

test('missing values retain metadata without synthetic session gaps and range uses market date', () => {
  const a = snapshot(), missing = snapshot('2026-10-26T15:05:00Z'), b = snapshot('2026-10-27T15:00:00Z');
  delete missing.byExpiry['20261030'];
  const series = buildMultiExpirySeries(calculateMultiExpiryPoints([a, missing, b], config));
  assert.deepEqual(series.x, [a, missing, b].map((s) => Date.parse(s.time) / 1000));
  assert.equal(series.lines[0].data[1], null);
  assert.ok(Number.isFinite(series.lines[0].data[2]));
  assert.ok(series.lines[0].meta[1].warning);
  assert.ok(Number.isFinite(series.lines[1].data[1]));
  const filtered = buildMultiExpirySeries(calculateMultiExpiryPoints([a, b], config), { startDate: '2026-10-27', endDate: '2026-10-27' });
  assert.equal(filtered.x.length, 1);
  assert.equal(mergeSkewPoints([point()], [point(undefined, null)])[0].skew, 0.04);
});

test('six-hour, overnight and weekend pauses retain only actual timestamps across expirations', () => {
  const timestamps = ['2026-10-23T14:00:00Z', '2026-10-23T20:00:00Z', '2026-10-24T14:00:00Z', '2026-10-26T14:00:00Z'];
  const points = timestamps.map((timestamp, i) => point(timestamp, (i + 1) / 100));
  const series = buildMultiExpirySeries([
    { expiration: '20261030', points: [points[3], points[0], points[1]] },
    { expiration: '20261106', points: [points[2], { ...points[1], skew: null, warning: 'Missing quotes' }, points[3]] }
  ]);
  assert.deepEqual(series.x, timestamps.map((t) => Date.parse(t) / 1000));
  assert.deepEqual(series.lines[0].data, [1, 2, undefined, 4]);
  assert.deepEqual(series.lines[1].data, [undefined, null, 3, 4]);
  assert.deepEqual(series.lines[0].meta.map((p) => p?.timestamp ?? null), [timestamps[0], timestamps[1], null, timestamps[3]]);
  assert.equal(series.lines[1].meta[1].warning, 'Missing quotes');
});

test('empty, single-point and filtered series preserve alignment and local calendar dates', () => {
  assert.deepEqual(buildMultiExpirySeries([]), { x: [], lines: [] });
  const points = [point(new Date('2026-10-26T23:00:00').toISOString()), point(new Date('2026-10-27T15:00:00').toISOString())];
  const filtered = buildMultiExpirySeries([{ expiration: '20261030', points }], { startDate: '2026-10-26', endDate: '2026-10-26' });
  assert.deepEqual(filtered.x, [Date.parse(points[0].timestamp) / 1000]);
  assert.deepEqual(filtered.lines[0].data, [4]);
  assert.deepEqual(filtered.lines[0].meta, [points[0]]);
  const empty = buildMultiExpirySeries([{ expiration: '20261030', points }], { startDate: '2026-10-28' });
  assert.deepEqual(empty, { x: [], lines: [{ id: '20261030:spread', metric: 'spread', expiration: '20261030', meta: [], data: [] }] });
});

test('smoothing uses trailing valid windows of 5 or 15 points without changing raw metadata', () => {
  const points = Array.from({ length: 18 }, (_, i) => point(new Date(Date.parse('2026-10-26T15:00:00Z') + i * 60000).toISOString(), i + 1));
  const lines = [{ expiration: '20261030', points }];
  const raw = structuredClone(lines);
  for (const [smoothing, size] of [['linear', 1], ['ma5', 5], ['ma15', 15], ['unknown', 1]]) {
    const series = buildMultiExpirySeries(lines, { smoothing });
    assert.deepEqual(series.lines[0].data, points.map((_, i) => (Math.max(1, i + 2 - size) + i + 1) * 50));
    assert.deepEqual(series.lines[0].meta, points);
    const prefix = buildMultiExpirySeries([{ ...lines[0], points: points.slice(0, 4) }], { smoothing });
    assert.deepEqual(prefix.lines[0].data, series.lines[0].data.slice(0, 4));
    assert.deepEqual(buildMultiExpirySeries([], { smoothing }), { x: [], lines: [] });
  }
  assert.deepEqual(lines, raw);
});

test('MA skips gaps independently per expiration and restarts at the selected date range', () => {
  const timestamps = ['2026-10-23T15:00:00Z', '2026-10-26T15:00:00Z', '2026-10-26T16:00:00Z', '2026-10-27T15:00:00Z'];
  const lines = [
    { expiration: '20261030', points: [point(timestamps[0], 1), point(timestamps[1], null), point(timestamps[3], 3)] },
    { expiration: '20261106', points: [point(timestamps[1], 10), point(timestamps[2], 20), point(timestamps[3], 30)] }
  ];
  for (const smoothing of ['ma5', 'ma15']) {
    const series = buildMultiExpirySeries(lines, { smoothing });
    assert.deepEqual(series.lines[0].data, [100, null, undefined, 200]);
    assert.deepEqual(series.lines[1].data, [undefined, 1000, 1500, 2000]);
    const filtered = buildMultiExpirySeries(lines, { smoothing, startDate: '2026-10-26', endDate: '2026-10-27' });
    assert.deepEqual(filtered.lines[0].data, [null, undefined, 300]);
    assert.deepEqual(filtered.lines[1].data, [1000, 1500, 2000]);
    const single = buildMultiExpirySeries(lines, { smoothing, startDate: '2026-10-27' });
    assert.deepEqual(single.lines.map((line) => line.data), [[300], [3000]]);
  }
});

test('RTH boundaries follow New York DST independently of the computer timezone', () => {
  const moduleUrl = new URL('../src/shared/multi-expiry-skew.mjs', import.meta.url).href;
  for (const timezone of ['UTC', 'Asia/Nicosia']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { buildMultiExpirySeries } from ${JSON.stringify(moduleUrl)};
      for (const [date, offset] of [
        ['2026-03-06', '-05:00'], ['2026-03-09', '-04:00'],
        ['2026-03-30', '-04:00'], ['2026-07-06', '-04:00'],
        ['2026-10-23', '-04:00'], ['2026-10-26', '-04:00'], ['2026-11-02', '-05:00']
      ]) {
        const points = ['00:00:00', '09:29:59.999', '09:30:00', '12:00:00', '16:00:00', '16:00:00.001', '23:59:59']
          .map((time) => ({ timestamp: new Date(date + 'T' + time + offset).toISOString(), skew: 0.04 }));
        const lines = [{ expiration: '20261218', points }];
        const series = buildMultiExpirySeries(lines, { rthOnly: true });
        assert.deepEqual(series.lines[0].meta, points.slice(2, 5), date);
        assert.deepEqual(series.x, points.slice(2, 5).map((p) => Date.parse(p.timestamp) / 1000));
        assert.equal(buildMultiExpirySeries(lines).x.length, points.length);
        assert.deepEqual(buildMultiExpirySeries(lines, { rthOnly: false }), buildMultiExpirySeries(lines));
      }
      const weekends = ['2026-10-24T12:00:00-04:00', '2026-10-25T12:00:00-04:00']
        .map((timestamp) => ({ timestamp, skew: 0.04 }));
      assert.deepEqual(buildMultiExpirySeries([{ expiration: '20261218', points: weekends }], { rthOnly: true }),
        { x: [], lines: [{ id: '20261218:spread', metric: 'spread', expiration: '20261218', data: [], meta: [] }] });
    `], { env: { ...process.env, TZ: timezone }, encoding: 'utf8' });
    assert.equal(result.status, 0, `${timezone}: ${result.stderr || result.error || result.stdout}`);
  }
});

test('RTH intersects local bounds before smoothing and preserves alignment and raw observations', () => {
  const points = [
    point('2026-10-23T13:29:59Z', 99), point('2026-10-23T13:30:00Z', 1),
    point('2026-10-23T20:00:00Z', 3), point('2026-10-23T20:00:00.001Z', 99),
    point('2026-10-24T14:00:00Z', 99), point('2026-10-26T13:30:00Z', 5)
  ];
  const lines = [
    { expiration: '20261030', points },
    { expiration: '20261106', points: [points[0], points[2], points[5]] }
  ];
  const original = structuredClone(lines);
  for (const smoothing of ['ma5', 'ma15']) {
    const series = buildMultiExpirySeries(lines, { rthOnly: true, smoothing });
    assert.deepEqual(series.x, [points[1], points[2], points[5]].map((p) => Date.parse(p.timestamp) / 1000));
    assert.deepEqual(series.lines.map((l) => l.data), [[100, 200, 300], [undefined, 300, 400]]);
    const localStart = new Date(points[2].timestamp);
    const pad = (n) => String(n).padStart(2, '0');
    const cut = buildMultiExpirySeries(lines, { rthOnly: true, smoothing,
      startDate: `${localStart.getFullYear()}-${pad(localStart.getMonth() + 1)}-${pad(localStart.getDate())}`,
      rthStartOffsetMinutes: 390 });
    assert.deepEqual(cut.lines.map((l) => l.data), [[300], [300]]);
  }
  assert.deepEqual(lines, original);
  assert.equal(buildMultiExpirySeries(lines, { rthOnly: false }).x.length, points.length);
});

test('RTH checkbox saves booleans and restores independently per widget', async () => {
  let onChange;
  let saved;
  const checkbox = { dataset: { skewSetting: 'rthOnly' }, value: 'on', checked: false,
    addEventListener: (_event, handler) => { onChange = handler; } };
  const container = {
    innerHTML: '',
    querySelectorAll: (selector) => selector === '[data-skew-setting]' ? [checkbox] : [],
    querySelector: () => ({ addEventListener() {}, textContent: '' })
  };
  const instance = { config: {} };
  const render = (widget = instance) => multiExpirySkewWidget.render({ container, widget,
    onConfigChange: () => { saved = JSON.stringify(widget.config); } });
  const markup = (checked) => `data-skew-setting="rthOnly" type="checkbox"${checked ? ' checked' : ''} />`;
  assert.equal(multiExpirySkewWidget.defaultConfig.rthOnly, false);
  await render();
  assert.ok(container.innerHTML.includes(markup(false)));
  assert.ok(container.innerHTML.includes('Mon–Fri, 09:30–16:00 America/New_York'));
  for (const checked of [true, false, true]) {
    checkbox.checked = checked;
    onChange();
    assert.equal(JSON.parse(saved).rthOnly, checked);
    instance.config = JSON.parse(saved);
    await render();
    assert.ok(container.innerHTML.includes(markup(checked)));
  }
  await render({ config: {} });
  assert.ok(container.innerHTML.includes(markup(false)));
  await render();
  assert.ok(container.innerHTML.includes(markup(true)));
  multiExpirySkewWidget.destroy(container);
});

test('RTH display filtering retains all recorded and archived points', async (t) => {
  const directory = await temporary(t);
  const session = createSkewHistorySession(() => ({ saveSkewHistory: (payload) => store.saveSkewHistory(directory, payload) }));
  const observations = ['2026-10-26T13:00:00Z', '2026-10-26T13:30:00Z', '2026-10-26T20:00:00.001Z'].map(snapshot);
  await session.capture(source, [{ ...widget, config: { ...config, rthOnly: true } }], observations);
  for (const expiration of config.expirations) {
    const key = skewIdentity(source, expiration, config.targetDelta);
    const archived = (await store.loadSkewHistory(directory, { identity: key })).documents.flatMap((d) => d.points);
    assert.deepEqual(archived.map((p) => p.timestamp), observations.map((s) => new Date(s.time).toISOString()));
    assert.deepEqual(session.points(key), archived);
    const lines = [{ expiration, points: archived }];
    assert.equal(buildMultiExpirySeries(lines, { rthOnly: true }).x.length, 1);
    assert.equal(buildMultiExpirySeries(lines, { rthOnly: false }).x.length, 3);
  }
});

test('smoothing control persists changes through the config callback and restores the selected option', async () => {
  let onChange;
  let saved;
  const select = { dataset: { skewSetting: 'smoothing' }, value: '', addEventListener: (_event, handler) => { onChange = handler; } };
  const container = {
    innerHTML: '',
    querySelectorAll: (selector) => selector === '[data-skew-setting]' ? [select] : [],
    querySelector: () => ({ addEventListener() {}, textContent: '' })
  };
  const instance = { config: {} };
  const render = () => multiExpirySkewWidget.render({ container, widget: instance, onConfigChange: () => { saved = JSON.stringify(instance.config); } });
  await render();
  assert.match(container.innerHTML, /value="linear" selected/);
  for (const smoothing of ['ma5', 'ma15', 'linear']) {
    select.value = smoothing;
    onChange();
    assert.equal(JSON.parse(saved).smoothing, smoothing);
    instance.config = JSON.parse(saved);
    await render();
    assert.ok(container.innerHTML.includes(`value="${smoothing}" selected`));
  }
  instance.config.smoothing = 'unknown';
  await render();
  assert.match(container.innerHTML, /value="linear" selected/);
  for (const key of ['startTime', 'endTime']) {
    select.dataset.skewSetting = key;
    select.value = '11:30:15';
    onChange();
    assert.equal(JSON.parse(saved)[key], '11:30:15');
    instance.config = JSON.parse(saved);
    await render();
    assert.ok(container.innerHTML.includes(`data-skew-setting="${key}" type="time"`));
    assert.ok(container.innerHTML.includes('value="11:30:15"'));
  }
  multiExpirySkewWidget.destroy(container);
});

test('expiration section keeps its state across renders and restored config without toggle loops', async () => {
  let details;
  let changes = 0;
  let saved;
  const instance = { config: {} };
  const container = {
    set innerHTML(html) {
      details = { open: html.includes('data-skew-expirations open'),
        addEventListener: (_event, handler) => { details.toggle = handler; } };
    },
    querySelectorAll: () => [],
    querySelector: (selector) => selector === '[data-skew-expirations]' ? details : { addEventListener() {}, textContent: '' }
  };
  const render = () => multiExpirySkewWidget.render({ container, widget: instance, onConfigChange: () => {
    changes++;
    saved = JSON.stringify(instance.config);
  } });
  await render();
  assert.equal(details.open, true);
  details.toggle(); // Initial browser toggle event must not trigger another render.
  assert.equal(changes, 0);
  details.open = false;
  details.toggle();
  assert.equal(changes, 1);
  const detached = details;
  await render();
  assert.equal(details.open, false);
  detached.open = true;
  detached.toggle(); // A detached render must not overwrite the saved state.
  assert.equal(changes, 1);
  instance.config = JSON.parse(saved);
  await render();
  assert.equal(details.open, false);
  details.open = true;
  details.toggle();
  assert.equal(changes, 2);
  await render();
  assert.equal(details.open, true);
  details.toggle();
  assert.equal(changes, 2);
  multiExpirySkewWidget.destroy(container);
});

test('legend visibility survives refreshes, reordering and restored config, independently per widget', async () => {
  const lines = [{ expiration: '20261030', data: [4] }, { expiration: '20261106', data: [3] }];
  const config = { hiddenExpirations: [] };
  let changes = 0;
  let current = true;
  const options = multiExpiryVisibilityOptions(lines, config, () => { changes++; }, () => current);
  const plot = { series: options.series };
  const toggle = (index, show) => {
    plot.series[index].show = show;
    options.hooks.setSeries[0](plot, index, { show });
  };
  toggle(1, false);
  await Promise.resolve();
  assert.deepEqual(config.hiddenSeries, ['20261030:spread']);
  assert.equal(changes, 1);
  const restored = multiExpiryVisibilityOptions([...lines].reverse(), JSON.parse(JSON.stringify(config)), () => {});
  assert.deepEqual(restored.series.slice(1).map((series) => series.show), [true, false]);
  const independent = multiExpiryVisibilityOptions(lines, { hiddenExpirations: [] }, () => {});
  assert.equal(independent.series[1].show, true);
  toggle(1, true);
  toggle(2, false); // A grouped legend action should persist once.
  await Promise.resolve();
  assert.deepEqual(config.hiddenSeries, ['20261106:spread']);
  assert.equal(changes, 2);
  toggle(1, false);
  await Promise.resolve();
  assert.equal(multiExpiryVisibilityOptions(lines, config, () => {}).series.slice(1).every((series) => !series.show), true);
  toggle(1, true);
  toggle(2, true);
  await Promise.resolve();
  assert.deepEqual(config.hiddenSeries, []);
  const count = changes;
  options.hooks.setSeries[0](plot, 1, { focus: true });
  await Promise.resolve();
  assert.equal(changes, count);
  toggle(1, false);
  current = false; // A refresh disposed this plot before the queued hook ran.
  await Promise.resolve();
  assert.deepEqual(config.hiddenSeries, []);
  assert.equal(changes, count);
});

test('time bounds include exact boundary points and filter before smoothing in local chart time', () => {
  const points = ['10:59:59', '11:00:00', '11:30:00', '11:30:00.001', '12:00:00']
    .map((time, i) => point(new Date(`2026-10-26T${time}`).toISOString(), i + 1));
  const lines = [{ expiration: '20261030', points }];
  const bounds = { startDate: '2026-10-26', endDate: '2026-10-26', startTime: '11:00', endTime: '11:30' };
  const series = buildMultiExpirySeries(lines, { ...bounds, smoothing: 'ma5' });
  assert.deepEqual(series.lines[0].meta, points.slice(1, 3));
  assert.deepEqual(series.lines[0].data, [200, 250]);
  assert.deepEqual(buildMultiExpirySeries(lines, { startTime: '11:00', endTime: '11:30' }), buildMultiExpirySeries(lines));
  assert.equal(buildMultiExpirySeries(lines, { ...bounds, startTime: '', endTime: '' }).x.length, 5);
  assert.equal(buildMultiExpirySeries(lines, { ...bounds, startTime: '12:00' }).x.length, 0);
});

test('time bounds apply only on boundary dates and follow local winter/summer offsets', () => {
  for (const date of ['2026-10-26', '2026-12-01']) {
    const points = [point(new Date(`${date}T11:00:00`).toISOString(), 1), point(new Date(`${date}T11:00:01`).toISOString(), 2)];
    const result = buildMultiExpirySeries([{ expiration: '20261218', points }], {
      startDate: date, endDate: date, startTime: '11:00:00', endTime: '11:00:00'
    });
    assert.deepEqual(result.lines[0].meta, [points[0]]);
  }
  const points = ['2026-10-26T11:00:00', '2026-10-27T09:00:00', '2026-10-28T10:00:00'].map((time) => point(new Date(time).toISOString()));
  assert.equal(buildMultiExpirySeries([{ expiration: '20261030', points }], {
    startDate: '2026-10-26', startTime: '11:00', endDate: '2026-10-28', endTime: '10:00'
  }).x.length, 3);
});

test('AM/PM cuts match chart time across timezones and archive boundaries cover adjacent New York dates', () => {
  const moduleUrl = new URL('../src/shared/multi-expiry-skew.mjs', import.meta.url).href;
  for (const timezone of ['Asia/Nicosia', 'America/New_York', 'UTC']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { buildMultiExpirySeries, skewDisplayRange } from ${JSON.stringify(moduleUrl)};
      const points = ['15:30:00', '16:30:00', '17:00:00'].map((time) => ({
        timestamp: new Date('2026-10-28T' + time).toISOString(), skew: 0.04
      }));
      const lines = [{ expiration: '20261030', points }];
      const config = { startDate: '2026-10-28', endDate: '2026-10-28' };
      assert.equal(buildMultiExpirySeries(lines, { ...config, startTime: '04:30' }).x.length, 3);
      const cut = buildMultiExpirySeries(lines, { ...config, startTime: '16:30' });
      assert.equal(cut.x.length, 2);
      assert.equal(new Date(cut.x[0] * 1000).getHours(), 16);
      assert.equal(new Date(cut.x[0] * 1000).getMinutes(), 30);
      assert.equal(buildMultiExpirySeries(lines, { ...config, endTime: '16:30' }).x.length, 2);
      if (process.env.TZ === 'Asia/Nicosia') {
        assert.deepEqual(skewDisplayRange(config).archive, { startDate: '20261027', endDate: '20261028' });
        const dstDay = skewDisplayRange({ startDate: '2026-03-29', endDate: '2026-03-29' });
        assert.equal(dstDay.end - dstDay.start + 1, 23 * 60 * 60 * 1000);
      }
    `], { env: { ...process.env, TZ: timezone }, encoding: 'utf8' });
    assert.equal(result.status, 0, `${timezone}: ${result.stderr || result.error || result.stdout}`);
  }
});

test('store survives new sessions, upserts concurrently, separates identities and protects valid points', async (t) => {
  const directory = await temporary(t);
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.saveSkewHistory(directory, { identity,
    points: [point(`2026-10-26T15:0${i}:00Z`)] })));
  await store.saveSkewHistory(directory, { identity, points: [point(undefined, null)] });
  await store.saveSkewHistory(directory, { identity, points: [point(undefined, 0.05)] });
  const loaded = await store.loadSkewHistory(directory, { identity });
  assert.equal(loaded.documents[0].points.length, 8);
  assert.equal(loaded.documents[0].points[0].skew, 0.05);
  for (const changed of [{ dataSourceId: 'other' }, { symbol: 'SPX' }, { targetDelta: 0.1 }, { expiration: '20261106' }]) {
    assert.equal((await store.loadSkewHistory(directory, { identity: { ...identity, ...changed } })).documents.length, 0);
  }
  assert.equal((await store.loadSkewHistory(directory, { identity, startDate: '2026-10-27' })).documents.length, 0);
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const saved = JSON.parse(await readFile(path.join(directory, files[0]), 'utf8'));
  assert.equal(saved.version, 1);
  await writeFile(path.join(directory, 'broken.json'), '{');
  const withWarning = await store.loadSkewHistory(directory, { identity });
  assert.equal(withWarning.documents.length, 1);
  assert.equal(withWarning.warnings.length, 1);
});

test('session records without a renderer, deduplicates widgets, retries writes and survives datasource reset', async (t) => {
  const directory = await temporary(t);
  let fail = true, calls = 0;
  const bridge = { saveSkewHistory: async (payload) => {
    calls++;
    if (fail) throw new Error('disk unavailable');
    return store.saveSkewHistory(directory, payload);
  } };
  const session = createSkewHistorySession(() => bridge);
  await session.capture(source, [widget, { ...widget, id: 'w2' }], [snapshot()]);
  assert.equal(calls, 2); // one write per expiration, independent of widget count
  assert.match(session.error(identity), /disk unavailable/);
  fail = false;
  await session.capture(source, [widget], []); // datasource history has been reset
  assert.equal(session.error(identity), '');
  assert.equal((await store.loadSkewHistory(directory, { identity })).documents[0].points.length, 1);
  const restored = createSkewHistorySession(() => bridge);
  assert.equal(restored.points(identity).length, 0);
  const archived = (await store.loadSkewHistory(directory, { identity })).documents.flatMap((d) => d.points);
  assert.equal(mergeSkewPoints(archived, restored.points(identity)).length, 1);
  await session.capture(source, [widget], [snapshot()]);
  assert.equal(calls, 4);
  await session.capture(source, [{ ...widget, config: { ...config, targetDelta: 0.1 } }], [snapshot()]);
  assert.equal(session.points({ ...identity, targetDelta: 0.1 }).length, 1);
  assert.ok(Math.abs(session.points(identity)[0].skew - 0.04) < 1e-9);
});

test('new points arriving during a write are flushed and invalid timestamps are rejected', async (t) => {
  const directory = await temporary(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const session = createSkewHistorySession(() => ({ saveSkewHistory: async (payload) => {
    if (++calls === 1) await gate;
    return store.saveSkewHistory(directory, payload);
  } }));
  const one = { ...widget, config: { ...config, expirations: ['20261030'] } };
  const first = session.capture(source, [one], [snapshot()]);
  const second = session.capture(source, [one], [snapshot('2026-10-26T15:05:00Z')]);
  release();
  await Promise.all([first, second]);
  assert.equal((await store.loadSkewHistory(directory, { identity })).documents[0].points.length, 2);
  await assert.rejects(store.saveSkewHistory(directory, { identity, points: [point('invalid')] }), /Invalid skew history point/);
});

test('archive uses New York date, preserves malformed documents and ignores malformed point metadata', async (t) => {
  const directory = await temporary(t);
  await store.saveSkewHistory(directory, { identity, points: [point('2026-10-27T01:00:00Z')] });
  const loaded = await store.loadSkewHistory(directory, { identity, endDate: '2026-10-26' });
  assert.equal(loaded.documents[0].date, '20261026');
  const filename = (await readdir(directory))[0];
  const file = path.join(directory, filename);
  const broken = { ...loaded.documents[0], points: [{ ...point(), put: { iv: 0.24, contracts: [{ delta: 'invalid' }] } }] };
  await writeFile(file, JSON.stringify(broken));
  const skipped = await store.loadSkewHistory(directory, { identity });
  assert.equal(skipped.documents.length, 0);
  assert.equal(skipped.warnings.length, 1);
  await assert.rejects(store.saveSkewHistory(directory, { identity, points: [point()] }), /Invalid existing/);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), broken);
  assert.equal(calculateMultiExpiryPoints([snapshot(Date.parse('2026-10-26T15:00:00Z'))], config)[0].points.length, 1);
});

function wingSnapshot(time) {
  const s = snapshot(time);
  for (const chain of Object.values(s.byExpiry)) chain.optionQuotes.push(q('put', 100, -0.5, 0.19), q('call', 100, 0.5, 0.21));
  return s;
}

test('side modes use wing-minus-ATM formulas and retain stable metric IDs', () => {
  const s = wingSnapshot();
  const compact = trimSnapshotForWidgets(s, { widgets: [widget] });
  const lines = calculateMultiExpiryPoints([compact], config);
  const p = lines[0].points[0];
  assert.equal(p.atmIV, 0.2);
  assert.equal(p.atmStrike, 100);
  for (const [side, expected] of [['put', [4, 3]], ['call', [0, 0]], ['spread', [4, 3]], ['both', [4, 0, 3, 0]]]) {
    const series = buildMultiExpirySeries(lines, { side });
    assert.equal(series.lines.length, expected.length);
    series.lines.forEach((line, i) => {
      assert.ok(Math.abs(line.data[0] - expected[i]) < 1e-9);
      assert.equal(line.id, `${line.expiration}:${line.metric}`);
    });
  }
  const noAtm = calculateMultiExpiryPoints([snapshot()], config);
  assert.equal(buildMultiExpirySeries(noAtm, { side: 'both' }).lines.every((l) => l.data[0] === null), true);
  assert.ok(Number.isFinite(buildMultiExpirySeries(noAtm, { side: 'spread' }).lines[0].data[0]));
  s.byExpiry['20261030'].optionQuotes = s.byExpiry['20261030'].optionQuotes.filter((v) => v.type !== 'call' || v.strike === 100);
  const missingCall = calculateMultiExpiryPoints([s], config)[0].points[0];
  assert.ok(Number.isFinite(missingCall.putWing));
  assert.equal(missingCall.callWing, null);
  assert.equal(missingCall.skew, null);
});

test('legacy config migrates once; new widgets default to Both; selector persists every mode', async () => {
  const old = { type: widget.type, config: { hiddenExpirations: ['20261030'] } };
  assert.equal(migrateMultiExpirySkewConfig(old), true);
  assert.equal(old.config.side, 'spread');
  assert.deepEqual(old.config.hiddenSeries, ['20261030:spread']);
  assert.equal(migrateMultiExpirySkewConfig(old), false);
  assert.equal(multiExpirySkewWidget.defaultConfig.side, 'both');
  let handler, saved;
  const select = { dataset: { skewSetting: 'side' }, value: '', addEventListener: (_e, fn) => { handler = fn; } };
  const container = { innerHTML: '', querySelectorAll: (selector) => selector === '[data-skew-setting]' ? [select] : [], querySelector: () => ({ addEventListener() {} }) };
  const instance = { type: widget.type, config: {} };
  const render = () => multiExpirySkewWidget.render({ container, widget: instance, onConfigChange: () => { saved = JSON.stringify(instance.config); } });
  await render();
  assert.match(container.innerHTML, /value="spread" selected/);
  for (const side of ['put', 'call', 'both', 'spread']) {
    select.value = side;
    handler();
    instance.config = JSON.parse(saved);
    await render();
    assert.equal(instance.config.side, side);
    assert.ok(container.innerHTML.includes(`value="${side}" selected`));
  }
  multiExpirySkewWidget.destroy(container);
});

test('wing smoothing skips independent gaps and applies RTH and date filters first', () => {
  const points = [
    { ...point('2026-10-26T13:00:00Z'), putWing: 1, callWing: 1 },
    { ...point('2026-10-26T14:00:00Z'), putWing: 0.01, callWing: null },
    { ...point('2026-10-26T15:00:00Z'), putWing: null, callWing: 0.04 },
    { ...point('2026-10-26T16:00:00Z'), putWing: 0.03, callWing: 0.06 }
  ];
  const series = buildMultiExpirySeries([{ expiration: '20261030', points }], {
    side: 'both', smoothing: 'ma5', rthOnly: true, startDate: '2026-10-26', endDate: '2026-10-26'
  });
  assert.deepEqual(series.lines.map((l) => l.data), [[1, null, 2], [null, 4, 5]]);
  assert.equal(points[0].putWing, 1);
});

test('wing legend shares expiry colors, distinguishes sides and persists each line across mode changes', async () => {
  const lines = buildMultiExpirySeries(calculateMultiExpiryPoints([wingSnapshot()], config), { side: 'both' }).lines;
  const cfg = { hiddenSeries: [] };
  const options = multiExpiryVisibilityOptions(lines, cfg, () => {});
  assert.equal(options.series[1].stroke, options.series[2].stroke);
  assert.notEqual(options.series[1].stroke, options.series[3].stroke);
  assert.deepEqual(options.series[1].dash, []);
  assert.deepEqual(options.series[2].dash, [6, 4]);
  assert.equal(options.series[2].label, '20261030 Call');
  options.series[2].show = false;
  options.hooks.setSeries[0]({ series: options.series }, 2, { show: false });
  await Promise.resolve();
  const restored = JSON.parse(JSON.stringify(cfg));
  assert.deepEqual(restored.hiddenSeries, ['20261030:call']);
  const call = multiExpiryVisibilityOptions(lines.filter((l) => l.metric === 'call').reverse(), restored, () => {});
  assert.deepEqual(call.series.slice(1).map((s) => s.show), [true, false]);
  const put = multiExpiryVisibilityOptions(lines.filter((l) => l.metric === 'put'), restored, () => {});
  assert.equal(put.series[1].show, true);
});

test('archive enriches legacy points and partial wing observations cannot erase valid measurements', async (t) => {
  const directory = await temporary(t);
  const original = calculateMultiExpiryPoints([wingSnapshot()], config)[0].points[0];
  const legacy = { ...original };
  for (const field of ['atmIV', 'atmStrike', 'putWing', 'callWing']) delete legacy[field];
  await store.saveSkewHistory(directory, { identity, points: [legacy] });
  const load = async () => (await store.loadSkewHistory(directory, { identity })).documents[0].points;
  assert.equal(buildMultiExpirySeries([{ expiration: identity.expiration, points: await load() }], { side: 'put' }).lines[0].data[0], null);
  await store.saveSkewHistory(directory, { identity, points: [original] });
  const partial = { ...original, skew: null, putWing: null, put: { iv: null, contracts: [] }, callWing: 0.01 };
  await store.saveSkewHistory(directory, { identity, points: [partial] });
  const disk = (await load())[0];
  const memory = mergeSkewPoints([legacy], [original], [partial])[0];
  assert.deepEqual(disk, memory);
  assert.equal(disk.putWing, original.putWing);
  assert.equal(disk.skew, original.skew);
  assert.equal(disk.put.iv, original.put.iv);
  assert.equal(disk.callWing, 0.01);
  await assert.rejects(store.saveSkewHistory(directory, { identity, points: [{ ...original, atmIV: 'bad' }] }), /Invalid skew history point/);
  const session = createSkewHistorySession(() => ({ saveSkewHistory: (payload) => store.saveSkewHistory(directory, payload) }));
  for (const side of ['put', 'call', 'both', 'spread']) await session.capture(source, [{ ...widget, config: { ...config, side } }], [wingSnapshot()]);
  assert.equal((await readdir(directory)).length, 2); // One archive per expiry, shared across sides.
  assert.ok(Number.isFinite(session.points(identity)[0].callWing));
});


test('RTH daily opening offset follows New York DST independently of local timezone', () => {
  const moduleUrl = new URL('../src/shared/multi-expiry-skew.mjs', import.meta.url).href;
  for (const timezone of ['UTC', 'Asia/Nicosia', 'America/New_York']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { buildMultiExpirySeries } from ${JSON.stringify(moduleUrl)};
      const points = [
        ['2026-03-06', '-05:00'], ['2026-03-09', '-04:00'],
        ['2026-10-23', '-04:00'], ['2026-10-26', '-04:00'],
        ['2026-11-02', '-05:00'], ['2026-11-03', '-05:00']
      ].flatMap(([date, offset]) => ['09:30:00', '09:59:59.999', '10:00:00', '10:00:00.001', '16:00:00', '16:00:00.001']
        .map((time) => ({timestamp:new Date(date+'T'+time+offset).toISOString(),skew:0.04,putWing:0.02,callWing:-0.02})));
      const lines = [{expiration:'20261218',points}];
      const config = {rthOnly:true,rthStartOffsetMinutes:30,side:'both',smoothing:'ma5'};
      const expected = points.filter((_p,i)=>[2,3,4].includes(i%6));
      for (const bounds of [{}, {startDate:'2026-03-06',endDate:'2026-11-03'}]) {
        const series = buildMultiExpirySeries(lines,{...config,...bounds});
        assert.deepEqual(series.lines[0].meta,expected);
        assert.deepEqual(series.lines[1].meta,expected);
        assert.ok(series.lines[0].data.every((v)=>v===2));
      }
      assert.deepEqual(buildMultiExpirySeries(lines,{...config,startTime:'23:59',endTime:'00:01'}),buildMultiExpirySeries(lines,config));
      assert.equal(buildMultiExpirySeries(lines,{rthStartOffsetMinutes:30}).x.length,points.length);
      assert.equal(buildMultiExpirySeries(lines,{rthOnly:true,rthStartOffsetMinutes:0}).x.length,30);
      assert.deepEqual(buildMultiExpirySeries(lines,{...config,rthStartOffsetMinutes:390}).lines[0].meta,points.filter((_p,i)=>i%6===4));
      const weekend = [{timestamp:'2026-10-24T14:00:00Z',skew:0.04}];
      assert.equal(buildMultiExpirySeries([{expiration:'20261218',points:weekend}],config).x.length,0);
      const cut = buildMultiExpirySeries(lines,{...config,startDate:'2026-11-02',endDate:'2026-11-03'});
      assert.deepEqual(cut.lines[0].meta,expected.slice(-6));
    `], {env:{...process.env,TZ:timezone},encoding:'utf8'});
    assert.equal(result.status,0,timezone+': '+(result.stderr||result.error||result.stdout));
  }
  for (const [value, expected] of [[undefined,0],['bad',0],[-10,0],[400,390],['30',30],[30.9,30]]) {
    assert.equal(normalizeRthStartOffset(value),expected);
  }
});

test('RTH offset control persists and replaces local start time only in RTH mode', async () => {
  let handler, saved;
  const input = {dataset:{skewSetting:'rthStartOffsetMinutes'},value:'30',addEventListener:(_e,fn)=>{handler=fn;}};
  const container = {innerHTML:'',querySelectorAll:(selector)=>selector==='[data-skew-setting]'?[input]:[],querySelector:()=>({addEventListener(){}})};
  const instance = {type:widget.type,config:{rthOnly:true,startTime:'15:00'}};
  const render=()=>multiExpirySkewWidget.render({container,widget:instance,onConfigChange:()=>{saved=JSON.stringify(instance.config);}});
  await render();
  assert.ok(container.innerHTML.includes('RTH start + (min)'));
  assert.ok(!container.innerHTML.includes('data-skew-setting="startTime"'));
  assert.ok(!container.innerHTML.includes('data-skew-setting="endTime"'));
  handler();
  instance.config=JSON.parse(saved);
  await render();
  assert.equal(instance.config.rthStartOffsetMinutes,30);
  assert.equal(instance.config.startTime,'15:00');
  instance.config.rthOnly=false;
  await render();
  assert.ok(container.innerHTML.includes('data-skew-setting="startTime"'));
  assert.ok(container.innerHTML.includes('data-skew-setting="endTime"'));
  assert.ok(!container.innerHTML.includes('data-skew-setting="rthStartOffsetMinutes"'));
  multiExpirySkewWidget.destroy(container);
});
