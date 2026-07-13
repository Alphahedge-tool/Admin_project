import { canonicalSymbol, expiryKey } from './symbol.js';

const EXCHANGES = {
  nse_cm: 'NSE',
  nse_fo: 'NFO',
  bse_cm: 'BSE',
  bse_fo: 'BFO',
  cde_fo: 'CDS',
  bcs_fo: 'BCD',
  'bcs-fo': 'BCD',
  mcx_fo: 'MCX',
};

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function canonicalExchange(value) {
  const input = String(value || '').trim();
  return EXCHANGES[input.toLowerCase()] || upper(input);
}

function contractType(position, brokerInstrument) {
  const optionType = upper(
    brokerInstrument?.optionType || position.optiontype || position.optTp,
  );
  if (optionType === 'CE' || optionType === 'PE') return optionType;

  const instrumentType = upper(
    brokerInstrument?.instrumentType || position.type || position.instrumentType,
  );
  const tradingSymbol = upper(position.tradingsymbol || position.trdSym);
  if (instrumentType.includes('FUT') || tradingSymbol.endsWith('FUT')) return 'FUT';
  if (tradingSymbol.endsWith('CE')) return 'CE';
  if (tradingSymbol.endsWith('PE')) return 'PE';
  return 'EQ';
}

function underlyingOf(position, brokerInstrument, type, expiry) {
  const direct = upper(
    brokerInstrument?.name || position.sym || position.underlying || position.symbolname,
  );
  if (direct && direct !== upper(position.tradingsymbol || position.trdSym)) return direct;

  let symbol = upper(position.tradingsymbol || position.trdSym || direct)
    .replace(/-(EQ|BE|MF|SG)$/i, '');
  if (type !== 'EQ') {
    const expiryPart = expiryKey(expiry);
    if (expiryPart) symbol = symbol.split(expiryPart)[0];
  }
  return symbol;
}

function canonicalContract(position, brokerInstrument) {
  if (brokerInstrument?.symbol && brokerInstrument?.exchange) {
    return {
      symbol: brokerInstrument.symbol,
      exchange: brokerInstrument.exchange,
      underlying: brokerInstrument.name || '',
      expiry: brokerInstrument.expiry || '',
      strike: brokerInstrument.strike ?? null,
      optionType: brokerInstrument.optionType || '',
      instrumentType: contractType(position, brokerInstrument),
    };
  }

  const type = contractType(position, brokerInstrument);
  const expiry = brokerInstrument?.expiry || position.expirydate || position.expDt || '';
  const strike = brokerInstrument?.strike
    ?? position.strikeprice
    ?? position.stkPrc
    ?? null;
  const underlying = underlyingOf(position, brokerInstrument, type, expiry);
  return {
    symbol: canonicalSymbol({ name: underlying, expiry, strike, type }),
    exchange: canonicalExchange(
      brokerInstrument?.exchange || position.exSeg || position.exchange,
    ),
    underlying,
    expiry,
    strike: type === 'CE' || type === 'PE' ? Number(strike) : null,
    optionType: type === 'CE' || type === 'PE' ? type : '',
    instrumentType: type,
  };
}

// Broker report tokens are only valid for that broker. Resolve the report row
// into a canonical contract first, then find the independent Angel feed token.
export function mapKotakPositionToAngelFeed(position, instruments) {
  const brokerInstrument = instruments.resolveBroker(
    'kotak',
    position.tradingsymbol || position.trdSym,
    position.exSeg || position.exchange,
  );
  const contract = canonicalContract(position, brokerInstrument);
  const feedInstrument = contract.symbol && contract.exchange
    ? instruments.resolve('angel', contract.symbol, contract.exchange)
    : null;

  const brokerToken = brokerInstrument?.token
    || position.brokerToken
    || position.symboltoken
    || '';
  const brokerExchange = brokerInstrument?.brexchange
    || brokerInstrument?.segment
    || position.brokerExchange
    || position.exSeg
    || position.exchange
    || '';

  return {
    ...position,
    brokerToken: String(brokerToken),
    brokerExchange,
    // Keep symboltoken as Kotak for order/margin operations. Angel market data
    // always uses the separate masterFeed* fields below.
    symboltoken: String(brokerToken),
    feedExchange: brokerExchange,
    canonicalSymbol: contract.symbol,
    canonicalExchange: contract.exchange,
    canonicalUnderlying: contract.underlying,
    canonicalExpiry: contract.expiry,
    canonicalStrike: contract.strike,
    canonicalOptionType: contract.optionType,
    canonicalInstrumentType: contract.instrumentType,
    lotsize: brokerInstrument?.lotsize || position.lotsize,
    masterFeedBroker: 'angelone',
    masterFeedToken: feedInstrument ? String(feedInstrument.token) : '',
    masterFeedExchange: feedInstrument?.brexchange
      || feedInstrument?.segment
      || feedInstrument?.exchange
      || '',
    masterFeedSymbol: feedInstrument?.brsymbol || '',
    masterFeedMapped: Boolean(feedInstrument?.token),
  };
}

