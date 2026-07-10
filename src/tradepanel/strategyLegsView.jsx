import { Check } from 'lucide-react'
import { compactProductTag, parseTradingSymbol } from './symbolParse'
import { legIsClosed, money } from './legFormat'

// Shared strategy-leg rendering used by both Sync Net Positions and the Client
// Dashboard so the two pages stay pixel-identical: the same compact rows, the
// same Normal-view table (Stock Name / Product Type / Net Qty. / Buy Avg /
// Sell Avg / LTP / P&L headers) and the same Buy/Sell split.

function priceCell(value, strong = false, dir = '') {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n === 0) return <span className="position-price-muted">-</span>
  const cls = strong ? 'position-price ltp' : 'position-price'
  return <span className={`${cls}${dir ? ` flash-${dir}` : ''}`} key={dir ? `${n}-${dir}` : undefined}>{money(n)}</span>
}

function legExitPrice(leg) {
  return Number(leg.exit_price || leg.exitPrice || leg.close_price || leg.closePrice || 0)
}

function exitPriceCell(leg) {
  const exit = legExitPrice(leg)
  if (!legIsClosed(leg) || !exit) return priceCell(leg.ltp, true, leg.liveDir)
  return (
    <span className="strategy-exit-price">
      <span>Exit</span>{money(exit)}
    </span>
  )
}

function legEntryDate(leg) {
  const raw = leg.created_at || leg.createdAt
  if (!raw) return null
  const date = new Date(String(raw).replace(' ', 'T'))
  return Number.isNaN(date.getTime()) ? null : date
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
}

function EntryDateTag({ leg }) {
  const date = legEntryDate(leg)
  if (!date) return null
  const today = isSameDay(date, new Date())
  const label = today ? 'Today' : date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
  return <span className={`leg-entry-tag ${today ? 'is-today' : 'is-carried'}`}>{label}</span>
}

function LegCheckbox({ leg, selection }) {
  if (!selection) return null
  const selected = selection.selectedKeys.has(leg.id)
  return (
    <button
      className={`position-row-check${selected ? ' checked' : ''}`}
      type="button"
      aria-pressed={selected}
      aria-label={`${selected ? 'Unselect' : 'Select'} ${leg.trading_symbol}`}
      onClick={(event) => {
        event.stopPropagation()
        selection.onToggle(leg.id)
      }}
    >
      {selected && <Check size={12} strokeWidth={3} />}
    </button>
  )
}

export function CompactLegs({ legs, selection }) {
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
              <LegCheckbox leg={leg} selection={selection} />
              <strong>{parsed.root}</strong>
              {parsed.strike && <span className="position-strike">{parsed.strike}</span>}
              {parsed.optionType && <span className={`book-tag option ${parsed.optionType.toLowerCase()}`}>{parsed.optionType}</span>}
              <EntryDateTag leg={leg} />
              {closed ? <span className="strategy-closed-tag">Closed</span> : <span className="strategy-open-tag">Open</span>}
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

export function LegsTable({ legs, title, selection }) {
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
                      <LegCheckbox leg={leg} selection={selection} />
                      <strong>{parsed.root}</strong>
                      {parsed.expiry && <span className="position-expiry">{parsed.expiry}</span>}
                      {parsed.strike && <span className="position-strike">{parsed.strike}</span>}
                      {parsed.optionType && <span className={`book-tag option ${parsed.optionType.toLowerCase()}`}>{parsed.optionType}</span>}
                      {leg.exchange && <span className="book-tag exchange">{leg.exchange}</span>}
                      <EntryDateTag leg={leg} />
                      {closed ? <span className="strategy-closed-tag">Closed</span> : <span className="strategy-open-tag">Open</span>}
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
