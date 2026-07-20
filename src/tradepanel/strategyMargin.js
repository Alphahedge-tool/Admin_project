// Per-strategy "Margin Used" for the Client Dashboard.
//
// Each broker's margin calculator prices a whole basket at once and nets the
// hedge benefit across its legs, so the margin to DEPLOY a saved strategy is one
// call over that strategy's legs:
//   - Angel   -> /api/angel/margin          (SmartAPI margin/v1/batch)
//   - Zerodha -> /api/zerodha/basket-margin  (Kite /margins/basket, final.total)
// Both endpoints take the same { client, legs } request and answer with the same
// { totalMarginRequired }, so everything below is broker-agnostic bar the URL.
// Other brokers (Kotak) have no such calculator wired, so they carry no metric.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ensureAccountsLoaded, ensureSession, getAngelClient, hasToken,
  isAngelBroker, isKotakBroker, isZerodhaBroker,
} from '../feedmaster/angelSessionStore';

const MARGIN_URLS = {
  angel: '/api/angel/margin',
  zerodha: '/api/zerodha/basket-margin',
  kotak: '/api/kotak/basket-margin',
};

// How many DISTINCT accounts sign in at once. The backend logs an account in from
// the session we post - it keeps no server-side session of its own - so an
// account with no live token would re-login on every margin call (Angel even
// rejects a TOTP reused inside its 30s window). So each account is signed in ONCE
// here through the store's deduped ensureSession() and that one session is reused
// across all of its strategies. Bounded low because Angel caps logins at ~1/sec.
const ACCOUNT_CONCURRENCY = 2;

// Which margin calculator (if any) a strategy's broker uses.
function marginBrokerOf(name) {
  if (isAngelBroker(name)) return 'angel';
  if (isZerodhaBroker(name)) return 'zerodha';
  if (isKotakBroker(name)) return 'kotak';
  return '';
}

// A live session in the shape this broker mints: Angel a jwtToken, Kite an
// accessToken. Used to confirm ensureSession() actually produced one before we
// bother the margin endpoint.
function sessionReady(broker, client) {
  if (!client) return false;
  // The store already knows each broker's token shape (Kotak needs a tradeToken,
  // sid AND baseUrl, not just one field), so defer to it rather than restating
  // the rules here and drifting out of step.
  return hasToken(broker, client.session || client);
}

// One saved strategy leg -> the shared margin-calculator leg shape (the same
// payload Enter Trade sends Angel). net_qty is already in UNITS (a lot's worth of
// contracts), so lotSize stays 1 and the sign picks the trade side. Angel keys off
// `token`, Kite off `symbol` - the leg carries both, each backend reads its own.
function marginLeg(leg) {
  const netQty = Number(leg.net_qty || 0);
  const qty = Math.abs(netQty);
  const symbol = leg.trading_symbol || leg.symbol_name || leg.symbol || '';
  const token = leg.symbol_token != null ? String(leg.symbol_token) : '';
  if ((!token && !symbol) || qty <= 0) return null;
  const isBuy = netQty >= 0;
  const price = Number(leg.ltp) || (isBuy ? Number(leg.buy_avg) : Number(leg.sell_avg)) || 0;
  return {
    token,
    symbol,
    exchange: leg.exchange || 'NFO',
    qty,
    lotSize: 1,
    price,
    tradeType: isBuy ? 'BUY' : 'SELL',
    productType: leg.product_type || 'CARRYFORWARD',
    orderType: 'MARKET',
  };
}

// What makes a basket's margin change: its legs' contracts, sizes and sides. Price
// is deliberately left out so live LTP ticks don't re-trigger a fetch every
// second - the deploy margin barely moves with a tick, and re-pricing on each one
// would hammer the broker.
function legsSignature(legs) {
  return legs.map((l) => `${l.token || l.symbol}:${l.qty}:${l.tradeType}:${l.productType}`).sort().join(',');
}

// Same key the dashboard cards use, so the returned map lines up 1:1 with them.
function strategyKey(strategy) {
  return String(strategy.id ?? `${strategy._userLabel || ''}::${strategy.strategy_code}`);
}

