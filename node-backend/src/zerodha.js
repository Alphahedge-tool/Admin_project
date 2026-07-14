import crypto from 'node:crypto';

const KITE_API_BASE_URL = 'https://api.kite.trade';

function trim(value) {
  return String(value || '').trim();
}

function normalizeInput(input = {}) {
  const client = input.client && typeof input.client === 'object' ? input.client : input;
  const session = client.session && typeof client.session === 'object' ? client.session : null;
  return {
    apiKey: trim(client.apiKey || client.app_key || session?.apiKey || session?.api_key),
    apiSecret: trim(client.apiSecret || client.app_secret || session?.apiSecret || session?.api_secret),
    accessToken: trim(client.accessToken || client.access_token || session?.accessToken || session?.access_token),
    requestToken: trim(client.requestToken || client.request_token || session?.requestToken || session?.request_token),
    session,
  };
}

function statusText(value) {
  return trim(value).toUpperCase();
}

function assertLoginCreds(creds) {
  const missing = [];
  if (!creds.apiKey) missing.push('API key');
  if (!creds.apiSecret) missing.push('API secret');
  if (!creds.requestToken) missing.push('request token');
  if (missing.length) {
    throw new Error(`Zerodha login needs ${missing.join(', ')}`);
  }
}

function assertAccessCreds(creds) {
  const missing = [];
  if (!creds.apiKey) missing.push('API key');
  if (!creds.accessToken) missing.push('access token');
  if (missing.length) {
    throw new Error(`Zerodha portfolio calls need ${missing.join(', ')}`);
  }
}

function checksum(apiKey, requestToken, apiSecret) {
  return crypto.createHash('sha256').update(`${apiKey}${requestToken}${apiSecret}`).digest('hex');
}

function kiteHeaders(apiKey, accessToken) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Kite-Version': '3',
    Authorization: `token ${apiKey}:${accessToken}`,
  };
}

function mergedSession(creds, extra = {}) {
  return {
    ...(creds.session || {}),
    apiKey: creds.apiKey,
    accessToken: creds.accessToken || creds.session?.accessToken || creds.session?.access_token || '',
    loginAt: creds.session?.loginAt || creds.session?.login_at || extra.loginAt || '',
    lastUsedAt: new Date().toISOString(),
    ...extra,
  };
}

async function kiteRequest(path, {
  method = 'GET',
  input,
  body,
  query,
  form = false,
  timeoutMs = 20_000,
} = {}) {
  const creds = normalizeInput(input);
  assertAccessCreds(creds);

  const url = new URL(`${KITE_API_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'X-Kite-Version': '3',
      Authorization: `token ${creds.apiKey}:${creds.accessToken}`,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : { 'Content-Type': 'application/json' }),
    },
    body: body == null
      ? undefined
      : form
        ? (body instanceof URLSearchParams ? body.toString() : new URLSearchParams(body).toString())
        : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Zerodha returned an invalid response (HTTP ${response.status})`);
    }
  }

  if (!response.ok || parsed.status === 'error') {
    const message = parsed.message || parsed.error_type || parsed.error || `Zerodha HTTP ${response.status}`;
    // Carry Kite's own error_type and the HTTP status on the error. A dead access
    // token (TokenException / 403) has to be told apart from a real failure -
    // the first means "log in again", the second must not silently do that.
    const error = new Error(message);
    error.status = response.status;
    error.errorType = trim(parsed.error_type);
    throw error;
  }

  if (parsed.status && parsed.status !== 'success') {
    throw new Error(parsed.message || `Zerodha request failed (${parsed.status})`);
  }

  return {
    status: true,
    broker: 'zerodha',
    session: mergedSession(creds),
    data: parsed.data ?? parsed,
    raw: parsed,
  };
}

export function buildLoginUrl(apiKey) {
  const key = trim(apiKey);
  if (!key) throw new Error('Zerodha login URL needs an API key');
  return `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(key)}`;
}

export function buildHoldingsAuthoriseUrl(apiKey, requestId) {
  const key = trim(apiKey);
  const id = trim(requestId);
  if (!key) throw new Error('Zerodha holdings authorise URL needs an API key');
  if (!id) throw new Error('Zerodha holdings authorise URL needs a request id');
  return `https://kite.zerodha.com/connect/portfolio/authorise/holdings/${encodeURIComponent(key)}/${encodeURIComponent(id)}`;
}

