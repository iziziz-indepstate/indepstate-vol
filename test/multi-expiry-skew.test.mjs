import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildMultiExpirySeries, calculateMultiExpiryPoints, mergeSkewPoints, normalizeSkewExpirations, skewIdentity } from '../src/shared/multi-expiry-skew.mjs';
import { createSkewHistorySession } from '../src/renderer/skew-history.js';
import { multiExpirySkewWidget } from '../src/renderer/widgets/multi-expiry-skew-widget.js';
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

test('empty, single-point and filtered series preserve alignment and New York trading dates', () => {
  assert.deepEqual(buildMultiExpirySeries([]), { x: [], lines: [] });
  const points = [point('2026-10-27T01:00:00Z'), point('2026-10-27T15:00:00Z')];
  const filtered = buildMultiExpirySeries([{ expiration: '20261030', points }], { startDate: '2026-10-26', endDate: '2026-10-26' });
  assert.deepEqual(filtered.x, [Date.parse(points[0].timestamp) / 1000]);
  assert.deepEqual(filtered.lines[0].data, [4]);
  assert.deepEqual(filtered.lines[0].meta, [points[0]]);
  const empty = buildMultiExpirySeries([{ expiration: '20261030', points }], { startDate: '2026-10-28' });
  assert.deepEqual(empty, { x: [], lines: [{ expiration: '20261030', meta: [], data: [] }] });
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
