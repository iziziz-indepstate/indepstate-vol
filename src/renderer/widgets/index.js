import { atmSkewWidget } from './atm-skew-widget.js';
import { tailSkewWidget } from './tail-skew-widget.js';
import { nDatePutSkewWidget } from './ndate-put-skew-widget.js';
import { nDateCallSkewWidget } from './ndate-call-skew-widget.js';

const definitions = [atmSkewWidget, tailSkewWidget, nDatePutSkewWidget, nDateCallSkewWidget];

export const widgetRegistry = Object.fromEntries(definitions.map((d) => [d.type, d]));

export function getWidgetDefinition(type) {
  return widgetRegistry[type] || null;
}
