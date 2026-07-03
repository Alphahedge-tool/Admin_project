// Shared Angel account picker state, used by both Enter Trade (option chain +
// basket) and Get Position. Hydrates a single logged-in `client` from a user's
// Angel broker config (the rows managed in Users -> Broker Configuration).
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '../config/api';

export function useAngelAccount() {
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState('');
  const [configs, setConfigs] = useState([]); // Angel configs for the selected user
  const [configId, setConfigId] = useState('');
  const [client, setClient] = useState(null); // hydrated client creds (single account)
  const [accStatus, setAccStatus] = useState('Select a user and Angel account');
  const [loginNotice, setLoginNotice] = useState({ open: false, message: '' });
  const lastNotifiedJwtRef = useRef('');

  // Load users once.
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      apiGet('/users/list.php'),
      apiGet('/auth/me.php'),
    ])
      .then(([usersOut, authOut]) => {
        if (cancelled) return;
        if (usersOut.status !== 'fulfilled') {
          setAccStatus('Failed to load users');
          return;
        }

        const list = usersOut.value.data || [];
        setUsers(list);
        if (!list.length) {
          setAccStatus('No users available');
          return;
        }

        const auth = authOut.status === 'fulfilled' ? authOut.value : null;
        const principal = auth?.user || auth?.admin || auth?.data || auth || {};
        const current = findLoggedInUser(list, principal) || list[0];
        if (current?.id) {
          setUserId(String(current.id));
          setAccStatus(`Loading Angel accounts for ${current.username || 'selected user'}...`);
        }
      })
      .catch(() => setAccStatus('Failed to load users'));

    return () => {
      cancelled = true;
    };
  }, [client?.alias]);

  // Load the selected user's Angel broker configs.
  useEffect(() => {
    if (!userId) {
      setConfigs([]);
      setConfigId('');
      return;
    }
    setConfigs([]);
    setConfigId('');
    setClient(null);
    apiGet(`/users/broker-config/list.php?user_id=${userId}`)
      .then((res) => {
        const angel = (res.data || []).filter((c) =>
          String(c.broker_name || '').toLowerCase().replace(/\s/g, '').includes('angel')
        );
        setConfigs(angel);
        if (angel.length > 0) {
          setConfigId(String(angel[0].id));
          setAccStatus('Loading first Angel account...');
        } else {
          setAccStatus('No Angel account configured for this user');
        }
      })
      .catch(() => setAccStatus('Failed to load broker configs'));
  }, [userId]);

  // Hydrate full credentials when an account is chosen.
  useEffect(() => {
    if (!configId) {
      setClient(null);
      return;
    }
        setAccStatus('Loading credentials...');
    apiGet(`/users/broker-config/get.php?id=${configId}`)
      .then((res) => {
        const c = res.data || {};
        if (!c.account_id || !c.app_key || !c.pin || !c.totp_secret) {
          setClient(null);
          setAccStatus('This Angel config is missing Client Code / PIN / TOTP / API Key - edit it in Users.');
          return;
        }
        const user = users.find((u) => String(u.id) === String(userId));
        setClient({
          enabled: true,
          alias: `${user?.username || 'user'} - ${c.account_id}`,
          clientCode: c.account_id,
          apiKey: c.app_key,
          pin: c.pin,
          totpSecret: c.totp_secret,
          loggedIn: false,
          session: null,
        });
        setAccStatus('Account ready');
      })
      .catch(() => {
        setClient(null);
        setAccStatus('Failed to load credentials');
      });
  }, [configId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the live session back onto the client so re-loads reuse it.
  const handleClientSession = useCallback((_index, session) => {
    setClient((c) => (c ? { ...c, session, loggedIn: !!session?.jwtToken } : c));
    if (session?.jwtToken) {
      setAccStatus('Logged in - live');
      if (lastNotifiedJwtRef.current !== session.jwtToken) {
        lastNotifiedJwtRef.current = session.jwtToken;
        setLoginNotice({
          open: true,
          message: `${client?.alias || session.clientCode || 'Angel account'} logged in successfully`,
        });
      }
    }
  }, []);

  const clients = client ? [client] : [];

  return {
    users, userId, setUserId,
    configs, configId, setConfigId,
    client, clients, accStatus, setAccStatus,
    handleClientSession,
    loginNotice,
    clearLoginNotice: () => setLoginNotice({ open: false, message: '' }),
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
