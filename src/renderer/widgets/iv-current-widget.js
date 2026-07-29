import { resolveStrikeSelection } from '../../shared/option-chain-utils.js';

function avg(values) {
  const valid = values.filter((x) => Number.isFinite(x));
  if (!valid.length) return null;
  return valid.reduce((acc, x) => acc + x, 0) / valid.length;
}

function toNumberOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export const ivCurrentWidget = {
  type: 'iv-current-line',
  mode: 'timeseries-custom',
  chartRuntime: 'uplot',
  defaultTitle: 'IV-Current',
  color: '#7dffb3',
  hideXAxisValues: true,
  controls: {
    strike: true,
    strikeInputType: 'text'
  },
  defaultConfig: {
    baseStrike: 'ATM'
  },
  extractTimeSeriesValue: (snapshot, widget) => {
    const strikesAsc = Array.from(new Set([
      ...(Array.isArray(snapshot?.putStrikesAsc) ? snapshot.putStrikesAsc : []),
      ...(Array.isArray(snapshot?.callStrikesAsc) ? snapshot.callStrikesAsc : [])
    ])).sort((a, b) => a - b);

    const { strike } = resolveStrikeSelection(
      strikesAsc,
      widget?.config?.baseStrike,
      snapshot?.px
    );
    if (!Number.isFinite(strike)) return null;

    const putIv = toNumberOrNull(snapshot?.putIvByStrike?.[strike]);
    const callIv = toNumberOrNull(snapshot?.callIvByStrike?.[strike]);
    return avg([putIv, callIv]);
  }
};