// Kite kills the access token every morning (~6am IST). A saved one is therefore
// verified, never assumed - and a dead token is a "log in again", not an error.
function isDeadToken(error) {
  if (error?.errorType === 'TokenException') return true;
  if (error?.status === 403) return true;
  return /token|api_key|access_token|unauthor/i.test(String(error?.message || ''));
}

export async function profile(input = {}) {
  return kiteRequest('/user/profile', { method: 'GET', input });
}

export async function margins(input = {}) {
  return kiteRequest('/user/margins', { method: 'GET', input });
}

function availableCashOf(data = {}) {
  const equity = data.equity || {};
  return Number(
    equity.available?.live_balance
    ?? equity.available?.cash
    ?? equity.net
    ?? 0,
  );
}

/**
 * Zerodha's login, in the only shape Kite Connect allows.
 *
 * Kite has NO headless login - there is no PIN/TOTP endpoint to call, the user
 * has to go through kite.zerodha.com in a browser once. What can be automated is
 * everything either side of that:
 *
 *   1. a saved access token is REUSED, after checking it is still alive;
 *   2. a request token that the browser flow just produced is exchanged for one;
 *   3. and only when neither is available does this ask for the browser login,
 *      handing back the URL to open rather than throwing.
 *
 * Step 1 is what was missing: autoLogin demanded a request token every single
 * time, so a perfectly good saved token was ignored and every app start sent the
 * user back through the browser.
 */
export async function autoLogin(input = {}) {
  const creds = normalizeInput(input);

  // 1. Reuse a saved token, if it is still good.
  if (creds.apiKey && creds.accessToken && !creds.requestToken) {
    try {
      const me = await profile(input);
      const data = me.data || {};
      const session = mergedSession(creds, {
        userId: trim(data.user_id || creds.session?.userId || ''),
        userName: trim(data.user_name || creds.session?.userName || ''),
        userShortname: trim(data.user_shortname || creds.session?.userShortname || ''),
        broker: 'ZERODHA',
        loginSource: 'session',
      });

      let availableMargin = 0;
      try {
        const funds = await margins(input);
        availableMargin = availableCashOf(funds.data || {});
      } catch {
        // A funds hiccup must not discard a token the profile call just proved good.
      }

      return {
        status: true,
        broker: 'zerodha',
        clientCode: session.userId || creds.apiKey,
        availableMargin,
        marginSource: 'kite-margins',
        sessionSource: 'session',
        session,
        data,
      };
    } catch (error) {
      // A dead token falls through to the browser login below. Anything else is a
      // real failure and must not be papered over as "just log in again".
      if (!isDeadToken(error)) throw error;
    }
  }

  // 3. Nothing to exchange and nothing to reuse: the browser flow has to run.
  if (!creds.requestToken) {
    if (!creds.apiKey) throw new Error('Zerodha login needs an API key');
    return {
      status: false,
      needsLogin: true,
      broker: 'zerodha',
      loginUrl: buildLoginUrl(creds.apiKey),
      message: 'Zerodha needs a browser login - Kite Connect has no headless login.',
    };
  }

  // 2. Exchange the request token the browser flow just produced.
  assertLoginCreds(creds);

  const response = await fetch(`${KITE_API_BASE_URL}/session/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Kite-Version': '3',
    },
    body: new URLSearchParams({
      api_key: creds.apiKey,
      request_token: creds.requestToken,
      checksum: checksum(creds.apiKey, creds.requestToken, creds.apiSecret),
    }).toString(),
    signal: AbortSignal.timeout(20_000),
  });

  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Zerodha returned an invalid response (HTTP ${response.status})`);
  }

  if (!response.ok || body.status === 'error') {
    const message = body.message || body.error_type || body.error || `Zerodha HTTP ${response.status}`;
    throw new Error(message);
  }

  const data = body.data || body;
  const session = {
    apiKey: creds.apiKey,
    // Deliberately NOT the API secret. This session is handed to the browser and
    // saved there; the secret is only ever needed server-side, to sign this one
    // exchange. Reusing the token afterwards needs the api key and nothing else.
    accessToken: trim(data.access_token || ''),
    publicToken: trim(data.public_token || ''),
    userId: trim(data.user_id || ''),
    userName: trim(data.user_name || ''),
    userShortname: trim(data.user_shortname || ''),
    broker: 'ZERODHA',
    loginSource: 'request-token',
    loginAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };

  if (!session.accessToken) {
    throw new Error('Zerodha session token exchange returned no access token');
  }

  return {
    status: true,
    broker: 'zerodha',
    clientCode: session.userId || creds.apiKey,
    availableMargin: 0,
    marginSource: 'n/a',
    sessionSource: 'request-token',
    session,
    data,
  };
}

