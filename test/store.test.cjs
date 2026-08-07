const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  backupPath,
  configPath,
  legacyStatePath,
  loadState,
  saveUiState
} = require('../src/main/store.cjs');

const defaults = {
  activeTabId: 'default-tab',
  tabs: [{ id: 'default-tab', title: 'Default', widgets: [] }],
  historyByTab: { 'default-tab': [{ time: 'default-history' }] }
};

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'is-vol-store-'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function config(activeTabId, historyByTab = undefined) {
  const data = {
    activeTabId,
    tabs: [{ id: activeTabId, title: activeTabId, widgets: [] }]
  };
  if (historyByTab) data.historyByTab = historyByTab;
  return data;
}

test('loads dashboard-config.json when valid and always starts with empty history', () => {
  const dir = makeTempDir();
  writeJson(configPath(dir), config('config-tab', { 'config-tab': [{ time: 'old' }] }));

  const loaded = loadState(dir, defaults);

  assert.equal(loaded.activeTabId, 'config-tab');
  assert.deepEqual(loaded.tabs, [{ id: 'config-tab', title: 'config-tab', widgets: [] }]);
  assert.deepEqual(loaded.historyByTab, {});
});

test('falls back to a valid backup when dashboard-config.json is corrupt', () => {
  const dir = makeTempDir();
  fs.writeFileSync(configPath(dir), '{ broken', 'utf-8');
  writeJson(backupPath(dir, 1), config('backup-tab', { 'backup-tab': [{ time: 'old' }] }));

  const loaded = loadState(dir, defaults);

  assert.equal(loaded.activeTabId, 'backup-tab');
  assert.deepEqual(loaded.historyByTab, {});
});

test('falls back to legacy dashboard-state.json when no config exists', () => {
  const dir = makeTempDir();
  writeJson(legacyStatePath(dir), config('legacy-tab', { 'legacy-tab': [{ time: 'old' }] }));

  const loaded = loadState(dir, defaults);

  assert.equal(loaded.activeTabId, 'legacy-tab');
  assert.deepEqual(loaded.tabs, [{ id: 'legacy-tab', title: 'legacy-tab', widgets: [] }]);
  assert.deepEqual(loaded.historyByTab, {});
});

test('saves only config fields and never writes historyByTab', async () => {
  const dir = makeTempDir();

  await saveUiState(dir, {
    activeTabId: 'saved-tab',
    tabs: [{ id: 'saved-tab', title: 'Saved', widgets: [] }],
    historyByTab: { 'saved-tab': [{ time: 'must-not-save' }] }
  });

  assert.deepEqual(readJson(configPath(dir)), {
    activeTabId: 'saved-tab',
    tabs: [{ id: 'saved-tab', title: 'Saved', widgets: [] }]
  });
  assert.equal(fs.existsSync(legacyStatePath(dir)), false);
});

test('creates and rotates up to 3 config backups before replacing valid config', async () => {
  const dir = makeTempDir();
  writeJson(configPath(dir), config('A'));

  await saveUiState(dir, config('B'));
  await saveUiState(dir, config('C'));
  await saveUiState(dir, config('D'));
  await saveUiState(dir, config('E'));

  assert.equal(readJson(configPath(dir)).activeTabId, 'E');
  assert.equal(readJson(backupPath(dir, 1)).activeTabId, 'D');
  assert.equal(readJson(backupPath(dir, 2)).activeTabId, 'C');
  assert.equal(readJson(backupPath(dir, 3)).activeTabId, 'B');
  assert.equal(fs.existsSync(backupPath(dir, 4)), false);
});

test('corrupt config does not overwrite existing backups during the next save', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(configPath(dir), '{ broken', 'utf-8');
  writeJson(backupPath(dir, 1), config('safe-backup'));

  await saveUiState(dir, config('new-config'));

  assert.equal(readJson(configPath(dir)).activeTabId, 'new-config');
  assert.equal(readJson(backupPath(dir, 1)).activeTabId, 'safe-backup');
  assert.equal(fs.existsSync(backupPath(dir, 2)), false);
});
