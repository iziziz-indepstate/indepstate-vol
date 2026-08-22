const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KIND = 'atm-straddle-daily-snapshot';
const VERSION = 1;
const writeQueues = new Map();

function defaultAtmStraddleSnapshotDir(appLike) {
  const documents = appLike.getPath('documents');
  return path.join(documents, 'IS-VOL', 'Data', 'Straddle-ATM');
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

function isoDate(value) {
  const dt = new Date(value || 0);
  if (Number.isNaN(dt.getTime())) throw new Error('ATM straddle snapshot point is missing a valid time.');
  return dt.toISOString().slice(0, 10);
}

function toFiniteNumber(value, fieldName) {
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error(`ATM straddle snapshot point is missing ${fieldName}.`);
  return num;
}

function normalizeToken(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function normalizeIdentity(payload = {}) {
  const snapshot = payload.snapshot || {};
  const config = payload.config || {};
  return {
    symbol: normalizeToken(snapshot.symbol || config.symbol, 'SPX'),
    tenor: normalizeToken(snapshot.tenor || config.tenor, '1W'),
    expiry: normalizeToken(snapshot.expiry || config.expiryOverride, ''),
    atmStrikeOverride: normalizeToken(config.atmStrikeOverride, ''),
    manualReferencePrice: normalizeToken(config.manualReferencePrice, 'Auto'),
    referencePriceMode: normalizeToken(config.referencePriceMode, 'spot'),
    quoteMode: normalizeToken(config.quoteMode, 'mid')
  };
}

function identityKey(identity) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(identity))
    .digest('hex')
    .slice(0, 10);
}

function atmStraddleSnapshotFileName(payload = {}) {
  const snapshot = payload.snapshot || {};
  const time = payload.sourceSnapshotTime || snapshot.snapshotTime || snapshot.time;
  const date = isoDate(time);
  const identity = normalizeIdentity(payload);
  const symbol = safePart(identity.symbol, 'symbol');
  const expiry = safePart(identity.expiry, 'expiry');
  const tenor = safePart(identity.tenor, 'tenor');
  return `atm-straddle_${date}_${symbol}_${expiry}_${tenor}_${identityKey(identity)}.json`;
}

function buildPoint(payload = {}) {
  const snapshot = payload.snapshot || {};
  const time = payload.sourceSnapshotTime || snapshot.snapshotTime || snapshot.time;
  isoDate(time);
  return {
    time,
    atmStrike: toFiniteNumber(snapshot.atmStrike, 'atmStrike'),
    spot: toFiniteNumber(snapshot.referencePrice, 'spot'),
    straddlePts: toFiniteNumber(snapshot.straddle?.mid, 'straddlePts')
  };
}

function buildDocument(payload = {}, existing = null) {
  const snapshot = payload.snapshot || {};
  const point = buildPoint(payload);
  const date = isoDate(point.time);
  const identity = normalizeIdentity(payload);
  const nowIso = new Date().toISOString();
  const base = existing && typeof existing === 'object' ? existing : {};
  const pointsByTime = new Map();

  for (const row of Array.isArray(base.points) ? base.points : []) {
    if (row?.time) pointsByTime.set(String(row.time), row);
  }
  pointsByTime.set(String(point.time), point);

  const points = Array.from(pointsByTime.values())
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  return {
    kind: KIND,
    version: VERSION,
    date,
    identity,
    summary: {
      title: payload.title || 'Straddle ATM',
      expiry: snapshot.expiry || identity.expiry,
      dte: Number.isFinite(Number(snapshot.dte)) ? Number(snapshot.dte) : null,
      atmSelectionMethod: snapshot.atmSelectionMethod || null
    },
    updatedAt: nowIso,
    points
  };
}

function readExistingJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

function saveAtmStraddleSnapshot(directory, payload = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, atmStraddleSnapshotFileName(payload));
  const document = buildDocument(payload, readExistingJson(file));
  writeJsonAtomic(file, document);
  return {
    ok: true,
    file,
    directory,
    points: document.points.length
  };
}

async function saveAtmStraddleSnapshotAsync(directory, payload = {}) {
  await fs.promises.mkdir(directory, { recursive: true });
  const file = path.join(directory, atmStraddleSnapshotFileName(payload));
  const previous = writeQueues.get(file) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const existing = fs.existsSync(file) ? JSON.parse(await fs.promises.readFile(file, 'utf-8')) : null;
    const document = buildDocument(payload, existing);
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(document, null, 2), 'utf-8');
    await fs.promises.rename(tmp, file);
    return {
      ok: true,
      file,
      directory,
      points: document.points.length
    };
  });
  writeQueues.set(file, current);
  try {
    return await current;
  } finally {
    if (writeQueues.get(file) === current) writeQueues.delete(file);
  }
}

module.exports = {
  defaultAtmStraddleSnapshotDir,
  atmStraddleSnapshotFileName,
  saveAtmStraddleSnapshot,
  saveAtmStraddleSnapshotAsync
};
