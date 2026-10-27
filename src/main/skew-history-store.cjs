const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const queues = new Map();
const kind = 'multi-expiry-skew-history';
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const defaultSkewHistoryDir = (app) => path.join(app.getPath('documents'), 'IS-VOL', 'Data', 'Skew');
function identityOf(value) {
  if (!value?.dataSourceId || !value?.symbol || !/^\d{8}$/.test(value?.expiration || '')
    || !Number.isFinite(value?.targetDelta) || value.targetDelta < 0.01 || value.targetDelta > 0.49) throw new Error('Invalid skew history identity');
  return { dataSourceId: String(value.dataSourceId), symbol: String(value.symbol), expiration: value.expiration, targetDelta: value.targetDelta };
}
const keyOf = (identity) => JSON.stringify(identityOf(identity));
function dateOf(timestamp) {
  const parts = Object.fromEntries(dateFormatter.formatToParts(new Date(timestamp)).map((p) => [p.type, p.value]));
  return `${parts.year}${parts.month}${parts.day}`;
}
function validPoint(p) {
  return p && Number.isFinite(Date.parse(p.timestamp)) && (p.skew === null || Number.isFinite(p.skew))
    && ['put', 'call'].every((side) => p[side] == null ||
      ((p[side].iv === null || Number.isFinite(p[side].iv)) && Array.isArray(p[side].contracts)
        && p[side].contracts.every((q) => q && ['delta', 'strike', 'iv'].every((key) => Number.isFinite(q[key])))));
}
function validDocument(document) {
  return document?.kind === kind && document.version === 1 && /^\d{8}$/.test(document.date)
    && Array.isArray(document.points) && document.points.every((p) => validPoint(p) && dateOf(p.timestamp) === document.date);
}
async function saveSkewHistory(directory, payload) {
  const identity = identityOf(payload.identity);
  const groups = new Map();
  for (const point of payload.points || []) {
    if (!validPoint(point)) throw new Error('Invalid skew history point');
    const date = dateOf(point.timestamp);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(point);
  }
  await fs.mkdir(directory, { recursive: true });
  for (const [date, points] of groups) {
    const hash = crypto.createHash('sha256').update(keyOf(identity)).digest('hex').slice(0, 24);
    const file = path.join(directory, `skew_${date}_${identity.expiration}_${hash}.json`);
    const operation = (queues.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
      let existing;
      try { existing = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (existing && (!validDocument(existing) || keyOf(existing.identity) !== keyOf(identity))) throw new Error('Invalid existing skew history document');
      const merged = new Map((existing?.points || []).map((p) => [Date.parse(p.timestamp), p]));
      for (const p of points) {
        const t = Date.parse(p.timestamp);
        if (!merged.has(t) || Number.isFinite(p.skew) || !Number.isFinite(merged.get(t).skew)) merged.set(t, p);
      }
      const document = { kind, version: 1, date, identity, updatedAt: new Date().toISOString(),
        points: [...merged.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)) };
      await fs.writeFile(`${file}.tmp`, JSON.stringify(document), 'utf8');
      await fs.rename(`${file}.tmp`, file);
    });
    queues.set(file, operation);
    try { await operation; } finally { if (queues.get(file) === operation) queues.delete(file); }
  }
  return { ok: true };
}
async function loadSkewHistory(directory, params) {
  const key = keyOf(params.identity);
  const documents = [], warnings = [];
  let entries;
  try { entries = await fs.readdir(directory); } catch (err) { if (err.code === 'ENOENT') return { ok: true, documents, warnings }; throw err; }
  for (const filename of entries.filter((name) => name.endsWith('.json')).sort()) {
    try {
      const document = JSON.parse(await fs.readFile(path.join(directory, filename), 'utf8'));
      if (!validDocument(document)) throw new Error('Invalid skew history document');
      if (keyOf(document.identity) !== key) continue;
      if (params.startDate && document.date < params.startDate.replaceAll('-', '')) continue;
      if (params.endDate && document.date > params.endDate.replaceAll('-', '')) continue;
      documents.push(document);
    } catch (err) { warnings.push({ file: filename, message: err.message }); }
  }
  return { ok: true, documents, warnings };
}
module.exports = { defaultSkewHistoryDir, saveSkewHistory, loadSkewHistory };
