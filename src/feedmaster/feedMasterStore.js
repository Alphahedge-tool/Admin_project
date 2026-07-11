// Which account provides the shared live websocket feed. The account's *session*
// is not managed here - every Angel session lives in angelSessionStore, which
// logs all accounts in at app start. This file only remembers WHICH of them is
// the Feedmaster and hands back its already-logged-in client.
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  clientFromAccount,
  saveSession,
  useAngelSessions,
} from './angelSessionStore'

export const FEED_MASTER_KEY = 'feed_master_account'
export const FEED_MASTER_CHANGED = 'feedmaster:changed'

// Re-exported so pages keep importing their session helpers from one place.
export {
  BROKERS,
  clearSession,
  clientFromAccount,
  ensureSession,
  getAngelClient,
  getSavedSession,
  isAngelBroker,
  loginAngelClient,
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

// The Feedmaster's client, already carrying the session the startup login saved.
// Never logs in here: if the account failed at startup, `status` says why.
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
