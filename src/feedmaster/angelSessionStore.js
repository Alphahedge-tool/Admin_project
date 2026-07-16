// Single source of truth for every broker session in the admin app - Angel One
// and Kotak Neo, the two brokers that can log in headlessly.
//
// The app boots by logging in EVERY configured account once (see
// bootstrapAngelSessions, driven by StartupGate) and saving each token, so no
// page ever has to log in on its own - a page just asks for the hydrated client
// of a config id and gets one that already carries a live session.
//
// Re-logins (expired token, RMS 401) go through ensureSession(), which dedupes
// concurrent logins per account: two pages can never fire two TOTP logins for
// the same account at once (Angel rejects a TOTP that is reused inside its 30s
// window, which is what made logins look random before).
import { useMemo, useSyncExternalStore } from 'react'
import { apiGet } from '../config/api'

// Brokers the startup screen can sign in.
//
// Angel and Kotak log in headlessly. Zerodha CANNOT - Kite Connect has no PIN/TOTP
// endpoint, the user has to pass through kite.zerodha.com in a browser once a day.
// What the startup screen does for it is reuse the access token from that login
// for as long as it lives, and say plainly when a new browser login is due.
export const BROKERS = [
  { id: 'angelone', label: 'Angel One' },
  { id: 'kotak', label: 'Kotak Neo' },
  { id: 'zerodha', label: 'Zerodha' },
]

// The shared live feed runs on Angel's websocket, so a Kotak or Zerodha account -
// logged in or not - cannot be the Feedmaster. Only these are offered as sources.
export const FEED_BROKERS = BROKERS.filter((broker) => broker.id === 'angelone')

const SESSION_PREFIX = { angelone: 'angel_session_', kotak: 'kotak_session_', zerodha: 'zerodha_session_' }
const AUTO_LOGIN_URL = {
  angelone: '/api/angel/auto-login',
  kotak: '/api/kotak/auto-login',
  zerodha: '/api/zerodha/auto-login',
}
const LOGIN_CONCURRENCY = 3
const CONFIG_FETCH_CONCURRENCY = 4

// Account status: 'pending' | 'logging-in' | 'live' | 'failed'
// Store phase:    'idle' | 'loading' | 'logging-in' | 'ready'

// The Trade Panel's book pages hydrate Kotak credentials themselves and listen
// for this, so a token saved by the startup login reaches them too.
export const KOTAK_SESSION_EVENT = 'kotak-session-changed'

export function isAngelBroker(name = '') {
  return String(name).toLowerCase().replace(/\s/g, '').includes('angel')
}

export function isKotakBroker(name = '') {
  return String(name).toLowerCase().replace(/\s/g, '').includes('kotak')
}

export function isZerodhaBroker(name = '') {
  const text = String(name).toLowerCase().replace(/\s/g, '')
  return text.includes('zerodha') || text.includes('kite')
}

// Which broker a config row belongs to. A broker the app has no adapter for at all
// resolves to '' and is left out of the store - there is nothing the startup screen
// could do with it.
export function brokerIdOf(brokerName = '') {
  if (isKotakBroker(brokerName)) return 'kotak'
  if (isAngelBroker(brokerName)) return 'angelone'
  if (isZerodhaBroker(brokerName)) return 'zerodha'
  return ''
}

export function sessionKey(configId, broker = 'angelone') {
  return `${SESSION_PREFIX[broker] || SESSION_PREFIX.angelone}${configId}`
}

// Angel hands back a jwtToken. Kotak hands back a tradeToken that is only usable
// alongside the sid and baseUrl it came with, so "is there a session?" is a
// different question per broker.
export function hasToken(broker, session) {
  if (broker === 'kotak') return !!(session?.tradeToken && session.sid && session.baseUrl)
  if (broker === 'zerodha') return !!session?.accessToken
  return !!session?.jwtToken
}

/* ── saved tokens (localStorage) ──────────────────────────────────────────── */

