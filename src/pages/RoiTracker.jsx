import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, TriangleAlert, Radio, TrendingUp, TrendingDown } from 'lucide-react'
import { apiGet, angelPosttradePnl } from '../config/api'
import { isAngelBroker, getAngelClient, ensureSession, ensureAccountsLoaded } from '../feedmaster/angelSessionStore'
import { CompactSelect } from '../tradepanel/PositionSelect'
import { BrokerMark } from '../tradepanel/BrokerMark'
import './roiTracker.css'

const SEGMENTS = ['EQUITY', 'FNO', 'COMMODITY', 'CURRENCY']

const num = (v) => Number(v || 0)
// Indian-format currency, no decimals for big headline figures, 2dp elsewhere.
const money = (v, dp = 2) => num(v).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })
const signed = (v) => `${num(v) >= 0 ? '+' : '-'}₹${money(Math.abs(num(v)))}`
const pct = (v) => `${num(v) >= 0 ? '+' : ''}${num(v).toFixed(2)}%`

function toYmd(date) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

function defaultRange() {
  const end = new Date()
  end.setDate(end.getDate() - 1)
  const start = new Date(end)
  start.setFullYear(start.getFullYear() - 1)
  start.setDate(start.getDate() + 1)
  return { start: toYmd(start), end: toYmd(end) }
}

function userLabel(user) {
  return user.username || `${user.first_name || ''} ${user.last_name || ''}`.trim() || `User ${user.id}`
}

// All eight charge components Angel bills per symbol.
function symbolCharges(r) {
  return num(r.total_brokerage) + num(r.total_stt) + num(r.total_gst)
    + num(r.total_transaction_charges) + num(r.total_sebi_charges)
    + num(r.total_stamp_charges) + num(r.total_other_charges) + num(r.total_ipft_charges)
}

// Turn Angel's nested realised_profit into flat per-symbol rows plus the totals
// and per-segment rollups the ROI tracker renders. short_term + long_term is
// already NET of charges (verified: gross - charges), so ROI = net / invested.
function computeRoi(payload) {
  const raw = payload?.response?.realised_profit || payload?.realised_profit || []

  const symbols = raw.map((r) => {
    const buy = num(r.total_buy_value)
    const sell = num(r.total_sell_value)
    const charges = symbolCharges(r)
    const net = num(r.short_term) + num(r.long_term)
    return {
      symbol: r.trading_symbol || '—',
      segment: r.segment || 'OTHER',
      tradeType: r.trade_type || '',
      qty: num(r.total_qty),
      buy,
      sell,
      charges,
      gross: sell - buy,
      net,
      roi: buy ? (net / buy) * 100 : 0,
      shortTerm: num(r.short_term),
      longTerm: num(r.long_term),
    }
  })

  const acc = (key) => symbols.reduce((s, r) => s + r[key], 0)
  const invested = acc('buy')
  const net = acc('net')
  const wins = symbols.filter((s) => s.net > 0)
  const losses = symbols.filter((s) => s.net < 0)

  const segMap = new Map()
  symbols.forEach((s) => {
    const cur = segMap.get(s.segment) || { segment: s.segment, invested: 0, net: 0, charges: 0, count: 0 }
    cur.invested += s.buy
    cur.net += s.net
    cur.charges += s.charges
    cur.count += 1
    segMap.set(s.segment, cur)
  })
  const segments = [...segMap.values()]
    .map((seg) => ({ ...seg, roi: seg.invested ? (seg.net / seg.invested) * 100 : 0 }))
    .sort((a, b) => b.net - a.net)

  const best = symbols.reduce((b, s) => (b == null || s.net > b.net ? s : b), null)
  const worst = symbols.reduce((w, s) => (w == null || s.net < w.net ? s : w), null)

  return {
    symbols: symbols.sort((a, b) => b.net - a.net),
    segments,
    totals: {
      invested,
      soldValue: acc('sell'),
      charges: acc('charges'),
      net,
      gross: acc('gross'),
      roi: invested ? (net / invested) * 100 : 0,
      shortTerm: acc('shortTerm'),
      longTerm: acc('longTerm'),
      turnover: invested + acc('sell'),
      count: symbols.length,
      wins: wins.length,
      losses: losses.length,
      winRate: symbols.length ? (wins.length / symbols.length) * 100 : 0,
      best,
      worst,
    },
  }
}

