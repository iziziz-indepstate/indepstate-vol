import { atmSkewWidget } from './atm-skew-widget.js';
import { tailSkewWidget } from './tail-skew-widget.js';
import {
  nDateSkewVelocityPutWidget,
  nDateSkewPutWidget
} from './ndate-put-skew-widget.js';
import {
  nDateSkewVelocityCallWidget,
  nDateSkewCallWidget
} from './ndate-call-skew-widget.js';

const definitions = [
  atmSkewWidget,
  tailSkewWidget,
  nDateSkewVelocityPutWidget,
  nDateSkewVelocityCallWidget,
  nDateSkewPutWidget,
  nDateSkewCallWidget
];

export const widgetRegistry = Object.fromEntries(definitions.map((d) => [d.type, d]));

export function getWidgetDefinition(type) {
  return widgetRegistry[type] || null;
}
