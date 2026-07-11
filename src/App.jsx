import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate  } from 'react-router-dom'
import { Alert, Snackbar } from '@mui/material'

import AdminLogin from './pages/AdminLogin'
import AdminLayout from './layout/AdminLayout'
import AdminDashboard from './pages/AdminDashboard'
import UsersPage from './pages/UsersPage'
import BrokerMaster from './masters/BrokerMaster'
import GroupMaster from './masters/GroupMaster'
import Feedmaster from './masters/Feedmaster'
import UserBalances from './transactions/UserBalances'
import SyncNetPositions from './transactions/SyncNetPositions'
import { apiGet } from './config/api'
import NetPositionsReport from './pages/NetPositionsReport'
import TradePanelTabs from './tradepanel/TradePanelTabs'
import TradePanelStandalone from './tradepanel/TradePanelStandalone'
import StartupGate from './startup/StartupGate'


function App() {
  const [loading, setLoading] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [admin, setAdmin] = useState(null)
  const [toast, setToast] = useState({ open: false, message: '' })


  useEffect(() => {
    apiGet('/auth/me.php')
      .then(data => {
        setAuthenticated(data.authenticated === true)
        setAdmin(data.admin || data.user || data.data || null)
        setLoading(false)
      })
      .catch(() => {
        setAuthenticated(false)
        setLoading(false)
      })
  }, [])

  if (loading) return null

  if (!authenticated) {
    return <AdminLogin onSuccess={(data) => {
      setAuthenticated(true)
      setAdmin(data?.admin || data?.user || data?.data || null)
      const name = data?.admin?.username || data?.user?.username || data?.username || 'User'
      setToast({ open: true, message: `${name} logged in successfully` })
    }} />
  }

  // Nothing renders until every Angel account has been logged in (tokens saved)
  // and the Feedmaster is set - see StartupGate.
  return (
    <StartupGate>
    <BrowserRouter>
      <Snackbar
        open={toast.open}
        autoHideDuration={3000}
        onClose={() => setToast({ open: false, message: '' })}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Alert
          severity="success"
          variant="filled"
          onClose={() => setToast({ open: false, message: '' })}
          sx={{ borderRadius: 1, fontWeight: 700 }}
        >
          {toast.message}
        </Alert>
      </Snackbar>
          <Routes>
                  {/* DEFAULT ROOT REDIRECT */}
            <Route path="/" element={<Navigate to="/admin" replace />} />
            <Route path="/admin/trade-panel/standalone" element={<TradePanelStandalone />} />

            {/* ADMIN ROUTES */}
            <Route path="/admin" element={<AdminLayout admin={admin} />}>
              <Route index element={<AdminDashboard />} />
              <Route path="users" element={<UsersPage />} />
              <Route path="masters/brokers" element={<BrokerMaster />} />
              <Route path="masters/groups" element={<GroupMaster />} />
              <Route path="masters/feedmaster" element={<Feedmaster />} />
               <Route path="transactions/user-balances" element={<UserBalances />} />
               <Route path="transactions/sync-net-positions" element={<SyncNetPositions />}/>

               {/* TRADE PANEL - one persistent element for all four tabs, so
                   switching between them never unmounts/re-fetches (see
                   TradePanelTabs.jsx) */}
               <Route path="trade-panel/*" element={<TradePanelTabs />} />
            </Route>

            {/* FALLBACK (OPTIONAL) */}
            <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </BrowserRouter>
    </StartupGate>
  )
}

export default App
