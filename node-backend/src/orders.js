// Margin, charges, and order placement for basket legs. Ports of the Go
// margin.go, charges.go, and orders.go.
import { mapData, strOr, toFloat, round2 } from './util.js';
import { withoutSession } from './auth.js';

const maxFloat = (a, b) => (a > b ? a : b);
const orDefault = (v, def) => (v ? v : def);

function tradeType(v) {
  return String(v || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
}

function orderType(v) {
  return String(v || '').toUpperCase() === 'LIMIT' ? 'LIMIT' : 'MARKET';
}

// basket product (CF/MIS) → Angel margin productType.
function mapProductType(v) {
  switch (String(orDefault(v, 'CF')).toUpperCase()) {
    case 'MIS':
    case 'INTRADAY':
      return 'INTRADAY';
    case 'DELIVERY':
    case 'CNC':
      return 'DELIVERY';
    case 'MARGIN':
      return 'MARGIN';
    default:
      return 'CARRYFORWARD';
  }
}

function mapChargeProduct(value, exchange) {
  const v = String(orDefault(value, 'CF')).toUpperCase();
  const derivative = ['NFO', 'BFO', 'MCX', 'CDS'].includes(String(exchange || '').toUpperCase());
  switch (v) {
    case 'MIS':
    case 'INTRADAY':
      return 'INTRADAY';
    case 'CF':
    case 'NRML':
    case 'CARRYFORWARD':
      return derivative ? 'CARRYFORWARD' : 'DELIVERY';
    case 'DELIVERY':
    case 'CNC':
      return 'DELIVERY';
    default:
      return derivative ? 'CARRYFORWARD' : 'DELIVERY';
  }
}

function legUnits(leg) {
  return Math.trunc((Number(leg.qty) || 0) * maxFloat(Number(leg.lotSize) || 0, 1));
}

// getMargin computes the netted basket margin via Angel's batch calculator.
export async function getMargin(client, auth, req) {
  const positions = [];
  for (const leg of req.legs || []) {
    if (!leg.token) continue;
    const units = legUnits(leg);
    if (units <= 0) continue;
    positions.push({
      exchange: orDefault(leg.exchange, 'NFO'),
      token: leg.token, // Angel's key is "token" (not "symboltoken")
      qty: units,
      price: Number(leg.price) || 0,
      productType: mapProductType(leg.productType),
      tradeType: tradeType(leg.tradeType),
      orderType: orderType(leg.orderType),
    });
    if (positions.length >= 50) break;
  }
  if (positions.length === 0) {
    return { status: true, totalMarginRequired: 0, marginComponents: null, empty: true };
  }

  let session = await auth.sessionOrLogin(req.client).catch(() => {
    throw new Error('Angel session unavailable for margin');
  });
  const headers = client.smartHeaders(req.client.apiKey);
  const body = { positions };

  let result;
  try {
    result = await client.doJSON('POST', '/rest/secure/angelbroking/margin/v1/batch', client.authHeaders(headers, session.jwtToken), body);
  } catch (err) {
    const relogin = await auth.autoLogin(withoutSession(req.client)).catch(() => null);
    if (!relogin) throw err;
    session = relogin.session;
    result = await client.doJSON('POST', '/rest/secure/angelbroking/margin/v1/batch', client.authHeaders(headers, session.jwtToken), body);
  }

  const data = mapData(result);
  return {
    status: true,
    totalMarginRequired: toFloat(data.totalMarginRequired),
    marginComponents: data.marginComponents,
    positionCount: positions.length,
    session,
  };
}

// getCharges estimates brokerage + statutory charges. Angel is picky: quantity
// and price must be STRINGS and price an INTEGER string, or it returns AB2001.
export async function getCharges(client, auth, req) {
  const orders = [];
  for (const leg of req.legs || []) {
    if (!leg.token || !leg.symbol) continue;
    const units = legUnits(leg);
    if (units <= 0) continue;
    orders.push({
      product_type: mapChargeProduct(leg.productType, leg.exchange),
      transaction_type: tradeType(leg.tradeType),
      quantity: String(units),
      price: String(Math.round(maxFloat(Number(leg.price) || 0, 0))),
      exchange: orDefault(leg.exchange, 'NFO'),
      symbol_name: leg.symbol,
      token: leg.token,
    });
    if (orders.length >= 50) break;
  }
  if (orders.length === 0) {
    return { status: true, totalCharges: 0, breakup: null, empty: true };
  }

  let session = await auth.sessionOrLogin(req.client).catch(() => {
    throw new Error('Angel session unavailable for charges');
  });
  const headers = client.smartHeaders(req.client.apiKey);
  const body = { orders };

  let result;
  try {
    result = await client.doJSON('POST', '/rest/secure/angelbroking/brokerage/v1/estimateCharges', client.authHeaders(headers, session.jwtToken), body);
  } catch (err) {
    const relogin = await auth.autoLogin(withoutSession(req.client)).catch(() => null);
    if (!relogin) throw err;
    session = relogin.session;
    result = await client.doJSON('POST', '/rest/secure/angelbroking/brokerage/v1/estimateCharges', client.authHeaders(headers, session.jwtToken), body);
  }

  const data = mapData(result);
  const summary = data.summary && typeof data.summary === 'object' ? data.summary : null;
  let total = 0;
  let breakup = null;
  if (summary) {
    total = toFloat(summary.total_charges);
    breakup = summary.breakup;
  }
  if (breakup == null) breakup = data.charges;
  return {
    status: true,
    totalCharges: total,
    breakup,
    orderCount: orders.length,
    session,
  };
}

// ── order placement ──────────────────────────────────────────────────────────

function placeOrderType(v) {
  const t = String(v || '').toUpperCase().trim();
  switch (t) {
    case 'LIMIT':
    case 'LMT':
      return 'LIMIT';
    case 'SL':
    case 'STOPLOSS_LIMIT':
      return 'STOPLOSS_LIMIT';
    case 'SL-M':
    case 'SLM':
    case 'STOPLOSS_MARKET':
      return 'STOPLOSS_MARKET';
    default:
      return 'MARKET';
  }
}

function priceString(v) {
  if (v <= 0) return '0';
  return (Math.round(v * 100) / 100).toFixed(2);
}

function placeLegLabel(leg) {
  return [leg.exchange, leg.symbol, tradeType(leg.tradeType)].filter(Boolean).join(' ').trim();
}

function placeOrderPayload(leg) {
  if (!leg.token) throw new Error('token missing');
  if (!leg.symbol) throw new Error('trading symbol missing');
  const units = legUnits(leg);
  if (units <= 0) throw new Error('quantity must be greater than zero');

  const type = placeOrderType(leg.orderType);
  let price = 0;
  const trigger = Math.max(0, Number(leg.triggerPrice) || 0);
  if (type === 'LIMIT' || type === 'STOPLOSS_LIMIT') {
    price = Math.max(0, Number(leg.price) || 0);
    if (price <= 0) throw new Error(`price required for ${type}`);
  }
  if (type === 'STOPLOSS_LIMIT' || type === 'STOPLOSS_MARKET') {
    if (trigger <= 0) throw new Error(`trigger price required for ${type}`);
  }

  return {
    variety: 'NORMAL',
    tradingsymbol: leg.symbol,
    symboltoken: leg.token,
    transactiontype: tradeType(leg.tradeType),
    exchange: orDefault(leg.exchange, 'NFO'),
    ordertype: type,
    producttype: mapProductType(leg.productType),
    duration: 'DAY',
    price: priceString(price),
    triggerprice: priceString(trigger),
    squareoff: '0',
    stoploss: '0',
    quantity: String(units),
    ordertag: 'alphahedge_basket',
  };
}

function placeOrderResult(order, result, err) {
  const row = {
    request: {
      tradingsymbol: order.tradingsymbol,
      symboltoken: order.symboltoken,
      transactiontype: order.transactiontype,
      exchange: order.exchange,
      ordertype: order.ordertype,
      producttype: order.producttype,
      quantity: order.quantity,
      price: order.price,
      triggerprice: order.triggerprice,
    },
  };
  if (err) {
    row.status = false;
    row.error = err.message;
    return row;
  }
  if (!result.status) {
    row.status = false;
    row.error = strOr(result.message, 'Order rejected');
    row.raw = result;
    return row;
  }
  const data = mapData(result);
  row.status = true;
  row.orderid = strOr(data.orderid, strOr(result.orderid, ''));
  row.uniqueorderid = strOr(data.uniqueorderid, '');
  row.raw = result;
  return row;
}

// placeBasket places each selected basket leg as a regular SmartAPI order.
export async function placeBasket(client, auth, req) {
  const orders = [];
  for (const leg of req.legs || []) {
    try {
      orders.push(placeOrderPayload(leg));
    } catch (err) {
      orders.push({ status: false, error: err.message, leg: placeLegLabel(leg) });
    }
    if (orders.length >= 50) break;
  }
  if (orders.length === 0) {
    return { status: true, empty: true, results: [] };
  }

  let session = await auth.sessionOrLogin(req.client).catch(() => {
    throw new Error('Angel session unavailable for placing orders');
  });
  const headers = client.smartHeaders(req.client.apiKey);

  const results = [];
  let relogged = false;
  for (const order of orders) {
    if (order.status === false && order.error != null) {
      results.push(order);
      continue;
    }
    let result;
    let err = null;
    try {
      result = await client.doJSON('POST', '/rest/secure/angelbroking/order/v1/placeOrder', client.authHeaders(headers, session.jwtToken), order);
    } catch (e) {
      err = e;
    }
    if (err && !relogged) {
      const relogin = await auth.autoLogin(withoutSession(req.client)).catch(() => null);
      if (relogin && relogin.session) {
        session = relogin.session;
        relogged = true;
        err = null;
        try {
          result = await client.doJSON('POST', '/rest/secure/angelbroking/order/v1/placeOrder', client.authHeaders(headers, session.jwtToken), order);
        } catch (e) {
          err = e;
        }
      }
    }
    results.push(placeOrderResult(order, result || {}, err));
  }

  let placed = 0;
  let failed = 0;
  for (const row of results) {
    if (row.status) placed++;
    else failed++;
  }
  return { status: failed === 0, placed, failed, results, session };
}

// normalizeBookRows / book reads (order-book, trade-book) kept for parity.
function normalizeBookRows(v) {
  if (Array.isArray(v)) return v.filter((r) => r && typeof r === 'object');
  if (v && typeof v === 'object') return [v];
  return [];
}

export async function book(client, auth, cc, pathName, key) {
  let session = await auth.sessionOrLogin(cc).catch(() => {
    throw new Error(`Angel session unavailable for ${key}`);
  });
  const headers = client.smartHeaders(cc.apiKey);
  let result;
  try {
    result = await client.doJSON('GET', pathName, client.authHeaders(headers, session.jwtToken), null);
  } catch (err) {
    const relogin = await auth.autoLogin(withoutSession(cc)).catch(() => null);
    if (!relogin) throw err;
    session = relogin.session;
    result = await client.doJSON('GET', pathName, client.authHeaders(headers, session.jwtToken), null);
  }
  return { status: true, [key]: normalizeBookRows(result.data), raw: result, session };
}

export { round2 };
