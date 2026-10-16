const http = require('http');

const SCHEMA = 'tape.contract.csv.v1';
const KINDS = new Set(['tape', 'contract', 'quote', 'calibration']);
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8124;

function text(value) {
  return String(value ?? '').trim();
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseMarketNumber(value) {
  const normalized = typeof value === 'string' ? value.trim().replace(/[$,%\s]/g, '') : value;
  if (normalized == null || normalized === '') return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function normalizeTapeRecord(record = {}) {
  return {
    timestamp: text(record.timestamp),
    timezone: text(record.timezone),
    underlying: text(record.underlying).toUpperCase(),
    expiration: text(record.expiration),
    strike: finiteNumber(record.strike),
    call_put: text(record.call_put).toUpperCase(),
    trade_price: record.trade_price ?? '',
    size_contracts: finiteNumber(record.size_contracts),
    premium: finiteNumber(record.premium),
    bid: record.bid ?? '',
    ask: record.ask ?? '',
    mid: record.mid ?? '',
    underlying_price: record.underlying_price ?? '',
    aggressor_buy_sell: text(record.aggressor_buy_sell).toUpperCase(),
    condition_flag: record.condition_flag ?? '',
    trade_id_sequence: text(record.trade_id_sequence),
    complex_order_id: record.complex_order_id ?? '',
    exchange: record.exchange ?? '',
    iv: record.iv ?? '',
    gamma: finiteNumber(record.gamma),
    gamma_unit: text(record.gamma_unit || 'per_point'),
    executed_at: text(record.executed_at),
    classification_quality: text(record.classification_quality || 'unknown').toLowerCase(),
    delta: finiteNumber(record.delta)
  };
}

function absoluteTime(value) {
  return typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

// New analytical records have explicit units and timestamps; legacy tape remains accepted.
function normalizeAnalyticalRecord(kind, record = {}) {
  const out = {
    underlying: text(record.underlying).toUpperCase(),
    expiration: text(record.expiration),
    timestamp: text(record.timestamp),
    expiration_at: text(record.expiration_at),
    quality: text(record.quality).toLowerCase()
  };
  if (!['SPX', 'SPXW'].includes(out.underlying) || !validDate(out.expiration)
    || !absoluteTime(out.timestamp) || !absoluteTime(out.expiration_at)
    || Date.parse(out.expiration_at) <= Date.parse(out.timestamp)
    || !['reliable', 'unreliable', 'unknown'].includes(out.quality)) {
    throw new Error(`Invalid ${kind} identity, timestamps or quality`);
  }
  const expiryDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(out.expiration_at));
  if (expiryDate !== out.expiration) throw new Error('Invalid expiration_at date');
  if (kind === 'quote') {
    Object.assign(out, {
      strike: finiteNumber(record.strike), call_put: text(record.call_put).toUpperCase(),
      gamma: finiteNumber(record.gamma), gamma_unit: record.gamma_unit,
      iv: finiteNumber(record.iv), iv_unit: record.iv_unit,
      underlying_price: finiteNumber(record.underlying_price), forward: finiteNumber(record.forward)
    });
    if (!(out.strike > 0) || !['CALL', 'PUT'].includes(out.call_put)
      || !(out.gamma >= 0) || out.gamma == null || out.gamma_unit !== 'per_point'
      || !(out.iv > 0) || out.iv_unit !== 'decimal'
      || (record.underlying_price != null && record.underlying_price !== '' && !(out.underlying_price > 0))
      || !(out.forward > 0)) throw new Error('Invalid quote values or units');
  } else {
    Object.assign(out, {
      scope_key: text(record.scope_key), gamma_mode: text(record.gamma_mode),
      option_types: text(record.option_types), segment: text(record.segment),
      window_start: text(record.window_start), window_end: text(record.window_end),
      iv_unit: record.iv_unit, historical: record.historical === true,
      sample_count: finiteNumber(record.sample_count),
      tod_start_minute: finiteNumber(record.tod_start_minute), tod_end_minute: finiteNumber(record.tod_end_minute),
      min_seconds_to_expiry: finiteNumber(record.min_seconds_to_expiry), max_seconds_to_expiry: finiteNumber(record.max_seconds_to_expiry),
      iv_scale: finiteNumber(record.iv_scale), skew_scale: finiteNumber(record.skew_scale),
      activity_threshold: finiteNumber(record.activity_threshold),
      adjusted_iv_change: finiteNumber(record.adjusted_iv_change),
      comparable_iv_start: finiteNumber(record.comparable_iv_start), comparable_iv_end: finiteNumber(record.comparable_iv_end),
      comparison_method: text(record.comparison_method)
    });
    if (!out.scope_key || !['executed', 'revalued'].includes(out.gamma_mode)
      || !['total', 'call', 'put'].includes(out.option_types)
      || !['downside', 'atm', 'upside'].includes(out.segment)
      || !absoluteTime(out.window_start) || !absoluteTime(out.window_end)
      || Date.parse(out.window_start) >= Date.parse(out.window_end)
      || Date.parse(out.window_end) > Date.parse(out.timestamp)
      || out.iv_unit !== 'decimal' || !out.historical || !(out.sample_count > 0)
      || out.tod_start_minute == null || out.tod_end_minute == null
      || !(out.tod_start_minute >= 0) || !(out.tod_end_minute <= 1440) || !(out.tod_end_minute > out.tod_start_minute)
      || out.min_seconds_to_expiry == null || out.max_seconds_to_expiry == null
      || !(out.min_seconds_to_expiry >= 0) || !(out.max_seconds_to_expiry > out.min_seconds_to_expiry)
      || (out.iv_scale != null && !(out.iv_scale > 0)) || (out.skew_scale != null && !(out.skew_scale > 0))
      || (out.activity_threshold != null && out.activity_threshold < 0)
      || out.comparison_method !== 'constant_forward_moneyness_adjusted') throw new Error('Invalid calibration context or units');
    for (const name of ['iv_scale', 'skew_scale', 'activity_threshold', 'adjusted_iv_change', 'comparable_iv_start', 'comparable_iv_end']) {
      if (record[name] != null && record[name] !== '' && out[name] == null) throw new Error(`Invalid calibration ${name}`);
    }
    if ((out.comparable_iv_start != null && !(out.comparable_iv_start > 0))
      || (out.comparable_iv_end != null && !(out.comparable_iv_end > 0))) throw new Error('Invalid comparable IV');
  }
  return out;
}

function normalizeContractRecord(record = {}) {
  return {
    underlying: text(record.underlying).toUpperCase(),
    expiration: text(record.expiration),
    strike: finiteNumber(record.strike),
    call_put: text(record.call_put).toUpperCase(),
    oi: finiteNumber(record.oi),
    total_premium: finiteNumber(record.total_premium),
    total_volume: finiteNumber(record.total_volume),
    delta_notional: finiteNumber(record.delta_notional),
    gamma_notional: finiteNumber(record.gamma_notional),
    vega_notional: finiteNumber(record.vega_notional)
  };
}

function tapeDedupeKey(record = {}) {
  const id = text(record.trade_id_sequence);
  if (id) return `tape:id:${id}`;
  return [
    'tape:fallback',
    text(record.timestamp),
    text(record.underlying).toUpperCase(),
    text(record.expiration),
    text(record.strike),
    text(record.call_put).toUpperCase(),
    text(record.size_contracts),
    text(record.premium),
    text(record.aggressor_buy_sell).toUpperCase()
  ].join('|');
}

function contractDedupeKey(record = {}) {
  return [
    'contract',
    text(record.underlying).toUpperCase(),
    text(record.expiration),
    text(record.strike),
    text(record.call_put).toUpperCase()
  ].join('|');
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('Envelope must be an object');
  }
  if (envelope.schema !== SCHEMA) throw new Error(`Unsupported schema: ${envelope.schema || '(missing)'}`);
  if (!KINDS.has(envelope.kind)) throw new Error(`Unsupported kind: ${envelope.kind || '(missing)'}`);
  const sentAt = new Date(envelope.sentAt);
  if (!envelope.sentAt || Number.isNaN(sentAt.getTime())) throw new Error('sentAt must be a valid ISO timestamp');
  if (!Array.isArray(envelope.records)) throw new Error('records must be an array');
  return true;
}

function normalizeRecord(kind, record) {
  if (kind === 'quote' || kind === 'calibration') return normalizeAnalyticalRecord(kind, record);
  return kind === 'tape' ? normalizeTapeRecord(record) : normalizeContractRecord(record);
}

function dedupeKey(kind, record) {
  if (kind === 'quote') return `${contractDedupeKey(record)}|${record.timestamp}`;
  if (kind === 'calibration') return `calibration|${JSON.stringify(record)}`;
  return kind === 'tape' ? tapeDedupeKey(record) : contractDedupeKey(record);
}

function createTapeContractStore({ now = () => new Date() } = {}) {
  const seen = {
    tape: new Set(), contract: new Set(), quote: new Set(), calibration: new Set()
  };
  const pending = {
    tape: [], contract: [], quote: [], calibration: []
  };
  const stats = {
    received: { tape: 0, contract: 0, quote: 0, calibration: 0 },
    accepted: { tape: 0, contract: 0, quote: 0, calibration: 0 },
    duplicate: { tape: 0, contract: 0, quote: 0, calibration: 0 },
    rejected: 0,
    lastReceivedAt: null
  };

  function ingestEnvelope(envelope) {
    validateEnvelope(envelope);
    const kind = envelope.kind;
    let accepted = 0;
    let duplicate = 0;
    // Validate the whole batch before accepting any records.
    const normalizedRecords = envelope.records.map((record) => normalizeRecord(kind, record));
    for (const normalized of normalizedRecords) {
      stats.received[kind] += 1;
      const key = dedupeKey(kind, normalized);
      if (seen[kind].has(key)) {
        duplicate += 1;
        stats.duplicate[kind] += 1;
        continue;
      }
      seen[kind].add(key);
      pending[kind].push({
        ...normalized,
        _dedupeKey: key,
        _receivedAt: now().toISOString(),
        _sentAt: envelope.sentAt
      });
      accepted += 1;
      stats.accepted[kind] += 1;
    }
    stats.lastReceivedAt = now().toISOString();
    return {
      ok: true,
      schema: SCHEMA,
      kind,
      received: envelope.records.length,
      accepted,
      duplicate,
      pending: {
        tape: pending.tape.length,
        contract: pending.contract.length,
        quote: pending.quote.length,
        calibration: pending.calibration.length
      }
    };
  }

  function reject() {
    stats.rejected += 1;
  }

  function drainSnapshot({ underlying } = {}) {
    const wantedUnderlying = text(underlying).toUpperCase();
    const select = (rows) => {
      if (!wantedUnderlying) return { selected: rows, remaining: [] };
      const selected = [];
      const remaining = [];
      for (const row of rows) {
        const actual = text(row.underlying).toUpperCase();
        const spxAlias = ['SPX', 'SPXW'].includes(actual) && ['SPX', 'SPXW'].includes(wantedUnderlying);
        if (actual === wantedUnderlying || spxAlias) selected.push(row);
        else remaining.push(row);
      }
      return { selected, remaining };
    };
    const tapeDrain = select(pending.tape);
    const contractDrain = select(pending.contract);
    const quoteDrain = select(pending.quote);
    const calibrationDrain = select(pending.calibration);
    pending.tape = tapeDrain.remaining;
    pending.contract = contractDrain.remaining;
    pending.quote = quoteDrain.remaining;
    pending.calibration = calibrationDrain.remaining;

    if (!tapeDrain.selected.length && !contractDrain.selected.length && !quoteDrain.selected.length && !calibrationDrain.selected.length) {
      return {
        noop: true,
        provider: 'tape-contract',
        schema: SCHEMA,
        time: now().toISOString(),
        stats: snapshotStats()
      };
    }

    return {
      provider: 'tape-contract',
      schema: SCHEMA,
      time: now().toISOString(),
      underlying: wantedUnderlying || null,
      tape: {
        records: tapeDrain.selected,
        count: tapeDrain.selected.length
      },
      contract: {
        records: contractDrain.selected,
        count: contractDrain.selected.length
      },
      quote: { records: quoteDrain.selected, count: quoteDrain.selected.length },
      calibration: { records: calibrationDrain.selected, count: calibrationDrain.selected.length },
      stats: snapshotStats()
    };
  }

  function snapshotStats() {
    return {
      received: { ...stats.received },
      accepted: { ...stats.accepted },
      duplicate: { ...stats.duplicate },
      rejected: stats.rejected,
      pending: {
        tape: pending.tape.length,
        contract: pending.contract.length,
        quote: pending.quote.length,
        calibration: pending.calibration.length
      },
      seen: {
        tape: seen.tape.size,
        contract: seen.contract.size,
        quote: seen.quote.size,
        calibration: seen.calibration.size
      },
      lastReceivedAt: stats.lastReceivedAt
    };
  }

  return {
    ingestEnvelope,
    drainSnapshot,
    reject,
    stats: snapshotStats
  };
}

function readRequestBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const raw = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(raw)
  });
  res.end(raw);
}

