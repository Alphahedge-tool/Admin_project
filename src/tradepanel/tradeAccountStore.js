// The user/account selected in the Trade Panel, shared by Get Position, Get
// OrderBook, Get TradeBook and Sync Net Positions so switching pages keeps the
// same account instead of each page falling back to its own default.
//
// It has to NOTIFY, not just persist. Trade Panel keeps every tab mounted at
// once (see TradePanelTabs - it toggles `hidden`, it does not unmount), so a page
// reads this once when it mounts and then never again. Writing to localStorage
// alone meant picking bberlia in Get Position was invisible to the already-mounted
// Order Book, which sat on whoever it had loaded with.
import { useSyncExternalStore } from 'react'

const TRADE_ACCOUNT_KEY = 'trade_panel_account'

function read() {
  try {
    return JSON.parse(localStorage.getItem(TRADE_ACCOUNT_KEY)) || {}
  } catch {
    return {}
  }
}

// Held as one stable object: useSyncExternalStore compares snapshots by identity,
// so a fresh object on every read would re-render forever.
let snapshot = read()
const listeners = new Set()

export function getSavedTradeAccount() {
  return snapshot
}

export function saveTradeAccount(next) {
  const merged = { ...snapshot, ...next }
  if (
    String(merged.userId || '') === String(snapshot.userId || '')
    && String(merged.configId || '') === String(snapshot.configId || '')
  ) {
    return
  }

  snapshot = merged
  localStorage.setItem(TRADE_ACCOUNT_KEY, JSON.stringify(merged))
  listeners.forEach((listener) => listener())
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// The current selection, re-rendering the caller whenever ANY page changes it.
export function useTradeAccount() {
  return useSyncExternalStore(subscribe, getSavedTradeAccount)
}
