function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function calculateForwardVols(points = []) {
  const sorted = points
    .map((point) => ({
      label: String(point?.label || ''),
      dte: toNum(point?.dte),
      iv: toNum(point?.iv)
    }))
    .filter((point) => point.label && Number.isFinite(point.dte) && point.dte > 0 && Number.isFinite(point.iv) && point.iv > 0)
    .sort((a, b) => a.dte - b.dte);

  const result = [];
  for (let idx = 0; idx < sorted.length - 1; idx += 1) {
    const current = sorted[idx];
    const next = sorted[idx + 1];
    const dt = next.dte - current.dte;
    if (dt <= 0) throw new Error('DTE must be strictly increasing');

    const totalVarianceFrom = current.iv * current.iv * current.dte;
    const totalVarianceTo = next.iv * next.iv * next.dte;
    const forwardVariance = (totalVarianceTo - totalVarianceFrom) / dt;
    const isValid = forwardVariance >= 0;
    const forwardVol = isValid ? Math.sqrt(forwardVariance) : Number.NaN;

    result.push({
      fromLabel: current.label,
      toLabel: next.label,
      fromDte: current.dte,
      toDte: next.dte,
      dt,
      totalVarianceFrom,
      totalVarianceTo,
      forwardVariance,
      forwardVol,
      forwardVolPercent: isValid ? forwardVol * 100 : Number.NaN,
      status: isValid ? 'ok' : 'invalid_negative_forward_variance'
    });
  }

  return result;
}
