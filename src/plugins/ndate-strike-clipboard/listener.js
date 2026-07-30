import { createStrikeClipboardChain } from './chain.js';

export const POINT_CLICK_EVENT = 'chart.pointClick';

export function subscribeNDateStrikeClipboard({
  eventBus,
  getWidgetDefinition,
  writeText,
  setStatus,
  chain = createStrikeClipboardChain()
}) {
  if (!eventBus || typeof eventBus.subscribe !== 'function') return () => {};

  return eventBus.subscribe(POINT_CLICK_EVENT, async (event) => {
    const definition = getWidgetDefinition?.(event?.widgetType);
    const prefix = definition?.eventStrategies?.strikeClipboard?.prefix;
    const strike = event?.payload?.strike;
    if (!prefix || strike == null) return;

    const result = chain.click({
      widgetId: event.widgetId,
      prefix,
      strike
    });
    if (!result.text) {
      setStatus?.(`strike selected: ${prefix} ${result.strike}`);
      return;
    }

    try {
      await writeText(result.text);
      setStatus?.(`copied: ${result.text}`);
    } catch (err) {
      console.warn('Failed to copy strike chain to clipboard', err);
      setStatus?.(`clipboard copy failed: ${err?.message || String(err)}`);
    }
  });
}

