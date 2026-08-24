function noop() {}

export function createWidgetDataPublishBus(options = {}) {
  const subscribers = new Set();
  const onError = typeof options.onError === 'function' ? options.onError : console.warn;

  function subscribe(handler) {
    if (typeof handler !== 'function') return noop;
    subscribers.add(handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      subscribers.delete(handler);
    };
  }

  function publish(event) {
    const payload = {
      tab: event?.tab || null,
      widget: event?.widget || null,
      definition: event?.definition || null,
      output: event?.output || null,
      sourceSnapshotTime: event?.sourceSnapshotTime || null
    };
    for (const handler of Array.from(subscribers)) {
      try {
        const result = handler(payload);
        if (result && typeof result.catch === 'function') {
          result.catch((err) => onError('Widget data publish subscriber failed', err));
        }
      } catch (err) {
        onError('Widget data publish subscriber failed', err);
      }
    }
    return subscribers.size > 0;
  }

  return {
    subscribe,
    publish
  };
}
