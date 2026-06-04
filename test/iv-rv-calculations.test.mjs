import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateIvRvSeries, resolveHorizon } from '../src/shared/iv-rv-calculations.mjs';

function rows(symbol, closes) {
  return closes.map((close, index) => ({
    date: `2026-01-${String(index + 1).padStart(2, '0')}`,
    symbol,
    close
  }));
}

test('resolves standard horizons to their IV symbols', () => {
  assert.deepEqual(resolveHorizon('9d'), { days: 9, label: '9d', ivSymbol: 'VIX9D' });
  assert.deepEqual(resolveHorizon('30d'), { days: 30, label: '30d', ivSymbol: 'VIX' });
});

test('calculates RMS realized volatility and aligned IV/RV ratios', () => {
  const spxRows = rows('SPX', [100, 101, 100, 102]);
  const ivRows = rows('CUSTOM', [10, 11, 12, 13]);
  const result = calculateIvRvSeries({
    spxRows,
    ivRows,
    horizon: '2d',
    annualizationFactor: 252
  });

  assert.equal(result.series.length, 2);
  const expectedRv = Math.sqrt((252 / 2) * (
    Math.log(100 / 101) ** 2 + Math.log(102 / 100) ** 2
  )) * 100;
  assert.ok(Math.abs(result.series.at(-1).rv - expectedRv) < 1e-10);
  assert.equal(result.series.at(-1).vol_spread, 13 - expectedRv);
  assert.ok(Math.abs(result.series.at(-1).variance_ratio - result.series.at(-1).vol_ratio ** 2) < 1e-12);
});

test('does not create ratios when realized volatility is zero', () => {
  const result = calculateIvRvSeries({
    spxRows: rows('SPX', [100, 100, 100]),
    ivRows: rows('CUSTOM', [10, 10, 10]),
    horizon: '2d'
  });

  assert.equal(result.series[0].vol_ratio, null);
  assert.equal(result.series[0].variance_ratio, null);
  assert.match(result.series[0].ratio_warning, /zero/i);
});
