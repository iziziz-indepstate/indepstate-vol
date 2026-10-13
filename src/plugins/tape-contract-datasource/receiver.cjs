const http = require('http');

const SCHEMA = 'tape.contract.csv.v1';
const KINDS = new Set(['tape', 'contract']);
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8124;

function text(value) {
  return String(value ?? '').trim();
}

function finiteNumber(value) {
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
    delta: finiteNumber(record.delta)
  };
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
  return kind === 'tape' ? normalizeTapeRecord(record) : normalizeContractRecord(record);
}

function dedupeKey(kind, record) {
  return kind === 'tape' ? tapeDedupeKey(record) : contractDedupeKey(record);
}

function createTapeContractStore({ now = () => new Date() } = {}) {
  const seen = {
    tape: new Set(),
    contract: new Set()
  };
  const pending = {
    tape: [],
    contract: []
  };
  const stats = {
    received: { tape: 0, contract: 0 },
    accepted: { tape: 0, contract: 0 },
    duplicate: { tape: 0, contract: 0 },
    rejected: 0,
    lastReceivedAt: null
  };

  function ingestEnvelope(envelope) {
    validateEnvelope(envelope);
    const kind = envelope.kind;
    let accepted = 0;
    let duplicate = 0;
    for (const sourceRecord of envelope.records) {
      stats.received[kind] += 1;
      const normalized = normalizeRecord(kind, sourceRecord);
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
        contract: pending.contract.length
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
        if (text(row.underlying).toUpperCase() === wantedUnderlying) selected.push(row);
        else remaining.push(row);
      }
      return { selected, remaining };
    };
    const tapeDrain = select(pending.tape);
    const contractDrain = select(pending.contract);
    pending.tape = tapeDrain.remaining;
    pending.contract = contractDrain.remaining;

    if (!tapeDrain.selected.length && !contractDrain.selected.length) {
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
        contract: pending.contract.length
      },
      seen: {
        tape: seen.tape.size,
        contract: seen.contract.size
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
  normalizeTapeRecord,
  parseMarketNumber,
  startTapeContractReceiver,
  tapeDedupeKey,
  validateEnvelope
};
