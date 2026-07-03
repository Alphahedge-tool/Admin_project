// Live feed: one upstream Angel SmartWebSocket V2 connection, an additive token
// union (on-screen chain + every basket leg), incremental subscribe/unsubscribe
// frames, and a fan-out to connected SSE clients. Port of the Go feed.go.
import WebSocket from 'ws';
import { SMART_STREAM_URL, config } from './config.js';

// Angel's hard limit: 1000 token subscriptions per WS session. Small safety margin.
const MAX_FEED_TOKENS = 990;

// exchange segment → SmartWebSocket exchangeType code.
const WS_EXCHANGE_TYPE = { NSE: 1, NFO: 2, BSE: 3, BFO: 4, MCX: 5, CDS: 7, NCDEX: 7 };
function wsType(exchange) {
  return WS_EXCHANGE_TYPE[exchange] ?? WS_EXCHANGE_TYPE.NFO;
}

const keyOf = (exType, token) => `${exType}|${token}`;
function splitKey(key) {
  const i = key.indexOf('|');
  if (i < 0) return [0, key];
  return [Number(key.slice(0, i)), key.slice(i + 1)];
}

export class Feed {
  constructor() {
    this.conn = null;
    this.creds = {};
    this.tokens = new Map(); // exType -> Set(token) — the union
    this.chainKeys = new Set(); // "type|token" for the current on-screen chain
    this.basketKeys = new Set(); // "type|token" the basket currently holds
    this.sseClients = new Set(); // Set of { write } handles
    this.pingTimer = null;
    this.idleCloseTimer = null;
  }

  // ── SSE client registry ─────────────────────────────────────────────────
  addClient(handle) {
    this.#cancelIdleClose();
    this.sseClients.add(handle);
    return this.conn != null;
  }

  removeClient(handle) {
    if (this.sseClients.delete(handle)) {
      if (this.sseClients.size === 0) this.#scheduleIdleClose();
    }
  }

