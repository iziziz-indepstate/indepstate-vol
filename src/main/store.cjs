const fs = require('fs');
const path = require('path');

const FILE_NAME = 'dashboard-state.json';

function statePath(userDataPath) {
  return path.join(userDataPath, FILE_NAME);
}

function mergeDefaults(loaded, defaults) {
  if (!loaded || typeof loaded !== 'object') return defaults;
  return {
    ...defaults,
    ...loaded,
    tabs: Array.isArray(loaded.tabs) && loaded.tabs.length ? loaded.tabs : defaults.tabs,
    activeTabId: loaded.activeTabId || defaults.activeTabId,
    historyByTab: loaded.historyByTab && typeof loaded.historyByTab === 'object'
      ? loaded.historyByTab
      : (defaults.historyByTab || {})
  };
}

function loadState(userDataPath, defaults) {
  const file = statePath(userDataPath);
  try {
    if (!fs.existsSync(file)) return defaults;
    const raw = fs.readFileSync(file, 'utf-8');
    const data = JSON.parse(raw);
    return mergeDefaults(data, defaults);
  } catch (_err) {
    return defaults;
  }
}

function saveState(userDataPath, state) {
  const file = statePath(userDataPath);
  return fs.promises.writeFile(file, JSON.stringify(state), 'utf-8');
}

module.exports = {
  loadState,
  saveState
};
