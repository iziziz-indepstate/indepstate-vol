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
import { zeroDteSkewWidget } from './zero-dte-skew-widget.js';
import { multiExpirySkewWidget } from './multi-expiry-skew-widget.js';
import { ivDynamicsWidget } from './iv-dynamics-widget.js';
import { optionFlowBalancedTickWidget, optionFlowTickWidget } from './option-flow-tick-widget.js';
import { gammaFlowWidget, gammaImbalanceWidget } from './gamma-flow-widget.js';
import { theBlockWidgets } from './theblock-widgets.js';
import { appPluginWidgets } from '../../plugins/index.js';

// Provider ownership is part of the widget definition contract.
const tapeWidgets = new Set([optionFlowTickWidget, optionFlowBalancedTickWidget, gammaFlowWidget, gammaImbalanceWidget]);
const independentWidgets = new Set([volUpfrontWidget, ivRvWidget, ...appPluginWidgets]);

export const widgetDefinitions = [
  atmStraddleWidget,
  volUpfrontWidget,
  nDeltaIVWidget,
  zeroDteSkewWidget,
  multiExpirySkewWidget,
  ivDynamicsWidget,
  optionFlowTickWidget,
  optionFlowBalancedTickWidget,
  gammaFlowWidget,
  gammaImbalanceWidget,
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
  ivRvWidget,
  ...appPluginWidgets,
  ...theBlockWidgets
].map((definition) => Object.assign(definition, {
  providerKey: definition.providerKey !== undefined ? definition.providerKey
    : independentWidgets.has(definition) ? null
      : tapeWidgets.has(definition) ? 'tape-contract'
        : theBlockWidgets.includes(definition) ? 'theblock' : 'tradingview'
}));

export const widgetRegistry = Object.fromEntries(widgetDefinitions.map((d) => [d.type, d]));

export function getWidgetDefinition(type) {
  return widgetRegistry[type] || null;
}
