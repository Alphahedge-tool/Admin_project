// Kotak Securities NEO Trade API (V3) — headless TOTP login.
//
// Unlike Zerodha (whose Kite Connect has no headless login at all: a human must
// click through the browser every morning), Kotak can be logged in entirely from
// the server, the same way Angel is. It just takes two calls:
//
//   1. tradeApiLogin    mobile + UCC + a generated TOTP  -> "view" token + sid
//   2. tradeApiValidate the MPIN, carrying that view token -> the TRADE token
//
// The trade token from step 2 is the one that authorises actual trading calls;
// the view token on its own is not enough.
import { generateTOTP } from './auth.js';

const LOGIN_URL = 'https://mis.kotaksecurities.com/login/1.0/tradeApiLogin';
const VALIDATE_URL = 'https://mis.kotaksecurities.com/login/1.0/tradeApiValidate';

// Kotak requires this fixed header on both login calls. Without it the API
// rejects the request with "Missing required field 'NeoFinKey'". It is not a
// secret and not per-account - it is the same constant for every caller.
const NEO_FIN_KEY = 'neotradeapi';

const LOGIN_TIMEOUT_MS = 20_000;
const REPORT_TIMEOUT_MS = 20_000;

async function postJSON(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'neo-fin-key': NEO_FIN_KEY,
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
  });

  const text = await res.text();
  let out = {};
  if (text) {
    try {
      out = JSON.parse(text);
    } catch {
      out = { raw: text };
    }
  }

  // Kotak answers a failed login with HTTP 200 and {status:"error"} in the body,
  // so the HTTP status alone cannot be trusted to mean success.
  if (!res.ok || out?.status === 'error') {
    const message = out?.message
      || out?.error?.[0]?.message
      || out?.fault?.message
      || `Kotak HTTP ${res.status}`;
    throw new Error(message);
  }
  return out;
}

// Kotak nests the useful part under `data` on some responses and returns it flat
// on others.
function dataOf(res) {
  return (res && typeof res.data === 'object' && res.data) || res || {};
}

function normalizeCreds(input = {}) {
  const c = input.client && typeof input.client === 'object' ? input.client : input;
  return {
    ucc: String(c.ucc || c.clientCode || c.account_id || '').trim(),
    accessToken: String(c.accessToken || c.app_secret || '').trim(),
    mobileNumber: String(c.mobileNumber || c.phone || '').trim(),
    mpin: String(c.mpin || c.pin || '').trim(),
    totpSecret: String(c.totpSecret || c.totp_secret || '').trim(),
    session: c.session || null,
  };
}

// Names the credential that is actually missing, rather than failing later
// inside Kotak's API with something unhelpful.
function assertCreds(cr) {
  const missing = [];
  if (!cr.ucc) missing.push('UCC');
  if (!cr.accessToken) missing.push('Access Token');
  if (!cr.mobileNumber) missing.push('mobile number');
  if (!cr.mpin) missing.push('MPIN');
  if (!cr.totpSecret) missing.push('TOTP secret');
  if (missing.length) {
    throw new Error(`Kotak login needs ${missing.join(', ')}`);
  }
}

export async function autoLogin(input) {
  const cr = normalizeCreds(input);
  assertCreds(cr);

  const totp = generateTOTP(cr.totpSecret);

  const loginRes = await postJSON(LOGIN_URL, { Authorization: cr.accessToken }, {
    mobileNumber: cr.mobileNumber,
    ucc: cr.ucc,
    totp,
  });
  const login = dataOf(loginRes);
  const viewToken = login.token || '';
  const viewSID = login.sid || '';
  if (!viewToken || !viewSID) throw new Error('Kotak login returned no view token/sid');

  const validateRes = await postJSON(
    VALIDATE_URL,
    { Authorization: cr.accessToken, sid: viewSID, Auth: viewToken },
    { mpin: cr.mpin },
  );
  const validated = dataOf(validateRes);
  const tradeToken = validated.token || '';
  if (!tradeToken) throw new Error('Kotak MPIN validation returned no trade token');

  const now = new Date().toISOString();
  const session = {
    tradeToken,
    sid: validated.sid || viewSID,
    rid: validated.rid || '',
    serverId: validated.hsServerId || validated.serverId || '',
    dataCenter: validated.dataCenter || '',
    // Kotak hands back the data-centre host to use for subsequent calls; it is
    // not the same for every account, so it has to be carried in the session.
    baseUrl: validated.baseUrl || '',
    ucc: cr.ucc,
    greeting: validated.greetingName || '',
    loginSource: 'totp-login',
    loginAt: now,
    lastUsedAt: now,
  };

  // Same envelope shape Angel's auto-login returns, so the frontend can treat
  // the two identically. Kotak's login response carries no margin.
  return {
    status: true,
    broker: 'kotak',
    clientCode: session.ucc,
    availableMargin: 0,
    marginSource: 'n/a',
    sessionSource: 'totp-login',
    session,
    data: {
      baseUrl: session.baseUrl,
      greetingName: session.greeting,
      hsServerId: session.serverId,
      dataCenter: session.dataCenter,
    },
  };
}

