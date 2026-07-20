import { useCallback, useEffect, useMemo, useState } from 'react'
import { CircleChevronDown, AlignJustify, Table, ArrowUpDown, Radio } from 'lucide-react'
import { apiGet } from '../config/api'
import { ensureAccountsLoaded, isAngelBroker } from '../feedmaster/angelSessionStore'
import { getSavedTradeAccount, saveTradeAccount } from './tradeAccountStore'
import { CompactSelect } from './PositionSelect'
import { BrokerMark } from './BrokerMark'
import { expiryDate, parseTradingSymbol } from './symbolParse'
import { legIsClosed, money, withLiveTick } from './legFormat'
import { CompactLegs, LegsTable } from './strategyLegsView'
import { SkeletonCards } from './TableSkeleton'
import { useLiveLegFeed } from './useLiveLegFeed'
import { strategyCardKey, useStrategyMargins } from './useStrategyMargins'
import './tradepanel.css'
import './clientDashboard.css'

// "Every user" and "every group" are selections in their own right, not the
// absence of one - the pickers carry them as values.
const ALL_USERS = 'all'
const ALL_GROUPS = 'all'
// A single user's Account picker can also select ALL of their accounts at once,
// which shows their positions grouped per broker (Zerodha, Kotak, ...) instead of
// one account at a time. Its own sentinel so it never collides with a real config
// id, and so the other Trade Panel pages (which only understand one account) are
// never handed it.
const ALL_ACCOUNTS = 'all-accounts'

