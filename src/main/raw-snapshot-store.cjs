const fs = require('fs');
const path = require('path');

function defaultRawSnapshotDir(appLike) {
  const documents = appLike.getPath('documents');
  return path.join(documents, 'IS-VOL', 'Data');
}

function safePart(value, fallback) {
  const raw = String(value || '').trim();
  const safe = raw
    .replace(/[:/\\?%*"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return safe || fallback;
}

function timestampPart(value) {
  const dt = new Date(value || Date.now());
  const iso = Number.isNaN(dt.getTime()) ? new Date().toISOString() : dt.toISOString();
  return iso.replace(/[:.]/g, '-');
}

function rawSnapshotFileName(payload = {}) {
  const snapshot = payload.snapshot || {};
  const tab = payload.tab || {};
  const providerConfig = payload.providerConfig || tab.providerConfig || {};
  const ts = timestampPart(snapshot.time);
  const tabPart = safePart(tab.title || tab.id, 'tab');
  const symbolPart = safePart(providerConfig.root || providerConfig.ticker || providerConfig.yahooSymbol, 'snapshot');
  return `${ts}_${tabPart}_${symbolPart}.json`;
}

function saveRawSnapshot(directory, payload = {}) {
  const snapshot = payload.snapshot;
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Raw snapshot payload is missing snapshot object.');
  }

  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, rawSnapshotFileName(payload));
  fs.writeFileSync(file, JSON.stringify(snapshot), 'utf-8');
  return {
    ok: true,
    file,
    directory
  };
}

module.exports = {
  defaultRawSnapshotDir,
  rawSnapshotFileName,
  saveRawSnapshot
};
