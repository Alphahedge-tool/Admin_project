import { useEffect, useRef, useState } from 'react'
import {
  Box,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  IconButton,
  Typography,
  Alert,
  Divider,
  Switch,
  CircularProgress
} from '@mui/material'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { apiGet, apiPost, angelAutoLogin } from '../../config/api'

/* ============ BROKER FIELD SCHEMAS ============
   Each broker only asks for the credentials its auto-login
   actually needs. Field `name` maps to the existing DB columns. */
const EMPTY_FORM = {
  broker_id: '',
  account_id: '',
  password: '',
  pin: '',
  totp_secret: '',
  app_name: '',
  app_key: ''
}

const DEFAULT_SCHEMA = {
  note: '',
  fields: [
    { name: 'account_id', label: 'Account ID' },
    { name: 'password', label: 'Password', type: 'password' },
    { name: 'pin', label: 'PIN' },
    { name: 'totp_secret', label: 'TOTP Secret' },
    { name: 'app_name', label: 'App Name' },
    { name: 'app_key', label: 'App Key' }
  ]
}

const BROKER_SCHEMAS = [
  {
    // Angel One SmartAPI auto-login: clientCode + pin + totpSecret + apiKey
    match: (name) => name.toLowerCase().replace(/\s/g, '').includes('angel'),
    autoLogin: true,
    note: 'Angel One auto-login needs these 4 fields. The TOTP code is generated automatically from the secret at login time.',
    fields: [
      {
        name: 'account_id',
        label: 'Client Code',
        required: true,
        helper: 'Angel One client code (login user ID)'
      },
      {
        name: 'pin',
        label: 'PIN',
        required: true,
        type: 'password',
        helper: 'Login PIN (used as SmartAPI password)'
      },
      {
        name: 'totp_secret',
        label: 'TOTP Secret',
        required: true,
        helper: 'Base32 secret from smartapi.angelbroking.com → Enable TOTP'
      },
      {
        name: 'app_key',
        label: 'API Key',
        required: true,
        helper: 'SmartAPI app API key (X-PrivateKey)'
      }
    ]
  }
]

const getBrokerSchema = (brokerName) => {
  if (!brokerName) return DEFAULT_SCHEMA
  return BROKER_SCHEMAS.find(s => s.match(brokerName)) || DEFAULT_SCHEMA
}

