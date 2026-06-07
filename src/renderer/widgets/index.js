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
import { nDateSkewBidIVRatioWidget } from './ndate-bidiv-ratio-widget.js';
import { spreadOptimizerWidget } from './spread-optimizer-widget.js';
import { ivRvWidget } from './iv-rv-widget.js';
import { atmStraddleWidget } from './atm-straddle-widget.js';
import { volUpfrontWidget } from './vol-upfront-widget.js';
import { nDeltaIVWidget } from './n-delta-iv-widget.js';

export const widgetDefinitions = [
  atmStraddleWidget,
  volUpfrontWidget,
  nDeltaIVWidget,
  atmSkewWidget,
  tailSkewWidget,
  ivCurrentWidget,
  nDateSkewVelocityPutWidget,
  nDateSkewVelocityCallWidget,
  nDateSkewPutWidget,
  nDateSkewCallWidget,
  nDateSkewBidPutWidget,
  nDateSkewBidCallWidget,
  nDateSkewBidIVRatioWidget,
  spreadOptimizerWidget,
  ivRvWidget
];

export const widgetRegistry = Object.fromEntries(widgetDefinitions.map((d) => [d.type, d]));

export function getWidgetDefinition(type) {
  return widgetRegistry[type] || null;
}
