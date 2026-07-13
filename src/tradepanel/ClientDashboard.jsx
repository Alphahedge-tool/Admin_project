import { useCallback, useEffect, useMemo, useState } from 'react'
import { CircleChevronDown, AlignJustify, Table, ArrowUpDown, Radio } from 'lucide-react'
import { apiGet } from '../config/api'
import {
  classifyLoginError, ensureSession, getAngelClient, isAngelBroker, isAuthError, isRateLimited,
  saveSession,
} from '../feedmaster/angelSessionStore'
import { getSavedTradeAccount, saveTradeAccount } from './tradeAccountStore'
import { CompactSelect } from './PositionSelect'
import { compactProductTag, parseTradingSymbol } from './symbolParse'
import { legIsClosed, money, withLiveTick } from './legFormat'
import { CompactLegs, LegsTable } from './strategyLegsView'
import { useLiveLegFeed } from './useLiveLegFeed'
import './tradepanel.css'

function ClientDashboard() {
  const [users, setUsers] = useState([])
  const [userId, setUserId] = useState('')
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
  const [view, setView] = useState('compact') // 'compact' | 'normal' | 'buysell'

  const selectedUser = useMemo(
    () => users.find((user) => String(user.id) === String(userId)),
    [users, userId],
  )
  const selectedConfig = useMemo(
    () => configs.find((config) => String(config.id) === String(configId)),
    [configs, configId],
  )
  const isAllUsers = userId === 'all'
  const brokerStrategies = useMemo(
    () => (isAllUsers
      ? strategies
      : strategies.filter((strategy) => strategyBrokerMatchesSelected(strategy, selectedConfig, configId))),
    [isAllUsers, strategies, selectedConfig, configId],
  )
  const selectedIsAngel = isAngelBroker(selectedConfig?.broker_name || '')

  // Live-mark every open leg on screen (saved strategy legs + matched Get
  // Position legs) over the shared Feedmaster websocket feed - same feed the
  // rest of Trade Panel uses.
  const legFeedKey = useMemo(() => {
    const seen = new Set()
    brokerStrategies.forEach((strategy) => {
      (strategy.legs || []).forEach((leg) => {
        if (legIsClosed(leg)) return
        const token = leg.symbol_token
        if (token == null || token === '') return
        seen.add(`${leg.exchange || 'NFO'}|${token}`)
      })
    })
    positionRows.forEach((row) => {
      const token = row.symboltoken
      if (token == null || token === '') return
      seen.add(`${row.exchange || 'NFO'}|${token}`)
    })
    return [...seen].sort().join(',')
  }, [brokerStrategies, positionRows])

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
      .map(positionRowToLeg)
      .map((leg) => withLiveTick(leg, liveTicks)),
    [untrackedPositionRows, liveTicks],
  )

  const handleUserId = useCallback((value) => {
    setUserId(value)
    setConfigId('')
    saveTradeAccount({ userId: value, configId: '' })
  }, [])

  const handleConfigId = useCallback((value) => {
    setConfigId(value)
    saveTradeAccount({ userId, configId: value })
  }, [userId])

  const toggleStrategyExpanded = useCallback((strategyCode) => {
    setExpandedStrategies((current) => {
      const next = new Set(current)
      if (next.has(strategyCode)) next.delete(strategyCode)
      else next.add(strategyCode)
      return next
    })
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadUsers() {
      try {
        const [usersOut, authOut] = await Promise.allSettled([
          apiGet('/users/list.php'),
          apiGet('/auth/me.php'),
        ])
        if (cancelled) return

        if (usersOut.status !== 'fulfilled') {
          setStatus('Failed to load users')
          return
        }

        const list = usersOut.value.data || []
        setUsers(list)
        const auth = authOut.status === 'fulfilled' ? authOut.value : null
        const principal = auth?.user || auth?.admin || auth?.data || auth || {}
        const saved = getSavedTradeAccount()
        const savedUser = saved.userId && list.some((user) => String(user.id) === String(saved.userId))
          ? list.find((user) => String(user.id) === String(saved.userId))
          : null
        const current = savedUser || findLoggedInUser(list, principal) || list[0]

        if (current?.id) {
          setUserId(String(current.id))
          saveTradeAccount({ userId: String(current.id) })
          setStatus('Select client account')
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

  useEffect(() => {
    let cancelled = false

    async function loadConfigs() {
      if (!userId || userId === 'all') {
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
        if (userId === 'all') {
          // Overview: pull every user's strategies at once and tag each with
          // the user it belongs to, so the cards can span many users.
          const results = await Promise.all(users.map(async (user) => {
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
  }, [userId, users])

  useEffect(() => {
    let cancelled = false

    async function loadPositions() {
      setPositionRows([])
      setPositionsStatus('')
      if (!configId || !selectedConfig) return

      if (!selectedIsAngel) {
        setPositionsStatus(`${selectedConfig.broker_name || 'Selected broker'} positions are not wired yet`)
        return
      }

      setPositionsLoading(true)
      setPositionsStatus('Loading Get Position legs...')
      try {
        // The account was logged in at app start and its token saved (see
        // StartupGate), so normally there is nothing to do here.
        let client = getAngelClient(configId)
        if (!client) {
          setPositionsStatus('This Angel account is not loaded')
          return
        }
        if (!client.session?.jwtToken) {
          setPositionsStatus('Signing in this Angel account...')
          client = { ...client, session: await ensureSession(configId), loggedIn: true }
          if (cancelled) return
        }

        setPositionsStatus('Loading Get Position legs...')
        let body
        try {
          body = await fetchAngelPositions(client)
        } catch (error) {
          // A saved token that has since expired: one shared, deduped re-login.
          if (!isAuthError(error)) throw error
          setPositionsStatus('Angel token expired - signing in again...')
          client = { ...client, session: await ensureSession(configId, { force: true }), loggedIn: true }
          if (cancelled) return
          body = await fetchAngelPositions(client)
        }

        if (body.session?.jwtToken) saveSession(configId, body.session)
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
  }, [configId, selectedConfig, selectedIsAngel])

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
              title="User"
              value={userId}
              onChange={handleUserId}
              menuMinWidth={360}
              options={[
                { value: 'all', label: 'All Users', meta: 'Overview' },
                ...users.map((user) => ({
                  value: String(user.id),
                  label: userLabel(user),
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
                  Viewing <strong>All Users</strong>
                </span>
              ) : selectedUser ? (
                <span className="client-viewing-user">
                  Viewing <strong>{userLabel(selectedUser)}</strong>
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

          {isAllUsers && !strategiesLoading && brokerStrategies.length === 0 && (
            <div className="client-strategy-empty">No strategies found for any user.</div>
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
                const positionsPnl = livePositionLegs.reduce((sum, leg) => sum + Number(leg.pnl || 0), 0)
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
                        positionLegs={livePositionLegs}
                        positionsLoading={positionsLoading}
                        positionsStatus={positionsStatus}
                        showPositions={!isAllUsers}
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

async function fetchAngelPositions(client) {
  const res = await fetch('/api/angel/positions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.status === false) throw new Error(body.message || `HTTP ${res.status}`)
  return body
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

function positionRowToLeg(row) {
  return {
    id: positionIdentityKey(row),
    trading_symbol: row.tradingsymbol || row.symbolname || row.symbol,
    stock_name: row.symbolname || row.name || row.symbol,
    expiry: row.expirydate || row.expiry_date || row.expiry || row.expirationdate,
    symbol_token: row.symboltoken,
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

export default ClientDashboard
