import { Alert, Snackbar } from '@mui/material';

// Presentational account picker bar shared by Enter Trade and Get Position.
// Driven entirely by the useAngelAccount() hook's values.
export default function AngelAccountBar({
  users,
  userId,
  setUserId,
  configs,
  configId,
  setConfigId,
  client,
  accStatus,
  loginNotice,
  clearLoginNotice,
}) {
  return (
    <>
      <div className="trade-account-bar">
        <label>
          User
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Select user</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username || `${u.first_name || ''} ${u.last_name || ''}`.trim() || `User ${u.id}`}
              </option>
            ))}
          </select>
        </label>

        <label>
          Angel Account
          <select value={configId} onChange={(e) => setConfigId(e.target.value)} disabled={!configs.length}>
            <option value="">Select account</option>
            {configs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.broker_name} - {c.account_id || c.id}
              </option>
            ))}
          </select>
        </label>

        <span className={`trade-account-status${client?.loggedIn ? ' is-live' : ''}`}>{accStatus}</span>
      </div>

      <Snackbar
        open={!!loginNotice?.open}
        autoHideDuration={3200}
        onClose={clearLoginNotice}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Alert
          severity="success"
          variant="filled"
          onClose={clearLoginNotice}
          sx={{ borderRadius: 1, fontWeight: 700 }}
        >
          {loginNotice?.message || 'Angel account logged in successfully'}
        </Alert>
      </Snackbar>
    </>
  );
}