export function getSavedSession(configId, broker = 'angelone') {
  if (!configId) return null
  try {
    return JSON.parse(localStorage.getItem(sessionKey(configId, broker))) || null
  } catch {
    return null
  }
}

// `broker` is only needed for an account the store has not loaded yet; for one
// it knows, its own broker wins.
export function saveSession(configId, session, broker) {
  const resolved = getAccount(configId)?.broker || broker || 'angelone'
  if (!configId || !hasToken(resolved, session)) return
  localStorage.setItem(sessionKey(configId, resolved), JSON.stringify(session))
  patchAccount(configId, { session, status: 'live', issue: null })
  if (resolved === 'kotak') {
    window.dispatchEvent(new CustomEvent(KOTAK_SESSION_EVENT, {
      detail: { configId: String(configId), session },
    }))
  }
}

export function clearSession(configId, broker) {
  if (!configId) return
  const resolved = getAccount(configId)?.broker || broker || 'angelone'
  localStorage.removeItem(sessionKey(configId, resolved))
  patchAccount(configId, { session: null, status: 'pending' })
}

/* ── store ────────────────────────────────────────────────────────────────── */

let state = {
  phase: 'idle',
  users: [],
  accounts: [],
  error: '',
}

const listeners = new Set()

function setState(patch) {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return state
}

function patchAccount(configId, patch) {
  const id = String(configId)
  let changed = false
  const accounts = state.accounts.map((account) => {
    if (account.configId !== id) return account
    changed = true
    return { ...account, ...patch }
  })
  if (changed) setState({ accounts })
}

export function getAngelState() {
  return state
}

export function getAccount(configId) {
  const id = String(configId || '')
  return state.accounts.find((account) => account.configId === id) || null
}

// The client payload the broker's own /api/<broker>/* endpoints expect, carrying
// whatever session this account currently holds. The two brokers name the same
// columns differently - Angel's client code is Kotak's UCC, Angel's PIN is
// Kotak's MPIN - so each gets the shape its backend reads.
export function clientFromAccount(account) {
  if (!account) return null
  const broker = account.broker || 'angelone'
  const session = account.session || null

  if (broker === 'zerodha') {
    return {
      enabled: true,
      broker: 'zerodha',
      configId: account.configId,
      userId: account.userId,
      alias: account.alias,
      clientCode: account.accountId,
      apiKey: account.apiKey,
      apiSecret: account.apiSecret,
      requestToken: account.requestToken,
      accessToken: session?.accessToken,
      // Headless login creds. With these, autoLogin drives Kite's web login and
      // never needs the browser popup (bar the one-time app Authorize). Absent,
      // it falls back to reusing a saved token or asking for the browser login.
      password: account.password,
      totpSecret: account.totpSecret,
      autoLogin: true,
      loggedIn: hasToken('zerodha', session),
      session,
    }
  }

  if (broker === 'kotak') {
    return {
      enabled: true,
      broker: 'kotak',
      configId: account.configId,
      userId: account.userId,
      alias: account.alias,
      clientCode: account.accountId,
      ucc: account.accountId,
      accessToken: account.accessToken,
      mobileNumber: account.mobileNumber,
      mpin: account.pin,
      totpSecret: account.totpSecret,
      loggedIn: hasToken('kotak', session),
      session,
    }
  }

  return {
    enabled: true,
    broker: 'angelone',
    configId: account.configId,
    userId: account.userId,
    alias: account.alias,
    clientCode: account.accountId,
    apiKey: account.apiKey,
    pin: account.pin,
    totpSecret: account.totpSecret,
    loggedIn: hasToken('angelone', session),
    session,
  }
}

export function getAngelClient(configId) {
  return clientFromAccount(getAccount(configId))
}

/* ── React bindings ───────────────────────────────────────────────────────── */

export function useAngelSessions() {
  return useSyncExternalStore(subscribe, getSnapshot)
}

// Hydrated client for one account. Its identity only changes when THAT
// account changes (login, new token), so effects keyed on it don't churn when
// some other account logs in.
export function useAngelClient(configId) {
  const { accounts } = useAngelSessions()
  const id = String(configId || '')
  const account = useMemo(
    () => accounts.find((item) => item.configId === id) || null,
    [accounts, id],
  )
  return useMemo(() => clientFromAccount(account), [account])
}

