import crypto from 'node:crypto';

import { generateTOTP } from './auth.js';

const KITE_API_BASE_URL = 'https://api.kite.trade';
const KITE_WEB = 'https://kite.zerodha.com';
const WEB_LOGIN_URL = `${KITE_WEB}/api/login`;
const TWOFA_URL = `${KITE_WEB}/api/twofa`;

// Browser user-agent so Kite's web login doesn't treat the fetch as a bot.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ZERODHA_DEBUG=1 traces the headless login hop chain. It logs URLs, statuses and
// cookie NAMES only — never the password, the TOTP, or any cookie value.
const DEBUG = /^(1|true|yes)$/i.test(process.env.ZERODHA_DEBUG || '');
function debug(...args) {
  if (DEBUG) console.log('[zerodha]', ...args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    // Headless auto-login creds. Kite's web login wants the numeric/user id, the
    // account password and the base32 TOTP secret to mint codes on the fly.
    userId: trim(client.userId || client.clientCode || client.account_id || session?.userId),
    password: trim(client.password || client.pin),
    totpSecret: trim(client.totpSecret || client.totp_secret),
    // Auto Login on by default; `manual` skips headless and asks for the popup.
    autoLogin: client.autoLogin !== false && client.auto_login !== false,
    manual: client.manual === true,
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

// exchangeRequestToken turns a one-time request_token into an access_token via
// the official /session/token endpoint — the same call the browser popup makes.
// `source` is recorded on the session so the UI can tell how login happened.
async function exchangeRequestToken(creds, source = 'request-token') {
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
  const now = new Date().toISOString();
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
    loginSource: source,
    loginAt: now,
    lastUsedAt: now,
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
    sessionSource: source,
    session,
    data,
  };
}

// --- Headless auto-login (no popup, no browser) ------------------------------
// Kite Connect has no login endpoint, but kite.zerodha.com's own web login is a
// plain cookie + JSON flow, so the whole thing runs on fetch(). Steps:
//   1. GET connect/login?v=3&api_key=..  Follow the redirects; the page we land
//      on sets the cookies and carries the sess_id Kite ties this attempt to.
//   2. POST /api/login  {user_id, password}            -> request_id
//   3. POST /api/twofa  {user_id, request_id, TOTP}    -> cookies now authorized
//   4. GET the step-1 URL again with &skip_session=true. With the cookies now
//      authorized, Kite redirects to the app's redirect_uri carrying
//      ?request_token=.., which we pluck off the Location header.
//   5. Exchange that request_token for an access_token — the same call the popup
//      flow makes, so everything downstream is identical.

// A minimal cookie jar. fetch() drops Set-Cookie between calls, but Kite carries
// the whole login across cookies, so we harvest and replay them by hand.
function cookieJar() {
  const jar = new Map();
  return {
    header() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    names() {
      return [...jar.keys()];
    },
    absorb(res) {
      const lines =
        typeof res.headers.getSetCookie === 'function'
          ? res.headers.getSetCookie()
          : [res.headers.get('set-cookie')].filter(Boolean);
      for (const line of lines) {
        const pair = line.split(';')[0];
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
  };
}

function jarHeaders(jar, extra = {}) {
  const cookie = jar.header();
  return { 'User-Agent': USER_AGENT, ...(cookie ? { Cookie: cookie } : {}), ...extra };
}

function requestTokenOf(url) {
  try {
    return new URL(url).searchParams.get('request_token') || '';
  } catch {
    return '';
  }
}

// jarGet walks the redirect chain itself (redirect: 'manual') for two reasons:
// fetch would not replay our cookies across hops, and we must STOP at the hop
// carrying request_token instead of chasing it into our own /zerodha/callback
// route — that route would exchange the token, and Kite only honours it once.
async function jarGet(jar, startUrl, maxHops = 10) {
  let url = startUrl;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: jarHeaders(jar, { Accept: 'text/html,application/xhtml+xml,*/*' }),
      signal: AbortSignal.timeout(20_000),
    });
    jar.absorb(res);
    const location = res.headers.get('location');
    debug(`GET ${res.status} ${url}`, location ? `-> ${location}` : '');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url).toString();
      const token = requestTokenOf(url);
      if (token) return { url, requestToken: token };
      continue;
    }
    if (res.status >= 400) throw new Error(`Zerodha login page returned HTTP ${res.status}`);
    return { url, requestToken: requestTokenOf(url) };
  }
  throw new Error('Zerodha login redirected too many times');
}

