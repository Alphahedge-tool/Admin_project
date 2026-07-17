// Trade Panel shell for the admin app's nested routes (Enter Trade / Get
// Position / Get OrderBook / Get TradeBook). The sidebar already provides
// the tab-like navigation between these four - what this component changes
// is that switching between them no longer unmounts/remounts the target
// page. Previously each was its own <Route element={...}>, so React Router
// tore the whole component down and rebuilt it from scratch on every click:
// re-fetching users, broker configs, credentials, and re-opening the live
// feed/order-stream connections, even though the account rarely changed.
//
// Here all four are mounted once, permanently, and only the active one is
// shown (via the `hidden` attribute) - the others stay alive in the
// background with their state and connections intact, so switching back to
// one is instant.
import { Navigate, useLocation } from 'react-router-dom'
import GetPositions from './GetPositions'
import GetOrderBook from './GetOrderBook'
import GetTradeBook from './GetTradeBook'
import ClientDashboard from './ClientDashboard'

const TAB_PATHS = {
  'enter-trade': '/admin/trade-panel/enter-trade',
  'client-dashboard': '/admin/trade-panel/client-dashboard',
  positions: '/admin/trade-panel/positions',
  'order-book': '/admin/trade-panel/order-book',
  'trade-book': '/admin/trade-panel/trade-book',
}

function activeTabFromPath(pathname) {
  return Object.keys(TAB_PATHS).find((key) => pathname.startsWith(TAB_PATHS[key])) || null
}

export default function TradePanelTabs() {
  const location = useLocation()
  const activeTab = activeTabFromPath(location.pathname)

  // Bare "/admin/trade-panel" (no sub-page) - same redirect the old routes did.
  if (!activeTab) {
    return <Navigate to={TAB_PATHS['enter-trade']} replace />
  }

  return (
    <div className="trade-panel-tabs">
      <div className="trade-panel-tab" hidden={activeTab !== 'enter-trade'}>
        {/* Enter Trade isn't wired up in the admin yet (matches the
            previous element={null} route) */}
      </div>
      <div className="trade-panel-tab" hidden={activeTab !== 'client-dashboard'}>
        {/* `active` gates the per-strategy margin fetch: every tab is mounted at
            once, so without it the dashboard would price (and log in) every
            account the moment any Trade Panel tab is opened. */}
        <ClientDashboard active={activeTab === 'client-dashboard'} />
      </div>
      <div className="trade-panel-tab" hidden={activeTab !== 'positions'}>
        <GetPositions />
      </div>
      <div className="trade-panel-tab" hidden={activeTab !== 'order-book'}>
        <GetOrderBook />
      </div>
      <div className="trade-panel-tab" hidden={activeTab !== 'trade-book'}>
        <GetTradeBook />
      </div>
    </div>
  )
}
