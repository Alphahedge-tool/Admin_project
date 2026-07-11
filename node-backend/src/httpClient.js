// SmartAPI HTTP client: connection-reusing fetch, per-endpoint rate limiting,
// a short-TTL quote cache with request coalescing (singleflight), and a JWT
// liveness-validation cache. Port of the Go client.go + cache.go.
import { SMARTAPI_BASE, QUOTE_CACHE_TTL_MS, SESSION_VALID_TTL_MS, config } from './config.js';

// Conservative req/sec caps per SmartAPI endpoint prefix (kept just under the
// documented ceiling so we never eat a 429/ban).
//
// Angel answers a breach with a bare 403 and no JSON body - which reads exactly
// like an auth failure. Anything NOT listed here falls back to DEFAULT_LIMIT, so
// an endpoint with a low real ceiling that is missing from this table gets
// hammered at 8/sec and 403s: keep login, getRMS and getPosition here.
const ENDPOINT_LIMITS = {
  '/rest/auth/angelbroking/user/v1/loginByPassword': 1,
  '/rest/secure/angelbroking/user/v1/getRMS': 2,
  '/rest/secure/angelbroking/order/v1/getPosition': 1,
  '/rest/secure/angelbroking/order/v1/placeOrder': 18,
  '/rest/secure/angelbroking/order/v1/getOrderBook': 1,
  '/rest/secure/angelbroking/order/v1/getTradeBook': 1,
  '/rest/secure/angelbroking/order/v1/details': 9,
  '/rest/secure/angelbroking/market/v1/quote': 9,
  '/rest/secure/angelbroking/order/v1/getLtpData': 9,
  '/rest/secure/angelbroking/margin/v1/batch': 9,
  '/rest/secure/angelbroking/brokerage/v1/estimateCharges': 9,
  '/rest/secure/angelbroking/marketData/v1/optionGreek': 9,
  '/rest/secure/angelbroking/historical/v1/getCandleData': 3,
};
const DEFAULT_LIMIT = 8;

// Angel throttles with 403 (and 429); 503 is its "try again" blip. All three are
// transient, so the request is retried with backoff instead of being reported as
// a failure - or, worse, mistaken for a dead session and answered with a login.
const TRANSIENT_STATUS = new Set([403, 429, 503]);
const TRANSIENT_RETRIES = 2;
const TRANSIENT_BACKOFF_MS = [700, 1500];

