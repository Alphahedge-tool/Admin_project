// Node SmartAPI proxy for the admin Trade Panel. Exposes the same /api/angel/*
// surface the option chain + basket frontend expects. Port of the Go httpapi.
import express from 'express';
import cors from 'cors';
import WebSocket from 'ws';

import { config } from './src/config.js';
import { Client } from './src/httpClient.js';
import { Auth } from './src/auth.js';
import * as kotak from './src/kotak.js';
import { MasterStore } from './src/master.js';
import { allScripOptions } from './src/scripoptions.js';
import {
  scripOptionsWithSpot, chainPrices, getOptionChain, resolveLeg,
} from './src/market.js';
import { getMargin, getCharges, placeBasket, book } from './src/orders.js';
import { getHistoricalCandle } from './src/historical.js';
import { Feed, wsType } from './src/feed.js';
import { BrokerInstrumentManager } from './src/instruments/manager.js';
import { mapKotakPositionToAngelFeed } from './src/instruments/positionRouter.js';
import { KotakUserStream } from './src/kotakUserStream.js';
import { KotakHsmRegistry } from './src/kotakHsmFeed.js';

const client = new Client();
const auth = new Auth(client);
const master = new MasterStore();
const instruments = new BrokerInstrumentManager(master);
const feed = new Feed();
const kotakFeeds = new KotakHsmRegistry();

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));

// Small wrapper so async handlers report errors as { status:false, message }.
const h = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ status: false, message: err.message || 'Server error' });
  }
};

// ── auth ─────────────────────────────────────────────────────────────────────
app.post('/api/angel/auto-login', h(async (req) => {
  const cc = req.body?.client || {};
  return auth.autoLogin(cc);
}));

app.post('/api/angel/logout', (req, res) => {
  res.json({ status: true, message: 'Logged out' });
});

// Kotak Neo logs in headlessly (TOTP + MPIN), like Angel, so it gets the same
// auto-login endpoint shape. The rest of Trade Panel - option chain, feed,
// orders - is still Angel-only; this authenticates the account and nothing more.
app.post('/api/kotak/auto-login', h(async (req) => {
  const credentials = req.body?.client || {};
  const result = await kotak.autoLogin(credentials);
  try {
    result.instrumentMaster = await instruments.loadSessionBroker('kotak', {
      accessToken: credentials.accessToken || credentials.app_secret,
      baseUrl: result.session?.baseUrl,
    });
  } catch (error) {
    result.instrumentMaster = `error: ${error.message}`;
  }
  try {
    const funds = await kotak.limits({ ...credentials, session: result.session });
    result.availableMargin = funds.limits.availableCash;
    result.marginSource = 'kotak-limits';
    result.limits = funds.limits;
  } catch (error) {
    // A temporary funds failure must not discard an otherwise valid login.
    result.limits = { error: error.message };
  }
  return result;
}));

// ── normalized broker instrument masters ───────────────────────────────────
// One canonical contract resolves to the selected broker's own token, trading
// symbol and exchange segment. Orders/WebSockets will consume this layer in the
// next integration phase; these endpoints make the mapping inspectable now.
app.get('/api/master/status', h(async () => ({ status: true, masters: instruments.status() })));

app.post('/api/master/refresh', h(async (req) => ({
  status: true,
  result: await instruments.loadAngel({ force: req.body?.force !== false }),
  masters: instruments.status(),
})));

app.post('/api/master/refresh-session', h(async (req) => {
  const body = req.body || {};
  const client = body.client || body;
  const broker = String(body.broker || client.broker || '').toLowerCase();
  if (!broker) throw new Error('broker is required');
  const credentials = broker === 'kotak'
    ? {
      accessToken: client.accessToken || client.app_secret,
      baseUrl: client.baseUrl || client.session?.baseUrl,
    }
    : {
      apiKey: client.apiKey || client.app_key || client.session?.apiKey,
      accessToken: client.accessToken || client.session?.accessToken,
    };
  const result = await instruments.loadSessionBroker(broker, credentials, { force: body.force !== false });
  return { status: true, broker, result, masters: instruments.status() };
}));

app.get('/api/master/resolve', h(async (req) => {
  const broker = String(req.query.broker || '').toLowerCase();
  const symbol = String(req.query.symbol || '').toUpperCase();
  const exchange = String(req.query.exchange || '').toUpperCase();
  if (!broker || !symbol) throw new Error('broker and symbol are required');
  const instrument = instruments.resolve(broker, symbol, exchange);
  return instrument
    ? { status: true, broker, symbol, exchange, instrument }
    : { status: false, broker, symbol, exchange, message: `Instrument not found for ${broker}` };
}));

app.get('/api/master/route', h(async (req) => {
  const symbol = String(req.query.symbol || '').toUpperCase();
  const exchange = String(req.query.exchange || '').toUpperCase();
  if (!symbol) throw new Error('symbol is required');
  return { status: true, symbol, exchange, brokers: instruments.route(symbol, exchange) };
}));

