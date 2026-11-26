import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateVixeqDynamics, getVixeqRegimeObservations, VIXEQ_METRICS } from '../src/shared/vixeq-dynamics-calculations.mjs';
import {
  classifyCombinedState, classifyDiversification, classifyLevel, classifyMomentum, classifyRiskEnvironment,
  classifyRiskResponse, classifyStressDynamics, evaluateVolatilityRegime
} from '../src/shared/volatility-regime-engine.mjs';
import { REGIME_RULES } from '../src/shared/volatility-regime-rules.mjs';
import { selectRegimeResponse } from '../src/renderer/widgets/volatility-regime-panel.js';

test('classifies the exact boundaries and uses configurable thresholds', () => {
  const cases = [
    [classifyLevel, 'z', [[-2, 'VERY_LOW'], [-1.999, 'LOW'], [-1, 'LOW'], [-0.999, 'NORMAL'],
      [0.999, 'NORMAL'], [1, 'ELEVATED'], [1.999, 'ELEVATED'], [2, 'EXTREME']]],
    [classifyMomentum, 'momentum', [[-0.5, 'FALLING'], [-0.499, 'STABLE'], [0.499, 'STABLE'], [0.5, 'RISING']]],
    [classifyRiskResponse, 'z', [[-4, 'EXTREME_RELIEF_RESPONSE'], [-3.999, 'RELIEF_RESPONSE'], [-3, 'RELIEF_RESPONSE'],
      [-2.999, 'NORMAL_RESPONSE'], [2.999, 'NORMAL_RESPONSE'], [3, 'STRESS_RESPONSE'],
      [3.999, 'STRESS_RESPONSE'], [4, 'EXTREME_STRESS_RESPONSE']]]
  ];
  for (const [classify, key, values] of cases) {
    for (const [value, expected] of [...values, [null, 'UNKNOWN'], [NaN, 'UNKNOWN']]) {
      assert.equal(classify({ [key]: value }).id, expected);
    }
  }
  const custom = { ...REGIME_RULES, thresholds: { ...REGIME_RULES.thresholds, momentum: [-1, 1] } };
  assert.equal(classifyMomentum({ momentum: 0.5 }, custom).id, 'STABLE');
});

test('uses every row in the risk environment and stress tables in priority order', () => {
  const levelCases = [
    [[2, 1, 3], 'SYSTEMIC_STRESS'], [[2, 0, 3], 'SYSTEMIC_RISK'], [[2, 1, 0], 'INDEX_VOL_RISK'],
    [[0, 2, 2], 'FRAGILE_INDEX'], [[0, 2, 0], 'DISPERSION_RISK'], [[0, 0, 2], 'CORRELATION_RISK'],
    [[-2, -1, -2], 'CALM'], [[-2, 0, 0], 'MIXED_NORMAL'], [[2, null, 2], 'UNKNOWN']
  ];
  for (const [[vix, vixeq, cor1m], expected] of levelCases) {
    assert.equal(classifyRiskEnvironment({
      vix: classifyLevel({ z: vix }), vixeq: classifyLevel({ z: vixeq }), cor1m: classifyLevel({ z: cor1m })
    }).id, expected);
  }
  const stressCases = [
    [[1, 1, 1], 'SYNCHRONIZED_VOL_EXPANSION'], [[0, 1, 1], 'SYSTEMIC_ESCALATION'],
    [[1, 0, -1], 'DISPERSION_BUILDUP'], [[-1, 1, 0], 'INDEX_RISK_REPRICING'], [[0, -1, -1], 'SYSTEMIC_RELIEF'],
    [[-1, -1, -1], 'BROAD_NORMALIZATION'], [[-1, -1, 0], 'CONSTITUENT_RELIEF'],
    [[0, 0, 0], 'STABLE'], [[0, -1, 1], 'MIXED_TRANSITION'], [[null, 1, 1], 'UNKNOWN']
  ];
  for (const [[vixeq, vix, cor1m], expected] of stressCases) {
    assert.equal(classifyStressDynamics({
      vixeq: classifyMomentum({ momentum: vixeq }), vix: classifyMomentum({ momentum: vix }),
      cor1m: classifyMomentum({ momentum: cor1m }), spread: classifyMomentum({ momentum: null })
    }).id, expected);
  }
});

