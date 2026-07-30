function noop() {}

function normalizeContracts(contracts) {
  return new Set((Array.isArray(contracts) ? contracts : [])
    .map((contract) => String(contract?.type || contract || '').trim())
    .filter(Boolean));
}

function timestampFromNow(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date(Number.isFinite(Number(value)) ? Number(value) : Date.now()).toISOString();
}

export function createWidgetEventBus(options = {}) {
  const now = options.now || Date.now;
  const onError = typeof options.onError === 'function' ? options.onError : console.warn;
  const subscribersByType = new Map();
  const sources = new Set();

  function subscriberCount(type) {
    return subscribersByType.get(type)?.size || 0;
  }

  function hasSubscribers(type) {
    return subscriberCount(type) > 0;
  }

  function notifyInterest(type, active) {
    for (const source of sources) {
      if (source.destroyed || !source.contractTypes.has(type)) continue;
      for (const listener of source.interestListeners) {
        try {
          listener(type, active);
        } catch (err) {
          onError('Widget event interest listener failed', err);
        }
      }
    }
  }

  function subscribe(type, handler) {
    const eventType = String(type || '').trim();
    if (!eventType || typeof handler !== 'function') return noop;

    const before = subscriberCount(eventType);
    const subscribers = subscribersByType.get(eventType) || new Set();
    subscribers.add(handler);
    subscribersByType.set(eventType, subscribers);
    if (before === 0 && subscribers.size > 0) notifyInterest(eventType, true);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const curr = subscribersByType.get(eventType);
      if (!curr) return;
      const beforeDelete = curr.size;
      curr.delete(handler);
      if (!curr.size) subscribersByType.delete(eventType);
      if (beforeDelete > 0 && !subscriberCount(eventType)) notifyInterest(eventType, false);
    };
  }

  function registerSource(sourceContext = {}) {
    const contractTypes = normalizeContracts(sourceContext.contracts);
    const source = {
      tabId: sourceContext.tabId || null,
      widgetId: sourceContext.widgetId || null,
      widgetType: sourceContext.widgetType || null,
      contractTypes,
      interestListeners: new Set(),
      destroyed: false
    };
    sources.add(source);

    function hasInterest(type) {
      const eventType = String(type || '').trim();
      return !source.destroyed && contractTypes.has(eventType) && hasSubscribers(eventType);
    }

    function emit(type, payload = {}) {
      const eventType = String(type || '').trim();
      if (!hasInterest(eventType)) return false;

      const event = {
        type: eventType,
        tabId: source.tabId,
        widgetId: source.widgetId,
        widgetType: source.widgetType,
        timestamp: timestampFromNow(now),
        payload: payload && typeof payload === 'object' ? { ...payload } : payload
      };

      const subscribers = Array.from(subscribersByType.get(eventType) || []);
      for (const handler of subscribers) {
        try {
          const result = handler(event);
          if (result && typeof result.catch === 'function') {
            result.catch((err) => onError('Widget event subscriber failed', err));
          }
        } catch (err) {
          onError('Widget event subscriber failed', err);
        }
      }
      return subscribers.length > 0;
    }

    function onInterestChange(listener) {
      if (source.destroyed || typeof listener !== 'function') return noop;
      source.interestListeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        source.interestListeners.delete(listener);
      };
    }

    function destroy() {
      if (source.destroyed) return;
      source.destroyed = true;
      source.interestListeners.clear();
      sources.delete(source);
    }

    return {
      emit,
      hasInterest,
      onInterestChange,
      destroy
    };
  }

  return {
    subscribe,
    hasSubscribers,
    registerSource
  };
}
