const fs = require('fs');
const path = require('path');

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      values.push(value.trim());
      value = '';
    } else {
      value += char;
    }
  }
  values.push(value.trim());
  return values;
}

function parseCsv(raw) {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map((header) => header.trim().replace(/^\uFEFF/, '').toLowerCase());

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

function loadLocalMarketSeries(source) {
  const normalizedSource = String(source || '').trim();
  if (!normalizedSource) {
    throw new Error('Local market data source not found: (empty)');
  }

  const file = path.resolve(normalizedSource);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`Local market data source not found: ${normalizedSource}`);
  }

  const extension = path.extname(file).toLowerCase();
  const raw = fs.readFileSync(file, 'utf-8');
  if (extension === '.csv') return parseCsv(raw);
  if (extension === '.json') {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('JSON market data source must contain an array');
    return data;
  }

  throw new Error(`Unsupported local market data format: ${extension || '(none)'}. Use CSV or JSON.`);
}

module.exports = { loadLocalMarketSeries };