/* ── login ────────────────────────────────────────────────────────────────── */

const inflight = new Map() // configId -> Promise<session>

// Returns a live session for the account, logging in only when needed.
// Concurrent callers for the same account share one login.
export async function ensureSession(configId, { force = false } = {}) {
  const id = String(configId || '')
  const account = getAccount(id)
  if (!account) throw new Error('This broker account is not loaded yet')

  if (!force && account.status === 'live' && hasToken(account.broker, account.session)) {
    return account.session
  }
  const pending = inflight.get(id)
  if (pending) return pending

  const promise = performLogin(id, force).finally(() => inflight.delete(id))
  inflight.set(id, promise)
  return promise
}

async function performLogin(configId, force) {
  const account = getAccount(configId)
  const broker = account?.broker || 'angelone'
  const missing = missingCredentials(account)
  if (missing.length) {
    const issue = {
      code: 'credentials',
      title: 'Credentials incomplete',
      hint: `Missing ${missing.join(', ')} - add it in Users -> Broker Configuration.`,
    }
    patchAccount(configId, { status: 'failed', issue, message: issue.hint })
    throw new Error(issue.hint)
  }

  patchAccount(configId, { status: 'logging-in', message: 'Signing in...', issue: null })

  // force=true drops the saved token so the backend does a fresh TOTP login
  // instead of re-validating a token we already know is dead.
  const client = clientFromAccount({
    ...account,
    session: force ? null : (account.session || getSavedSession(configId, broker)),
  })

  try {
    const body = await postAutoLogin(broker, client)

    // Zerodha can answer "I need you in a browser". Headless login covers the
    // normal case, but the very first connection for an app+account needs a human
    // to click Authorize once - so this gets its own message and the URL to open,
    // rather than a login-error guess.
    if (body.needsLogin) {
      const issue = {
        code: 'browser-login',
        title: 'Browser login needed',
        hint: body.message
          || 'Open Users -> Broker Configuration and complete the Zerodha login once. After that, auto-login runs headless with no popup until Zerodha expires the token, around 6am the next day.',
      }
      patchAccount(configId, {
        status: 'failed',
        issue,
        message: issue.title,
        loginUrl: body.loginUrl || '',
      })
      const needsLogin = new Error(issue.title)
      needsLogin.handled = true
      throw needsLogin
    }

    const session = body.session || null
    if (!hasToken(broker, session)) throw new Error(`${brokerLabel(broker)} returned no token`)

    localStorage.setItem(sessionKey(configId, broker), JSON.stringify(session))
    patchAccount(configId, {
      session,
      status: 'live',
      issue: null,
      margin: body.availableMargin ?? null,
      message: body.sessionSource === 'session'
        ? 'Saved token still valid'
        : 'Signed in - token saved',
    })
    if (broker === 'kotak') {
      window.dispatchEvent(new CustomEvent(KOTAK_SESSION_EVENT, {
        detail: { configId: String(configId), session },
      }))
    }
    return session
  } catch (error) {
    // Already reported with an issue of its own (the Zerodha browser login) -
    // classifying it again would replace a precise message with a guess.
    if (error.handled) throw error

    const issue = classifyLoginError(error)
    patchAccount(configId, {
      status: 'failed',
      issue,
      message: error.message || issue.title,
    })
    throw error
  }
}

function brokerLabel(broker) {
  return BROKERS.find((item) => item.id === broker)?.label || 'The broker'
}

async function postAutoLogin(broker, client) {
  let response
  try {
    response = await fetch(AUTO_LOGIN_URL[broker] || AUTO_LOGIN_URL.angelone, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client }),
    })
  } catch {
    throw new Error('Broker backend not reachable')
  }

  const body = await response.json().catch(() => ({}))

  // "You need a browser login" comes back as status:false, because no session was
  // minted - but it is an ANSWER, not a failure. The caller acts on it.
  if (response.ok && body.needsLogin) return body

  if (!response.ok || body.status === false) {
    throw new Error(body.message || `Auto-login failed (HTTP ${response.status})`)
  }
  return body
}

