// Who the Trade Panel's book pages (Get Position, Get OrderBook, Get TradeBook)
// are allowed to show, and keeping all of them pointed at the same client.
import { useEffect, useMemo } from 'react'

import { useAngelSessions } from '../feedmaster/angelSessionStore'
import { useTradeAccount } from './tradeAccountStore'

/**
 * The accounts that actually SIGNED IN at startup.
 *
 * An account that never logged in has no book to read - offering it only leads to
 * an empty table and a login error - so it is not listed, and a user with no
 * signed-in account is not listed either.
 */
export function useSignedInAccounts() {
  const { accounts, phase } = useAngelSessions()

  return useMemo(() => {
    // While the startup logins are still running, nothing is live yet. Filtering
    // on that would briefly empty both pickers, so hold off until it settles.
    const ready = phase === 'ready'
    const live = accounts.filter((account) => account.status === 'live')
    return {
      ready,
      configIds: new Set(live.map((account) => String(account.configId))),
      userIds: new Set(live.map((account) => String(account.userId))),
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
