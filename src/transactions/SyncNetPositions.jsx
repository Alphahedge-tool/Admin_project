import { useState } from 'react'
import {
  Box,
  Typography,
  Paper,
  Button,
  Divider
} from '@mui/material'
import { apiPost } from '../config/api'

function SyncNetPositions() {
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState([])
  const [summary, setSummary] = useState(null)

  const startSync = async () => {
    setRunning(true)
    setLog([])
    setSummary(null)

    try {
      const res = await apiPost('/transactions/sync-net-positions.php', {
        live: true
      })

      setSummary(res.summary)
      setLog(res.log || [])
    } catch (e) {
      setLog(prev => [...prev, '❌ Sync failed'])
    } finally {
      setRunning(false)
    }
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Typography variant="h5" fontWeight={600} mb={2}>
        Sync Net Positions
      </Typography>

      <Paper sx={{ p: 3, maxWidth: 700 }}>
        <Typography fontSize="0.9rem" color="text.secondary">
          This will sync net positions for all active Angel accounts.
        </Typography>

        <Divider sx={{ my: 2 }} />

        <Button
          variant="contained"
          disabled={running}
          onClick={startSync}
        >
          {running ? 'Syncing…' : 'Start Sync'}
        </Button>

        {/* STATUS */}
        {running && (
          <Typography sx={{ mt: 2 }} color="primary">
            🔄 Syncing records…
          </Typography>
        )}

        {/* SUMMARY */}
        {summary && (
          <Box sx={{ mt: 3 }}>
            <Typography fontWeight={600}>
              Total Active Accounts: {summary.total_accounts}
            </Typography>
            <Typography fontSize="0.9rem" color="green">
              Successfully Synced: {summary.success}
            </Typography>
            <Typography fontSize="0.9rem" color="red">
              Failed: {summary.failed}
            </Typography>
          </Box>
        )}

        {/* LIVE LOG */}
        {log.length > 0 && (
          <Box sx={{ mt: 3 }}>
            <Typography fontWeight={600} mb={1}>
              Sync Log
            </Typography>

            <Paper
              variant="outlined"
              sx={{
                p: 2,
                maxHeight: 300,
                overflowY: 'auto',
                background: '#f9fafb'
              }}
            >
              {log.map((l, i) => (
                <Typography
                  key={i}
                  fontSize="0.8rem"
                  sx={{ mb: 0.5 }}
                >
                  {l}
                </Typography>
              ))}
            </Paper>
          </Box>
        )}
      </Paper>
    </Box>
  )
}

export default SyncNetPositions
