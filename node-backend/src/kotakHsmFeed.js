import WebSocket from 'ws';

import { sessionFromClient } from './kotak.js';

const HSM_URL = process.env.KOTAK_HSM_URL || 'wss://mlhsm.kotaksecurities.com';
const MAX_INSTRUMENTS = 200;
const MAX_PER_FRAME = 100;
const MAX_CHANNELS = 16;
const TRASH = -2147483648;
const TYPES = { CONNECTION: 1, THROTTLE: 2, ACK: 3, SUBSCRIBE: 4, UNSUBSCRIBE: 5, DATA: 6 };
const SNAP = 83;
const UPDATE = 85;
const SEGMENTS = {
  NSE: 'nse_cm', BSE: 'bse_cm', NFO: 'nse_fo', BFO: 'bse_fo',
  CDS: 'cde_fo', MCX: 'mcx_fo',
};
const EXCHANGES = Object.fromEntries(Object.entries(SEGMENTS).map(([exchange, segment]) => [segment, exchange]));

function segmentOf(value) {
  const raw = String(value || '').trim();
  return SEGMENTS[raw.toUpperCase()] || raw.toLowerCase();
}

function withLength(build) {
  const parts = [];
  const writer = {
    byte(value) { parts.push(Buffer.from([value & 255])); },
    short(value) { const b = Buffer.alloc(2); b.writeUInt16BE(value); parts.push(b); },
    int(value) { const b = Buffer.alloc(4); b.writeInt32BE(value); parts.push(b); },
    string(value) { parts.push(Buffer.from(String(value), 'utf8')); },
    raw(value) { parts.push(value); },
  };
  build(writer);
  const body = Buffer.concat(parts);
  const frame = Buffer.alloc(body.length + 2);
  frame.writeUInt16BE(body.length);
  body.copy(frame, 2);
  return frame;
}

export function hsmConnectionFrame(token, sid) {
  return withLength((w) => {
    w.byte(TYPES.CONNECTION);
    w.byte(3);
    for (const [field, value] of [[1, token], [2, sid], [3, 'JS_API']]) {
      const text = String(value || '');
      w.byte(field);
      w.short(Buffer.byteLength(text));
      w.string(text);
    }
  });
}

function scripArray(items, prefix) {
  const names = items.map((item) => `${prefix}|${item.segment}|${item.token}`);
  const parts = [Buffer.alloc(2)];
  parts[0].writeUInt16BE(names.length);
  for (const name of names) {
    const bytes = Buffer.from(name, 'utf8');
    parts.push(Buffer.from([bytes.length & 255]), bytes);
  }
  return Buffer.concat(parts);
}

export function hsmSubscriptionFrame(items, { unsubscribe = false, prefix = 'sf', channel = 1 } = {}) {
  const array = scripArray(items, prefix);
  return withLength((w) => {
    w.byte(unsubscribe ? TYPES.UNSUBSCRIBE : TYPES.SUBSCRIBE);
    w.byte(2);
    w.byte(1);
    w.short(array.length);
    w.raw(array);
    w.byte(2);
    w.short(1);
    w.byte(channel);
  });
}

function hsmAckFrame(number) {
  return withLength((w) => {
    w.byte(TYPES.ACK);
    w.byte(1);
    w.byte(1);
    w.short(4);
    w.int(number);
  });
}

function hsmThrottleFrame() {
  return withLength((w) => {
    w.byte(TYPES.THROTTLE);
    w.byte(1);
    w.byte(1);
    w.short(4);
    w.int(0);
  });
}

function chunks(items, size = MAX_PER_FRAME) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

export function hsmSubscriptionFrames(items, options = {}) {
  return chunks(items).map((batch, index) => hsmSubscriptionFrame(batch, {
    ...options,
    channel: ((Number(options.channel || 1) - 1 + index) % MAX_CHANNELS) + 1,
  }));
}

function normalizeItem(item = {}) {
  const token = String(item.brokerToken || item.symboltoken || item.token || '').trim();
  const segment = segmentOf(item.brokerExchange || item.feedExchange || item.segment || item.exchange);
  if (!token || !segment) return null;
  const prefix = /^\d+$/.test(token) ? 'sf' : 'if';
  return { token, segment, prefix, key: `${prefix}|${segment}|${token}` };
}

function topicFromName(name) {
  const [prefix, segment, ...rest] = String(name || '').split('|');
  if (!['sf', 'if', 'dp'].includes(prefix)) return null;
  return {
    prefix, segment, token: rest.join('|'), fields: new Array(100).fill(null),
    multiplier: 1, precision: 2,
  };
}

