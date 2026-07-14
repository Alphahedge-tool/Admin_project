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
import { apiGet, apiPost, brokerAutoLogin, zerodhaLoginStart, zerodhaLoginUrl } from '../../config/api'
import { clearSession, getSavedSession, refreshBrokerAccounts, saveSession } from '../../feedmaster/angelSessionStore'

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
  app_key: '',
  app_secret: '',
  phone: ''
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

const FALLBACK_BROKERS = [
  { id: '__zerodha__', name: 'Zerodha', synthetic: true },
]

/* Each broker names the SAME columns differently — Angel's "Client Code" is
   Kotak's "UCC", Angel's "PIN" is Kotak's "MPIN" — so the schema carries the
   label the broker's own portal uses. `broker` is the backend's auto-login
   path. Order here is the order the fields appear in the form. */
const BROKER_SCHEMAS = [
  {
    // Angel One SmartAPI auto-login: clientCode + pin + totpSecret + apiKey
    match: (name) => name.toLowerCase().replace(/\s/g, '').includes('angel'),
    autoLogin: true,
    broker: 'angel',
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
  },
  {
    // Zerodha Kite Connect needs the browser login redirect to mint a
    // request_token, then the backend exchanges it for an access_token.
    match: (name) => name.toLowerCase().replace(/\s/g, '').includes('zerodha')
      || name.toLowerCase().replace(/\s/g, '').includes('kite'),
    autoLogin: false,
    broker: 'zerodha',
    note: 'Zerodha Kite Connect does not support a fully headless login. Save the API credentials here, then complete the browser login flow so the backend can exchange the request token for an access token.',
    fields: [
      {
        name: 'account_id',
        label: 'User ID',
        required: true,
        helper: 'Your Zerodha user ID'
      },
      {
        name: 'app_key',
        label: 'API Key',
        required: true,
        helper: 'Kite Connect developer app key'
      },
      {
        name: 'app_secret',
        label: 'API Secret',
        required: true,
        type: 'password',
        helper: 'Kite Connect developer app secret'
      },
      {
        name: 'password',
        label: 'Password',
        required: true,
        type: 'password',
        helper: 'Zerodha account password'
      },
      {
        name: 'totp_secret',
        label: 'TOTP Secret',
        required: true,
        helper: 'Base32 TOTP secret enabled for the account'
      }
    ]
  },
  {
    // Kotak Neo logs in headlessly like Angel, but in two steps: the mobile +
    // UCC + TOTP get a view token, then the MPIN upgrades it to a trade token.
    // All five fields are needed - the login fails without any one of them.
    match: (name) => name.toLowerCase().replace(/\s/g, '').includes('kotak'),
    autoLogin: true,
    broker: 'kotak',
    note: 'Kotak Neo auto-login needs all 5 fields. The TOTP code is generated from the secret at login time; the MPIN is what upgrades the login into a trading session.',
    fields: [
      {
        name: 'account_id',
        label: 'UCC (Client Code)',
        required: true,
        helper: 'Kotak Unique Client Code'
      },
      {
        name: 'phone',
        label: 'Mobile Number',
        required: true,
        helper: 'Registered mobile, with country code (e.g. +919876543210)'
      },
      {
        name: 'app_secret',
        label: 'Access Token',
        required: true,
        type: 'password',
        helper: 'Long access token from the Kotak Neo API portal (napi.kotaksecurities.com)'
      },
      {
        name: 'pin',
        label: 'MPIN',
        required: true,
        type: 'password',
        helper: '6-digit Neo MPIN'
      },
      {
        name: 'totp_secret',
        label: 'TOTP Secret',
        required: true,
        helper: 'Base32 secret from the Kotak Neo portal → Enable TOTP'
      }
    ]
  }
]

const getBrokerSchema = (brokerName) => {
  if (!brokerName) return DEFAULT_SCHEMA
  return BROKER_SCHEMAS.find(s => s.match(brokerName)) || DEFAULT_SCHEMA
}

function brokerNameOf(broker = {}) {
  return String(broker?.name || broker?.broker_name || '').trim()
}

function brokerLabelOf(broker = {}) {
  return brokerNameOf(broker) || 'Broker'
}

function isFallbackBroker(brokerId) {
  return String(brokerId || '') === '__zerodha__'
}

