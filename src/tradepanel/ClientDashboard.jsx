import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleChevronDown, AlignJustify, Table, ArrowUpDown, Radio } from 'lucide-react'
import { apiGet } from '../config/api'
import {
  classifyLoginError, clientFromAccount, isAngelBroker, isAuthError, isRateLimited,
  useAngelSessions,
} from '../feedmaster/angelSessionStore'
import {
  ensureBookSession, fetchBrokerPositions, hasBookSession, isBookBroker, saveBookSession,
  useBrokerBookClient,
} from './brokerBookClient'
import { getSavedTradeAccount, saveTradeAccount } from './tradeAccountStore'
import { CompactSelect } from './PositionSelect'
import { compactProductTag, parseTradingSymbol } from './symbolParse'
import { legIsClosed, money, withLiveTick } from './legFormat'
import { CompactLegs, LegsTable } from './strategyLegsView'
import { useLiveLegFeed } from './useLiveLegFeed'
import './tradepanel.css'

// "Every user" and "every group" are selections in their own right, not the
// absence of one - the pickers carry them as values.
const ALL_USERS = 'all'
const ALL_GROUPS = 'all'

function ClientDashboard() {
  const [users, setUsers] = useState([])
  const [userId, setUserId] = useState('')
  const [groups, setGroups] = useState([])
  const [groupId, setGroupId] = useState(ALL_GROUPS)
  const [configs, setConfigs] = useState([])
  const [configId, setConfigId] = useState('')
  const [status, setStatus] = useState('Loading users...')
  const [configLoading, setConfigLoading] = useState(false)
  const [strategies, setStrategies] = useState([])
  const [strategiesLoading, setStrategiesLoading] = useState(false)
  const [positionRows, setPositionRows] = useState([])
  const [positionsStatus, setPositionsStatus] = useState('')
  const [positionsLoading, setPositionsLoading] = useState(false)
  const [expandedStrategies, setExpandedStrategies] = useState(() => new Set())
  const [collapsedCards, setCollapsedCards] = useState(() => new Set())
  const [view, setView] = useState('compact') // 'compact' | 'normal' | 'buysell'
  // userId -> { loading, legs, status } for scope members who have no strategies.
  const [overviewPositions, setOverviewPositions] = useState({})

  // Every broker account in the app, already signed in at startup (StartupGate),
  // so an overview of several users costs a position read each - not a login each.
  const { accounts: storeAccounts } = useAngelSessions()
  const storeAccountsRef = useRef(storeAccounts)
  useEffect(() => { storeAccountsRef.current = storeAccounts }, [storeAccounts])
  const storeAccountsKey = useMemo(
    () => storeAccounts.map((account) => `${account.configId}:${account.status}`).join(','),
    [storeAccounts],
  )

  const selectedGroup = useMemo(
    () => groups.find((group) => String(group.id) === String(groupId)) || null,
    [groups, groupId],
  )

  // The users a group selection narrows the dashboard down to. Everything below -
  // the User picker, and the All Users overview - works off THIS list rather than
  // the full one, so picking a group scopes the whole page to that group.
  const groupUsers = useMemo(
    () => (groupId === ALL_GROUPS
      ? users
      : users.filter((user) => String(user.group_id || '') === String(groupId))),
    [users, groupId],
  )

  const selectedUser = useMemo(
    () => users.find((user) => String(user.id) === String(userId)),
    [users, userId],
  )

  // In the overview, EVERY member of the scope gets their live Get Position book -
  // not just the ones with no strategy. The overview is otherwise built purely from
  // strategy cards, which left a member with none undrawn entirely (bberlia), and a
  // member with one showing his strategies but never his open positions (NP Berlia,
  // whose cards suppress the positions panel in overview mode).
  const scopeUsers = useMemo(
    () => (userId === ALL_USERS ? groupUsers : []),
    [userId, groupUsers],
  )

  const overviewLegs = useMemo(
    () => Object.values(overviewPositions).flatMap((entry) => entry.legs || []),
    [overviewPositions],
  )
  const selectedConfig = useMemo(
    () => configs.find((config) => String(config.id) === String(configId)),
    [configs, configId],
  )
  const isAllUsers = userId === ALL_USERS
  const brokerStrategies = useMemo(
    () => (isAllUsers
      ? strategies
      : strategies.filter((strategy) => strategyBrokerMatchesSelected(strategy, selectedConfig, configId))),
    [isAllUsers, strategies, selectedConfig, configId],
  )
  const selectedBrokerName = selectedConfig?.broker_name || ''
  const selectedIsSupported = isBookBroker(selectedBrokerName)
  const { client, clientError } = useBrokerBookClient(configId, selectedBrokerName)

  // Live-mark every open leg on screen (saved strategy legs + matched Get
  // Position legs) over the shared Feedmaster websocket feed - same feed the
  // rest of Trade Panel uses.
  //
  // The feed is ANGEL's websocket, so only Angel tokens may be subscribed to it.
  // A Kotak position carries the Angel token the backend's position router
  // resolved for it (masterFeedToken), and that is what goes on the feed; one it
  // could not map is left out. Subscribing a Kotak token here would not fail - it
  // would quietly return a DIFFERENT Angel contract's price, which is worse.
  const legFeedKey = useMemo(() => {
    const seen = new Set()
    brokerStrategies.forEach((strategy) => {
      // A strategy saved from a Kotak account stores Kotak tokens on its legs.
      if (strategy.broker_name && !isAngelBroker(strategy.broker_name)) return
      ;(strategy.legs || []).forEach((leg) => {
        if (legIsClosed(leg)) return
        const token = leg.symbol_token
        if (token == null || token === '') return
        seen.add(`${leg.exchange || 'NFO'}|${token}`)
      })
    })
    positionRows.forEach((row) => {
      const ref = angelFeedRef(row, selectedBrokerName)
      if (!ref) return
      seen.add(`${ref.exchange}|${ref.token}`)
    })
    // The group overview's own position books need marking to market too - they
    // already carry the Angel token they are fed under.
    overviewLegs.forEach((leg) => {
      if (!leg.feed_token) return
      seen.add(`${(leg.feed_exchange || leg.exchange || 'NFO').toUpperCase()}|${leg.feed_token}`)
    })
    return [...seen].sort().join(',')
  }, [brokerStrategies, positionRows, selectedBrokerName, overviewLegs])

  const { liveTicks, feedStatus } = useLiveLegFeed(legFeedKey, { subscriber: 'client-dashboard' })

  // Identity keys of every leg already saved in this account's strategies.
  const strategyLegKeys = useMemo(() => {
    const keys = new Set()
    brokerStrategies.forEach((strategy) => {
      (strategy.legs || []).forEach((leg) => {
        const key = strategyLegIdentityKey(leg)
        if (key) keys.add(key)
      })
    })
    return keys
  }, [brokerStrategies])

  // Get Position open legs that are NOT already part of any saved strategy -
  // the extra broker positions the user hasn't grouped into a strategy yet.
  const untrackedPositionRows = useMemo(
    () => positionRows.filter((row) => !strategyLegKeys.has(positionIdentityKey(row))),
    [positionRows, strategyLegKeys],
  )
  const livePositionLegs = useMemo(
    () => untrackedPositionRows
      .map((row) => positionRowToLeg(row, selectedBrokerName))
      .map((leg) => withLiveTick(leg, liveTicks)),
    [untrackedPositionRows, liveTicks, selectedBrokerName],
  )

  // Each scope member's live Get Position book, keyed by the label their strategy
  // cards are tagged with - so in the overview a card can show ITS OWN owner's open
  // positions beside the strategy, the way the single-user view already does.
  //
  // Legs already saved into one of that user's strategies are left out: they are
  // shown on the strategy card itself, and counting them on both sides would double
  // the user's P&L inside a single view.
  const overviewByUser = useMemo(() => {
    const byUser = new Map()
    scopeUsers.forEach((user) => {
      const label = userLabel(user)
      const entry = overviewPositions[String(user.id)] || {}

      const saved = new Set()
      strategies
        .filter((strategy) => strategy._userLabel === label)
        .forEach((strategy) => (strategy.legs || []).forEach((leg) => {
          const key = strategyLegIdentityKey(leg)
          if (key) saved.add(key)
        }))

      byUser.set(label, {
        user,
        savedLegCount: saved.size,
        signedIn: entry.signedIn !== false,
        loading: Boolean(entry.loading),
        status: entry.status || '',
        legs: (entry.legs || [])
          .filter((leg) => !saved.has(leg.id))
          .map((leg) => withLiveTick(leg, liveTicks)),
      })
    })
    return byUser
  }, [scopeUsers, overviewPositions, strategies, liveTicks])

  const EMPTY_BOOK = useMemo(() => ({ legs: [], loading: false, status: '' }), [])

  // Members with nothing saved, who therefore get a card of their own. A user whose
  // accounts are all signed out is left out entirely - there is no book to read, and
  // an empty card that only says so is noise in a group overview.
  const strategyLessScopeUsers = useMemo(
    () => [...overviewByUser.values()]
      .filter((book) => book.savedLegCount === 0 && (book.loading || book.signedIn))
      .map((book) => ({ user: book.user, book })),
    [overviewByUser],
  )

  // Only a REAL user is shared with the other Trade Panel pages. "All Users" is an
  // overview that only this page has - handing it to Get Position or Order Book,
  // which can only ever show one account, would leave them with a user id that
  // matches nobody.
  const handleUserId = useCallback((value) => {
    setUserId(value)
    setConfigId('')
    if (value !== ALL_USERS) saveTradeAccount({ userId: value, configId: '' })
  }, [])

  // Picking a group shows the GROUP - every user in it at once - rather than
  // leaving whoever happened to be selected on screen. Drilling into one of its
  // members afterwards is then just the User picker, which the group has scoped.
  const handleGroupId = useCallback((value) => {
    setGroupId(value)
    setUserId(ALL_USERS)
    setConfigId('')
  }, [])

  // A user picked before the group changed may not be in the new group. Fall back
  // to the group overview rather than showing someone the group excludes.
  useEffect(() => {
    if (!userId || userId === ALL_USERS || !users.length) return
    if (!groupUsers.some((user) => String(user.id) === String(userId))) {
      setUserId(ALL_USERS)
      setConfigId('')
    }
  }, [groupUsers, userId, users.length])

  const handleConfigId = useCallback((value) => {
    setConfigId(value)
    saveTradeAccount({ userId, configId: value })
  }, [userId])

  // Each member of the group has a broker book of their own. Read it straight from
  // their own accounts - every one of them, since a user can hold both an Angel and
  // a Kotak account and each has its own positions.
  const scopeKey = useMemo(
    () => scopeUsers.map((user) => String(user.id)).join(','),
    [scopeUsers],
  )

  useEffect(() => {
    let cancelled = false

    if (userId !== ALL_USERS || !scopeKey) {
      setOverviewPositions({})
      return undefined
    }

    async function loadOverviewPositions() {
      const ids = scopeKey.split(',')
      setOverviewPositions(Object.fromEntries(ids.map((id) => [
        id, { loading: true, legs: [], status: 'Loading positions...' },
      ])))

      await Promise.all(ids.map(async (id) => {
        // Only accounts that are actually SIGNED IN are read. One that never
        // logged in has no book to show, and an overview is no place to argue
        // about it - it is simply not part of the picture.
        const accounts = storeAccountsRef.current.filter((account) => (
          account.userId === id && hasBookSession(account.brokerName, clientFromAccount(account))
        ))

        if (!accounts.length) {
          if (!cancelled) {
            setOverviewPositions((current) => ({
              ...current,
              [id]: { loading: false, legs: [], status: '', signedIn: false },
            }))
          }
          return
        }

        const legs = []
        const problems = []
        for (const account of accounts) {
          try {
            const body = await fetchBrokerPositions(account.brokerName, clientFromAccount(account))
            for (const row of body.positions || []) {
              legs.push(positionRowToLeg(row, account.brokerName))
            }
          } catch (error) {
            problems.push(`${account.brokerName}: ${error.message || 'failed'}`)
          }
        }

        if (cancelled) return
        setOverviewPositions((current) => ({
          ...current,
          [id]: {
            loading: false,
            legs,
            signedIn: true,
            status: legs.length
              ? ''
              : (problems.join(' · ') || 'No open positions'),
          },
        }))
      }))
    }

    loadOverviewPositions()
    return () => {
      cancelled = true
    }
  }, [userId, scopeKey, storeAccountsKey])

  const toggleStrategyExpanded = useCallback((strategyCode) => {
    setExpandedStrategies((current) => {
      const next = new Set(current)
      if (next.has(strategyCode)) next.delete(strategyCode)
      else next.add(strategyCode)
      return next
    })
  }, [])

  // A Get Position card opens by default - there is no strategy above it to read
  // first - so it is tracked by what has been CLOSED, not by what has been opened.
  const toggleCardCollapsed = useCallback((cardKey) => {
    setCollapsedCards((current) => {
      const next = new Set(current)
      if (next.has(cardKey)) next.delete(cardKey)
      else next.add(cardKey)
      return next
    })
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadUsers() {
      try {
        const [usersOut, groupsOut] = await Promise.allSettled([
          apiGet('/users/list.php'),
          apiGet('/masters/groups/list.php'),
        ])
        if (cancelled) return

        if (usersOut.status !== 'fulfilled') {
          setStatus('Failed to load users')
          return
        }

        // A group that no longer has any user in it would be a dead end in the
        // picker, so only groups someone is actually in are offered.
        const list = usersOut.value.data || []
        const allGroups = groupsOut.status === 'fulfilled' ? (groupsOut.value.data || []) : []
        const peopled = new Set(list.map((user) => String(user.group_id || '')))
        setGroups(allGroups.filter((group) => peopled.has(String(group.id))))
        setUsers(list)

        if (!list.length) {
          setStatus('No users available')
          return
        }

        // The dashboard opens as an OVERVIEW: Group is All Groups, so User is All
        // Users to match - the two pickers always agree about how wide the view is.
        // Landing on one arbitrary user under "All Groups" only ever read as the
        // group filter having done nothing. Narrowing to a group, or to one user,
        // is a click away.
        setUserId(ALL_USERS)
        setStatus('')
      } catch {
        if (!cancelled) setStatus('Failed to load users')
      }
    }

    loadUsers()
    return () => {
      cancelled = true
    }
  }, [])

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
          && list.some((config) => String(config.id) === String(saved.configId))
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

  useEffect(() => {
    let cancelled = false

    async function loadStrategies() {
      if (!userId) {
        setStrategies([])
        return
      }

      setStrategiesLoading(true)
      try {
        if (userId === ALL_USERS) {
          // Overview: pull every user's strategies at once and tag each with
          // the user it belongs to, so the cards can span many users. With a group
          // selected this is the GROUP's overview - groupUsers is already narrowed
          // to its members, so the same fan-out serves both.
          const results = await Promise.all(groupUsers.map(async (user) => {
            try {
              const res = await apiGet(`/strategy-master/list.php?user_id=${user.id}`)
              return (res.data || []).map((strategy) => ({ ...strategy, _userLabel: userLabel(user) }))
            } catch {
              return []
            }
          }))
          if (!cancelled) setStrategies(results.flat())
        } else {
          const res = await apiGet(`/strategy-master/list.php?user_id=${userId}`)
          if (!cancelled) setStrategies(res.data || [])
        }
      } catch {
        if (!cancelled) setStrategies([])
      } finally {
        if (!cancelled) setStrategiesLoading(false)
      }
    }

    loadStrategies()
    return () => {
      cancelled = true
    }
  }, [userId, groupUsers])

  useEffect(() => {
    let cancelled = false

    async function loadPositions() {
      setPositionRows([])
      setPositionsStatus('')
      if (!configId || !selectedConfig) return

      // Angel and Kotak both read their books through the shared broker client -
      // this page used to be wired to Angel alone, so selecting a Kotak account
      // switched the dropdown and then loaded nothing.
      if (!selectedIsSupported) {
        setPositionsStatus(`${selectedBrokerName || 'Selected broker'} positions are not supported`)
        return
      }
      if (!client) {
        setPositionsStatus(clientError || 'Loading account...')
        return
      }

      setPositionsLoading(true)
      setPositionsStatus('Loading Get Position legs...')
      try {
        // The account was logged in at app start and its token saved (see
        // StartupGate), so normally there is nothing to do here.
        let active = client
        if (!hasBookSession(selectedBrokerName, active)) {
          setPositionsStatus(`Signing in to ${selectedBrokerName}...`)
          active = await ensureBookSession(configId, selectedBrokerName, active)
          if (cancelled) return
        }

        setPositionsStatus('Loading Get Position legs...')
        let body
        try {
          body = await fetchBrokerPositions(selectedBrokerName, active)
        } catch (error) {
          // A saved token that has since expired: one shared, deduped re-login.
          if (!isAuthError(error)) throw error
          setPositionsStatus(`${selectedBrokerName} token expired - signing in again...`)
          active = await ensureBookSession(configId, selectedBrokerName, active, { force: true })
          if (cancelled) return
          body = await fetchBrokerPositions(selectedBrokerName, active)
        }

        if (body.session) saveBookSession(configId, selectedBrokerName, body.session)
        if (cancelled) return

        // Keep every leg the broker returns - including flat (netqty 0) ones,
        // which are closed intraday but still carry realized P&L. Dropping them
        // hid legs and under-counted the Get Position total.
        const positions = body.positions || []
        setPositionRows(positions)
        setPositionsStatus(positions.length ? `${positions.length} Get Position legs` : 'No Get Position legs')
      } catch (error) {
        if (!cancelled) setPositionsStatus(toPositionStatus(error))
      } finally {
        if (!cancelled) setPositionsLoading(false)
      }
    }

    loadPositions()
    return () => {
      cancelled = true
    }
  }, [configId, selectedConfig, selectedBrokerName, selectedIsSupported, client, clientError])

  return (
    <div className="trade-panel">
      <div className="client-dashboard-view">
        <div className="client-dashboard-head">
          <div>
            <h2>Client Dashboard</h2>
          </div>
        </div>

        <div className="client-dashboard-toolbar">
          <div className="client-dashboard-picker">
            <CompactSelect
              title="Group"
              value={groupId}
              onChange={handleGroupId}
              disabled={!groups.length}
              menuMinWidth={300}
              options={[
                { value: ALL_GROUPS, label: 'All Groups', meta: `${users.length} users` },
                ...groups.map((group) => ({
                  value: String(group.id),
                  label: group.name,
                  meta: `${users.filter((user) => String(user.group_id || '') === String(group.id)).length} users`,
                })),
              ]}
            />
          </div>

          <div className="client-dashboard-picker">
            <CompactSelect
              title="User"
              value={userId}
              onChange={handleUserId}
              menuMinWidth={360}
              options={[
                {
                  value: ALL_USERS,
                  label: selectedGroup ? `All of ${selectedGroup.name}` : 'All Users',
                  meta: 'Overview',
                },
                // Scoped by the group: a group selection is what decides who is
                // even listed here.
                ...groupUsers.map((user) => ({
                  value: String(user.id),
                  label: userLabel(user),
                  meta: user.group_name || 'No group',
                })),
              ]}
            />
          </div>

          <div className="client-dashboard-picker account">
            <CompactSelect
              title="Account"
              value={isAllUsers ? 'all' : configId}
              onChange={handleConfigId}
              disabled={isAllUsers || configLoading || !configs.length}
              menuMinWidth={300}
              options={isAllUsers
                ? [{ value: 'all', label: 'All Accounts', meta: 'Overview' }]
                : configs.map((config) => ({
                  value: String(config.id),
                  label: config.account_id || `Account ${config.id}`,
                  meta: config.broker_name || 'Broker',
                }))}
            />
          </div>

          {status && <span className="positions-status">{status}</span>}

          <span className={`orderbook-live-pill ${feedStatus}`} title="Live LTP feed (Feedmaster)">
            <Radio size={13} />
            {feedStatus === 'live' ? 'Live' : feedStatus === 'connecting' ? 'Connecting' : 'Offline'}
          </span>

          <div className="view-toggle" role="group" aria-label="Dashboard view">
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
        </div>

        <div className="client-strategy-strip">
          <div className="client-strategy-strip-head">
            <div className="client-strategy-strip-title">
              <strong>Strategies</strong>
              {isAllUsers ? (
                <span className="client-viewing-user">
                  Viewing <strong>{selectedGroup ? selectedGroup.name : 'All Users'}</strong>
                </span>
              ) : selectedUser ? (
                <span className="client-viewing-user">
                  Viewing <strong>{userLabel(selectedUser)}</strong>
                  {selectedGroup && <> in <strong>{selectedGroup.name}</strong></>}
                </span>
              ) : null}
            </div>
            <span>
              {strategiesLoading
                ? 'Loading...'
                : isAllUsers
                  ? `${brokerStrategies.length} strategies · ${new Set(brokerStrategies.map((s) => s._userLabel)).size} users`
                  : selectedConfig
                    ? `${brokerStrategies.length} matched`
                    : 'Select account'}
            </span>
          </div>

          {selectedConfig && !strategiesLoading && brokerStrategies.length === 0 && (
            <div className="client-no-strategy-content">
              <div className="client-strategy-empty">
                No strategies tagged to {selectedConfig.broker_name || 'this broker'} {selectedConfig.account_id || ''}.
              </div>
              <OpenPositionsPanel
                view={view}
                positionLegs={livePositionLegs}
                positionsLoading={positionsLoading}
                positionsStatus={positionsStatus}
              />
            </div>
          )}

          {isAllUsers && !strategiesLoading && !groupUsers.length && (
            <div className="client-strategy-empty">No users in this group.</div>
          )}

          {/* Members with NO saved strategy get a card of their own - the ones WITH
              a strategy already show their book beside it, on the strategy's card.
              An account that never signed in has no book to show, so its user is not
              drawn at all rather than shown as an empty shell. */}
          {isAllUsers && !strategiesLoading && strategyLessScopeUsers.length > 0 && (
            <div className="client-strategy-row">
              {strategyLessScopeUsers.map(({ user, book }) => {
                const openLegs = book.legs.filter((leg) => Number(leg.net_qty || 0) !== 0).length
                const pnl = book.legs.reduce((sum, leg) => sum + Number(leg.pnl || 0), 0)
                const cardKey = `positions-${user.id}`
                const expanded = !collapsedCards.has(cardKey)
                return (
                  <article className={`client-strategy-card${expanded ? ' expanded' : ''}`} key={cardKey}>
                    <div className="client-strategy-summary">
                      <div className="client-strategy-broker">
                        <span>User</span>
                        <strong>{userLabel(user)}</strong>
                        <em className="client-strategy-broker-sub">Get Position</em>
                      </div>
                      <div className="client-strategy-name">
                        <strong>No saved strategy</strong>
                        {/* The same open/close control every other card has - without
                            it this one could only ever be left open. */}
                        <button
                          type="button"
                          className="client-strategy-expand"
                          onClick={() => toggleCardCollapsed(cardKey)}
                          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${userLabel(user)} positions`}
                          aria-expanded={expanded}
                        >
                          <CircleChevronDown size={16} strokeWidth={2.2} />
                        </button>
                      </div>
                      <div className="client-strategy-metrics">
                        <div>
                          <span>Total Positions</span>
                          <strong>{book.legs.length}</strong>
                        </div>
                        <div>
                          <span>Open Legs</span>
                          <strong>{openLegs}</strong>
                        </div>
                        <div>
                          <span>Combined P&amp;L</span>
                          <strong className={pnl >= 0 ? 'up' : 'down'}>{money(pnl)}</strong>
                        </div>
                      </div>
                    </div>
                    {/* Same two-panel shape as every other card: saved strategies on
                        the left (there are none), the open positions on the right. */}
                    {expanded && (
                      <StrategyExpandedDetails
                        view={view}
                        strategyLegs={[]}
                        positionLegs={book.legs}
                        positionsLoading={book.loading}
                        positionsStatus={book.status}
                        showPositions
                      />
                    )}
                  </article>
                )
              })}
            </div>
          )}

          {brokerStrategies.length > 0 && (
            <div className="client-strategy-row">
              {brokerStrategies.map((strategy) => {
                const rawLegs = strategy.legs || []
                // Mark every open leg to the live websocket feed so LTP/P&L
                // tick in real time, same as Sync Net Positions.
                const legs = rawLegs.map((leg) => withLiveTick(leg, liveTicks))
                const openLegs = legs.filter((leg) => !legIsClosed(leg)).length
                // Get Position open legs NOT already in a saved strategy.
                // Header P&L combines the saved strategy legs and the live
                // open Get Position legs.
                const strategyPnl = legs.reduce((sum, leg) => sum + Number(leg.pnl || 0), 0)
                // In the overview each card is a different user's, so its positions
                // are that user's - not the single selected account's.
                const ownerBook = isAllUsers
                  ? (overviewByUser.get(strategy._userLabel) || EMPTY_BOOK)
                  : { legs: livePositionLegs, loading: positionsLoading, status: positionsStatus }
                const positionsPnl = ownerBook.legs.reduce((sum, leg) => sum + Number(leg.pnl || 0), 0)
                const combinedPnl = strategyPnl + positionsPnl
                const brokerLabel = strategyBrokerLabel(strategy)
                // strategy_code isn't unique across users (All-Users mode), so
                // key each card on the row id instead.
                const cardKey = String(strategy.id ?? `${strategy._userLabel || ''}::${strategy.strategy_code}`)
                // Normal / Buy-Sell views auto-expand each card; in the All-Users
                // overview keep them collapsed so ~10 fit at a glance.
                const forceExpanded = view !== 'compact' && !isAllUsers
                const expanded = forceExpanded || expandedStrategies.has(cardKey)
                return (
                  <article className={`client-strategy-card${expanded ? ' expanded' : ''}`} key={cardKey}>
                    <div className="client-strategy-summary">
                    <div className="client-strategy-broker">
                      <span>{strategy._userLabel ? 'User' : 'Broker'}</span>
                      <strong>{strategy._userLabel || brokerLabel || selectedConfig?.broker_name || 'Broker'}</strong>
                      {strategy._userLabel && brokerLabel && <em className="client-strategy-broker-sub">{brokerLabel}</em>}
                    </div>
                    <div className="client-strategy-name">
                      <strong>{strategy.strategy_name}</strong>
                      {!forceExpanded && (
                        <button
                          type="button"
                          className="client-strategy-expand"
                          onClick={() => toggleStrategyExpanded(cardKey)}
                          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${strategy.strategy_name}`}
                          aria-expanded={expanded}
                        >
                          <CircleChevronDown size={16} strokeWidth={2.2} />
                        </button>
                      )}
                    </div>
                      <div className="client-strategy-metrics">
                        <div>
                          <span>Total Positions</span>
                          <strong>{legs.length}</strong>
                        </div>
                        <div>
                          <span>Open Legs</span>
                          <strong>{openLegs}</strong>
                        </div>
                        <div>
                          <span>Combined P&amp;L</span>
                          <strong className={combinedPnl >= 0 ? 'up' : 'down'}>{money(combinedPnl)}</strong>
                        </div>
                      </div>
                    </div>
                    {expanded && (
                      <StrategyExpandedDetails
                        view={view}
                        strategyLegs={legs}
                        // Saved strategy on the left, that user's open positions on
                        // the right - in the overview those come from the card's own
                        // owner, not from whichever account happens to be selected.
                        positionLegs={ownerBook.legs}
                        positionsLoading={ownerBook.loading}
                        positionsStatus={ownerBook.status}
                        showPositions
                      />
                    )}
                  </article>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Renders one set of legs exactly like Sync Net Positions: Compact rows,
// the full Normal-view table, or the Buy/Sell split - depending on the view.
function LegsByView({ view, legs }) {
  if (view === 'buysell') {
    return (
      <div className="legs-split">
        <LegsTable title="Buy" legs={legs.filter((leg) => Number(leg.net_qty || 0) > 0)} />
        <LegsTable title="Sell" legs={legs.filter((leg) => Number(leg.net_qty || 0) < 0)} />
      </div>
    )
  }
  if (view === 'compact') return <CompactLegs legs={legs} />
  return <LegsTable legs={legs} />
}

function StrategyExpandedDetails({ view, strategyLegs, positionLegs, positionsLoading, positionsStatus, showPositions = true }) {
  return (
    <div className={`client-expanded-details view-${view}${showPositions ? '' : ' single'}`}>
      <div className="client-detail-panel">
        <div className="client-detail-panel-head">
          <strong>Strategy Details</strong>
          <LegsHeadMeta legs={strategyLegs} countLabel={`${strategyLegs.length} saved legs`} />
        </div>
        {strategyLegs.length > 0 ? (
          <>
            <LegsByView view={view} legs={strategyLegs} />
            <PanelTotal legs={strategyLegs} />
          </>
        ) : (
          <div className="client-detail-empty">No saved legs for this strategy</div>
        )}
      </div>
      {showPositions && (
        <OpenPositionsPanel
          view={view}
          positionLegs={positionLegs}
          positionsLoading={positionsLoading}
          positionsStatus={positionsStatus}
        />
      )}
    </div>
  )
}

function OpenPositionsPanel({ view, positionLegs, positionsLoading, positionsStatus }) {
  // Keep accounts with many contracts predictable: indexes first, then stocks,
  // with contracts ordered consistently inside each group.
  const posLegs = useMemo(() => [...positionLegs].sort(comparePositionLegs), [positionLegs])

  return (
    <div className="client-detail-panel client-open-positions-panel">
      <div className="client-detail-panel-head">
        <strong>Open Positions</strong>
        {positionsLoading
          ? <span>Loading</span>
          : <LegsHeadMeta legs={posLegs} countLabel={`${posLegs.length} open legs`} />}
      </div>
      {posLegs.length > 0 ? (
        <>
          <LegsByView view={view} legs={posLegs} />
          <PanelTotal legs={posLegs} />
        </>
      ) : (
        <div className="client-detail-empty">{positionsStatus || 'No open positions outside your strategies'}</div>
      )}
    </div>
  )
}

// Footer row under a legs panel showing that panel's total P&L.
function PanelTotal({ legs }) {
  const total = legs.reduce((sum, leg) => sum + Number(leg.pnl || 0), 0)
  return (
    <div className="client-panel-total">
      <span>Total P&amp;L</span>
      <strong className={total >= 0 ? 'up' : 'down'}>{money(total)}</strong>
    </div>
  )
}

// Long/Short breakdown shown in a leg panel's header: how many legs are long
// vs short and the total quantity on each side.
function LegsHeadMeta({ legs, countLabel }) {
  let longQty = 0
  let shortQty = 0
  legs.forEach((leg) => {
    const qty = Number(leg.net_qty || 0)
    if (qty > 0) longQty += qty
    else if (qty < 0) shortQty += Math.abs(qty)
  })
  return (
    <div className="client-legs-meta">
      <span className="client-legs-count">{countLabel}</span>
      <span className="client-legs-chip long">
        <em>Long Qty</em>{longQty.toLocaleString('en-IN')}
      </span>
      <span className="client-legs-chip short">
        <em>Short Qty</em>{shortQty.toLocaleString('en-IN')}
      </span>
    </div>
  )
}

// The Angel token this position is marked to market with on the shared feed.
//
// A Kotak row carries the Angel token the backend's position router resolved for
// it (masterFeedToken) - its own symboltoken is a KOTAK token, and Angel's feed
// would answer that with a completely different contract's price. A Kotak row the
// router could not map has no Angel token at all, so it gets none: no live LTP is
// better than a wrong one. An Angel row simply IS its own token.
function angelFeedRef(row, brokerName) {
  const master = row.masterFeedToken || row.feedMasterToken || ''
  if (master) {
    return {
      token: String(master),
      exchange: String(row.masterFeedExchange || row.feedMasterExchange || row.exchange || 'NFO').toUpperCase(),
    }
  }
  if (!isAngelBroker(brokerName)) return null

  const token = row.symboltoken
  if (token == null || token === '') return null
  return { token: String(token), exchange: String(row.exchange || 'NFO').toUpperCase() }
}

function toPositionStatus(error) {
  const message = String(error?.message || '')
  if (/SmartAPI HTTP 503/i.test(message)) {
    return 'SmartAPI is temporarily unavailable. Please retry Get Position in a moment.'
  }
  if (isAuthError(error) || isRateLimited(error)) {
    const issue = classifyLoginError(error)
    return `${issue.title}. ${issue.hint}`
  }
  return message || 'Failed to load Get Position legs'
}

function positionRowToLeg(row, brokerName) {
  // symbol_token stays the BROKER's token (it is what orders and margins use);
  // feed_token is the Angel token the row is actually subscribed under, which for
  // a Kotak row is a different number entirely. withLiveTick() matches on the
  // latter, so a Kotak leg finds the tick that was subscribed for it.
  const feed = angelFeedRef(row, brokerName)
  return {
    id: positionIdentityKey(row),
    trading_symbol: row.tradingsymbol || row.symbolname || row.symbol,
    stock_name: row.symbolname || row.name || row.symbol,
    expiry: row.expirydate || row.expiry_date || row.expiry || row.expirationdate,
    // Carried through so the leg is rendered from what the BROKER says, not from a
    // guess at its symbol: Kotak's monthly form (NIFTY26JUL24100PE) is written
    // exactly like Angel's DD-MMM-YY and parses to a strike of 100.
    strike: row.strikeprice ?? row.strike_price ?? row.strike,
    option_type: row.optiontype || row.option_type,
    symbol_token: row.symboltoken,
    feed_token: feed ? feed.token : '',
    feed_exchange: feed ? feed.exchange : '',
    exchange: row.exchange,
    product_type: row.producttype || row.product_type,
    net_qty: row.netqty,
    buy_avg: positionBuyAvg(row),
    sell_avg: positionSellAvg(row),
    ltp: positionValue(row, ['ltp', 'LTP', 'lasttradedprice']),
    pnl: positionPnl(row),
  }
}

function comparePositionLegs(a, b) {
  const stockA = positionStockName(a)
  const stockB = positionStockName(b)
  const categoryDiff = Number(!isIndexPosition(a)) - Number(!isIndexPosition(b))

  return categoryDiff
    || stockA.localeCompare(stockB, 'en', { numeric: true })
    || String(a.expiry || a.trading_symbol || '').localeCompare(
      String(b.expiry || b.trading_symbol || ''),
      'en',
      { numeric: true },
    )
}

const INDEX_STOCK_NAMES = new Set([
  'BANKEX',
  'BANKNIFTY',
  'FINNIFTY',
  'MIDCPNIFTY',
  'NIFTY',
  'NIFTYNXT50',
  'SENSEX',
])

function positionStockName(leg) {
  const explicit = String(leg.stock_name || leg.symbol_name || '').trim().toUpperCase()
  return explicit || parseTradingSymbol(leg.trading_symbol).root.toUpperCase()
}

function isIndexPosition(leg) {
  return INDEX_STOCK_NAMES.has(positionStockName(leg).replace(/[\s_-]/g, ''))
}

function positionPnl(row) {
  if (row.pnl != null && row.pnl !== '') return Number(row.pnl)
  return Number(row.realised || 0) + Number(row.unrealised || 0)
}

function positionIdentityKey(row) {
  return normalizedPositionIdentity({
    token: row.symboltoken,
    symbol: row.tradingsymbol || row.symbolname || row.symbol,
    exchange: row.exchange,
    product: row.producttype || row.product_type,
    qty: row.netqty,
  })
}

function strategyLegIdentityKey(leg) {
  return normalizedPositionIdentity({
    token: leg.symbol_token,
    symbol: leg.trading_symbol,
    exchange: leg.exchange,
    product: leg.product_type,
    qty: leg.net_qty,
  })
}

function normalizedPositionIdentity({ token, symbol, exchange, product, qty }) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase()
  if (!normalizedSymbol) return ''

  return [
    String(token || '').trim(),
    normalizedSymbol,
    String(exchange || '').trim().toUpperCase(),
    compactProductTag(product || ''),
    String(Number(qty || 0)),
  ].join('|')
}

function positionValue(row, keys) {
  for (const key of keys) {
    const value = row?.[key]
    if (value != null && value !== '' && Number.isFinite(Number(value))) return Number(value)
  }
  return 0
}

function positionBuyAvg(row) {
  const direct = positionValue(row, [
    'totalbuyavgprice',
    'totalBuyAvgPrice',
    'total_buy_avg_price',
    'buyavgprice',
    'buyAvgPrice',
    'buyaverageprice',
    'buyAveragePrice',
    'buy_avg_price',
    'buyAvg',
    'cfbuyavgprice',
    'cfBuyAvgPrice',
    'cf_buy_avg_price',
  ])
  if (direct) return direct

  const amount = positionValue(row, ['totalbuyvalue', 'totalBuyValue', 'buyamount', 'buyAmount', 'cfbuyamount', 'cfBuyAmount', 'buy_value', 'buyValue'])
  const qty = Math.abs(positionValue(row, ['totalbuyqty', 'totalBuyQty', 'buyqty', 'buyQty', 'buyquantity', 'buyQuantity', 'cfbuyqty', 'cfBuyQty']))
  return amount && qty ? amount / qty : 0
}

function positionSellAvg(row) {
  const direct = positionValue(row, [
    'totalsellavgprice',
    'totalSellAvgPrice',
    'total_sell_avg_price',
    'sellavgprice',
    'sellAvgPrice',
    'sellaverageprice',
    'sellAveragePrice',
    'sell_avg_price',
    'sellAvg',
    'cfsellavgprice',
    'cfSellAvgPrice',
    'cf_sell_avg_price',
  ])
  if (direct) return direct

  const amount = positionValue(row, ['totalsellvalue', 'totalSellValue', 'sellamount', 'sellAmount', 'cfsellamount', 'cfSellAmount', 'sell_value', 'sellValue'])
  const qty = Math.abs(positionValue(row, ['totalsellqty', 'totalSellQty', 'sellqty', 'sellQty', 'sellquantity', 'sellQuantity', 'cfsellqty', 'cfSellQty']))
  return amount && qty ? amount / qty : 0
}

function strategyBrokerLabel(strategy) {
  const broker = String(strategy.broker_name || '').trim()
  const account = String(strategy.broker_account_id || '').trim()
  if (broker && account) return `${broker} ${account}`
  return broker || account
}

function strategyBrokerMatchesSelected(strategy, selectedConfig, configId) {
  if (!strategy || !selectedConfig) return false

  const savedConfigId = String(strategy.broker_config_id || '')
  const selectedConfigId = String(configId || selectedConfig.id || '')
  if (savedConfigId && selectedConfigId && savedConfigId === selectedConfigId) return true

  const savedBroker = String(strategy.broker_name || '').trim().toLowerCase()
  const selectedBroker = String(selectedConfig.broker_name || '').trim().toLowerCase()
  const savedAccount = String(strategy.broker_account_id || '').trim()
  const selectedAccount = String(selectedConfig.account_id || '').trim()

  return Boolean(savedBroker && selectedBroker && savedAccount && selectedAccount
    && savedBroker === selectedBroker
    && savedAccount === selectedAccount)
}

function userLabel(user) {
  return user.username || `${user.first_name || ''} ${user.last_name || ''}`.trim() || `User ${user.id}`
}

export default ClientDashboard
