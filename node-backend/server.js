// Node SmartAPI proxy for the admin Trade Panel. Exposes the same /api/angel/*
// surface the option chain + basket frontend expects. Port of the Go httpapi.
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import WebSocket from 'ws';

import { config } from './src/config.js';
import { Client } from './src/httpClient.js';
import { Auth } from './src/auth.js';
import * as kotak from './src/kotak.js';
import * as zerodha from './src/zerodha.js';
import { MasterStore } from './src/master.js';
import { allScripOptions } from './src/scripoptions.js';
import {
  scripOptionsWithSpot, chainPrices, getOptionChain, resolveLeg,
} from './src/market.js';
import { getMargin, getCharges, placeBasket, book } from './src/orders.js';
import { getHistoricalCandle } from './src/historical.js';
import { Feed, wsType } from './src/feed.js';
import { BrokerInstrumentManager } from './src/instruments/manager.js';
import { mapKotakPositionToAngelFeed, mapZerodhaPositionToAngelFeed } from './src/instruments/positionRouter.js';
import { KotakUserStream } from './src/kotakUserStream.js';
import { KotakHsmRegistry } from './src/kotakHsmFeed.js';

const client = new Client();
const auth = new Auth(client);
const master = new MasterStore();
const instruments = new BrokerInstrumentManager(master);
const feed = new Feed();
const kotakFeeds = new KotakHsmRegistry();
const zerodhaLoginStates = new Map();

const app = express();
app.use(cors({ origin: true, credentials: true }));
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

function parseCookies(header = '') {
  return header.split(';').reduce((acc, part) => {
    const [rawKey, ...rest] = part.split('=');
    const key = String(rawKey || '').trim();
    if (!key) return acc;
    acc[key] = decodeURIComponent(rest.join('=').trim() || '');
    return acc;
  }, {});
}

function clearZerodhaCookie(res) {
  res.setHeader('Set-Cookie', 'zerodha_login_id=; Max-Age=0; Path=/; SameSite=Lax');
}

function renderZerodhaCallbackHtml({ status, title, message, configId, session, origin = '*' }) {
  const payload = {
    type: 'zerodha-login-complete',
    status,
    title,
    message,
    configId: configId ? String(configId) : '',
    session: session || null,
  };
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  const titleText = String(title || 'Zerodha login');
  const messageText = String(message || '');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${titleText}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 32px; background: #f6f7fb; color: #1f2937; }
    .card { max-width: 520px; margin: 0 auto; background: #fff; border-radius: 16px; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,.08); }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p { margin: 0 0 12px; line-height: 1.5; }
    code { display: block; white-space: pre-wrap; word-break: break-word; background: #f3f4f6; padding: 12px; border-radius: 10px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${titleText}</h1>
    <p>${messageText}</p>
    <p>You can close this tab once the Trade Panel updates.</p>
  </div>
  <script>
    (function () {
      const payload = ${data};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, ${JSON.stringify(origin)});
        }
      } catch (error) {
        console.error(error);
      }
      setTimeout(() => window.close(), 250);
    }());
  </script>
