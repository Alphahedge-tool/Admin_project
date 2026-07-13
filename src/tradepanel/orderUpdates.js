import { useCallback, useEffect, useRef, useState } from 'react';
import { isKotakBroker, saveBookSession } from './brokerBookClient';

// The one order-status stream, shared by Get Position, Get OrderBook and Get
// TradeBook. Brokers never push "your position/book changed" - they only push
// order status changes - so this stream is the only thing standing between
// those three tables and reality, and every one of them was reading it with its
// own copy of the same subtly broken plumbing:
//
//   - the stream was started from inside load(), whose first act was to abort
//     the previous stream. A fill triggers a refresh, so a fill tore down and
//     reconnected the very stream that had just delivered it - and anything
//     that filled during the reconnect (the next leg of a basket exit) was
//     never seen at all.
//   - a stream that ENDED (server close, token expiry, proxy timeout) was never
//     reconnected. readOrderStream() simply returned, the page went on claiming
//     to be "live", and no update ever arrived again for the rest of the session.
//   - OrderBook only started the stream on load()'s success path, so an order
//     book that failed to fetch once - a rate limit is enough - never connected.
//
// So the connection lives here instead: owned by an effect, reconnected with
// backoff, and reporting a status the pill can actually be trusted to show.

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;

// Angel's websocket order-status codes.
const STATUS_LABELS = {
  AB00: '',
  AB01: 'open',
  AB02: 'cancelled',
  AB03: 'rejected',
  AB04: 'modified',
  AB05: 'complete',
  AB06: 'amo received',
  AB07: 'amo cancelled',
  AB08: 'amo modify received',
  AB09: 'open pending',
  AB10: 'trigger pending',
  AB11: 'modify pending',
};

export function orderStatusCodeLabel(code) {
  return STATUS_LABELS[code] || '';
}

export function normalizeSocketOrder(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload.orderData;
  if (!data || typeof data !== 'object') return null;
  if (!data.orderid && !data.uniqueorderid && !data.tradingsymbol) return null;

  return {
    ...data,
    orderstatus: data.orderstatus || data.status || orderStatusCodeLabel(payload['order-status']),
    status: data.status || data.orderstatus || orderStatusCodeLabel(payload['order-status']),
    websocketStatusCode: payload['order-status'] || '',
    websocketStatusText: payload['error-message'] || '',
  };
}

// Did this order actually move the books? A completed order obviously did - but
// so did a PARTIALLY filled one, and Angel reports that as an open (or later
// cancelled) order carrying a non-zero filled quantity, not as a "complete".
// Matching only on complete/traded meant a partial fill never refreshed
// anything, and the position table sat there disagreeing with the order book
// until the order happened to fill in full - or never did.
export function orderIsFill(order) {
  if (!order) return false;

  const status = String(order.orderstatus || order.status || '').toLowerCase();
  if (status.includes('complete') || status.includes('traded')) return true;
  if (status.includes('reject')) return false;

  return Number(order.filledshares ?? order.filledShares ?? order.filledqty ?? 0) > 0;
}

function handleStreamChunk(chunk, handlers) {
  if (!chunk) return;
  let event = 'message';
  let data = '';
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data += line.slice(5).trim();
  }

  let payload = null;
  try {
    payload = data ? JSON.parse(data) : null;
  } catch {
    payload = { raw: data };
  }

  if (event === 'session') handlers.onSession?.(payload?.session);
  else if (event === 'order') handlers.onOrder?.(payload);
  else if (event === 'position') handlers.onPosition?.(payload);
  else if (event === 'status') handlers.onStatus?.(payload);
  else if (event === 'error') handlers.onError?.(payload);
}

async function readOrderStream(body, handlers) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      handleStreamChunk(chunk, handlers);
      boundary = buffer.indexOf('\n\n');
    }
  }
}

/**
 * Subscribes to one account's order-status stream for as long as the account is
 * selected, and keeps it up: it reconnects with backoff whenever the stream
 * drops or the server ends it.
 *
 * onOrder(order)   - a normalized order update arrived.
 * onResync()       - the stream came back after having been down. Whatever
 *                    happened while it was down was never pushed, so the caller
 *                    has to re-fetch rather than wait for an update that has
 *                    already been and gone.
 *
 * Returns 'offline' | 'connecting' | 'live'.
 */
const sharedOrderHubs = new Map();

function hasStreamToken(brokerName, client) {
  return isKotakBroker(brokerName)
    ? !!(client?.session?.tradeToken && client.session.sid && client.session.baseUrl)
    : !!client?.session?.jwtToken;
}

function directKotakOrder(payload) {
  const order = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  if (!order || typeof order !== 'object') return null;
  if (!order.orderid && !order.nOrdNo && !order.tradingsymbol && !order.sym) return null;
  return order;
}

