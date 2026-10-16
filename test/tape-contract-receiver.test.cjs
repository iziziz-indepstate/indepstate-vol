const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA,
  attachTapeContractAtmPrice,
  contractDedupeKey,
  createTapeContractStore,
  normalizeContractRecord,
  normalizeAnalyticalRecord,
  normalizeTapeRecord,
  parseMarketNumber,
  startTapeContractReceiver,
  tapeDedupeKey
} = require('../src/plugins/tape-contract-datasource/receiver.cjs');

function quote(overrides = {}) {
  return { underlying: 'SPX', expiration: '2026-10-16', strike: 7750, call_put: 'CALL',
    timestamp: '2026-10-16T13:31:00Z', expiration_at: '2026-10-16T20:00:00Z',
    gamma: .01, gamma_unit: 'per_point', iv: .2, iv_unit: 'decimal',
    underlying_price: 7750, forward: 7751, quality: 'reliable', ...overrides };
}

test('gamma tape fields survive normalization without inferring gamma or aggressor', () => {
  const r = normalizeTapeRecord(tape({ gamma: '.012', executed_at: '2026-10-16T13:31:00Z',
    classification_quality: 'RELIABLE', complex_order_id: 'spread', iv: '20%' }));
  assert.equal(r.gamma, .012); assert.equal(r.gamma_unit, 'per_point');
  assert.equal(r.executed_at, '2026-10-16T13:31:00Z'); assert.equal(r.classification_quality, 'reliable');
  assert.equal(r.complex_order_id, 'spread'); assert.equal(r.iv, '20%');
  assert.equal(normalizeTapeRecord(tape()).gamma, null);
  assert.equal(normalizeTapeRecord(tape({ gamma: -1500, size_contracts: 10 })).gamma, -1500);
  assert.equal(normalizeTapeRecord(tape({ aggressor_buy_sell: '' })).aggressor_buy_sell, '');
});

test('quote versions dedupe by contract and timestamp, drain independently, and filter by underlying', () => {
  const store = createTapeContractStore();
  const payload = envelope('quote', [quote(), quote(), quote({ timestamp: '2026-10-16T13:32:00Z', gamma: .02 })]);
  const result = store.ingestEnvelope(payload);
  assert.equal(result.accepted, 2); assert.equal(result.duplicate, 1); assert.equal(result.pending.quote, 2);
  assert.equal(store.drainSnapshot({ underlying: 'SPY' }).noop, true);
  const s = store.drainSnapshot({ underlying: 'SPX' });
  assert.equal(s.quote.count, 2); assert.equal(s.tape.count, 0);
  assert.deepEqual(s.quote.records.map((r) => r.gamma), [.01, .02]);
  assert.equal(store.drainSnapshot().noop, true);
});

test('analytical records require explicit units, absolute timestamps and finite valid values; batch validation is atomic', () => {
  assert.equal(normalizeAnalyticalRecord('quote', quote({ underlying_price: undefined })).underlying_price, null);
  assert.equal(normalizeAnalyticalRecord('quote', quote({ underlying_price: 123 })).underlying_price, 123);
  for (const bad of [{ gamma: null }, { gamma: -1 }, { gamma_unit: 'notional' }, { iv_unit: '%' },
    { timestamp: '09:31:00' }, { expiration_at: '2026-10-16T13:00:00Z' }, { forward: 0 }, { quality: '' }]) {
    assert.throws(() => normalizeAnalyticalRecord('quote', quote(bad)), /Invalid/);
  }
  const store = createTapeContractStore();
  assert.throws(() => store.ingestEnvelope(envelope('quote', [quote(), quote({ gamma: null })])));
  assert.equal(store.stats().pending.quote, 0);
});

test('calibration accepts only historical comparable-surface evidence with an explicit window/context', () => {
  const row = { ...quote(), segment: 'atm', scope_key: '["dynamic",3]', gamma_mode: 'executed', option_types: 'total',
    window_start: '2026-10-16T13:30:00Z', window_end: '2026-10-16T13:31:00Z',
    historical: true, sample_count: 100, tod_start_minute: 570, tod_end_minute: 600,
    min_seconds_to_expiry: 0, max_seconds_to_expiry: 86400, iv_scale: .01, skew_scale: .02,
    activity_threshold: 1000, adjusted_iv_change: .001, comparable_iv_start: .2,
    comparable_iv_end: .201, comparison_method: 'constant_forward_moneyness_adjusted' };
  const store = createTapeContractStore();
  assert.equal(store.ingestEnvelope(envelope('calibration', [row, row])).accepted, 1);
  assert.equal(store.drainSnapshot().calibration.count, 1);
  for (const bad of [{ historical: false }, { iv_scale: 0 }, { skew_scale: -1 }, { sample_count: 0 },
    { comparison_method: 'fixed_strike' }, { scope_key: '' }, { window_end: '2026-10-16T13:32:00Z' },
    { tod_start_minute: null }, { min_seconds_to_expiry: null }, { iv_scale: 'bad' }, { comparable_iv_start: 0 }]) {
    assert.throws(() => normalizeAnalyticalRecord('calibration', { ...row, ...bad }), /Invalid/);
  }
});

function envelope(kind, records) {
  return {
    schema: SCHEMA,
    kind,
    sentAt: '2026-10-12T10:15:30.123Z',
    records
  };
}

