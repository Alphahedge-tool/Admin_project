// The ONE shared connection to the backend Angel live feed (/api/angel/stream),
// fanned out to every useLiveLegFeed on the page.
//
// The backend broadcasts every subscribed token's tick to EVERY connected SSE
// client (see node-backend/src/feed.js), so a second, third, ... EventSource was
// only ever another copy of the exact same stream - and each one held one of the
// browser's ~6-connections-per-host open for the life of the page. The Trade
// Panel keeps several tabs mounted at once, and the Client Dashboard opens an
// order stream per group member on top of that, so those duplicate feed
// connections were enough to exhaust the budget: the feed's own request got
// queued and never connected, which showed as the pill stuck on "Connecting" and
// the group books stuck on "Loading".
//
// Sharing ONE connection here fixes that. The Feedmaster's session drives the
// upstream Angel socket (whichever subscriber posts its credentials to
// basket-tokens), every subscriber's tokens go into the backend's union, and the
// single tick stream is handed to every subscriber, which keeps only the tokens
// it asked for.

let source = null;
let status = 'offline'; // 'offline' | 'connecting' | 'live'
const tickListeners = new Set();
const statusListeners = new Set();

function emitStatus(next) {
  if (status === next) return;
  status = next;
  for (const fn of statusListeners) {
    try {
      fn(next);
    } catch {
      // One listener throwing must not stop the fan-out to the rest.
    }
  }
}

function openSource() {
  // readyState 2 === CLOSED: reopen a dropped connection, but never stack a
  // second EventSource on top of a live/connecting one.
  if (source && source.readyState !== 2) return;
  emitStatus('connecting');
  const es = new EventSource('/api/angel/stream');
  source = es;

  es.addEventListener('status', (event) => {
    try {
      const info = JSON.parse(event.data);
      emitStatus(info.connected ? 'live' : 'offline');
    } catch {
      // ignore malformed status payloads
    }
  });

  es.onmessage = (event) => {
    let tick;
    try {
      tick = JSON.parse(event.data);
    } catch {
      return;
    }
    for (const fn of tickListeners) {
      try {
        fn(tick);
      } catch {
        // keep fanning out to the other subscribers
      }
    }
  };

  es.onerror = () => emitStatus('offline');
}

function closeSource() {
  source?.close();
  source = null;
  emitStatus('offline');
}

// Join the shared feed. `onTick` receives every tick (filter it down to your own
// tokens); `onStatus` receives the connection status, and the CURRENT status
// synchronously on join so a late joiner is not left reading a stale 'offline'.
// Returns an unsubscribe. The connection opens on the first join and closes when
// the last subscriber leaves.
export function joinFeedStream(onTick, onStatus) {
  tickListeners.add(onTick);
  statusListeners.add(onStatus);
  try {
    onStatus(status);
  } catch {
    // ignore
  }
  if (!source) openSource();
  return () => {
    tickListeners.delete(onTick);
    statusListeners.delete(onStatus);
    if (tickListeners.size === 0) closeSource();
  };
}

// Reopen the shared connection if it had been closed (the backend drops it when
// it goes fully idle). Safe - and cheap - to call on every token resync.
export function ensureFeedStream() {
  if (!source || source.readyState === 2) openSource();
}

// The status the shared feed is in right now, for a subscriber that has just
// (re)subscribed its tokens and needs to reflect a connection another subscriber
// already brought up - the status broadcast only fires on a CHANGE, so an
// already-live feed would otherwise never tell the newcomer it is live.
export function feedStreamStatus() {
  return status;
}
