import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlignJustify, ArrowUpDown, Check, ChevronDown, History, Info, Minus, Pencil, Radio, RefreshCw, RotateCcw, Table, Trash2, X,
} from 'lucide-react'
import { apiGet, apiPost } from '../config/api'
import { useFeedMasterAccount } from '../feedmaster/feedMasterStore'
import {
  classifyLoginError, ensureSession, getAccount, isAngelBroker, useAngelSessions,
} from '../feedmaster/angelSessionStore'
import { releaseFeedTokens } from '../tradepanel/feedTokens'
import { getSavedTradeAccount, saveTradeAccount } from '../tradepanel/tradeAccountStore'
import { CompactSelect } from '../tradepanel/PositionSelect'
import { BrokerMark } from '../tradepanel/BrokerMark'
import { legIsClosed, money, withLiveTick } from '../tradepanel/legFormat'
import { CompactLegs, LegsTable } from '../tradepanel/strategyLegsView'
import { SkeletonCards } from '../tradepanel/TableSkeleton'
import '../tradepanel/tradepanel.css'

// Marks an open leg to market using that day's historical closing price
// instead of a live tick — used when browsing a PAST date, where no
// websocket is opened at all (see the historical-candle fetch below).
// Closed-that-day legs already carry real, locked-in exit data.
function withHistoricalLtp(leg, dateFilter, historicalLtps) {
  if (dateFilter === 'all' || legIsClosed(leg)) return leg

  const token = leg.symbol_token != null ? String(leg.symbol_token) : ''
  const entry = token ? historicalLtps[token] : null
  if (!entry || !(entry.close > 0)) return leg

  const qty = Number(leg.net_qty || 0)
  const pnl = qty > 0
    ? (entry.close - Number(leg.buy_avg || 0)) * qty
    : qty < 0
      ? (Number(leg.sell_avg || 0) - entry.close) * Math.abs(qty)
      : Number(leg.pnl || 0)

  return { ...leg, ltp: entry.close, pnl }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Sentinel user id for the bulk mode: run every user's every broker account,
// one account at a time. Never persisted to the shared trade-account store -
// the other Trade Panel pages would read it back as a real user id.
const ALL_USERS = 'all'
// A group selection scopes the whole page (Client picker, bulk sync queue and the
// strategies shown) to just that group's users. 'all' means every group.
const ALL_GROUPS = 'all-groups'

// How far through one account the bar sits at the start of each step. The sync
// really does await these in order, so the bar only moves on work that finished.
const SIGN_IN_DONE = 0.35

// Raw YYYY-MM-DD slice straight off the backend's created_at, no Date()
// parsing/timezone shifting, so the filter matches exactly what was stored.
function legDateKey(leg) {
  const raw = leg.created_at || leg.createdAt
  if (!raw) return ''
  return String(raw).slice(0, 10)
}

function formatDateKey(key) {
  const [y, m, d] = key.split('-')
  return `${d} ${MONTHS[Number(m) - 1] || m} ${y}`
}

// Raw YYYY-MM-DD slice of closed_at, same rules as legDateKey.
function legClosedDateKey(leg) {
  const raw = leg.closed_at || leg.closedAt
  if (!raw) return ''
  return String(raw).slice(0, 10)
}

// A leg's is_closed/exit_price are permanent, current-state flags in the
// backend — closing overwrites them regardless of which day the position
// was actually opened on. Browsing a PAST date should show exactly what had
// happened BY that date, nothing from later:
//   - closed on the exact date being viewed -> real entry + real exit/pnl,
//     both genuinely happened that day.
//   - closed on a LATER date -> as of this date the position hadn't exited
//     yet, so the exit price/closed badge are hidden (that exit is a future
//     event relative to the date being viewed). Its ltp/pnl (mark-to-market
//     detail) are still shown as-is, since that's genuine data, not
//     something to hide.
//   - still genuinely open -> shown as-is, nothing to derive.
function deriveLegForDate(leg, dateFilter) {
  if (dateFilter === 'all' || !legIsClosed(leg)) return leg

  const closedKey = legClosedDateKey(leg)
  if (closedKey === dateFilter) return leg // closed on the very date being viewed - show as is

  const exitQty = Number(leg.exit_qty || 0)
  const magnitude = exitQty > 0 ? exitQty : Math.abs(Number(leg.net_qty || 0))
  const wasShort = Number(leg.sell_avg || 0) > 0 && !(Number(leg.buy_avg || 0) > 0)

  return {
    ...leg,
    net_qty: wasShort ? -magnitude : magnitude,
    // legIsClosed() also treats closed_at/exit_price/exitPrice as closed
    // flags on their own, so all of them must be cleared - not just is_closed.
    is_closed: 0,
    closed: 0,
    closed_at: null,
    exit_price: null,
    exitPrice: null,
  }
}

function SyncNetPositions() {
  const [users, setUsers] = useState([])
  const [userId, setUserId] = useState('')
  const [groups, setGroups] = useState([])
  const [groupId, setGroupId] = useState(ALL_GROUPS)
  const [configs, setConfigs] = useState([])
  const [configId, setConfigId] = useState('')
  const [status, setStatus] = useState('Select a user and account')
  const [running, setRunning] = useState('') // '' | 'sync' | 'unsync'
  const [progress, setProgress] = useState(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [log, setLog] = useState([])
  const [summary, setSummary] = useState(null)
  const [strategies, setStrategies] = useState([])
  const [strategiesLoading, setStrategiesLoading] = useState(false)
  const [view, setView] = useState('normal') // 'compact' | 'normal' | 'buysell'
  const [dateFilter, setDateFilter] = useState('all')
  const [selectedLegKeys, setSelectedLegKeys] = useState(() => new Set())
  const [removingLegs, setRemovingLegs] = useState(false)
  const [clearingStrategies, setClearingStrategies] = useState(false)
  const [editingStrategyCode, setEditingStrategyCode] = useState('')
  const [editingStrategyId, setEditingStrategyId] = useState('')
  const [editingStrategyName, setEditingStrategyName] = useState('')
  const [savingStrategyName, setSavingStrategyName] = useState(false)
  const [savingBrokerTagCode, setSavingBrokerTagCode] = useState('')
  const [brokerTagDoneCode, setBrokerTagDoneCode] = useState('')
  const [brokerConfigs, setBrokerConfigs] = useState([])
  // Strategy cards whose legs are collapsed. Default expanded (legs visible);
  // clicking a card's head toggles its legs open/closed.
  const [collapsedStrategies, setCollapsedStrategies] = useState(() => new Set())

  const toggleStrategyCollapsed = useCallback((code) => {
    setCollapsedStrategies((current) => {
      const next = new Set(current)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }, [])

  // Startup logged every Angel account in and kept its real client code. The
  // broker-config list endpoint masks account_id as "****", so that store is
  // the only place the actual account number can be read from.
  const { accounts: angelAccounts } = useAngelSessions()
  const angelAccountByConfigId = useMemo(() => {
    const map = new Map()
    angelAccounts.forEach((account) => map.set(String(account.configId), account))
    return map
  }, [angelAccounts])

  // Every active broker account of every active user, across ALL brokers - not
  // just Angel - so a user with an Angel and a Zerodha account shows both, and
  // the unwired one is reported as such instead of silently vanishing.
  const allAccounts = useMemo(() => brokerConfigs.map((config) => ({
    ...config,
    accountId: angelAccountByConfigId.get(config.configId)?.accountId || '',
  })), [brokerConfigs, angelAccountByConfigId])
  const { client: feedMasterClient, handleSession: onFeedMasterSession } = useFeedMasterAccount()
  const [liveTicks, setLiveTicks] = useState({})
  const [feedStatus, setFeedStatus] = useState('offline') // 'offline' | 'connecting' | 'live'
  const [historicalLtps, setHistoricalLtps] = useState({})
  const [historicalStatus, setHistoricalStatus] = useState('idle') // 'idle' | 'loading' | 'done' | 'error'
  const feedMasterClientRef = useRef(null)
  const esRef = useRef(null)
  const feedTokenSetRef = useRef(new Set())
  const liveRef = useRef({})
  const prevRef = useRef({})
  const rafRef = useRef(0)
  const dirtyRef = useRef(false)
  const brokerTagDoneTimerRef = useRef(null)

  useEffect(() => {
    feedMasterClientRef.current = feedMasterClient
  }, [feedMasterClient])

  // Every OPEN leg across all saved strategies, regardless of the date/view
  // filter currently on screen - closed legs have a locked-in exit and don't
  // need a live mark.
  const legFeedKey = useMemo(() => {
    const seen = new Set()
    strategies.forEach((strategy) => {
      (strategy.legs || []).forEach((leg) => {
        if (legIsClosed(leg)) return
        const token = leg.symbol_token
        if (token == null || token === '') return
        seen.add(`${leg.exchange || 'NFO'}|${token}`)
      })
    })
    return [...seen].sort().join(',')
  }, [strategies])

  // Keep the feed reconciled to exactly this leg set, and stream ticks over
  // the same Feedmaster SSE connection the rest of Trade Panel uses. Only
  // for the "All dates" (live/today) view — browsing a past date never
  // opens a websocket at all, it's reconciled from the historical API
  // instead (see below).
  useEffect(() => {
    let cancelled = false

    function scheduleFlush() {
      dirtyRef.current = true
      if (rafRef.current) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0
        if (!dirtyRef.current) return
        dirtyRef.current = false
        setLiveTicks({ ...liveRef.current })
      })
    }

    async function syncFeedTokens() {
      if (dateFilter !== 'all') {
        esRef.current?.close()
        esRef.current = null
        setFeedStatus('offline')
        return
      }

      const client = feedMasterClientRef.current
      if (!client) return

      let session = client.session
      if (!session?.jwtToken || !session?.feedToken) {
        // Startup logged the Feedmaster in; this only covers an expired token,
        // and it is deduped across every page.
        setFeedStatus('connecting')
        try {
          session = await ensureSession(client.configId, { force: true })
          if (session?.jwtToken) onFeedMasterSession?.(session)
        } catch {
          setFeedStatus('offline')
          return
        }
      }
      if (cancelled || !session?.jwtToken || !session?.feedToken) {
        setFeedStatus('offline')
        return
      }

      const items = (legFeedKey ? legFeedKey.split(',') : []).map((pair) => {
        const [exchange, token] = pair.split('|')
        return { exchange, token }
      })
      feedTokenSetRef.current = new Set(items.map((item) => String(item.token)))

      if (!items.length) {
        setFeedStatus('offline')
        return
      }

      try {
        await fetch('/api/angel/basket-tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            credentials: {
              jwtToken: session.jwtToken,
              feedToken: session.feedToken,
              apiKey: client.apiKey,
              clientCode: client.clientCode,
            },
            items,
            subscriber: 'sync-net-positions',
          }),
        })
      } catch {
        setFeedStatus('offline')
        return
      }
      if (cancelled) return

      let source = esRef.current
      if (!source || source.readyState === 2) {
        setFeedStatus('connecting')
        source = new EventSource('/api/angel/stream')
        esRef.current = source
        source.addEventListener('status', (event) => {
          try {
            const info = JSON.parse(event.data)
            setFeedStatus(info.connected ? 'live' : 'offline')
          } catch {
            // ignore malformed status payloads
          }
        })
        source.onerror = () => setFeedStatus('offline')
      } else {
        setFeedStatus('live')
      }

      source.onmessage = (event) => {
        let tick
        try { tick = JSON.parse(event.data) } catch { return }
        const token = String(tick.token)
        if (!feedTokenSetRef.current.has(token)) return
        const prev = prevRef.current[token]
        const dir = prev == null ? '' : tick.ltp > prev ? 'up' : tick.ltp < prev ? 'down' : ''
        prevRef.current[token] = tick.ltp
        liveRef.current[token] = { ltp: tick.ltp, dir, at: event.timeStamp || performance.now() }
        scheduleFlush()
      }
    }

    syncFeedTokens()
    return () => {
      cancelled = true
    }
  }, [legFeedKey, feedMasterClient, onFeedMasterSession, dateFilter])

  // Leaving the page hands its tokens back to the feed, so coming back re-syncs
  // them as a fresh subscription (which is what makes Angel re-push a snapshot).
  useEffect(() => () => {
    esRef.current?.close()
    releaseFeedTokens('sync-net-positions')
  }, [])

  useEffect(() => () => {
    if (brokerTagDoneTimerRef.current) clearTimeout(brokerTagDoneTimerRef.current)
  }, [])

  // Every leg entered on the date being browsed that doesn't already have a
  // real, locked-in exit for that exact day - these need a historical close
  // price to mark to, since there's no live feed running for a past date.
  const historicalFeedKey = useMemo(() => {
    if (dateFilter === 'all') return ''
    const seen = new Set()
    strategies.forEach((strategy) => {
      (strategy.legs || []).forEach((leg) => {
        if (legDateKey(leg) !== dateFilter) return
        if (legIsClosed(leg) && legClosedDateKey(leg) === dateFilter) return
        const token = leg.symbol_token
        if (token == null || token === '') return
        seen.add(`${leg.exchange || 'NFO'}|${token}`)
      })
    })
    return [...seen].sort().join(',')
  }, [strategies, dateFilter])

  // Reconcile that day's LTP from Angel's Historical Candle API (one day's
  // close, via Feedmaster's session) instead of any live feed connection.
  useEffect(() => {
    let cancelled = false

    async function loadHistorical() {
      if (dateFilter === 'all' || !historicalFeedKey) {
        setHistoricalLtps({})
        setHistoricalStatus('idle')
        return
      }

      const feedClient = feedMasterClientRef.current
      if (!feedClient) {
        setHistoricalStatus('error')
        return
      }

      setHistoricalStatus('loading')

      let session = feedClient.session
      if (!session?.jwtToken) {
        try {
          session = await ensureSession(feedClient.configId, { force: true })
          if (session?.jwtToken) onFeedMasterSession?.(session)
        } catch {
          if (!cancelled) setHistoricalStatus('error')
          return
        }
      }
      if (cancelled || !session?.jwtToken) return

      const items = historicalFeedKey.split(',').map((pair) => {
        const [exchange, token] = pair.split('|')
        return { exchange, token }
      })

      const results = await Promise.all(items.map(async (item) => {
        try {
          const res = await fetch('/api/angel/historical-candle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              client: feedClient,
              exchange: item.exchange,
              symboltoken: item.token,
              interval: 'ONE_DAY',
              fromdate: `${dateFilter} 00:00`,
              todate: `${dateFilter} 23:59`,
            }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body.status === false) return null
          const candles = body.candles || []
          const last = candles[candles.length - 1]
          const close = last ? Number(last[4]) : null
          return close > 0 ? { token: item.token, close } : null
        } catch {
          return null
        }
      }))

      if (cancelled) return
      const next = {}
      results.forEach((entry) => { if (entry) next[String(entry.token)] = { close: entry.close } })
      setHistoricalLtps(next)
      setHistoricalStatus('done')
    }

    loadHistorical()
    return () => {
      cancelled = true
    }
  }, [historicalFeedKey, dateFilter, onFeedMasterSession])

  const availableDates = useMemo(() => {
    const keys = new Set()
    strategies.forEach((strategy) => {
      (strategy.legs || []).forEach((leg) => {
        const key = legDateKey(leg)
        if (key) keys.add(key)
      })
    })
    return Array.from(keys).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  }, [strategies])

  const allUsers = userId === ALL_USERS
  const selectedUser = users.find((user) => String(user.id) === String(userId))
  const selectedConfig = configs.find((config) => String(config.id) === String(configId))
  const selectedBrokerName = selectedConfig?.broker_name || ''
  const selectedIsAngel = isAngelBroker(selectedBrokerName)

  const selectedGroup = groups.find((group) => String(group.id) === String(groupId)) || null

  // The users a group selection narrows the page down to (all users when the
  // group filter is 'all-groups'). The Client picker, the bulk sync queue and the
  // strategies shown all work off THIS list.
  const groupUsers = useMemo(() => (
    groupId === ALL_GROUPS
      ? users
      : users.filter((user) => String(user.group_id || '') === String(groupId))
  ), [users, groupId])

  // Every broker account inside the current group scope - what a group-wide Sync
  // walks, one account at a time.
  const scopedAccounts = useMemo(() => {
    if (groupId === ALL_GROUPS) return allAccounts
    const ids = new Set(groupUsers.map((user) => String(user.id)))
    return allAccounts.filter((account) => ids.has(String(account.userId)))
  }, [allAccounts, groupUsers, groupId])

  const bulkAccountGroups = useMemo(() => groupByUser(scopedAccounts), [scopedAccounts])

  const canRun = allUsers ? scopedAccounts.length > 0 : Boolean(selectedConfig)

  // Manual picks here should also become the shared Trade Panel selection -
  // except the bulk sentinel, which only means something on this page.
  const handleUserId = useCallback((value) => {
    setUserId(value)
    if (value !== ALL_USERS) saveTradeAccount({ userId: value, configId: '' })
  }, [])

  // Picking a group shows that whole group at once - its members' strategies and
  // its accounts - rather than leaving one user selected.
  const handleGroupId = useCallback((value) => {
    setGroupId(value)
    setUserId(ALL_USERS)
    setConfigId('')
    // Group overview is read-only, so drop any leg selection carried in from a
    // single-account view.
    setSelectedLegKeys(new Set())
  }, [])

  const handleConfigId = useCallback((value) => {
    setConfigId(value)
    if (userId !== ALL_USERS) saveTradeAccount({ userId, configId: value })
  }, [userId])

  const loadStrategies = useCallback(async (nextUserId = userId, cancelled = false) => {
    // Group overview: pull every member's strategies at once and tag each with
    // its owner, so the cards can span the whole group. Read-only in this mode.
    if (nextUserId === ALL_USERS) {
      if (!groupUsers.length) {
        setStrategies([])
        return
      }
      setStrategiesLoading(true)
      try {
        const results = await Promise.all(groupUsers.map(async (user) => {
          try {
            const res = await apiGet(`/strategy-master/list.php?user_id=${user.id}`)
            return (res.data || []).map((strategy) => ({
              ...strategy,
              _userId: String(user.id),
              _userLabel: userLabel(user),
            }))
          } catch {
            return []
          }
        }))
        if (!cancelled) setStrategies(results.flat())
      } finally {
        if (!cancelled) setStrategiesLoading(false)
      }
      return
    }

    if (!nextUserId) {
      setStrategies([])
      return
    }

    setStrategiesLoading(true)
    try {
      const res = await apiGet(`/strategy-master/list.php?user_id=${nextUserId}`)
      if (!cancelled) setStrategies(res.data || [])
    } catch {
      if (!cancelled) setStrategies([])
    } finally {
      if (!cancelled) setStrategiesLoading(false)
    }
  }, [userId, groupUsers])

  const toggleLegSelection = useCallback((legId) => {
    setSelectedLegKeys((current) => {
      const next = new Set(current)
      if (next.has(legId)) next.delete(legId)
      else next.add(legId)
      return next
    })
  }, [])

  const legSelection = useMemo(
    () => ({ selectedKeys: selectedLegKeys, onToggle: toggleLegSelection }),
    [selectedLegKeys, toggleLegSelection],
  )

  const selectStrategyLegs = useCallback((legs) => {
    const ids = legs.map((leg) => leg.id).filter((id) => id != null)
    if (!ids.length) return

    setSelectedLegKeys((current) => {
      const next = new Set(current)
      const allSelected = ids.every((id) => next.has(id))
      ids.forEach((id) => {
        if (allSelected) next.delete(id)
        else next.add(id)
      })
      return next
    })
  }, [])

  const visibleStrategyLegIds = useMemo(
    () => strategies.flatMap((strategy) => {
      const legs = strategy.legs || []
      const visibleLegs = dateFilter === 'all'
        ? legs
        : legs.filter((leg) => legDateKey(leg) === dateFilter)

      return visibleLegs.map((leg) => leg.id).filter((id) => id != null)
    }),
    [dateFilter, strategies],
  )

  const allVisibleStrategyLegsSelected = visibleStrategyLegIds.length > 0
    && visibleStrategyLegIds.every((id) => selectedLegKeys.has(id))
  const someVisibleStrategyLegsSelected = !allVisibleStrategyLegsSelected
    && visibleStrategyLegIds.some((id) => selectedLegKeys.has(id))

  const toggleAllVisibleStrategyLegs = useCallback(() => {
    if (!visibleStrategyLegIds.length) return

    setSelectedLegKeys((current) => {
      const next = new Set(current)
      const shouldClear = visibleStrategyLegIds.every((id) => next.has(id))

      visibleStrategyLegIds.forEach((id) => {
        if (shouldClear) next.delete(id)
        else next.add(id)
      })

      return next
    })
  }, [visibleStrategyLegIds])

  const startEditStrategy = useCallback((strategy) => {
    setEditingStrategyCode(strategy.strategy_code)
    setEditingStrategyId(strategy.id || strategy.strategy_id || '')
    setEditingStrategyName(strategy.strategy_name || '')
  }, [])

  const cancelEditStrategy = useCallback(() => {
    setEditingStrategyCode('')
    setEditingStrategyId('')
    setEditingStrategyName('')
  }, [])

  const saveStrategyName = useCallback(async () => {
    const name = editingStrategyName.trim()
    if (savingStrategyName || !editingStrategyCode || !name) return

    setSavingStrategyName(true)
    try {
      const payload = {
        id: editingStrategyId,
        strategy_id: editingStrategyId,
        user_id: Number(userId),
        strategy_code: editingStrategyCode,
        strategyCode: editingStrategyCode,
        strategy_name: name,
        strategyName: name,
        name,
      }
      await apiPost('/strategy-master/update.php', payload)
      setStrategies((current) => current.map((strategy) => (
        String(strategy.strategy_code) === String(editingStrategyCode)
          ? { ...strategy, strategy_name: name, strategyName: name, name }
          : strategy
      )))
      setStatus('Strategy name updated')
      cancelEditStrategy()
      await loadStrategies(userId)
    } catch (error) {
      setStatus(error.message || 'Failed to update strategy name')
    } finally {
      setSavingStrategyName(false)
    }
  }, [cancelEditStrategy, editingStrategyCode, editingStrategyId, editingStrategyName, loadStrategies, userId])

  const saveStrategyBrokerTag = useCallback(async (strategy) => {
    if (!selectedConfig || !strategy?.strategy_code || savingBrokerTagCode) return

    const brokerPatch = {
      broker_config_id: Number(configId || 0) || null,
      broker_name: selectedBrokerName || selectedConfig.broker_name || '',
      broker_account_id: selectedConfig.account_id || '',
    }

    setSavingBrokerTagCode(strategy.strategy_code)
    try {
      await apiPost('/strategy-master/update.php', {
        id: strategy.id,
        strategy_id: strategy.id,
        user_id: Number(userId),
        strategy_code: strategy.strategy_code,
        strategyCode: strategy.strategy_code,
        ...brokerPatch,
      })
      setStrategies((current) => current.map((item) => (
        String(item.strategy_code) === String(strategy.strategy_code)
          ? { ...item, ...brokerPatch }
          : item
      )))
      setStatus('Broker tag updated')
      setBrokerTagDoneCode(strategy.strategy_code)
      if (brokerTagDoneTimerRef.current) clearTimeout(brokerTagDoneTimerRef.current)
      brokerTagDoneTimerRef.current = window.setTimeout(() => {
        setBrokerTagDoneCode((current) => (
          current === strategy.strategy_code ? '' : current
        ))
      }, 1800)
      await loadStrategies(userId)
    } catch (error) {
      setStatus(error.message || 'Failed to update broker tag')
    } finally {
      setSavingBrokerTagCode('')
    }
  }, [configId, loadStrategies, savingBrokerTagCode, selectedBrokerName, selectedConfig, userId])

  const removeSelectedLegs = useCallback(async () => {
    const ids = Array.from(selectedLegKeys)
    if (!ids.length) return

    setRemovingLegs(true)
    try {
      await Promise.all(ids.map((id) => apiPost('/strategy-master/delete-leg.php', { id })))
      setStatus(`Removed ${ids.length} leg${ids.length === 1 ? '' : 's'}`)
      setSelectedLegKeys(new Set())
      await loadStrategies(userId)
    } catch (error) {
      setStatus(error.message || 'Failed to remove legs')
    } finally {
      setRemovingLegs(false)
    }
  }, [selectedLegKeys, loadStrategies, userId])

  // Wipe every saved strategy (and all their legs) for the selected user from the
  // backend in one call. Permanent and unlike per-leg removal there is no unsync
  // to bring these back, so it is gated behind an explicit confirm.
  const clearAllStrategies = useCallback(async () => {
    if (clearingStrategies || !userId || allUsers || !strategies.length) return

    const label = userLabel(selectedUser) || `user ${userId}`
    const confirmed = window.confirm(
      `Clear ALL ${strategies.length} ${strategies.length === 1 ? 'strategy' : 'strategies'} for ${label}?\n\n`
      + 'This permanently deletes them and every one of their legs from the backend. It cannot be undone.',
    )
    if (!confirmed) return

    setClearingStrategies(true)
    try {
      const res = await apiPost('/strategy-master/clear.php', { user_id: Number(userId) })
      setSelectedLegKeys(new Set())
      cancelEditStrategy()
      await loadStrategies(userId)
      setStatus(res.message || 'Strategies cleared')
    } catch (error) {
      setStatus(error.message || 'Failed to clear strategies')
    } finally {
      setClearingStrategies(false)
    }
  }, [allUsers, cancelEditStrategy, clearingStrategies, loadStrategies, selectedUser, strategies.length, userId])

  useEffect(() => {
    setSelectedLegKeys(new Set())
    cancelEditStrategy()
  }, [userId, cancelEditStrategy])

  useEffect(() => {
    let cancelled = false

    async function loadUsers() {
      try {
        const [usersOut, authOut, groupsOut] = await Promise.allSettled([
          apiGet('/users/list.php'),
          apiGet('/auth/me.php'),
          apiGet('/masters/groups/list.php'),
        ])
        if (cancelled) return

        if (usersOut.status !== 'fulfilled') {
          setStatus('Failed to load users')
          return
        }

        const list = usersOut.value.data || []
        setUsers(list)
        // Only groups that actually have a user in them are worth offering.
        const allGroups = groupsOut.status === 'fulfilled' ? (groupsOut.value.data || []) : []
        const peopled = new Set(list.map((user) => String(user.group_id || '')))
        setGroups(allGroups.filter((group) => peopled.has(String(group.id))))
        const auth = authOut.status === 'fulfilled' ? authOut.value : null
        const principal = auth?.user || auth?.admin || auth?.data || auth || {}

        // Reuse whichever user/account was last picked on any Trade Panel
        // page (Get Position, Get OrderBook, Get TradeBook, Sync Net
        // Positions), so switching pages keeps the same account selected.
        const saved = getSavedTradeAccount()
        const savedUser = saved.userId && list.some((u) => String(u.id) === String(saved.userId))
          ? list.find((u) => String(u.id) === String(saved.userId))
          : null
        const current = savedUser || findLoggedInUser(list, principal) || list[0]
        if (current?.id) {
          setUserId(String(current.id))
          saveTradeAccount({ userId: String(current.id) })
          setStatus(`Select account for ${current.username || 'user'}`)
        } else {
          setStatus('No users available')
        }
      } catch {
        if (!cancelled) setStatus('Failed to load users')
      }
    }

    loadUsers()
    return () => {
      cancelled = true
    }
  }, [])

  // The bulk queue. Mirrors the backend's own selection (active user, active
  // broker config) so the accounts listed on screen are exactly the ones a sync
  // will touch.
  useEffect(() => {
    let cancelled = false

    async function loadBrokerConfigs() {
      const activeUsers = users.filter((user) => Number(user.is_active) === 1)
      if (!activeUsers.length) {
        setBrokerConfigs([])
        return
      }

      const perUser = await Promise.all(activeUsers.map(async (user) => {
        try {
          const res = await apiGet(`/users/broker-config/list.php?user_id=${user.id}`)
          return (res.data || [])
            .filter((config) => config.is_active)
            .map((config) => ({
              configId: String(config.id),
              userId: String(user.id),
              username: userLabel(user),
              brokerName: config.broker_name || 'Broker',
            }))
        } catch {
          return []
        }
      }))

      if (!cancelled) setBrokerConfigs(perUser.flat())
    }

    loadBrokerConfigs()
    return () => {
      cancelled = true
    }
  }, [users])

  useEffect(() => {
    let cancelled = false

    async function loadConfigs() {
      if (!userId || userId === ALL_USERS) {
        setConfigs([])
        setConfigId('')
        return
      }

      setConfigLoading(true)
      try {
        const res = await apiGet(`/users/broker-config/list.php?user_id=${userId}`)
        if (cancelled) return

        const list = res.data || []
        setConfigs(list)
        const saved = getSavedTradeAccount()
        const savedConfigId = String(saved.userId || '') === String(userId) && saved.configId
          && list.some((c) => String(c.id) === String(saved.configId))
          ? saved.configId
          : ''
        const nextConfigId = String(savedConfigId || list[0]?.id || '')
        setConfigId(nextConfigId)
        if (nextConfigId) saveTradeAccount({ userId: String(userId), configId: nextConfigId })
        setStatus(list.length ? '' : 'No broker accounts configured for this user')
      } catch {
        if (!cancelled) setStatus('Failed to load broker accounts')
      } finally {
        if (!cancelled) setConfigLoading(false)
      }
    }

    loadConfigs()
    return () => {
      cancelled = true
    }
  }, [userId])

  // Show the strategies (and their legs) this user has saved.
  useEffect(() => {
    let cancelled = false

    loadStrategies(userId, cancelled)
    return () => {
      cancelled = true
    }
  }, [loadStrategies, userId])

  // A different user/account means a different run - drop the previous run's
  // progress, summary and log rather than leaving them to be misread as this
  // selection's result.
  useEffect(() => {
    setProgress(null)
    setLog([])
    setSummary(null)
  }, [userId, configId])

  useEffect(() => {
    if (allUsers) {
      const scope = selectedGroup ? ` in ${selectedGroup.name}` : ''
      setStatus(scopedAccounts.length
        ? `${scopedAccounts.length} broker account${scopedAccounts.length === 1 ? '' : 's'}${scope} queued`
        : `No broker accounts configured${scope}`)
      return
    }

    if (!selectedConfig) return
    if (!selectedIsAngel) {
      setStatus(`${selectedBrokerName || 'Selected broker'} sync is not wired yet`)
      return
    }

    // The account was logged in at app start; if it failed, say why (PIN, TOTP,
    // API key, backend down) rather than "not logged in".
    const account = getAccount(configId)
    if (account?.status === 'failed') {
      setStatus(`${account.issue?.title || 'Login failed'}. ${account.issue?.hint || ''}`.trim())
    } else {
      setStatus('')
    }
  }, [scopedAccounts.length, selectedGroup, allUsers, configId, selectedBrokerName, selectedConfig, selectedIsAngel])

  // Every broker account the run will touch, grouped user-then-account so the
  // bulk mode walks them in the order they are listed on screen.
  const buildQueue = useCallback(() => {
    if (allUsers) {
      return [...scopedAccounts].sort((a, b) => (
        Number(a.userId) - Number(b.userId) || Number(a.configId) - Number(b.configId)
      ))
    }

    if (!selectedConfig) return []
    return [{
      configId: String(configId),
      userId: String(userId),
      username: userLabel(selectedUser) || `User ${userId}`,
      brokerName: selectedBrokerName || 'Broker',
      accountId: angelAccountByConfigId.get(String(configId))?.accountId || '',
    }]
  }, [scopedAccounts, allUsers, angelAccountByConfigId, configId, selectedBrokerName, selectedConfig, selectedUser, userId])

  // Sync and unsync walk the same queue one account at a time; only the work
  // done per account differs. Driving the loop here (rather than handing the
  // whole selection to PHP and waiting on one long call) is what makes the
  // progress real: every step the bar advances on is a step that has finished.
  const runQueue = useCallback(async (mode) => {
    const isSync = mode === 'sync'
    const queue = buildQueue()

    if (!queue.length) {
      setStatus(allUsers ? 'No broker accounts to run' : 'Select an account first')
      return
    }

    // An unwired broker is not turned away here - it goes through the queue like
    // any other account and comes out as "skipped", so a single Zerodha account
    // says the same thing it would say inside a bulk run.
    setRunning(mode)
    setLog([])
    setSummary(null)

    const total = queue.length
    const logLines = []
    let success = 0
    let failed = 0
    let skipped = 0
    let completed = 0

    // Every account is on screen from the start, so the whole run is visible up
    // front and each one is watched through queued -> running -> done.
    const live = new Map(queue.map((item) => [
      item.configId,
      { ...item, state: 'queued', percent: 0, detail: 'Queued' },
    ]))

    const patch = (item, next) => live.set(item.configId, { ...live.get(item.configId), ...next })

    // `fraction` is how far into the account currently running we are, so the
    // overall bar keeps moving inside an account, not only between accounts.
    const publish = (fraction = 0, done = false) => {
      setProgress({
        mode,
        total,
        done,
        percent: done ? 100 : Math.min(100, Math.round(((completed + fraction) / total) * 100)),
        groups: groupByUser([...live.values()]),
      })
    }

    publish()

    for (const item of queue) {
      // Every broker goes to the backend now - it resolves the account's own
      // adapter and answers with a real reason if it cannot read that broker,
      // rather than the frontend deciding up front what is "wired".
      if (isSync) {
        patch(item, { state: 'running', percent: 0, detail: `Signing in to ${item.brokerName}…` })
        publish(0)

        // Angel's session lives in the browser (the whole Trade Panel reads it),
        // so a dead token is worth catching here, where the message can name the
        // credential to fix. Every other broker is logged in server-side by the
        // sync itself - signing in here as well would spend a second TOTP inside
        // the same 30s window, which the broker then rejects.
        if (isAngelBroker(item.brokerName)) {
          try {
            // Normally a no-op - startup logged every account in. Only an expired
            // token actually re-logs in here.
            await ensureSession(item.configId)
          } catch (error) {
            const issue = classifyLoginError(error)
            const detail = `${issue.title}. ${issue.hint}`
            failed += 1
            completed += 1
            patch(item, { state: 'failed', percent: 100, detail })
            logLines.push(`${item.username} ${detail}`)
            publish()
            continue
          }
        }

        patch(item, { percent: Math.round(SIGN_IN_DONE * 100), detail: 'Syncing net positions…' })
        publish(SIGN_IN_DONE)
      } else {
        patch(item, { state: 'running', percent: 0, detail: 'Restoring pre-sync state…' })
        publish(0)
      }

      try {
        const res = await apiPost(
          isSync
            ? '/transactions/sync-net-positions.php'
            : '/transactions/unsync-net-positions.php',
          {
            ...(isSync ? { live: true } : null),
            user_id: item.userId,
            broker_config_id: item.configId,
          },
        )

        const lines = res.log || []
        logLines.push(...lines)

        // The endpoint ran for exactly this one account, so its own counters say
        // what happened to it. "skipped" is unsync's "nothing left to undo", and
        // zero accounts means the backend did not consider it active at all.
        const accountSummary = res.summary || {}
        const state = Number(accountSummary.total_accounts || 0) === 0
          ? 'skipped'
          : Number(accountSummary.failed || 0) > 0
            ? 'failed'
            : Number(accountSummary.skipped || 0) > 0
              ? 'skipped'
              : 'ok'

        if (state === 'failed') failed += 1
        else if (state === 'skipped') skipped += 1
        else success += 1

        completed += 1
        patch(item, {
          state,
          percent: 100,
          detail: stripName(lines[0], item.username) || (isSync ? 'Synced' : 'Unsynced'),
        })
        publish()
      } catch (error) {
        const detail = error.message || (isSync ? 'Sync failed' : 'Unsync failed')
        failed += 1
        completed += 1
        patch(item, { state: 'failed', percent: 100, detail })
        logLines.push(`${item.username} ${detail}`)
        publish()
      }
    }

    publish(0, true)

    setSummary({ total_accounts: total, success, failed, skipped })
    setLog(logLines)

    const verb = isSync ? 'Sync' : 'Unsync'
    setStatus(failed
      ? `${verb} completed with ${failed} failure${failed === 1 ? '' : 's'}`
      : `${verb} completed`)

    // The legs the run closed (or reopened) are only visible once reloaded -
    // for a single user or the whole group's aggregated cards alike.
    await loadStrategies(userId)

    setRunning('')
  }, [allUsers, buildQueue, loadStrategies, userId])

  return (
    <div className="trade-panel">
      <div className="positions-view positions-view-compact sync-view sync-view-production">
        <div className="positions-toolbar">
          <CompactSelect
            title="Group"
            icon="group"
            value={groupId}
            onChange={handleGroupId}
            disabled={Boolean(running) || !groups.length}
            options={[
              { value: ALL_GROUPS, label: 'All groups', meta: `${users.length} user${users.length === 1 ? '' : 's'}` },
              ...groups.map((group) => ({
                value: String(group.id),
                label: group.name,
                meta: `${users.filter((user) => String(user.group_id || '') === String(group.id)).length} users`,
              })),
            ]}
          />

          <CompactSelect
            title="Client"
            icon="user"
            menuMinWidth={240}
            value={userId}
            onChange={handleUserId}
            disabled={Boolean(running)}
            options={[
              ...(scopedAccounts.length
                ? [{
                  value: ALL_USERS,
                  label: selectedGroup ? `All of ${selectedGroup.name}` : 'All users',
                  meta: `${scopedAccounts.length} account${scopedAccounts.length === 1 ? '' : 's'}`,
                }]
                : []),
              ...groupUsers.map((user) => ({
                value: String(user.id),
                label: userLabel(user),
              })),
            ]}
          />

          <CompactSelect
            title="Account"
            value={allUsers ? ALL_USERS : configId}
            onChange={handleConfigId}
            disabled={Boolean(running) || allUsers || configLoading || !configs.length}
            options={allUsers
              ? [{ value: ALL_USERS, label: 'All accounts', meta: selectedGroup ? selectedGroup.name : 'Every user' }]
              : configs.map((config) => ({
                value: String(config.id),
                label: config.account_id || `Account ${config.id}`,
                meta: config.broker_name || 'Broker',
              }))}
          />

          <button
            className="positions-load-btn"
            onClick={() => runQueue('sync')}
            disabled={Boolean(running) || !canRun}
            type="button"
          >
            <RefreshCw size={13} className={running === 'sync' ? 'spin' : ''} />
            {running === 'sync' ? 'Syncing…' : 'Sync'}
          </button>

          <button
            className="positions-load-btn ghost"
            onClick={() => runQueue('unsync')}
            disabled={Boolean(running) || !canRun}
            type="button"
            title="Undo the last sync: puts the net positions and closed strategy legs back exactly as they were"
          >
            <RotateCcw size={14} />
            {running === 'unsync' ? 'Unsyncing…' : 'Unsync'}
          </button>

          <span className="positions-toolbar-divider" aria-hidden="true" />

          {summary && (
            <span className={`sync-toolbar-result ${summary.failed ? 'down' : 'up'}`}>
              <Check size={12} /> {summary.success || 0}/{summary.total_accounts || 0} successful
            </span>
          )}

          {dateFilter === 'all' ? (
            <span className={`orderbook-live-pill ${feedStatus}`} title="Live LTP feed (Feedmaster)">
              <Radio size={13} />
              {feedStatus === 'live' ? 'Live' : feedStatus === 'connecting' ? 'Connecting' : 'Offline'}
            </span>
          ) : (
            <span
              className={`orderbook-live-pill ${historicalStatus === 'done' ? 'live' : historicalStatus === 'loading' ? 'connecting' : historicalStatus === 'error' ? 'offline' : ''}`}
              title="Historical closing price for this date - no live feed for a past date"
            >
              <History size={13} />
              {historicalStatus === 'done' ? 'Historical'
                : historicalStatus === 'loading' ? 'Loading history'
                  : historicalStatus === 'error' ? 'Historical unavailable'
                    : 'Historical'}
            </span>
          )}

          <span className="positions-toolbar-divider" aria-hidden="true" />

          <CompactSelect
            title="Date"
            value={dateFilter}
            onChange={setDateFilter}
            disabled={!availableDates.length}
            options={[
              { value: 'all', label: 'All dates' },
              ...availableDates.map((key, index) => ({
                value: key,
                label: index === 0 ? `${formatDateKey(key)} (Latest)` : formatDateKey(key),
              })),
            ]}
          />

          <div className="view-toggle" role="group" aria-label="Table view">
            <button
              type="button"
              className={`view-toggle-btn ${view === 'compact' ? 'active' : ''}`}
              onClick={() => setView('compact')}
              data-tip="Compact view"
              aria-label="Compact view"
              aria-pressed={view === 'compact'}
            >
              <AlignJustify size={16} />
            </button>
            <button
              type="button"
              className={`view-toggle-btn ${view === 'normal' ? 'active' : ''}`}
              onClick={() => setView('normal')}
              data-tip="Normal view"
              aria-label="Normal view"
              aria-pressed={view === 'normal'}
            >
              <Table size={16} />
            </button>
            <button
              type="button"
              className={`view-toggle-btn ${view === 'buysell' ? 'active' : ''}`}
              onClick={() => setView('buysell')}
              data-tip="Buy / Sell view"
              aria-label="Buy / Sell view"
              aria-pressed={view === 'buysell'}
            >
              <ArrowUpDown size={16} />
            </button>
          </div>

          {status && <span className="positions-toolbar-status" title={status}>{status}</span>}
          {selectedLegKeys.size > 0 && (
            <>
              <span className="positions-toolbar-divider" aria-hidden="true" />
              <span className="positions-selection-count">{selectedLegKeys.size} selected</span>
              <button type="button" className="positions-remove-btn" onClick={removeSelectedLegs} disabled={removingLegs}>
                <Trash2 size={13} /> {removingLegs ? 'Removing…' : 'Remove'}
              </button>
              <button type="button" className="positions-selection-clear" onClick={() => setSelectedLegKeys(new Set())}>
                <X size={12} /> Clear
              </button>
            </>
          )}
        </div>

        {allUsers && scopedAccounts.length > 0 && (
          <div className="sync-bulk-preview" aria-label="Accounts queued for sync">
            <div className="sync-bulk-preview-head">
              <strong>Accounts that will sync{selectedGroup ? ` · ${selectedGroup.name}` : ''}</strong>
              <span>{scopedAccounts.length} broker account{scopedAccounts.length === 1 ? '' : 's'}</span>
            </div>

            <div className="sync-bulk-preview-groups">
              {bulkAccountGroups.map((group) => (
                <div className="sync-bulk-preview-group" key={group.userId}>
                  <div className="sync-bulk-preview-user">{group.username}</div>
                  <div className="sync-bulk-preview-accounts">
                    {group.accounts.map((account) => (
                      <div className="sync-bulk-preview-account" key={account.configId}>
                        <span className="sync-bulk-preview-account-name">{accountLabel(account)}</span>
                        <span className="sync-bulk-preview-account-user">User {group.userId}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {progress && (
          <div
            className={`sync-progress mode-${progress.mode} ${progress.done ? 'is-done' : 'is-running'}`}
            role="status"
            aria-live="polite"
          >
            <div className="sync-progress-head">
              <div className="sync-progress-heading">
                <span className="sync-progress-heading-icon" aria-hidden="true">
                  {progress.done ? <Check size={17} /> : <RefreshCw size={16} />}
                </span>
                <div>
                  <span className="sync-progress-eyebrow">
                    {progress.mode === 'sync' ? 'Position sync' : 'Position restore'}
                  </span>
                  <strong className="sync-progress-title">
                    {progress.done
                      ? (progress.mode === 'sync' ? 'Sync completed' : 'Unsync completed')
                      : (progress.mode === 'sync' ? 'Syncing accounts' : 'Restoring accounts')}
                  </strong>
                </div>
              </div>
              <div className="sync-progress-head-meta">
                <span className="sync-progress-count">
                  {completedProgressAccounts(progress)} / {progress.total} accounts
                </span>
                {/* One account is its own overall progress - no point saying it twice. */}
                {progress.total > 1 && (
                  <span className="sync-progress-pct">{progress.percent}%</span>
                )}
              </div>
            </div>

            {progress.total > 1 && (
              <div
                className={`sync-progress-bar${progress.done ? ' done' : ' active'}`}
                role="progressbar"
                aria-valuenow={progress.percent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span className="sync-progress-fill" style={{ width: `${progress.percent}%` }} />
              </div>
            )}

            <div className="sync-progress-users">
              {progress.groups.map((group) => (
                <div className="sync-progress-user-group" key={group.userId}>
                  <div className="sync-progress-user">{group.username}</div>

                  {group.accounts.map((account) => (
                    <div
                      className={`sync-progress-account ${account.state}`}
                      key={account.configId}
                    >
                      <div className="sync-progress-account-head">
                        <span className="sync-progress-account-name">
                          <span className="sync-progress-account-icon">
                            {account.state === 'ok' ? <Check size={11} />
                              : account.state === 'failed' ? <X size={11} />
                                : account.state === 'skipped' ? <Minus size={11} />
                                  : null}
                          </span>
                          {accountLabel(account)}
                        </span>
                        <span className="sync-progress-account-pct">{account.percent}%</span>
                      </div>

                      <div
                        className={`sync-progress-bar small${account.state === 'running' ? ' active' : ''}`}
                        role="progressbar"
                        aria-valuenow={account.percent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <span className="sync-progress-fill" style={{ width: `${account.percent}%` }} />
                      </div>

                      <div className="sync-progress-account-detail">{account.detail}</div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {summary && (
          <section className="sync-result-panel" aria-label="Sync result">
            <div className="sync-result-copy">
              <span className={`sync-result-icon${summary.failed ? ' has-failures' : ''}`}>
                {summary.failed ? <X size={16} /> : <Check size={16} />}
              </span>
              <div>
                <strong>{progress?.mode === 'unsync' ? 'Positions restored' : 'Positions synchronized'}</strong>
                <span>{summary.failed ? 'Completed with account failures' : 'All requested account operations completed'}</span>
              </div>
            </div>
            <div className="sync-result-metrics">
              <span><small>Accounts</small><strong>{summary.total_accounts || 0}</strong></span>
              <span className="success"><small>Success</small><strong>{summary.success || 0}</strong></span>
              <span><small>Skipped</small><strong>{summary.skipped || 0}</strong></span>
              <span className={summary.failed ? 'failed' : ''}><small>Failed</small><strong>{summary.failed || 0}</strong></span>
            </div>
          </section>
        )}

        {log.length > 0 && (
          <details className="sync-log-panel">
            <summary><History size={14} /> Activity log <span>{log.length}</span></summary>
            <div className="sync-log-lines">
              {log.map((item, index) => <div key={`${index}-${item}`}>{item}</div>)}
            </div>
          </details>
        )}

        {userId && (
          <div className={`strategy-list strategy-list--${view}`}>
            <div className="strategy-list-head">
              <div className="strategy-list-head-title">
                {!allUsers && (
                  <button
                    type="button"
                    className={`strategy-master-check${allVisibleStrategyLegsSelected ? ' checked' : ''}${someVisibleStrategyLegsSelected ? ' indeterminate' : ''}`}
                    role="checkbox"
                    aria-checked={someVisibleStrategyLegsSelected ? 'mixed' : allVisibleStrategyLegsSelected}
                    aria-label={allVisibleStrategyLegsSelected ? 'Clear all visible strategy legs' : 'Select all visible strategy legs'}
                    title={allVisibleStrategyLegsSelected ? 'Clear all visible strategy legs' : 'Select all visible strategy legs'}
                    onClick={toggleAllVisibleStrategyLegs}
                    disabled={strategiesLoading || visibleStrategyLegIds.length === 0}
                  >
                    {allVisibleStrategyLegsSelected && <Check size={12} strokeWidth={2.5} />}
                    {someVisibleStrategyLegsSelected && <Minus size={12} strokeWidth={2.5} />}
                  </button>
                )}
                <strong>{allUsers ? (selectedGroup ? `${selectedGroup.name} · Strategies` : 'All Strategies') : 'Saved Strategies'}</strong>
              </div>
              <div className="strategy-list-head-actions">
                <span>
                  {strategiesLoading
                    ? 'Loading…'
                    : `${strategies.length} ${strategies.length === 1 ? 'strategy' : 'strategies'}`}
                </span>
                {!allUsers && !strategiesLoading && strategies.length > 0 && (
                  <button
                    type="button"
                    className="positions-remove-btn strategy-clear-all-btn"
                    onClick={clearAllStrategies}
                    disabled={clearingStrategies}
                    title="Delete every saved strategy for this user from the backend"
                  >
                    <Trash2 size={14} /> {clearingStrategies ? 'Clearing…' : 'Clear all'}
                  </button>
                )}
              </div>
            </div>

            {/* First load only: skeleton cards while nothing is on screen yet.
                A re-load after a sync keeps the previous cards (strategies stays
                populated), so this never flashes over existing content. */}
            {strategiesLoading && strategies.length === 0 && (
              <SkeletonCards count={4} />
            )}

            {!strategiesLoading && strategies.length === 0 && (
              <div className="strategy-list-empty sync-strategy-empty">
                <span className="sync-strategy-empty-icon"><Info size={18} /></span>
                <strong>No synced positions</strong>
                <p>{allUsers
                  ? `No strategies are saved for ${selectedGroup ? selectedGroup.name : 'any user'} yet. Run Sync to bring positions here.`
                  : 'No strategies are saved for this client yet. Select a broker account and run Sync to bring positions here.'}</p>
              </div>
            )}

            {strategies.map((strategy) => {
              const allLegs = strategy.legs || []
              const legs = (dateFilter === 'all'
                ? allLegs
                : allLegs.filter((leg) => legDateKey(leg) === dateFilter)
              ).map((leg) => {
                // Tag the leg with its strategy's broker so the symbol parser reads
                // a Kotak-monthly contract (year+month+strike, no day) correctly
                // instead of with Angel's grammar.
                const derived = {
                  ...deriveLegForDate(leg, dateFilter),
                  broker_name: leg.broker_name || strategy.broker_name,
                }
                return dateFilter === 'all'
                  ? withLiveTick(derived, liveTicks)
                  : withHistoricalLtp(derived, dateFilter, historicalLtps)
              })
              const totalPnl = legs.reduce((sum, leg) => sum + Number(leg.pnl || 0), 0)
              const legIds = legs.map((leg) => leg.id).filter((id) => id != null)
              const allVisibleSelected = legIds.length > 0 && legIds.every((id) => selectedLegKeys.has(id))
              const isEditing = editingStrategyCode === strategy.strategy_code
              const brokerLabel = strategyBrokerLabel(strategy)
              const brokerMatchesSelected = strategyBrokerMatchesSelected(strategy, selectedConfig, selectedBrokerName, configId)
              const showBrokerTagButton = selectedConfig && !brokerMatchesSelected
              const showBrokerDone = brokerTagDoneCode === strategy.strategy_code
              // Group overview aggregates several users' strategies: key each card
              // (and its collapse state) by owner+code, and render it read-only.
              const readOnly = allUsers
              const cardKey = `${strategy._userId || userId}::${strategy.strategy_code}`
              const cardSelection = readOnly ? undefined : legSelection
              const collapsed = collapsedStrategies.has(cardKey)
              return (
                <div className={`strategy-card${collapsed ? ' collapsed' : ''}`} key={cardKey}>
                  <div
                    className="strategy-card-head"
                    role="button"
                    tabIndex={0}
                    aria-expanded={!collapsed}
                    onClick={() => toggleStrategyCollapsed(cardKey)}
                    onKeyDown={(event) => {
                      if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
                        event.preventDefault()
                        toggleStrategyCollapsed(cardKey)
                      }
                    }}
                  >
                    <div className="strategy-card-title">
                      <span className="strategy-collapse-caret" aria-hidden="true">
                        <ChevronDown size={15} />
                      </span>
                      {isEditing ? (
                        <input
                          className="strategy-title-input"
                          value={editingStrategyName}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => setEditingStrategyName(event.target.value)}
                          onKeyDown={(event) => {
                            event.stopPropagation()
                            if (event.key === 'Enter') saveStrategyName()
                            if (event.key === 'Escape') cancelEditStrategy()
                          }}
                          autoFocus
                        />
                      ) : (
                        <strong>{strategy.strategy_name}</strong>
                      )}
                      {!readOnly && (isEditing ? (
                        <span className="strategy-card-actions">
                          <button
                            type="button"
                            className="strategy-icon-btn"
                            onClick={(event) => { event.stopPropagation(); saveStrategyName() }}
                            disabled={savingStrategyName || !editingStrategyName.trim()}
                            aria-label="Save strategy name"
                            title="Save name"
                          >
                            <Check size={14} />
                          </button>
                          <button
                            type="button"
                            className="strategy-icon-btn"
                            onClick={(event) => { event.stopPropagation(); cancelEditStrategy() }}
                            disabled={savingStrategyName}
                            aria-label="Cancel strategy name edit"
                            title="Cancel"
                          >
                            <X size={14} />
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="strategy-icon-btn"
                          onClick={(event) => { event.stopPropagation(); startEditStrategy(strategy) }}
                          aria-label={`Edit ${strategy.strategy_name}`}
                          title="Edit name"
                        >
                          <Pencil size={14} />
                        </button>
                      ))}
                    </div>
                    <div className="strategy-card-meta">
                      {readOnly && strategy._userLabel && (
                        <span className="strategy-owner-tag">{strategy._userLabel}</span>
                      )}
                      {!readOnly && legs.length > 0 && (
                        <button
                          type="button"
                          className={`strategy-select-all${allVisibleSelected ? ' active' : ''}`}
                          onClick={(event) => { event.stopPropagation(); selectStrategyLegs(legs) }}
                        >
                          <Check size={13} /> {allVisibleSelected ? 'Clear all' : 'Select all'}
                        </button>
                      )}
                      {brokerLabel && (
                        <span className="strategy-broker-tag">
                          <BrokerMark brokerName={strategy.broker_name} />
                          {brokerLabel}
                        </span>
                      )}
                      {showBrokerDone && <span className="strategy-tag-done">Done</span>}
                      {showBrokerTagButton && (
                        <button
                          type="button"
                          className="strategy-tag-btn"
                          onClick={(event) => { event.stopPropagation(); saveStrategyBrokerTag(strategy) }}
                          disabled={savingBrokerTagCode === strategy.strategy_code}
                          title={`Use selected account: ${selectedBrokerName || 'Broker'} ${selectedConfig.account_id || ''}`}
                        >
                          {savingBrokerTagCode === strategy.strategy_code
                            ? 'Saving tag'
                            : brokerLabel ? 'Update broker' : 'Add broker'}
                        </button>
                      )}
                      <span>{legs.length} {legs.length === 1 ? 'leg' : 'legs'}</span>
                      <span className={`strategy-pnl-tag ${totalPnl >= 0 ? 'up' : 'down'}`}>P&amp;L {money(totalPnl)}</span>
                    </div>
                  </div>

                  {!collapsed && (
                    legs.length > 0 ? (
                      view === 'buysell' ? (
                        <div className="legs-split">
                          <LegsTable compact title="Buy" legs={legs.filter((leg) => Number(leg.net_qty || 0) > 0)} selection={cardSelection} />
                          <LegsTable compact title="Sell" legs={legs.filter((leg) => Number(leg.net_qty || 0) < 0)} selection={cardSelection} />
                        </div>
                      ) : view === 'compact' ? (
                        <CompactLegs legs={legs} selection={cardSelection} />
                      ) : (
                        <LegsTable compact legs={legs} selection={cardSelection} />
                      )
                    ) : (
                      <div className="strategy-card-nolegs">
                        {dateFilter === 'all' || allLegs.length === 0
                          ? 'No legs saved for this strategy'
                          : `No legs added on ${formatDateKey(dateFilter)}`}
                      </div>
                    )
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function completedProgressAccounts(progress) {
  return (progress?.groups || []).reduce((total, group) => (
    total + (group.accounts || []).filter((account) => (
      account.state === 'ok' || account.state === 'failed' || account.state === 'skipped'
    )).length
  ), 0)
}

function userLabel(user) {
  if (!user) return ''
  return user.username
    || `${user.first_name || ''} ${user.last_name || ''}`.trim()
    || `User ${user.id}`
}

// "Angel · UBC 3 · A12345" - the broker account line under the user's name. The
// UBC id is always there; the client code only for accounts the session store
// logged in (the broker-config list endpoint masks it as "****").
function accountLabel(item) {
  if (!item) return ''

  const parts = []
  const broker = String(item.brokerName || '').trim()
  if (broker) parts.push(broker)
  if (item.configId) parts.push(`UBC ${item.configId}`)

  const account = String(item.accountId || '').trim()
  if (account && account !== '****') parts.push(account)

  return parts.join(' · ') || 'Account'
}

// The run is displayed the way it is selected: a user, then the broker accounts
// under them. Queue order is already user-then-account, so first-seen order is
// the order they will be worked through.
function groupByUser(accounts) {
  const groups = []
  const byUser = new Map()

  accounts.forEach((account) => {
    let group = byUser.get(account.userId)
    if (!group) {
      group = { userId: account.userId, username: account.username, accounts: [] }
      byUser.set(account.userId, group)
      groups.push(group)
    }
    group.accounts.push(account)
  })

  return groups
}

// The backend's log lines are already worded per account ("bberlia synced (3
// open positions)"). The progress rows show the name in their own column, so
// drop the duplicated prefix from the detail text.
function stripName(line, username) {
  const text = String(line || '')
  const prefix = `${username} `
  return text.startsWith(prefix) ? text.slice(prefix.length) : text
}

function strategyBrokerLabel(strategy) {
  const broker = String(strategy.broker_name || '').trim()
  const account = String(strategy.broker_account_id || '').trim()
  if (broker && account) return `${broker} ${account}`
  return broker || account
}

function strategyBrokerMatchesSelected(strategy, selectedConfig, selectedBrokerName, configId) {
  if (!strategy || !selectedConfig) return false

  const savedConfigId = String(strategy.broker_config_id || '')
  const selectedConfigId = String(configId || selectedConfig.id || '')
  if (savedConfigId && selectedConfigId && savedConfigId === selectedConfigId) return true

  const savedBroker = String(strategy.broker_name || '').trim().toLowerCase()
  const selectedBroker = String(selectedBrokerName || selectedConfig.broker_name || '').trim().toLowerCase()
  const savedAccount = String(strategy.broker_account_id || '').trim()
  const selectedAccount = String(selectedConfig.account_id || '').trim()

  return Boolean(savedBroker && selectedBroker && savedAccount && selectedAccount
    && savedBroker === selectedBroker
    && savedAccount === selectedAccount)
}

function findLoggedInUser(users, principal = {}) {
  const candidates = [
    principal.id,
    principal.user_id,
    principal.userId,
    principal.admin_id,
  ].filter((value) => value != null).map(String)

  if (candidates.length) {
    const byId = users.find((user) => candidates.includes(String(user.id)))
    if (byId) return byId
  }

  const names = [
    principal.username,
    principal.user_name,
    principal.email,
  ].filter(Boolean).map((value) => String(value).toLowerCase())

  if (!names.length) return null
  return users.find((user) => {
    const username = String(user.username || '').toLowerCase()
    const email = String(user.email || '').toLowerCase()
    return names.includes(username) || names.includes(email)
  }) || null
}

export default SyncNetPositions
