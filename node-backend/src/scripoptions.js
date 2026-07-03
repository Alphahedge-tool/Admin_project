// AllScripOptions: mirrors Angel's internal all-scrip-options, served from our
// in-memory scrip master (no Angel round-trip). Returns every option scrip for
// (symbol, expiry, segment), CE/PE aligned by strike. Port of Go scripoptions.go.
import { parseExpiryMs, normalizeStrike, unionStrikes, nilIfEmpty } from './util.js';

const MASTER_EXPIRY_RE = /^\d{2}[A-Z]{3}\d{4}$/;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// index symbol -> [exchange, spotToken] for the spot LTP source.
export const SPOT_TOKENS = {
  NIFTY: ['NSE', '99926000'],
  BANKNIFTY: ['NSE', '99926009'],
  FINNIFTY: ['NSE', '99926037'],
  MIDCPNIFTY: ['NSE', '99926074'],
  SENSEX: ['BSE', '99919000'],
};

export const MCX_SYMBOLS = new Set([
  'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'CRUDEOIL', 'CRUDEOILM',
  'NATURALGAS', 'NATGASMINI', 'COPPER', 'ZINC', 'MCXBULLDEX',
]);

// segmentFor picks the F&O segment a symbol's contracts live in.
export function segmentFor(symbol) {
  if (symbol === 'SENSEX') return 'BFO';
  if (MCX_SYMBOLS.has(symbol)) return 'MCX';
  return 'NFO';
}

// Angel's MarketSegmentId → our F&O segment code.
const SEGMENT_BY_MARKET_ID = { '1': 'NFO', '2': 'NFO', '3': 'BFO', '5': 'MCX' };

// normalizeExpiry accepts ISO "2026-07-07" or master "07JUL2026" and returns
// the master form (uppercase "DDMMMYYYY").
export function normalizeExpiry(value) {
  const v = String(value || '').toUpperCase().trim();
  if (!v) throw new Error('ExpiryDate is required');
  if (MASTER_EXPIRY_RE.test(v)) return v;
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const month = MONTHS[Number(iso[2]) - 1];
    if (month) return `${iso[3]}${month}${iso[1]}`;
  }
  throw new Error(`ExpiryDate ${JSON.stringify(value)} must be YYYY-MM-DD or DDMMMYYYY`);
}

// allScripOptions returns every option scrip for (symbol, expiry, segment) from
// the master, sorted by strike then CE before PE, with aligned CE/PE arrays.
export async function allScripOptions(master, req) {
  const symbol = String(req.TradeSymbol || '').toUpperCase().trim();
  if (!symbol) throw new Error('TradeSymbol is required');
  const expiry = normalizeExpiry(req.ExpiryDate);

  let segment = SEGMENT_BY_MARKET_ID[String(req.MarketSegmentId || '').trim()];
  if (!segment) segment = segmentFor(symbol);

  const rows = await master.data();

  const ce = new Map(); // strike -> { token, tradingSymbol, lotSize }
  const pe = new Map();
  let lotSize = 1;
  const futs = []; // { token, expiryMs }

  for (const r of rows) {
    if (r.n !== symbol || r.g !== segment) continue;
    if (segment === 'MCX' && r.s.endsWith('FUT')) {
      futs.push({ token: r.t, expiryMs: parseExpiryMs(r.e) });
    }
    if (r.e !== expiry) continue;
    const strike = normalizeStrike(r.k, segment);
    const lot = r.l > 0 ? r.l : 1;
    lotSize = lot;
    if (r.s.endsWith('CE')) ce.set(strike, { token: r.t, tradingSymbol: r.s, lotSize: lot });
    else if (r.s.endsWith('PE')) pe.set(strike, { token: r.t, tradingSymbol: r.s, lotSize: lot });
  }

  if (ce.size === 0 && pe.size === 0) {
    throw new Error(`No option scrips for ${symbol} ${expiry} (${segment})`);
  }

  const strikes = unionStrikes(ce, pe);
  const exchange = segment;

  const callTokens = new Array(strikes.length).fill(null);
  const putTokens = new Array(strikes.length).fill(null);
  const callSymbols = new Array(strikes.length).fill(null);
  const putSymbols = new Array(strikes.length).fill(null);
  const scrips = [];
  const liveTokens = [];

  strikes.forEach((s, i) => {
    const c = ce.get(s);
    if (c) {
      callTokens[i] = c.token;
      callSymbols[i] = c.tradingSymbol;
      liveTokens.push(c.token);
      scrips.push({ token: c.token, tradingSymbol: c.tradingSymbol, strike: s, optionType: 'CE', lotSize: c.lotSize, expiry, exchange });
    }
    const p = pe.get(s);
    if (p) {
      putTokens[i] = p.token;
      putSymbols[i] = p.tradingSymbol;
      liveTokens.push(p.token);
      scrips.push({ token: p.token, tradingSymbol: p.tradingSymbol, strike: s, optionType: 'PE', lotSize: p.lotSize, expiry, exchange });
    }
  });

  // Spot source: index LTP for NSE/BSE, nearest future for MCX commodities.
  let spotExchange = '';
  let spotToken = '';
  if (SPOT_TOKENS[symbol]) {
    [spotExchange, spotToken] = SPOT_TOKENS[symbol];
  } else if (futs.length > 0) {
    futs.sort((a, b) => a.expiryMs - b.expiryMs);
    const optMs = parseExpiryMs(expiry);
    spotExchange = segment;
    spotToken = futs[0].token;
    for (const f of futs) {
      if (f.expiryMs >= optMs) {
        spotToken = f.token;
        break;
      }
    }
  }

  scrips.sort((a, b) => (a.strike !== b.strike ? a.strike - b.strike : a.optionType < b.optionType ? -1 : 1));

  return {
    status: true,
    symbol,
    expiry,
    exchange,
    segment,
    lotSize,
    strikes,
    callTokens,
    putTokens,
    callSymbols,
    putSymbols,
    liveTokens,
    spotToken: nilIfEmpty(spotToken),
    spotExchange: nilIfEmpty(spotExchange),
    scrips,
    count: scrips.length,
  };
}