export function holdings(input = {}) {
  return kiteRequest('/portfolio/holdings', { method: 'GET', input });
}

export function positions(input = {}) {
  return kiteRequest('/portfolio/positions', { method: 'GET', input }).then((result) => ({
    ...result,
    positions: Array.isArray(result.data?.net) ? result.data.net.map(normalizePosition) : [],
    day: Array.isArray(result.data?.day) ? result.data.day.map(normalizePosition) : [],
  }));
}

export function holdingsAuctions(input = {}) {
  return kiteRequest('/portfolio/holdings/auctions', { method: 'GET', input });
}

function normalizeOrder(row = {}) {
  return {
    ...row,
    orderid: trim(row.order_id),
    order_id: trim(row.order_id),
    uniqueorderid: trim(row.guid || row.exchange_order_id || ''),
    exchangeorderid: row.exchange_order_id == null ? null : trim(row.exchange_order_id),
    parentorderid: row.parent_order_id == null ? null : trim(row.parent_order_id),
    orderstatus: statusText(row.status),
    status: statusText(row.status),
    ordertimestamp: trim(row.order_timestamp),
    order_timestamp: trim(row.order_timestamp),
    exchangetimestamp: trim(row.exchange_timestamp),
    exchange_timestamp: trim(row.exchange_timestamp),
    exchangeupdatetimestamp: trim(row.exchange_update_timestamp),
    exchange_update_timestamp: trim(row.exchange_update_timestamp),
    variety: trim(row.variety),
    modified: Boolean(row.modified),
    exchange: trim(row.exchange),
    tradingsymbol: trim(row.tradingsymbol),
    instrument_token: row.instrument_token,
    instrumenttoken: row.instrument_token,
    ordertype: statusText(row.order_type),
    transactiontype: statusText(row.transaction_type),
    validity: statusText(row.validity),
    producttype: statusText(row.product),
    product: statusText(row.product),
    quantity: Number(row.quantity || 0),
    disclosed_quantity: Number(row.disclosed_quantity || 0),
    price: Number(row.price || 0),
    trigger_price: Number(row.trigger_price || 0),
    average_price: Number(row.average_price || 0),
    averageprice: Number(row.average_price || 0),
    filled_quantity: Number(row.filled_quantity || 0),
    filledquantity: Number(row.filled_quantity || 0),
    filledshares: Number(row.filled_quantity || 0),
    pending_quantity: Number(row.pending_quantity || 0),
    pendingquantity: Number(row.pending_quantity || 0),
    cancelled_quantity: Number(row.cancelled_quantity || 0),
    cancelledquantity: Number(row.cancelled_quantity || 0),
    market_protection: Number(row.market_protection || 0),
    auction_number: trim(row.auction_number),
    meta: row.meta || {},
    tag: row.tag ?? null,
    text: trim(row.status_message || row.status_message_raw || ''),
  };
}

function normalizeTrade(row = {}) {
  const quantity = Number(row.quantity || 0);
  const price = Number(row.average_price || row.fill_price || row.price || 0);
  return {
    ...row,
    tradeid: trim(row.trade_id),
    trade_id: trim(row.trade_id),
    orderid: trim(row.order_id),
    exchangeorderid: row.exchange_order_id == null ? null : trim(row.exchange_order_id),
    exchange: trim(row.exchange),
    tradingsymbol: trim(row.tradingsymbol),
    symbolname: trim(row.tradingsymbol),
    instrument_token: row.instrument_token,
    instrumenttoken: row.instrument_token,
    producttype: statusText(row.product),
    product: statusText(row.product),
    averageprice: price,
    fillprice: price,
    price,
    quantity,
    fillsize: quantity,
    filledshares: quantity,
    transactiontype: statusText(row.transaction_type),
    filltime: trim(row.fill_timestamp),
    fill_timestamp: trim(row.fill_timestamp),
    ordertimestamp: trim(row.order_timestamp),
    order_timestamp: trim(row.order_timestamp),
    exchangetimestamp: trim(row.exchange_timestamp),
    exchange_timestamp: trim(row.exchange_timestamp),
    tradevalue: Number(row.trade_value || (price * quantity) || 0),
    fillid: trim(row.trade_id),
  };
}

