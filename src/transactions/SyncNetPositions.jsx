import { useCallback, useEffect, useState } from 'react'
import { AlignJustify, Table, ArrowUpDown } from 'lucide-react'
import { apiGet, apiPost } from '../config/api'
import { getSavedSession, isAngelBroker } from '../feedmaster/feedMasterStore'
import { compactProductTag, parseTradingSymbol } from '../tradepanel/symbolParse'
import { CompactSelect } from '../tradepanel/PositionSelect'
import '../tradepanel/tradepanel.css'

function money(v) {
  const n = Number(v || 0)
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function priceCell(value, strong = false) {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n === 0) return <span className="position-price-muted">-</span>
  return <span className={strong ? 'position-price ltp' : 'position-price'}>{money(n)}</span>
}

function legIsClosed(leg) {
  return Boolean(
    Number(leg.is_closed || leg.closed || 0) ||
    leg.closed_at ||
    leg.exit_price ||
    leg.exitPrice
  )
}

function legExitPrice(leg) {
  return Number(leg.exit_price || leg.exitPrice || leg.close_price || leg.closePrice || 0)
}

function exitPriceCell(leg) {
  const exit = legExitPrice(leg)
  if (!legIsClosed(leg) || !exit) return priceCell(leg.ltp, true)
  return (
    <span className="strategy-exit-price">
      <span>Exit</span>{money(exit)}
    </span>
  )
}

function CompactLegs({ legs }) {
  return (
    <div className="compact-legs">
      <div className="compact-leg-row compact-leg-head">
        <span />
        <span>Symbol</span>
        <span>Qty</span>
        <span>Buy Avg</span>
        <span>Sell Avg</span>
        <span>LTP</span>
        <span>P&amp;L</span>
      </div>
      {legs.map((leg) => {
        const parsed = parseTradingSymbol(leg.trading_symbol)
        const qty = Number(leg.net_qty || 0)
        const pnl = Number(leg.pnl || 0)
        const closed = legIsClosed(leg)
        return (
          <div className={`compact-leg-row ${closed ? 'strategy-leg-closed' : ''}`} key={leg.id} title={leg.trading_symbol}>
            <span className={`book-tag side ${qty >= 0 ? 'buy' : 'sell'}`}>{closed ? 'C' : (qty >= 0 ? 'B' : 'S')}</span>
            <span className="compact-leg-symbol">
              <strong>{parsed.root}</strong>
              {parsed.strike && <span className="position-strike">{parsed.strike}</span>}
              {parsed.optionType && <span className={`book-tag option ${parsed.optionType.toLowerCase()}`}>{parsed.optionType}</span>}
              {closed && <span className="strategy-closed-tag">Closed</span>}
            </span>
            <span className={`compact-leg-qty ${qty >= 0 ? 'up' : 'down'}`}>{qty.toLocaleString('en-IN')}</span>
            <span className="compact-leg-cell">{priceCell(leg.buy_avg)}</span>
            <span className="compact-leg-cell">{priceCell(leg.sell_avg)}</span>
            <span className="compact-leg-cell compact-leg-ltp">{exitPriceCell(leg)}</span>
            <span className={`compact-leg-pnl ${pnl >= 0 ? 'up' : 'down'}`}>{money(pnl)}</span>
          </div>
        )
      })}
    </div>
  )
}

