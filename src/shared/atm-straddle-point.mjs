export const ATM_STRADDLE_POINT_EVENT = 'atm-straddle:point';

function validTime(value) {
  return value != null && !Number.isNaN(new Date(value).getTime());
}

function finiteNumber(value) {
  return value !== null && value !== '' && Number.isFinite(Number(value));
}

export function buildAtmStraddlePoint(result) {
  const time = result?.snapshotTime || result?.time;
  const straddleRaw = result?.straddle?.mid;
  const atmStrikeRaw = result?.atmStrike;
  const referencePriceRaw = result?.referencePrice;

  if (!validTime(time)
    || !finiteNumber(straddleRaw)
    || !finiteNumber(atmStrikeRaw)
    || !finiteNumber(referencePriceRaw)) {
    return null;
  }

  const straddlePts = Number(straddleRaw);
  const atmStrike = Number(atmStrikeRaw);
  const referencePrice = Number(referencePriceRaw);

  return {
    time,
    value: straddlePts,
    straddlePts,
    atmStrike,
    referencePrice,
    spot: referencePrice,
    impliedMovePct: result?.straddle?.impliedMovePct,
    atmIv: result?.atmIv
  };
}
