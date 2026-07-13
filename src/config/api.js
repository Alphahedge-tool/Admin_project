const API_BASE_URL = '/api'

// Angel One Go backend (Angelone_frontend project) — handles SmartAPI auto-login
const ANGEL_API_BASE_URL = 'http://localhost:3001'

const defaultOptions = {
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json'
  }
}

// Generic GET
export async function apiGet(path) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...defaultOptions,
    method: 'GET'
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
    body: JSON.stringify(body)
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

// Headless auto-login against the Node backend. Both brokers wired here log in
// server-side from stored credentials and answer with the same envelope, so the
// caller only has to say which one:
//
//   angel  clientCode + PIN + TOTP secret + API key   -> jwtToken/feedToken
//   kotak  UCC + access token + MPIN + TOTP + mobile  -> tradeToken
//
// (Zerodha is deliberately absent: Kite Connect has no headless login. It needs
// a human through the browser once a day, so it cannot use this path at all.)
export async function brokerAutoLogin(broker, client) {
  const path = broker === 'kotak' ? 'kotak' : 'angel'
  const res = await fetch(`${ANGEL_API_BASE_URL}/api/${path}/auto-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client })
  })

  let data
  try {
    data = await res.json()
  } catch {
    throw new Error('Broker backend not reachable (is it running on :3001?)')
  }

  if (!data.status) {
    throw new Error(data.message || 'Auto-login failed')
  }

  return data
}

export function angelAutoLogin(client) {
  return brokerAutoLogin('angel', client)
}

export { API_BASE_URL, ANGEL_API_BASE_URL }