function startTapeContractReceiver({ store, host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  const activeStore = store || createTapeContractStore();
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/tape-contract/batch') {
      sendJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }
    try {
      const body = await readRequestBody(req);
      const envelope = JSON.parse(body);
      sendJson(res, 200, activeStore.ingestEnvelope(envelope));
    } catch (err) {
      activeStore.reject();
      sendJson(res, 400, { ok: false, error: err?.message || String(err) });
    }
  });

  server.listen(port, host);
  return server;
}

function attachTapeContractAtmPrice(snapshot) {
  if (snapshot?.noop) return snapshot;
  const records = Array.isArray(snapshot?.tape?.records) ? snapshot.tape.records : [];
  const prices = records
    .map((record) => parseMarketNumber(record?.underlying_price))
    .filter((value) => Number.isFinite(value) && value > 0);
  const px = prices.at(-1) ?? null;
  snapshot.px = px;
  snapshot.atmSource = {
    provider: 'tape.underlying_price',
    warning: px == null ? 'No valid underlying_price in drained tape records.' : null
  };
  return snapshot;
}

module.exports = {
  SCHEMA,
  DEFAULT_HOST,
  DEFAULT_PORT,
  attachTapeContractAtmPrice,
  contractDedupeKey,
  createTapeContractStore,
  normalizeContractRecord,
  normalizeAnalyticalRecord,
  normalizeTapeRecord,
  parseMarketNumber,
  startTapeContractReceiver,
  tapeDedupeKey,
  validateEnvelope
};