function topicTick(topic) {
  const fields = topic.fields;
  const multiplierIndex = topic.prefix === 'sf' ? 23 : topic.prefix === 'if' ? 8 : 32;
  const precisionIndex = topic.prefix === 'sf' ? 24 : topic.prefix === 'if' ? 9 : 33;
  topic.multiplier = fields[multiplierIndex] || topic.multiplier || 1;
  topic.precision = fields[precisionIndex] ?? topic.precision ?? 2;
  const divisor = topic.multiplier * (10 ** topic.precision);
  const price = (index) => (fields[index] == null ? undefined : fields[index] / divisor);
  const integer = (index) => (fields[index] == null ? undefined : fields[index]);
  const base = {
    broker: 'kotak',
    exchange: EXCHANGES[topic.segment] || topic.segment.toUpperCase(),
    segment: topic.segment,
    token: topic.token,
  };
  if (topic.prefix === 'if') {
    const ltp = price(2);
    return ltp == null ? null : {
      ...base, ltp, close: price(3), high: price(5), low: price(6), open: price(7),
    };
  }
  if (topic.prefix === 'sf') {
    const ltp = price(5);
    return ltp == null ? null : {
      ...base,
      ltp,
      volume: integer(4),
      totalBuyQty: integer(7),
      totalSellQty: integer(8),
      bid: price(9),
      ask: price(10),
      bidQty: integer(11),
      askQty: integer(12),
      low: price(14),
      high: price(15),
      open: price(20),
      close: price(21),
      oi: integer(22),
    };
  }
  return null;
}

export class KotakHsmFeed {
  constructor(id) {
    this.id = id;
    this.session = null;
    this.sessionKey = '';
    this.groups = new Map();
    this.items = new Map();
    this.clients = new Set();
    this.lastTicks = new Map();
    this.topics = new Map();
    this.ws = null;
    this.connected = false;
    this.ackEvery = 0;
    this.dataCount = 0;
    this.retryCount = 0;
    this.retryTimer = null;
    this.keepAlive = null;
  }

  sync(input, requested, subscriber = 'get-positions') {
    const session = sessionFromClient(input);
    const nextSessionKey = `${session.sid}|${session.tradeToken}`;
    const normalized = (requested || []).map(normalizeItem).filter(Boolean);
    const group = new Map(normalized.map((item) => [item.key, item]));
    this.groups.set(String(subscriber || 'get-positions'), group);
    const previous = this.items;
    const union = new Map();
    let dropped = 0;
    for (const entries of this.groups.values()) {
      for (const [key, item] of entries) {
        if (union.has(key)) continue;
        if (union.size >= MAX_INSTRUMENTS) { dropped++; continue; }
        union.set(key, item);
      }
    }
    this.items = union;

    const authChanged = this.sessionKey && this.sessionKey !== nextSessionKey;
    this.session = session;
    this.sessionKey = nextSessionKey;
    if (authChanged) this.#disconnect(false);

    const removed = [...previous.values()].filter((item) => !union.has(item.key));
    const added = [...union.values()].filter((item) => !previous.has(item.key));
    if (this.connected) {
      this.#sendItems(removed, true);
      // Re-send the caller's full group so HSM emits an immediate snapshot.
      this.#sendItems([...group.values()], false);
    } else if (union.size) {
      this.#connect();
    } else {
      this.#disconnect(false);
    }
    return { total: union.size, added: added.length, removed: removed.length, dropped };
  }

  addClient(client) {
    this.clients.add(client);
    client.write(this.#statusEvent());
    for (const tick of this.lastTicks.values()) client.write({ event: '', data: JSON.stringify(tick) });
    if (!this.ws && this.items.size) this.#connect();
  }

  removeClient(client) {
    this.clients.delete(client);
  }

  status() {
    return { id: this.id, connected: this.connected, subscribers: this.groups.size, instruments: this.items.size, clients: this.clients.size };
  }

  #statusEvent(message) {
    return {
      event: 'status',
      data: JSON.stringify({ connected: this.connected, message: message || (this.connected ? 'Kotak HSM connected' : 'Kotak HSM offline') }),
    };
  }

