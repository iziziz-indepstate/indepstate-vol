// Keep explicit signs: +3 and 3 select different strike windows.
export function parseOptionFlowStrikeWindow(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (text.toUpperCase() === 'ALL') return 'ALL';
  if (!/^[+-]?\d+$/.test(text)) return null;
  const count = Number(text.replace(/^[+-]/, ''));
  if (!Number.isSafeInteger(count)) return null;
  return /^[+-]/.test(text) ? `${text[0]}${count}` : count;
}

export function formatOptionFlowStrikeWindow(value) {
  const window = parseOptionFlowStrikeWindow(value) ?? 3;
  return typeof window === 'number' ? `±${window}` : window;
}