function ClientDashboard({ active = true }) {
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
  const [expandedStrategies, setExpandedStrategies] = useState(() => new Set())
  const [view, setView] = useState('normal') // 'compact' | 'normal' | 'buysell'

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

  // A single user with All Accounts selected shares the same saved-strategy
  // overview path as All Users. No broker position book is read on this page.
  const singleAllAccounts = userId !== ALL_USERS && configId === ALL_ACCOUNTS && Boolean(selectedUser)
  const showOverview = userId === ALL_USERS || singleAllAccounts

  const selectedConfig = useMemo(
    () => configs.find((config) => String(config.id) === String(configId)),
    [configs, configId],
  )
  const isAllUsers = userId === ALL_USERS
  // In any overview (all users, or one user across all their accounts) every
  // strategy in scope is shown; only the single-account view filters to the one
  // account that is selected.
  const brokerStrategies = useMemo(() => {
    const now = Date.now()
    const inScope = showOverview
      ? strategies
      : strategies.filter((strategy) => strategyBrokerMatchesSelected(strategy, selectedConfig, configId))
    // Drop strategies whose every leg has already expired - a contract past its
    // expiry is settled, not a live position, so it does not belong on the
    // dashboard. A strategy with even one still-live (or unreadable) leg stays.
    return inScope.filter((strategy) => !strategyIsExpired(strategy, now))
  }, [showOverview, strategies, selectedConfig, configId])
  // Live-mark only backend-saved strategy legs over the shared Feedmaster feed.
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
    return [...seen].sort().join(',')
  }, [brokerStrategies])

  const { liveTicks, feedStatus } = useLiveLegFeed(legFeedKey, { subscriber: 'client-dashboard' })

  // "Margin deployed" per strategy, from Angel's batch margin calculator. Only
  // Angel accounts are priced, and only while THIS is the visible tab - the four
  // Trade Panel tabs are all mounted at once, so an ungated fetch would log in
  // every account and price every strategy the moment any tab is opened. In the
  // single-account view a strategy may predate broker tagging, so the selected
  // account id fills in as the fallback.
  const strategyMargins = useStrategyMargins(brokerStrategies, {
    fallbackConfigId: showOverview ? '' : configId,
    active,
  })

  // One live combined P&L per user group across every saved strategy currently
  // in scope. This is derived from the already-loaded backend legs and their
  // shared live ticks; it never requests a broker position book.
  const groupPnlSummaries = useMemo(() => {
    const userById = new Map(users.map((user) => [String(user.id), user]))
    const groupById = new Map(groups.map((group) => [String(group.id), group]))
    const totals = new Map()

    brokerStrategies.forEach((strategy) => {
      const owner = userById.get(String(strategy._userId || userId)) || selectedUser
      const ownerGroupId = String(owner?.group_id || selectedGroup?.id || 'ungrouped')
      const ownerGroup = groupById.get(ownerGroupId) || selectedGroup
      const groupName = owner?.group_name || ownerGroup?.name || 'No Group'
      const legs = (strategy.legs || []).map((leg) => withLiveTick(leg, liveTicks))
      const openLegs = legs.filter((leg) => !legIsClosed(leg)).length
      const pnl = legs.reduce((sum, leg) => sum + Number(leg.pnl || 0), 0)
      const marginState = strategyMargins[strategyCardKey(strategy)]
      const current = totals.get(ownerGroupId) || {
        id: ownerGroupId,
        name: groupName,
        strategies: 0,
        legs: 0,
        openLegs: 0,
        pnl: 0,
        margin: 0,
      }

      current.strategies += 1
      current.legs += legs.length
      current.openLegs += openLegs
      current.pnl += pnl
      // Only settled margins roll into the group total, so a still-loading (or
      // Angel-unavailable) strategy leaves it reading low rather than wrong.
      if (marginState?.status === 'ready') current.margin += Number(marginState.value || 0)
      totals.set(ownerGroupId, current)
    })

    return [...totals.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'))
  }, [brokerStrategies, groups, liveTicks, selectedGroup, selectedUser, strategyMargins, userId, users])

  const overviewLoading = showOverview && strategiesLoading

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
    // "All Accounts" is a dashboard-only overview selection - the other Trade Panel
    // pages only understand a single account, so never persist it as the shared one.
    if (value !== ALL_ACCOUNTS) saveTradeAccount({ userId, configId: value })
  }, [userId])

  const toggleStrategyExpanded = useCallback((strategyCode) => {
    setExpandedStrategies((current) => {
      const next = new Set(current)
      if (next.has(strategyCode)) next.delete(strategyCode)
      else next.add(strategyCode)
      return next
    })
  }, [])

  // Strategies load as compact horizontal containers. Opening is deliberate:
  // changing group, user, or account closes the previous scope's cards so only
  // the strategy the user clicks reveals its position table.
  useEffect(() => {
    setExpandedStrategies(new Set())
  }, [configId, groupId, userId])

  // Hydrate the broker session store (accounts + saved tokens) so the margin
  // hook can resolve each strategy's Angel account and its session. Deduped, so
  // sharing it with the sibling book pages costs nothing.
  useEffect(() => {
    ensureAccountsLoaded()
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
        } else {
          const res = await apiGet(`/strategy-master/list.php?user_id=${userId}`)
          // Tag with the owner even for a single user, so the All-Accounts overview
          // (which reuses the group-overview render) can match a strategy to its
          // owner's position book the same way. The card labels off isAllUsers, not
          // this tag, so the single-account view is unchanged.
          const owner = groupUsers.find((user) => String(user.id) === String(userId))
          const label = owner ? userLabel(owner) : ''
          if (!cancelled) setStrategies((res.data || []).map((strategy) => ({
            ...strategy,
            _userId: String(userId),
            _userLabel: label,
          })))
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

  return (
    <div className="trade-panel">
      <div className="client-dashboard-view client-dashboard-production positions-view-compact">
        <div className="client-dashboard-head">
          <div>
            <h2>Client Dashboard</h2>
          </div>
        </div>

        <div className="client-dashboard-toolbar">
          <div className="client-dashboard-picker">
            <CompactSelect
              title="Group"
              icon="group"
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
              icon="user"
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
                : [
                  // Only worth offering when the user actually holds more than one
                  // account - otherwise "All Accounts" and the one account are the
                  // same view.
                  ...(configs.length > 1
                    ? [{ value: ALL_ACCOUNTS, label: 'All Accounts', meta: `${configs.length} accounts · grouped` }]
                    : []),
                  ...configs.map((config) => ({
                    value: String(config.id),
                    label: config.account_id || `Account ${config.id}`,
                    meta: config.broker_name || 'Broker',
                  })),
                ]}
            />
          </div>

          {status && <span className="positions-status">{status}</span>}

          <span
            className={`orderbook-live-pill ${overviewLoading && feedStatus === 'offline' ? 'connecting' : feedStatus}`}
            title={overviewLoading
              ? 'Loading user books and live streams'
              : 'Live LTP feed (Feedmaster)'}
          >
            <Radio size={13} />
            {overviewLoading && feedStatus === 'offline'
              ? 'Loading'
              : feedStatus === 'live'
                ? 'Live'
                : feedStatus === 'connecting'
                  ? 'Connecting'
                  : 'Offline'}
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
                  {singleAllAccounts && <> · <strong>all accounts</strong></>}
                </span>
              ) : null}
            </div>
            <span>
              {strategiesLoading
                ? 'Loading...'
                : isAllUsers
                  ? `${brokerStrategies.length} strategies · ${new Set(brokerStrategies.map((s) => s._userLabel)).size} users`
                  : singleAllAccounts
                    ? `${brokerStrategies.length} strategies · ${configs.length} accounts`
                    : selectedConfig
                      ? `${brokerStrategies.length} matched`
                      : 'Select account'}
            </span>
          </div>

          {groupPnlSummaries.length > 0 && (
            <div className="client-group-pnl-strip" aria-label="Combined strategy P and L by group">
              {groupPnlSummaries.map((group) => (
                <div className="client-group-pnl-card" key={group.id}>
                  <div className="client-group-pnl-name">
                    <span>Group</span>
                    <strong>{group.name}</strong>
                  </div>
                  <div className="client-group-pnl-meta">
                    <span className="client-group-chip">
                      <em>{group.strategies === 1 ? 'Strategy' : 'Strategies'}</em>{group.strategies}
                    </span>
                    <span className="client-group-chip">
                      <em>Legs</em>{group.legs}
                    </span>
                    <span className="client-group-chip">
                      <em>Open</em>{group.openLegs}
                    </span>
                    {group.margin > 0 && (
                      <span
                        className="client-group-chip margin"
                        title="Angel margin deployed across this group's strategies"
                      >
                        <em>Margin</em>{money(group.margin)}
                      </span>
                    )}
                  </div>
                  <div className="client-group-pnl-value">
                    <span>Combined P&amp;L</span>
                    <strong className={group.pnl >= 0 ? 'up' : 'down'}>{money(group.pnl)}</strong>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* First load only: skeleton cards while there are no strategies on
              screen yet. Switching scope keeps the previous cards until the new
              ones arrive, so this never flashes over existing content. */}
          {strategiesLoading && brokerStrategies.length === 0 && (
            <SkeletonCards count={4} />
          )}

          {selectedConfig && !strategiesLoading && brokerStrategies.length === 0 && (
            <div className="client-strategy-empty">
              No saved strategies tagged to {selectedConfig.broker_name || 'this broker'} {selectedConfig.account_id || ''}.
            </div>
          )}

          {isAllUsers && !strategiesLoading && !groupUsers.length && (
            <div className="client-strategy-empty">No users in this group.</div>
          )}

          {brokerStrategies.length > 0 && (
            <div className={`client-strategy-row client-strategy-row--${view}`}>
              {brokerStrategies.map((strategy) => {
                const rawLegs = strategy.legs || []
                // Mark every open leg to the live websocket feed so LTP/P&L
                // tick in real time, same as Sync Net Positions. Tag each leg with
                // the strategy's broker so the symbol parser reads a Kotak-monthly
                // contract with Kotak's grammar (year+month+strike, no day) instead
                // of Angel's - otherwise NIFTY26JUL22350PE shows "26 Jul 22 / 350".
                const legs = rawLegs.map((leg) => withLiveTick(
                  { ...leg, broker_name: leg.broker_name || strategy.broker_name },
                  liveTicks,
                ))
                const openLegs = legs.filter((leg) => !legIsClosed(leg)).length
                const strategyPnl = legs.reduce((sum, leg) => sum + Number(leg.pnl || 0), 0)
                const brokerLabel = strategyBrokerLabel(strategy)
                // strategy_code isn't unique across users (All-Users mode), so
                // key each card on the row id instead. Shared with the margin hook
                // so a card and its margin agree on the key.
                const cardKey = strategyCardKey(strategy)
                const marginState = strategyMargins[cardKey]
                // The full-width container opens its table only when clicked.
                const expanded = expandedStrategies.has(cardKey)
                return (
                  <article className={`client-strategy-card${expanded ? ' expanded' : ''}`} key={cardKey}>
                    <div
                      className="client-strategy-summary"
                      role="button"
                      tabIndex={0}
                      aria-expanded={expanded}
                      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${strategy.strategy_name}`}
                      onClick={() => toggleStrategyExpanded(cardKey)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          toggleStrategyExpanded(cardKey)
                        }
                      }}
                    >
                    <div className="client-strategy-broker">
                      <span>{isAllUsers ? 'User' : 'Broker'}</span>
                      <strong>
                        {!isAllUsers && <BrokerMark brokerName={strategy.broker_name || selectedConfig?.broker_name} />}
                        {isAllUsers ? strategy._userLabel : (brokerLabel || selectedConfig?.broker_name || 'Broker')}
                      </strong>
                      {isAllUsers && brokerLabel && (
                        <em className="client-strategy-broker-sub">
                          <BrokerMark brokerName={strategy.broker_name} />
                          {brokerLabel}
                        </em>
                      )}
                    </div>
                    <div className="client-strategy-name">
                      <strong>{strategy.strategy_name}</strong>
                      <span className="client-strategy-expand" aria-hidden="true">
                        <CircleChevronDown size={16} strokeWidth={2.2} />
                      </span>
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
                        <div className="client-metric-margin">
                          <span>Margin Deployed</span>
                          <MarginMetric state={marginState} />
                        </div>
                        <div>
                          <span>Strategy P&amp;L</span>
                          <strong className={strategyPnl >= 0 ? 'up' : 'down'}>{money(strategyPnl)}</strong>
                        </div>
                      </div>
                    </div>
                    {expanded && (
                      <StrategyExpandedDetails
                        view={view}
                        strategyLegs={legs}
                        positionLegs={[]}
                        positionsLoading={false}
                        positionsStatus=""
                        showPositions={false}
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
        <LegsTable compact title="Buy" legs={legs.filter((leg) => Number(leg.net_qty || 0) > 0)} />
        <LegsTable compact title="Sell" legs={legs.filter((leg) => Number(leg.net_qty || 0) < 0)} />
      </div>
    )
  }
  if (view === 'compact') return <CompactLegs legs={legs} />
  return <LegsTable compact legs={legs} />
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
  // When the legs come from more than one broker account, show them split per
  // account (each with its own P&L) instead of one merged list - a user holding
  // both a Zerodha and a Kotak account then sees each book distinctly.
  const groups = useMemo(() => accountGroupsOf(posLegs), [posLegs])
  const grouped = groups.length > 1

  return (
    <div className="client-detail-panel client-open-positions-panel">
      <div className="client-detail-panel-head">
        <strong>Open Positions</strong>
        {positionsLoading
          ? <span>Loading</span>
          : (
            <LegsHeadMeta
              legs={posLegs}
              countLabel={`${posLegs.length} open legs${grouped ? ` · ${groups.length} accounts` : ''}`}
            />
          )}
      </div>
      {posLegs.length > 0 ? (
        grouped ? (
          <>
            {groups.map((group) => (
              <div className="client-account-group" key={group.key}>
                <div className="client-account-group-head">
                  <div className="client-account-group-name">
                    <span className="client-account-group-broker">
                      <BrokerMark brokerName={group.broker} />
                      {group.broker || 'Account'}
                    </span>
                    {group.accountId && <em>{group.accountId}</em>}
                  </div>
                  <AccountGroupTotal legs={group.legs} />
                </div>
                <LegsByView view={view} legs={group.legs} />
              </div>
            ))}
            <PanelTotal legs={posLegs} label="All accounts P&L" />
          </>
        ) : (
          <>
            <LegsByView view={view} legs={posLegs} />
            <PanelTotal legs={posLegs} />
          </>
        )
      ) : (
        <div className="client-detail-empty">{positionsStatus || 'No open positions outside your strategies'}</div>
      )}
    </div>
  )
}

// The P&L for one broker account's slice of a position panel, shown inline on the
// account's group heading.
function AccountGroupTotal({ legs }) {
  const total = legs.reduce((sum, leg) => sum + Number(leg.pnl || 0), 0)
  const open = legs.filter((leg) => Number(leg.net_qty || 0) !== 0).length
  return (
    <span className="client-account-group-total">
      <span className="client-account-group-open">{open} open</span>
      <strong className={total >= 0 ? 'up' : 'down'}>{money(total)}</strong>
    </span>
  )
}

// Footer row under a legs panel showing that panel's total P&L.
function PanelTotal({ legs, label = 'Total P&L' }) {
  const total = legs.reduce((sum, leg) => sum + Number(leg.pnl || 0), 0)
  return (
    <div className="client-panel-total">
      <span>{label}</span>
      <strong className={total >= 0 ? 'up' : 'down'}>{money(total)}</strong>
    </div>
  )
}

// The "Margin Deployed" figure on a strategy card. Angel's batch calculator is
// the source; a strategy on a non-Angel account (or one still resolving its
// account) has no state and reads as a muted dash. A failed price keeps the dash
// but carries the reason as a tooltip rather than shouting an error on the card.
function MarginMetric({ state }) {
  if (!state) {
    return <strong className="client-metric-pending" title="Margin is priced for Angel accounts">—</strong>
  }
  if (state.status === 'loading') {
    return <strong className="client-metric-pending">…</strong>
  }
  if (state.status === 'error') {
    return <strong className="client-metric-pending" title={state.message}>—</strong>
  }
  return <strong title={marginBreakdown(state.components)}>{money(state.value)}</strong>
}

// A one-line SPAN/exposure/premium breakdown for the margin tooltip, from
// Angel's marginComponents. Only the parts that are present and non-zero show.
function marginBreakdown(components) {
  if (!components) return 'Margin deployed'
  const parts = [
    ['SPAN', components.spanMargin],
    ['Exposure', components.exposureMargin],
    ['Option premium', components.totOptionsPremium ?? components.netPremium],
    ['Benefit', components.marginBenefit],
  ]
  const shown = parts
    .filter(([, value]) => Number(value || 0) !== 0)
    .map(([label, value]) => `${label} ${money(value)}`)
  return shown.length ? shown.join(' · ') : 'Margin deployed'
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

function strategyBrokerLabel(strategy) {
  const broker = String(strategy.broker_name || '').trim()
  const account = String(strategy.broker_account_id || '').trim()
  if (broker && account) return `${broker} ${account}`
  return broker || account
}

// True only when EVERY leg of the strategy has a known expiry and all of them are
// already past. A leg still live - or one whose expiry we cannot read - keeps the
// whole strategy visible, so a live position is never hidden by a bad parse.
function strategyIsExpired(strategy, now) {
  const legs = strategy.legs || []
  if (!legs.length) return false

  let sawExpiry = false
  for (const leg of legs) {
    const expiry = expiryDate(leg)
    if (!expiry) return false          // unreadable expiry: keep it visible
    sawExpiry = true
    if (expiry.getTime() >= now) return false // still live: keep it visible
  }
  return sawExpiry
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

// Splits position legs into one group per broker account. Legs with no account tag
// (single-account views) all fall into one unlabelled group, so those still render
// as a single flat list. Groups are ordered by broker, then account id.
function accountGroupsOf(legs) {
  const groups = new Map()
  for (const leg of legs) {
    const key = leg.account_config_id || leg.account_label || ''
    let group = groups.get(key)
    if (!group) {
      group = { key, broker: leg.account_broker || '', accountId: leg.account_id || '', legs: [] }
      groups.set(key, group)
    }
    group.legs.push(leg)
  }
  return [...groups.values()].sort((a, b) => (
    a.broker.localeCompare(b.broker, 'en') || a.accountId.localeCompare(b.accountId, 'en', { numeric: true })
  ))
}

export default ClientDashboard
