const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  defaultRawSnapshotDir,
  rawSnapshotFileName,
  saveRawSnapshot
} = require('../src/main/raw-snapshot-store.cjs');

test('default raw snapshot dir uses the platform documents folder', () => {
  const dir = defaultRawSnapshotDir({
    getPath: (name) => {
      assert.equal(name, 'documents');
      return path.join('C:', 'Users', 'Trader', 'Documents');
    }
  });

  assert.equal(dir, path.join('C:', 'Users', 'Trader', 'Documents', 'IS-VOL', 'Data'));
});

test('raw snapshot filename is stable and filesystem safe', () => {
  const fileName = rawSnapshotFileName({
    tab: {
      title: 'SPY / 0DTE',
      providerConfig: { ticker: 'AMEX:SPY' }
    },
    snapshot: { time: '2026-06-09T10:11:12.123Z' }
  });

  assert.equal(fileName, '2026-06-09T10-11-12-123Z_SPY-0DTE_AMEX-SPY.json');
});

test('saveRawSnapshot writes the full raw snapshot JSON', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-raw-'));
  const snapshot = {
    time: '2026-06-09T10:11:12.123Z',
    px: 100,
    byExpiry: {
      20260612: {
        optionQuotes: [
          { type: 'put', strike: 100, bid: 1, ask: 1.2 }
        ]
      }
    }
  };

  const result = saveRawSnapshot(directory, {
    tab: {
      title: 'SPY',
      providerConfig: { root: 'SPY' }
    },
    snapshot
  });

  assert.equal(result.ok, true);
  assert.equal(result.directory, directory);
  assert.ok(fs.existsSync(result.file));
  assert.deepEqual(JSON.parse(fs.readFileSync(result.file, 'utf-8')), snapshot);
});
