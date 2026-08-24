export const ATM_STRADDLE_SNAPSHOT_PLUGIN_ID = 'atm-straddle-snapshot';

export function isSaveableAtmStraddleSnapshot(snapshot) {
  return Number.isFinite(snapshot?.atmStrike)
    && Number.isFinite(snapshot?.referencePrice)
    && Number.isFinite(snapshot?.straddle?.mid);
}

export function shouldSaveAtmStraddleSnapshotEvent(event, pluginId = ATM_STRADDLE_SNAPSHOT_PLUGIN_ID) {
  const widget = event?.widget;
  const output = event?.output;
  const settings = widget?.config?.plugins?.[pluginId] || {};

  return widget?.type === 'atm-straddle'
    && event?.definition?.type === 'atm-straddle'
    && output?.type === 'atm-straddle'
    && output?.status === 'ok'
    && settings.enabled === true
    && isSaveableAtmStraddleSnapshot(output?.snapshot);
}

export function subscribeAtmStraddleSnapshot({
  widgetDataEvents,
  appBridge,
  pluginId = ATM_STRADDLE_SNAPSHOT_PLUGIN_ID
}) {
  if (!widgetDataEvents || typeof widgetDataEvents.subscribe !== 'function') return () => {};

  return widgetDataEvents.subscribe(async (event) => {
    if (!shouldSaveAtmStraddleSnapshotEvent(event, pluginId)) return;
    if (typeof appBridge?.saveAtmStraddleSnapshot !== 'function') return;

    await appBridge.saveAtmStraddleSnapshot({
      title: event.output.title || event.widget.title || event.definition.defaultTitle || 'Straddle ATM',
      config: { ...(event.output.config || event.widget.config || {}) },
      snapshot: event.output.snapshot,
      sourceSnapshotTime: event.sourceSnapshotTime
    });
  });
}