function sessionOf(input = {}) {
  const client = input.client && typeof input.client === 'object' ? input.client : input;
  const session = client.session && typeof client.session === 'object' ? client.session : client;
  const normalized = {
    ...session,
    tradeToken: String(session.tradeToken || session.token || '').trim(),
    sid: String(session.sid || '').trim(),
    baseUrl: String(session.baseUrl || '').trim().replace(/\/+$/, ''),
  };
  const missing = [];
  if (!normalized.tradeToken) missing.push('trade token');
  if (!normalized.sid) missing.push('SID');
  if (!normalized.baseUrl) missing.push('base URL');
  if (missing.length) throw new Error(`Kotak session needs ${missing.join(', ')}`);
  return normalized;
}

export function sessionFromClient(input = {}) {
  return sessionOf(input);
}

async function requestReport(input, path, { method = 'GET', jData } = {}) {
  const session = sessionOf(input);
  const body = jData == null ? undefined : new URLSearchParams({
    jData: JSON.stringify(jData),
  }).toString();
  const res = await fetch(`${session.baseUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Sid: session.sid,
      Auth: session.tradeToken,
      'neo-fin-key': NEO_FIN_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
  });

  const text = await res.text();
  let out = {};
  if (text) {
    try {
      out = JSON.parse(text);
    } catch {
      throw new Error(`Kotak returned an invalid response (HTTP ${res.status})`);
    }
  }

  // "No data" is an EMPTY BOOK, not a failure. Kotak answers an account with no
  // positions (or no orders, or no trades) with HTTP 200 and
  // {stCode:5203, errMsg:"No Data", stat:"Not_Ok"} - and treating that as an
  // error meant a flat account could not read its own books at all: Get
  // Positions, Order Book, Trade Book and the position sync all failed on it.
  // An empty book reads back as an empty list, which is what it is.
  if (res.ok && isNoDataResponse(out)) {
    return { raw: { ...out, data: [] }, session: { ...session, lastUsedAt: new Date().toISOString() } };
  }

  // Kotak names its error message `errMsg`; reading `emsg` meant every real
  // failure surfaced as the useless "Kotak HTTP 200".
  const message = out?.errMsg || out?.emsg || out?.message || out?.desc;

  if (!res.ok || String(out?.stat || '').toLowerCase() === 'not_ok') {
    throw new Error(message || `Kotak HTTP ${res.status}`);
  }
  if (out?.stat && String(out.stat).toLowerCase() !== 'ok') {
    throw new Error(message || `Kotak request failed (${out.stat})`);
  }
  return { raw: out, session: { ...session, lastUsedAt: new Date().toISOString() } };
}

const NO_DATA_CODE = 5203;

function isNoDataResponse(out) {
  if (Number(out?.stCode) === NO_DATA_CODE) return true;
  return /^\s*no\s*data\s*$/i.test(String(out?.errMsg || out?.emsg || ''));
}

function numberOf(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function sideOf(value) {
  return String(value || '').trim().toUpperCase().startsWith('S') ? 'SELL' : 'BUY';
}

function exchangeOf(value) {
  const exchange = String(value || '').trim();
  const key = exchange.toLowerCase().replace(/[^a-z0-9]/g, '');
  return ({
    nsecm: 'NSE', nsefo: 'NFO', bsecm: 'BSE', bsefo: 'BFO',
    cdefo: 'CDS', nsecd: 'CDS', mcxfo: 'MCX',
  })[key] || exchange.toUpperCase();
}

function orderTypeOf(value) {
  const type = String(value || '').trim().toUpperCase().replace(/[_\s]/g, '-');
  if (type === 'L' || type === 'LIMIT') return 'LIMIT';
  if (type === 'M' || type === 'MKT' || type === 'MARKET') return 'MARKET';
  if (type === 'SL' || type === 'STOP-LOSS') return 'STOPLOSS_LIMIT';
  if (type === 'SL-M' || type === 'SLM') return 'STOPLOSS_MARKET';
  return type;
}

export function normalizeKotakOrder(row = {}) {
  const quantity = numberOf(row.qty);
  const filled = numberOf(row.fldQty ?? row.filledQty ?? row.filledshares);
  return {
    ...row,
    orderid: String(row.nOrdNo || row.orderid || ''),
    uniqueorderid: String(row.exOrdId || row.uniqueorderid || ''),
    exchangeorderid: String(row.exOrdId || row.exchangeorderid || ''),
    tradingsymbol: String(row.trdSym || row.sym || row.tradingsymbol || ''),
    symbolname: String(row.sym || row.trdSym || row.symbolname || ''),
    exchange: exchangeOf(row.exSeg || row.exchange),
    transactiontype: sideOf(row.trnsTp || row.transactiontype),
    ordertype: orderTypeOf(row.prcTp || row.ordertype),
    producttype: String(row.prod || row.product || row.producttype || ''),
    variety: String(row.ordGenTp || row.variety || 'NORMAL'),
    quantity,
    filledshares: filled,
    unfilledshares: numberOf(row.unFldSz ?? row.pendingQty ?? Math.max(quantity - filled, 0)),
    price: numberOf(row.prc ?? row.price),
    averageprice: numberOf(row.avgPrc ?? row.averageprice),
    triggerprice: numberOf(row.trgPrc ?? row.trigPrc ?? row.triggerprice),
    status: String(row.ordSt || row.status || ''),
    orderstatus: String(row.ordSt || row.orderstatus || row.status || ''),
    updatetime: String(row.ordDtTm || row.flDtTm || row.exTm || row.updatetime || ''),
    text: String(row.rejRsn || row.text || ''),
  };
}

export function normalizeKotakTrade(row = {}, index = 0) {
  const quantity = numberOf(row.fldQty ?? row.qty ?? row.quantity);
  const price = numberOf(row.flPrc ?? row.avgPrc ?? row.prc ?? row.price);
  const fillTime = String(row.flDtTm || row.exTm || row.flDt || row.filltime || '');
  const orderId = String(row.nOrdNo || row.orderid || '');
  return {
    ...row,
    orderid: orderId,
    fillid: String(row.flId || row.tradeId || row.exTradeId || `${orderId}-${index + 1}`),
    tradingsymbol: String(row.trdSym || row.tradingsymbol || ''),
    symbolname: String(row.trdSym || row.symbolname || ''),
    exchange: exchangeOf(row.exSeg || row.exchange),
    transactiontype: sideOf(row.trnsTp || row.transactiontype),
    ordertype: orderTypeOf(row.prcTp || row.ordertype),
    producttype: String(row.prod || row.product || row.producttype || ''),
    fillsize: quantity,
    quantity,
    fillprice: price,
    price,
    tradevalue: price * quantity,
    filltime: fillTime,
    updatetime: fillTime,
  };
}

export async function orderBook(input) {
  const result = await requestReport(input, '/quick/user/orders');
  const rows = Array.isArray(result.raw?.data) ? result.raw.data : [];
  return {
    status: true,
    broker: 'kotak',
    orders: rows.map(normalizeKotakOrder),
    raw: result.raw,
    session: result.session,
  };
}

export async function tradeBook(input) {
  const result = await requestReport(input, '/quick/user/trades');
  const rows = Array.isArray(result.raw?.data) ? result.raw.data : [];
  return {
    status: true,
    broker: 'kotak',
    trades: rows.map(normalizeKotakTrade),
    raw: result.raw,
    session: result.session,
  };
}

export function normalizeKotakPosition(row = {}) {
  const dayBuyQty = numberOf(row.flBuyQty);
  const daySellQty = numberOf(row.flSellQty);
  const carryBuyQty = numberOf(row.cfBuyQty);
  const carrySellQty = numberOf(row.cfSellQty);
  const buyQty = dayBuyQty + carryBuyQty;
  const sellQty = daySellQty + carrySellQty;
  const buyAmount = numberOf(row.buyAmt) + numberOf(row.cfBuyAmt);
  const sellAmount = numberOf(row.sellAmt) + numberOf(row.cfSellAmt);
  const buyAvg = buyQty ? buyAmount / buyQty : 0;
  const sellAvg = sellQty ? sellAmount / sellQty : 0;
  const closedQty = Math.min(buyQty, sellQty);
  return {
    ...row,
    tradingsymbol: String(row.trdSym || row.tradingsymbol || ''),
    symbolname: String(row.sym || row.trdSym || row.symbolname || ''),
    exchange: exchangeOf(row.exSeg || row.exchange),
    producttype: String(row.prod || row.producttype || ''),
    netqty: numberOf(row.qty ?? row.netqty ?? (buyQty - sellQty)),
    buyqty: buyQty,
    sellqty: sellQty,
    totalbuyqty: buyQty,
    totalsellqty: sellQty,
    totalbuyvalue: buyAmount,
    totalsellvalue: sellAmount,
    buyavgprice: buyAvg,
    sellavgprice: sellAvg,
    totalbuyavgprice: buyAvg,
    totalsellavgprice: sellAvg,
    lotsize: numberOf(row.lotSz ?? row.brdLtQty ?? row.lotsize) || 1,
    strikeprice: numberOf(row.stkPrc ?? row.strikeprice),
    expirydate: String(row.expDt || row.expirydate || ''),
    optiontype: String(row.optTp || row.optiontype || ''),
    realised: (sellAvg - buyAvg) * closedQty,
    unrealised: 0,
    updatetime: String(row.hsUpTm || row.updatetime || ''),
  };
}

export async function positions(input) {
  const result = await requestReport(input, '/quick/user/positions');
  const rows = Array.isArray(result.raw?.data) ? result.raw.data : [];
  return {
    status: true,
    broker: 'kotak',
    positions: rows.map(normalizeKotakPosition),
    raw: result.raw,
    session: result.session,
  };
}

export async function limits(input, filters = {}) {
  const jData = {
    seg: String(filters.seg || 'ALL').toUpperCase(),
    exch: String(filters.exch || 'ALL').toUpperCase(),
    prod: String(filters.prod || 'ALL').toUpperCase(),
  };
  const result = await requestReport(input, '/quick/user/limits', { method: 'POST', jData });
  const data = result.raw || {};
  return {
    status: true,
    broker: 'kotak',
    filters: jData,
    limits: {
      availableCash: numberOf(data.Net),
      net: numberOf(data.Net),
      marginUsed: numberOf(data.MarginUsed),
      collateralValue: numberOf(data.CollateralValue),
      adhocMargin: numberOf(data.AdhocMargin),
      unrealizedMtm: numberOf(data.UnrealizedMtomPrsnt),
      realizedMtm: numberOf(data.RealizedMtomPrsnt),
    },
    raw: data,
    session: result.session,
  };
}

function marginRequest(order = {}) {
  const transactionType = order.trnsTp || order.transactionType || order.side;
  const required = {
    brkName: 'KOTAK',
    brnchId: 'ONLINE',
    exSeg: order.exSeg || order.exchangeSegment || ({
      NSE: 'nse_cm', NFO: 'nse_fo', BSE: 'bse_cm', BFO: 'bse_fo',
      CDS: 'cde_fo', MCX: 'mcx_fo',
    })[String(order.exchange || '').toUpperCase()],
    prc: order.prc ?? order.price,
    prcTp: order.prcTp || order.orderType,
    prod: order.prod || order.productType,
    qty: order.qty ?? order.quantity,
    tok: order.tok || order.token || order.symboltoken,
    trnsTp: transactionType,
  };
  required.prcTp = orderTypeOf(required.prcTp);
  required.prcTp = ({ LIMIT: 'L', MARKET: 'MKT', STOPLOSS_LIMIT: 'SL', STOPLOSS_MARKET: 'SL-M' })[required.prcTp] || required.prcTp;
  for (const key of ['exSeg', 'prc', 'prcTp', 'prod', 'qty', 'tok']) {
    if (required[key] == null || String(required[key]).trim() === '') throw new Error(`Kotak margin check needs ${key}`);
    required[key] = String(required[key]);
  }
  if (transactionType == null || String(transactionType).trim() === '') throw new Error('Kotak margin check needs trnsTp');
  required.trnsTp = sideOf(transactionType) === 'SELL' ? 'S' : 'B';
  for (const key of ['slAbsOrTks', 'slVal', 'sqrOffAbsOrTks', 'sqrOffVal', 'trailSL', 'trgPrc', 'tSLTks']) {
    if (order[key] != null && String(order[key]) !== '') required[key] = String(order[key]);
  }
  return required;
}

// Kotak's product codes. The shared leg shape speaks Angel's vocabulary, and
// marginRequest() passes `prod` through untouched, so 'CARRYFORWARD' would reach
// Kotak verbatim and be rejected - the translation has to happen here.
function kotakProduct(value, exchange) {
  const v = String(value || '').toUpperCase();
  const derivative = ['NFO', 'BFO', 'MCX', 'CDS'].includes(String(exchange || '').toUpperCase());
  switch (v) {
    case 'MIS':
    case 'INTRADAY':
      return 'MIS';
    case 'CNC':
    case 'DELIVERY':
      return derivative ? 'NRML' : 'CNC';
    case 'NRML':
    case 'CF':
    case 'CARRYFORWARD':
    default:
      return derivative ? 'NRML' : 'CNC';
  }
}

// Prices a whole strategy for Kotak.
//
// IMPORTANT - this is a GROSS figure, not a netted one. Angel and Kite both
// expose a basket calculator that offsets a hedge across the legs and returns
// the margin actually blocked. Kotak's /quick/user/check-margin prices ONE order
// at a time and has no basket equivalent, so the only thing available is to
// price each leg alone and add them up. For a hedged spread that OVERSTATES the
// margin - a bought leg that would have offset a sold one instead contributes
// its own margin on top. The result therefore carries netted:false so the
// caller can label it as an estimate rather than pass it off as a real figure.
export async function basketMargin(input = {}, legs = []) {
  const orders = [];
  for (const leg of legs || []) {
    const token = String(leg.token || leg.symbolToken || leg.symbol_token || '').trim();
    if (!token) continue;
    const quantity = Math.trunc((Number(leg.qty) || 0) * Math.max(Number(leg.lotSize) || 0, 1));
    if (quantity <= 0) continue;

    const exchange = String(leg.exchange || '').trim() || 'NFO';
    const isLimit = String(leg.orderType || 'MARKET').toUpperCase() === 'LIMIT';
    orders.push({
      token,
      exchange,
      qty: quantity,
      // Kotak's own note: market orders must send prc "0".
      prc: isLimit ? Number(leg.price) || 0 : 0,
      prcTp: isLimit ? 'LIMIT' : 'MARKET',
      prod: kotakProduct(leg.productType, exchange),
      trnsTp: leg.tradeType,
    });
    if (orders.length >= 50) break;
  }

  if (!orders.length) {
    return {
      status: true, broker: 'kotak', totalMarginRequired: 0, marginComponents: null, netted: false, empty: true,
    };
  }

  // Sequential on purpose: Kotak rate-limits, and each call reuses the one
  // session rather than racing several logins.
  let total = 0;
  let session;
  const priced = [];
  for (const order of orders) {
    const result = await checkMargin(input, order);
    session = result.session || session;
    // ordMrgn is "margin required for THIS order". reqdMrgn/totMrgnUsd are
    // account-level totals that already include margin used elsewhere, so
    // summing those across legs would multiply the account's existing usage.
    const value = Number(result.margin?.orderMargin || 0);
    total += value;
    priced.push({ token: order.token, margin: value });
  }

  return {
    status: true,
    broker: 'kotak',
    session,
    totalMarginRequired: total,
    // No SPAN/exposure split is available from this endpoint, and no hedge
    // benefit exists to report, so there is nothing honest to put here.
    marginComponents: null,
    netted: false,
    positionCount: orders.length,
    legs: priced,
  };
}

export async function checkMargin(input, order = {}) {
  const jData = marginRequest(order);
  const result = await requestReport(input, '/quick/user/check-margin', { method: 'POST', jData });
  const data = result.raw || {};
  return {
    status: true,
    broker: 'kotak',
    margin: {
      availableCash: numberOf(data.avlCash),
      availableMargin: numberOf(data.avlMrgn),
      insufficientFunds: numberOf(data.insufFund),
      marginUsed: numberOf(data.mrgnUsd),
      orderMargin: numberOf(data.ordMrgn),
      requiredMargin: numberOf(data.reqdMrgn),
      totalMarginUsed: numberOf(data.totMrgnUsd),
      rmsValidated: String(data.rmsVldtd || ''),
    },
    request: jData,
    raw: data,
    session: result.session,
  };
}
