import { REGIME_RULES } from './volatility-regime-rules.mjs';
import { CONTEXT_SESSIONS, VIXEQ_SERIES, VIXEQ_METRICS } from './vixeq-dynamics-calculations.mjs';

function state([id, label, description], supporting_metrics) {
  return { id, label, description, supporting_metrics: supporting_metrics ?? {} };
}

function fromTable(table, inputs, metrics, rules) {
  if (inputs.some((value) => !value || value === 'UNKNOWN')) return state(rules.unknown, metrics);
  const match = table.find(([conditions]) => conditions.every((condition, i) =>
    condition === '*' || (Array.isArray(condition) ? condition.includes(inputs[i]) : condition === inputs[i])));
  return state(match?.slice(1) ?? rules.unknown, metrics);
}

export function classifyLevel(metrics, rules = REGIME_RULES) {
  const z = metrics?.z;
  if (!Number.isFinite(z)) return state(rules.unknown, metrics);
  const [veryLow, low, elevated, extreme] = rules.thresholds.level;
  return state(rules.level[z <= veryLow ? 0 : z <= low ? 1 : z < elevated ? 2 : z < extreme ? 3 : 4], metrics);
}

export function classifyMomentum(metrics, rules = REGIME_RULES) {
  const value = metrics?.momentum;
  if (!Number.isFinite(value)) return state(rules.unknown, metrics);
  const [falling, rising] = rules.thresholds.momentum;
  return state(rules.momentum[value <= falling ? 0 : value < rising ? 1 : 2], metrics);
}

function bucket(level) {
  if (level === 'VERY_LOW') return 'LOW';
  if (level === 'ELEVATED' || level === 'EXTREME') return 'HIGH';
  return level;
}

export function classifyRiskEnvironment(levels = {}, rules = REGIME_RULES) {
  const order = ['vix', 'vixeq', 'cor1m'];
  const support = Object.fromEntries(order.map((key) => [key, levels[key]?.supporting_metrics ?? null]));
  return fromTable(rules.environment, order.map((key) => bucket(levels[key]?.id)), support, rules);
}

export function classifyDiversification(level, momentum, rules = REGIME_RULES) {
  return fromTable(rules.diversification, [bucket(level?.id), momentum?.id],
    { level: level?.supporting_metrics ?? null, change20: momentum?.supporting_metrics ?? null }, rules);
}

export function classifyStressDynamics(momentum = {}, rules = REGIME_RULES) {
  const support = Object.fromEntries(VIXEQ_METRICS.map((key) => [key, momentum[key]?.supporting_metrics ?? null]));
  return fromTable(rules.stress, VIXEQ_SERIES.map((key) => momentum[key]?.id), support, rules);
}

export function classifyRiskResponse(metrics, rules = REGIME_RULES) {
  const z = metrics?.z;
  if (!Number.isFinite(z)) return state(rules.unknown, metrics);
  const [extremeRelief, relief, stress, extremeStress] = rules.thresholds.response;
  return state(rules.response[z <= extremeRelief ? 0 : z <= relief ? 1 : z < stress ? 2 : z < extremeStress ? 3 : 4], metrics);
}

export function classifyCombinedState(environment, response, rules = REGIME_RULES) {
  const group = !environment?.id || environment.id === 'UNKNOWN' ? 'UNKNOWN'
    : rules.ordinaryEnvironments.includes(environment.id) ? 'ORDINARY' : 'ELEVATED';
  return fromTable(rules.combined, [group, rules.responseGroups[response?.id]],
    { environment: environment?.supporting_metrics ?? null, response: response?.supporting_metrics ?? null }, rules);
}

export function resolveTradingImplications(states, rules = REGIME_RULES) {
  const risk_management_implications = [];
  const strategy_considerations = [];
  const add = (list, text, regime) => {
    if (!list.some((item) => item.text === text)) list.push({ regime_id: regime.id, label: regime.label, text });
  };
  for (const regime of states) {
    const copy = rules.implications[regime.id];
    if (!copy) continue;
    add(risk_management_implications, copy[0], regime);
    add(strategy_considerations, copy[1], regime);
  }
  return { risk_management_implications, strategy_considerations };
}

function sourceIssue(key, sources, date) {
  const keys = key === 'spread' ? ['vixeq', 'vix'] : [key];
  for (const input of keys) {
    const source = sources[input];
    if (source?.stale) return 'stale_source';
    if (!source?.provider || !source.latestDate) return 'missing_source';
    if (source.latestDate < date) return 'misaligned_session';
  }
  return null;
}

function levelEvidence(row, observations, key, issue) {
  const { count = 0, sigma = null } = observations?.levels?.[key] ?? {};
  const value = row?.[key] ?? null;
  const z = row?.zScore?.[key] ?? null;
  const reason = issue ?? (value === null ? 'missing_observation' : count < CONTEXT_SESSIONS ? 'insufficient_history'
    : sigma === 0 ? 'zero_standard_deviation' : Number.isFinite(z) ? null : 'missing_observation');
  return { value, z: reason ? null : z, sigma, count, reason };
}

