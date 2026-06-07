import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfiguredStrike } from '../src/shared/option-chain-utils.js';
import { nDateSkewPutWidget } from '../src/renderer/widgets/ndate-put-skew-widget.js';

test('resolves configured ATM strike from underlying reference price', () => {
  assert.deepEqual(
    resolveConfiguredStrike([95, 100, 105, 110], 'ATM', { underlyingPrice: 103 }),
    { strike: 105, mode: 'atm' }
  );
});

test('nDate put skew accepts ATM as the base strike control value', () => {
  const series = nDateSkewPutWidget.buildSnapshotSeries({
    px: 103,
    putStrikesAsc: [95, 100, 105, 110],
    putBidIvByStrike: {
      95: 0.30,
      100: 0.25,
      105: 0.22,
      110: 0.20
    }
  }, {
    config: {
      baseStrike: 'ATM',
      strikeRange: 1
    }
  });

  assert.deepEqual(series.labels, ['100']);
  assert.deepEqual(series.values, [0.25]);
});