function hasSavedZerodhaSession(configId) {
  return Boolean(getSavedSession(configId, 'zerodha')?.accessToken)
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
      const list = brokerRes.data || []
      const hasZerodha = list.some((broker) => /zerodha|kite/i.test(brokerNameOf(broker)))
      setBrokers(hasZerodha ? list : [...list, ...FALLBACK_BROKERS])
      const zerodhaLoginState = {}
      for (const cfg of cfgRes.data || []) {
        const brokerName = cfg.broker_name || brokerNameOf(list.find((broker) => String(broker.id) === String(cfg.broker_id)) || {})
        if (/zerodha|kite/i.test(brokerName) && hasSavedZerodhaSession(cfg.id)) {
          zerodhaLoginState[cfg.id] = {
            status: 'on',
            message: 'Logged in (session reused)',
          }
        }
      }
      if (Object.keys(zerodhaLoginState).length) {
        setLoginState((prev) => ({ ...prev, ...zerodhaLoginState }))
      }
    } catch {
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

  useEffect(() => {
    const allowedOrigins = new Set(['http://127.0.0.1:3001', 'http://localhost:3001'])

    const onMessage = (event) => {
      if (!allowedOrigins.has(event.origin)) return
      const data = event.data || {}
      if (data.type !== 'zerodha-login-complete') return
      if (!data.configId) return
      if (data.status !== 'success' || !data.session?.accessToken) {
        setLoginState((prev) => ({
          ...prev,
          [data.configId]: {
            status: 'error',
            message: data.message || 'Zerodha login failed',
          },
        }))
        return
      }

      saveSession(data.configId, data.session, 'zerodha')
      setLoginState((prev) => ({
        ...prev,
        [data.configId]: {
          status: 'on',
          message: 'Logged in (fresh browser login)',
        },
      }))
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  /* ================= HELPERS ================= */
  const handleChange = (field) => (e) => {
    setForm({ ...form, [field]: e.target.value })
  }

  const resetForm = () => {
    setForm(EMPTY_FORM)
    setEditing(null)
    setError('')
  }

  const ensureBrokerRow = async () => {
    const selectedId = String(form.broker_id || '')
    if (!isFallbackBroker(selectedId)) return selectedId

    try {
      await apiPost('/masters/brokers/create.php', { name: 'Zerodha' })
    } catch (err) {
      const alreadyExists = /duplicate|exists|unique/i.test(String(err?.message || ''))
      if (!alreadyExists) throw err
    }

    const refresh = await apiGet('/masters/brokers/list.php')
    const list = refresh.data || []
    const match = list.find((broker) => /zerodha|kite/i.test(brokerNameOf(broker)))
    if (!match?.id) {
      throw new Error('Zerodha broker row could not be created')
    }
    setBrokers(list.some((broker) => /zerodha|kite/i.test(brokerNameOf(broker)))
      ? list
      : [...list, ...FALLBACK_BROKERS])
    return String(match.id)
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
            app_key: res.data.app_key || '',
            app_secret: res.data.app_secret || '',
            phone: res.data.phone || ''
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
      const resolvedBrokerId = await ensureBrokerRow()

      // Only send fields this broker uses; blank out the rest so
      // stale values from a previous broker selection aren't saved.
      const activeFields = new Set(schema.fields.map(f => f.name))
      const cleaned = { ...EMPTY_FORM, broker_id: resolvedBrokerId }
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
      // Teach the session store about the config that was just added or changed,
      // so it is signed in now rather than only at the next app start.
      refreshBrokerAccounts().catch(() => {})
    } catch (e) {
      setError(e.message || 'Failed to save configuration')
    }
  }

  /* ================= AUTO LOGIN ================= */
  // Angel's saved token lives under angel_session_<id> and is read back by the
  // whole Trade Panel, so that key must not change. Kotak gets its own prefix:
  // its session carries a tradeToken, not a jwtToken, and handing one to the
  // Angel session store would simply be dropped.
  const sessionKey = (cfgId, broker) => `${broker === 'kotak' ? 'kotak' : 'angel'}_session_${cfgId}`

  const setCfgLogin = (cfgId, state) => {
    setLoginState(prev => ({ ...prev, [cfgId]: state }))
  }

  const handleLoginToggle = async (cfg) => {
    const current = loginState[cfg.id]
    const cfgSchema = getBrokerSchema(cfg.broker_name)
    const broker = cfgSchema.broker || 'angel'
    const key = sessionKey(cfg.id, broker)

    // Turn OFF → drop the saved session
    if (current?.status === 'on') {
      localStorage.removeItem(key)
      setCfgLogin(cfg.id, { status: 'idle' })
      return
    }

    if (broker === 'zerodha') {
      if (current?.status === 'on' || hasSavedZerodhaSession(cfg.id)) {
        clearSession(cfg.id, 'zerodha')
        setCfgLogin(cfg.id, { status: 'idle' })
        return
      }

      const popup = window.open('', '_blank')
      if (!popup) {
        setCfgLogin(cfg.id, { status: 'error', message: 'Popup blocked. Allow popups to complete Zerodha login.' })
        return
      }

      try {
        const cfgDetails = await apiGet(`/users/broker-config/get.php?id=${cfg.id}`)
        const apiKey = cfgDetails.data?.app_key || cfg.app_key || ''
        const apiSecret = cfgDetails.data?.app_secret || cfg.app_secret || ''
        if (!apiKey || !apiSecret) {
          throw new Error('Missing Zerodha API key or API secret')
        }
        await zerodhaLoginStart({
          configId: String(cfg.id),
          apiKey,
          apiSecret,
        })
        const loginUrl = await zerodhaLoginUrl(apiKey)
        if (loginUrl?.url) {
          popup.location.href = loginUrl.url
          setCfgLogin(cfg.id, {
            status: 'loading',
            message: 'Complete the Zerodha login in the opened tab.',
          })
          return
        }
        throw new Error('Zerodha login URL could not be created')
      } catch (e) {
        popup.close()
        setCfgLogin(cfg.id, { status: 'error', message: e.message })
      }
      return
    }

    // Turn ON → fetch credentials, then auto-login via the Node backend
    setCfgLogin(cfg.id, { status: 'loading' })
    try {
      const res = await apiGet(`/users/broker-config/get.php?id=${cfg.id}`)
      const c = res.data

      // Ask the broker's own schema what it needs, and name what is missing in
      // that broker's own words (Kotak has no "API Key"; Angel has no "MPIN").
      const missing = cfgSchema.fields
        .filter(f => f.required && !String(c[f.name] || '').trim())
        .map(f => f.label)
      if (missing.length) {
        throw new Error(`Missing credentials — edit this config and fill ${missing.join(', ')}`)
      }

      // Reuse a previously saved session if there is one. Angel's backend
      // validates it with getRMS and falls back to a fresh TOTP login by itself;
      // Kotak always performs the two-step login.
      let session = null
      try {
        session = JSON.parse(localStorage.getItem(key))
      } catch { /* ignore corrupt session */ }

      const data = await brokerAutoLogin(broker, broker === 'kotak'
        ? {
          ucc: c.account_id,
          accessToken: c.app_secret,
          mobileNumber: c.phone,
          mpin: c.pin,
          totpSecret: c.totp_secret,
          session
        }
        : {
          clientCode: c.account_id,
          apiKey: c.app_key,
          pin: c.pin,
          totpSecret: c.totp_secret,
          session
        })

      if (data.session) {
        localStorage.setItem(key, JSON.stringify(data.session))
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
    refreshBrokerAccounts().catch(() => {})
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
            const savedZerodha = hasSavedZerodhaSession(cfg.id)
            const isZerodha = /zerodha|kite/i.test(String(cfg.broker_name || ''))
            const loginOn = login.status === 'on' || (isZerodha && savedZerodha)

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

                  {/* Zerodha needs a browser login, so show a visible action
                      row instead of hiding the control entirely. */}
                  {!cfgSchema.autoLogin && isZerodha && (
                    login.status === 'loading' ? (
                      <CircularProgress size={20} sx={{ mx: 1.5 }} />
                    ) : loginOn ? (
                      <Switch
                        size="small"
                        checked
                        onChange={() => handleLoginToggle(cfg)}
                      />
                    ) : (
                      <Button
                        size="small"
                        onClick={() => handleLoginToggle(cfg)}
                        sx={{ mr: 0.5 }}
                      >
                        Open Login
                      </Button>
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
                    {brokers.map((b) => (
                    <MenuItem key={b.id} value={b.id}>
                        {brokerLabelOf(b)}
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
