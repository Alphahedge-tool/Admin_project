import { useEffect, useState } from 'react'
import {
  Box,
  Typography,
  Paper,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem
} from '@mui/material'
import DataTable from '../components/common/DataTable'
import { apiGet } from '../config/api'

function NetPositionsReport() {

  const [users, setUsers] = useState([])
  const [selectedUser, setSelectedUser] = useState('all')
  const [rows, setRows] = useState([])
  const [totalPnl, setTotalPnl] = useState(0)
  const [loading, setLoading] = useState(false)

  /* ================= LOAD USERS ================= */

  const loadUsers = async () => {
    const res = await apiGet('/users/list.php')
    setUsers(res.data)
  }

  /* ================= LOAD REPORT ================= */

  const loadReport = async (userId = 'all') => {
    setLoading(true)
    try {
      const res = await apiGet(
        `/reports/net-positions-report.php?user_id=${userId}`
      )

      setRows(res.data || [])
      setTotalPnl(res.total_net_pnl || 0)

    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadUsers()
    loadReport('all')
  }, [])

  /* ================= TABLE CONFIG ================= */

  const columns = [
    {
      field: 'user',
      label: 'User',
      sortable: true,
      hide: selectedUser !== 'all'
    },
    { field: 'symbol', label: 'Symbol', sortable: true },
    { field: 'underlying', label: 'Underlying', sortable: true },
    { field: 'expiry', label: 'Expiry', sortable: true },
    { field: 'type', label: 'CE/PE', sortable: true },

    {
      field: 'buy_qty',
      label: 'Buy Qty',
      align: 'right',
      render: (row) => (
        <Typography color="success.main" fontWeight={600}>
          {row.buy_qty || ''}
        </Typography>
      )
    },
    {
      field: 'sell_qty',
      label: 'Sell Qty',
      align: 'right',
      render: (row) => (
        <Typography color="error.main" fontWeight={600}>
          {row.sell_qty || ''}
        </Typography>
      )
    },

    {
      field: 'avg_price',
      label: 'Avg Price',
      align: 'right',
      sortable: true
    },
    {
      field: 'ltp',
      label: 'LTP',
      align: 'right',
      sortable: true
    },
    {
      field: 'net_pnl',
      label: 'Net PnL',
      align: 'right',
      sortable: true,
      render: (row) => (
        <Typography
          fontWeight={700}
          color={row.net_pnl >= 0 ? 'success.main' : 'error.main'}
        >
          {row.net_pnl.toFixed(2)}
        </Typography>
      )
    }
  ]

  /* ================= RENDER ================= */

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>

      {/* HEADER */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h5" fontWeight={600}>
          Net Positions Report
        </Typography>

        <Box sx={{ display: 'flex', gap: 2 }}>

          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel>User</InputLabel>
            <Select
              value={selectedUser}
              label="User"
              onChange={(e) => {
                setSelectedUser(e.target.value)
                loadReport(e.target.value)
              }}
            >
              <MenuItem value="all">All Users</MenuItem>
              {users.map(u => (
                <MenuItem key={u.id} value={u.id}>
                  {u.username}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Button
            variant="contained"
            onClick={() => loadReport(selectedUser)}
          >
            Refresh
          </Button>

        </Box>
      </Box>

      {/* TOTAL SUMMARY */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="h6">
          Total Net PnL:
          <Typography
            component="span"
            ml={1}
            fontWeight={700}
            color={totalPnl >= 0 ? 'success.main' : 'error.main'}
          >
            ₹ {totalPnl.toFixed(2)}
          </Typography>
        </Typography>
      </Paper>

      {/* TABLE */}
      <Paper sx={{ flex: 1, p: 2 }}>
        <DataTable
          columns={columns}
          rows={rows}
          loading={loading}
          pageSize={10}
        />
      </Paper>

    </Box>
  )
}

export default NetPositionsReport
