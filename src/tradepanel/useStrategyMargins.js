// Per-strategy "margin deployed" for the Client Dashboard.
//
// For every saved strategy that belongs to an Angel account this asks Angel's
// batch margin calculator (/api/angel/margin) what margin the strategy's open
// legs currently block, and returns the results keyed by the SAME card key the
// dashboard renders with, so a value lines up with its card.
//
// Only Angel accounts are priced: the endpoint is Angel's, and a Kotak/Zerodha
// strategy carries tokens Angel would not recognise. Work is gated on `active`
// (the dashboard being the visible tab) so that opening a sibling Trade Panel
// tab - all four are mounted at once - does not silently log in every account
// and fan out margin calls in the background.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ensureSession, getAngelClient, useAngelSessions } from '../feedmaster/angelSessionStore'
import { legIsClosed } from './legFormat'

// The dashboard keys each card on the strategy row id, falling back to
// user+code for the All-Users overview where a strategy_code is not unique
// across users. Kept here so the margins line up with the exact cards on screen.
export function strategyCardKey(strategy) {
  return String(strategy.id ?? `${strategy._userLabel || ''}::${strategy.strategy_code}`)
}

// A saved strategy's OPEN legs, shaped for /api/angel/margin. net_qty is already
// the total unit count (not lots) and signed for side, so lotSize is 1 and qty
// its magnitude; price 0 prices at market, which is what a held position wants.
// The backend nets the basket, so this yields the margin the strategy blocks.
function marginLegsOf(strategy) {
  const out = []
  for (const leg of strategy.legs || []) {
    if (legIsClosed(leg)) continue
    const qty = Number(leg.net_qty || 0)
    const token = String(leg.symbol_token || '')
    if (!token || qty === 0) continue
    out.push({
      token,
      exchange: leg.exchange || 'NFO',
      qty: Math.abs(qty),
      lotSize: 1,
      price: 0,
      tradeType: qty > 0 ? 'BUY' : 'SELL',
      productType: leg.product_type || 'CARRYFORWARD',
      orderType: 'MARKET',
    })
  }
  return out
}

// Changes only when the priced inputs change - never on a live LTP tick - so a
// margin is not refetched every time the feed marks a leg to market.
function signatureOf(legs) {
  return legs.map((l) => `${l.token}:${l.qty}:${l.tradeType}:${l.productType}`).join('|')
}

async function postMargin(client, legs) {
  const res = await fetch('/api/angel/margin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client, legs }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.status === false) throw new Error(body.message || `HTTP ${res.status}`)
  return body
}

// Returns a client carrying a live session, logging the account in only when its
// saved token is gone. ensureSession dedupes per account, so two strategies on
// the same account never fire two TOTP logins at once.
async function clientWithSession(configId) {
  const existing = getAngelClient(configId)
  if (existing?.session?.jwtToken) return existing
  await ensureSession(configId)
  const client = getAngelClient(configId)
  if (!client?.session?.jwtToken) throw new Error('Angel account not logged in')
  return client
}

const CONCURRENCY = 3

// margins: { [cardKey]: { status: 'loading' | 'ready' | 'error', value?, components?, message? } }
export function useStrategyMargins(strategies, { fallbackConfigId = '', active = true } = {}) {
  const { accounts } = useAngelSessions()
  const [margins, setMargins] = useState({})
  // cardKey -> the signature already priced OK, so a re-run skips settled cards.
  const doneRef = useRef(new Map())

  // One descriptor per Angel strategy with open legs. Depends on `accounts` so an
  // account that loads (or logs in) after the first pass is picked up. The broker
  // gate reads the store's own account, which is authoritative even when a
  // strategy row was saved without a broker_name.
  const descriptors = useMemo(() => {
    const byId = new Map(accounts.map((account) => [account.configId, account]))
    const out = []
    for (const strategy of strategies) {
      const configId = String(strategy.broker_config_id || fallbackConfigId || '')
      if (!configId) continue
      const account = byId.get(configId)
      if (!account || account.broker !== 'angelone') continue
      const legs = marginLegsOf(strategy)
      if (!legs.length) continue
      out.push({ cardKey: strategyCardKey(strategy), configId, legs, signature: signatureOf(legs) })
    }
    return out
  }, [strategies, accounts, fallbackConfigId])

  // Stable across live ticks and unrelated account churn; changes only when the
  // set of cards, their accounts, or their positions change - which is exactly
  // when a refetch is warranted.
  const runKey = descriptors.map((d) => `${d.cardKey}@${d.configId}#${d.signature}`).join(',')

  useEffect(() => {
    if (!active) return undefined
    const todo = descriptors.filter((d) => doneRef.current.get(d.cardKey) !== d.signature)
    if (!todo.length) return undefined

    let cancelled = false
    setMargins((current) => {
      const next = { ...current }
      for (const d of todo) {
        // Keep a prior value on screen while its refresh is in flight.
        if (next[d.cardKey]?.status !== 'ready') next[d.cardKey] = { status: 'loading' }
      }
      return next
    })

    let index = 0
    async function worker() {
      while (index < todo.length && !cancelled) {
        const d = todo[index++]
        try {
          const client = await clientWithSession(d.configId)
          const body = await postMargin(client, d.legs)
          if (cancelled) return
          doneRef.current.set(d.cardKey, d.signature)
          setMargins((current) => ({
            ...current,
            [d.cardKey]: {
              status: 'ready',
              value: Number(body.totalMarginRequired || 0),
              components: body.marginComponents || null,
            },
          }))
        } catch (error) {
          if (cancelled) return
          setMargins((current) => ({
            ...current,
            [d.cardKey]: { status: 'error', message: error.message || 'Margin unavailable' },
          }))
        }
      }
    }

    Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker))
    return () => {
      cancelled = true
    }
  }, [runKey, active]) // eslint-disable-line react-hooks/exhaustive-deps

  return margins
}
