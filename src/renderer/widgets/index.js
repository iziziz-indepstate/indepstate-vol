import { atmSkewWidget } from './atm-skew-widget.js';
import { tailSkewWidget } from './tail-skew-widget.js';
import { ivCurrentWidget } from './iv-current-widget.js';
import {
  nDateSkewVelocityPutWidget,
  nDateSkewPutWidget,
  nDateSkewBidPutWidget
} from './ndate-put-skew-widget.js';
import {
  nDateSkewVelocityCallWidget,
  nDateSkewCallWidget,
  nDateSkewBidCallWidget
} from './ndate-call-skew-widget.js';

export const widgetDefinitions = [
  atmSkewWidget,
  tailSkewWidget,
  ivCurrentWidget,
  nDateSkewVelocityPutWidget,
  nDateSkewVelocityCallWidget,
  nDateSkewPutWidget,
  nDateSkewCallWidget,
  nDateSkewBidPutWidget,
  nDateSkewBidCallWidget
];

export const widgetRegistry = Object.fromEntries(widgetDefinitions.map((d) => [d.type, d]));

export function getWidgetDefinition(type) {
  return widgetRegistry[type] || null;
}
