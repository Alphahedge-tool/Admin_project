import { useEffect, useMemo, useRef, useState } from 'react';

function sessionReady(client) {
  return !!(client?.session?.tradeToken && client.session.sid && client.session.baseUrl);
}

function syncFeed(feedId, client, items, subscriber, keepalive = false) {
  return fetch('/api/kotak/feed/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedId, client, items, subscriber }),
    keepalive,
  });
}

export function useKotakMarketFeed({
  configId, client, enabled, items, subscriber = 'get-positions',
}) {
  const [status, setStatus] = useState('offline');
  const [ticks, setTicks] = useState({});
  const clientRef = useRef(client);
  const wantedRef = useRef(new Set());
  const previousRef = useRef({});
  const itemsKey = useMemo(
    () => (items || []).map((item) => `${item.segment || item.exchange}|${item.token}`).sort().join(','),
    [items],
  );
  const active = Boolean(enabled && configId && sessionReady(client));
  const sessionKey = `${client?.session?.sid || ''}|${client?.session?.tradeToken || ''}`;

  useEffect(() => { clientRef.current = client; }, [client]);

  useEffect(() => {
    if (!active) return undefined;
    const currentItems = itemsKey
      ? itemsKey.split(',').map((entry) => {
        const separator = entry.lastIndexOf('|');
        return { segment: entry.slice(0, separator), token: entry.slice(separator + 1) };
      })
      : [];
    wantedRef.current = new Set(currentItems.map((item) => `${String(item.segment).toLowerCase()}|${item.token}`));
    let cancelled = false;
    syncFeed(configId, clientRef.current, currentItems, subscriber)
      .then((response) => {
        if (cancelled) return;
        if (!response.ok) setStatus('offline');
        else if (!currentItems.length) setStatus('offline');
      })
      .catch(() => { if (!cancelled) setStatus('offline'); });
    return () => { cancelled = true; };
  }, [active, configId, itemsKey, sessionKey, subscriber]);

  useEffect(() => {
    if (!active) return undefined;
    const source = new EventSource(`/api/kotak/feed/stream?feedId=${encodeURIComponent(configId)}`);
    source.addEventListener('status', (event) => {
      try {
        const payload = JSON.parse(event.data);
        setStatus(payload.connected ? 'live' : 'offline');
      } catch {
        setStatus('offline');
      }
    });
    source.onmessage = (event) => {
      let tick;
      try { tick = JSON.parse(event.data); } catch { return; }
      const segment = String(tick.segment || tick.exchange || '').toLowerCase();
      const key = `${segment}|${tick.token}`;
      if (!wantedRef.current.has(key) || !(Number(tick.ltp) > 0)) return;
      const previous = previousRef.current[key];
      const next = Number(tick.ltp);
      const dir = previous == null ? '' : next > previous ? 'up' : next < previous ? 'down' : '';
      previousRef.current[key] = next;
      setTicks((current) => ({ ...current, [key]: { ...tick, ltp: next, dir } }));
    };
    source.onerror = () => setStatus('offline');
    return () => {
      source.close();
      wantedRef.current = new Set();
      syncFeed(configId, clientRef.current, [], subscriber, true).catch(() => {});
    };
  }, [active, configId, sessionKey, subscriber]);

  return { status, ticks };
}