function RoiTracker() {
  const [users, setUsers] = useState([])
  const [userId, setUserId] = useState('')
  const [configs, setConfigs] = useState([])
  const [configId, setConfigId] = useState('')
  const [configLoading, setConfigLoading] = useState(false)

  const [{ start, end }, setRange] = useState(defaultRange)
  const [segments, setSegments] = useState(SEGMENTS)

  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [needsToken, setNeedsToken] = useState(false)

  const selectedConfig = useMemo(
    () => configs.find((config) => String(config.id) === String(configId)),
    [configs, configId],
  )
  const isAngel = Boolean(selectedConfig) && isAngelBroker(selectedConfig.broker_name)
  const partyCode = isAngel ? String(selectedConfig.account_id || '').trim() : ''

  const roi = useMemo(() => (result ? computeRoi(result.data) : null), [result])

  useEffect(() => {
    let cancelled = false
    // Hydrate the Angel account store (creds + saved tokens) so we can read the
    // selected account's own login token when loading ROI.
    ensureAccountsLoaded()
    apiGet('/users/list.php')
      .then((res) => { if (!cancelled) setUsers(res.data || []) })
      .catch(() => { if (!cancelled) setUsers([]) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!userId) { setConfigs([]); setConfigId(''); return }
    let cancelled = false
    setConfigLoading(true)
    apiGet(`/users/broker-config/list.php?user_id=${userId}`)
      .then((res) => {
        if (cancelled) return
        const list = res.data || []
        setConfigs(list)
        setConfigId(String(list[0]?.id || ''))
      })
      .catch(() => { if (!cancelled) { setConfigs([]); setConfigId('') } })
      .finally(() => { if (!cancelled) setConfigLoading(false) })
    return () => { cancelled = true }
  }, [userId])

  useEffect(() => { setResult(null); setError(null); setNeedsToken(false) }, [configId, start, end])

  const toggleSegment = useCallback((seg) => {
    setSegments((current) => (
      current.includes(seg) ? current.filter((s) => s !== seg) : [...current, seg]
    ))
  }, [])

  const loadRoi = useCallback(async () => {
    if (!partyCode || !start || !end) return
    setLoading(true)
    setError(null)
    setNeedsToken(false)
    try {
      // Pull the token from THIS account's own Angel login rather than a server
      // env var - logging the account in if its session isn't live yet.
      let accessToken = getAngelClient(configId)?.session?.jwtToken || ''
      if (!accessToken) {
        try { await ensureSession(configId) } catch { /* fall through - backend falls back to env */ }
        accessToken = getAngelClient(configId)?.session?.jwtToken || ''
      }
      const res = await angelPosttradePnl({
        party_code: partyCode,
        start_date: start,
        end_date: end,
        segments: segments.length ? segments : SEGMENTS,
        access_token: accessToken,
      })
      setResult(res)
    } catch (err) {
      setError(err.message || 'Failed to load Angel P&L')
      setNeedsToken(Boolean(err.needsToken))
    } finally {
      setLoading(false)
    }
  }, [partyCode, start, end, segments, configId])

  const t = roi?.totals

  return (
    <div className="roi-tracker">
      {/* ── Command bar ─────────────────────────────────────────────────── */}
      <div className="roi-toolbar">
        <div className="roi-picker">
          <CompactSelect
            title="User"
            value={userId}
            onChange={setUserId}
            menuMinWidth={320}
            options={[
              { value: '', label: 'Select a user', meta: `${users.length} users` },
              ...users.map((user) => ({
                value: String(user.id),
                label: userLabel(user),
                meta: user.group_name || 'No group',
              })),
            ]}
          />
        </div>

        <div className="roi-picker account">
          <CompactSelect
            title="Account"
            value={configId}
            onChange={setConfigId}
            disabled={configLoading || !configs.length}
            menuMinWidth={320}
            options={configs.map((config) => ({
              value: String(config.id),
              label: config.account_id || `Account ${config.id}`,
              meta: config.broker_name || 'Broker',
            }))}
          />
        </div>

        <label className="roi-date">
          <span>From</span>
          <input type="date" value={start} max={end} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))} />
        </label>
        <label className="roi-date">
          <span>To</span>
          <input type="date" value={end} min={start} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))} />
        </label>

        <div className="roi-segments" role="group" aria-label="Segments">
          {SEGMENTS.map((seg) => (
            <button
              key={seg}
              type="button"
              className={`roi-segment ${segments.includes(seg) ? 'on' : ''}`}
              onClick={() => toggleSegment(seg)}
              aria-pressed={segments.includes(seg)}
            >
              {seg}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="roi-load-btn"
          onClick={loadRoi}
          disabled={loading || !isAngel || !partyCode}
        >
          <RefreshCw size={13} className={loading ? 'spin' : ''} />
          {loading ? 'Loading' : 'Load ROI'}
        </button>
      </div>

      {/* ── States ──────────────────────────────────────────────────────── */}
      {!selectedConfig && (
        <div className="roi-empty">
          <Radio size={18} />
          <p>Pick a user and one of their broker accounts to track ROI.</p>
        </div>
      )}

      {selectedConfig && !isAngel && (
        <div className="roi-empty">
          <span className="roi-empty-broker"><BrokerMark brokerName={selectedConfig.broker_name} /> {selectedConfig.broker_name}</span>
          <p>ROI tracking currently routes through Angel&apos;s post-trade API. Pick an Angel account to see its P&amp;L.</p>
        </div>
      )}

      {isAngel && (
        <div className="roi-account-head">
          <span className="roi-account-broker"><BrokerMark brokerName={selectedConfig.broker_name} /> {selectedConfig.broker_name}</span>
          <strong>{partyCode}</strong>
          <span className="roi-account-range">{start} &rarr; {end}</span>
        </div>
      )}

      {error && (
        <div className={`roi-notice ${needsToken ? 'warn' : 'error'}`}>
          <TriangleAlert size={16} />
          <div>
            <strong>{needsToken ? 'Angel session token needed' : 'Could not load P&L'}</strong>
            <p>{error}</p>
          </div>
        </div>
      )}

      {isAngel && !result && !error && !loading && (
        <div className="roi-empty subtle">
          <p>Set the date range and press <strong>Load ROI</strong> to pull realised P&amp;L for {partyCode}.</p>
        </div>
      )}

      {/* ── ROI report ──────────────────────────────────────────────────── */}
      {t && (
        <div className="roi-report">
          {/* Hero: ROI is the headline, then Net P&L, capital, charges. */}
          <div className="roi-hero">
            <div className={`roi-hero-card primary ${t.net >= 0 ? 'up' : 'down'}`}>
              <span className="roi-hero-label">Return on Capital</span>
              <strong className="roi-hero-value">{pct(t.roi)}</strong>
              <span className="roi-hero-sub">
                {t.net >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                {signed(t.net)} on ₹{money(t.invested, 0)} deployed
              </span>
            </div>
            <div className={`roi-hero-card ${t.net >= 0 ? 'up' : 'down'}`}>
              <span className="roi-hero-label">Net Realised P&amp;L</span>
              <strong className="roi-hero-value">{signed(t.net)}</strong>
              <span className="roi-hero-sub">Gross {signed(t.gross)}</span>
            </div>
            <div className="roi-hero-card">
              <span className="roi-hero-label">Capital Deployed</span>
              <strong className="roi-hero-value neutral">₹{money(t.invested, 0)}</strong>
              <span className="roi-hero-sub">Turnover ₹{money(t.turnover, 0)}</span>
            </div>
            <div className="roi-hero-card">
              <span className="roi-hero-label">Total Charges</span>
              <strong className="roi-hero-value charges">₹{money(t.charges)}</strong>
              <span className="roi-hero-sub">{t.invested ? ((t.charges / t.invested) * 100).toFixed(2) : '0.00'}% of capital</span>
            </div>
          </div>

          {/* Secondary KPI strip (fintech pattern: hairline-divided stats). */}
          <div className="roi-strip">
            <div className="roi-stat"><em>Short Term</em><b className={t.shortTerm >= 0 ? 'up' : 'down'}>{signed(t.shortTerm)}</b></div>
            <div className="roi-stat"><em>Long Term</em><b className={t.longTerm >= 0 ? 'up' : 'down'}>{signed(t.longTerm)}</b></div>
            <div className="roi-stat"><em>Win Rate</em><b>{t.winRate.toFixed(0)}%</b></div>
            <div className="roi-stat"><em>Wins / Losses</em><b>{t.wins} / {t.losses}</b></div>
            <div className="roi-stat"><em>Symbols</em><b>{t.count}</b></div>
            {t.best && <div className="roi-stat"><em>Top</em><b className="up" title={t.best.symbol}>{signed(t.best.net)}</b></div>}
            {t.worst && <div className="roi-stat"><em>Worst</em><b className="down" title={t.worst.symbol}>{signed(t.worst.net)}</b></div>}
          </div>

          {/* Per-segment ROI. */}
          {roi.segments.length > 0 && (
            <div className="roi-segblock">
              {roi.segments.map((seg) => {
                const share = t.invested ? (seg.invested / t.invested) * 100 : 0
                return (
                  <div className="roi-segcard" key={seg.segment}>
                    <div className="roi-segcard-head">
                      <span className="roi-segtag">{seg.segment}</span>
                      <strong className={seg.net >= 0 ? 'up' : 'down'}>{pct(seg.roi)}</strong>
                    </div>
                    <div className="roi-segcard-net">
                      <span className={seg.net >= 0 ? 'up' : 'down'}>{signed(seg.net)}</span>
                      <em>on ₹{money(seg.invested, 0)}</em>
                    </div>
                    <div className="roi-segbar"><span style={{ width: `${Math.max(2, share)}%` }} /></div>
                    <div className="roi-segcard-foot">{seg.count} symbols · {share.toFixed(0)}% of capital</div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Per-symbol table. */}
          <div className="roi-table-wrap">
            <table className="roi-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Segment</th>
                  <th className="num">Qty</th>
                  <th className="num">Invested</th>
                  <th className="num">Sold</th>
                  <th className="num">Charges</th>
                  <th className="num">Net P&amp;L</th>
                  <th className="num">ROI</th>
                </tr>
              </thead>
              <tbody>
                {roi.symbols.map((s, i) => (
                  <tr key={`${s.symbol}-${i}`}>
                    <td className="roi-sym" title={s.symbol}>{s.symbol}</td>
                    <td><span className="roi-segtag sm">{s.segment}</span></td>
                    <td className="num">{s.qty}</td>
                    <td className="num">₹{money(s.buy)}</td>
                    <td className="num">₹{money(s.sell)}</td>
                    <td className="num muted">₹{money(s.charges)}</td>
                    <td className={`num strong ${s.net >= 0 ? 'up' : 'down'}`}>{signed(s.net)}</td>
                    <td className={`num ${s.net >= 0 ? 'up' : 'down'}`}>{pct(s.roi)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

export default RoiTracker