function BrokerConfigDialog({ user, open, onClose }) {
  /* ================= STATE ================= */
  const [configs, setConfigs] = useState([])
  const [brokers, setBrokers] = useState([])

  const [editing, setEditing] = useState(null)
  const [formOpen, setFormOpen] = useState(false)

  const [error, setError] = useState('')

  // Per-config auto-login state: { [cfgId]: { status, message, margin } }
  // status: 'idle' | 'loading' | 'on' | 'error'
  const [loginState, setLoginState] = useState({})

  const [form, setForm] = useState(EMPTY_FORM)
  const loadSeq = useRef(0)

  const selectedBroker = brokers.find(b => String(b.id) === String(form.broker_id))
  const schema = getBrokerSchema(selectedBroker?.name)

  /* ================= LOAD ================= */
  const clearUserState = () => {
    setConfigs([])
    setEditing(null)
    setFormOpen(false)
    setError('')
    setLoginState({})
    setForm(EMPTY_FORM)
  }

  const loadData = async (targetUser = user) => {
    if (!targetUser?.id) {
      clearUserState()
      return
    }

    const seq = ++loadSeq.current
    clearUserState()

    try {
      const [cfgRes, brokerRes] = await Promise.all([
        apiGet(`/users/broker-config/list.php?user_id=${targetUser.id}`),
        apiGet('/masters/brokers/list.php')
      ])

      if (seq !== loadSeq.current) return
      setConfigs(cfgRes.data || [])
      setBrokers(brokerRes.data || [])
    } catch (e) {
      if (seq !== loadSeq.current) return
      setError('Failed to load broker configurations')
    }
  }

  useEffect(() => {
    if (!open) {
      clearUserState()
      return
    }

    loadData(user)
  }, [open, user?.id])

  /* ================= HELPERS ================= */
  const handleChange = (field) => (e) => {
    setForm({ ...form, [field]: e.target.value })
  }

  const resetForm = () => {
    setForm(EMPTY_FORM)
    setEditing(null)
    setError('')
  }

  /* ================= ADD / EDIT ================= */
  const handleEdit = async (row) => {
        try {
            const res = await apiGet(`/users/broker-config/get.php?id=${row.id}`)

            setEditing(row)

            setForm({
            broker_id: res.data.broker_id,
            account_id: res.data.account_id || '',
            password: res.data.password || '',
            pin: res.data.pin || '',
            totp_secret: res.data.totp_secret || '',
            app_name: res.data.app_name || '',
            app_key: res.data.app_key || ''
            })

            setFormOpen(true)
        } catch {
            setError('Failed to load broker configuration')
        }
        }


  const handleSave = async () => {
    if (!user?.id) {
      setError('Select a user before saving broker configuration')
      return
    }

    if (!form.broker_id) {
      setError('Please select a broker')
      return
    }

    const missing = schema.fields.filter(
      f => f.required && !String(form[f.name] || '').trim()
    )
    if (missing.length > 0) {
      setError(`Required: ${missing.map(f => f.label).join(', ')}`)
      return
    }

    try {
      // Only send fields this broker uses; blank out the rest so
      // stale values from a previous broker selection aren't saved.
      const activeFields = new Set(schema.fields.map(f => f.name))
      const cleaned = { ...EMPTY_FORM, broker_id: form.broker_id }
      activeFields.forEach(name => { cleaned[name] = form[name] })

      const payload = {
        user_id: user.id,
        ...cleaned
      }

      if (editing) {
        await apiPost('/users/broker-config/update.php', {
          id: editing.id,
          ...payload
        })
      } else {
        await apiPost('/users/broker-config/create.php', payload)
      }

      setFormOpen(false)
      resetForm()
      loadData(user)
    } catch (e) {
      setError(e.message || 'Failed to save configuration')
    }
  }

  /* ================= AUTO LOGIN ================= */
  const sessionKey = (cfgId) => `angel_session_${cfgId}`

  const setCfgLogin = (cfgId, state) => {
    setLoginState(prev => ({ ...prev, [cfgId]: state }))
  }

  const handleLoginToggle = async (cfg) => {
    const current = loginState[cfg.id]

    // Turn OFF → drop the saved session
    if (current?.status === 'on') {
      localStorage.removeItem(sessionKey(cfg.id))
      setCfgLogin(cfg.id, { status: 'idle' })
      return
    }

    // Turn ON → fetch credentials, then auto-login via the Angel Go backend
    setCfgLogin(cfg.id, { status: 'loading' })
    try {
      const res = await apiGet(`/users/broker-config/get.php?id=${cfg.id}`)
      const c = res.data

      if (!c.account_id || !c.app_key || !c.pin || !c.totp_secret) {
        throw new Error('Missing credentials — edit this config and fill Client Code, PIN, TOTP Secret and API Key')
      }

      // Reuse a previously saved session if we have one (backend validates it
      // with getRMS and falls back to a fresh TOTP login automatically).
      let session = null
      try {
        session = JSON.parse(localStorage.getItem(sessionKey(cfg.id)))
      } catch { /* ignore corrupt session */ }

      const data = await angelAutoLogin({
        clientCode: c.account_id,
        apiKey: c.app_key,
        pin: c.pin,
        totpSecret: c.totp_secret,
        session
      })

      if (data.session) {
        localStorage.setItem(sessionKey(cfg.id), JSON.stringify(data.session))
      }

      setCfgLogin(cfg.id, {
        status: 'on',
        message: data.sessionSource === 'session' ? 'Logged in (session reused)' : 'Logged in (fresh TOTP login)',
        margin: data.availableMargin
      })
    } catch (e) {
      setCfgLogin(cfg.id, { status: 'error', message: e.message })
    }
  }

  /* ================= DELETE ================= */
  const handleDelete = async (row) => {
    if (!window.confirm('Delete this broker configuration?')) return

    await apiPost('/users/broker-config/delete.php', { id: row.id })
    loadData(user)
  }

  /* ================= RENDER ================= */
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        Broker Configuration{user ? ` - ${user.username}` : ''}
      </DialogTitle>

      <DialogContent>
        {error && <Alert severity="error">{error}</Alert>}

        {/* LIST */}
        <Box sx={{ mb: 2 }}>
          {configs.length === 0 && (
            <Typography color="text.secondary">
              No broker configured for this user.
            </Typography>
          )}

          {configs.map(cfg => {
            const cfgSchema = getBrokerSchema(cfg.broker_name)
            const login = loginState[cfg.id] || { status: 'idle' }

            return (
              <Box
                key={cfg.id}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  py: 1
                }}
              >
                <Box>
                  <Typography fontWeight={600}>
                    {cfg.broker_name}
                  </Typography>
                  <Typography fontSize="0.8rem" color="text.secondary">
                    Account: {cfg.account_id ? '••••••' : '—'}
                  </Typography>

                  {/* LOGIN STATUS LINE */}
                  {login.status === 'on' && (
                    <Typography fontSize="0.8rem" color="success.main">
                      ✓ {login.message}
                      {login.margin != null && ` — Margin: ₹${Number(login.margin).toLocaleString('en-IN')}`}
                    </Typography>
                  )}
                  {login.status === 'error' && (
                    <Typography fontSize="0.8rem" color="error.main">
                      ✗ {login.message}
                    </Typography>
                  )}
                  {login.status === 'loading' && (
                    <Typography fontSize="0.8rem" color="text.secondary">
                      Logging in…
                    </Typography>
                  )}
                </Box>

                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  {/* AUTO-LOGIN SWITCH (brokers that support it) */}
                  {cfgSchema.autoLogin && (
                    login.status === 'loading' ? (
                      <CircularProgress size={20} sx={{ mx: 1.5 }} />
                    ) : (
                      <Switch
                        size="small"
                        checked={login.status === 'on'}
                        onChange={() => handleLoginToggle(cfg)}
                      />
                    )
                  )}

                  <IconButton size="small" onClick={() => handleEdit(cfg)}>
                    <Pencil size={15} />
                  </IconButton>
                  <IconButton size="small" onClick={() => handleDelete(cfg)}>
                    <Trash2 size={15} />
                  </IconButton>
                </Box>
              </Box>
            )
          })}
        </Box>

        <Divider />

        {/* ADD BUTTON */}
        <Box sx={{ mt: 2 }}>
          <Button
            startIcon={<Plus size={15} />}
            onClick={() => {
              resetForm()
              setFormOpen(true)
            }}
          >
            Add Broker
          </Button>
        </Box>

        {/* FORM */}
       {formOpen && (
            <Box sx={{ mt: 2 }}>
                <Typography fontWeight={600} mb={2}>
                {editing ? 'Edit Broker Config' : 'Add Broker Config'}
                </Typography>

                {/* Broker selector */}
                <FormControl fullWidth margin="normal">
                <InputLabel>Broker</InputLabel>
                <Select
                    label="Broker"
                    value={form.broker_id}
                    onChange={handleChange('broker_id')}
                >
                    {brokers.map(b => (
                    <MenuItem key={b.id} value={b.id}>
                        {b.name}
                    </MenuItem>
                    ))}
                </Select>
                </FormControl>

                {/* BROKER-SPECIFIC NOTE */}
                {form.broker_id && schema.note && (
                <Alert severity="info" sx={{ mt: 1 }}>
                    {schema.note}
                </Alert>
                )}

                {/* BROKER-SPECIFIC FIELDS (2 per row) */}
                {form.broker_id && schema.fields.map((field, i) => (
                i % 2 === 0 ? (
                    <Box key={field.name} sx={{ display: 'flex', gap: 2 }}>
                    {[field, schema.fields[i + 1]].filter(Boolean).map(f => (
                        <TextField
                        key={f.name}
                        fullWidth
                        required={!!f.required}
                        label={f.label}
                        type={f.type || 'text'}
                        margin="normal"
                        helperText={f.helper || ''}
                        value={form[f.name]}
                        onChange={handleChange(f.name)}
                        />
                    ))}
                    </Box>
                ) : null
                ))}

                {!form.broker_id && (
                <Typography color="text.secondary" sx={{ mt: 2 }}>
                    Select a broker to see the required credentials.
                </Typography>
                )}

                {/* ACTIONS */}
                <Box sx={{ mt: 2 }}>
                <Button variant="contained" onClick={handleSave}>
                    Save
                </Button>
                <Button sx={{ ml: 1 }} onClick={() => setFormOpen(false)}>
                    Cancel
                </Button>
                </Box>
            </Box>
            )}


      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}

export default BrokerConfigDialog
