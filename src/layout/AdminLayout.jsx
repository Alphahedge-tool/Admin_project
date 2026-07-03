import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import AdminTopbar from '../components/AdminTopbar'
import AdminSidebar from '../components/AdminSidebar'
import EnterTrade from '../tradepanel/EnterTrade'

function AdminLayout({ admin }) {
  const location = useLocation()
  const isEnterTradeRoute = location.pathname === '/admin/trade-panel/enter-trade'
  const [keepEnterTrade, setKeepEnterTrade] = useState(isEnterTradeRoute)

  useEffect(() => {
    if (isEnterTradeRoute) setKeepEnterTrade(true)
  }, [isEnterTradeRoute])

  return (
    <div className="app-shell">
      <AdminTopbar
        admin={admin}
      />
      <div className="app-body">
        <AdminSidebar />
        <main className="app-main">
          {keepEnterTrade && (
            <div className="trade-panel-keepalive" style={{ display: isEnterTradeRoute ? 'block' : 'none' }}>
              <EnterTrade />
            </div>
          )}
          <div style={{ display: isEnterTradeRoute ? 'none' : 'block' }}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}

export default AdminLayout