app.get('/api/master/search', h(async (req) => {
  const broker = String(req.query.broker || '').toLowerCase();
  if (!broker) throw new Error('broker is required');
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
  return { status: true, broker, results: instruments.search(broker, req.query.q || '', limit) };
}));

// ── master / search ────────────────────────────────────────────────────────
app.get('/api/angel/master-index', h(async () => master.getIndex()));

app.post('/api/angel/refresh-master', h(async () => master.refresh()));

app.get('/api/angel/search-scrips', h(async (req) => {
  const q = String(req.query.q || '');
  let limit = 80;
  const raw = Number(req.query.limit);
  if (Number.isFinite(raw) && raw > 0) limit = raw;
  const results = await master.searchScrips(q, limit);
  return { status: true, results };
}));

// ── option chain ─────────────────────────────────────────────────────────────
// GET → pure master skeleton; POST → skeleton + spot/atm + feed/session.
app.get('/api/angel/all-scrip-options', h(async (req) => {
  const q = req.query;
  return allScripOptions(master, {
    TradeSymbol: q.TradeSymbol,
    ExpiryDate: q.ExpiryDate,
    MarketSegmentId: q.MarketSegmentId,
  });
}));

app.post('/api/angel/all-scrip-options', h(async (req) => {
  const b = req.body || {};
  return scripOptionsWithSpot(client, auth, master, {
    TradeSymbol: b.TradeSymbol,
    ExpiryDate: b.ExpiryDate,
    MarketSegmentId: b.MarketSegmentId,
  }, b.client || {});
}));

app.post('/api/angel/chain-prices', h(async (req) => {
  const b = req.body || {};
  return chainPrices(client, auth, master, {
    TradeSymbol: b.TradeSymbol,
    ExpiryDate: b.ExpiryDate,
  }, b.client || {});
}));

app.post('/api/angel/option-chain', h(async (req) => {
  const b = req.body || {};
  return getOptionChain(client, auth, master, {
    client: b.client || {},
    symbol: b.symbol,
    expiry: b.expiry,
    window: b.window,
  });
}));

app.post('/api/angel/resolve-leg', h(async (req) => {
  const b = req.body || {};
  return resolveLeg(client, auth, master, {
    client: b.client || null,
    symbol: b.symbol,
    expiry: b.expiry,
    strike: b.strike,
    optionType: b.optionType,
  });
}));

// ── basket: margin / charges / place ─────────────────────────────────────────
app.post('/api/angel/margin', h(async (req) => {
  const b = req.body || {};
  return getMargin(client, auth, { client: b.client || {}, legs: b.legs || [] });
}));

app.post('/api/angel/charges', h(async (req) => {
  const b = req.body || {};
  return getCharges(client, auth, { client: b.client || {}, legs: b.legs || [] });
}));

app.post('/api/angel/place-basket', h(async (req) => {
  const b = req.body || {};
  return placeBasket(client, auth, { client: b.client || {}, legs: b.legs || [] });
}));

app.post('/api/angel/order-book', h(async (req) => {
  const cc = req.body?.client || {};
  return book(client, auth, cc, '/rest/secure/angelbroking/order/v1/getOrderBook', 'orders');
}));

app.post('/api/kotak/order-book', h(async (req) => {
  return kotak.orderBook(req.body?.client || {});
}));

app.post('/api/kotak/order-updates', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (event === 'end') res.end();
  };

  let stream = null;
  try {
    const cc = req.body?.client || {};
    const session = kotak.sessionFromClient(cc);
    send('session', { status: true, session });
    stream = new KotakUserStream({ ...cc, session }, send).connect();
  } catch (error) {
    send('error', { status: false, message: error.message || 'Kotak stream unavailable' });
    res.end();
  }

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, 20_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    stream?.close();
  });
});

app.post('/api/angel/order-updates', async (req, res) => {
  const cc = req.body?.client || {};
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let upstream = null;
  let keepAlive = null;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (keepAlive) clearInterval(keepAlive);
    if (upstream && upstream.readyState === WebSocket.OPEN) upstream.close(1000, 'client closed');
  };

  req.on('close', cleanup);

  try {
    const session = await auth.sessionOrLogin(cc);
    send('session', { status: true, session });

    upstream = new WebSocket('wss://tns.angelone.in/smart-order-update', {
      headers: { Authorization: `Bearer ${session.jwtToken}` },
    });

    upstream.on('open', () => {
      send('status', { status: true, message: 'Order status stream connected' });
      keepAlive = setInterval(() => {
        if (upstream?.readyState !== WebSocket.OPEN) return;
        try {
          upstream.ping();
          upstream.send('ping');
        } catch {
          // The close/error handlers below will report broken connections.
        }
      }, 10000);
    });

    upstream.on('message', (raw) => {
      const text = raw.toString();
      if (text.toLowerCase() === 'pong') {
        send('pong', { status: true, at: new Date().toISOString() });
        return;
      }

      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        send('message', { status: true, raw: text });
        return;
      }

      send('order', payload);
    });

    upstream.on('close', (code, reason) => {
      if (keepAlive) clearInterval(keepAlive);
      if (!closed) send('status', { status: false, message: `Order status stream closed (${code})`, reason: reason.toString() });
      cleanup();
    });

    upstream.on('error', (err) => {
      if (!closed) send('error', { status: false, message: err.message || 'Order status stream error' });
    });
  } catch (err) {
    send('error', { status: false, message: err.message || 'Order status stream unavailable' });
    cleanup();
    res.end();
  }
});