function normalizePosition(row = {}) {
  const quantity = Number(row.quantity || row.net_quantity || row.netqty || 0);
  return {
    ...row,
    tradingsymbol: trim(row.tradingsymbol),
    symbolname: trim(row.tradingsymbol),
    exchange: trim(row.exchange),
    instrument_token: row.instrument_token,
    instrumenttoken: row.instrument_token,
    symboltoken: row.instrument_token,
    symbol_token: row.instrument_token,
    brokerToken: row.instrument_token,
    brokerExchange: trim(row.exchange),
    feedExchange: trim(row.exchange),
    producttype: trim(row.product),
    product: trim(row.product),
    stock_name: trim(row.tradingsymbol),
    quantity,
    netqty: quantity,
    netQty: quantity,
    net_qty: quantity,
    overnight_quantity: Number(row.overnight_quantity || 0),
    multiplier: Number(row.multiplier || 0),
    average_price: Number(row.average_price || 0),
    buyavgprice: Number(row.average_buy_price || row.buy_avg_price || row.average_price || 0),
    buyAvg: Number(row.average_buy_price || row.buy_avg_price || row.average_price || 0),
    sellavgprice: Number(row.average_sell_price || row.sell_avg_price || row.average_price || 0),
    sellAvg: Number(row.average_sell_price || row.sell_avg_price || row.average_price || 0),
    close_price: Number(row.close_price || 0),
    last_price: Number(row.last_price || 0),
    ltp: Number(row.last_price || row.ltp || 0),
    value: Number(row.value || 0),
    pnl: Number(row.pnl || 0),
    m2m: Number(row.m2m || 0),
    unrealised: Number(row.unrealised || 0),
    realised: Number(row.realised || 0),
    buy_quantity: Number(row.buy_quantity || 0),
    buy_price: Number(row.buy_price || 0),
    buy_value: Number(row.buy_value || 0),
    sell_quantity: Number(row.sell_quantity || 0),
    sell_price: Number(row.sell_price || 0),
    sell_value: Number(row.sell_value || 0),
    day_buy_quantity: Number(row.day_buy_quantity || 0),
    day_sell_quantity: Number(row.day_sell_quantity || 0),
  };
}

export function convertPosition(input = {}) {
  const payload = input.position && typeof input.position === 'object' ? input.position : input;
  const body = {
    tradingsymbol: trim(payload.tradingsymbol || payload.trading_symbol || payload.symbol),
    exchange: trim(payload.exchange),
    transaction_type: trim(payload.transaction_type || payload.transactionType || payload.side),
    position_type: trim(payload.position_type || payload.positionType || payload.scope),
    quantity: trim(payload.quantity),
    old_product: trim(payload.old_product || payload.oldProduct),
    new_product: trim(payload.new_product || payload.newProduct),
  };

  for (const key of Object.keys(body)) {
    if (!body[key]) {
      throw new Error(`Zerodha position conversion needs ${key}`);
    }
  }

  return kiteRequest('/portfolio/positions', {
    method: 'PUT',
    input,
    body,
    form: true,
    timeoutMs: 20_000,
  });
}

export function authoriseHoldings(input = {}) {
  const payload = input.authorisation && typeof input.authorisation === 'object'
    ? input.authorisation
    : (input.authorization && typeof input.authorization === 'object' ? input.authorization : input);
  const pairs = Array.isArray(payload.items) ? payload.items : [];

  const body = new URLSearchParams();
  for (const item of pairs) {
    const isin = trim(item.isin);
    const quantity = trim(item.quantity);
    if (!isin || !quantity) continue;
    body.append('isin', isin);
    body.append('quantity', quantity);
  }

  return kiteRequest('/portfolio/holdings/authorise', {
    method: 'POST',
    input,
    body,
    form: true,
    timeoutMs: 20_000,
  }).then((result) => ({
    ...result,
    requestId: result.data?.request_id || result.data?.requestId || '',
    authoriseUrl: result.data?.request_id
      ? buildHoldingsAuthoriseUrl(normalizeInput(input).apiKey, result.data.request_id)
      : '',
  }));
}

export const authorizeHoldings = authoriseHoldings;

export function orderBook(input = {}) {
  return kiteRequest('/orders', { method: 'GET', input }).then((result) => ({
    ...result,
    orders: Array.isArray(result.data) ? result.data.map(normalizeOrder) : [],
  }));
}

