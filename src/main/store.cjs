const fs = require('fs');
const path = require('path');

const CONFIG_FILE_NAME = 'dashboard-config.json';
const LEGACY_FILE_NAME = 'dashboard-state.json';
const BACKUP_COUNT = 3;

function configPath(userDataPath) {
  return path.join(userDataPath, CONFIG_FILE_NAME);
}

function legacyStatePath(userDataPath) {
  return path.join(userDataPath, LEGACY_FILE_NAME);
}

function backupPath(userDataPath, index) {
  return path.join(userDataPath, `dashboard-config.backup-${index}.json`);
}

function tempConfigPath(userDataPath) {
  return path.join(userDataPath, `${CONFIG_FILE_NAME}.tmp`);
}

function readJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf-8');
  return JSON.parse(raw);
}

function hasValidConfigShape(data) {
  return Boolean(data && typeof data === 'object' && Array.isArray(data.tabs) && data.tabs.length);
}

function pickConfigFields(loaded, defaults) {
  const source = hasValidConfigShape(loaded) ? loaded : defaults;
  return {
    activeTabId: source.activeTabId || defaults.activeTabId,
    tabs: Array.isArray(source.tabs) && source.tabs.length ? source.tabs : defaults.tabs,
    historyByTab: {}
  };
}

function loadFirstValidConfig(userDataPath) {
  const candidates = [
    configPath(userDataPath),
    ...Array.from({ length: BACKUP_COUNT }, (_item, idx) => backupPath(userDataPath, idx + 1)),
    legacyStatePath(userDataPath)
  ];

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const data = readJsonFile(file);
      if (hasValidConfigShape(data)) return data;
    } catch (_err) {
      // Try the next candidate. Corrupt config must not block backup or legacy recovery.
    }
  }

  return null;
}

function loadState(userDataPath, defaults) {
  return pickConfigFields(loadFirstValidConfig(userDataPath), defaults);
}

function configFromUiState(uiState, defaults = {}) {
  const tabs = Array.isArray(uiState?.tabs) && uiState.tabs.length
    ? uiState.tabs
    : defaults.tabs;
  return {
    activeTabId: uiState?.activeTabId || defaults.activeTabId || tabs?.[0]?.id || null,
    tabs: tabs || []
  };
}

async function removeFileBestEffort(file) {
  try {
    await fs.promises.rm(file, { force: true });
  } catch (_err) {
    // Best effort cleanup only.
  }
}

async function rotateConfigBackups(userDataPath) {
  const current = configPath(userDataPath);
  try {
    if (!hasValidConfigShape(readJsonFile(current))) return;
  } catch (_err) {
    return;
  }

  await removeFileBestEffort(backupPath(userDataPath, BACKUP_COUNT));
  for (let idx = BACKUP_COUNT - 1; idx >= 1; idx -= 1) {
    const from = backupPath(userDataPath, idx);
    const to = backupPath(userDataPath, idx + 1);
    try {
      await fs.promises.rename(from, to);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  await fs.promises.copyFile(current, backupPath(userDataPath, 1));
}

async function saveUiState(userDataPath, uiState) {
  const file = configPath(userDataPath);
  const tmp = tempConfigPath(userDataPath);
  const config = configFromUiState(uiState);
  const raw = `${JSON.stringify(config, null, 2)}\n`;

  try {
    await fs.promises.mkdir(userDataPath, { recursive: true });
    await fs.promises.writeFile(tmp, raw, 'utf-8');
    await rotateConfigBackups(userDataPath);
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await removeFileBestEffort(tmp);
    throw err;
  }
}

module.exports = {
  BACKUP_COUNT,
  CONFIG_FILE_NAME,
  LEGACY_FILE_NAME,
  backupPath,
  configPath,
  legacyStatePath,
  loadState,
  saveState: saveUiState,
  saveUiState
};