app.post('/api/angel/trade-book', h(async (req) => {
  const cc = req.body?.client || {};
  return book(client, auth, cc, '/rest/secure/angelbroking/order/v1/getTradeBook', 'trades');
}));

app.post('/api/kotak/trade-book', h(async (req) => {
  return kotak.tradeBook(req.body?.client || {});
}));

app.post('/api/kotak/positions', h(async (req) => {
  const cc = req.body?.client || {};
  const session = kotak.sessionFromClient(cc);
  await Promise.allSettled([
    instruments.loadSessionBroker('kotak', {
      accessToken: cc.accessToken || cc.app_secret,
      baseUrl: session.baseUrl,
    }),
    instruments.loadAngel(),
  ]);
  const result = await kotak.positions({ ...cc, session });
  result.positions = result.positions.map((position) => (
    mapKotakPositionToAngelFeed(position, instruments)
  ));
  return result;
}));

app.post('/api/kotak/limits', h(async (req) => {
  const body = req.body || {};
  return kotak.limits(body.client || {}, body.filters || body);
}));

app.post('/api/kotak/check-margin', h(async (req) => {
  const body = req.body || {};
  return kotak.checkMargin(body.client || {}, body.order || body);
}));

app.post('/api/kotak/feed/sync', h(async (req) => {
  const body = req.body || {};
  const feedId = body.feedId || body.client?.configId;
  const result = kotakFeeds.get(feedId).sync(
    body.client || {},
    body.items || [],
    body.subscriber || 'get-positions',
  );
  return { status: true, broker: 'kotak', feedId: String(feedId), ...result };
}));

app.get('/api/kotak/feed/status', h(async () => ({
  status: true,
  feeds: kotakFeeds.status(),
})));

app.get('/api/kotak/feed/stream', (req, res) => {
  let feedInstance;
  try {
    feedInstance = kotakFeeds.get(req.query.feedId);
  } catch (error) {
    res.status(400).json({ status: false, message: error.message });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  const handle = {
    write: (event) => {
      if (event.event) res.write(`event: ${event.event}\n`);
      res.write(`data: ${event.data}\n\n`);
    },
  };
  res.write('retry: 3000\n\n');
  feedInstance.addClient(handle);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    feedInstance.removeClient(handle);
  });
});

app.post('/api/angel/positions', h(async (req) => {
  const cc = req.body?.client || {};
  return book(client, auth, cc, '/rest/secure/angelbroking/order/v1/getPosition', 'positions');
}));

// Historical candle data - used to reconcile a leg's LTP for a PAST date
// (Sync Net Positions' date filter) instead of a live feed tick.
app.post('/api/angel/historical-candle', h(async (req) => {
  const b = req.body || {};
  return getHistoricalCandle(client, auth, b.client || {}, {
    exchange: b.exchange,
    symboltoken: b.symboltoken,
    interval: b.interval,
    fromdate: b.fromdate,
    todate: b.todate,
  });
}));

// ── live feed: subscribe + basket sync + SSE stream ──────────────────────────
app.post('/api/angel/subscribe', h(async (req) => {
  const b = req.body || {};
  const spot = b.spot || null;
  const n = feed.subscribe(
    b.credentials || {},
    b.exchange || 'NFO',
    b.tokens || [],
    spot ? spot.token : '',
    spot ? spot.exchange : ''
  );
  return { status: true, subscribed: n, exchange: b.exchange || 'NFO' };
}));

// Each page syncs its own token set under its own subscriber name, so pages that
// are alive at the same time don't unsubscribe each other's tokens.
const basketSync = h(async (req) => {
  const b = req.body || {};
  const res = feed.setBasketTokensItems(b.credentials || null, b.items || [], b.subscriber || 'basket');
  return { status: true, ...res };
});
app.post('/api/angel/basket-tokens', basketSync);
app.post('/api/angel/subscribe-more', basketSync); // alias for older frontends

app.get('/api/angel/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const handle = {
    write: (ev) => {
      if (ev.event) res.write(`event: ${ev.event}\n`);
      res.write(`data: ${ev.data}\n\n`);
    },
  };

  res.write('retry: 3000\n\n');
  const connected = feed.addClient(handle);
  handle.write({ event: 'status', data: JSON.stringify({ connected, message: 'Stream open' }) });

  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    feed.removeClient(handle);
  });
});

// ── boot ─────────────────────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`Angel Trade Panel backend running at http://localhost:${config.port}`);
  master.warm()
    .then(() => instruments.loadAngel())
    .then(() => console.log('Angel + normalized instrument masters ready'))
    .catch((err) => console.log('Master warm-up failed:', err.message));
});
