export function parseSessionOffset(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const offset = Number(value);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
}

export function normalizeDailyLines(config = {}) {
  const lines = Array.isArray(config.lines) ? config.lines : [];
  const source = lines.length ? lines : [{ tenor: config.tenor || '0DTE' }];
  return source.map((line) => ({
    tenor: String(line?.tenor || '0DTE').trim() || '0DTE',
    offsetMinutes: parseSessionOffset(line?.offsetMinutes) ?? 15
  }));
}

export function migrateDailyPriceWidgetConfig(widget) {
  if (widget?.type !== 'straddle-daily-price') return false;
  const config = widget.config || {};
  const next = { ...config, lines: normalizeDailyLines(config) };
  delete next.tenor;
  delete next.time;
  if (JSON.stringify(config) === JSON.stringify(next)) return false;
  widget.config = next;
  return true;
}