function createOrderHub(key, configId, brokerName) {
  const hub = {
    key,
    configId,
    brokerName,
    listeners: new Set(),
    status: 'offline',
    controller: null,
    retryTimer: 0,
    retries: 0,
    stopped: false,
    connectedOnce: false,
    connecting: false,
  };

  hub.notifyStatus = (status) => {
    hub.status = status;
    hub.listeners.forEach((listener) => listener.setStatus(status));
  };
  hub.currentClient = () => {
    for (const listener of hub.listeners) {
      const candidate = listener.clientRef.current;
      if (hasStreamToken(hub.brokerName, candidate)) return candidate;
    }
    return null;
  };
  hub.schedule = () => {
    if (hub.stopped || !hub.listeners.size || hub.retryTimer) return;
    const delay = Math.min(RETRY_BASE_MS * (2 ** hub.retries), RETRY_MAX_MS);
    hub.retries += 1;
    hub.retryTimer = window.setTimeout(() => {
      hub.retryTimer = 0;
      hub.connect();
    }, delay);
  };
  hub.markConnected = () => {
    if (hub.status === 'live') return;
    hub.retries = 0;
    hub.notifyStatus('live');
    if (hub.connectedOnce) hub.listeners.forEach((listener) => listener.onResyncRef.current?.());
    hub.connectedOnce = true;
  };
  hub.connect = async () => {
    if (hub.stopped || hub.connecting || !hub.listeners.size) return;
    const streamClient = hub.currentClient();
    if (!streamClient) {
      hub.notifyStatus('offline');
      hub.schedule();
      return;
    }
    hub.connecting = true;
    hub.controller = new AbortController();
    hub.notifyStatus('connecting');
    const broker = isKotakBroker(hub.brokerName) ? 'kotak' : 'angel';
    try {
      const response = await fetch(`/api/${broker}/order-updates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: streamClient }),
        signal: hub.controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`Order stream HTTP ${response.status}`);
      await readOrderStream(response.body, {
        onSession: (session) => {
          if (!session) return;
          const token = isKotakBroker(hub.brokerName) ? session.tradeToken : session.jwtToken;
          const currentToken = isKotakBroker(hub.brokerName)
            ? hub.currentClient()?.session?.tradeToken
            : hub.currentClient()?.session?.jwtToken;
          if (token && token !== currentToken) saveBookSession(hub.configId, hub.brokerName, session);
        },
        onOrder: (payload) => {
          const order = isKotakBroker(hub.brokerName) ? directKotakOrder(payload) : normalizeSocketOrder(payload);
          if (!order) {
            if (payload?.['order-status'] === 'AB00') hub.markConnected();
            return;
          }
          if (hub.status !== 'live') hub.markConnected();
          hub.listeners.forEach((listener) => listener.onOrderRef.current?.(order));
        },
        onPosition: (payload) => {
          if (hub.status !== 'live') hub.markConnected();
          hub.listeners.forEach((listener) => listener.onPositionRef.current?.(payload));
        },
        onStatus: (payload) => {
          if (payload?.status === false || payload?.connected === false) hub.notifyStatus('offline');
          else hub.markConnected();
        },
        onError: () => hub.notifyStatus('offline'),
      });
      if (hub.stopped) return;
      hub.notifyStatus('offline');
      hub.schedule();
    } catch {
      if (!hub.stopped && !hub.controller?.signal.aborted) {
        hub.notifyStatus('offline');
        hub.schedule();
      }
    } finally {
      hub.connecting = false;
    }
  };
  hub.stop = () => {
    hub.stopped = true;
    clearTimeout(hub.retryTimer);
    hub.controller?.abort();
    hub.listeners.clear();
  };
  return hub;
}

export function useOrderUpdates({
  configId, client, brokerName = 'angel', enabled = true, onOrder, onPosition, onResync,
}) {
  const [status, setStatus] = useState('offline');

  // The stream outlives individual renders, so it reaches the current client and
  // handlers through refs. Passing an inline arrow as onOrder must not reconnect
  // it - reconnecting is exactly the bug this hook exists to end.
  const clientRef = useRef(null);
  const onOrderRef = useRef(null);
  const onPositionRef = useRef(null);
  const onResyncRef = useRef(null);

  useEffect(() => { clientRef.current = client; }, [client]);
  useEffect(() => { onOrderRef.current = onOrder; }, [onOrder]);
  useEffect(() => { onPositionRef.current = onPosition; }, [onPosition]);
  useEffect(() => { onResyncRef.current = onResync; }, [onResync]);

  // A token has to exist to connect at all, but its VALUE is deliberately not a
  // dependency: connect() re-reads the client, so a mid-session token refresh is
  // picked up without restarting the stream (and without looping, since the
  // stream itself is what hands the refreshed token back).
  const hasToken = hasStreamToken(brokerName, client);
  const active = Boolean(configId) && enabled && hasToken;
  const brokerKey = isKotakBroker(brokerName) ? 'kotak' : 'angel';

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const key = `${brokerKey}:${configId}`;
    let hub = sharedOrderHubs.get(key);
    if (!hub) {
      hub = createOrderHub(key, configId, brokerName);
      sharedOrderHubs.set(key, hub);
    }
    const listener = { clientRef, onOrderRef, onPositionRef, onResyncRef, setStatus };
    hub.listeners.add(listener);
    hub.connect();

    return () => {
      hub.listeners.delete(listener);
      setStatus('offline');
      if (!hub.listeners.size) {
        hub.stop();
        sharedOrderHubs.delete(key);
      }
    };
  }, [active, brokerKey, brokerName, configId]);

  return active ? status : 'offline';
}

/**
 * Coalesces a burst of fills into a single refresh.
 *
 * A broker's book/position snapshot lags the fill it just pushed, and a
 * multi-leg exit fills one leg at a time - so refetching on each push both
 * hammers the broker and risks pinning a pre-fill snapshot on screen. Instead
 * the burst is refreshed once it settles, then confirmed once more in case that
 * first answer was still the stale one.
 */
export function useFillRefresh(refresh, { settleMs = 700, confirmMs = 3500 } = {}) {
  const refreshRef = useRef(refresh);
  const timersRef = useRef([]);

  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  const clear = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  useEffect(() => clear, [clear]);

  return useCallback(() => {
    clear();
    timersRef.current = [
      window.setTimeout(() => refreshRef.current?.(), settleMs),
      window.setTimeout(() => refreshRef.current?.(), confirmMs),
    ];
  }, [clear, confirmMs, settleMs]);
}
