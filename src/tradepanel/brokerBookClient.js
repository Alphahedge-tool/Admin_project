import { useEffect, useMemo, useState } from 'react';

import { apiGet, brokerAutoLogin } from '../config/api';
import {
  ensureSession, isAngelBroker, saveSession, useAngelClient,
} from '../feedmaster/angelSessionStore';

const KOTAK_SESSION_PREFIX = 'kotak_session_';
const KOTAK_SESSION_EVENT = 'kotak-session-changed';
const kotakLoginInflight = new Map();

export function isKotakBroker(name = '') {
  return String(name).toLowerCase().replace(/\s/g, '').includes('kotak');
}

export function isBookBroker(name = '') {
  return isAngelBroker(name) || isKotakBroker(name);
}

function kotakSessionKey(configId) {
  return `${KOTAK_SESSION_PREFIX}${configId}`;
}

function getKotakSession(configId) {
  if (!configId) return null;
  try {
    return JSON.parse(localStorage.getItem(kotakSessionKey(configId))) || null;
  } catch {
    return null;
  }
}

export function saveKotakSession(configId, session) {
  if (!configId || !session?.tradeToken || !session?.sid || !session?.baseUrl) return;
  localStorage.setItem(kotakSessionKey(configId), JSON.stringify(session));
  window.dispatchEvent(new CustomEvent(KOTAK_SESSION_EVENT, {
    detail: { configId: String(configId), session },
  }));
}

function kotakClientFromConfig(configId, config) {
  return {
    enabled: true,
    broker: 'kotak',
    configId: String(configId),
    clientCode: config.account_id || '',
    ucc: config.account_id || '',
    accessToken: config.app_secret || '',
    mobileNumber: config.phone || '',
    mpin: config.pin || '',
    totpSecret: config.totp_secret || '',
    session: getKotakSession(configId),
  };
}

// Angel clients come from the startup session store. Kotak is hydrated only
// when a Kotak account is selected, so its secrets do not fan out to pages that
// never use them.
export function useBrokerBookClient(configId, brokerName) {
  const angelClient = useAngelClient(configId);
  const selectedIsKotak = isKotakBroker(brokerName);
  const [kotakState, setKotakState] = useState({ configId: '', client: null, error: '' });

  useEffect(() => {
    let cancelled = false;
    if (!configId || !selectedIsKotak) {
      return undefined;
    }

    apiGet(`/users/broker-config/get.php?id=${encodeURIComponent(configId)}`)
      .then((response) => {
        if (!cancelled) setKotakState({
          configId: String(configId),
          client: kotakClientFromConfig(configId, response.data || {}),
          error: '',
        });
      })
      .catch((error) => {
        if (!cancelled) setKotakState({
          configId: String(configId),
          client: null,
          error: error.message || 'Failed to load Kotak credentials',
        });
      });

    const onSession = (event) => {
      if (String(event.detail?.configId || '') !== String(configId)) return;
      setKotakState((current) => ({
        configId: String(configId),
        error: '',
        client: current.configId === String(configId) && current.client
          ? { ...current.client, session: event.detail.session }
          : current.client,
      }));
    };
    window.addEventListener(KOTAK_SESSION_EVENT, onSession);
    return () => {
      cancelled = true;
      window.removeEventListener(KOTAK_SESSION_EVENT, onSession);
    };
  }, [configId, selectedIsKotak]);

  const stateMatches = kotakState.configId === String(configId || '');
  const client = selectedIsKotak ? (stateMatches ? kotakState.client : null) : angelClient;
  const clientError = selectedIsKotak && stateMatches ? kotakState.error : '';
  return useMemo(() => ({ client, clientError }), [client, clientError]);
}

export function hasBookSession(brokerName, client) {
  if (isKotakBroker(brokerName)) {
    return !!(client?.session?.tradeToken && client.session.sid && client.session.baseUrl);
  }
  return !!client?.session?.jwtToken;
}

export async function ensureBookSession(configId, brokerName, client, { force = false } = {}) {
  if (isAngelBroker(brokerName)) {
    const session = await ensureSession(configId, { force });
    return { ...client, session, loggedIn: true };
  }
  if (!isKotakBroker(brokerName)) throw new Error(`${brokerName || 'Selected broker'} is not supported`);
  if (!force && hasBookSession(brokerName, client)) return client;

  const id = String(configId || '');
  const pending = kotakLoginInflight.get(id);
  if (pending) return pending;
  const promise = brokerAutoLogin('kotak', { ...client, session: force ? null : client?.session })
    .then((body) => {
      if (!body.session?.tradeToken) throw new Error('Kotak returned no trade token');
      saveKotakSession(id, body.session);
      return { ...client, session: body.session, loggedIn: true };
    })
    .finally(() => kotakLoginInflight.delete(id));
  kotakLoginInflight.set(id, promise);
  return promise;
}

export function saveBookSession(configId, brokerName, session) {
  if (isKotakBroker(brokerName)) saveKotakSession(configId, session);
  else saveSession(configId, session);
}

export async function fetchBrokerBook(kind, brokerName, client) {
  const broker = isKotakBroker(brokerName) ? 'kotak' : 'angel';
  const res = await fetch(`/api/${broker}/${kind}-book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status === false) throw new Error(body.message || `HTTP ${res.status}`);
  return body;
}

export async function fetchBrokerPositions(brokerName, client) {
  const broker = isKotakBroker(brokerName) ? 'kotak' : 'angel';
  const res = await fetch(`/api/${broker}/positions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status === false) throw new Error(body.message || `HTTP ${res.status}`);
  return body;
}
