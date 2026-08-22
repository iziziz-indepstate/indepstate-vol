const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  defaultAtmStraddleSnapshotDir,
  atmStraddleSnapshotFileName,
  saveAtmStraddleSnapshot,
  saveAtmStraddleSnapshotAsync
} = require('../src/main/atm-straddle-snapshot-store.cjs');

function payload(overrides = {}) {
  const baseSnapshot = {
    symbol: 'SPX',
    tenor: '1W',
    expiry: '20260828',
    dte: 7,
    atmStrike: 6500,
    referencePrice: 6492.15,
    atmSelectionMethod: 'nearest_to_reference',
    straddle: { mid: 82.4 }
  };
  const snapshotOverrides = overrides.snapshot || {};
  const { config: _config, snapshot: _snapshot, ...rest } = overrides;
  return {
    title: 'Straddle ATM',
    sourceSnapshotTime: '2026-08-21T12:00:00.000Z',
    ...rest,
    config: {
      symbol: 'SPX',
      tenor: '1W',
      atmStrikeOverride: '',
      manualReferencePrice: 'Auto',
      referencePriceMode: 'spot',
      quoteMode: 'mid',
      ...(overrides.config || {})
    },
    snapshot: {
      ...baseSnapshot,
      ...snapshotOverrides,
      straddle: {
        ...baseSnapshot.straddle,
        ...(snapshotOverrides.straddle || {})
      }
    }
  };
}

test('default ATM straddle snapshot dir uses the Straddle-ATM Data subfolder', () => {
  const dir = defaultAtmStraddleSnapshotDir({
    getPath: (name) => {
      assert.equal(name, 'documents');
      return path.join('C:', 'Users', 'Trader', 'Documents');
    }
  });

  assert.equal(dir, path.join('C:', 'Users', 'Trader', 'Documents', 'IS-VOL', 'Data', 'Straddle-ATM'));
});

test('ATM straddle snapshot filename is stable and filesystem safe', () => {
  const first = atmStraddleSnapshotFileName(payload({
    config: {
      symbol: 'SPX / cash',
      tenor: '1 W'
    },
    snapshot: {
      symbol: 'SPX / cash',
      tenor: '1 W',
      expiry: '2026/08/28'
    }
  }));
  const second = atmStraddleSnapshotFileName(payload({
    config: {
      symbol: 'SPX / cash',
      tenor: '1 W'
    },
    snapshot: {
      symbol: 'SPX / cash',
      tenor: '1 W',
      expiry: '2026/08/28'
    }
  }));

  assert.equal(first, second);
  assert.match(first, /^atm-straddle_2026-08-21_SPX-cash_2026-08-28_1-W_[a-f0-9]{10}\.json$/);
});

test('saveAtmStraddleSnapshot creates a daily JSON document', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-atm-straddle-'));
  const result = saveAtmStraddleSnapshot(directory, payload());
  const document = JSON.parse(fs.readFileSync(result.file, 'utf-8'));

  assert.equal(result.ok, true);
  assert.equal(result.directory, directory);
  assert.equal(result.points, 1);
  assert.equal(document.kind, 'atm-straddle-daily-snapshot');
  assert.equal(document.version, 1);
  assert.equal(document.date, '2026-08-21');
  assert.deepEqual(document.identity, {
    symbol: 'SPX',
    tenor: '1W',
    expiry: '20260828',
    atmStrikeOverride: '',
    manualReferencePrice: 'Auto',
    referencePriceMode: 'spot',
    quoteMode: 'mid'
  });
  assert.deepEqual(document.points, [{
    time: '2026-08-21T12:00:00.000Z',
    atmStrike: 6500,
    spot: 6492.15,
    straddlePts: 82.4
  }]);
});

test('saveAtmStraddleSnapshot appends later same-day points sorted by time', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-atm-straddle-'));
  const first = saveAtmStraddleSnapshot(directory, payload({
    sourceSnapshotTime: '2026-08-21T12:00:00.000Z',
    snapshot: { straddle: { mid: 82.4 } }
  }));
  const second = saveAtmStraddleSnapshot(directory, payload({
    sourceSnapshotTime: '2026-08-21T11:55:00.000Z',
    snapshot: { straddle: { mid: 81.1 } }
  }));
  const document = JSON.parse(fs.readFileSync(second.file, 'utf-8'));

  assert.equal(first.file, second.file);
  assert.equal(second.points, 2);
  assert.deepEqual(document.points.map((point) => point.time), [
    '2026-08-21T11:55:00.000Z',
    '2026-08-21T12:00:00.000Z'
  ]);
  assert.deepEqual(document.points.map((point) => point.straddlePts), [81.1, 82.4]);
});

test('saveAtmStraddleSnapshot replaces an existing point with the same time', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-atm-straddle-'));
  const first = saveAtmStraddleSnapshot(directory, payload({
    snapshot: { straddle: { mid: 82.4 } }
  }));
  const second = saveAtmStraddleSnapshot(directory, payload({
    snapshot: { referencePrice: 6499.5, straddle: { mid: 79.25 } }
  }));
  const document = JSON.parse(fs.readFileSync(second.file, 'utf-8'));

  assert.equal(first.file, second.file);
  assert.equal(second.points, 1);
  assert.deepEqual(document.points, [{
    time: '2026-08-21T12:00:00.000Z',
    atmStrike: 6500,
    spot: 6499.5,
    straddlePts: 79.25
  }]);
});

test('different ATM straddle identity writes a different file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-atm-straddle-'));
  const first = saveAtmStraddleSnapshot(directory, payload());
  const second = saveAtmStraddleSnapshot(directory, payload({
    config: { atmStrikeOverride: '6510' },
    snapshot: { atmStrike: 6510, straddle: { mid: 76.5 } }
  }));

  assert.notEqual(first.file, second.file);
  assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith('.json')).length, 2);
});

test('saveAtmStraddleSnapshotAsync serializes concurrent writes to the same file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-atm-straddle-'));
  const first = payload({
    sourceSnapshotTime: '2026-08-21T12:00:00.000Z',
    snapshot: { straddle: { mid: 82.4 } }
  });
  const second = payload({
    sourceSnapshotTime: '2026-08-21T12:01:00.000Z',
    snapshot: { straddle: { mid: 83.2 } }
  });
  const [firstResult, secondResult] = await Promise.all([
    saveAtmStraddleSnapshotAsync(directory, first),
    saveAtmStraddleSnapshotAsync(directory, second)
  ]);
  const document = JSON.parse(fs.readFileSync(firstResult.file, 'utf-8'));

  assert.equal(firstResult.file, secondResult.file);
  assert.equal(document.points.length, 2);
  assert.deepEqual(document.points.map((point) => point.straddlePts), [82.4, 83.2]);
});