function tape(overrides = {}) {
  return {
    timestamp: '09:31:20.000',
    timezone: 'America/New_York',
    underlying: 'spx',
    expiration: '2026-06-12',
    strike: '7400',
    call_put: 'call',
    size_contracts: '10',
    premium: '25000',
    aggressor_buy_sell: 'buy',
    trade_id_sequence: '',
    delta: '0.45',
    ...overrides
  };
}

test('normalizes records and builds stable dedupe keys', () => {
  const normalizedTape = normalizeTapeRecord(tape({ trade_id_sequence: 'abc' }));
  assert.equal(normalizedTape.underlying, 'SPX');
  assert.equal(normalizedTape.call_put, 'CALL');
  assert.equal(normalizedTape.size_contracts, 10);
  assert.equal(tapeDedupeKey(normalizedTape), 'tape:id:abc');
  assert.match(tapeDedupeKey(normalizeTapeRecord(tape())), /^tape:fallback\|09:31:20\.000\|SPX\|/);

  const normalizedContract = normalizeContractRecord({
    underlying: 'spx',
    expiration: '2026-09-01',
    strike: '7725',
    call_put: 'put'
  });
  assert.equal(contractDedupeKey(normalizedContract), 'contract|SPX|2026-09-01|7725|PUT');
});

test('parses formatted market numbers near tape datasource', () => {
  assert.equal(parseMarketNumber('$7,799.8'), 7799.8);
  assert.equal(parseMarketNumber('23.73%'), 23.73);
  assert.equal(parseMarketNumber(''), null);
  assert.equal(parseMarketNumber(null), null);
});

test('attaches ATM px from latest valid tape underlying price', () => {
  const snapshot = attachTapeContractAtmPrice({
    provider: 'tape-contract',
    tape: {
      records: [
        { underlying_price: '$7,799.8' },
        { underlying_price: '' },
        { underlying_price: '$7,801.2' }
      ]
    }
  });

  assert.equal(snapshot.px, 7801.2);
  assert.deepEqual(snapshot.atmSource, {
    provider: 'tape.underlying_price',
    warning: null
  });
});

test('store dedupes before drain and drains only new records', () => {
  const store = createTapeContractStore({ now: () => new Date('2026-10-12T10:20:00.000Z') });
  const first = store.ingestEnvelope(envelope('tape', [
    tape({ trade_id_sequence: 't-1', size_contracts: 10 }),
    tape({ trade_id_sequence: 't-1', size_contracts: 10 }),
    tape({ trade_id_sequence: 't-2', size_contracts: 5 })
  ]));

  assert.equal(first.accepted, 2);
  assert.equal(first.duplicate, 1);

  const snapshot = store.drainSnapshot();
  assert.equal(snapshot.noop, undefined);
  assert.equal(snapshot.tape.count, 2);
  assert.deepEqual(snapshot.tape.records.map((record) => record.trade_id_sequence), ['t-1', 't-2']);

  const empty = store.drainSnapshot();
  assert.equal(empty.noop, true);
  assert.equal(empty.stats.pending.tape, 0);
});

test('store filters drained records by underlying without losing other pending records', () => {
  const store = createTapeContractStore({ now: () => new Date('2026-10-12T10:20:00.000Z') });
  store.ingestEnvelope(envelope('tape', [
    tape({ trade_id_sequence: 'spx-1', underlying: 'SPX' }),
    tape({ trade_id_sequence: 'spy-1', underlying: 'SPY' })
  ]));

  const spx = store.drainSnapshot({ underlying: 'SPX' });
  assert.equal(spx.tape.count, 1);
  assert.equal(spx.tape.records[0].underlying, 'SPX');

  const spy = store.drainSnapshot({ underlying: 'SPY' });
  assert.equal(spy.tape.count, 1);
  assert.equal(spy.tape.records[0].underlying, 'SPY');
});

test('http receiver accepts valid batches and rejects invalid schema', async (t) => {
  const store = createTapeContractStore({ now: () => new Date('2026-10-12T10:20:00.000Z') });
  const server = startTapeContractReceiver({ store, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  try {
    let ok;
    try {
      ok = await fetch(`http://127.0.0.1:${port}/tape-contract/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope('tape', [tape({ trade_id_sequence: 'http-1' })]))
      });
    } catch (err) {
      if (err?.cause?.code === 'EACCES') {
        t.skip('Local loopback connection is blocked in this environment.');
        return;
      }
      throw err;
    }
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).accepted, 1);
    assert.equal(store.drainSnapshot().tape.count, 1);

    const acceptedQuote = await fetch(`http://127.0.0.1:${port}/tape-contract/batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope('quote', [quote()]))
    });
    assert.equal(acceptedQuote.status, 200);
    assert.equal((await acceptedQuote.json()).accepted, 1);
    assert.equal(store.drainSnapshot().quote.count, 1);
    const invalidQuote = await fetch(`http://127.0.0.1:${port}/tape-contract/batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope('quote', [quote({ iv_unit: '%' })]))
    });
    assert.equal(invalidQuote.status, 400);

    const bad = await fetch(`http://127.0.0.1:${port}/tape-contract/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...envelope('tape', []), schema: 'bad' })
    });
    assert.equal(bad.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
