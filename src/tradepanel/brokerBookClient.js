import { useEffect, useMemo, useState } from 'react';

import { apiGet, brokerAutoLogin, zerodhaOrderBook, zerodhaPositions, zerodhaTradeBook } from '../config/api';
import {
  ensureSession, getSavedSession, isAngelBroker, isKotakBroker, KOTAK_SESSION_EVENT,
  saveSession, useAngelClient,
} from '../feedmaster/angelSessionStore';

// Kotak sessions are stored by the session store, which logs every Kotak account
// in at startup alongside the Angel ones - so by the time a book page opens, the
// token is usually already there.
export { isKotakBroker };

const kotakLoginInflight = new Map();

export function isBookBroker(name = '') {
  return isAngelBroker(name) || isKotakBroker(name) || isZerodhaBroker(name);
}

function getKotakSession(configId) {
  return getSavedSession(configId, 'kotak');
}

function getZerodhaSession(configId) {
  return getSavedSession(configId, 'zerodha');
}

export function saveKotakSession(configId, session) {
  saveSession(configId, session, 'kotak');
}

export function saveZerodhaSession(configId, session) {
  saveSession(configId, session, 'zerodha');
}

export function isZerodhaBroker(name = '') {
  return String(name).toLowerCase().replace(/\s/g, '').includes('zerodha')
    || String(name).toLowerCase().replace(/\s/g, '').includes('kite');
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

function zerodhaClientFromConfig(configId, config) {
  const session = getZerodhaSession(configId);
  return {
    enabled: true,
    broker: 'zerodha',
    configId: String(configId),
    clientCode: config.account_id || '',
    apiKey: config.app_key || config.appKey || config.api_key || '',
    apiSecret: config.app_secret || config.appSecret || config.api_secret || '',
    requestToken: config.request_token || config.requestToken || '',
    accessToken: session?.accessToken || session?.access_token || '',
    session,
  };
}

// Angel clients come from the startup session store. Kotak is hydrated only
// when a Kotak account is selected, so its secrets do not fan out to pages that
// never use them.
export function useBrokerBookClient(configId, brokerName) {
  const angelClient = useAngelClient(configId);
  const selectedIsKotak = isKotakBroker(brokerName);
  const selectedIsZerodha = isZerodhaBroker(brokerName);
  const [kotakState, setKotakState] = useState({ configId: '', client: null, error: '' });
  const [zerodhaState, setZerodhaState] = useState({ configId: '', client: null, error: '' });

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

  useEffect(() => {
    let cancelled = false;
    if (!configId || !selectedIsZerodha) {
      return undefined;
    }

    apiGet(`/users/broker-config/get.php?id=${encodeURIComponent(configId)}`)
      .then((response) => {
        if (!cancelled) setZerodhaState({
          configId: String(configId),
          client: zerodhaClientFromConfig(configId, response.data || {}),
          error: '',
        });
      })
      .catch((error) => {
        if (!cancelled) setZerodhaState({
          configId: String(configId),
          client: null,
          error: error.message || 'Failed to load Zerodha credentials',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [configId, selectedIsZerodha]);

  const stateMatches = kotakState.configId === String(configId || '');
  const zerodhaMatches = zerodhaState.configId === String(configId || '');
  const client = selectedIsKotak
    ? (stateMatches ? kotakState.client : null)
    : selectedIsZerodha
      ? (zerodhaMatches ? zerodhaState.client : null)
      : angelClient;
  const clientError = selectedIsKotak && stateMatches
    ? kotakState.error
    : selectedIsZerodha && zerodhaMatches
      ? zerodhaState.error
      : '';
  return useMemo(() => ({ client, clientError }), [client, clientError]);
}

export function hasBookSession(brokerName, client) {
  if (isKotakBroker(brokerName)) {
    return !!(client?.session?.tradeToken && client.session.sid && client.session.baseUrl);
  }
  if (isZerodhaBroker(brokerName)) {
    return !!(client?.session?.accessToken && client.session.apiKey);
  }
  return !!client?.session?.jwtToken;
}

export async function ensureBookSession(configId, brokerName, client, { force = false } = {}) {
  if (isAngelBroker(brokerName)) {
    const session = await ensureSession(configId, { force });
    return { ...client, session, loggedIn: true };
  }
  if (isZerodhaBroker(brokerName)) {
    if (!force && hasBookSession(brokerName, client)) return client;
    if (!client?.apiKey || !client?.apiSecret) {
      throw new Error('Zerodha login needs API key and API secret');
    }
    if (!client?.requestToken) {
      throw new Error('Zerodha request token is missing. Complete the browser login and exchange the request token first.');
    }
    const body = await brokerAutoLogin('zerodha', {
      apiKey: client.apiKey,
      apiSecret: client.apiSecret,
      requestToken: client.requestToken,
      session: force ? null : client?.session,
    });
    if (!body.session?.accessToken) throw new Error('Zerodha returned no access token');
    saveZerodhaSession(String(configId), body.session);
    return { ...client, accessToken: body.session.accessToken, session: body.session, loggedIn: true };
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
  else if (isZerodhaBroker(brokerName)) saveZerodhaSession(configId, session);
  else saveSession(configId, session);
}

export async function fetchBrokerBook(kind, brokerName, client) {
  if (isZerodhaBroker(brokerName)) {
    const body = kind === 'trade'
      ? await zerodhaTradeBook(client)
      : await zerodhaOrderBook(client);
    return body;
  }
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
  if (isZerodhaBroker(brokerName)) {
    return zerodhaPositions(client);
  }
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
