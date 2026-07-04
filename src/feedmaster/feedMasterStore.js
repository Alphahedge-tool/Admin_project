import { useCallback, useEffect, useState } from 'react'
import { apiGet } from '../config/api'

export const FEED_MASTER_KEY = 'feed_master_account'
export const FEED_MASTER_CHANGED = 'feedmaster:changed'

export const BROKERS = [
  { id: 'angelone', label: 'Angel One' },
]

export function isAngelBroker(name = '') {
  return String(name).toLowerCase().replace(/\s/g, '').includes('angel')
}

export function sessionKey(configId) {
  return `angel_session_${configId}`
}

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

export function getSavedSession(configId) {
  try {
    return JSON.parse(localStorage.getItem(sessionKey(configId))) || null
  } catch {
    return null
  }
}

export function saveSession(configId, session) {
  if (!configId || !session) return
  localStorage.setItem(sessionKey(configId), JSON.stringify(session))
}

export function buildAngelClient(config, user, session = null) {
  if (!config?.account_id || !config?.app_key || !config?.pin || !config?.totp_secret) {
    return null
  }

  return {
    enabled: true,
    broker: 'angelone',
    configId: config.id,
    userId: user?.id || config.user_id || '',
    alias: `${user?.username || 'Feedmaster'} - ${config.account_id}`,
    clientCode: config.account_id,
    apiKey: config.app_key,
    pin: config.pin,
    totpSecret: config.totp_secret,
    loggedIn: !!session?.jwtToken,
    session,
  }
}

export async function loginAngelClient(client) {
  const response = await fetch('/api/angel/auto-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.status === false) {
    throw new Error(body.message || 'Angel auto-login failed')
  }
  return body
}

export function useFeedMasterAccount() {
  const [setting, setSetting] = useState(() => getSavedFeedMaster())
  const [client, setClient] = useState(null)
  const [status, setStatus] = useState(setting ? 'Loading Feedmaster...' : 'No Feedmaster selected')

  useEffect(() => {
    const onChange = () => setSetting(getSavedFeedMaster())
    window.addEventListener(FEED_MASTER_CHANGED, onChange)
    window.addEventListener('storage', onChange)
    return () => {
      window.removeEventListener(FEED_MASTER_CHANGED, onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function hydrate() {
      if (!setting?.configId) {
        setClient(null)
        setStatus('No Feedmaster selected')
        return
      }

      if (setting.broker !== 'angelone') {
        setClient(null)
        setStatus('This Feedmaster broker is not supported yet')
        return
      }

      setStatus('Loading Feedmaster...')
      try {
        const [configRes, usersRes] = await Promise.all([
          apiGet(`/users/broker-config/get.php?id=${setting.configId}`),
          apiGet('/users/list.php'),
        ])
        if (cancelled) return

        const config = configRes.data || {}
        const users = usersRes.data || []
        const user = users.find((u) => String(u.id) === String(setting.userId))
        const session = getSavedSession(setting.configId)
        const hydrated = buildAngelClient(config, user, session)

        if (!hydrated) {
          setClient(null)
          setStatus('Feedmaster credentials are incomplete')
          return
        }

        setClient(hydrated)
        setStatus(hydrated.loggedIn ? 'Feedmaster ready - live session saved' : 'Feedmaster ready')
      } catch (error) {
        if (!cancelled) {
          setClient(null)
          setStatus(error.message || 'Failed to load Feedmaster')
        }
      }
    }

    hydrate()
    return () => {
      cancelled = true
    }
  }, [setting])

  const handleSession = useCallback((session) => {
    setClient((current) => {
      if (!current) return current
      saveSession(current.configId, session)
      return { ...current, session, loggedIn: !!session?.jwtToken }
    })
    if (session?.jwtToken) setStatus('Feedmaster live')
  }, [])

  return { setting, client, status, handleSession }
}
