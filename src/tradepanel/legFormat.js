// Pure leg helpers shared across the Trade Panel pages. Kept out of the
// component file so fast-refresh stays happy (components-only exports there).

export function money(v) {
  const n = Number(v || 0)
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function legIsClosed(leg) {
  return Boolean(
    Number(leg.is_closed || leg.closed || 0) ||
    leg.closed_at ||
    leg.exit_price ||
    leg.exitPrice
  )
}

// Marks an open leg to market from a live feed tick: recomputes its ltp/pnl
// from the tick instead of the backend's last-synced snapshot. Closed legs
// are left untouched — their exit price/pnl are locked in, not live.
export function withLiveTick(leg, liveTicks) {
  if (legIsClosed(leg)) return leg

  // `feed_token` is the token this leg is actually SUBSCRIBED under, which is not
  // always the token it trades under: a Kotak position is marked to market on the
  // Angel feed using the Angel token the backend resolved for it, while
  // symbol_token stays Kotak's (orders and margins need that one). A leg with no
  // feed token of its own trades and feeds under the same token.
  const token = String(leg.feed_token || leg.symbol_token || '')
  const tick = token ? liveTicks[token] : null
  if (!tick || !(tick.ltp > 0)) return leg

  const qty = Number(leg.net_qty || 0)
  const pnl = qty > 0
    ? (tick.ltp - Number(leg.buy_avg || 0)) * qty
    : qty < 0
      ? (Number(leg.sell_avg || 0) - tick.ltp) * Math.abs(qty)
      : Number(leg.pnl || 0)

  return { ...leg, ltp: tick.ltp, pnl, liveDir: tick.dir }
}