export function tradeBook(input = {}) {
  return kiteRequest('/trades', { method: 'GET', input }).then((result) => ({
    ...result,
    trades: Array.isArray(result.data) ? result.data.map(normalizeTrade) : [],
  }));
}

export function orderHistory(input = {}, orderId = '') {
  const id = trim(orderId || input.orderId || input.order_id);
  return kiteRequest(`/orders/${encodeURIComponent(id)}`, { method: 'GET', input }).then((result) => ({
    ...result,
    history: Array.isArray(result.data) ? result.data.map(normalizeOrder) : [],
    order: Array.isArray(result.data) ? normalizeOrder(result.data[0] || {}) : normalizeOrder(result.data || {}),
  }));
}

export function orderTrades(input = {}, orderId = '') {
  const id = trim(orderId || input.orderId || input.order_id);
  return kiteRequest(`/orders/${encodeURIComponent(id)}/trades`, { method: 'GET', input }).then((result) => ({
    ...result,
    trades: Array.isArray(result.data) ? result.data.map(normalizeTrade) : [],
  }));
}

export function placeOrder(input = {}) {
  const payload = input.order && typeof input.order === 'object' ? input.order : input;
  const variety = trim(payload.variety || 'regular').toLowerCase() || 'regular';
  const body = {
    tradingsymbol: trim(payload.tradingsymbol || payload.trading_symbol),
    exchange: trim(payload.exchange),
    transaction_type: trim(payload.transaction_type || payload.transactionType || payload.side),
    order_type: trim(payload.order_type || payload.orderType),
    quantity: trim(payload.quantity),
    product: trim(payload.product || payload.producttype),
    price: trim(payload.price),
    trigger_price: trim(payload.trigger_price || payload.triggerPrice),
    disclosed_quantity: trim(payload.disclosed_quantity || payload.disclosedQuantity),
    validity: trim(payload.validity),
    validity_ttl: trim(payload.validity_ttl || payload.validityTtl),
    iceberg_legs: trim(payload.iceberg_legs || payload.icebergLegs),
    iceberg_quantity: trim(payload.iceberg_quantity || payload.icebergQuantity),
    auction_number: trim(payload.auction_number || payload.auctionNumber),
    market_protection: trim(payload.market_protection || payload.marketProtection),
    autoslice: payload.autoslice != null ? String(payload.autoslice) : '',
    tag: trim(payload.tag),
  };
  const clean = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== ''));
  return kiteRequest(`/orders/${encodeURIComponent(variety)}`, { method: 'POST', input, body: clean, form: true });
}

export function modifyOrder(input = {}) {
  const payload = input.order && typeof input.order === 'object' ? input.order : input;
  const variety = trim(payload.variety || 'regular').toLowerCase() || 'regular';
  const orderId = trim(payload.order_id || payload.orderId);
  if (!orderId) throw new Error('Zerodha order modification needs order_id');
  const body = {
    tradingsymbol: trim(payload.tradingsymbol || payload.trading_symbol),
    exchange: trim(payload.exchange),
    transaction_type: trim(payload.transaction_type || payload.transactionType || payload.side),
    order_type: trim(payload.order_type || payload.orderType),
    quantity: trim(payload.quantity),
    product: trim(payload.product || payload.producttype),
    price: trim(payload.price),
    trigger_price: trim(payload.trigger_price || payload.triggerPrice),
    disclosed_quantity: trim(payload.disclosed_quantity || payload.disclosedQuantity),
    validity: trim(payload.validity),
    validity_ttl: trim(payload.validity_ttl || payload.validityTtl),
    market_protection: trim(payload.market_protection || payload.marketProtection),
    tag: trim(payload.tag),
  };
  const clean = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== ''));
  return kiteRequest(`/orders/${encodeURIComponent(variety)}/${encodeURIComponent(orderId)}`, {
    method: 'PUT',
    input,
    body: clean,
    form: true,
  });
}

export function cancelOrder(input = {}) {
  const payload = input.order && typeof input.order === 'object' ? input.order : input;
  const variety = trim(payload.variety || 'regular').toLowerCase() || 'regular';
  const orderId = trim(payload.order_id || payload.orderId);
  if (!orderId) throw new Error('Zerodha order cancel needs order_id');
  return kiteRequest(`/orders/${encodeURIComponent(variety)}/${encodeURIComponent(orderId)}`, {
    method: 'DELETE',
    input,
    form: true,
  });
}
