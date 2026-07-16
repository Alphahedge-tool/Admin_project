// Who the Trade Panel's book pages (Get Position, Get OrderBook, Get TradeBook)
// are allowed to show, and keeping all of them pointed at the same client.
import { useEffect, useMemo } from 'react'

import { useAngelSessions } from '../feedmaster/angelSessionStore'
import { useTradeAccount } from './tradeAccountStore'

/**
 * Every configured account the store knows about - logged in or NOT.
 *
 * The app no longer logs every broker in at startup; a page lists all configured
 * accounts and signs the picked one in on demand (see each page's load()). So an
 * account that is not logged in yet must still be offered - selecting it is HOW
 * you log it in. This used to filter to status==='live', which hid every account
 * that had not already been logged in, leaving nothing to pick.
 */
export function useAvailableAccounts() {
  const { accounts, phase } = useAngelSessions()

  return useMemo(() => {
    // Until the account list has loaded, don't filter at all - that would briefly
    // empty both pickers. Once ready, every loaded account is offered regardless
    // of whether its token is live yet.
    const ready = phase === 'ready'
    return {
      ready,
      configIds: new Set(accounts.map((account) => String(account.configId))),
      userIds: new Set(accounts.map((account) => String(account.userId))),
    }
  }, [accounts, phase])
}

/**
 * Follows the user/account picked on ANY Trade Panel page.
 *
 * Trade Panel keeps every tab mounted at once (TradePanelTabs toggles `hidden`,
 * it does not unmount), so a page reads the shared selection when it mounts and
 * then never again. Picking bberlia in Get Position was therefore invisible to
 * Order Book, which went on showing whoever it had loaded with. This adopts the
 * change instead, so switching tabs keeps the same client on screen.
 */
export function useSharedTradeAccount({
  userId, setUserId, configId, setConfigId, configs, onAdopt,
}) {
  const shared = useTradeAccount()

  useEffect(() => {
    const next = String(shared.userId || '')
    if (!next || next === String(userId)) return
    setUserId(next)
    // The account belongs to the user that was on screen - the config effect
    // below picks this user's own, once their configs have loaded.
    setConfigId('')
    onAdopt?.()
    // Only the shared value drives this; reacting to our own state would fight it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared.userId])

  useEffect(() => {
    const next = String(shared.configId || '')
    if (!next || next === String(configId)) return
    if (!configs.some((config) => String(config.id) === next)) return
    setConfigId(next)
    onAdopt?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared.configId, configs])
}
