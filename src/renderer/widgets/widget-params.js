export const WIDGET_PARAM_NAMES = Object.freeze({
  BASE_STRIKE: 'baseStrike',
  EXPIRY_START: 'expiryStart',
  EXPIRY_END: 'expiryEnd',
  STRIKE_RANGE: 'strikeRange',
  TAIL_STEPS: 'tailSteps',
  OPTION_TYPE: 'optionType',
  TARGET_DELTA: 'targetDelta',
  EXPIRATION: 'expiration',
  TIME_RANGE: 'range',
  MIRROR_X: 'mirrorX'
});

export const WIDGET_PARAM_DATASET = Object.freeze({
  WIDGET_ID: 'widgetParamWidgetId',
  PARAM_NAME: 'widgetParamName'
});

export function normalizeWidgetParamValue(paramName, rawValue, currentValue, options = {}) {
  const str = String(rawValue ?? '').trim();

  switch (paramName) {
    case WIDGET_PARAM_NAMES.BASE_STRIKE: {
      if (options.strikeInputType === 'text') return str || currentValue;
      const numeric = Number(str);
      return Number.isFinite(numeric) ? numeric : currentValue;
    }

    case WIDGET_PARAM_NAMES.TAIL_STEPS: {
      const numeric = Number(str);
      return Number.isFinite(numeric) ? Math.max(1, Math.floor(numeric)) : (currentValue || 3);
    }

    case WIDGET_PARAM_NAMES.TARGET_DELTA: {
      const numeric = Math.abs(Number(str));
      return Number.isFinite(numeric) ? Math.min(0.99, Math.max(0.01, numeric)) : (currentValue || 0.25);
    }

    case WIDGET_PARAM_NAMES.OPTION_TYPE:
      return str === 'call' ? 'call' : 'put';

    case WIDGET_PARAM_NAMES.TIME_RANGE:
      return ['1D', '1W', '1M', '6M'].includes(str) ? str : (currentValue || '1M');

    case WIDGET_PARAM_NAMES.MIRROR_X:
      return Boolean(rawValue);

    case WIDGET_PARAM_NAMES.EXPIRY_START:
    case WIDGET_PARAM_NAMES.EXPIRY_END:
    case WIDGET_PARAM_NAMES.EXPIRATION:
    case WIDGET_PARAM_NAMES.STRIKE_RANGE:
      return str;

    default:
      return str;
  }
}

export function shouldRefreshOnWidgetParamChange(paramName) {
  return paramName === WIDGET_PARAM_NAMES.BASE_STRIKE
    || paramName === WIDGET_PARAM_NAMES.STRIKE_RANGE
    || paramName === WIDGET_PARAM_NAMES.TAIL_STEPS
    || paramName === WIDGET_PARAM_NAMES.OPTION_TYPE
    || paramName === WIDGET_PARAM_NAMES.TARGET_DELTA
    || paramName === WIDGET_PARAM_NAMES.EXPIRATION
    || paramName === WIDGET_PARAM_NAMES.TIME_RANGE
    || paramName === WIDGET_PARAM_NAMES.MIRROR_X;
}