test('covers all diversification and combined states', () => {
  for (const [level, z] of [['LOW', -1], ['NORMAL', 0], ['HIGH', 2]]) {
    for (const [direction, value] of [['FALLING', -1], ['STABLE', 0], ['RISING', 1]]) {
      assert.equal(classifyDiversification(classifyLevel({ z }), classifyMomentum({ momentum: value })).id,
        `DIVERSIFICATION_${level}_${direction}`);
    }
  }
  for (const [environment, codes] of [
    ['CALM', ['VOLATILITY_COMPRESSION', 'NORMAL_MARKET', 'EMERGING_STRESS']],
    ['INDEX_VOL_RISK', ['ACUTE_RELIEF_ELEVATED_RISK', 'ELEVATED_RISK_NORMAL_RESPONSE', 'ACUTE_STRESS']]
  ]) {
    for (const [index, z] of [-4, 0, 4].entries()) {
      assert.equal(classifyCombinedState({ id: environment }, classifyRiskResponse({ z })).id, codes[index]);
    }
  }
});

const date = '2026-11-24';
const metricMap = (value) => Object.fromEntries(VIXEQ_METRICS.map((key) => [key, value]));
const fresh = { provider: 'cboe', latestDate: date };

function input({ z = 2, residualZ = 0 } = {}) {
  const observation = { count: 252, sigma: 1 };
  return {
    latest: { date, ...metricMap(30), zScore: metricMap(z),
      change5: { vixeq: 0, vix: -2, cor1m: -2, spread: 2 }, change20: { vixeq: 0, vix: 2, cor1m: 2, spread: -2 } },
    sources: metricMap(fresh),
    regimeObservations: { levels: metricMap(observation), momentum: { 5: metricMap(observation), 20: metricMap(observation) } },
    response: { status: 'partial', latest: { date: '2026-11-25' }, series: [
      { date, spxReturn: -1, actualChange: residualZ, expectedChange: 0, residual: residualZ,
        residualBands: { sigma: 1 }, standardizedResidual: residualZ }
    ], sources: { spx: fresh, vix: fresh } }, responseWidgetId: 'producer'
  };
}

test('keeps risk levels, horizon changes and same-date response distinct', () => {
  const high = evaluateVolatilityRegime(input());
  assert.equal(high.risk_environment.id, 'SYSTEMIC_STRESS');
  assert.equal(high.risk_response.id, 'NORMAL_RESPONSE');
  assert.equal(high.combined_state.id, 'ELEVATED_RISK_NORMAL_RESPONSE');
  assert.equal(high.stress_dynamics_5d.id, 'SYSTEMIC_RELIEF');
  assert.equal(high.stress_dynamics_20d.id, 'SYSTEMIC_ESCALATION');
  assert.equal(high.diversification_state.id, 'DIVERSIFICATION_HIGH_RISING');
  assert.equal(high.risk_management_implications[0].regime_id, high.combined_state.id);
  assert.equal(high.matched_rule_ids.combined_state, 'combined_state.ELEVATED_RISK_NORMAL_RESPONSE');
  assert.equal(high.data_quality.status, 'ok');
  assert.ok(Object.values(high.extreme_metric_flags).every(Boolean));
  const low = evaluateVolatilityRegime(input({ z: -2, residualZ: 4 }));
  assert.equal(low.risk_environment.id, 'CALM');
  assert.equal(low.risk_response.id, 'EXTREME_STRESS_RESPONSE');
  assert.equal(low.combined_state.id, 'EMERGING_STRESS');
  const sameSpread = input();
  sameSpread.latest.change5 = { vixeq: 2, vix: 2, cor1m: 2, spread: 0 };
  assert.equal(evaluateVolatilityRegime(sameSpread).stress_dynamics_5d.id, 'SYNCHRONIZED_VOL_EXPANSION');
  for (const z of [-2, 0, 2]) {
    for (const residualZ of [-4, -3, 0, 3, 4]) {
      assert.equal(evaluateVolatilityRegime(input({ z, residualZ })).directional_bias, 'UNDETERMINED');
    }
  }
  assert.equal(evaluateVolatilityRegime({}).directional_bias, 'UNDETERMINED');
});

