const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  defaultAtmStraddleSnapshotDir,
  atmStraddleSnapshotFileName,
  loadAtmStraddleSnapshots,
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

test('loadAtmStraddleSnapshots loads valid daily documents', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-atm-straddle-'));
  saveAtmStraddleSnapshot(directory, payload());

  const result = loadAtmStraddleSnapshots(directory, { tenor: '1W' });

  assert.equal(result.ok, true);
  assert.equal(result.directory, directory);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].kind, 'atm-straddle-daily-snapshot');
  assert.equal(result.documents[0].identity.tenor, '1W');
  assert.equal(result.documents[0].points[0].straddlePts, 82.4);
  assert.match(result.documents[0].source.filename, /^atm-straddle_/);
});

test('loadAtmStraddleSnapshots filters by tenor and date range', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-atm-straddle-'));
  saveAtmStraddleSnapshot(directory, payload({
    sourceSnapshotTime: '2026-08-21T13:30:00.000Z',
    config: { tenor: '1W' },
    snapshot: { tenor: '1W', expiry: '2026-08-28' }
  }));
  saveAtmStraddleSnapshot(directory, payload({
    sourceSnapshotTime: '2026-08-22T13:30:00.000Z',
    config: { tenor: '0DTE' },
    snapshot: { tenor: '0DTE', expiry: '2026-08-22' }
  }));
  saveAtmStraddleSnapshot(directory, payload({
    sourceSnapshotTime: '2026-08-23T13:30:00.000Z',
    config: { tenor: '1W' },
    snapshot: { tenor: '1W', expiry: '2026-08-30' }
  }));

  const result = loadAtmStraddleSnapshots(directory, {
    tenor: '1W',
    startDate: '2026-08-22',
    endDate: '2026-08-24'
  });

  assert.deepEqual(result.documents.map((document) => document.date), ['2026-08-23']);
});

test('loadAtmStraddleSnapshots skips malformed and wrong-kind files with warnings', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-atm-straddle-'));
  fs.writeFileSync(path.join(directory, 'broken.json'), '{ nope', 'utf-8');
  fs.writeFileSync(path.join(directory, 'wrong.json'), JSON.stringify({ kind: 'other', version: 1 }), 'utf-8');
  saveAtmStraddleSnapshot(directory, payload());

  const result = loadAtmStraddleSnapshots(directory, { tenor: '1W' });

  assert.equal(result.documents.length, 1);
  assert.equal(result.warnings.length, 2);
});

test('loadAtmStraddleSnapshots keeps the last same-date same-identity document', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-atm-straddle-'));
  const base = {
    kind: 'atm-straddle-daily-snapshot',
    version: 1,
    date: '2026-08-21',
    identity: {
      symbol: 'SPX',
      tenor: '0DTE',
      expiry: '2026-08-21',
      atmStrikeOverride: 'ATM',
      manualReferencePrice: 'ATM',
      referencePriceMode: 'spot',
      quoteMode: 'mid'
    },
    summary: {},
    updatedAt: '2026-08-21T12:00:00.000Z'
  };
  fs.writeFileSync(path.join(directory, 'a.json'), JSON.stringify({
    ...base,
    points: [{ time: '2026-08-21T12:00:00.000Z', atmStrike: 6500, spot: 6490, straddlePts: 20 }]
  }), 'utf-8');
  fs.writeFileSync(path.join(directory, 'b.json'), JSON.stringify({
    ...base,
    points: [{ time: '2026-08-21T12:01:00.000Z', atmStrike: 6505, spot: 6495, straddlePts: 21 }]
  }), 'utf-8');

  const result = loadAtmStraddleSnapshots(directory, { tenor: '0DTE' });

  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].source.filename, 'b.json');
  assert.equal(result.documents[0].points[0].straddlePts, 21);
});

test('loadAtmStraddleSnapshots keeps different same-date identities separate', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-atm-straddle-'));
  saveAtmStraddleSnapshot(directory, payload({
    sourceSnapshotTime: '2026-08-21T13:30:00.000Z',
    config: { tenor: '0DTE', atmStrikeOverride: 'ATM' },
    snapshot: { tenor: '0DTE', expiry: '2026-08-21', atmStrike: 6500 }
  }));
  saveAtmStraddleSnapshot(directory, payload({
    sourceSnapshotTime: '2026-08-21T13:35:00.000Z',
    config: { tenor: '0DTE', atmStrikeOverride: '6510' },
    snapshot: { tenor: '0DTE', expiry: '2026-08-21', atmStrike: 6510 }
  }));

  const result = loadAtmStraddleSnapshots(directory, { tenor: '0DTE' });

  assert.equal(result.documents.length, 2);
});

test('loadAtmStraddleSnapshots returns empty data for a missing directory', () => {
  const directory = path.join(os.tmpdir(), `is-vol-missing-${Date.now()}`);

  const result = loadAtmStraddleSnapshots(directory, { tenor: '1W' });

  assert.deepEqual(result, {
    ok: true,
    directory,
    documents: [],
    warnings: []
  });
});