function LegsTable({ legs, title }) {
  const sidePnl = legs.reduce((sum, leg) => sum + Number(leg.pnl || 0), 0)
  return (
    <div className="positions-table-wrap">
      {title && (
        <div className="legs-table-title">
          <span className="legs-table-title-label">{title}</span>
          <span className={`legs-table-title-pnl ${sidePnl >= 0 ? 'up' : 'down'}`}>
            P&amp;L {money(sidePnl)}
          </span>
        </div>
      )}
      <table className="positions-table position-book-table strategy-legs-table">
        <thead>
          <tr>
            <th>Stock Name</th>
            <th>Product Type</th>
            <th className="num">Net Qty.</th>
            <th className="num">Buy Avg</th>
            <th className="num">Sell Avg</th>
            <th className="num">LTP</th>
            <th className="num">P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {legs.length === 0 ? (
            <tr>
              <td className="positions-empty" colSpan={7}>No {title ? title.toLowerCase() : ''} legs</td>
            </tr>
          ) : (
            legs.map((leg) => {
              const parsed = parseTradingSymbol(leg.trading_symbol)
              const qty = Number(leg.net_qty || 0)
              const pnl = Number(leg.pnl || 0)
              const closed = legIsClosed(leg)
              return (
                <tr key={leg.id} className={`${qty < 0 ? 'position-row-short' : ''}${closed ? ' strategy-leg-closed' : ''}`}>
                  <td>
                    <div className="position-symbol-line" title={leg.trading_symbol}>
                      <strong>{parsed.root}</strong>
                      {parsed.expiry && <span className="position-expiry">{parsed.expiry}</span>}
                      {parsed.strike && <span className="position-strike">{parsed.strike}</span>}
                      {parsed.optionType && <span className={`book-tag option ${parsed.optionType.toLowerCase()}`}>{parsed.optionType}</span>}
                      {leg.exchange && <span className="book-tag exchange">{leg.exchange}</span>}
                      {closed && <span className="strategy-closed-tag">Closed</span>}
                    </div>
                  </td>
                  <td>
                    <div className="book-product-cell">
                      {closed && <span className="strategy-closed-tag">CLOSED</span>}
                      {!closed && qty !== 0 && <span className={`book-tag side ${qty > 0 ? 'buy' : 'sell'}`}>{qty > 0 ? 'LONG' : 'SHORT'}</span>}
                      <span className="book-tag product">{compactProductTag(leg.product_type)}</span>
                    </div>
                  </td>
                  <td className="num">
                    <div className="book-qty-cell">
                      <span className={qty >= 0 ? 'up' : 'down'}>{qty.toLocaleString('en-IN')}</span>
                    </div>
                  </td>
                  <td className="num">{priceCell(leg.buy_avg)}</td>
                  <td className="num">{priceCell(leg.sell_avg)}</td>
                  <td className="num">{exitPriceCell(leg)}</td>
                  <td className="num">
                    <span className={`position-pnl-value ${pnl >= 0 ? 'up' : 'down'}`}>{money(pnl)}</span>
                  </td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}

function SyncNetPositions() {
  const [users, setUsers] = useState([])
  const [userId, setUserId] = useState('')
  const [configs, setConfigs] = useState([])
  const [configId, setConfigId] = useState('')
  const [status, setStatus] = useState('Select a user and account')
  const [running, setRunning] = useState(false)
  const [configLoading, setConfigLoading] = useState(false)
  const [log, setLog] = useState([])
  const [summary, setSummary] = useState(null)
  const [strategies, setStrategies] = useState([])
  const [strategiesLoading, setStrategiesLoading] = useState(false)
  const [view, setView] = useState('normal') // 'compact' | 'normal' | 'buysell'

  const selectedConfig = configs.find((config) => String(config.id) === String(configId))
  const selectedBrokerName = selectedConfig?.broker_name || ''
  const selectedIsAngel = isAngelBroker(selectedBrokerName)

  const loadStrategies = useCallback(async (nextUserId = userId, cancelled = false) => {
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
  }, [userId])

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
        const current = findLoggedInUser(list, principal) || list[0]
        if (current?.id) {
          setUserId(String(current.id))
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

  useEffect(() => {
    let cancelled = false

    async function loadConfigs() {
      if (!userId) {
        setConfigs([])
        setConfigId('')
        return
      }

      setConfigLoading(true)
      setLog([])
      setSummary(null)
      try {
        const res = await apiGet(`/users/broker-config/list.php?user_id=${userId}`)
        if (cancelled) return

        const list = res.data || []
        setConfigs(list)
        setConfigId(String(list[0]?.id || ''))
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

  useEffect(() => {
    setLog([])
    setSummary(null)

    if (!selectedConfig) return
    if (!selectedIsAngel) {
      setStatus(`${selectedBrokerName || 'Selected broker'} sync is not wired yet`)
      return
    }

    const session = getSavedSession(configId)
    setStatus(session?.jwtToken ? '' : 'This account is not logged in. Login from Broker Configuration first.')
  }, [configId, selectedBrokerName, selectedConfig, selectedIsAngel])

  const startSync = async () => {
    if (!selectedConfig) {
      setStatus('Select an account first')
      return
    }
    if (!selectedIsAngel) {
      setStatus(`${selectedBrokerName || 'Selected broker'} sync is not wired yet`)
      return
    }
    if (!getSavedSession(configId)?.jwtToken) {
      setStatus('This account is not logged in. Login from Broker Configuration first.')
      return
    }

    setRunning(true)
    setLog([])
    setSummary(null)
    setStatus('Syncing net positions...')

    try {
      const res = await apiPost('/transactions/sync-net-positions.php', {
        live: true,
        user_id: userId,
        broker_config_id: configId,
      })

      setSummary(res.summary || null)
      setLog(res.log || [])
      setStatus('Sync completed')
      await loadStrategies(userId)
    } catch (error) {
      setStatus(error.message || 'Sync failed')
      setLog((prev) => [...prev, 'Sync failed'])
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="trade-panel">
      <div className="positions-view">
        <div className="positions-toolbar">
          <CompactSelect
            title="User"
            value={userId}
            onChange={setUserId}
            options={users.map((user) => ({
              value: String(user.id),
              label: user.username || `${user.first_name || ''} ${user.last_name || ''}`.trim() || `User ${user.id}`,
            }))}
          />

          <CompactSelect
            title="Account"
            value={configId}
            onChange={setConfigId}
            disabled={configLoading || !configs.length}
            options={configs.map((config) => ({
              value: String(config.id),
              label: config.account_id || `Account ${config.id}`,
              meta: config.broker_name || 'Broker',
            }))}
          />

          <button
            className="positions-load-btn"
            onClick={startSync}
            disabled={running || !selectedConfig}
            type="button"
          >
            {running ? 'Syncing' : 'Sync Net Positions'}
          </button>

          {summary && (
            <span className="positions-total up">
              Synced: {summary.success || 0} / {summary.total_accounts || 0}
            </span>
          )}
          {status && <span className="positions-status">{status}</span>}

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
        </div>

        <div className="positions-table-wrap">
          <table className="positions-table">
            <thead>
              <tr>
                <th>Result</th>
                <th className="num">Total Accounts</th>
                <th className="num">Success</th>
                <th className="num">Failed</th>
              </tr>
            </thead>
            <tbody>
              {summary ? (
                <tr>
                  <td>Net positions sync completed</td>
                  <td className="num">{summary.total_accounts || 0}</td>
                  <td className="num up">{summary.success || 0}</td>
                  <td className="num down">{summary.failed || 0}</td>
                </tr>
              ) : (
                <tr>
                  <td className="positions-empty" colSpan={4}>No sync result to show</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {log.length > 0 && (
          <div className="positions-table-wrap sync-log-wrap">
            <table className="positions-table">
              <thead>
                <tr>
                  <th>Sync Log</th>
                </tr>
              </thead>
              <tbody>
                {log.map((item, index) => (
                  <tr key={`${index}-${item}`}>
                    <td>{item}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {userId && (
          <div className={`strategy-list strategy-list--${view}`}>
            <div className="strategy-list-head">
              <strong>Saved Strategies</strong>
              <span>
                {strategiesLoading
                  ? 'Loading…'
                  : `${strategies.length} ${strategies.length === 1 ? 'strategy' : 'strategies'}`}
              </span>
            </div>

            {!strategiesLoading && strategies.length === 0 && (
              <div className="strategy-list-empty">No strategies saved for this user yet</div>
            )}

            {strategies.map((strategy) => {
              const legs = strategy.legs || []
              const totalPnl = legs.reduce((sum, leg) => sum + Number(leg.pnl || 0), 0)
              return (
                <div className="strategy-card" key={strategy.strategy_code}>
                  <div className="strategy-card-head">
                    <div className="strategy-card-title">
                      <strong>{strategy.strategy_name}</strong>
                    </div>
                    <div className="strategy-card-meta">
                      <span>{legs.length} {legs.length === 1 ? 'leg' : 'legs'}</span>
                      <span className={totalPnl >= 0 ? 'up' : 'down'}>P&amp;L {money(totalPnl)}</span>
                    </div>
                  </div>

                  {legs.length > 0 ? (
                    view === 'buysell' ? (
                      <div className="legs-split">
                        <LegsTable title="Buy" legs={legs.filter((leg) => Number(leg.net_qty || 0) > 0)} />
                        <LegsTable title="Sell" legs={legs.filter((leg) => Number(leg.net_qty || 0) < 0)} />
                      </div>
                    ) : view === 'compact' ? (
                      <CompactLegs legs={legs} />
                    ) : (
                      <LegsTable legs={legs} />
                    )
                  ) : (
                    <div className="strategy-card-nolegs">No legs saved for this strategy</div>
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
