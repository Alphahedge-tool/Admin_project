import { useEffect, useMemo, useRef } from 'react';

// Subscribes to the backend order hub (node-backend/src/orderHub.js): ONE SSE
// carrying the order/fill events of EVERY account handed to it - Angel and Kotak
// alike - so the Client Dashboard can refresh any member's book the instant a leg
// is added or closed, over a single connection instead of one per account.
//
// `accounts`: [{ configId, broker, userId, client }]. `onEvent` receives each
// hub event as { configId, broker, userId, type, payload }, where type is
// 'order' | 'position' | 'status' | 'session' | 'error'.

// Stamps the account's live token so a refresh re-registers it - the hub then
// uses the new credentials for that account's next reconnect.
function sessionStamp(client) {
  const session = client?.session || {};
  return session.jwtToken || session.tradeToken || session.accessToken || '';
}

function postAccounts(subscriber, accounts) {
  return fetch('/api/orders/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscriber, accounts }),
  });
}

// Hand this page's accounts back so the hub stops streaming them once the page is
// gone. keepalive so it survives the unmount/navigation that triggered it.
function releaseAccounts(subscriber) {
  return fetch('/api/orders/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscriber, accounts: [] }),
    keepalive: true,
  }).catch(() => {});
}

export function useGroupOrderStream(accounts, onEvent, { subscriber = 'client-dashboard', enabled = true } = {}) {
  const onEventRef = useRef(onEvent);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);

  const accountsRef = useRef(accounts);
  useEffect(() => { accountsRef.current = accounts; }, [accounts]);

  // Changes when the account set OR any of their sessions change, so a token
  // refresh re-registers the account without churning otherwise.
  const accountsKey = useMemo(
    () => (accounts || [])
      .map((account) => `${account.broker}:${account.configId}:${sessionStamp(account.client)}`)
      .sort()
      .join(','),
    [accounts],
  );

  // Register/reconcile this page's account set whenever it changes.
  useEffect(() => {
    if (!enabled || !accountsRef.current.length) {
      releaseAccounts(subscriber);
      return undefined;
    }
    postAccounts(subscriber, accountsRef.current).catch(() => {});
    return undefined;
  }, [accountsKey, subscriber, enabled]);

  // One SSE for the life of the mount. The hub drops a subscriber's accounts when
  // its SSE goes away, so re-register the current set on every (re)connect.
  useEffect(() => {
    if (!enabled) return undefined;
    const source = new EventSource('/api/orders/stream');
    source.onopen = () => {
      if (accountsRef.current.length) postAccounts(subscriber, accountsRef.current).catch(() => {});
    };
    source.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message && message.type) onEventRef.current?.(message);
    };
    return () => {
      source.close();
      releaseAccounts(subscriber);
    };
  }, [subscriber, enabled]);
}
