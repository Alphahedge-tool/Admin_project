import { useEffect, useRef, useState } from 'react'
import { useFeedMasterAccount } from '../feedmaster/feedMasterStore'
import { ensureSession } from '../feedmaster/angelSessionStore'
import { releaseFeedTokens } from './feedTokens'

// Streams live LTP ticks over the shared Feedmaster SSE connection for a set of
// feed tokens (a comma-joined list of "exchange|token" pairs). Returns the
// latest tick per token plus the connection status. This is the same live feed
// Sync Net Positions uses, packaged so any Trade Panel page can mark its open
// legs to market. Ticks are batched through requestAnimationFrame so a busy
// feed never floods React with renders.
//
// `subscriber` names this page in the backend feed. Trade Panel keeps several
// pages mounted at once and each syncs the tokens it needs; without distinct
// names they reconcile the same token set and unsubscribe each other's tokens,
// which freezes the other page's LTPs at their last REST snapshot.
export function useLiveLegFeed(feedKey, { enabled = true, subscriber = 'live-legs' } = {}) {
  const { client: feedMasterClient, handleSession: onFeedMasterSession } = useFeedMasterAccount()
  const [liveTicks, setLiveTicks] = useState({})
  const [feedStatus, setFeedStatus] = useState('offline') // 'offline' | 'connecting' | 'live'
  const feedMasterClientRef = useRef(null)
  const esRef = useRef(null)
  const feedTokenSetRef = useRef(new Set())
  const liveRef = useRef({})
  const prevRef = useRef({})
  const rafRef = useRef(0)
  const dirtyRef = useRef(false)

  useEffect(() => {
    feedMasterClientRef.current = feedMasterClient
  }, [feedMasterClient])

  useEffect(() => {
    let cancelled = false

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

    async function syncFeedTokens() {
      if (!enabled) {
        esRef.current?.close()
        esRef.current = null
        setFeedStatus('offline')
        return
      }

      const client = feedMasterClientRef.current
      if (!client) return

      let session = client.session
      if (!session?.jwtToken || !session?.feedToken) {
        // Startup logged the Feedmaster in; this only covers an expired token,
        // and it is deduped across every page that wants the feed.
        setFeedStatus('connecting')
        try {
          session = await ensureSession(client.configId, { force: true })
          if (session?.jwtToken) onFeedMasterSession?.(session)
        } catch {
          setFeedStatus('offline')
          return
        }
      }
      if (cancelled || !session?.jwtToken || !session?.feedToken) {
        setFeedStatus('offline')
        return
      }

      const items = (feedKey ? feedKey.split(',') : []).map((pair) => {
        const [exchange, token] = pair.split('|')
        return { exchange, token }
      })
      feedTokenSetRef.current = new Set(items.map((item) => String(item.token)))

      if (!items.length) {
        setFeedStatus('offline')
        return
      }

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

      let source = esRef.current
      if (!source || source.readyState === 2) {
        setFeedStatus('connecting')
        source = new EventSource('/api/angel/stream')
        esRef.current = source
        source.addEventListener('status', (event) => {
          try {
            const info = JSON.parse(event.data)
            setFeedStatus(info.connected ? 'live' : 'offline')
          } catch {
            // ignore malformed status payloads
          }
        })
        source.onerror = () => setFeedStatus('offline')
      } else {
        setFeedStatus('live')
      }

      source.onmessage = (event) => {
        let tick
        try { tick = JSON.parse(event.data) } catch { return }
        const token = String(tick.token)
        if (!feedTokenSetRef.current.has(token)) return
        const prev = prevRef.current[token]
        const dir = prev == null ? '' : tick.ltp > prev ? 'up' : tick.ltp < prev ? 'down' : ''
        prevRef.current[token] = tick.ltp
        liveRef.current[token] = { ltp: tick.ltp, dir, at: event.timeStamp || performance.now() }
        scheduleFlush()
      }
    }

    syncFeedTokens()
    return () => {
      cancelled = true
    }
  }, [feedKey, feedMasterClient, onFeedMasterSession, enabled, subscriber])

  useEffect(() => () => {
    esRef.current?.close()
    releaseFeedTokens(subscriber)
  }, [subscriber])

  return { liveTicks, feedStatus }
}