// Back-compat entry point for callers that hold a client object rather than a
// config id. Anything with a configId is routed through the shared, deduped
// login so it can't start a second TOTP login behind the store's back.
export async function loginAngelClient(client) {
  const broker = client?.broker === 'zerodha'
    ? 'zerodha'
    : brokerIdOf(client?.broker) || 'angelone'
  if (client?.configId) {
    const session = await ensureSession(client.configId, {
      force: !hasToken(broker, client.session),
    })
    return { status: true, session, sessionSource: 'store' }
  }
  return postAutoLogin(broker, client)
}

// Named in the broker's own words: Kotak has no "API Key", Angel has no "MPIN".
export function missingCredentials(account) {
  if (!account) return ['Client Code', 'API Key', 'PIN', 'TOTP Secret']

  const missing = []
  if (account.broker === 'kotak') {
    if (!account.accountId) missing.push('UCC')
    if (!account.accessToken) missing.push('Access Token')
    if (!account.mobileNumber) missing.push('Mobile Number')
    if (!account.pin) missing.push('MPIN')
    if (!account.totpSecret) missing.push('TOTP Secret')
    return missing
  }

  // Kite Connect signs in through the browser, so the API key and secret are the
  // whole of it - the key identifies the app, the secret signs the one token
  // exchange. Demanding a password or TOTP here would block a login that never
  // uses them.
  if (account.broker === 'zerodha') {
    if (!account.apiKey) missing.push('API Key')
    if (!account.apiSecret) missing.push('API Secret')
    return missing
  }

  if (!account.accountId) missing.push('Client Code')
  if (!account.apiKey) missing.push('API Key')
  if (!account.pin) missing.push('PIN')
  if (!account.totpSecret) missing.push('TOTP Secret')
  return missing
}

// Turns whatever SmartAPI (or our backend) said into a plain "here's what's
// wrong and where to fix it" - this is what the startup screen shows per
// account instead of a raw broker error string.
export function classifyLoginError(error) {
  const message = String(error?.message || '')

  if (/not reachable|failed to fetch|networkerror|load failed|econnrefused/i.test(message)) {
    return {
      code: 'network',
      title: 'Broker backend not reachable',
      hint: 'The broker backend is not running. Start it and retry.',
    }
  }
  // Kotak names what it wants as "Kotak login needs UCC, MPIN"; Angel says
  // "required"/"missing". Both mean: a credential is not filled in.
  if (/required|missing|needs/i.test(message)) {
    return {
      code: 'credentials',
      title: 'Credentials incomplete',
      hint: 'Fill in the credentials this broker needs in Users -> Broker Configuration.',
    }
  }
  if (/totp|AB1050/i.test(message)) {
    return {
      code: 'totp',
      title: 'TOTP rejected',
      hint: 'The TOTP secret is wrong or this machine\'s clock is off. Re-copy the Base32 secret from Angel One into Broker Configuration.',
    }
  }
  if (/\bpin\b|password|AB1007|AB1005/i.test(message)) {
    return {
      code: 'pin',
      title: 'PIN rejected',
      hint: 'Angel refused the PIN for this client code. Re-enter the login PIN in Broker Configuration.',
    }
  }
  // Kotak calls the access token a "consumer key" when it rejects one.
  if (/consumer key|access token/i.test(message)) {
    return {
      code: 'accesstoken',
      title: 'Access Token rejected',
      hint: 'The Kotak access token is wrong or expired. Re-copy it from the Kotak Neo API portal into Broker Configuration.',
    }
  }
  if (/api ?key|smartapi key|AB1010|invalid key/i.test(message)) {
    return {
      code: 'apikey',
      title: 'API key rejected',
      hint: 'The SmartAPI key is wrong or not enabled for this account. Re-copy it from the Angel developer portal.',
    }
  }
  if (/block|freeze|frozen|suspend|AB1013/i.test(message)) {
    return {
      code: 'blocked',
      title: 'Account blocked by Angel',
      hint: 'Angel has blocked or frozen this account. Contact Angel support - nothing to fix in the app.',
    }
  }
  if (/SmartAPI HTTP (403|429)|exceeding access rate|rate|too many|AB1004/i.test(message)) {
    return {
      code: 'ratelimit',
      title: 'Angel is rate-limiting this account',
      hint: 'Too many requests to Angel for this client code. It clears on its own - retry in a few seconds.',
    }
  }
  if (/HTTP 5|unavailable|timeout/i.test(message)) {
    return {
      code: 'broker',
      title: 'SmartAPI unavailable',
      hint: 'Angel\'s servers are not responding right now. Retry in a moment.',
    }
  }
  return {
    code: 'unknown',
    title: 'Login failed',
    hint: message || 'Angel refused the login without a reason.',
  }
}

