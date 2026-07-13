import { parseCSV } from './csv.js';
import { canonicalSymbol } from './symbol.js';

function derivativeType(symbol, instrumentType = '', optionType = '') {
  const brokerSymbol = String(symbol || '').toUpperCase();
  const instrument = String(instrumentType || '').toUpperCase();
  const option = String(optionType || '').toUpperCase();
  if (option === 'CE' || option === 'PE') return option;
  if (instrument.startsWith('OPT')) return brokerSymbol.endsWith('PE') ? 'PE' : 'CE';
  if (option === 'XX' || instrument.includes('FUT') || brokerSymbol.endsWith('FUT')) return 'FUT';
  return 'EQ';
}

export function normalizeAngelRows(rows) {
  return rows.map((raw) => {
    const brsymbol = String(raw.s || '').trim();
    const name = String(raw.n || '').toUpperCase().trim();
    const exchange = String(raw.g || '').toUpperCase();
    const type = derivativeType(brsymbol);
    const strikeRaw = Number(raw.k);
    const strike = type === 'CE' || type === 'PE'
      ? (Number.isFinite(strikeRaw) && strikeRaw > 0 ? strikeRaw / 100 : null)
      : null;
    return {
      symbol: type === 'EQ'
        ? brsymbol.toUpperCase().replace(/-(EQ|BE|MF|SG)$/i, '')
        : canonicalSymbol({ name, expiry: raw.e, strike, type }),
      brsymbol,
      name,
      exchange,
      brexchange: exchange,
      token: String(raw.t || ''),
      expiry: raw.e || '',
      strike,
      optionType: type === 'CE' || type === 'PE' ? type : '',
      lotsize: Number(raw.l) || 1,
      segment: exchange,
      instrumentType: type,
    };
  }).filter((row) => row.symbol && row.token);
}

function kotakExchange(url) {
  const name = String(url || '').toLowerCase();
  if (name.includes('nse_fo')) return { exchange: 'NFO', segment: 'nse_fo' };
  if (name.includes('bse_fo')) return { exchange: 'BFO', segment: 'bse_fo' };
  if (name.includes('cde_fo') || name.includes('cds')) return { exchange: 'CDS', segment: 'cde_fo' };
  if (name.includes('bcs-fo') || name.includes('bcd')) return { exchange: 'BCD', segment: 'bcs-fo' };
  if (name.includes('mcx')) return { exchange: 'MCX', segment: 'mcx_fo' };
  if (name.includes('bse_cm') || name.includes('bse')) return { exchange: 'BSE', segment: 'bse_cm' };
  return { exchange: 'NSE', segment: 'nse_cm' };
}

function kotakExpiry(raw, segment) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return raw || '';
  const seconds = value + (segment === 'nse_fo' ? 315_511_200 : 0);
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function normalizeKotakFiles(files) {
  const output = [];
  for (const file of files) {
    const { exchange, segment } = kotakExchange(file.url);
    for (const raw of parseCSV(file.text)) {
      const name = String(raw.pSymbolName || '').toUpperCase().trim();
      const brsymbol = String(raw.pTrdSymbol || '').trim();
      const type = derivativeType(brsymbol, raw.pInstType, raw.pOptionType);
      const strikeRaw = Number(raw.dStrikePrice);
      const strike = type === 'CE' || type === 'PE'
        ? (Number.isFinite(strikeRaw) && strikeRaw > 0 ? strikeRaw / 100 : null)
        : null;
      const expiry = type === 'EQ' ? '' : kotakExpiry(raw.pExpiryDate, segment);
      if (!name || !brsymbol || !raw.pSymbol) continue;
      output.push({
        symbol: type === 'EQ' ? name : canonicalSymbol({ name, expiry, strike, type }),
        brsymbol,
        name,
        exchange,
        brexchange: segment,
        token: String(raw.pSymbol),
        expiry,
        strike,
        optionType: type === 'CE' || type === 'PE' ? type : '',
        lotsize: Number(raw.lLotSize) || 1,
        ticksize: Number(raw.dTickSize) || 0,
        segment,
        instrumentType: raw.pInstType || type,
      });
    }
  }
  return output;
}

