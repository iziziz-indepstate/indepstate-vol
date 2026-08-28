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

function normalizedDateFilter(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const dt = new Date(raw);
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
}

function pointIsValid(point) {
  return point
    && !Number.isNaN(new Date(point.time || 0).getTime())
    && Number.isFinite(Number(point.atmStrike))
    && Number.isFinite(Number(point.spot))
    && Number.isFinite(Number(point.straddlePts));
}

function documentIsValid(document) {
  return document
    && document.kind === KIND
    && document.version === VERSION
    && /^\d{4}-\d{2}-\d{2}$/.test(String(document.date || ''))
    && document.identity
    && typeof document.identity === 'object'
    && Array.isArray(document.points);
}

function documentIdentitySignature(document) {
  return `${document.date}:${JSON.stringify(document.identity || {})}`;
}

function dedupeDocumentsByIdentity(documents) {
  const byIdentity = new Map();
  for (const document of documents) {
    byIdentity.set(documentIdentitySignature(document), document);
  }
  return Array.from(byIdentity.values());
}

function normalizeLoadedDocument(document, file) {
  const points = document.points
    .filter(pointIsValid)
    .map((point) => ({
      time: point.time,
      atmStrike: Number(point.atmStrike),
      spot: Number(point.spot),
      straddlePts: Number(point.straddlePts)
    }))
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  return {
    kind: document.kind,
    version: document.version,
    date: document.date,
    identity: { ...(document.identity || {}) },
    summary: document.summary && typeof document.summary === 'object' ? { ...document.summary } : {},
    updatedAt: document.updatedAt || null,
    points,
    source: {
      file,
      filename: path.basename(file)
    }
  };
}

function loadAtmStraddleSnapshots(directory, params = {}) {
  const warnings = [];
  const documents = [];
  const tenor = String(params.tenor || '').trim();
  const startDate = normalizedDateFilter(params.startDate);
  const endDate = normalizedDateFilter(params.endDate);

  if (!fs.existsSync(directory)) {
    return { ok: true, directory, documents, warnings };
  }

  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    try {
      const document = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!documentIsValid(document)) {
        warnings.push({ file, message: 'Skipped invalid ATM straddle snapshot document.' });
        continue;
      }
      if (tenor && String(document.identity?.tenor || '') !== tenor) continue;
      if (startDate && document.date < startDate) continue;
      if (endDate && document.date > endDate) continue;
      documents.push(normalizeLoadedDocument(document, file));
    } catch (err) {
      warnings.push({ file, message: err?.message || String(err) });
    }
  }

  const deduped = dedupeDocumentsByIdentity(documents);
  deduped.sort((a, b) => {
    const byDate = String(a.date).localeCompare(String(b.date));
    if (byDate) return byDate;
    return String(a.source?.filename || '').localeCompare(String(b.source?.filename || ''));
  });

  return { ok: true, directory, documents: deduped, warnings };
}

async function loadAtmStraddleSnapshotsAsync(directory, params = {}) {
  const warnings = [];
  const documents = [];
  const tenor = String(params.tenor || '').trim();
  const startDate = normalizedDateFilter(params.startDate);
  const endDate = normalizedDateFilter(params.endDate);

  try {
    await fs.promises.access(directory, fs.constants.R_OK);
  } catch (_err) {
    return { ok: true, directory, documents, warnings };
  }

  const entries = (await fs.promises.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    try {
      const document = JSON.parse(await fs.promises.readFile(file, 'utf-8'));
      if (!documentIsValid(document)) {
        warnings.push({ file, message: 'Skipped invalid ATM straddle snapshot document.' });
        continue;
      }
      if (tenor && String(document.identity?.tenor || '') !== tenor) continue;
      if (startDate && document.date < startDate) continue;
      if (endDate && document.date > endDate) continue;
      documents.push(normalizeLoadedDocument(document, file));
    } catch (err) {
      warnings.push({ file, message: err?.message || String(err) });
    }
  }

  const deduped = dedupeDocumentsByIdentity(documents);
  deduped.sort((a, b) => {
    const byDate = String(a.date).localeCompare(String(b.date));
    if (byDate) return byDate;
    return String(a.source?.filename || '').localeCompare(String(b.source?.filename || ''));
  });

  return { ok: true, directory, documents: deduped, warnings };
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
  loadAtmStraddleSnapshots,
  loadAtmStraddleSnapshotsAsync,
  saveAtmStraddleSnapshot,
  saveAtmStraddleSnapshotAsync
};