function momentumEvidence(row, observations, horizon, key, issue) {
  const { count = 0, sigma = null } = observations?.momentum?.[horizon]?.[key] ?? {};
  const change = row?.[`change${horizon}`]?.[key] ?? null;
  const reason = issue ?? (change === null ? 'missing_observation' : count < CONTEXT_SESSIONS ? 'insufficient_history'
    : sigma === 0 ? 'zero_standard_deviation' : Number.isFinite(sigma) && Number.isFinite(change / sigma) ? null : 'missing_observation');
  return { change, momentum: reason ? null : change / sigma, sigma, count, reason };
}

function responseEvidence(date, output, unavailableReason) {
  const row = output?.latest?.date === date ? output.latest : output?.series?.find((point) => point.date === date);
  const sigma = row?.residualBands?.sigma ?? null;
  const reason = !date ? 'missing_session'
    : !output ? unavailableReason
      : ['spx', 'vix'].some((key) => output.sources?.[key]?.stale) ? 'stale_source'
        : output.status === 'error' ? 'missing_response'
          : !row ? 'misaligned_session'
            : ['spx', 'vix'].map((key) => sourceIssue(key, output.sources ?? {}, date)).find(Boolean)
              ?? (sigma === 0 ? 'zero_standard_deviation'
                : !(sigma > 0) || !Number.isFinite(row.standardizedResidual) ? 'insufficient_response_history' : null);
  return { spxReturn: row?.spxReturn ?? null, expectedChange: row?.expectedChange ?? null,
    actualChange: row?.actualChange ?? null, residual: row?.residual ?? null, sigma,
    z: reason ? null : row?.standardizedResidual ?? null, reason };
}

export function evaluateVolatilityRegime({ latest, regimeObservations, sources = {}, response, responseWidgetId = null,
  unavailableReason = 'missing_response_widget' }, rules = REGIME_RULES) {
  const as_of_date = latest?.date ?? null;
  const issue = (key) => as_of_date ? sourceIssue(key, sources, as_of_date) : 'missing_session';
  const metric_levels = Object.fromEntries(VIXEQ_METRICS.map((key) => [key, classifyLevel(levelEvidence(latest, regimeObservations, key, issue(key)), rules)]));
  const momentumAt = (horizon) => Object.fromEntries(VIXEQ_METRICS.map((key) => [
    key, classifyMomentum(momentumEvidence(latest, regimeObservations, horizon, key, issue(key)), rules)
  ]));
  const momentum5 = momentumAt(5);
  const momentum20 = momentumAt(20);
  const risk_environment = classifyRiskEnvironment(metric_levels, rules);
  const diversification_state = classifyDiversification(metric_levels.cor1m, momentum20.cor1m, rules);
  const stress_dynamics_5d = classifyStressDynamics(momentum5, rules);
  const stress_dynamics_20d = classifyStressDynamics(momentum20, rules);
  const risk_response = classifyRiskResponse(responseEvidence(as_of_date, response, unavailableReason), rules);
  const combined_state = classifyCombinedState(risk_environment, risk_response, rules);
  const states = { risk_environment, diversification_state, stress_dynamics_5d, stress_dynamics_20d, risk_response, combined_state };
  const ruleId = (key, regime) => regime.id === 'UNKNOWN' ? null : `${key}.${regime.id}`;
  const reasons = (metrics) => Object.fromEntries(VIXEQ_METRICS.map((key) => [key, metrics[key].supporting_metrics.reason]));
  const extreme_metric_flags = Object.fromEntries(VIXEQ_METRICS.map((key) => {
    const { id } = metric_levels[key];
    return [key, id === 'UNKNOWN' ? null : id === 'VERY_LOW' || id === 'EXTREME'];
  }));
  return {
    schema_version: 1, rules_version: rules.version, as_of_date, ...states, metric_levels, extreme_metric_flags,
    directional_bias: 'UNDETERMINED',
    ...resolveTradingImplications([combined_state, risk_environment, stress_dynamics_20d, stress_dynamics_5d], rules),
    matched_rule_ids: {
      ...Object.fromEntries(Object.entries(states).map(([key, regime]) => [key, ruleId(key, regime)])),
      metric_levels: Object.fromEntries(VIXEQ_METRICS.map((key) => [key, ruleId('level', metric_levels[key])]))
    },
    data_quality: {
      status: !as_of_date ? 'unavailable' : [...Object.values(states), ...Object.values(metric_levels)].some(({ id }) => id === 'UNKNOWN')
        ? 'partial' : 'ok',
      metric_levels: reasons(metric_levels), momentum_5d: reasons(momentum5), momentum_20d: reasons(momentum20),
      response_widget_id: responseWidgetId, response: risk_response.supporting_metrics.reason,
      retrospective_vixeq: latest?.retrospective === true
    }
  };
}
