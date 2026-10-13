const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA,
  attachTapeContractAtmPrice,
  contractDedupeKey,
  createTapeContractStore,
  normalizeContractRecord,
  normalizeTapeRecord,
  parseMarketNumber,
  startTapeContractReceiver,
  tapeDedupeKey
} = require('../src/plugins/tape-contract-datasource/receiver.cjs');

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
