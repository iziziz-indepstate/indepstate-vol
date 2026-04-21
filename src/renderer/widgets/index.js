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

export const widgetDefinitions = [
  atmSkewWidget,
  tailSkewWidget,
  nDateSkewVelocityPutWidget,
  nDateSkewVelocityCallWidget,
  nDateSkewPutWidget,
  nDateSkewCallWidget
];

export const widgetRegistry = Object.fromEntries(widgetDefinitions.map((d) => [d.type, d]));

export function getWidgetDefinition(type) {
  return widgetRegistry[type] || null;
}
