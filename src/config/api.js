const API_BASE_URL = '/api'

// Broker backend base URL. Leave empty to use the current origin and Vite's
// dev proxy / reverse proxy in front of it, or set VITE_BROKER_API_BASE_URL
// when the Node backend lives on a separate host.
const BROKER_API_BASE_URL = (import.meta.env.VITE_BROKER_API_BASE_URL || '').replace(/\/$/, '')

function brokerApiUrl(path) {
  return `${BROKER_API_BASE_URL}/api${path}`
}

const defaultOptions = {
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
  },
}

// Generic GET
export async function apiGet(path) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...defaultOptions,
    method: 'GET',
  })

  const text = await res.text()

  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('Invalid server response')
  }

  if (!data.success) {
    throw new Error(data.message || 'Request failed')
  }

  return data
}

// Generic POST
export async function apiPost(path, body = {}) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...defaultOptions,
    method: 'POST',
    body: JSON.stringify(body),
  })

  const text = await res.text()

  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('Invalid server response')
  }

  if (!data.success) {
    throw new Error(data.message || 'Request failed')
  }

  return data
}

// Broker login against the Node backend. Angel and Kotak finish entirely on the
// server. Zerodha uses the official Kite Connect request-token exchange, so it
// still needs a browser login first, but the backend can exchange the token once
// the browser redirect brings it back.
export async function brokerAutoLogin(broker, client) {
  const path = {
    kotak: 'kotak',
    zerodha: 'zerodha',
  }[broker] || 'angel'
  const res = await fetch(brokerApiUrl(`/${path}/auto-login`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client }),
  })

  let data
  try {
    data = await res.json()
  } catch {
    throw new Error('Broker backend not reachable')
  }

  if (!data.status) {
    throw new Error(data.message || 'Auto-login failed')
  }

  return data
}

export function angelAutoLogin(client) {
  return brokerAutoLogin('angel', client)
}

async function zerodhaApi(path, { method = 'GET', query = {}, body } = {}) {
  const url = new URL(brokerApiUrl(`/zerodha${path}`), window.location.origin)
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value == null || value === '') return
    url.searchParams.set(key, String(value))
  })

  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  })

  let data
  try {
    data = await res.json()
  } catch {
    throw new Error('Zerodha backend not reachable')
  }

  if (!res.ok || data.status === false) {
    throw new Error(data.message || `Zerodha request failed (HTTP ${res.status})`)
  }

  return data
}

export function zerodhaLoginUrl(apiKey) {
  return zerodhaApi('/login-url', { query: { apiKey } })
}

export function zerodhaHoldings(client) {
  return zerodhaApi('/portfolio/holdings', { query: client })
}

export function zerodhaPositions(client) {
  return zerodhaApi('/portfolio/positions', { query: client })
}

export function zerodhaHoldingsAuctions(client) {
  return zerodhaApi('/portfolio/holdings/auctions', { query: client })
}

export function zerodhaConvertPosition(body) {
  return zerodhaApi('/portfolio/positions', { method: 'PUT', body })
}

export function zerodhaAuthoriseHoldings(body) {
  return zerodhaApi('/portfolio/holdings/authorise', { method: 'POST', body })
}

export function zerodhaOrders(query) {
  return zerodhaApi('/orders', { query })
}

export function zerodhaOrderBook(query) {
  return zerodhaOrders(query)
}

export function zerodhaOrderHistory(orderId, query) {
  return zerodhaApi(`/orders/${encodeURIComponent(orderId)}`, { query })
}

export function zerodhaOrderTrades(orderId, query) {
  return zerodhaApi(`/orders/${encodeURIComponent(orderId)}/trades`, { query })
}

export function zerodhaTrades(query) {
  return zerodhaApi('/trades', { query })
}

export function zerodhaTradeBook(query) {
  return zerodhaTrades(query)
}

export function zerodhaPlaceOrder(variety, body) {
  return zerodhaApi(`/orders/${encodeURIComponent(variety || 'regular')}`, { method: 'POST', body })
}

export function zerodhaModifyOrder(variety, orderId, body) {
  return zerodhaApi(`/orders/${encodeURIComponent(variety || 'regular')}/${encodeURIComponent(orderId)}`, { method: 'PUT', body })
}

export function zerodhaCancelOrder(variety, orderId, query) {
  return zerodhaApi(`/orders/${encodeURIComponent(variety || 'regular')}/${encodeURIComponent(orderId)}`, { method: 'DELETE', query })
}

export { API_BASE_URL, BROKER_API_BASE_URL }