// margins: { [cardKey]: { status: 'loading'|'ready'|'error', value, message } }
// Only Angel/Zerodha strategies appear in the map; the dashboard shows nothing for
// the rest.
export function useStrategyMargins(strategies) {
  const [margins, setMargins] = useState({});
  // `${configId}|${legsSig}` -> value. Survives re-renders so switching scope and
  // coming back, or a live tick re-running the memo, never re-hits the broker.
  const cacheRef = useRef(new Map());

  // Every margin-capable strategy on screen gets an entry - even one we can't
  // price - so a card never sits on the loading placeholder forever.
  const marginStrategies = useMemo(() => (strategies || [])
    .map((strategy) => {
      const broker = marginBrokerOf(strategy.broker_name);
      if (!broker) return null;
      const legs = (strategy.legs || []).map(marginLeg).filter(Boolean);
      return {
        key: strategyKey(strategy),
        broker,
        configId: String(strategy.broker_config_id || ''),
        legs,
        sig: legsSignature(legs),
      };
    })
    .filter(Boolean),
  [strategies]);

  const targets = useMemo(
    () => marginStrategies.filter((target) => target.configId && target.legs.length > 0),
    [marginStrategies],
  );

  // A stable fingerprint of the work to do: the effect only re-runs when the set
  // of baskets (or their sizes/sides) actually changes.
  const targetsSig = useMemo(
    () => marginStrategies.map((target) => `${target.key}#${target.broker}#${target.configId}#${target.sig}`).join('|'),
    [marginStrategies],
  );

  useEffect(() => {
    let cancelled = false;
    if (!marginStrategies.length) {
      setMargins({});
      return undefined;
    }

    const fail = (keys, message) => {
      if (cancelled) return;
      setMargins((m) => {
        const next = { ...m };
        keys.forEach((key) => { next[key] = { status: 'error', value: 0, message }; });
        return next;
      });
    };

    (async () => {
      // The dashboard doesn't sign accounts in itself; make sure the store at
      // least knows them so ensureSession()/getAngelClient() have credentials.
      await ensureAccountsLoaded();
      if (cancelled) return;

      // Seed every strategy: cached baskets show instantly, priceable ones go to
      // 'loading' (keeping a previous 'ready' value on screen so nothing flickers),
      // and ones we can't price get a terminal em-dash state now rather than a
      // spinner that never resolves.
      setMargins((prev) => {
        const next = {};
        for (const target of marginStrategies) {
          if (!target.legs.length) {
            next[target.key] = { status: 'error', value: 0, message: 'No open legs to margin' };
            continue;
          }
          if (!target.configId) {
            next[target.key] = { status: 'error', value: 0, message: 'No broker account linked to this strategy' };
            continue;
          }
          const cached = cacheRef.current.get(`${target.configId}|${target.sig}`);
          if (cached != null) {
            next[target.key] = {
              status: 'ready', value: cached.value, netted: cached.netted, message: '',
            };
          }
          else if (prev[target.key]?.status === 'ready') next[target.key] = prev[target.key];
          else next[target.key] = { status: 'loading', value: 0, message: '' };
        }
        return next;
      });

      // Group the still-uncached baskets by account: one sign-in per account, its
      // session reused across all of its strategies. (A config is one broker, so a
      // group's broker is well-defined.)
      const byConfig = new Map();
      for (const target of targets) {
        if (cacheRef.current.has(`${target.configId}|${target.sig}`)) continue;
        if (!byConfig.has(target.configId)) byConfig.set(target.configId, []);
        byConfig.get(target.configId).push(target);
      }

      const configs = [...byConfig.keys()];
      let index = 0;
      const worker = async () => {
        while (index < configs.length && !cancelled) {
          const configId = configs[index];
          index += 1;
          const group = byConfig.get(configId);
          const broker = group[0].broker;
          const url = MARGIN_URLS[broker];

          // One deduped login for the whole account; the store hands back (and
          // caches) a live session other Trade Panel pages share too. A Zerodha
          // account still needing its one-time browser login surfaces here as the
          // sign-in error, shown on the card.
          try {
            await ensureSession(configId);
          } catch (error) {
            fail(group.map((target) => target.key), error?.message || 'Sign-in failed');
            continue;
          }
          if (cancelled) return;

          const client = getAngelClient(configId);
          if (!sessionReady(broker, client)) {
            fail(group.map((target) => target.key), 'Account not signed in');
            continue;
          }

          // Price this account's baskets one after another - margin reads are
          // cheap and all reuse the single session just obtained.
          for (const target of group) {
            if (cancelled) return;
            try {
              const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ client, legs: target.legs }),
              });
              const body = await res.json().catch(() => ({}));
              if (!res.ok || body.status === false) throw new Error(body.message || `HTTP ${res.status}`);
              const value = Number(body.totalMarginRequired || 0);
              // Angel and Kite net the hedge across a basket; Kotak can only
              // price leg-by-leg, so its total is gross. Carried through so a
              // card can mark an estimate rather than imply all three are
              // equally exact.
              const netted = body.netted !== false;
              cacheRef.current.set(`${target.configId}|${target.sig}`, { value, netted });
              if (!cancelled) {
                setMargins((m) => ({ ...m, [target.key]: { status: 'ready', value, netted, message: '' } }));
              }
            } catch (error) {
              fail([target.key], error?.message || 'Margin failed');
            }
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(ACCOUNT_CONCURRENCY, configs.length) }, worker));
    })();

    return () => { cancelled = true; };
  }, [targetsSig]); // eslint-disable-line react-hooks/exhaustive-deps

  return margins;
}