// Replaying these is not safe: an order could be placed twice, and a login would
// reuse a TOTP inside its 30s window (which Angel rejects).
const NEVER_RETRY = new Set([
  '/rest/secure/angelbroking/order/v1/placeOrder',
  '/rest/auth/angelbroking/user/v1/loginByPassword',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A dead/expired token - the ONLY thing worth answering with a fresh login.
// A 403 is not: it is how Angel says "you are going too fast".
export function isAuthFailure(err) {
  if (err?.status === 401) return true;
  return /invalid token|token expired|expired token|invalid session|unauthor/i.test(String(err?.message || ''));
}

export function isThrottled(err) {
  if (err?.status === 403 || err?.status === 429) return true;
  return /exceeding access rate|too many requests|rate limit/i.test(String(err?.message || ''));
}

function limitKey(endpoint) {
  const orderDetails = '/rest/secure/angelbroking/order/v1/details';
  if (endpoint.startsWith(orderDetails)) return orderDetails;
  return endpoint;
}

// Token-bucket limiter: refills `rate` tokens/sec up to `burst`. wait() resolves
// once a token is available (queuing callers rather than firing and getting
// throttled).
//
// The accounting is serialized through a promise chain: two callers arriving at
// once used to read the same token count, both find it "free" and both fire -
// which is how a 1/sec endpoint still got two hits in the same second (Client
// Dashboard and Get Position are mounted together and both read positions).
class RateLimiter {
  constructor(rate, burst) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.last = Date.now();
    this.chain = Promise.resolve();
  }

  #refill() {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    this.last = now;
  }

  wait() {
    this.chain = this.chain.then(() => this.#take(), () => this.#take());
    return this.chain;
  }

  async #take() {
    this.#refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const needed = (1 - this.tokens) / this.rate;
    await sleep(Math.ceil(needed * 1000));
    this.#refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }
}

class LimiterSet {
  constructor() {
    this.limiters = new Map();
  }

  get(endpoint) {
    const key = limitKey(endpoint);
    let lim = this.limiters.get(key);
    if (lim) return lim;
    const rate = ENDPOINT_LIMITS[key] ?? DEFAULT_LIMIT;
    lim = new RateLimiter(rate, Math.max(1, Math.floor(rate)));
    this.limiters.set(key, lim);
    return lim;
  }

  wait(endpoint) {
    return this.get(endpoint).wait();
  }
}

// Tiny TTL cache + singleflight in front of Angel's quote endpoint: concurrent
// identical reads collapse into ONE upstream call, and repeats within the TTL
// are served locally.
class QuoteCache {
  constructor() {
    this.entries = new Map(); // key -> { value, expires }
    this.inflight = new Map(); // key -> Promise
  }

  #get(key) {
    const e = this.entries.get(key);
    if (!e || Date.now() > e.expires) return undefined;
    return e.value;
  }

  #set(key, value) {
    this.entries.set(key, { value, expires: Date.now() + QUOTE_CACHE_TTL_MS });
    if (this.entries.size > 512) {
      const now = Date.now();
      for (const [k, e] of this.entries) if (now > e.expires) this.entries.delete(k);
    }
  }

  async do(key, fn) {
    const cached = this.#get(key);
    if (cached !== undefined) return cached;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = (async () => {
      const hit = this.#get(key);
      if (hit !== undefined) return hit;
      const res = await fn();
      this.#set(key, res);
      return res;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}

// Remembers which JWTs recently passed a liveness probe, so repeated
// authenticated calls don't re-validate the session every time.
class ValidationCache {
  constructor() {
    this.seen = new Map(); // jwt -> timestamp
  }

  fresh(jwt) {
    if (!jwt) return false;
    const t = this.seen.get(jwt);
    return t != null && Date.now() - t < SESSION_VALID_TTL_MS;
  }

  mark(jwt) {
    if (!jwt) return;
    this.seen.set(jwt, Date.now());
    if (this.seen.size > 256) {
      const cutoff = Date.now() - SESSION_VALID_TTL_MS;
      for (const [k, t] of this.seen) if (t < cutoff) this.seen.delete(k);
    }
  }
}

export class Client {
  constructor() {
    this.limiters = new LimiterSet();
    this.cache = new QuoteCache();
    this.valid = new ValidationCache();
  }

  // Standard SmartAPI header set for a given API key.
  smartHeaders(apiKey) {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': config.localIP,
      'X-ClientPublicIP': config.publicIP,
      'X-MACAddress': config.macAddress,
      'X-PrivateKey': apiKey,
    };
  }

  // Clone base headers and add the bearer token.
  authHeaders(base, jwt) {
    return { ...base, Authorization: 'Bearer ' + jwt };
  }

  // Rate-limited request to a SmartAPI endpoint; decodes the JSON envelope.
  // Throws on non-2xx with the API's message when present, and the HTTP status on
  // `err.status` so callers can tell "throttled" from "dead session".
  // Transient answers (403/429/503) are backed off and retried here, so they
  // never reach a caller that would mistake them for an auth failure.
  async doJSON(method, endpoint, headers, body) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#send(method, endpoint, headers, body);
      } catch (err) {
        const retryable = TRANSIENT_STATUS.has(err.status) && !NEVER_RETRY.has(limitKey(endpoint));
        if (!retryable || attempt >= TRANSIENT_RETRIES) throw err;
        await sleep(TRANSIENT_BACKOFF_MS[attempt] ?? 1500);
      }
    }
  }

  async #send(method, endpoint, headers, body) {
    await this.limiters.wait(endpoint);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let resp;
    try {
      resp = await fetch(SMARTAPI_BASE + endpoint, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const raw = await resp.text();
    let out = {};
    if (raw) {
      try {
        out = JSON.parse(raw);
      } catch {
        out = {};
      }
    }
    if (resp.status < 200 || resp.status >= 300) {
      const msg = (out && out.message) || `SmartAPI HTTP ${resp.status}`;
      const err = new Error(msg);
      err.status = resp.status;
      err.body = out;
      throw err;
    }
    return out;
  }

  // Market quote, coalescing identical concurrent requests within the cache TTL.
  quote(headers, jwt, mode, exchange, tokens) {
    const key = `quote|${mode}|${exchange}|${tokens.join(',')}`;
    return this.cache.do(key, () =>
      this.doJSON('POST', '/rest/secure/angelbroking/market/v1/quote', this.authHeaders(headers, jwt), {
        mode,
        exchangeTokens: { [exchange]: tokens },
      })
    );
  }
}
