// The backend feed holds one token set per named subscriber (a page) and
// subscribes to their union - see node-backend/src/feed.js.
//
// A page that goes away must hand its tokens back, otherwise they stay
// subscribed forever and eat into Angel's 1000-token cap. Re-syncing on the way
// back in re-subscribes them, which is also what makes Angel re-push a snapshot
// so the page has an LTP immediately instead of waiting for the next trade.
export function releaseFeedTokens(subscriber) {
  return fetch('/api/angel/basket-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [], subscriber }),
    keepalive: true, // must survive the unmount/navigation that triggered it
  }).catch(() => {});
}
