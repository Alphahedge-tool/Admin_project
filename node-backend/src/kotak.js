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
    data: { baseUrl: session.baseUrl, greetingName: session.greeting },
  };
}
