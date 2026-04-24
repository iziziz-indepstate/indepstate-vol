export const WIDGET_PARAM_NAMES = Object.freeze({
  BASE_STRIKE: 'baseStrike',
  EXPIRY_START: 'expiryStart',
  EXPIRY_END: 'expiryEnd',
  STRIKE_RANGE: 'strikeRange',
  TAIL_STEPS: 'tailSteps'
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

    case WIDGET_PARAM_NAMES.EXPIRY_START:
    case WIDGET_PARAM_NAMES.EXPIRY_END:
    case WIDGET_PARAM_NAMES.STRIKE_RANGE:
      return str;

    default:
      return str;
  }
}

export function shouldRefreshOnWidgetParamChange(paramName) {
  return paramName === WIDGET_PARAM_NAMES.BASE_STRIKE
    || paramName === WIDGET_PARAM_NAMES.STRIKE_RANGE
    || paramName === WIDGET_PARAM_NAMES.TAIL_STEPS;
}

