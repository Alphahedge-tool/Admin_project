import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Skeleton,
  Typography,
} from '@mui/material'
import { CheckCircle2, PlugZap, Save } from 'lucide-react'
import {
  FEED_BROKERS,
  clearFeedMaster,
  getSavedFeedMaster,
  saveFeedMaster,
} from '../feedmaster/feedMasterStore'
import { ensureAccountsLoaded, ensureSession, useAngelSessions } from '../feedmaster/angelSessionStore'

// Picks WHICH account carries the shared live feed and remembers it permanently
// (localStorage). The app no longer logs brokers in at startup, so this page
// loads the account list itself on open (no auto-login) and "Test Login" signs
// the chosen account in. The saved Feedmaster only ever changes when you press
// Save or Clear here - it survives every app open and login.
function Feedmaster() {
  const { users, accounts, phase } = useAngelSessions()

  // Populate the account list without logging anything in.
  useEffect(() => {
    ensureAccountsLoaded()
  }, [])
  const saved = getSavedFeedMaster()
  const [broker, setBroker] = useState(saved?.broker || 'angelone')
  const [userPick, setUserPick] = useState(saved?.userId ? String(saved.userId) : '')
  const [configPick, setConfigPick] = useState(saved?.configId ? String(saved.configId) : '')
  const [status, setStatus] = useState(
    saved?.configId ? 'Saved Feedmaster loaded' : 'Select the Angel One account for the live feed',
  )
  const [error, setError] = useState('')

  const loading = phase !== 'ready'

  // Selection is derived from the store's accounts, so an account logging in (or
  // failing) is reflected here without any extra state juggling.
  const userId = users.some((user) => String(user.id) === userPick)
    ? userPick
    : String(accounts[0]?.userId || users[0]?.id || '')

  // Angel accounts only: the store also holds Kotak accounts, and Kotak cannot
  // carry the shared feed.
  const userAccounts = useMemo(
    () => accounts.filter(
      (account) => account.userId === String(userId) && account.broker === 'angelone',
    ),
    [accounts, userId],
  )

  const configId = userAccounts.some((account) => account.configId === configPick)
    ? configPick
    : (userAccounts[0]?.configId || '')

  const selectedAccount = accounts.find((account) => account.configId === String(configId)) || null
  const canSave = broker === 'angelone' && !!selectedAccount

  // Read straight from storage on every render: it changes on save/clear, which
  // this component drives itself.
  const savedLabel = describeSavedFeedMaster(accounts)

  const saveSelection = () => {
    if (!canSave) {
      setError('Select an Angel One account first')
      return
    }
    saveFeedMaster({
      broker,
      userId: selectedAccount.userId,
      configId: selectedAccount.configId,
      accountId: selectedAccount.accountId,
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
    setStatus('Signing the Feedmaster in again...')
    try {
      await ensureSession(selectedAccount.configId, { force: true })
      saveSelection()
      setStatus('Feedmaster live - fresh token saved')
    } catch {
      const account = accounts.find((item) => item.configId === String(configId))
      setError(`${account?.issue?.title || 'Login failed'}. ${account?.issue?.hint || ''}`.trim())
      setStatus('')
    }
  }

  const clearSelection = () => {
    clearFeedMaster()
    setConfigPick('')
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
          {loading ? (
            // Until the account list finishes loading, hold the account pickers'
            // space with skeletons instead of three empty disabled dropdowns.
            // MUI Skeleton follows the palette mode, so it reads in both themes.
            <>
              <Skeleton variant="rounded" height={40} />
              <Skeleton variant="rounded" height={40} />
              <Skeleton variant="rounded" height={40} sx={{ gridColumn: { md: '1 / -1' } }} />
            </>
          ) : (
          <>
          <FormControl fullWidth disabled={loading}>
            <InputLabel>Broker</InputLabel>
            <Select label="Broker" value={broker} onChange={(event) => setBroker(event.target.value)}>
              {FEED_BROKERS.map((item) => (
                <MenuItem key={item.id} value={item.id}>{item.label}</MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl fullWidth disabled={loading}>
            <InputLabel>User</InputLabel>
            <Select label="User" value={userId} onChange={(event) => setUserPick(event.target.value)}>
              {users.map((user) => (
                <MenuItem key={user.id} value={String(user.id)}>
                  {user.username || `${user.first_name || ''} ${user.last_name || ''}`.trim() || `User ${user.id}`}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl fullWidth disabled={loading || !userAccounts.length} sx={{ gridColumn: { md: '1 / -1' } }}>
            <InputLabel>Angel One Account</InputLabel>
            <Select label="Angel One Account" value={configId} onChange={(event) => setConfigPick(event.target.value)}>
              {userAccounts.map((account) => (
                <MenuItem key={account.configId} value={account.configId}>
                  {account.brokerName} - {account.accountId || account.configId}
                  {account.status === 'live' ? ' (logged in)' : account.issue ? ` (${account.issue.title})` : ''}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          </>
          )}
        </Box>

        {selectedAccount?.status === 'failed' && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            {selectedAccount.issue?.title}: {selectedAccount.issue?.hint}
          </Alert>
        )}

        <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button variant="contained" startIcon={<Save size={16} />} disabled={!canSave} onClick={saveSelection}>
            Save Feedmaster
          </Button>
          <Button variant="outlined" startIcon={<PlugZap size={16} />} disabled={!canSave} onClick={testLogin}>
            Test Login
          </Button>
          <Button color="error" onClick={clearSelection}>
            Clear
          </Button>
          {selectedAccount?.status === 'live' && <Chip size="small" color="success" label="Logged in" />}
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2, color: 'text.secondary' }}>
          <CheckCircle2 size={16} />
          <Typography fontSize="0.875rem">Current Feedmaster: {savedLabel}</Typography>
        </Box>
      </Paper>
    </Box>
  )
}

function describeSavedFeedMaster(accounts) {
  const current = getSavedFeedMaster()
  if (!current?.configId) return 'No account saved yet'
  const account = accounts.find((item) => item.configId === String(current.configId))
  if (!account) return `Config ${current.configId} (no longer configured)`
  return `${account.username} - ${account.accountId}`
}

export default Feedmaster
