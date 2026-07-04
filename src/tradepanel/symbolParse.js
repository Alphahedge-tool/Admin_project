// Shared trading-symbol parsing + product tag helpers, used by both the
// Get Position table and the saved-strategy legs shown in Sync Net Positions,
// so both render symbols identically.

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