</body>
</html>`;
}

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

app.post('/api/zerodha/auto-login', h(async (req) => {
  const credentials = req.body?.client || req.body || {};
  return zerodha.autoLogin(credentials);
}));

app.post('/api/zerodha/login-start', h(async (req, res) => {
  const body = req.body || {};
  const configId = String(body.configId || body.config_id || '').trim();
  const apiKey = String(body.apiKey || body.api_key || '').trim();
  const apiSecret = String(body.apiSecret || body.api_secret || '').trim();
  if (!configId) throw new Error('Zerodha login start needs configId');
  if (!apiKey) throw new Error('Zerodha login start needs API key');
  if (!apiSecret) throw new Error('Zerodha login start needs API secret');

  const loginId = crypto.randomUUID();
  zerodhaLoginStates.set(loginId, {
    configId,
    apiKey,
    apiSecret,
    createdAt: Date.now(),
  });
  res.setHeader('Set-Cookie', `zerodha_login_id=${encodeURIComponent(loginId)}; Max-Age=300; Path=/; SameSite=Lax`);
  return { status: true, loginId, configId };
}));

app.get('/api/zerodha/login-url', h(async (req) => ({
  status: true,
  broker: 'zerodha',
  url: zerodha.buildLoginUrl(req.query.apiKey || req.query.api_key),
})));

app.get('/zerodha/callback', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  const loginId = String(cookies.zerodha_login_id || req.query.login_id || '').trim();
  const pending = loginId ? zerodhaLoginStates.get(loginId) : null;
  const requestToken = String(req.query.request_token || req.query.requestToken || '').trim();
  const status = String(req.query.status || '').toLowerCase();

  if (!pending) {
    clearZerodhaCookie(res);
    res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderZerodhaCallbackHtml({
      status: 'error',
      title: 'Zerodha login not linked',
      message: 'The callback did not match a pending Zerodha login. Please open the login again from the app.',
    }));
    return;
  }

  if (status && status !== 'success') {
    zerodhaLoginStates.delete(loginId);
    clearZerodhaCookie(res);
    res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderZerodhaCallbackHtml({
      status: 'error',
      title: 'Zerodha login cancelled',
      message: `Zerodha returned status=${status || 'unknown'}.`,
      configId: pending.configId,
    }));
    return;
  }

  if (!requestToken) {
    zerodhaLoginStates.delete(loginId);
    clearZerodhaCookie(res);
    res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderZerodhaCallbackHtml({
      status: 'error',
      title: 'Zerodha login failed',
      message: 'The callback did not include a request token.',
      configId: pending.configId,
    }));
    return;
  }

  try {
    const result = await zerodha.autoLogin({
      apiKey: pending.apiKey,
      apiSecret: pending.apiSecret,
      requestToken,
    });
    zerodhaLoginStates.delete(loginId);
    clearZerodhaCookie(res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderZerodhaCallbackHtml({
      status: 'success',
      title: 'Zerodha login complete',
      message: 'The access token was generated successfully and sent back to the app.',
      configId: pending.configId,
      session: result.session,
      origin: '*',
    }));
  } catch (error) {
    zerodhaLoginStates.delete(loginId);
    clearZerodhaCookie(res);
    res.status(500).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderZerodhaCallbackHtml({
      status: 'error',
      title: 'Zerodha login failed',
      message: error.message || 'Could not exchange the request token.',
      configId: pending.configId,
    }));
  }
});

app.get('/api/zerodha/orders', h(async (req) => zerodha.orderBook(req.query || {})));
app.get('/api/zerodha/trades', h(async (req) => zerodha.tradeBook(req.query || {})));
app.get('/api/zerodha/orders/:orderId', h(async (req) => (
  zerodha.orderHistory(req.query || {}, req.params.orderId)
)));
app.get('/api/zerodha/orders/:orderId/trades', h(async (req) => (
  zerodha.orderTrades(req.query || {}, req.params.orderId)
)));
app.post('/api/zerodha/orders/:variety', h(async (req) => (
  zerodha.placeOrder({ ...req.body, variety: req.params.variety })
)));
app.put('/api/zerodha/orders/:variety/:orderId', h(async (req) => (
  zerodha.modifyOrder({ ...req.body, variety: req.params.variety, orderId: req.params.orderId })
)));
app.delete('/api/zerodha/orders/:variety/:orderId', h(async (req) => (
  zerodha.cancelOrder({ ...req.query, variety: req.params.variety, orderId: req.params.orderId })
)));

app.get('/api/zerodha/portfolio/holdings', h(async (req) => (
  zerodha.holdings(req.query || {})
)));

app.get('/api/zerodha/portfolio/positions', h(async (req) => (
  Promise.allSettled([
    instruments.loadSessionBroker('zerodha', {
      apiKey: req.query?.apiKey || req.query?.api_key || '',
      accessToken: req.query?.accessToken || req.query?.access_token || '',
    }),
    instruments.loadAngel(),
  ]).then(async () => {
    const result = await zerodha.positions(req.query || {});
    result.positions = result.positions.map((position) => (
      mapZerodhaPositionToAngelFeed(position, instruments)
    ));
    result.day = result.day.map((position) => (
      mapZerodhaPositionToAngelFeed(position, instruments)
    ));
    return result;
  })
)));

app.post('/api/zerodha/order-book', h(async (req) => zerodha.orderBook(req.body || req.query || {})));
app.post('/api/zerodha/trade-book', h(async (req) => zerodha.tradeBook(req.body || req.query || {})));

app.get('/api/zerodha/portfolio/holdings/auctions', h(async (req) => (
  zerodha.holdingsAuctions(req.query || {})
)));

app.put('/api/zerodha/portfolio/positions', h(async (req) => (
  zerodha.convertPosition(req.body || {})
)));

app.post('/api/zerodha/portfolio/holdings/authorise', h(async (req) => (
  zerodha.authoriseHoldings(req.body || {})
)));

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
  // The RESPONSE closing is what "the client went away" means. `req` is the
  // request BODY stream, and Node ends it - firing 'close' - the moment the body
  // has been read, which for a POST is immediately. Hanging the teardown off it
  // tore the Kotak websocket down while it was still shaking hands, so the stream
  // never opened, never errored, and the page sat on "Connecting" forever.
  res.on('close', () => {
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

  // On the response, not the request: Node ends the request body stream - firing
  // its 'close' - as soon as the POST body is read, which is immediately. This
  // stream only survived that because cleanup() skips a socket that is not OPEN
  // yet, and at that instant it is still connecting. It did kill the keep-alive
  // outright, though, and any slower teardown here would have killed the socket
  // too - the same way it did Kotak's.
  res.on('close', cleanup);

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
const server = app.listen(config.port, () => {
  console.log(`Angel Trade Panel backend running at http://localhost:${config.port}`);
  master.warm()
    .then(() => instruments.loadAngel())
    .then(() => console.log('Angel + normalized instrument masters ready'))
    .catch((err) => console.log('Master warm-up failed:', err.message));
});

// Without a handler here, a taken port surfaces as an unhandled 'error' event -
// a fifteen-line stack trace that says EADDRINUSE somewhere in the middle. It is
// almost always a second `npm run dev` still running, so say that and stop.
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\nPort ${config.port} is already in use - is another instance of this backend running?\n`);
    process.exit(1);
  }
  throw error;
});

// The feed and the order streams hold sockets open, which would keep the process
// alive after a --watch restart signal and leave the port bound just long enough
// for the NEXT one to fail. Let go of them promptly.
function shutdown() {
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
