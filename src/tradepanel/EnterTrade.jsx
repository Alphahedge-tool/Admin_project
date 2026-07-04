// Enter Trade: the option chain + basket ported from the Angel One frontend's
// Strategies tab, wired to the admin's Node backend (/api/angel/*). The Angel
// account is picked via the shared account bar (useAngelAccount).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, LoaderCircle, Search, X } from 'lucide-react';
import Basket from './Basket.jsx';
import { useAngelAccount } from './useAngelAccount';
import { loginAngelClient, useFeedMasterAccount } from '../feedmaster/feedMasterStore';
import './tradepanel.css';

/* ══════════════════════════════════════════════════════════════════════
   Enter Trade — account bar + option chain + basket. Selecting an Angel
   account loads its live option chain; Buy/Sell from the chain fills the
   basket on the right.
   ══════════════════════════════════════════════════════════════════════ */
export default function EnterTrade() {
  const acc = useAngelAccount();
  const feedMaster = useFeedMasterAccount();
  return (
    <div className="trade-panel">
      <Strategies
        clients={acc.clients}
        demoMode={false}
        feedMasterClient={feedMaster.client}
        onClientSession={acc.handleClientSession}
        onFeedMasterSession={feedMaster.handleSession}
      />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   Strategies — basket legs + option chain (port of main.jsx Strategies).
   ══════════════════════════════════════════════════════════════════════ */
function Strategies({ clients, demoMode, feedMasterClient, onClientSession, onFeedMasterSession }) {
  const [legs, setLegs] = useState([]);
  const legsRef = useRef([]);
  legsRef.current = legs;
  const [marginClient, setMarginClient] = useState(null);
  const marginClientRef = useRef(null);
  marginClientRef.current = marginClient;
  const feedMasterClientRef = useRef(null);
  feedMasterClientRef.current = feedMasterClient;
  const [margin, setMargin] = useState({ status: 'idle', value: 0, message: '' });
  const [charges, setCharges] = useState({ status: 'idle', value: 0, message: '' });
  const [expiryIndex, setExpiryIndex] = useState({});
  const [liveTicks, setLiveTicks] = useState({});
  const liveTicksRef = useRef({});
  liveTicksRef.current = liveTicks;
  const [marginNonce, setMarginNonce] = useState(0);
  const legSeq = useRef(0);

  const addLeg = useCallback((leg) => {
    setLegs((current) => [...current, { ...leg, id: `leg-${++legSeq.current}` }]);
  }, []);

  const updateLeg = useCallback((id, patch) => {
    setLegs((current) => current.map((leg) => (leg.id === id ? { ...leg, ...patch } : leg)));
  }, []);

  const resolveSeq = useRef({});
  const chainCache = useRef({});
  const chainPending = useRef({});

  const lookupFromChain = (chain, strike, optionType) => {
    if (!chain?.strikes?.length) return null;
    const want = Number(strike) || 0;
    let idx = chain.strikes.indexOf(want);
    if (idx < 0) {
      idx = chain.strikes.reduce((best, s, i) =>
        Math.abs(s - want) < Math.abs(chain.strikes[best] - want) ? i : best, 0);
    }
    const isCall = String(optionType).toUpperCase() !== 'PE';
    const ltp = (isCall ? chain.callLtp : chain.putLtp)?.[idx];
    const close = (isCall ? chain.callClose : chain.putClose)?.[idx];
    const token = (isCall ? chain.callTokens : chain.putTokens)?.[idx] || null;
    const tradingSymbol = (isCall ? chain.callSymbols : chain.putSymbols)?.[idx] || null;
    const changePctVal = (ltp && close) ? Number((((ltp - close) / close) * 100).toFixed(2)) : null;
    return {
      strike: chain.strikes[idx],
      ltp: ltp ?? null,
      close: close ?? null,
      changePct: changePctVal,
      token,
      tradingSymbol,
      exchange: chain.exchange,
      lotSize: chain.lotSize || 1,
    };
  };

  const loadExpiryChain = useCallback(async (symbol, expiry) => {
    const key = `${symbol}|${expiry}`;
    if (chainCache.current[key]) return chainCache.current[key];
    if (chainPending.current[key]) return chainPending.current[key];
    const liveClient = marginClientRef.current;
    if (!liveClient?.session?.jwtToken) return null;
    const request = (async () => {
      const res = await fetch('/api/angel/option-chain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: liveClient, symbol, expiry, window: 30 }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status === false) throw new Error(body.message || 'Chain load failed');
      chainCache.current[key] = body;
      return body;
    })();
    chainPending.current[key] = request;
    try {
      return await request;
    } finally {
      delete chainPending.current[key];
    }
  }, []);

  const resolveLegContract = useCallback(async (id, changes = {}) => {
    const found = legsRef.current.find((leg) => leg.id === id);
    if (!found) return;
    const target = { ...found, ...changes };
    setLegs((current) => current.map((leg) => (leg.id === id ? { ...leg, ...changes, resolving: true } : leg)));

    const seq = (resolveSeq.current[id] || 0) + 1;
    resolveSeq.current[id] = seq;
    const isLatest = () => resolveSeq.current[id] === seq;
    const finish = (patch) => {
      if (!isLatest()) return;
      setLegs((current) => current.map((leg) => (leg.id === id ? { ...leg, ...patch, resolving: false } : leg)));
    };

    try {
      const key = `${target.symbol}|${target.expiry}`;
      let chain = chainCache.current[key];
      if (!chain) chain = await loadExpiryChain(target.symbol, target.expiry);

      const hit = chain && lookupFromChain(chain, target.strike, target.optionType);
      if (hit && hit.token) {
        finish({
          expiry: target.expiry,
          strike: hit.strike,
          optionType: target.optionType,
          token: hit.token,
          tradingSymbol: hit.tradingSymbol,
          exchange: hit.exchange,
          lotSize: hit.lotSize,
          ltp: hit.ltp,
          close: hit.close,
          changePct: hit.changePct,
          resolveError: null,
        });
        return;
      }

      const liveClient = marginClientRef.current;
      const res = await fetch('/api/angel/resolve-leg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client: liveClient || null,
          symbol: target.symbol,
          expiry: target.expiry,
          strike: Number(target.strike) || 0,
          optionType: target.optionType,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status === false) throw new Error(body.message || 'Contract not found');
      finish({
        expiry: body.expiry || target.expiry,
        strike: body.strike ?? target.strike,
        optionType: body.optionType || target.optionType,
        token: body.token ?? target.token,
        tradingSymbol: body.tradingSymbol ?? target.tradingSymbol,
        exchange: body.exchange || target.exchange,
        lotSize: body.lotSize || target.lotSize,
        ltp: body.ltp ?? null,
        close: body.close ?? null,
        changePct: body.changePct ?? null,
        resolveError: body.quoteError || null,
      });
    } catch (error) {
      console.error('resolve-leg failed:', error);
      finish({ resolveError: error.message || 'Contract not found' });
    }
  }, [loadExpiryChain]);

  const stepStrike = useCallback(async (id, dir) => {
    const leg = legsRef.current.find((l) => l.id === id);
    if (!leg) return;
    const current = Number(leg.strike) || 0;
    const key = `${leg.symbol}|${leg.expiry}`;
    let chain = chainCache.current[key];
    if (!chain) chain = await loadExpiryChain(leg.symbol, leg.expiry).catch(() => null);
    const strikes = chain?.strikes;
    let target;
    if (strikes?.length) {
      target = dir > 0 ? strikes.find((s) => s > current) : [...strikes].reverse().find((s) => s < current);
      if (target == null) return;
    } else {
      const step = strikeStepFor(leg.symbol);
      target = Math.max(0, current + dir * step);
      if (target === current) return;
    }
    resolveLegContract(id, { strike: target });
  }, [loadExpiryChain, resolveLegContract]);

  const refreshMargin = useCallback(() => {
    const ticks = liveTicksRef.current;
    setLegs((current) => current.map((leg) => {
      const tick = leg.token != null ? ticks[leg.token] : null;
      if (!tick || tick.ltp == null) return leg;
      const changePctVal = (tick.ltp && tick.close)
        ? Number((((tick.ltp - tick.close) / tick.close) * 100).toFixed(2))
        : leg.changePct;
      return { ...leg, ltp: tick.ltp, changePct: changePctVal };
    }));
    setMarginNonce((n) => n + 1);
  }, []);

  const legFeedKey = useMemo(() => {
    const seen = new Set();
    for (const leg of legs) {
      if (leg.token != null) seen.add(`${leg.exchange || 'NFO'}|${leg.token}`);
    }
    return [...seen].sort().join(',');
  }, [legs]);

  useEffect(() => {
    let cancelled = false;

    async function syncBasketFeed() {
      const client = feedMasterClientRef.current || marginClientRef.current;
      let session = client?.session;
      if (!client) return;

      const items = (legFeedKey ? legFeedKey.split(',') : []).map((pair) => {
        const [exchange, token] = pair.split('|');
        return { exchange, token };
      });

      if (!items.length && (!session?.jwtToken || !session?.feedToken)) return;

      if (feedMasterClientRef.current && (!session?.jwtToken || !session?.feedToken)) {
        const login = await loginAngelClient(client);
        session = login.session || null;
        if (session?.jwtToken) onFeedMasterSession?.(session);
      }

      if (cancelled || !session?.jwtToken || !session?.feedToken) return;

      fetch('/api/angel/basket-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credentials: {
            jwtToken: session.jwtToken,
            feedToken: session.feedToken,
            apiKey: client.apiKey,
            clientCode: client.clientCode,
          },
          items,
        }),
      }).catch((error) => console.error('basket-tokens sync failed:', error));
    }

    syncBasketFeed().catch((error) => console.error('basket-tokens sync failed:', error));

    return () => {
      cancelled = true;
    };
  }, [legFeedKey, marginClient, feedMasterClient, onFeedMasterSession]);

  const removeLeg = useCallback((id) => {
    setLegs((current) => current.filter((leg) => leg.id !== id));
  }, []);

  const clearLegs = useCallback(() => setLegs([]), []);

  const priceFor = (leg) => {
    const orderType = String(leg.priceType || 'MARKET').toUpperCase();
    if (orderType === 'LIMIT' || orderType === 'SL') return Number(leg.price) || 0;
    const tick = leg.token != null ? liveTicksRef.current[leg.token] : null;
    return Number(leg.ltp) || Number(tick?.ltp) || Number(leg.close) || 0;
  };

  const calcKey = useMemo(
    () => JSON.stringify(legs.map((leg) => [
      leg.token, leg.exchange, leg.qty, leg.lotSize, leg.action, leg.product,
      leg.priceType, leg.triggerPrice, priceFor(leg),
    ])),
    [legs], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    if (!legs.length) {
      setMargin({ status: 'idle', value: 0, message: '' });
      setCharges({ status: 'idle', value: 0, message: '' });
      return undefined;
    }
    if (!marginClient?.session?.jwtToken) {
      const msg = 'Load the option chain on a logged-in account to price this basket';
      setMargin({ status: 'error', value: 0, message: msg });
      setCharges({ status: 'error', value: 0, message: msg });
      return undefined;
    }

    let cancelled = false;
    const handle = setTimeout(async () => {
      setMargin((m) => ({ ...m, status: 'loading' }));
      setCharges((c) => ({ ...c, status: 'loading' }));

      const legPayload = legs.map((leg) => ({
        token: leg.token,
        symbol: leg.tradingSymbol,
        exchange: leg.exchange,
        qty: leg.qty,
        lotSize: leg.lotSize,
        price: priceFor(leg),
        triggerPrice: Number(leg.triggerPrice) || 0,
        tradeType: leg.action,
        productType: leg.product,
        orderType: marginOrderType(leg.priceType),
      }));

      const post = (url) => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: marginClient, legs: legPayload }),
      }).then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status === false) throw new Error(body.message || `HTTP ${res.status}`);
        return body;
      });

      const [marginOut, chargesOut] = await Promise.allSettled([
        post('/api/angel/margin'),
        post('/api/angel/charges'),
      ]);
      if (cancelled) return;

      let nextSession = null;
      if (marginOut.status === 'fulfilled') {
        nextSession = marginOut.value.session || nextSession;
        setMargin({ status: 'ready', value: Number(marginOut.value.totalMarginRequired || 0), message: '' });
      } else {
        setMargin({ status: 'error', value: 0, message: marginOut.reason?.message || 'Margin failed' });
      }

      if (chargesOut.status === 'fulfilled') {
        nextSession = chargesOut.value.session || nextSession;
        setCharges({
          status: 'ready',
          value: Number(chargesOut.value.totalCharges || 0),
          breakup: chargesOut.value.breakup || null,
          message: '',
        });
      } else {
        setCharges({ status: 'error', value: 0, breakup: null, message: chargesOut.reason?.message || 'Charges failed' });
      }

      if (nextSession?.jwtToken && nextSession.jwtToken !== marginClientRef.current?.session?.jwtToken) {
        setMarginClient((current) => (current ? { ...current, session: nextSession } : current));
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [calcKey, marginClient, marginNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const placeBasket = useCallback(async () => {
    const client = marginClientRef.current;
    if (!client?.session?.jwtToken) throw new Error('Load the option chain on a logged-in account first');
    const selected = legsRef.current.filter((leg) => leg.selected !== false);
    if (!selected.length) throw new Error('Select at least one order');

    const legPayload = selected.map((leg) => ({
      token: leg.token,
      symbol: leg.tradingSymbol,
      exchange: leg.exchange,
      qty: leg.qty,
      lotSize: leg.lotSize,
      price: priceFor(leg),
      triggerPrice: Number(leg.triggerPrice) || 0,
      tradeType: leg.action,
      productType: leg.product,
      orderType: leg.priceType || 'MARKET',
    }));

    const response = await fetch('/api/angel/place-basket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client, legs: legPayload }),
    });
    const body = await response.json().catch(() => ({}));
    if (body.session?.jwtToken) {
      setMarginClient((current) => (current ? { ...current, session: body.session } : current));
      const clientIndex = clients.findIndex((item) => item.clientCode === client.clientCode);
      if (clientIndex >= 0) onClientSession?.(clientIndex, body.session);
    }
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    return body;
  }, [clients, onClientSession]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasLegs = legs.length > 0;
  const [basketRender, setBasketRender] = useState(hasLegs);
  const [basketOpen, setBasketOpen] = useState(hasLegs);
  useEffect(() => {
    if (hasLegs) {
      setBasketRender(true);
      const id = requestAnimationFrame(() => setBasketOpen(true));
      return () => cancelAnimationFrame(id);
    }
    setBasketOpen(false);
    const t = setTimeout(() => setBasketRender(false), 260);
    return () => clearTimeout(t);
  }, [hasLegs]);

  return (
    <section className={`strategies-view${basketRender ? '' : ' no-basket'}`}>
      <OptionChainPanel
        clients={clients}
        demoMode={demoMode}
        onClientSession={onClientSession}
        feedMasterClient={feedMasterClient}
        onFeedMasterSession={onFeedMasterSession}
        onAddLeg={addLeg}
        onMarginContext={setMarginClient}
        onExpiryIndex={setExpiryIndex}
        onLiveTicks={setLiveTicks}
      />
      {basketRender && (
        <Basket
          legs={legs}
          name="MY BASKET"
          className={basketOpen ? 'is-open' : 'is-closing'}
          margin={margin}
          charges={charges}
          expiryIndex={expiryIndex}
          liveTicks={liveTicks}
          onUpdateLeg={updateLeg}
          onResolveLeg={resolveLegContract}
          onStepStrike={stepStrike}
          onAddLeg={addLeg}
          onRemoveLeg={removeLeg}
          onRefreshMargin={refreshMargin}
          onPlaceBasket={placeBasket}
          onClear={clearLegs}
          onClose={clearLegs}
        />
      )}
    </section>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   Option chain panel (port of main.jsx OptionChainPanel).
   ══════════════════════════════════════════════════════════════════════ */
const OptionChainPanel = React.memo(function OptionChainPanel({
  clients,
  demoMode,
  feedMasterClient,
  onClientSession,
  onFeedMasterSession,
  onAddLeg,
  onMarginContext,
  onExpiryIndex,
  onLiveTicks,
}) {
  const [chainIndex, setChainIndex] = useState({});
  const [clientIndex, setClientIndex] = useState(0);
  const [symbol, setSymbol] = useState('');
  const [expiry, setExpiry] = useState('');
  const [status, setStatus] = useState('Loading master index...');
  const [chain, setChain] = useState(null);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState({});
  const [liveSpot, setLiveSpot] = useState(null);
  const [feedOn, setFeedOn] = useState(false);
  const esRef = useRef(null);
  const prevRef = useRef({});
  const autoLoadRef = useRef('');
  const tableWrapRef = useRef(null);
  const atmRowRef = useRef(null);
  const autoScrolledChainRef = useRef('');
  const [showAtmButton, setShowAtmButton] = useState(false);

  const liveRef = useRef({});
  const spotRef = useRef(null);
  const feedSpotTokenRef = useRef(null);
  const feedTokenSetRef = useRef(new Set());
  const dirtyRef = useRef(false);
  const rafRef = useRef(0);

  const symbolRef = useRef('');
  const expiryRef = useRef('');
  const exchangeRef = useRef('NFO');
  const lotSizeRef = useRef(1);
  const feedMasterClientRef = useRef(null);
  feedMasterClientRef.current = feedMasterClient;

  useEffect(() => () => {
    closeStream(esRef);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  const symbols = useMemo(() => {
    const preferred = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'CRUDEOIL', 'NATURALGAS', 'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'COPPER'];
    const all = Object.keys(chainIndex).sort();
    return [...preferred.filter((item) => all.includes(item)), ...all.filter((item) => !preferred.includes(item))];
  }, [chainIndex]);

  const loggedInIndexes = useMemo(
    () => clients.map((client, index) => (client.loggedIn ? index : -1)).filter((index) => index >= 0),
    [clients],
  );

  const expiries = chainIndex[symbol] || [];

  useEffect(() => {
    loadMasterIndex();
  }, []);

  useEffect(() => {
    if (!symbol && symbols.length) setSymbol(symbols[0]);
  }, [symbol, symbols]);

  useEffect(() => {
    if (loggedInIndexes.length && !loggedInIndexes.includes(clientIndex)) {
      setClientIndex(loggedInIndexes[0]);
    }
  }, [loggedInIndexes, clientIndex]);

  useEffect(() => {
    if (expiries.length && !expiries.includes(expiry)) setExpiry(expiries[0]);
  }, [expiries, expiry]);

  async function loadMasterIndex() {
    setStatus('Loading master index...');
    try {
      const response = await fetch('/api/angel/master-index');
      const body = await response.json();
      setChainIndex(body);
      onExpiryIndex?.(body);
      setStatus('Master ready');
    } catch (error) {
      setStatus(error.message || 'Master load failed');
    }
  }

  async function refreshMaster() {
    setLoading(true);
    setStatus('Refreshing master...');
    try {
      const response = await fetch('/api/angel/refresh-master', { method: 'POST' });
      const body = await response.json();
      if (!response.ok || body.status === false) throw new Error(body.message || 'Refresh failed');
      await loadMasterIndex();
      setStatus(`Master refreshed: ${body.totalTokens} tokens`);
    } catch (error) {
      setStatus(error.message || 'Refresh failed');
    } finally {
      setLoading(false);
    }
  }

  const canAuth = (c) => !!(c?.apiKey && (c.session?.jwtToken || (c.pin && c.totpSecret)));

  async function loadChain() {
    if (demoMode) {
      setStatus('Disable demo mode for live option chain');
      return;
    }
    let index = clientIndex;
    let client = clients[index];
    if (!canAuth(client)) {
      const found = clients.findIndex(canAuth);
      if (found >= 0) {
        index = found;
        client = clients[found];
        setClientIndex(found);
      }
    }
    if (!client) {
      setStatus('Select a client');
      return;
    }
    if (!client.apiKey) {
      setStatus('API key missing for selected client');
      return;
    }
    if (!client.session?.jwtToken && (!client.pin || !client.totpSecret)) {
      setStatus('Login first or add PIN and TOTP secret in Broker Config');
      return;
    }

    setLoading(true);
    if (!client.session?.jwtToken) {
      setStatus('Logging in...');
      try {
        const result = await liveLogin(client, '/api/angel/auto-login');
        const session = result.session || null;
        if (!session?.jwtToken) throw new Error('no session returned');
        onClientSession(index, session);
        client = { ...client, loggedIn: true, session };
      } catch (error) {
        setLoading(false);
        autoLoadRef.current = '';
        setStatus(`Login failed: ${error.message || 'auto-login'}`);
        return;
      }
    }

    setStatus('Loading option chain...');
    try {
      const skelRes = await fetch('/api/angel/all-scrip-options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client, TradeSymbol: symbol, ExpiryDate: expiry }),
      });
      const skeleton = await skelRes.json().catch(() => ({}));
      if (!skelRes.ok || skeleton.status === false) throw new Error(skeleton.message || `HTTP ${skelRes.status}`);

      setLive({});
      onLiveTicks?.({});
      setLiveSpot(null);
      prevRef.current = {};
      liveRef.current = {};
      spotRef.current = null;
      dirtyRef.current = false;

      const liveSession = skeleton.session || client.session || null;
      const liveClient = { ...client, session: liveSession };

      setChain(skeleton);
      onClientSession(index, liveSession);
      onMarginContext?.(liveClient);
      setStatus(`Loaded ${skeleton.symbol} ${skeleton.expiry} (${skeleton.count} scrips)`);
      startLiveFeed(skeleton);

      fetch('/api/angel/chain-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: liveClient, TradeSymbol: symbol, ExpiryDate: expiry }),
      })
        .then((r) => r.json().catch(() => ({})))
        .then((p) => {
          if (!p || p.status === false || !Array.isArray(p.strikes)) return;
          setChain((current) => {
            if (!current || current.symbol !== skeleton.symbol || current.expiry !== skeleton.expiry) return current;
            return {
              ...current,
              spot: p.spot ?? current.spot,
              atm: p.atm ?? current.atm,
              pcr: p.pcr ?? current.pcr ?? 0,
              callOI: p.callOI, putOI: p.putOI,
              callLtp: p.callLtp, putLtp: p.putLtp,
              callClose: p.callClose, putClose: p.putClose,
            };
          });
        })
        .catch(() => {});
    } catch (error) {
      autoLoadRef.current = '';
      setStatus(error.message || 'Option chain failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!symbol || !expiry || loading || demoMode) return;
    if (!clients.some(canAuth)) return;

    const key = `${symbol}|${expiry}`;
    if (autoLoadRef.current === key) return;
    autoLoadRef.current = key;
    loadChain();
  }, [clients, symbol, expiry, loading, demoMode]); // eslint-disable-line react-hooks/exhaustive-deps

  symbolRef.current = symbol;
  expiryRef.current = expiry;
  exchangeRef.current = chain?.exchange || 'NFO';
  lotSizeRef.current = Number(chain?.lotSize) || 1;

  const onTrade = useCallback((side, action, strike, token, ltp, changePctVal, tradingSymbol, close) => {
    onAddLeg?.({
      symbol: symbolRef.current,
      tradingSymbol: tradingSymbol || null,
      expiry: expiryRef.current,
      exchange: exchangeRef.current,
      lotSize: lotSizeRef.current,
      strike,
      optionType: side === 'call' ? 'CE' : 'PE',
      action,
      product: 'CF',
      qty: 1,
      price: '',
      priceType: 'MARKET',
      ltp: ltp ?? null,
      close: close ?? null,
      changePct: changePctVal ?? null,
      token: token ?? null,
      selected: true,
    });
    setStatus(`${action} ${side.toUpperCase()} ${strike} added to basket`);
  }, [onAddLeg]);

  async function startLiveFeed(body) {
    const tokens = body.liveTokens || [];
    if (!tokens.length) {
      setStatus('Loaded (no live tokens available)');
      feedSpotTokenRef.current = null;
      feedTokenSetRef.current = new Set();
      setFeedOn(false);
      return;
    }

    let feedCredentials = body.feed || null;
    const masterClient = feedMasterClientRef.current;
    if (masterClient) {
      let masterSession = masterClient.session;
      if (!masterSession?.jwtToken || !masterSession?.feedToken) {
        setStatus('Logging in Feedmaster for live feed...');
        const login = await loginAngelClient(masterClient);
        masterSession = login.session || null;
        if (masterSession?.jwtToken) onFeedMasterSession?.(masterSession);
      }

      feedCredentials = masterSession?.jwtToken && masterSession?.feedToken ? {
        jwtToken: masterSession.jwtToken,
        feedToken: masterSession.feedToken,
        apiKey: masterClient.apiKey,
        clientCode: masterClient.clientCode,
      } : null;
    }

    if (!feedCredentials?.feedToken) {
      setStatus(masterClient ? 'Loaded (Feedmaster has no feed token)' : 'Loaded (live feed unavailable - no feed token)');
      feedSpotTokenRef.current = null;
      feedTokenSetRef.current = new Set();
      setFeedOn(false);
      return;
    }

    feedSpotTokenRef.current = body.spotToken ? String(body.spotToken) : null;
    feedTokenSetRef.current = new Set(tokens.map((token) => String(token)));
    if (body.spotToken) feedTokenSetRef.current.add(String(body.spotToken));

    try {
      const res = await fetch('/api/angel/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credentials: feedCredentials,
          exchange: body.exchange,
          tokens,
          spot: body.spotToken ? { token: body.spotToken, exchange: body.spotExchange } : null,
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || out.status === false) throw new Error(out.message || 'Subscribe failed');
    } catch (error) {
      setStatus(`Live feed: ${error.message}`);
      return;
    }

    let source = esRef.current;
    if (!source || source.readyState === 2) {
      source = new EventSource('/api/angel/stream');
      esRef.current = source;
      source.addEventListener('status', (event) => {
        try {
          const info = JSON.parse(event.data);
          setFeedOn(Boolean(info.connected));
        } catch {}
      });
      source.onerror = () => setFeedOn(false);
    }

    source.onmessage = (event) => {
      let tick;
      try { tick = JSON.parse(event.data); } catch { return; }
      const token = String(tick.token);
      if (!feedTokenSetRef.current.has(token)) return;
      const prev = prevRef.current[token];
      const dir = prev == null ? '' : tick.ltp > prev ? 'up' : tick.ltp < prev ? 'down' : '';
      prevRef.current[token] = tick.ltp;
      const at = event.timeStamp || performance.now();
      if (token === feedSpotTokenRef.current) {
        spotRef.current = { ltp: tick.ltp, dir, at };
      } else {
        liveRef.current[token] = { ltp: tick.ltp, oi: tick.oi, close: tick.close, dir, at };
      }
      scheduleFlush();
    };
  }

  function scheduleFlush() {
    dirtyRef.current = true;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      if (spotRef.current) setLiveSpot(spotRef.current);
      const snapshot = { ...liveRef.current };
      setLive(snapshot);
      onLiveTicks?.(snapshot);
    });
  }

  const maxOi = useMemo(() => {
    const all = [...(chain?.callOI || []), ...(chain?.putOI || [])].map(Number);
    return all.length ? Math.max(...all, 0) : 0;
  }, [chain]);

  const symbolMeta = useMemo(() => classifySymbol(symbol), [symbol]);
  const expiryKinds = useMemo(() => classifyExpiries(expiries), [expiries]);

  const liveAtm = useMemo(() => {
    const price = liveSpot?.ltp;
    const strikes = chain?.strikes;
    if (!price || !strikes?.length) return null;
    return nearestStrike(strikes, price);
  }, [liveSpot, chain]);

  const snapshotAtm = useMemo(() => {
    const value = Number(chain?.atm || 0);
    if (value > 0) return value;
    const spot = Number(chain?.spot || 0);
    if (spot > 0 && chain?.strikes?.length) return nearestStrike(chain.strikes, spot);
    return null;
  }, [chain]);

  const atm = liveAtm ?? snapshotAtm;
  const hasAtm = atm != null && atm > 0;
  const chainScrollKey = chain && hasAtm
    ? `${chain.symbol}|${chain.expiry}|${chain.count || chain.strikes?.length || 0}`
    : '';

  const syncAtmButton = useCallback(() => {
    const wrap = tableWrapRef.current;
    const row = atmRowRef.current;
    if (!wrap || !row || !hasAtm) {
      setShowAtmButton(false);
      return;
    }

    const wrapRect = wrap.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const visible = rowRect.top >= wrapRect.top + 72 && rowRect.bottom <= wrapRect.bottom - 28;
    setShowAtmButton(!visible);
  }, [hasAtm]);

  const scrollToAtm = useCallback((behavior = 'smooth') => {
    const wrap = tableWrapRef.current;
    const row = atmRowRef.current;
    if (!wrap || !row) return;

    const target = row.offsetTop - (wrap.clientHeight / 2) + (row.clientHeight / 2);
    wrap.scrollTo({ top: Math.max(0, target), behavior });
    window.setTimeout(syncAtmButton, behavior === 'auto' ? 30 : 280);
  }, [syncAtmButton]);

  useEffect(() => {
    if (!chainScrollKey || autoScrolledChainRef.current === chainScrollKey) return;
    autoScrolledChainRef.current = chainScrollKey;
    requestAnimationFrame(() => scrollToAtm('smooth'));
  }, [chainScrollKey, scrollToAtm]);

  useEffect(() => {
    syncAtmButton();
  }, [atm, chainScrollKey, syncAtmButton]);

  return (
    <aside className="option-chain-panel">
      <header className="chain-titlebar">
        <h1>Option Chain</h1>
        <div className="chain-window-actions">
          <span className={`live-pill ${feedOn ? 'on' : 'off'}`} title={feedOn ? 'WebSocket connected - streaming ticks' : 'Live feed disconnected'}>
            <span className="live-dot" />{feedOn ? 'LIVE' : 'OFF'}
          </span>
        </div>
      </header>

      <div className="chain-controls">
        <PillSelect
          title="Symbol"
          searchable
          searchPlaceholder="Search underlying..."
          value={symbol}
          onChange={setSymbol}
          options={symbols.map((item) => {
            const meta = classifySymbol(item);
            const isIndex = meta.kind === 'Index';
            return {
              value: item,
              label: item,
              pill: isIndex ? 'IDX' : meta.kind === 'Commodity' ? 'COMM' : 'EQ',
              pillClass: isIndex ? 'pill-idx' : meta.kind === 'Commodity' ? 'pill-comm' : 'pill-eq',
            };
          })}
        />
        <PillSelect
          title="Expiry"
          value={expiry}
          onChange={setExpiry}
          options={expiries.map((item) => {
            const monthly = expiryKinds[item] === 'Monthly';
            return {
              value: item,
              label: formatExpiry(item),
              pill: monthly ? 'M' : 'W',
              pillClass: monthly ? 'pill-monthly' : 'pill-weekly',
            };
          })}
        />
        <button className="chain-icon-btn" disabled={loading} onClick={refreshMaster} type="button" title="Refresh master">↻</button>
        <button className="load-chain-btn" disabled={loading} onClick={loadChain} type="button">
          {loading && <LoaderCircle className="load-chain-spinner" size={14} />}
          <span>{loading ? 'LOADING' : 'LOAD'}</span>
        </button>
      </div>

      {symbol && (
        <div className="chain-tags" aria-label="Instrument details">
          <span className="tag-symbol">{symbol}</span>
          <span className={`tag seg-${symbolMeta.segment.toLowerCase()}`}>{symbolMeta.segment}</span>
          <span className={`tag kind-${symbolMeta.kind.toLowerCase()}`}>{symbolMeta.kind}</span>
          {expiry && expiryKinds[expiry] && (
            <span className={`tag exp-${expiryKinds[expiry].toLowerCase()}`}>
              {expiryKinds[expiry]}
            </span>
          )}
        </div>
      )}

      <div className="chain-table-wrap" ref={tableWrapRef} onScroll={syncAtmButton}>
        <table className="chain-table">
          <colgroup>
            <col className="col-oi" />
            <col className="col-chg" />
            <col className="col-ltp" />
            <col className="col-action" />
            <col className="col-strike" />
            <col className="col-action" />
            <col className="col-ltp" />
            <col className="col-chg" />
            <col className="col-oi" />
          </colgroup>
          <thead>
            <tr className="chain-side-head">
              <th className="side-call" colSpan="4">CALL</th>
              <th className="side-strike">STRIKE</th>
              <th className="side-put" colSpan="4">PUT</th>
            </tr>
            <tr>
              <th>OI</th>
              <th>Chng%</th>
              <th className="ltp-head">LTP</th>
              <th>Action</th>
              <th>Strike</th>
              <th>Action</th>
              <th className="ltp-head">LTP</th>
              <th>Chng%</th>
              <th>OI</th>
            </tr>
          </thead>
          <tbody>
            {(chain?.strikes || []).map((strike, index) => {
              const callTick = live[chain.callTokens?.[index]];
              const putTick = live[chain.putTokens?.[index]];
              return (
                <ChainRow
                  key={strike}
                  rowRef={hasAtm && strike === atm ? atmRowRef : null}
                  strike={strike}
                  isAtm={hasAtm && strike === atm}
                  callItm={hasAtm && strike < atm}
                  putItm={hasAtm && strike > atm}
                  callLtp={callTick?.ltp ?? chain.callLtp?.[index]}
                  putLtp={putTick?.ltp ?? chain.putLtp?.[index]}
                  callOi={Number(callTick?.oi ?? chain.callOI?.[index] ?? 0)}
                  putOi={Number(putTick?.oi ?? chain.putOI?.[index] ?? 0)}
                  callClose={callTick?.close ?? chain.callClose?.[index]}
                  putClose={putTick?.close ?? chain.putClose?.[index]}
                  callDir={callTick?.dir || ''}
                  putDir={putTick?.dir || ''}
                  callAt={callTick?.at || 0}
                  putAt={putTick?.at || 0}
                  callToken={chain.callTokens?.[index] || null}
                  putToken={chain.putTokens?.[index] || null}
                  callSymbol={chain.callSymbols?.[index] || null}
                  putSymbol={chain.putSymbols?.[index] || null}
                  onTrade={onTrade}
                  maxOi={maxOi}
                />
              );
            })}
            {!chain && (
              <tr>
                <td className="chain-empty" colSpan="9">Select expiry and load chain</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {showAtmButton && (
        <button className="atm-jump-btn" type="button" onClick={() => scrollToAtm()} title="Back to ATM strike">
          <Crosshair size={15} />
          <span className="atm-jump-label">ATM</span>
          <strong>{atm}</strong>
        </button>
      )}
      <div className="chain-status-line">{status}</div>
    </aside>
  );
});

const ChainRow = React.memo(function ChainRow({
  rowRef, strike, isAtm, callItm, putItm,
  callLtp, putLtp, callOi, putOi, callClose, putClose,
  callDir, putDir, callAt, putAt, callToken, putToken,
  callSymbol, putSymbol, onTrade, maxOi,
}) {
  const callChg = changePct(callLtp, callClose);
  const putChg = changePct(putLtp, putClose);
  const callWidth = maxOi ? Math.round((callOi / maxOi) * 100) : 0;
  const putWidth = maxOi ? Math.round((putOi / maxOi) * 100) : 0;
  return (
    <tr ref={rowRef} className={isAtm ? 'atm-row' : ''}>
      <td className={`oi call-oi${callItm ? ' itm-call' : ''}`}>
        <span className="oi-bar" style={{ width: `${callWidth}%` }} />
        <span className="oi-val">{formatQty(callOi)}</span>
      </td>
      <td className={`chg ${chgClass(callChg)}${callItm ? ' itm-call' : ''}`}>{formatChange(callChg)}</td>
      <td className={`ltp call-ltp${callItm ? ' itm-call' : ''}${callDir ? ` flash-${callDir}` : ''}`} key={`cl-${callAt}`}>
        <span className="ltp-val">{formatPrice(callLtp)}</span>
      </td>
      <td className={`action call-action${callItm ? ' itm-call' : ''}`}>
        <TradeActions side="call" strike={strike} token={callToken} symbol={callSymbol} ltp={callLtp} chg={callChg} close={callClose} onTrade={onTrade} />
      </td>
      <td className="strike">{strike}</td>
      <td className={`action put-action${putItm ? ' itm-put' : ''}`}>
        <TradeActions side="put" strike={strike} token={putToken} symbol={putSymbol} ltp={putLtp} chg={putChg} close={putClose} onTrade={onTrade} />
      </td>
      <td className={`ltp put-ltp${putItm ? ' itm-put' : ''}${putDir ? ` flash-${putDir}` : ''}`} key={`pl-${putAt}`}>
        <span className="ltp-val">{formatPrice(putLtp)}</span>
      </td>
      <td className={`chg ${chgClass(putChg)}${putItm ? ' itm-put' : ''}`}>{formatChange(putChg)}</td>
      <td className={`oi put-oi${putItm ? ' itm-put' : ''}`}>
        <span className="oi-bar" style={{ width: `${putWidth}%` }} />
        <span className="oi-val">{formatQty(putOi)}</span>
      </td>
    </tr>
  );
});

const TradeActions = React.memo(function TradeActions({ side, strike, token, symbol, ltp, chg, close, onTrade }) {
  const label = side === 'call' ? 'Call' : 'Put';
  const disabled = !token;
  return (
    <div className="trade-actions" role="group" aria-label={`${label} actions`}>
      <button
        className="trade-btn buy"
        type="button"
        title={`Buy ${label} ${strike}`}
        disabled={disabled}
        onClick={() => onTrade?.(side, 'BUY', strike, token, ltp, chg, symbol, close)}
      >B</button>
      <button
        className="trade-btn sell"
        type="button"
        title={`Sell ${label} ${strike}`}
        disabled={disabled}
        onClick={() => onTrade?.(side, 'SELL', strike, token, ltp, chg, symbol, close)}
      >S</button>
    </div>
  );
});

function closeStream(ref) {
  if (ref.current) {
    ref.current.close();
    ref.current = null;
  }
}

/* Custom dropdown with a colored pill badge beside each option. */
function PillSelect({ title, value, onChange, options, searchable = false, searchPlaceholder = 'Search...' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const selected = options.find((o) => o.value === value);

  const visibleOptions = useMemo(() => {
    if (!searchable || !query.trim()) return options;
    const needle = query.trim().toLowerCase();
    return options.filter((o) =>
      String(o.label).toLowerCase().includes(needle) || String(o.value).toLowerCase().includes(needle));
  }, [options, query, searchable]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    if (searchable) {
      const id = requestAnimationFrame(() => searchRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [open, searchable]);

  function pick(optionValue) {
    onChange(optionValue);
    setOpen(false);
  }

  function onSearchKeyDown(event) {
    if (event.key === 'Enter' && visibleOptions.length) {
      event.preventDefault();
      pick(visibleOptions[0].value);
    }
  }

  return (
    <div className={`pill-select${open ? ' open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="pill-select-trigger"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pill-select-label">{selected?.label ?? value ?? title}</span>
        {selected?.pill && <span className={`opt-pill ${selected.pillClass}`}>{selected.pill}</span>}
        <span className="pill-select-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="pill-select-menu" role="listbox">
          {searchable && (
            <div className="pill-select-search">
              <Search className="pill-select-search-icon" size={14} aria-hidden="true" />
              <input
                ref={searchRef}
                type="text"
                className="pill-select-search-input"
                placeholder={searchPlaceholder}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
              />
              {query && (
                <button
                  type="button"
                  className="pill-select-search-clear"
                  title="Clear search"
                  onClick={() => { setQuery(''); searchRef.current?.focus(); }}
                ><X size={13} /></button>
              )}
            </div>
          )}
          <ul className="pill-select-list">
            {visibleOptions.map((option) => (
              <li
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                className={`pill-select-option${option.value === value ? ' active' : ''}`}
                onClick={() => pick(option.value)}
              >
                <span className="pill-select-label">{option.label}</span>
                {option.pill && <span className={`opt-pill ${option.pillClass}`}>{option.pill}</span>}
              </li>
            ))}
            {!visibleOptions.length && (
              <li className="pill-select-empty">No matches for "{query}"</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   Helpers (ported from main.jsx).
   ══════════════════════════════════════════════════════════════════════ */
async function liveLogin(client, backendUrl) {
  const response = await fetch(backendUrl || '/api/angel/auto-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status === false) throw new Error(body.message || `HTTP ${response.status}`);

  return {
    availableMargin: pickMargin(body),
    availableCash: body.data?.availablecash ?? 0,
    collateral: body.data?.collateral ?? 0,
    utilisedPayout: body.data?.utilisedpayout ?? 0,
    sessionSource: body.sessionSource,
    session: body.session || null,
  };
}

function pickMargin(body) {
  return body.availableMargin ?? body.data?.net ?? body.data?.availablecash ?? body.data?.availablelimitmargin ?? body.data?.collateral ?? 0;
}

const MCX_SYMBOLS = new Set([
  'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'CRUDEOIL', 'CRUDEOILM',
  'NATURALGAS', 'NATGASMINI', 'COPPER', 'ZINC', 'MCXBULLDEX',
]);
const INDEX_SYMBOLS = new Set([
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50',
  'SENSEX', 'BANKEX', 'SENSEX50',
]);
const BSE_SYMBOLS = new Set(['SENSEX', 'BANKEX', 'SENSEX50']);

function classifySymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (MCX_SYMBOLS.has(s)) return { segment: 'MCX', kind: 'Commodity' };
  if (BSE_SYMBOLS.has(s)) return { segment: 'BSE', kind: 'Index' };
  if (INDEX_SYMBOLS.has(s)) return { segment: 'NSE', kind: 'Index' };
  return { segment: 'NSE', kind: 'Stock' };
}

function classifyExpiries(expiries = []) {
  const parsed = expiries
    .map((e) => ({ e, ms: Date.parse(e) }))
    .filter((x) => !Number.isNaN(x.ms))
    .sort((a, b) => a.ms - b.ms);

  const lastOfMonth = new Map();
  for (const { ms } of parsed) {
    const d = new Date(ms);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (!lastOfMonth.has(key) || ms > lastOfMonth.get(key)) lastOfMonth.set(key, ms);
  }

  const result = {};
  for (const { e, ms } of parsed) {
    const d = new Date(ms);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    result[e] = lastOfMonth.get(key) === ms ? 'Monthly' : 'Weekly';
  }
  return result;
}

function strikeStepFor(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (s === 'BANKNIFTY' || s === 'SENSEX' || s === 'BANKEX') return 100;
  return 50;
}

function marginOrderType(value) {
  const type = String(value || '').toUpperCase();
  return type === 'LIMIT' || type === 'SL' ? 'LIMIT' : 'MARKET';
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSpot(value) {
  const number = Number(value || 0);
  return number > 0 ? formatMoney(number) : '-';
}

function nearestStrike(strikes = [], price) {
  const number = Number(price || 0);
  if (!number || !strikes.length) return null;
  return strikes.reduce((best, s) => (Math.abs(s - number) < Math.abs(best - number) ? s : best), strikes[0]);
}

function formatPrice(value) {
  const number = Number(value || 0);
  return number ? `₹${number.toFixed(2)}` : '-';
}

function formatQty(value) {
  const number = Number(value || 0);
  return number ? number.toLocaleString('en-IN') : '-';
}

function changePct(ltp, close) {
  const l = Number(ltp || 0);
  const c = Number(close || 0);
  if (!l || !c) return null;
  return ((l - c) / c) * 100;
}

function formatChange(pct) {
  if (pct == null) return '-';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function chgClass(pct) {
  if (pct == null) return 'chg-flat';
  return pct > 0 ? 'chg-up' : pct < 0 ? 'chg-down' : 'chg-flat';
}

function formatExpiry(value) {
  const match = String(value || '').match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!match) return value;
  return `${match[1]} ${titleCase(match[2])} ${match[3]}`;
}

function titleCase(value) {
  return `${value.slice(0, 1)}${value.slice(1).toLowerCase()}`;
}
