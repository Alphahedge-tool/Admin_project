import { useCallback, useEffect, useRef, useState } from 'react';
import { saveSession } from '../feedmaster/angelSessionStore';

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
export function useOrderUpdates({ configId, client, enabled = true, onOrder, onResync }) {
  const [status, setStatus] = useState('offline');

  // The stream outlives individual renders, so it reaches the current client and
  // handlers through refs. Passing an inline arrow as onOrder must not reconnect
  // it - reconnecting is exactly the bug this hook exists to end.
  const clientRef = useRef(null);
  const onOrderRef = useRef(null);
  const onResyncRef = useRef(null);

  useEffect(() => { clientRef.current = client; }, [client]);
  useEffect(() => { onOrderRef.current = onOrder; }, [onOrder]);
  useEffect(() => { onResyncRef.current = onResync; }, [onResync]);

  // A token has to exist to connect at all, but its VALUE is deliberately not a
  // dependency: connect() re-reads the client, so a mid-session token refresh is
  // picked up without restarting the stream (and without looping, since the
  // stream itself is what hands the refreshed token back).
  const hasToken = Boolean(client?.session?.jwtToken);
  const active = Boolean(configId) && enabled && hasToken;

  useEffect(() => {
    if (!active) {
      setStatus('offline');
      return undefined;
    }

    let cancelled = false;
    let retries = 0;
    let retryTimer = 0;
    let controller = null;
    // The first connection is a fresh subscription; every one after it follows a
    // gap in which updates were missed and the tables have to be re-fetched.
    let connectedOnce = false;

    function scheduleReconnect() {
      if (cancelled) return;
      const delay = Math.min(RETRY_BASE_MS * (2 ** retries), RETRY_MAX_MS);
      retries += 1;
      retryTimer = window.setTimeout(connect, delay);
    }

    async function connect() {
      if (cancelled) return;

      const streamClient = clientRef.current;
      if (!streamClient?.session?.jwtToken) {
        setStatus('offline');
        scheduleReconnect();
        return;
      }

      controller = new AbortController();
      setStatus('connecting');

      try {
        const res = await fetch('/api/angel/order-updates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client: streamClient }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`Order stream HTTP ${res.status}`);
        if (cancelled) return;

        retries = 0;
        setStatus('live');
        if (connectedOnce) onResyncRef.current?.();
        connectedOnce = true;

        await readOrderStream(res.body, {
          onSession: (session) => {
            // Only a genuinely new token is worth writing back - re-saving the
            // same one churns every consumer of the session store.
            if (!session?.jwtToken) return;
            if (session.jwtToken === clientRef.current?.session?.jwtToken) return;
            saveSession(configId, session);
          },
          onOrder: (payload) => {
            const order = normalizeSocketOrder(payload);
            // AB00 is Angel's "subscribed, nothing to report" heartbeat: not an
            // order, but proof the stream is alive.
            if (!order) {
              if (payload?.['order-status'] === 'AB00') setStatus('live');
              return;
            }
            onOrderRef.current?.(order);
          },
          onStatus: (payload) => {
            setStatus(payload?.status === false ? 'offline' : 'live');
          },
          onError: () => {
            setStatus('offline');
          },
        });

        // The server ended the stream. Reconnect - this is the case that used to
        // leave the page reporting "live" while nothing was listening.
        if (cancelled) return;
        setStatus('offline');
        scheduleReconnect();
      } catch {
        if (cancelled || controller?.signal.aborted) return;
        setStatus('offline');
        scheduleReconnect();
      }
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      controller?.abort();
      setStatus('offline');
    };
  }, [active, configId]);

  return status;
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