// Angel answers "you are going too fast" with a bare 403. That is NOT a dead
// session: forcing a re-login on it burns Angel's 1/sec login limit and rotates
// the token out from under every other page - the cascade that ended as
// "Login failed. SmartAPI HTTP 403" on screen. The backend already backs off and
// retries these, so pages just surface them.
export function isRateLimited(error) {
  return /SmartAPI HTTP (403|429)|exceeding access rate|too many|rate limit/i
    .test(String(error?.message || ''))
}

// True when this error means "the token is dead" - the signal for pages to ask
// for a forced re-login instead of surfacing the error.
export function isAuthError(error) {
  if (isRateLimited(error)) return false
  return /SmartAPI HTTP 401|invalid token|token expired|session|unauthor|expire|login|totp|pin/i
    .test(String(error?.message || ''))
}

/* ── bootstrap: log in every configured Angel account ─────────────────────── */

let bootPromise = null

export function bootstrapAngelSessions({ force = false } = {}) {
  if (bootPromise && !force) return bootPromise
  bootPromise = runBootstrap().catch((error) => {
    setState({ phase: 'ready', error: error.message || 'Failed to load broker accounts' })
  })
  return bootPromise
}

async function runBootstrap() {
  setState({ phase: 'loading', error: '' })

  const { users, accounts } = await loadBrokerAccounts()
  setState({ phase: 'logging-in', users, accounts })

  await loginPending(accounts)
  setState({ phase: 'ready' })
}

// Loads the users + broker accounts ONLY - it never logs anything in. This is
// what the Feedmaster page uses so its dropdowns populate without triggering an
// auto-login of every account (the app no longer logs brokers in at startup).
// Accounts come back 'pending'; the page's "Test Login" signs the chosen one in.
let accountsLoadPromise = null

export function ensureAccountsLoaded({ force = false } = {}) {
  if (accountsLoadPromise && !force) return accountsLoadPromise
  accountsLoadPromise = (async () => {
    setState({ phase: 'loading', error: '' })
    try {
      const { users, accounts } = await loadBrokerAccounts()
      setState({ phase: 'ready', users, accounts })
    } catch (error) {
      // Never cache a failed load: clear the memo so the next caller (a page
      // mount, the Feedmaster auto-connect) retries instead of being stuck with
      // an empty account list - and, with it, no Feedmaster to sign in - forever.
      accountsLoadPromise = null
      setState({ phase: 'ready', error: error.message || 'Failed to load broker accounts' })
    }
  })()
  return accountsLoadPromise
}

// Re-reads users and their broker configs, keeping every account already logged
// in exactly as it is, and logs in whatever is new. This is what makes a user (or
// a broker config) added inside the app show up without a page reload - the
// account list is otherwise only ever read once, at boot.
export async function refreshBrokerAccounts() {
  const { users, accounts } = await loadBrokerAccounts()

  // Carry the session/status of accounts we already know across, so a refresh
  // never re-logs in an account that is already signed in. An account whose
  // credentials changed is deliberately NOT carried across: it stays 'pending'
  // and is signed in again below, which is what makes "fix the API key, save"
  // recover a failed account on the spot.
  const known = new Map(state.accounts.map((account) => [account.configId, account]))
  const merged = accounts.map((account) => {
    const existing = known.get(account.configId)
    if (!existing || credentialsOf(existing) !== credentialsOf(account)) return account
    return {
      ...account,
      session: existing.session,
      status: existing.status,
      message: existing.message,
      issue: existing.issue,
      margin: existing.margin,
    }
  })

  setState({ users, accounts: merged, error: '' })
  await loginPending(merged)
  return merged
}

