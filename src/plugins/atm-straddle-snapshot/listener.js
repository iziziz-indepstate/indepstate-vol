import { ATM_STRADDLE_POINT_EVENT, buildAtmStraddlePoint } from '../../shared/atm-straddle-point.mjs';

export const ATM_STRADDLE_SNAPSHOT_PLUGIN_ID = 'atm-straddle-snapshot';

export { ATM_STRADDLE_POINT_EVENT };

export function isSaveableAtmStraddlePointPayload(payload) {
  return Boolean(buildAtmStraddlePoint({
    snapshotTime: payload?.time,
    atmStrike: payload?.atmStrike,
    referencePrice: payload?.referencePrice,
    straddle: { mid: payload?.straddlePts }
  }));
}

export function shouldSaveAtmStraddlePointEvent(event, pluginId = ATM_STRADDLE_SNAPSHOT_PLUGIN_ID) {
  const widget = event?.payload?.widget || {};
  const settings = widget?.config?.plugins?.[pluginId] || event?.payload?.config?.plugins?.[pluginId] || {};

  return event?.type === ATM_STRADDLE_POINT_EVENT
    && event?.widgetType === 'atm-straddle'
    && settings.enabled === true
    && isSaveableAtmStraddlePointPayload(event?.payload)
    && event?.payload?.snapshot
    && typeof event.payload.snapshot === 'object';
}

export function subscribeAtmStraddleSnapshot({
  eventBus,
  appBridge,
  pluginId = ATM_STRADDLE_SNAPSHOT_PLUGIN_ID
}) {
  if (!eventBus || typeof eventBus.subscribe !== 'function') return () => {};

  return eventBus.subscribe(ATM_STRADDLE_POINT_EVENT, async (event) => {
    if (!shouldSaveAtmStraddlePointEvent(event, pluginId)) return;
    if (typeof appBridge?.saveAtmStraddleSnapshot !== 'function') return;

    await appBridge.saveAtmStraddleSnapshot({
      title: event.payload.title || event.payload.widget?.title || 'Straddle ATM',
      config: { ...(event.payload.config || event.payload.widget?.config || {}) },
      snapshot: event.payload.snapshot,
      sourceSnapshotTime: event.payload.time
    });
  });
}
