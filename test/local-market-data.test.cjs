const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLocalMarketSeries } = require('../src/main/local-market-data.cjs');

test('loads local CSV market rows with quoted values', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-market-'));
  const file = path.join(directory, 'spx.csv');
  fs.writeFileSync(file, '\uFEFFdate,symbol,close\n2026-06-02,"SPX",7609.78\n', 'utf-8');

  assert.deepEqual(loadLocalMarketSeries(file), [
    { date: '2026-06-02', symbol: 'SPX', close: '7609.78' }
  ]);
});

test('loads local JSON market rows', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-market-'));
  const file = path.join(directory, 'vix.json');
  fs.writeFileSync(file, JSON.stringify([{ date: '2026-06-02', symbol: 'VIX', close: 15.5 }]), 'utf-8');

  assert.deepEqual(loadLocalMarketSeries(file), [
    { date: '2026-06-02', symbol: 'VIX', close: 15.5 }
  ]);
});
