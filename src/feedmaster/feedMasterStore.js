// Which account provides the shared live websocket feed. The account's *session*
// is not managed here - every Angel session lives in angelSessionStore, which
// logs all accounts in at app start. This file only remembers WHICH of them is
// the Feedmaster and hands back its already-logged-in client.
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  clientFromAccount,
  ensureAccountsLoaded,
  ensureSession,
  saveSession,
  useAngelSessions,
} from './angelSessionStore'

export const FEED_MASTER_KEY = 'feed_master_account'
export const FEED_MASTER_CHANGED = 'feedmaster:changed'

// Re-exported so pages keep importing their session helpers from one place.
export {
  BROKERS,
  FEED_BROKERS,
  clearSession,
  clientFromAccount,
  ensureSession,
  getAngelClient,
  getSavedSession,
  isAngelBroker,
  isKotakBroker,
  loginAngelClient,
  refreshBrokerAccounts,
  saveSession,
  sessionKey,
  useAngelClient,
  useAngelSessions,
} from './angelSessionStore'

export function getSavedFeedMaster() {
  try {
    return JSON.parse(localStorage.getItem(FEED_MASTER_KEY)) || null
  } catch {
    return null
  }
}

export function saveFeedMaster(setting) {
  localStorage.setItem(FEED_MASTER_KEY, JSON.stringify(setting))
  window.dispatchEvent(new CustomEvent(FEED_MASTER_CHANGED, { detail: setting }))
}

export function clearFeedMaster() {
  localStorage.removeItem(FEED_MASTER_KEY)
  window.dispatchEvent(new CustomEvent(FEED_MASTER_CHANGED))
}

// Called once on every app open (right after login): loads the account list
// WITHOUT logging anything in, then signs in ONLY the saved Feedmaster account so
// the shared live feed is ready. This is the sole account that auto-connects -
// every other broker still logs in lazily when a page needs it. It keeps
// auto-connecting this same account until you pick a different one (or Clear) on
// the Feedmaster page. Re-uses a still-valid saved token; only does a fresh login
// when that token is dead. No-op until a Feedmaster has been saved.
export async function connectSavedFeedMaster() {
  const saved = getSavedFeedMaster()
  if (!saved?.configId) return
  await ensureAccountsLoaded()
  try {
    await ensureSession(String(saved.configId))
  } catch {
    // The Feedmaster page surfaces the exact login issue (PIN/TOTP/backend);
    // here we just try to connect quietly and let the feed report its status.
  }
}

// buildAngelClient is kept for callers that already hold a raw broker-config
// row (the Feedmaster page's account picker) rather than a store account.
export function buildAngelClient(config, user, session = null) {
  if (!config?.account_id || !config?.app_key || !config?.pin || !config?.totp_secret) {
    return null
  }
  return clientFromAccount({
    configId: String(config.id),
    userId: String(user?.id || config.user_id || ''),
    alias: `${user?.username || 'Feedmaster'} - ${config.account_id}`,
    accountId: config.account_id,
    apiKey: config.app_key,
    pin: config.pin,
    totpSecret: config.totp_secret,
    session,
  })
}

// The Feedmaster's client. Because the app no longer logs every broker in at
// startup, this hook is what keeps the saved Feedmaster signed in: it loads the
// account list and signs the Feedmaster in on its own, so any page that carries
// the shared feed gets a live account without depending on the app-open connect.
export function useFeedMasterAccount() {
  const [setting, setSetting] = useState(getSavedFeedMaster)
  const { accounts, phase } = useAngelSessions()

  useEffect(() => {
    const onChange = () => setSetting(getSavedFeedMaster())
    window.addEventListener(FEED_MASTER_CHANGED, onChange)
    window.addEventListener('storage', onChange)
    return () => {
      window.removeEventListener(FEED_MASTER_CHANGED, onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [])

  const configId = setting?.configId ? String(setting.configId) : ''
  const account = useMemo(
    () => accounts.find((item) => item.configId === configId) || null,
    [accounts, configId],
  )
  const client = useMemo(() => clientFromAccount(account), [account])

  // Make sure the account list is loaded, so the saved Feedmaster actually
  // exists in the store to be signed in (idempotent - deduped by the store).
  useEffect(() => {
    if (configId) ensureAccountsLoaded()
  }, [configId])

  // Sign the saved Feedmaster in once its account is loaded but not live yet.
  // Only a freshly loaded ('pending') account is auto-signed-in: a 'failed' one
  // is left alone so a bad credential can't spin in a retry loop, and a 'live'
  // or 'logging-in' one needs nothing. Deduped by the store, so several feed
  // pages share the one login.
  useEffect(() => {
    if (phase !== 'ready' || !configId) return
    if (!account || account.status !== 'pending') return
    ensureSession(configId).catch(() => {})
  }, [configId, phase, account])

  const status = useMemo(() => {
    if (!configId) return 'No Feedmaster selected'
    if (!account) return phase === 'ready' ? 'Feedmaster account no longer exists' : 'Loading Feedmaster...'
    if (account.status === 'live') return 'Feedmaster live'
    if (account.status === 'failed') return account.issue?.title || 'Feedmaster login failed'
    return 'Signing in Feedmaster...'
  }, [account, configId, phase])

  // Pages that get a refreshed session back from a broker call hand it here so
  // every other page sees the new token too.
  const handleSession = useCallback((session) => {
    if (configId) saveSession(configId, session)
  }, [configId])

  return { setting, client, status, handleSession }
}
