const DEFAULT_TIMEOUT_MS = 20000;

function normalizeStrike(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return raw;
  return String(Math.round(numeric * 1e6) / 1e6);
}

export function createStrikeClipboardChain(timeoutMs = DEFAULT_TIMEOUT_MS) {
  let pending = null;

  return {
    click({ widgetId, prefix, strike, now = Date.now() }) {
      const normalizedStrike = normalizeStrike(strike);
      if (!widgetId || !prefix || !normalizedStrike) {
        pending = null;
        return { text: null, pending: false };
      }

      const isContinuation = pending
        && pending.widgetId === widgetId
        && pending.prefix === prefix
        && now - pending.timestamp <= timeoutMs;

      if (isContinuation) {
        const text = `${prefix} ${pending.strike} ${normalizedStrike}`;
        pending = null;
        return { text, pending: false };
      }

      pending = {
        widgetId,
        prefix,
        strike: normalizedStrike,
        timestamp: now
      };
      return { text: null, pending: true, strike: normalizedStrike };
    },

    clear() {
      pending = null;
    },

    snapshot() {
      return pending ? { ...pending } : null;
    }
  };
}