  #scheduleIdleClose() {
    this.#cancelIdleClose();
    this.idleCloseTimer = setTimeout(() => {
      this.idleCloseTimer = null;
      if (this.sseClients.size === 0) this.#closeUpstream(true);
    }, 5000);
  }

  #cancelIdleClose() {
    if (this.idleCloseTimer) {
      clearTimeout(this.idleCloseTimer);
      this.idleCloseTimer = null;
    }
  }

  #broadcast(ev) {
    for (const h of this.sseClients) {
      try {
        h.write(ev);
      } catch {
        /* slow/broken client: skip */
      }
    }
  }

  #statusEvent(connected, message) {
    return { event: 'status', data: JSON.stringify({ connected, message }) };
  }

  // ── Subscription API ─────────────────────────────────────────────────────

  // Subscribe points the feed at a freshly loaded chain: drops the previous
  // chain's strikes (preserving basket-leg tokens) and (re)subscribes the union.
  subscribe(creds, exchange, tokens, spotToken, spotExchange) {
    if (!creds.jwtToken || !creds.feedToken) {
      throw new Error('Live feed needs an active session (jwtToken + feedToken)');
    }
    if (!tokens || tokens.length === 0) throw new Error('No tokens to subscribe');

    const entries = toEntries(exchange, tokens, spotToken, spotExchange);
    const newKeys = new Set(entries.map((e) => keyOf(e.exType, e.token)));

    const removed = [];
    for (const key of this.chainKeys) {
      if (newKeys.has(key) || this.basketKeys.has(key)) continue;
      const [exType, token] = splitKey(key);
      this.tokens.get(exType)?.delete(token);
      removed.push({ exType, token });
    }
    this.chainKeys = newKeys;
    this.creds = creds;
    const { added } = this.#merge(entries);

    this.#unsubscribe(groupEntries(removed));
    this.#startOrResubscribe(creds, added);
    return tokens.length;
  }

  // SetBasketTokensItems reconciles the feed to EXACTLY the basket's current leg
  // tokens (plus whatever the on-screen chain needs). Releases dropped tokens.
  setBasketTokensItems(creds, items) {
    const entries = [];
    for (const it of items || []) {
      if (!it.token) continue;
      entries.push({ exType: wsType(it.exchange), token: it.token });
    }

    let use = this.creds;
    if (creds && creds.jwtToken) use = creds;
    if (!use.jwtToken || !use.feedToken) {
      throw new Error('Live feed needs an active session (jwtToken + feedToken)');
    }
    this.creds = use;

    const newBasket = new Set(entries.map((e) => keyOf(e.exType, e.token)));

    const removed = [];
    for (const key of this.basketKeys) {
      if (newBasket.has(key) || this.chainKeys.has(key)) continue;
      const [exType, token] = splitKey(key);
      this.tokens.get(exType)?.delete(token);
      removed.push({ exType, token });
    }

    const { added, dropped } = this.#merge(entries);
    this.basketKeys = newBasket;
    const haveConn = this.conn != null;
    const total = this.#totalTokens();

    if (dropped > 0) {
      console.log(`[feed] basket sync hit the ${MAX_FEED_TOKENS}-token cap; ${dropped} dropped (total=${total})`);
    }

    this.#unsubscribe(groupEntries(removed));
    const addedCount = countGroups(added);
    if (addedCount > 0) {
      this.#startOrResubscribe(use, added);
    } else if (!haveConn) {
      this.#startOrResubscribe(use, this.#snapshot());
    }

    return { added: addedCount, removed: removed.length, dropped, total };
  }

  #totalTokens() {
    let n = 0;
    for (const set of this.tokens.values()) n += set.size;
    return n;
  }

  // merge adds entries to the union (respecting the cap) and returns the newly
  // added tokens grouped by exchangeType, plus how many were dropped (full).
  #merge(entries) {
    const added = new Map(); // exType -> [tokens]
    let total = this.#totalTokens();
    let dropped = 0;
    for (const e of entries) {
      if (!e.token) continue;
      if (!this.tokens.has(e.exType)) this.tokens.set(e.exType, new Set());
      const set = this.tokens.get(e.exType);
      if (set.has(e.token)) continue;
      if (total >= MAX_FEED_TOKENS) {
        dropped++;
        continue;
      }
      set.add(e.token);
      if (!added.has(e.exType)) added.set(e.exType, []);
      added.get(e.exType).push(e.token);
      total++;
    }
    return { added: groupsOf(added), dropped };
  }

  #snapshot() {
    const out = new Map();
    for (const [exType, set] of this.tokens) {
      if (set.size) out.set(exType, [...set]);
    }
    return groupsOf(out);
  }

  // ── Upstream WebSocket ───────────────────────────────────────────────────

  #startOrResubscribe(creds, groups) {
    if (this.conn && this.conn.readyState === WebSocket.OPEN) {
      this.#sendSubscribe(this.conn, groups);
      return;
    }
    if (!this.conn) this.#connect(creds);
  }

  #connect(creds) {
    const headers = {
      Authorization: creds.jwtToken, // raw JWT, no "Bearer "
      'x-api-key': creds.apiKey,
      'x-client-code': creds.clientCode,
      'x-feed-token': creds.feedToken,
    };

    let conn;
    try {
      conn = new WebSocket(SMART_STREAM_URL, { headers });
    } catch (err) {
      this.#broadcast(this.#statusEvent(false, 'Feed error: ' + err.message));
      return;
    }
    this.conn = conn;
    conn.binaryType = 'nodebuffer';

    conn.on('open', () => {
      this.#broadcast(this.#statusEvent(true, 'Live feed connected'));
      this.#sendSubscribe(conn, this.#snapshot());
      this.#startPing(conn);
    });

    conn.on('message', (data, isBinary) => {
      if (!isBinary) return; // pong/text/error frames
      const tick = parseTick(data);
      if (tick) this.#broadcast({ event: '', data: JSON.stringify(tick) });
    });

    const onDown = () => {
      if (this.conn === conn) {
        this.conn = null;
        this.#stopPing();
        this.#broadcast(this.#statusEvent(false, 'Live feed closed'));
      }
    };
    conn.on('close', onDown);
    conn.on('error', (err) => {
      this.#broadcast(this.#statusEvent(false, 'Feed error: ' + err.message));
      onDown();
    });
  }

  #sendSubscribe(conn, groups) {
    if (!groups.length || conn !== this.conn || conn.readyState !== WebSocket.OPEN) return;
    const tokenList = groups.map((g) => ({ exchangeType: g.exType, tokens: g.tokens }));
    const msg = { correlationID: 'sub', action: 1, params: { mode: 3, tokenList } };
    try {
      conn.send(JSON.stringify(msg));
    } catch (err) {
      if (config.feedDebug) console.log('[feed] subscribe write failed:', err.message);
    }
  }

  #unsubscribe(groups) {
    if (!groups.length) return;
    const conn = this.conn;
    if (!conn || conn.readyState !== WebSocket.OPEN) return;
    const tokenList = groups.map((g) => ({ exchangeType: g.exType, tokens: g.tokens }));
    const msg = { correlationID: 'basket-drop', action: 0, params: { mode: 3, tokenList } };
    try {
      conn.send(JSON.stringify(msg));
    } catch (err) {
      if (config.feedDebug) console.log('[feed] unsubscribe write failed:', err.message);
    }
  }

  #startPing(conn) {
    this.#stopPing();
    // Angel needs a ping ~every 10s.
    this.pingTimer = setInterval(() => {
      if (this.conn !== conn || conn.readyState !== WebSocket.OPEN) {
        this.#stopPing();
        return;
      }
      try {
        conn.send('ping');
      } catch {
        this.#stopPing();
      }
    }, 10000);
  }

  #stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  #closeUpstream(reset) {
    this.#cancelIdleClose();
    const conn = this.conn;
    this.conn = null;
    this.#stopPing();
    if (reset) {
      this.tokens = new Map();
      this.chainKeys = new Set();
      this.basketKeys = new Set();
      this.creds = {};
    }
    if (conn) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// parseTick decodes one SmartWebSocket V2 binary packet. Little-endian layout:
