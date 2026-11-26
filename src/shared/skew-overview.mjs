import { parseExpiryDate } from './expiry-placeholders.mjs';
import { analyzeSkewQuotes, isValidSkewQuote, readSkewQuotes, skewSessionDate, skewSpot } from './zero-dte-skew-calculations.mjs';

const DAY_MS = 86_400_000;
const TARGETS = [0.25, 0.1];
const STRIKE_RANGES = { auto: 0.05, '5': 0.05, '10': 0.1, '20': 0.2 };

export const skewOverviewDefaultConfig = { panel: 'smile', expiration: 'auto', range: 'auto' };

export function normalizeSkewOverviewConfig(config = {}) {
  const expiration = String(config?.expiration ?? '').trim().replaceAll('-', '');
  const range = String(config?.range ?? '');
  return {
    panel: ['smile', 'term', 'table'].includes(config?.panel) ? config.panel : 'smile',
    expiration: parseExpiryDate(expiration) ? expiration : 'auto',
    range: range === 'all' || Object.hasOwn(STRIKE_RANGES, range) ? range : 'auto'
  };
}

function chainOverview(snapshot, chain, expiration, dte) {
  const px = skewSpot(chain, snapshot);
  const spot = px > 0 ? px : null;
  const quotes = readSkewQuotes(chain);
  const { atmStrike, atmIV, wings: [wing25, wing10] } = analyzeSkewQuotes(quotes, spot, TARGETS);
  return { expiration, dte, spot, quotes, atmStrike, atmIV, wing25, wing10 };
}

function smileData(selected, chain) {
  const { spot, atmIV, wing25 } = selected;
  const quotes = selected.quotes
    .filter((q) => q.strike != null && (q.type === 'put' || q.type === 'call'))
    .sort((a, b) => a.strike - b.strike || a.type.localeCompare(b.type))
    .map((quote) => {
      const { type, strike } = quote;
      const byStrike = type === 'put' ? chain.putBidIvByStrike : chain.callBidIvByStrike;
      const bidIV = Number(byStrike?.[strike]);
      const moneyness = spot == null ? null : strike === spot ? 'atm'
        : ((type === 'put') === (strike < spot) ? 'otm' : 'itm');
      return { ...quote, bidIV: Number.isFinite(bidIV) && bidIV > 0 ? bidIV : null,
        valid: isValidSkewQuote(quote), moneyness };
    });
  return { spot, atmIV, wing25, quotes };
}

function skewPoints({ put, call }) {
  return put.iv == null || call.iv == null ? null : (put.iv - call.iv) * 100;
}

export function calculateSkewOverview(snapshot, expiration = 'auto') {
  const timestamp = snapshot?.time ?? null;
  const empty = { timestamp, expiration: expiration === 'auto' ? null : expiration, dte: null,
    contractCount: 0, metrics: null, smile: null, term: [] };
  const session = parseExpiryDate(skewSessionDate(timestamp));
  if (!session || !snapshot.byExpiry || snapshot.storage?.trimmed) {
    return { ...empty, status: 'waiting_for_snapshot' };
  }

  const chains = Object.keys(snapshot.byExpiry).sort().flatMap((date) => {
    const expiryDate = parseExpiryDate(date);
    const chain = snapshot.byExpiry[date];
    if (!expiryDate || expiryDate < session || chain?.storage?.trimmed) return [];
    const dte = (expiryDate - session) / DAY_MS;
    return [chainOverview(snapshot, chain, date, dte)];
  });
  const term = chains.map((row) => ({
    expiration: row.expiration, dte: row.dte, atmIV: row.atmIV,
    put25IV: row.wing25.put.iv, call25IV: row.wing25.call.iv
  }));
  const atmTerm = term.filter((row) => row.atmIV != null);
  const first = atmTerm[0];
  const last = atmTerm.at(-1);
  const termSlope = atmTerm.length > 1 ? (last.atmIV - first.atmIV) * 100 * 30 / (last.dte - first.dte) : null;
  const metrics = { atmIV: null, atmStrike: null, skew25: null, skew10: null, butterfly25: null, skewSlope: null, termSlope };
  const selected = chains.find((row) => row.quotes.length && (expiration === 'auto' || row.expiration === expiration));
  if (!selected) {
    const dte = chains.find((row) => row.expiration === expiration)?.dte ?? null;
    return { ...empty, dte, metrics, term, status: 'missing_chain' };
  }

  const { atmIV, atmStrike, wing25, wing10, spot } = selected;
  const skew25 = skewPoints(wing25);
  const { put, call } = wing25;
  const distance = skew25 == null ? null : (call.strike - put.strike) / spot * 100;
  return {
    status: 'ok', timestamp, expiration: selected.expiration, dte: selected.dte,
    contractCount: selected.quotes.length,
    metrics: {
      atmIV, atmStrike, skew25, skew10: skewPoints(wing10),
      butterfly25: skew25 == null || atmIV == null ? null : ((put.iv + call.iv) / 2 - atmIV) * 100,
      skewSlope: distance > 0 ? -skew25 / distance : null,
      termSlope
    },
    smile: smileData(selected, snapshot.byExpiry[selected.expiration]), term
  };
}

export function skewOverviewWindow(smile, range) {
  if (!smile) return { min: undefined, max: undefined, quotes: [] };
  const { spot, quotes, wing25 } = smile;
  if (spot == null || range === 'all') return { min: undefined, max: undefined, quotes };
  const width = spot * (STRIKE_RANGES[range] ?? STRIKE_RANGES.auto);
  const min = range === 'auto' ? Math.min(spot - width, wing25.put.strike ?? spot) : spot - width;
  const max = range === 'auto' ? Math.max(spot + width, wing25.call.strike ?? spot) : spot + width;
  return { min, max, quotes: quotes.filter(({ strike }) => strike >= min && strike <= max) };
}
