import { useEffect, useRef, useState } from 'react'
import { useFeedMasterAccount } from '../feedmaster/feedMasterStore'
import { ensureSession } from '../feedmaster/angelSessionStore'
import { releaseFeedTokens } from './feedTokens'
import { ensureFeedStream, feedStreamStatus, joinFeedStream } from './feedStream'

// Marks a set of open legs to market off the shared Angel live feed. `feedKey` is
// a comma-joined list of "exchange|token" pairs; the hook returns the latest tick
// per token plus the connection status.
//
// There is ONE feed connection for the whole page (feedStream.js), driven by the
// Feedmaster account by default - callers can pass their own logged-in Angel
// client to source a page's feed from a different account. This hook adds its
// tokens to the backend's shared union (so the single upstream socket subscribes
// them) and keeps just those tokens out of the one tick stream. Ticks are batched
// through requestAnimationFrame so a busy feed never floods React with renders.
//
// `subscriber` names this page in the backend feed. Several pages are mounted at
// once and each syncs the tokens it needs; without distinct names they reconcile
// the same token set and unsubscribe each other's tokens, freezing the other
// page's LTPs at their last REST snapshot.
export function useLiveLegFeed(feedKey, {
  enabled = true,
  subscriber = 'live-legs',
  client: providedClient = null,
  onSession = null,
} = {}) {
  const { client: feedMasterClient, handleSession: onFeedMasterSession } = useFeedMasterAccount()
  const [liveTicks, setLiveTicks] = useState({})
  const [feedStatus, setFeedStatus] = useState('offline') // 'offline' | 'connecting' | 'live'
  const feedClientRef = useRef(null)
  const feedTokenSetRef = useRef(new Set())
  const liveRef = useRef({})
  const prevRef = useRef({})
  const rafRef = useRef(0)
  const dirtyRef = useRef(false)
  const hubStatusRef = useRef(feedStreamStatus())

  useEffect(() => {
    feedClientRef.current = providedClient || feedMasterClient
  }, [feedMasterClient, providedClient])

  // Fan-in from the one shared feed connection. Joined once per subscriber - NOT
  // per feedKey - so a token change never tears the shared connection down: the
  // token effect below just re-posts this page's set to the backend union, and
  // the ticks for it keep arriving over the same stream.
  useEffect(() => {
    function scheduleFlush() {
      dirtyRef.current = true
      if (rafRef.current) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0
        if (!dirtyRef.current) return
        dirtyRef.current = false
        setLiveTicks({ ...liveRef.current })
      })
    }

    const onTick = (tick) => {
      const token = String(tick.token)
      if (!feedTokenSetRef.current.has(token)) return
      const prev = prevRef.current[token]
      const dir = prev == null ? '' : tick.ltp > prev ? 'up' : tick.ltp < prev ? 'down' : ''
      prevRef.current[token] = tick.ltp
      liveRef.current[token] = { ltp: tick.ltp, dir, at: performance.now() }
      scheduleFlush()
    }

    // The shared connection's state is only meaningful to this page while it has
    // something on the feed; a page with no legs reads as offline, exactly as it
    // did when every page owned its own stream.
    const onStatus = (next) => {
      hubStatusRef.current = next
      setFeedStatus(feedTokenSetRef.current.size ? next : 'offline')
    }

    const leave = joinFeedStream(onTick, onStatus)
    return () => {
      leave()
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
      // Hand this page's tokens back so the union stops carrying them once the
      // page is gone. The shared connection itself is closed by feedStream.js
      // when the last subscriber leaves.
      releaseFeedTokens(subscriber)
    }
  }, [subscriber])

  // Keeps this page's slice of the backend union in step with what is on screen.
  // Re-runs on every feedKey change; it only POSTs the new token set (and makes
  // sure the shared connection is up) - it does not own the connection.
  useEffect(() => {
    let cancelled = false

    async function syncFeedTokens() {
      if (!enabled) {
        feedTokenSetRef.current = new Set()
        await releaseFeedTokens(subscriber)
        setFeedStatus('offline')
        return
      }

      const client = feedClientRef.current
      if (!client) {
        feedTokenSetRef.current = new Set()
        await releaseFeedTokens(subscriber)
        setFeedStatus('offline')
        return
      }

      const items = (feedKey ? feedKey.split(',') : []).map((pair) => {
        const [exchange, token] = pair.split('|')
        return { exchange, token }
      })

      // Nothing to mark to market: drop this page's tokens from the union and go
      // quiet, without disturbing the shared connection other pages may be using.
      if (!items.length) {
        feedTokenSetRef.current = new Set()
        await releaseFeedTokens(subscriber)
        setFeedStatus('offline')
        return
      }

      let session = client.session
      if (!session?.jwtToken || !session?.feedToken) {
        // A missing or expired token only needs one deduped re-login for the
        // account that owns this feed.
        setFeedStatus('connecting')
        try {
          session = await ensureSession(client.configId, { force: true })
          if (session?.jwtToken) (onSession || onFeedMasterSession)?.(session)
        } catch {
          setFeedStatus('offline')
          return
        }
      }
      if (cancelled || !session?.jwtToken || !session?.feedToken) {
        if (!cancelled) setFeedStatus('offline')
        return
      }

      // These are the tokens the fan-in above keeps; they also go into the
      // backend union so the shared upstream socket actually subscribes them.
      feedTokenSetRef.current = new Set(items.map((item) => String(item.token)))

      try {
        await fetch('/api/angel/basket-tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            credentials: {
              jwtToken: session.jwtToken,
              feedToken: session.feedToken,
              apiKey: client.apiKey,
              clientCode: client.clientCode,
            },
            items,
            subscriber,
          }),
        })
      } catch {
        setFeedStatus('offline')
        return
      }
      if (cancelled) return

      // Make sure the shared connection is up, then reflect its status. It is
      // usually already live (another page opened it), and the status broadcast
      // only fires on a CHANGE - so read the current status directly here rather
      // than wait for an event that will not come.
      ensureFeedStream()
      setFeedStatus(hubStatusRef.current === 'live' ? 'live' : 'connecting')
    }

    syncFeedTokens()
    return () => {
      cancelled = true
    }
  }, [feedKey, enabled, subscriber, onFeedMasterSession, onSession, providedClient, feedMasterClient])

  return { liveTicks, feedStatus }
}