// [0]=mode [1]=exchangeType [2:27]=token (null-term ascii) [43:51]=LTP int64
// (paise ÷100). SNAP_QUOTE adds close at [115:123] and OI at [131:139].
function parseTick(buf) {
  if (buf.length < 51) return null;
  const rawToken = buf.toString('ascii', 2, 27);
  const token = rawToken.split('\x00')[0].replace(/[ \x00]+$/, '');
  if (!token) return null;
  const ltp = Number(buf.readBigInt64LE(43)) / 100;
  const tick = { token, ltp };
  if (buf.length >= 123) tick.close = Number(buf.readBigInt64LE(115)) / 100;
  if (buf.length >= 139) tick.oi = Number(buf.readBigInt64LE(131));
  return tick;
}

// ── helpers ──────────────────────────────────────────────────────────────

function toEntries(exchange, tokens, spotToken, spotExchange) {
  const entries = [];
  for (const t of tokens) if (t) entries.push({ exType: wsType(exchange), token: t });
  if (spotToken) {
    entries.push({ exType: wsType(spotExchange || exchange), token: spotToken });
  }
  return entries;
}

function groupsOf(map) {
  const out = [];
  for (const [exType, tokens] of map) {
    if (tokens.length) out.push({ exType, tokens });
  }
  out.sort((a, b) => a.exType - b.exType);
  return out;
}

function groupEntries(entries) {
  const m = new Map();
  for (const e of entries) {
    if (!e.token) continue;
    if (!m.has(e.exType)) m.set(e.exType, []);
    m.get(e.exType).push(e.token);
  }
  return groupsOf(m);
}

function countGroups(groups) {
  return groups.reduce((n, g) => n + g.tokens.length, 0);
}

export { wsType };