  #broadcast(event) {
    for (const client of this.clients) {
      try { client.write(event); } catch { /* broken SSE client */ }
    }
  }

  #connect() {
    if (this.ws || !this.session || !this.items.size) return;
    clearTimeout(this.retryTimer);
    let ws;
    try { ws = new WebSocket(HSM_URL); } catch (error) {
      this.#scheduleReconnect(error.message);
      return;
    }
    this.ws = ws;
    ws.binaryType = 'nodebuffer';
    ws.on('open', () => {
      if (this.ws !== ws) return;
      ws.send(hsmConnectionFrame(this.session.tradeToken, this.session.sid));
      this.#startKeepAlive(ws);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary && this.ws === ws) this.#onFrame(data);
    });
    ws.on('close', () => this.#down(ws, 'Kotak HSM closed'));
    ws.on('error', (error) => this.#down(ws, `Kotak HSM error: ${error.message}`));
  }

  #down(ws, message) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.connected = false;
    this.#stopKeepAlive();
    this.#broadcast(this.#statusEvent(message));
    this.#scheduleReconnect(message);
  }

  #scheduleReconnect() {
    if (!this.items.size || !this.session || this.retryTimer) return;
    const delay = Math.min(1000 * (2 ** this.retryCount), 15_000);
    this.retryCount += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.#connect();
    }, delay);
  }

  #disconnect(clearGroups) {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connected = false;
    this.#stopKeepAlive();
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* already closed */ }
    this.topics.clear();
    if (clearGroups) { this.groups.clear(); this.items.clear(); }
  }

  #startKeepAlive(ws) {
    this.#stopKeepAlive();
    this.keepAlive = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      try { ws.ping(); ws.send(hsmThrottleFrame()); } catch { /* close handler reconnects */ }
    }, 30_000);
  }

  #stopKeepAlive() {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  #sendItems(items, unsubscribe) {
    const ws = this.ws;
    if (!this.connected || !ws || ws.readyState !== WebSocket.OPEN || !items.length) return;
    const byPrefix = new Map();
    for (const item of items) {
      if (!byPrefix.has(item.prefix)) byPrefix.set(item.prefix, []);
      byPrefix.get(item.prefix).push(item);
    }
    let channel = 1;
    for (const [prefix, entries] of byPrefix) {
      for (const frame of hsmSubscriptionFrames(entries, { unsubscribe, prefix, channel })) {
        ws.send(frame);
        channel = channel % MAX_CHANNELS + 1;
      }
    }
  }

  #onFrame(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return;
    let position = 2;
    const type = buffer.readUInt8(position++);
    try {
      if (type === TYPES.CONNECTION) this.#connectionAck(buffer, position);
      else if (type === TYPES.DATA) this.#data(buffer, position);
    } catch {
      // Drop a malformed packet; the next snapshot/update repairs state.
    }
  }

  #connectionAck(buffer, position) {
    const count = buffer.readUInt8(position++);
    if (!count) return;
    position += 1;
    const length = buffer.readUInt16BE(position); position += 2;
    const status = buffer.toString('utf8', position, position + length); position += length;
    if (count >= 2) {
      position += 1;
      const ackLength = buffer.readUInt16BE(position); position += 2;
      this.ackEvery = Number(buffer.readUIntBE(position, Math.min(ackLength, 6)) || 0);
    }
    if (status !== 'K') {
      this.#broadcast(this.#statusEvent('Kotak HSM authentication failed'));
      this.#disconnect(false);
      return;
    }
    this.connected = true;
    this.retryCount = 0;
    this.topics.clear();
    this.#broadcast(this.#statusEvent('Kotak HSM connected'));
    this.#sendItems([...this.items.values()], false);
  }

  #data(buffer, position) {
    if (this.ackEvery > 0) {
      this.dataCount += 1;
      const number = buffer.readInt32BE(position); position += 4;
      if (this.dataCount === this.ackEvery) {
        this.dataCount = 0;
        this.ws?.send(hsmAckFrame(number));
      }
    }
    const count = buffer.readUInt16BE(position); position += 2;
    for (let index = 0; index < count; index++) {
      const size = buffer.readUInt16BE(position); position += 2;
      const start = position;
      const kind = buffer.readUInt8(position++);
      let topic;
      if (kind === SNAP) {
        const id = buffer.readInt32BE(position); position += 4;
        const nameLength = buffer.readUInt8(position++);
        const name = buffer.toString('utf8', position, position + nameLength); position += nameLength;
        topic = topicFromName(name);
        if (topic) this.topics.set(id, topic);
      } else if (kind === UPDATE) {
        const id = buffer.readInt32BE(position); position += 4;
        topic = this.topics.get(id);
      }
      if (!topic) { position = start + size; continue; }
      const fieldCount = buffer.readUInt8(position++);
      for (let field = 0; field < fieldCount; field++) {
        const value = buffer.readInt32BE(position); position += 4;
        if (value !== TRASH) topic.fields[field] = value;
      }
      if (kind === SNAP) {
        const stringCount = buffer.readUInt8(position++);
        for (let field = 0; field < stringCount; field++) {
          const id = buffer.readUInt8(position++);
          const length = buffer.readUInt8(position++);
          const value = buffer.toString('utf8', position, position + length); position += length;
          if (id === 52) topic.token = value;
          else if (id === 53) topic.segment = value;
          else if (id === 54) topic.symbol = value;
        }
      }
      const tick = topicTick(topic);
      if (tick) {
        if (topic.symbol) tick.symbol = topic.symbol;
        this.lastTicks.set(`${tick.segment}|${tick.token}`, tick);
        this.#broadcast({ event: '', data: JSON.stringify(tick) });
      }
      position = start + size;
    }
  }
}

export class KotakHsmRegistry {
  constructor() { this.feeds = new Map(); }
  get(id) {
    const key = String(id || '').trim();
    if (!key) throw new Error('Kotak feedId is required');
    if (!this.feeds.has(key)) this.feeds.set(key, new KotakHsmFeed(key));
    return this.feeds.get(key);
  }
  status() { return [...this.feeds.values()].map((feed) => feed.status()); }
}
