import { calculateMultiExpiryPoints, mergeSkewPoints, skewIdentity } from '../shared/multi-expiry-skew.mjs';

// Independent of datasource history: resets must never clear pending writes or chart points.
export function createSkewHistorySession(getBridge) {
  const entries = new Map();
  function entryFor(identity) {
    const key = JSON.stringify(identity);
    if (!entries.has(key)) entries.set(key, { identity, points: [], pending: new Map(), error: '', flight: null });
    return entries.get(key);
  }
  async function flush(entry) {
    if (entry.flight) return entry.flight;
    entry.flight = (async () => {
      while (entry.pending.size) {
        const batch = [...entry.pending.entries()];
        try {
          const bridge = getBridge();
          if (!bridge?.saveSkewHistory) throw new Error('Skew history writer is unavailable');
          const result = await bridge.saveSkewHistory({ identity: entry.identity, points: batch.map(([, p]) => p) });
          if (result?.ok !== true) throw new Error(result?.error || 'Skew history write failed');
          for (const [key, p] of batch) if (entry.pending.get(key) === p) entry.pending.delete(key);
          entry.error = '';
        } catch (err) { entry.error = err.message; break; }
      }
    })();
    try { await entry.flight; } finally { entry.flight = null; }
  }
  function capture(source, widgets, history) {
    const touched = new Set();
    for (const widget of widgets || []) {
      if (widget.type !== 'multi-expiry-skew') continue;
      for (const line of calculateMultiExpiryPoints(history, widget.config || {})) {
        const entry = entryFor(skewIdentity(source, line.expiration, widget.config?.targetDelta));
        const previous = new Map(entry.points.map((p) => [Date.parse(p.timestamp), JSON.stringify(p)]));
        entry.points = mergeSkewPoints(entry.points, line.points);
        for (const p of entry.points) if (previous.get(Date.parse(p.timestamp)) !== JSON.stringify(p)) entry.pending.set(Date.parse(p.timestamp), p);
        touched.add(entry);
      }
    }
    for (const entry of entries.values()) {
      if (entry.identity.dataSourceId === source.id && entry.pending.size) touched.add(entry);
    }
    return Promise.all([...touched].map(flush));
  }
  return { capture, points: (identity) => entryFor(identity).points, error: (identity) => entryFor(identity).error };
}

export const skewHistorySession = createSkewHistorySession(() => globalThis.window?.appBridge);