export function normalizeZerodhaRows(rows) {
  const output = [];
  for (const raw of rows) {
    const exchange = String(raw.exchange || '').toUpperCase();
    const type = String(raw.instrument_type || '').toUpperCase();
    const brsymbol = String(raw.tradingsymbol || '').trim();
    if (!exchange || !brsymbol || !['EQ', 'FUT', 'CE', 'PE'].includes(type)) continue;
    let name = String(raw.name || '').toUpperCase().trim();
    if (!name && type !== 'EQ') name = brsymbol.toUpperCase().replace(/\d{1,2}[A-Z]{3}\d{2}.*$/, '');
    if (!name) name = brsymbol.toUpperCase().replace(/-(EQ|BE)$/i, '');
    const strike = type === 'CE' || type === 'PE' ? Number(raw.strike) : null;
    output.push({
      symbol: type === 'EQ'
        ? brsymbol.toUpperCase().replace(/-(EQ|BE)$/i, '')
        : canonicalSymbol({ name, expiry: raw.expiry, strike, type }),
      brsymbol,
      name,
      exchange,
      brexchange: exchange,
      token: String(raw.instrument_token || ''),
      exchangeToken: String(raw.exchange_token || ''),
      expiry: raw.expiry || '',
      strike: Number.isFinite(strike) ? strike : null,
      optionType: type === 'CE' || type === 'PE' ? type : '',
      lotsize: Number(raw.lot_size) || 1,
      ticksize: Number(raw.tick_size) || 0,
      segment: raw.segment || exchange,
      instrumentType: type,
    });
  }
  return output.filter((row) => row.symbol && row.token);
}

const KOTAK_HOSTS = [
  'https://gw-napi.kotaksecurities.com',
  'https://cis.kotaksecurities.com',
  'https://neo-gw.kotaksecurities.com',
];
const KOTAK_PATHS = [
  '/Files/1.0/masterscrip/v2/file-paths',
  '/Files/1.0/masterscrip/v1/file-paths',
  '/script-details/1.0/masterscrip/file-paths',
];

export async function downloadKotakMaster({ accessToken, baseUrl }) {
  if (!accessToken) throw new Error('Kotak master needs the NeoFinKey/Access Token');
  let fileUrls = [];
  for (const host of [baseUrl, ...KOTAK_HOSTS].filter(Boolean)) {
    for (const endpoint of KOTAK_PATHS) {
      try {
        const response = await fetch(host.replace(/\/+$/, '') + endpoint, {
          headers: { Authorization: accessToken, 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) continue;
        const body = await response.json();
        fileUrls = body?.data?.filesPaths || body?.filesPaths || [];
        if (fileUrls.length) break;
      } catch {
        // Try the next official/compatible host and endpoint.
      }
    }
    if (fileUrls.length) break;
  }
  if (!fileUrls.length) throw new Error('Kotak master returned no CSV file paths');
  const files = [];
  for (const url of fileUrls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (response.ok) files.push({ url, text: await response.text() });
    } catch {
      // Keep good segments when a single CSV is temporarily unavailable.
    }
  }
  const rows = normalizeKotakFiles(files);
  if (!rows.length) throw new Error('Kotak master parsed no instruments');
  return rows;
}

export async function downloadZerodhaMaster({ apiKey, accessToken }) {
  if (!apiKey || !accessToken) throw new Error('Zerodha master needs apiKey and accessToken');
  const response = await fetch('https://api.kite.trade/instruments', {
    headers: {
      Accept: 'text/csv',
      'X-Kite-Version': '3',
      Authorization: `token ${apiKey}:${accessToken}`,
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Zerodha instruments download failed: HTTP ${response.status}`);
  const rows = normalizeZerodhaRows(parseCSV(await response.text()));
  if (!rows.length) throw new Error('Zerodha instruments file parsed no instruments');
  return rows;
}
