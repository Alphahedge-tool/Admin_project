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

// Angel One auto-login via the Go backend. Reuses a saved session when
// possible, otherwise performs a fresh TOTP login (same flow as the
// Angelone_frontend project). Returns the RMS response envelope.
export async function angelAutoLogin(client) {
  const res = await fetch(`${ANGEL_API_BASE_URL}/api/angel/auto-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client })
  })

  let data
  try {
    data = await res.json()
  } catch {
    throw new Error('Angel backend not reachable (is it running on :3001?)')
  }

  if (!data.status) {
    throw new Error(data.message || 'Auto-login failed')
  }

  return data
}

export { API_BASE_URL, ANGEL_API_BASE_URL }
