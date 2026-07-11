// What the user sees the moment the app opens, before any page renders:
//
//   1. every configured Angel One account is logged in and its token saved
//      (so no page ever has to log in on its own), with a per-account line
//      showing exactly what went wrong for the ones that fail - PIN, TOTP,
//      API key, backend down;
//   2. the Feedmaster (the account that carries the shared live feed) is
//      confirmed or picked.
//
// Only then are the routes rendered.
import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from '@mui/material'
import { AlertTriangle, CheckCircle2, RefreshCw, Radio } from 'lucide-react'
import {
  bootstrapAngelSessions,
  ensureSession,
  retryFailedAccounts,
  useAngelSessions,
} from '../feedmaster/angelSessionStore'
import { BROKERS, getSavedFeedMaster, saveFeedMaster } from '../feedmaster/feedMasterStore'

function StartupGate({ children }) {
  const { phase, accounts, error } = useAngelSessions()
  const [step, setStep] = useState('accounts') // 'accounts' | 'feedmaster' | 'done'
  const [feedPick, setFeedPick] = useState(() => String(getSavedFeedMaster()?.configId || ''))

  useEffect(() => {
    bootstrapAngelSessions()
  }, [])

  const live = useMemo(() => accounts.filter((a) => a.status === 'live'), [accounts])
  const failed = useMemo(() => accounts.filter((a) => a.status === 'failed'), [accounts])
  const booting = phase !== 'ready'

  // The saved Feedmaster when it logged in, otherwise the first account that
  // did - a Feedmaster without a token feeds nothing.
  const feedConfigId = live.some((a) => a.configId === feedPick)
    ? feedPick
    : (live[0]?.configId || '')

  if (step === 'done') return children

  const feedAccount = accounts.find((a) => a.configId === feedConfigId) || null

  const confirmFeedMaster = () => {
    if (feedAccount) {
      saveFeedMaster({
        broker: 'angelone',
        userId: feedAccount.userId,
        configId: feedAccount.configId,
        accountId: feedAccount.accountId,
      })
    }
    setStep('done')
  }

  return (
    <Shell>
      {step === 'accounts' ? (
        <AccountsStep
          accounts={accounts}
          booting={booting}
          error={error}
          live={live}
          failed={failed}
          onContinue={() => setStep('feedmaster')}
        />
      ) : (
        <FeedMasterStep
          live={live}
          feedConfigId={feedConfigId}
          setFeedConfigId={setFeedPick}
          onBack={() => setStep('accounts')}
          onContinue={confirmFeedMaster}
        />
      )}
    </Shell>
  )
}

function Shell({ children }) {
  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        p: 2,
      }}
    >
      <Paper sx={{ p: 3, width: '100%', maxWidth: 720 }}>{children}</Paper>
    </Box>
  )
}

function AccountsStep({ accounts, booting, error, live, failed, onContinue }) {
  const done = live.length + failed.length

  return (
    <>
      <Typography variant="h5" fontWeight={600}>Signing in broker accounts</Typography>
      <Typography color="text.secondary" fontSize="0.875rem" sx={{ mt: 0.5 }}>
        Every Angel One account is logged in once here and its token saved, so no screen has to log in again.
      </Typography>

      {booting && (
        <LinearProgress
          variant={accounts.length ? 'determinate' : 'indeterminate'}
          value={accounts.length ? (done / accounts.length) * 100 : 0}
          sx={{ mt: 2, borderRadius: 1 }}
        />
      )}

      {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}

      {!booting && !accounts.length && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          No Angel One account is configured yet. Add one in Users -&gt; Broker Configuration.
        </Alert>
      )}

      {!booting && failed.length > 0 && (
        <Alert
          severity="warning"
          sx={{ mt: 2 }}
          action={
            <Button
              size="small"
              color="inherit"
              startIcon={<RefreshCw size={14} />}
              onClick={() => retryFailedAccounts()}
            >
              Retry all
            </Button>
          }
        >
          {live.length} of {accounts.length} accounts logged in - {failed.length} could not.
          Fix the issue shown below, then retry.
        </Alert>
      )}

      {!booting && accounts.length > 0 && failed.length === 0 && (
        <Alert severity="success" sx={{ mt: 2 }}>
          All {accounts.length} accounts are logged in and their tokens saved.
        </Alert>
      )}

      <Stack divider={<Divider />} sx={{ mt: 2 }}>
        {accounts.map((account) => (
          <AccountRow key={account.configId} account={account} />
        ))}
      </Stack>

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 3 }}>
        <Button variant="contained" disabled={booting} onClick={onContinue}>
          {failed.length ? 'Continue anyway' : 'Continue'}
        </Button>
      </Box>
    </>
  )
}

