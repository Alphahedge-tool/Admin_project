// Shared Angel account picker state, used by Enter Trade (option chain + basket).
// It no longer loads credentials or logs anything in: every Angel account was
// already logged in at app start (see startup/StartupGate +
// feedmaster/angelSessionStore), so this just picks one of them and hands back
// the client that already carries a live session.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet } from '../config/api';
import {
  clientFromAccount,
  ensureSession,
  saveSession,
  useAngelSessions,
} from '../feedmaster/angelSessionStore';

export function useAngelAccount() {
  const { users, accounts, phase } = useAngelSessions();
  // Explicit picks. Everything else below is derived, so a login finishing in
  // the store shows up here without a round of extra renders.
  const [userPick, setUserPick] = useState('');
  const [configPick, setConfigPick] = useState('');
  const [statusOverride, setStatusOverride] = useState({ configId: '', text: '' });
  const [dismissedNotice, setDismissedNotice] = useState('');
  const [principal, setPrincipal] = useState(null);

  // Who is using the app - so their own user row is preselected.
  useEffect(() => {
    let cancelled = false;
    apiGet('/auth/me.php')
      .then((data) => {
        if (!cancelled) setPrincipal(data?.user || data?.admin || data?.data || data || {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const defaultUserId = useMemo(() => {
    const current = findLoggedInUser(users, principal || {}) || users[0];
    return current?.id ? String(current.id) : '';
  }, [users, principal]);

  const userId = users.some((user) => String(user.id) === userPick) ? userPick : defaultUserId;

  // The selected user's Angel accounts, in the shape the account bar renders.
  // The store also carries Kotak accounts, but the option chain, basket and feed
  // behind this hook are Angel-only, so they are not offered here.
  const configs = useMemo(
    () => accounts
      .filter((account) => account.userId === String(userId) && account.broker === 'angelone')
      .map((account) => ({
        id: account.configId,
        broker_name: account.brokerName,
        account_id: account.accountId,
      })),
    [accounts, userId],
  );

  const configId = configs.some((config) => config.id === configPick)
    ? configPick
    : (configs[0]?.id || '');

  const account = useMemo(
    () => accounts.find((item) => item.configId === configId) || null,
    [accounts, configId],
  );
  const client = useMemo(() => clientFromAccount(account), [account]);

  // A live account says so; a failed one says WHAT is wrong (PIN / TOTP / API
  // key / backend down) rather than a dead "not logged in".
  const derivedStatus = useMemo(() => {
    if (!users.length) return phase === 'ready' ? 'No users available' : 'Loading users...';
    if (!configs.length) {
      return phase === 'ready'
        ? 'No Angel account configured for this user'
        : 'Signing in Angel accounts...';
    }
    if (!account) return 'Select an Angel account';
    if (account.status === 'live') return 'Logged in - live';
    if (account.status === 'failed') {
      const issue = account.issue;
      return `${issue?.title || 'Login failed'} - ${issue?.hint || account.message || ''}`.trim();
    }
    return 'Signing in...';
  }, [account, configs.length, phase, users.length]);

  const accStatus = statusOverride.configId === configId && statusOverride.text
    ? statusOverride.text
    : derivedStatus;

  const setAccStatus = useCallback(
    (text) => setStatusOverride({ configId, text }),
    [configId],
  );

  // One toast per account state: "logged in" or the reason it could not be.
  const noticeKey = account ? `${account.configId}:${account.status}:${account.issue?.code || ''}` : '';
  const loginNotice = useMemo(() => {
    if (!account || dismissedNotice === noticeKey) {
      return { open: false, message: '', severity: 'success' };
    }
    if (account.status === 'live') {
      return { open: true, message: `${account.alias} logged in successfully`, severity: 'success' };
    }
    if (account.status === 'failed') {
      const issue = account.issue;
      return {
        open: true,
        message: `${account.alias}: ${issue?.title || 'Login failed'}. ${issue?.hint || ''}`.trim(),
        severity: 'error',
      };
    }
    return { open: false, message: '', severity: 'success' };
  }, [account, dismissedNotice, noticeKey]);

  const clearLoginNotice = useCallback(() => setDismissedNotice(noticeKey), [noticeKey]);

  // A broker call that came back with a refreshed token hands it here, so every
  // other page picks the new token up too.
  const handleClientSession = useCallback((_index, session) => {
    if (configId && session?.jwtToken) saveSession(configId, session);
  }, [configId]);

  // Forced re-login for this account (expired token, or a retry after the user
  // fixed the PIN/TOTP in Broker Configuration).
  const relogin = useCallback(() => ensureSession(configId, { force: true }), [configId]);

  const clients = client ? [client] : [];

  return {
    users, userId, setUserId: setUserPick,
    configs, configId, setConfigId: setConfigPick,
    client, clients, accStatus, setAccStatus,
    handleClientSession,
    relogin,
    loginNotice,
    clearLoginNotice,
  };
}

function findLoggedInUser(users, principal = {}) {
  const candidates = [
    principal.id,
    principal.user_id,
    principal.userId,
    principal.admin_id,
  ].filter((value) => value != null).map(String);

  if (candidates.length) {
    const byId = users.find((u) => candidates.includes(String(u.id)));
    if (byId) return byId;
  }

  const names = [
    principal.username,
    principal.user_name,
    principal.email,
  ].filter(Boolean).map((value) => String(value).toLowerCase());

  if (!names.length) return null;
  return users.find((u) => {
    const username = String(u.username || '').toLowerCase();
    const email = String(u.email || '').toLowerCase();
    return names.includes(username) || names.includes(email);
  }) || null;
}