function credentialsOf(account) {
  return [
    account.broker,
    account.accountId,
    account.apiKey,
    account.pin,
    account.password,
    account.totpSecret,
    account.accessToken,
    account.mobileNumber,
  ].join('|')
}

function loginPending(accounts) {
  const pending = accounts.filter((account) => account.status === 'pending')
  return runPool(
    pending.map((account) => () => ensureSession(account.configId).catch(() => {})),
    LOGIN_CONCURRENCY,
  )
}

// Every auto-loginnable broker config of every user, hydrated with full
// credentials and whatever token is already saved for it.
async function loadBrokerAccounts() {
  const users = (await apiGet('/users/list.php')).data || []

  const perUser = await Promise.all(users.map(async (user) => {
    try {
      const res = await apiGet(`/users/broker-config/list.php?user_id=${user.id}`)
      return (res.data || [])
        .map((config) => ({ config, user, broker: brokerIdOf(config.broker_name) }))
        .filter((row) => row.broker)
    } catch {
      return []
    }
  }))

  const rows = perUser.flat()
  const accounts = await runPool(
    rows.map(({ config, user, broker }) => () => hydrateAccount(config, user, broker)),
    CONFIG_FETCH_CONCURRENCY,
  )
  return { users, accounts: accounts.filter(Boolean) }
}

async function hydrateAccount(config, user, broker) {
  const configId = String(config.id)
  let full = config
  try {
    const res = await apiGet(`/users/broker-config/get.php?id=${configId}`)
    full = { ...config, ...(res.data || {}) }
  } catch {
    // Fall back to the list row: credentials will read as missing and the
    // account shows up as "Credentials incomplete" instead of vanishing.
  }

  const username = user?.username
    || `${user?.first_name || ''} ${user?.last_name || ''}`.trim()
    || `User ${user?.id}`
  const session = getSavedSession(configId, broker)

  return {
    configId,
    broker,
    userId: String(user?.id || full.user_id || ''),
    username,
    brokerName: full.broker_name || brokerLabel(broker),
    accountId: full.account_id || '',
    alias: `${username} - ${full.account_id || configId}`,
    apiKey: full.app_key || '',
    pin: full.pin || '',
    // Zerodha keeps the account password in its own column (Kite has no PIN);
    // Angel/Kotak leave it blank and sign in with pin/mpin instead.
    password: full.password || '',
    totpSecret: full.totp_secret || '',
    // One column, two meanings: app_secret is Kotak's ACCESS TOKEN and Zerodha's
    // API SECRET. Each broker reads the name it knows.
    accessToken: full.app_secret || '',
    apiSecret: full.app_secret || '',
    mobileNumber: full.phone || '',
    session,
    status: 'pending',
    message: '',
    issue: null,
    margin: null,
    loginUrl: '',
  }
}

// Runs tasks with a bounded number in flight, preserving result order.
async function runPool(tasks, limit) {
  const results = new Array(tasks.length)
  let next = 0

  async function worker() {
    while (next < tasks.length) {
      const index = next++
      results[index] = await tasks[index]()
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, () => worker()),
  )
  return results
}

// Retry every account that failed - what the startup screen's "Retry failed"
// button and the Feedmaster page's retry use.
export async function retryFailedAccounts() {
  const failed = state.accounts.filter((account) => account.status === 'failed')
  await runPool(
    failed.map((account) => () => ensureSession(account.configId, { force: true }).catch(() => {})),
    LOGIN_CONCURRENCY,
  )
}