async function jarPost(jar, url, form, referer) {
  const res = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: jarHeaders(jar, {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'X-Kite-Version': '3',
      ...(referer ? { Referer: referer } : {}),
    }),
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20_000),
  });
  jar.absorb(res);
  const out = await res.json().catch(() => ({}));
  debug(`POST ${res.status} ${url} -> status=${out?.status || '?'} ${out?.message || ''}`);
  if (!res.ok || out.status === 'error') {
    throw new Error(out?.message || `Zerodha HTTP ${res.status}`);
  }
  return out;
}

const WINDOW_MS = 30_000;

// nearWindowEdge reports whether `atMs` sits in the last few seconds of its 30s
// TOTP window — the only zone where a same-window round-trip is likely to expire
// before Kite checks it.
function nearWindowEdge(atMs, edgeMs = 3_000) {
  return WINDOW_MS - (atMs % WINDOW_MS) <= edgeMs;
}

function msUntilNextWindow(atMs) {
  return WINDOW_MS - (atMs % WINDOW_MS) + 250;
}

// Kite reports a bad TOTP generically; point at the usual cause, which is a
// secret copied from the wrong place rather than a mistyped code.
function hintTOTPError(err) {
  if (/totp|two.?fa/i.test(err?.message || '')) {
    return new Error(
      `${err.message} — check the TOTP secret is the base32 key from Kite's ` +
        'External TOTP setup ("Can\'t scan? Copy key"), and that the server clock is in sync',
    );
  }
  return err;
}

// submitTOTP sends the 2FA code, retrying once if the first was generated in the
// dying seconds of its 30s window and could have expired in flight.
async function submitTOTP(jar, userId, totpSecret, requestId, twofaType, referer) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const genMs = Date.now();
    try {
      return await jarPost(
        jar,
        TWOFA_URL,
        {
          user_id: userId,
          request_id: requestId,
          twofa_value: generateTOTP(totpSecret),
          ...(twofaType ? { twofa_type: twofaType } : {}),
        },
        referer,
      );
    } catch (err) {
      if (attempt > 0 || !nearWindowEdge(genMs)) throw hintTOTPError(err);
      await sleep(msUntilNextWindow(genMs));
    }
  }
  throw new Error('Zerodha 2FA failed');
}

// headlessLogin runs the five steps above and returns a session envelope in the
// same shape as exchangeRequestToken, enriched with margin when available.
async function headlessLogin(creds) {
  if (!creds.userId || !creds.password || !creds.totpSecret) {
    throw new Error('Zerodha auto-login needs User ID, password and TOTP secret');
  }
  if (!creds.apiKey || !creds.apiSecret) {
    throw new Error('Zerodha auto-login needs API key and API secret');
  }

  const jar = cookieJar();

  // 1. Land on the login page (this seeds the cookies + sess_id).
  const entry = await jarGet(jar, buildLoginUrl(creds.apiKey));

  // 2. Password -> request_id.
  const login = await jarPost(jar, WEB_LOGIN_URL, { user_id: creds.userId, password: creds.password }, entry.url);
  const requestId = login?.data?.request_id;
  if (!requestId) throw new Error('Zerodha login did not return a request_id');

  // 3. TOTP -> the jar's cookies are now an authorized Kite session.
  await submitTOTP(jar, creds.userId, creds.totpSecret, requestId, login?.data?.twofa_type, entry.url);
  debug('2FA accepted; cookies now:', jar.names().join(', '));

  // 4. Replay the connect URL; skip_session=true makes Kite mint the token
  //    instead of showing the "you are already logged in" interstitial.
  const replay = new URL(entry.url);
  replay.searchParams.set('skip_session', 'true');
  const { url: landedUrl, requestToken } = await jarGet(jar, replay.toString());
  if (!requestToken) {
    // First-ever connection: 2FA passed but Kite parked us on the one-time app
    // Authorize screen. That screen clears only when a human clicks Authorize
    // once — Zerodha allows no headless path for it. Signal the UI to fall back
    // to the browser popup; every later headless login then sails through.
    if (/\/connect\/(authorize|finish)/.test(landedUrl || '')) {
      const err = new Error(
        'Zerodha needs a one-time app authorization: open the Kite login popup once and ' +
          'click "Authorize". After that, auto-login runs headless with no popup.',
      );
      err.needsAuthorize = true;
      throw err;
    }
    throw new Error(
      'Zerodha login succeeded but returned no request_token — check the API key is active ' +
        'and its redirect URL matches the one registered in the Kite developer console.',
    );
  }

  // 5. Same exchange the popup flow performs, then enrich with margin.
  const result = await exchangeRequestToken({ ...creds, requestToken }, 'auto-login');
  try {
    const funds = await margins({ apiKey: result.session.apiKey, accessToken: result.session.accessToken });
    result.availableMargin = availableCashOf(funds.data || {});
    result.marginSource = 'kite-margins';
  } catch {
    // The token is good; margins are optional for login status.
  }
  return result;
}

