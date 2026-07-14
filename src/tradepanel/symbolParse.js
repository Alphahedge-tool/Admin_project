// Shared trading-symbol parsing + product tag helpers, used by the Get Position /
// OrderBook / TradeBook tables and the saved-strategy legs, so all of them render
// a contract identically.
//
// A word on why contractMeta() exists. Brokers do NOT agree on how a symbol is
// written, and Kotak does not even agree with itself:
//
//   Angel            NIFTY14JUL2622800PE   root + DD + MMM + YY + strike
//   Kotak weekly     NIFTY2671423900PE     root + YY + M + DD + strike
//   Kotak monthly    NIFTY26JUL24100PE     root + YY + MMM + strike   (no day!)
//
// The Angel and Kotak-monthly forms are IMPOSSIBLE to tell apart from the string:
// NIFTY26JUL24100PE reads equally well as "26 JUL, year 24, strike 100" (Angel's
// grammar) or "year 26, JUL, strike 24100" (Kotak's). Reading it the first way is
// what put a 100 strike on screen against a leg trading at 262.
//
// So the string is the LAST resort. Every broker also states the strike and expiry
// outright on the row, and those are what get shown.

export function compactProductTag(value) {
  const product = String(value || '-').toUpperCase();
  if (product === 'CARRYFORWARD' || product === 'NRML') return 'CF';
  if (product === 'INTRADAY') return 'MIS';
  return product;
}

function inferOptionType(symbol) {
  const text = String(symbol).toUpperCase();
  if (/\bCE\b|CE$/.test(text)) return 'CE';
  if (/\bPE\b|PE$/.test(text)) return 'PE';
  return '';
}

/**
 * What to display for a contract, taking the broker at its word.
 *
 * `row` is any position / order / trade / strategy-leg shape. Whatever it states
 * explicitly wins; the symbol is only parsed to fill in what it does not.
 */
export function contractMeta(row = {}) {
  const symbol = String(
    row.tradingsymbol || row.trading_symbol || row.symbolname || row.symbol || '-',
  );
  const parsed = parseTradingSymbol(symbol);

  const strike = normalizeStrike(
    row.strikeprice ?? row.strike_price ?? row.strike ?? row.canonicalStrike,
  );
  const expiry = formatExpiry(
    row.expirydate || row.expiry_date || row.expiry || row.expiration_date || row.canonicalExpiry,
  );
  const optionType = String(
    row.optiontype || row.option_type || row.canonicalOptionType || '',
  ).toUpperCase();
  const stock = String(row.stock_name || row.symbolname || row.symbol_name || '').trim();

  return {
    root: stock || parsed.root,
    expiry: expiry || parsed.expiry,
    strike: strike || parsed.strike,
    optionType: (optionType === 'CE' || optionType === 'PE') ? optionType : parsed.optionType,
  };
}

// "23300.0" -> "23300"; 0 / blank / non-numeric -> "" so the caller can fall back.
export function normalizeStrike(value) {
  if (value == null || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '';
  return String(number);
}

// Brokers write the expiry every which way: "14JUL2026" (Angel), "28 Jul, 2026"
// (Kotak), "2026-07-14" (our own tables). All of them come out as "14 Jul 2026".
export function formatExpiry(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  const compact = text.match(/^(\d{1,2})([A-Za-z]{3})(\d{4})$/);
  if (compact) {
    const [, day, month, year] = compact;
    return `${day.padStart(2, '0')} ${titleMonth(month)} ${year}`;
  }

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, year, month, day] = iso;
    const monthLabel = new Date(Number(year), Number(month) - 1, Number(day))
      .toLocaleDateString('en-IN', { month: 'short' });
    return `${day} ${monthLabel} ${year}`;
  }

  // "28 Jul, 2026" / "28 July 2026"
  const spaced = text.match(/^(\d{1,2})\s+([A-Za-z]{3,})[,]?\s+(\d{4})$/);
  if (spaced) {
    const [, day, month, year] = spaced;
    return `${day.padStart(2, '0')} ${titleMonth(month.slice(0, 3))} ${year}`;
  }

  return text;
}

export function parseTradingSymbol(symbol) {
  const text = String(symbol || '-').trim();
  const spaced = text.match(/^([A-Z]+)\s+(.+?)\s+(CE|PE)$/i);
  if (spaced) {
    const detail = spaced[2].trim();
    const strike = detail.match(/(\d+(?:\.\d+)?)$/)?.[1] || '';
    return { root: spaced[1].toUpperCase(), expiry: detail.replace(strike, '').trim(), strike, optionType: spaced[3].toUpperCase() };
  }

  const datedOption = text.match(/^([A-Z]+)(\d{2})([A-Z]{3})(\d{2})(\d+(?:\.\d+)?)(CE|PE)$/i);
  if (datedOption) {
    const [, root, day, mon, year, strike, optionType] = datedOption;
    return {
      root: root.toUpperCase(),
      expiry: `${day} ${titleMonth(mon)} ${year}`,
      strike: trimStrike(strike),
      optionType: optionType.toUpperCase(),
    };
  }

  const compact = text.match(/^([A-Z]+)(\d+)(CE|PE)$/i);
  if (compact) {
    const [, root, digits, optionType] = compact;
    const strike = digits.length > 5 ? digits.slice(-5) : digits;
    const prefix = strike ? digits.slice(0, -strike.length) : digits;
    return { root: root.toUpperCase(), expiry: formatSymbolCode(prefix), strike: trimStrike(strike), optionType: optionType.toUpperCase() };
  }

  const optionType = inferOptionType(text);
  return { root: optionType ? text.slice(0, -2) : text, expiry: '', strike: '', optionType };
}

function titleMonth(value) {
  const text = String(value || '').toUpperCase();
  return text ? text[0] + text.slice(1).toLowerCase() : '';
}

function formatSymbolCode(value) {
  if (!value) return '';
  const weekly5 = value.match(/^(\d{2})(\d)(\d{2})$/);
  if (weekly5) return `${weekly5[3]} ${monthName(Number(weekly5[2]))} 20${weekly5[1]}`;
  const weekly6 = value.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (weekly6) return `${weekly6[3]} ${monthName(Number(weekly6[2]))} 20${weekly6[1]}`;
  if (value.length === 5) return `${value.slice(0, 2)} ${value.slice(2, 3)} ${value.slice(3)}`;
  if (value.length === 6) return `${value.slice(0, 2)} ${value.slice(2, 4)} ${value.slice(4)}`;
  return value;
}

function trimStrike(value) {
  return String(value || '').replace(/^0+(?=\d)/, '');
}

function monthName(month) {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1] || '';
}
