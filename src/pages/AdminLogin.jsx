import { useState } from 'react'
import {
  Box,
  Paper,
  TextField,
  Button,
  Typography,
  CircularProgress
} from '@mui/material'
import { ShieldCheck } from 'lucide-react'
import { apiPost } from '../config/api'

function AdminLogin({ onSuccess }) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('12345')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const login = async (e) => {
    // 🔥 CRITICAL: stop any form / page reload
    if (e) e.preventDefault()

    setError('')
    setLoading(true)
    console.log('LOGIN CLICKED')

    try {
      const res = await apiPost('/auth/login.php', {
        username,
        password
      })

      if (!res || !res.success) {
        setError(res?.message || 'Invalid credentials')
        setLoading(false)
        return
      }

      // ✅ Auth success
      onSuccess(res)
    } catch (err) {
      console.error(err)
      setError('Unable to connect to server')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--ao-bg)'
      }}
    >
      <Paper
        sx={{
          width: 400,
          p: 3,
          border: '1px solid var(--ao-border-soft)'
        }}
      >
        {/* FORM — explicitly controlled */}
        <Box component="form" onSubmit={login}>
          <Box
            sx={{
              width: 38,
              height: 38,
              mx: 'auto',
              mb: 1.5,
              borderRadius: 1.5,
              display: 'grid',
              placeItems: 'center',
              bgcolor: 'primary.light',
              color: 'primary.main'
            }}
          >
            <ShieldCheck size={20} />
          </Box>
          <Typography
            variant="h5"
            sx={{
              mb: 0.5,
              textAlign: 'center',
              fontWeight: 800
            }}
          >
            STACKWEALTH Admin
          </Typography>
          <Typography sx={{ mb: 3, textAlign: 'center', color: 'text.secondary', fontSize: '0.8125rem', fontWeight: 600 }}>
            Sign in to manage users, balances and trading tools
          </Typography>

          <TextField
            fullWidth
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            sx={{ mb: 2 }}
            autoFocus
          />

          <TextField
            fullWidth
            type="password"
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            sx={{ mb: 3 }}
          />

          {error && (
            <Typography
              sx={{
                color: '#dc2626',
                fontSize: '0.85rem',
                mb: 2,
                textAlign: 'center'
              }}
            >
              {error}
            </Typography>
          )}

          <Button
            type="submit"     // ✅ controlled submit
            fullWidth
            variant="contained"
            size="large"
            disabled={loading}
          >
            {loading ? <CircularProgress size={22} /> : 'Login'}
          </Button>
        </Box>
      </Paper>
    </Box>
  )
}

export default AdminLogin