test('isolates missing, stale, misaligned and degenerate inputs', () => {
  const missing = input();
  missing.response = null;
  const independent = evaluateVolatilityRegime(missing);
  assert.equal(independent.risk_environment.id, 'SYSTEMIC_STRESS');
  assert.equal(independent.combined_state.id, 'UNKNOWN');
  assert.equal(independent.data_quality.response, 'missing_response_widget');
  const bad = input();
  bad.sources.vixeq = { ...fresh, stale: true };
  bad.response.series[0].residualBands.sigma = 0;
  bad.regimeObservations.levels.cor1m = { count: 251, sigma: null };
  bad.regimeObservations.momentum[20].cor1m = { count: 252, sigma: 0 };
  const invalid = evaluateVolatilityRegime(bad);
  assert.equal(invalid.risk_environment.id, 'UNKNOWN');
  assert.equal(invalid.risk_response.id, 'UNKNOWN');
  assert.equal(invalid.metric_levels.vix.id, 'EXTREME');
  assert.equal(invalid.data_quality.metric_levels.spread, 'stale_source');
  assert.equal(invalid.data_quality.metric_levels.cor1m, 'insufficient_history');
  assert.equal(invalid.data_quality.momentum_20d.cor1m, 'zero_standard_deviation');
  assert.equal(invalid.data_quality.response, 'zero_standard_deviation');
  bad.response.series = [];
  assert.equal(evaluateVolatilityRegime(bad).data_quality.response, 'misaligned_session');
  bad.response.sources.spx = { ...fresh, stale: true };
  assert.equal(evaluateVolatilityRegime(bad).data_quality.response, 'stale_source');
});

test('historical denominators use prior valid observations only and skip gaps without compressing sessions', () => {
  const sessions = Array.from({ length: 340 }, (_, i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10));
  const histories = Object.fromEntries(['vixeq', 'vix', 'cor1m'].map((key, offset) => [key,
    sessions.map((day, i) => ({ date: day, close: 30 + offset + 3 * Math.sin(i / (6 + offset)) }))]));
  histories.vix[270].close = null;
  const rows = calculateVixeqDynamics(sessions, histories);
  const index = 300;
  const baseline = getVixeqRegimeObservations(rows, index);
  assert.equal(baseline.levels.vix.count, 251);
  assert.equal(baseline.momentum[20].vix.count, 252);
  assert.equal(rows[290].change20.vix, null);
  assert.equal(rows[index].zScore.vix, null);
  const valid = rows.slice(0, index).map(({ change20 }) => change20.vix).filter(Number.isFinite).slice(-252);
  const mean = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  const sigma = Math.sqrt(valid.reduce((sum, value) => sum + (value - mean) ** 2, 0) / valid.length);
  assert.ok(Math.abs(baseline.momentum[20].vix.sigma - sigma) < 1e-12);
  for (const bar of histories.vix.slice(index)) bar.close += 10;
  const changed = calculateVixeqDynamics(sessions, histories);
  assert.deepEqual(getVixeqRegimeObservations(changed, index), baseline);
  assert.notEqual(changed[index].change20.vix, rows[index].change20.vix);
  assert.deepEqual(getVixeqRegimeObservations(changed.slice(0, index + 1)), baseline);
});

test('chooses a same-tab response unambiguously and handles an unavailable selection', () => {
  const one = { type: 'vix-response', id: 'one' };
  const two = { type: 'vix-response', id: 'two' };
  const outputs = [{ widgetId: 'one' }, { widgetId: 'two' }, { widgetId: 'external' }];
  assert.equal(selectRegimeResponse([one], outputs).response.widgetId, 'one');
  assert.equal(selectRegimeResponse([one, two], outputs).unavailableReason, 'select_response_widget');
  assert.equal(selectRegimeResponse([one, two], outputs, 'two').response.widgetId, 'two');
  assert.equal(selectRegimeResponse([one], outputs, 'external').unavailableReason, 'response_widget_removed');
  assert.equal(selectRegimeResponse([one], [], 'one').unavailableReason, 'response_not_published');
});
