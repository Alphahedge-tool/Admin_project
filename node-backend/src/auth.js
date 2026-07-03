// Auth: RFC-6238 TOTP generation + AutoLogin (session reuse or fresh TOTP login)
// + sessionOrLogin. Port of the Go auth.go.
import crypto from 'node:crypto';
import { mapData, strOr, toFloat } from './util.js';

// resolveSession returns the client's usable session (with API key filled in)
// or null when there's no JWT.
export function resolveSession(cc) {
  if (cc.session && cc.session.jwtToken) {
    return { ...cc.session, apiKey: cc.apiKey };
  }
  return null;
}

// withoutSession clones creds with the session dropped (forces a fresh login).
export function withoutSession(cc) {
  return { ...cc, session: null };
}

// generateTOTP produces the current 6-digit RFC-6238 TOTP (SHA-1, 30s step)
// for a base32 secret.
export function generateTOTP(secret) {
  const clean = String(secret || '').toUpperCase().replace(/\s/g, '').replace(/=+$/, '');
  const key = base32Decode(clean);
  if (!key || key.length === 0) throw new Error('Invalid TOTP secret');

  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));

  const mac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of input) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error('Invalid TOTP secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export class Auth {
  constructor(client) {
    this.client = client;
  }

  // AutoLogin reuses an existing session (validated via getRMS) or performs a
  // fresh TOTP login. Returns the RMS response envelope the frontend expects.
  async autoLogin(cc) {
    if (!cc.clientCode || !cc.apiKey) {
      throw new Error('User ID and API key are required');
    }
    const headers = this.client.smartHeaders(cc.apiKey);

    const existing = resolveSession(cc);
    if (existing) {
      try {
        const res = await this.#trySessionRMS(cc, headers, existing);
        if (res) return res;
      } catch {
        // fall through to fresh login
      }
    }

    const login = await this.#loginWithTotp(cc, headers);
    return this.#rmsResultFromLogin(cc, headers, login, 'totp-login');
  }

  async #trySessionRMS(cc, headers, s) {
    const rms = await this.#getRMS(headers, s.jwtToken);
    s.lastUsedAt = new Date().toISOString();
    s.lastRms = rms.data || null;
    this.client.valid.mark(s.jwtToken);
    return buildRMSResponse(cc.clientCode, mapData(rms), 'session', s);
  }

  async #loginWithTotp(cc, headers) {
    if (!cc.pin || !cc.totpSecret) {
      throw new Error('PIN and TOTP secret are required');
    }
    const totp = generateTOTP(cc.totpSecret);
    const login = await this.client.doJSON(
      'POST',
      '/rest/auth/angelbroking/user/v1/loginByPassword',
      headers,
      { clientcode: cc.clientCode, password: cc.pin, totp }
    );
    if (!login.status) {
      throw new Error(strOr(login.message, 'SmartAPI login failed'));
    }
    if (mapData(login).jwtToken == null) {
      throw new Error('SmartAPI login returned no jwtToken');
    }
    return login;
  }

  async #rmsResultFromLogin(cc, headers, login, source) {
    const data = mapData(login);
    const jwt = strOr(data.jwtToken, '');
    const rms = await this.#getRMS(headers, jwt);
    const now = new Date().toISOString();
    const s = {
      apiKey: cc.apiKey,
      jwtToken: jwt,
      refreshToken: strOr(data.refreshToken, ''),
      feedToken: strOr(data.feedToken, ''),
      loginSource: source,
      loginAt: now,
      lastUsedAt: now,
      lastRms: rms.data || null,
    };
    this.client.valid.mark(s.jwtToken);
    return buildRMSResponse(cc.clientCode, mapData(rms), source, s);
  }

  async #getRMS(headers, jwt) {
    const rms = await this.client.doJSON(
      'GET',
      '/rest/secure/angelbroking/user/v1/getRMS',
      this.client.authHeaders(headers, jwt),
      null
    );
    if (!rms.status) {
      throw new Error(strOr(rms.message, 'RMS margin request failed'));
    }
    return rms;
  }

  // sessionOrLogin returns a VALID session for the client, logging in if needed.
  // A stored session is trusted only after its JWT passed a recent liveness
  // probe (within the TTL); otherwise AutoLogin re-validates or re-logins.
  async sessionOrLogin(cc) {
    const s = resolveSession(cc);
    if (s && this.client.valid.fresh(s.jwtToken)) return s;
    try {
      const res = await this.autoLogin(cc);
      if (res && res.session) return res.session;
    } catch (err) {
      if (s) return s;
      throw err;
    }
    if (s) return s;
    throw new Error('Angel session unavailable');
  }
}

function buildRMSResponse(clientCode, data, source, s) {
  return {
    status: true,
    clientCode,
    availableMargin: pickMargin(data),
    marginSource: pickMarginSource(data),
    sessionSource: source,
    session: s,
    data,
  };
}

function pickMargin(data) {
  for (const k of ['net', 'availablecash', 'availablelimitmargin', 'collateral']) {
    if (data[k] != null) return toFloat(data[k]);
  }
  return 0;
}

function pickMarginSource(data) {
  for (const k of ['net', 'availablecash', 'availablelimitmargin', 'collateral']) {
    if (data[k] != null) return k;
  }
  return 'unknown';
}
