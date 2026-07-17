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
//   Zerodha monthly  NIFTY26JUL24100PE     root + YY + MMM + strike   (same as Kotak)
//
// The Angel and Kotak/Zerodha-monthly forms are IMPOSSIBLE to tell apart from the string:
// NIFTY26JUL24100PE reads equally well as "26 JUL, year 24, strike 100" (Angel's
// grammar) or "year 26, JUL, strike 24100" (Kotak's). Reading it the first way is
// what put a 100 strike on screen against a leg trading at 262.
//
// So the string is the LAST resort. Every broker also states the strike and expiry
// outright on the row, and those are what get shown. When neither is present (saved
// strategy legs carry only the symbol), the row's BROKER breaks the tie: a leg on a
// Kotak or Zerodha account is read with their year-first grammar, everything else
// with Angel's - which is also the default when the broker is unknown, so callers
// that never set it (and the tests) are unchanged.

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

// Brokers that write the 3-letter-month (monthly) contract as YEAR + month +
// strike, with NO day - Kotak Neo AND Zerodha both do (NIFTY26JUL24000CE reads
// year 26, JUL, strike 24000). Angel writes day + month + year + strike, so it -
// and any unknown broker - is read the other way. Kept a plain string test so
// this module stays free of the session-store import.
function monthlyIsYearFirst(broker) {
  return /kotak|zerodha|kite/i.test(String(broker || ''));
}

// The broker a row belongs to, however it is spelled across position / leg shapes.
function rowBroker(row = {}) {
  return row.broker_name || row.broker || row._broker || row.account_broker || '';
}

/**
 * What to display for a contract, taking the broker at its word.
 *
 * `row` is any position / order / trade / strategy-leg shape. Whatever it states
 * explicitly wins; the symbol is only parsed to fill in what it does not.
 */
export function contractMeta(row = {}) {
  const broker = rowBroker(row);
  const symbol = String(
    row.tradingsymbol || row.trading_symbol || row.symbolname || row.symbol || row.stock_name || '-',
  );
  const parsed = parseTradingSymbol(symbol, broker);

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
  const stockParsed = stock ? parseTradingSymbol(stock, broker) : null;
  const stockLooksLikeContract = Boolean(
    stockParsed?.expiry || stockParsed?.strike || stockParsed?.optionType,
  );
  const root = stock && !stockLooksLikeContract
    ? stock
    : (parsed.root && parsed.root !== '-' ? parsed.root : (stockParsed?.root || parsed.root));

  return {
    root,
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

  // Month + year with no day - a monthly contract states only its month (Zerodha's
  // "AUG2026"), the expiry day is not in the symbol. Shown as "Aug 2026".
  const monthYear = text.match(/^([A-Za-z]{3})[-\s]?(\d{4})$/);
  if (monthYear) {
    const [, month, year] = monthYear;
    return `${titleMonth(month)} ${year}`;
  }

  return text;
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function monthIndex(name) {
  const key = String(name || '').slice(0, 3).toLowerCase();
  return key in MONTHS ? MONTHS[key] : null;
}

// "26" -> 2026, "2026" -> 2026. Contracts only ever quote this century.
function fullYear(year) {
  const n = Number(year);
  return n < 100 ? 2000 + n : n;
}

function endOfDay(year, monthIdx, day) {
  return new Date(year, monthIdx, day, 23, 59, 59, 999);
}

// Day 0 of the next month is the last day of this one - a monthly contract states
// only its month, so it counts as live until the whole month is past.
function endOfMonth(year, monthIdx) {
  return new Date(year, monthIdx + 1, 0, 23, 59, 59, 999);
}

/**
 * The contract's expiry as a Date at end of that day, or null if the row states
 * no expiry we can read. Reads the same every-broker forms formatExpiry does
 * ("14JUL2026", "28 Jul, 2026", "2026-07-14", "AUG2026"), plus the 2-digit-year
 * "14 Jul 26" the symbol parser produces, and falls back to the trading symbol
 * when no explicit expiry field is present. Used to hide already-expired legs.
 */
export function expiryDate(row = {}) {
  const explicit = String(
    row.expirydate || row.expiry_date || row.expiry || row.expiration_date || row.canonicalExpiry || '',
  ).trim();
  const text = explicit || parseTradingSymbol(
    row.tradingsymbol || row.trading_symbol || row.symbolname || row.symbol || row.stock_name || '',
    rowBroker(row),
  ).expiry;
  if (!text) return null;

  // ISO 2026-07-14
  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return endOfDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  // Angel compact 14JUL2026 / 14JUL26
  m = text.match(/^(\d{1,2})([A-Za-z]{3})(\d{2,4})$/);
  if (m) {
    const mi = monthIndex(m[2]);
    if (mi != null) return endOfDay(fullYear(m[3]), mi, Number(m[1]));
  }

  // Spaced "14 Jul 2026" / "28 July, 2026" / "14 Jul 26"
  m = text.match(/^(\d{1,2})\s+([A-Za-z]{3,})[,]?\s+(\d{2,4})$/);
  if (m) {
    const mi = monthIndex(m[2]);
    if (mi != null) return endOfDay(fullYear(m[3]), mi, Number(m[1]));
  }

  // Month + year with no day: "AUG2026" / "Aug 2026" - last day of the month.
  m = text.match(/^([A-Za-z]{3})[-\s]?(\d{2,4})$/);
  if (m) {
    const mi = monthIndex(m[1]);
    if (mi != null) return endOfMonth(fullYear(m[2]), mi);
  }

  return null;
}

export function parseTradingSymbol(symbol, broker) {
  const text = String(symbol || '-').trim();
  const yearFirst = monthlyIsYearFirst(broker);
  const spaced = text.match(/^([A-Z]+)\s+(.+?)\s+(CE|PE)$/i);
  if (spaced) {
    const detail = spaced[2].trim();
    const strike = detail.match(/(\d+(?:\.\d+)?)$/)?.[1] || '';
    return { root: spaced[1].toUpperCase(), expiry: detail.replace(strike, '').trim(), strike, optionType: spaced[3].toUpperCase() };
  }

  // The 3-letter-month shape shared by Angel and the Kotak/Zerodha monthly. The
  // digits either side of the month mean different things per broker, so the
  // broker decides:
  //   Angel            root + DD + MMM + YY + strike   NIFTY 14 JUL 26 22800 PE
  //   Kotak/Zerodha    root + YY + MMM + strike         NIFTY 26 JUL    22350 PE (no day)
  // Default (unknown broker) stays Angel - what every caller has always assumed.
  const named = text.match(/^([A-Z]+)(\d{2})([A-Z]{3})(\d+(?:\.\d+)?)(CE|PE)$/i);
  if (named) {
    const [, root, lead, mon, tail, optionType] = named;
    if (yearFirst) {
      // lead = 2-digit year, tail = the whole strike, no day in the symbol. A
      // monthly states only its month, so it shows as "Jul 2026" (formatExpiry /
      // expiryDate already treat month-only as living to month-end).
      return {
        root: root.toUpperCase(),
        expiry: `${titleMonth(mon)} 20${lead}`,
        strike: trimStrike(tail),
        optionType: optionType.toUpperCase(),
      };
    }
    // Angel: lead = day, first two of tail = 2-digit year, remainder = strike.
    return {
      root: root.toUpperCase(),
      expiry: `${lead} ${titleMonth(mon)} ${tail.slice(0, 2)}`,
      strike: trimStrike(tail.slice(2)),
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
