import WebSocket from 'ws';

import {
  normalizeKotakPosition, sessionFromClient,
} from './kotak.js';

const HEARTBEAT_MS = 30_000;
const MAX_DEDUPE_KEYS = 2_000;

export function realtimeUrl(session) {
  const dc = String(session?.dataCenter || '').trim().toLowerCase();
  const hosts = {
    adc: 'cis.kotaksecurities.com',
    e21: 'e21.kotaksecurities.com',
    e22: 'e22.kotaksecurities.com',
    e41: 'e41.kotaksecurities.com',
    e43: 'e43.kotaksecurities.com',
  };
  if (hosts[dc]) return `wss://${hosts[dc]}/realtime`;
  try {
    const url = new URL(session.baseUrl);
    return `wss://${url.host}/realtime`;
  } catch {
    throw new Error('Kotak session has no valid websocket data center/base URL');
  }
}

function parseMessage(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { type: 'message', raw: text };
  }
}

export function normalizeKotakStreamMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const type = String(message.type || message.task || '').toLowerCase();
  const data = message.data && typeof message.data === 'object' ? message.data : message;
  if (type === 'order') {
    return { event: 'order', data: normalizeStreamOrder(data), raw: message };
  }
  if (type === 'position') {
    return { event: 'position', data: normalizeKotakPosition(data), raw: message };
  }
  if (type === 'cn' || String(message.ak || '').toLowerCase() === 'ok') {
    return { event: 'status', data: { status: true, connected: true, message: message.msg || 'Kotak stream connected' }, raw: message };
  }
  return { event: 'message', data: message, raw: message };
}

function normalizeStreamOrder(row) {
  const order = { ...row };
  const set = (key, condition, value) => { if (condition) order[key] = value; };
  set('orderid', row.nOrdNo != null || row.orderid != null, String(row.nOrdNo || row.orderid || ''));
  set('uniqueorderid', row.exOrdId != null || row.uniqueorderid != null, String(row.exOrdId || row.uniqueorderid || ''));
  set('exchangeorderid', row.exOrdId != null, String(row.exOrdId || ''));
  set('tradingsymbol', row.trdSym != null || row.sym != null, String(row.trdSym || row.sym || ''));
  set('symbolname', row.sym != null || row.trdSym != null, String(row.sym || row.trdSym || ''));
  set('orderstatus', row.ordSt != null || row.orderstatus != null, String(row.ordSt || row.orderstatus || ''));
  set('status', row.ordSt != null || row.status != null, String(row.ordSt || row.status || ''));
  set('quantity', row.qty != null, Number(row.qty) || 0);
  set('filledshares', row.fldQty != null, Number(row.fldQty) || 0);
  set('unfilledshares', row.unFldSz != null, Number(row.unFldSz) || 0);
  set('averageprice', row.avgPrc != null, Number(row.avgPrc) || 0);
  set('price', row.prc != null, Number(row.prc) || 0);
  set('transactiontype', row.trnsTp != null, String(row.trnsTp).toUpperCase().startsWith('S') ? 'SELL' : 'BUY');
  set('producttype', row.prod != null, String(row.prod || ''));
  set('ordertype', row.prcTp != null, String(row.prcTp || '').toUpperCase());
  set('exchange', row.exSeg != null, ({
    nse_cm: 'NSE', nse_fo: 'NFO', bse_cm: 'BSE', bse_fo: 'BFO', cde_fo: 'CDS', mcx_fo: 'MCX',
  })[String(row.exSeg).toLowerCase()] || String(row.exSeg).toUpperCase());
  set('updatetime', row.ordDtTm != null || row.exCfmTm != null, String(row.ordDtTm || row.exCfmTm || ''));
  return order;
}

function eventKey(event) {
  const data = event?.data || {};
  if (event?.event === 'order') {
    return `o|${data.orderid || data.nOrdNo || ''}|${data.updRecvTm || data.ordDtTm || ''}|${data.orderstatus || ''}|${data.filledshares || 0}`;
  }
  if (event?.event === 'position') {
    return `p|${data.actId || ''}|${data.tradingsymbol || data.symbolname || ''}|${data.updatetime || data.hsUpTm || ''}|${data.netqty || 0}`;
  }
  return '';
}

export class KotakUserStream {
  constructor(input, emit) {
    this.session = sessionFromClient(input);
    this.emit = emit;
    this.ws = null;
    this.heartbeat = null;
    this.closed = false;
    this.seen = new Set();
  }

  connect() {
    const url = realtimeUrl(this.session);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      if (this.closed || this.ws !== ws) return;
      // Kotak explicitly requires a raw JavaScript-object-like string here,
      // not JSON.stringify output.
      ws.send(`{type:cn,Authorization:${this.session.tradeToken},Sid:${this.session.sid},src:WEB}`);
      this.heartbeat = setInterval(() => {
        if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        try {
          // The official demo bypasses its quote-stripping wrapper for the
          // heartbeat and sends ordinary JSON on the native socket.
          ws.send(JSON.stringify({ type: 'hb' }));
        } catch {
          // close/error below hands reconnection to the SSE client.
        }
      }, HEARTBEAT_MS);
    });

    ws.on('message', (raw) => {
      const event = normalizeKotakStreamMessage(parseMessage(raw));
      if (!event) return;
      const key = eventKey(event);
      if (key && this.seen.has(key)) return;
      if (key) {
        this.seen.add(key);
        if (this.seen.size > MAX_DEDUPE_KEYS) this.seen.delete(this.seen.values().next().value);
      }
      this.emit(event.event, event.data);
    });

    ws.on('close', () => this.#down(ws, 'Kotak order/position stream closed'));
    ws.on('error', (error) => this.#down(ws, `Kotak stream error: ${error.message}`));
    return this;
  }

  #down(ws, message) {
    if (this.ws !== ws || this.closed) return;
    this.ws = null;
    this.#stopHeartbeat();
    this.emit('status', { status: false, connected: false, message });
    this.emit('end', { status: false, message });
  }

  #stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  close() {
    this.closed = true;
    this.#stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, 'SSE client closed');
    } catch {
      // Already closed.
    }
  }
}