function AccountRow({ account }) {
  const busy = account.status === 'logging-in' || account.status === 'pending'

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, py: 1.25 }}>
      <Box sx={{ mt: '2px' }}>
        {busy && <CircularProgress size={16} />}
        {account.status === 'live' && <CheckCircle2 size={18} color="#2e7d32" />}
        {account.status === 'failed' && <AlertTriangle size={18} color="#ed6c02" />}
      </Box>

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography fontWeight={600} fontSize="0.9rem">
          {account.username} - {account.accountId || `Config ${account.configId}`}
        </Typography>
        {account.status === 'failed' ? (
          <>
            <Typography color="warning.main" fontSize="0.8rem" fontWeight={600}>
              {account.issue?.title || 'Login failed'}
            </Typography>
            <Typography color="text.secondary" fontSize="0.8rem">
              {account.issue?.hint}
            </Typography>
            {account.message && account.message !== account.issue?.hint && (
              <Typography color="text.disabled" fontSize="0.75rem">
                Broker said: {account.message}
              </Typography>
            )}
          </>
        ) : (
          <Typography color="text.secondary" fontSize="0.8rem">
            {busy ? 'Signing in...' : account.message}
          </Typography>
        )}
      </Box>

      {account.status === 'live' && <Chip size="small" color="success" label="Logged in" />}
      {account.status === 'failed' && (
        <Button
          size="small"
          startIcon={<RefreshCw size={14} />}
          onClick={() => ensureSession(account.configId, { force: true }).catch(() => {})}
        >
          Retry
        </Button>
      )}
    </Box>
  )
}

function FeedMasterStep({ live, feedConfigId, setFeedConfigId, onBack, onContinue }) {
  const saved = getSavedFeedMaster()
  const selected = live.find((a) => a.configId === feedConfigId) || null

  return (
    <>
      <Typography variant="h5" fontWeight={600}>Set the Feedmaster</Typography>
      <Typography color="text.secondary" fontSize="0.875rem" sx={{ mt: 0.5 }}>
        This is the logged-in account whose websocket carries the shared live feed for every screen.
      </Typography>

      {!live.length ? (
        <Alert severity="warning" sx={{ mt: 2 }}>
          No account is logged in, so there is nothing to feed from. Go back, fix the login issue and retry -
          or continue without a live feed.
        </Alert>
      ) : (
        <>
          {saved?.configId === feedConfigId && (
            <Alert severity="info" sx={{ mt: 2 }}>Your saved Feedmaster is logged in and ready.</Alert>
          )}

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2, mt: 2 }}>
            <FormControl fullWidth>
              <InputLabel>Broker</InputLabel>
              <Select label="Broker" value="angelone" disabled>
                {BROKERS.map((broker) => (
                  <MenuItem key={broker.id} value={broker.id}>{broker.label}</MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl fullWidth>
              <InputLabel>Feedmaster account</InputLabel>
              <Select
                label="Feedmaster account"
                value={feedConfigId}
                onChange={(event) => setFeedConfigId(event.target.value)}
              >
                {live.map((account) => (
                  <MenuItem key={account.configId} value={account.configId}>
                    {account.username} - {account.accountId}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>

          {selected && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2, color: 'text.secondary' }}>
              <Radio size={16} />
              <Typography fontSize="0.875rem">
                Live feed will run on {selected.username} - {selected.accountId}
              </Typography>
            </Box>
          )}
        </>
      )}

      <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 3 }}>
        <Button onClick={onBack}>Back</Button>
        <Button variant="contained" onClick={onContinue} disabled={live.length > 0 && !selected}>
          {live.length ? 'Save Feedmaster and open app' : 'Continue without feed'}
        </Button>
      </Box>
    </>
  )
}

export default StartupGate
