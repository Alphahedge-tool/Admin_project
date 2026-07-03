// Small helpers shared across the Angel modules — ports of the Go util.go.

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// parseExpiryMs parses Angel's "DDMMMYYYY" expiry (e.g. "31JUL2026") into a
// millis timestamp for chronological sorting. Unknown formats sort last.
export function parseExpiryMs(expiry) {
  const m = String(expiry || '').toUpperCase().match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const month = MONTHS.indexOf(m[2]);
  if (month < 0) return Number.MAX_SAFE_INTEGER;
  return Date.UTC(Number(m[3]), month, Number(m[1]));
}

// mapData returns the "data" object of a SmartAPI envelope (or empty).
export function mapData(m) {
  return m && typeof m.data === 'object' && m.data !== null ? m.data : {};
}

// strOr coerces v to a non-empty string, or returns fallback.
export function strOr(v, fallback) {
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return fallback;
}

// toFloat coerces JSON scalars to a number (0 on failure).
export function toFloat(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const f = parseFloat(v);
    return Number.isFinite(f) ? f : 0;
  }
  return 0;
}

// normalizeStrike converts Angel's scaled master strike to a whole-rupee strike.
// MCX commodity strikes are consistently ×100, so always ÷100. NSE/BSE index
// option strikes only over-scale on some rows (>200000), so divide only then.
export function normalizeStrike(raw, exchange) {
  const n = Number(raw) || 0;
  if (exchange === 'MCX') return Math.trunc(n / 100);
  if (n > 200000) return Math.trunc(n / 100);
  return Math.trunc(n);
}

export const round2 = (v) => Math.round(v * 100) / 100;

export const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function indexOf(arr, want) {
  return arr.indexOf(want);
}

export function nilIfEmpty(s) {
  return s === '' || s == null ? null : s;
}

// chunkTokens splits a token array into batches of at most `size` so a bulk
// quote stays under Angel's per-request token cap (~50).
export function chunkTokens(tokens, size = 50) {
  if (size < 1) size = 50;
  const chunks = [];
  for (let i = 0; i < tokens.length; i += size) {
    chunks.push(tokens.slice(i, i + size));
  }
  return chunks;
}

// unionStrikes returns the sorted numeric union of two strike-keyed maps.
export function unionStrikes(ce, pe) {
  const set = new Set();
  for (const k of ce.keys()) set.add(k);
  for (const k of pe.keys()) set.add(k);
  return [...set].sort((a, b) => a - b);
}

// firstFetchedLTP reads data.fetched[0].ltp from a quote envelope.
export function firstFetchedLTP(res) {
  const list = fetchedList(res);
  return list.length ? toFloat(list[0].ltp) : 0;
}

// fetchedList extracts data.fetched[] as an array of objects.
export function fetchedList(res) {
  const data = res && res.data;
  if (!data || !Array.isArray(data.fetched)) return [];
  return data.fetched.filter((x) => x && typeof x === 'object');
}

// fetchedGreeks extracts data[] (a plain array) from the optionGreek envelope.
export function fetchedGreeks(res) {
  const raw = res && res.data;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x) => x && typeof x === 'object');
}

// firstNonZero returns the first non-zero numeric field among keys.
export function firstNonZero(m, ...keys) {
  for (const k of keys) {
    if (m[k] != null) {
      const f = toFloat(m[k]);
      if (f !== 0) return f;
    }
  }
  return 0;
}
