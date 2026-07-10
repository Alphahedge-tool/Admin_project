// Persists the last selected user/account across the Trade Panel pages (Get
// Position, Get OrderBook, Get TradeBook, Sync Net Positions) so switching
// between them keeps using the same account instead of each page resetting
// to its own default (logged-in user + first broker config).
const TRADE_ACCOUNT_KEY = 'trade_panel_account'

export function getSavedTradeAccount() {
  try {
    return JSON.parse(localStorage.getItem(TRADE_ACCOUNT_KEY)) || {}
  } catch {
    return {}
  }
}

export function saveTradeAccount(next) {
  const current = getSavedTradeAccount()
  localStorage.setItem(TRADE_ACCOUNT_KEY, JSON.stringify({ ...current, ...next }))
}
