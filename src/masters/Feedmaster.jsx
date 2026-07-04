import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Typography,
} from '@mui/material'
import { CheckCircle2, PlugZap, Save } from 'lucide-react'
import { apiGet } from '../config/api'
import {
  BROKERS,
  buildAngelClient,
  clearFeedMaster,
  getSavedFeedMaster,
  getSavedSession,
  isAngelBroker,
  loginAngelClient,
  saveFeedMaster,
  saveSession,
} from '../feedmaster/feedMasterStore'

function Feedmaster() {
  const [users, setUsers] = useState([])
  const [configs, setConfigs] = useState([])
  const [broker, setBroker] = useState('angelone')
  const [userId, setUserId] = useState('')
  const [configId, setConfigId] = useState('')
  const [loading, setLoading] = useState(true)
  const [configLoading, setConfigLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  const selectedUser = users.find((user) => String(user.id) === String(userId))
  const selectedConfig = configs.find((config) => String(config.id) === String(configId))
  const canSave = broker === 'angelone' && userId && configId

  useEffect(() => {
    let cancelled = false

    async function loadUsers() {
      setLoading(true)
      setError('')
      try {
        const saved = getSavedFeedMaster()
        const res = await apiGet('/users/list.php')
        if (cancelled) return

        const list = res.data || []
        setUsers(list)
        setBroker(saved?.broker || 'angelone')
        setUserId(saved?.userId ? String(saved.userId) : String(list[0]?.id || ''))
        setConfigId(saved?.configId ? String(saved.configId) : '')
        setStatus(saved?.configId ? 'Saved Feedmaster loaded' : 'Select the Angel One account for live feed')
      } catch (loadError) {
        if (!cancelled) setError(loadError.message || 'Failed to load users')
      } finally {
        if (!cancelled) setLoading(false)
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
      if (!userId || broker !== 'angelone') {
        setConfigs([])
        setConfigId('')
        return
      }

      setConfigLoading(true)
      setError('')
      try {
        const saved = getSavedFeedMaster()
        const res = await apiGet(`/users/broker-config/list.php?user_id=${userId}`)
        if (cancelled) return

        const angelConfigs = (res.data || []).filter((config) => isAngelBroker(config.broker_name))
        setConfigs(angelConfigs)
        if (saved?.userId && String(saved.userId) === String(userId) && saved?.configId) {
          setConfigId(String(saved.configId))
        } else {
          setConfigId(String(angelConfigs[0]?.id || ''))
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError.message || 'Failed to load Angel One accounts')
      } finally {
        if (!cancelled) setConfigLoading(false)
      }
    }

    loadConfigs()
    return () => {
      cancelled = true
    }
  }, [broker, userId])

  const savedLabel = useMemo(() => {
    const saved = getSavedFeedMaster()
    if (!saved?.configId) return 'No account saved yet'
    const user = users.find((item) => String(item.id) === String(saved.userId))
    const config = configs.find((item) => String(item.id) === String(saved.configId))
    return `${user?.username || 'Selected user'} - ${config?.account_id || `Config ${saved.configId}`}`
  }, [users, configs, status])

  const saveSelection = () => {
    if (!canSave) {
      setError('Select an Angel One account first')
      return
    }

    saveFeedMaster({
      broker,
      userId,
      configId,
      accountId: selectedConfig?.account_id || '',
    })
    setError('')
    setStatus('Feedmaster account saved')
  }

  const testLogin = async () => {
    if (!canSave) {
      setError('Select an Angel One account first')
      return
    }

    setError('')
    setStatus('Logging in Feedmaster...')
    try {
      const res = await apiGet(`/users/broker-config/get.php?id=${configId}`)
      const client = buildAngelClient(res.data || {}, selectedUser, getSavedSession(configId))
      if (!client) {
        throw new Error('Selected account is missing Client Code, PIN, TOTP Secret or API Key')
      }

      const login = await loginAngelClient(client)
      if (login.session) saveSession(configId, login.session)
      saveSelection()
      setStatus(login.sessionSource === 'session' ? 'Feedmaster live - saved session reused' : 'Feedmaster live - fresh login saved')
    } catch (loginError) {
      setError(loginError.message || 'Feedmaster login failed')
      setStatus('')
    }
  }

  const clearSelection = () => {
    clearFeedMaster()
    setConfigId('')
    setStatus('Feedmaster cleared')
    setError('')
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Box>
          <Typography variant="h5" fontWeight={600}>
            Feedmaster
          </Typography>
          <Typography color="text.secondary" fontSize="0.875rem">
            Choose the broker account that provides the shared live websocket feed.
          </Typography>
        </Box>
      </Box>

      <Paper sx={{ p: 2, maxWidth: 760 }}>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {status && !error && <Alert severity="info" sx={{ mb: 2 }}>{status}</Alert>}

        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
          <FormControl fullWidth disabled={loading}>
            <InputLabel>Broker</InputLabel>
            <Select label="Broker" value={broker} onChange={(event) => setBroker(event.target.value)}>
              {BROKERS.map((item) => (
                <MenuItem key={item.id} value={item.id}>{item.label}</MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl fullWidth disabled={loading}>
            <InputLabel>User</InputLabel>
            <Select label="User" value={userId} onChange={(event) => setUserId(event.target.value)}>
              {users.map((user) => (
                <MenuItem key={user.id} value={String(user.id)}>
                  {user.username || `${user.first_name || ''} ${user.last_name || ''}`.trim() || `User ${user.id}`}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl fullWidth disabled={configLoading || !configs.length} sx={{ gridColumn: { md: '1 / -1' } }}>
            <InputLabel>Angel One Account</InputLabel>
            <Select label="Angel One Account" value={configId} onChange={(event) => setConfigId(event.target.value)}>
              {configs.map((config) => (
                <MenuItem key={config.id} value={String(config.id)}>
                  {config.broker_name} - {config.account_id || config.id}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>

        <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
          <Button variant="contained" startIcon={<Save size={16} />} disabled={!canSave} onClick={saveSelection}>
            Save Feedmaster
          </Button>
          <Button variant="outlined" startIcon={<PlugZap size={16} />} disabled={!canSave} onClick={testLogin}>
            Test Login
          </Button>
          <Button color="error" onClick={clearSelection}>
            Clear
          </Button>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2, color: 'text.secondary' }}>
          <CheckCircle2 size={16} />
          <Typography fontSize="0.875rem">Current Feedmaster: {savedLabel}</Typography>
        </Box>
      </Paper>
    </Box>
  )
}

export default Feedmaster
