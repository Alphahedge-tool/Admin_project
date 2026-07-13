const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function expiryKey(input) {
  if (input == null || input === '') return '';
  const value = String(input).trim().toUpperCase();
  let match = value.match(/^(\d{1,2})([A-Z]{3})(\d{2}|\d{4})$/);
  if (match) return `${match[1].padStart(2, '0')}${match[2]}${match[3].slice(-2)}`;
  match = value.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (match) return `${match[3]}${MONTHS[Number(match[2]) - 1]}${match[1].slice(-2)}`;
  const numeric = Number(value);
  const millis = Number.isFinite(numeric) && numeric > 0
    ? numeric * (value.length <= 10 ? 1000 : 1)
    : Date.parse(value);
  if (!Number.isNaN(millis)) {
    const date = new Date(millis);
    return `${String(date.getUTCDate()).padStart(2, '0')}${MONTHS[date.getUTCMonth()]}${String(date.getUTCFullYear()).slice(-2)}`;
  }
  return value;
}

export function strikeKey(input) {
  const value = Number(input);
  if (!Number.isFinite(value)) return String(input ?? '');
  return Number.isInteger(value) ? String(value) : String(value).replace(/\.?0+$/, '');
}

export function canonicalSymbol({ name, expiry, strike, type, optionType }) {
  const root = String(name || '').toUpperCase().trim();
  const instrumentType = String(type || '').toUpperCase();
  const side = String(optionType || '').toUpperCase();
  if (instrumentType === 'FUT') return `${root}${expiryKey(expiry)}FUT`;
  if (instrumentType === 'CE' || instrumentType === 'PE') {
    return `${root}${expiryKey(expiry)}${strikeKey(strike)}${instrumentType}`;
  }
  if (instrumentType === 'OPT' && (side === 'CE' || side === 'PE')) {
    return `${root}${expiryKey(expiry)}${strikeKey(strike)}${side}`;
  }
  return root;
}