/**
 * Zerodha's login. Kite Connect itself has no login endpoint, but three things
 * can be automated, tried here in order:
 *
 *   1. a saved access token is REUSED, after checking it is still alive;
 *   2. a request token that the browser flow just produced is exchanged for one;
 *   3. HEADLESS login — kite.zerodha.com's web login (password + TOTP) is driven
 *      over fetch() with a cookie jar, so no browser popup is shown. This is the
 *      path the Broker Config auto-login switch takes.
 *
 * Only when none of those is possible does this ask for the browser popup,
 * handing back the URL to open rather than throwing. The one exception is the
 * very first connection for an app+account, where Kite demands a human click
 * "Authorize" once — headlessLogin flags that and the popup covers it.
 */
export async function autoLogin(input = {}) {
  const creds = normalizeInput(input);

  // 1. Reuse a saved token, if it is still good.
  if (creds.apiKey && creds.accessToken && !creds.requestToken) {
    try {
      const me = await profile(input);
      const data = me.data || {};
      const session = mergedSession(creds, {
        userId: trim(data.user_id || creds.session?.userId || creds.userId || ''),
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
      // A dead token falls through to a fresh login below. Anything else is a real
      // failure and must not be papered over as "just log in again".
      if (!isDeadToken(error)) throw error;
    }
  }

  // 2. Exchange a request token the browser callback just produced.
  if (creds.requestToken) {
    return exchangeRequestToken(creds);
  }

  // "Browser Login" button: skip headless and hand back the Kite popup URL. The
  // /zerodha/login-start + /zerodha/callback pair finishes the exchange.
  if (creds.manual) {
    if (!creds.apiKey) throw new Error('Zerodha login needs an API key');
    return {
      status: false,
      needsLogin: true,
      broker: 'zerodha',
      loginUrl: buildLoginUrl(creds.apiKey),
      message: 'Complete the Zerodha browser login to finish signing in.',
    };
  }

  // 3. Headless auto-login: password + TOTP drive Kite's web login, no popup.
  if (creds.autoLogin && creds.userId && creds.password && creds.totpSecret) {
    try {
      return await headlessLogin(creds);
    } catch (error) {
      // First-ever connection: 2FA passed but Kite is holding on the one-time app
      // Authorize screen. Don't surface it as an error — hand back a popup URL so
      // the user clicks Authorize once, then headless takes over from then on.
      if (error.needsAuthorize) {
        return {
          status: false,
          needsLogin: true,
          needsAuthorize: true,
          broker: 'zerodha',
          message: error.message,
          loginUrl: creds.apiKey ? buildLoginUrl(creds.apiKey) : '',
        };
      }
      throw error;
    }
  }

  // 4. Nothing to reuse, exchange or drive headlessly. Ask for the browser login,
  //    naming what a headless login would still need so the user can fill it in.
  if (!creds.apiKey) throw new Error('Zerodha login needs an API key');
  const missing = [];
  if (!creds.userId) missing.push('User ID');
  if (!creds.password) missing.push('Password');
  if (!creds.totpSecret) missing.push('TOTP Secret');
  return {
    status: false,
    needsLogin: true,
    broker: 'zerodha',
    loginUrl: buildLoginUrl(creds.apiKey),
    message: missing.length
      ? `Add ${missing.join(', ')} for headless login, or complete the browser login.`
      : 'Zerodha needs a browser login.',
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
    // Kite states neither strike, expiry nor option type on an order - decode them
    // from the symbol so the Order Book renders the contract, not the raw string.
    ...zerodhaContractFields(row.tradingsymbol, row),
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
    // Kite states neither strike, expiry nor option type on a trade - decode them
    // from the symbol so the Trade Book renders the contract, not the raw string.
    ...zerodhaContractFields(row.tradingsymbol, row),
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

const ZERODHA_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
// Zerodha's WEEKLY symbols compress the month to a single character: 1-9 for
// Jan-Sep, then O / N / D for Oct / Nov / Dec.
const ZERODHA_WEEKLY_MONTH = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, O: 10, N: 11, D: 12 };

// "26", 7, "21" -> "2026-07-21" (an exact calendar date the UI renders as such).
function isoExpiry(yy, month, dd) {
  return `20${yy}-${String(month).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

// A MONTHLY contract's symbol carries only its month and year - the expiry day is
// simply not in the string - so it is stated as "AUG2026", which the UI renders
// "Aug 2026". Inventing a day (last Thursday, etc.) would be a guess, and the
// expiry-day rules have changed more than once.
function monthlyExpiry(yy, mmm) {
  return `${mmm}20${yy}`;
}

/**
 * Decode a Zerodha NFO trading symbol into its parts.
 *
 * Zerodha names the contract ONLY in its trading symbol and repeats none of it as
 * separate fields on a position/order/trade row. Worse, its monthly form is
 * genuinely ambiguous once it is a bare string - NIFTY26AUG24000PE reads equally
 * as Angel's "26 AUG, year 24, strike 000" or Zerodha's "year 26, AUG, strike
 * 24000" - which is exactly what put a strike of 0 and a 2024 expiry on a 2026
 * contract. Decode it HERE, where we know it is Zerodha's grammar, and let the row
 * state each part outright the way Angel and Kotak already do.
 *
 *   Future           NIFTY26AUGFUT       ROOT + YY + MMM + FUT
 *   Monthly option   NIFTY26AUG24000PE   ROOT + YY + MMM + STRIKE + CE/PE
 *   Weekly option    NIFTY2672124000CE   ROOT + YY + M   + DD + STRIKE + CE/PE
 *
 * Returns null for a plain equity symbol (RELIANCE) or anything unrecognised, so
 * the caller leaves the row's symbol untouched.
 */
export function parseZerodhaContract(tradingsymbol) {
  const text = String(tradingsymbol || '').trim().toUpperCase();
  if (!text) return null;

  // Future: ROOT + YY + MMM + FUT
  let m = text.match(/^([A-Z&]+?)(\d{2})([A-Z]{3})FUT$/);
  if (m && ZERODHA_MONTHS.includes(m[3])) {
    return { name: m[1], expiry: monthlyExpiry(m[2], m[3]), strike: '', optionType: '', instrumentType: 'FUT' };
  }

  // Monthly option: ROOT + YY + MMM + STRIKE + CE/PE. The 3-letter month must be a
  // real month, else this is a weekly whose single-char month happens to be a
  // letter (O/N/D) - fall through to the weekly form below.
  m = text.match(/^([A-Z&]+?)(\d{2})([A-Z]{3})(\d+)(CE|PE)$/);
  if (m && ZERODHA_MONTHS.includes(m[3])) {
    return { name: m[1], expiry: monthlyExpiry(m[2], m[3]), strike: Number(m[4]), optionType: m[5], instrumentType: m[5] };
  }

  // Weekly option: ROOT + YY + M + DD + STRIKE + CE/PE
  m = text.match(/^([A-Z&]+?)(\d{2})([1-9OND])(\d{2})(\d+)(CE|PE)$/);
  if (m) {
    const month = ZERODHA_WEEKLY_MONTH[m[3]];
    if (month) {
      return { name: m[1], expiry: isoExpiry(m[2], month, m[4]), strike: Number(m[5]), optionType: m[6], instrumentType: m[6] };
    }
  }

  return null;
}

// The root, strike, expiry and option type decoded from a Zerodha trading symbol,
// in the shape the position, order and trade rows all carry them - so every book
// renders a contract identically instead of each re-deriving it from the raw, and
// always ambiguous, symbol (NIFTY26AUG24000PE). A plain equity, or anything
// unrecognised, keeps the row's own values.
function zerodhaContractFields(tradingsymbol, row = {}) {
  const contract = parseZerodhaContract(tradingsymbol);
  const name = contract ? contract.name : trim(tradingsymbol);
  return {
    symbolname: name,
    stock_name: name,
    strikeprice: contract && contract.strike !== '' ? contract.strike : (row.strikeprice ?? ''),
    expirydate: contract ? contract.expiry : (row.expirydate || ''),
    optiontype: contract ? contract.optionType : (row.optiontype || ''),
    instrumenttype: contract ? contract.instrumentType : (row.instrumenttype || ''),
  };
}

function normalizePosition(row = {}) {
  const quantity = Number(row.quantity || row.net_quantity || row.netqty || 0);
  return {
    ...row,
    tradingsymbol: trim(row.tradingsymbol),
    // Kite states neither strike, expiry nor option type - decode them from the
    // symbol so "NIFTY · Aug 2026 · 24000 · PE" shows instead of the raw string.
    ...zerodhaContractFields(row.tradingsymbol, row),
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
