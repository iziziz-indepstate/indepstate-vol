import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildMultiExpirySeries, calculateMultiExpiryPoints, mergeSkewPoints, normalizeSkewExpirations, skewIdentity } from '../src/shared/multi-expiry-skew.mjs';
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

test('multiple expirations share delta, retain quotes in compact history and show only skew', () => {
  const s = snapshot();
  const compact = trimSnapshotForWidgets(s, { widgets: [widget] });
  for (const expiry of config.expirations) assert.equal(compact.byExpiry[expiry].optionQuotes.length, 4);
  const lines = calculateMultiExpiryPoints([compact], config);
  const series = buildMultiExpirySeries(lines);
  assert.equal(series.lines.length, 2);
  assert.ok(Math.abs(series.lines[0].data[0] - 4) < 1e-9);
  assert.ok(Math.abs(series.lines[1].data[0] - 3) < 1e-9);
  assert.equal(lines[0].points[0].targetDelta, lines[1].points[0].targetDelta);
  assert.equal(lines[0].points[0].putWing, undefined);
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
  assert.deepEqual(empty, { x: [], lines: [{ expiration: '20261030', meta: [], data: [] }] });
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
  assert.deepEqual(config.hiddenExpirations, ['20261030']);
  assert.equal(changes, 1);
  const restored = multiExpiryVisibilityOptions([...lines].reverse(), JSON.parse(JSON.stringify(config)), () => {});
  assert.deepEqual(restored.series.slice(1).map((series) => series.show), [true, false]);
  const independent = multiExpiryVisibilityOptions(lines, { hiddenExpirations: [] }, () => {});
  assert.equal(independent.series[1].show, true);
  toggle(1, true);
  toggle(2, false); // A grouped legend action should persist once.
  await Promise.resolve();
  assert.deepEqual(config.hiddenExpirations, ['20261106']);
  assert.equal(changes, 2);
  toggle(1, false);
  await Promise.resolve();
  assert.equal(multiExpiryVisibilityOptions(lines, config, () => {}).series.slice(1).every((series) => !series.show), true);
  toggle(1, true);
  toggle(2, true);
  await Promise.resolve();
  assert.deepEqual(config.hiddenExpirations, []);
  const count = changes;
  options.hooks.setSeries[0](plot, 1, { focus: true });
  await Promise.resolve();
  assert.equal(changes, count);
  toggle(1, false);
  current = false; // A refresh disposed this plot before the queued hook ran.
  await Promise.resolve();
  assert.deepEqual(config.hiddenExpirations, []);
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
