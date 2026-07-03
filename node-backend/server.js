// Node SmartAPI proxy for the admin Trade Panel. Exposes the same /api/angel/*
// surface the option chain + basket frontend expects. Port of the Go httpapi.
import express from 'express';
import cors from 'cors';

import { config } from './src/config.js';
import { Client } from './src/httpClient.js';
import { Auth } from './src/auth.js';
import { MasterStore } from './src/master.js';
import { allScripOptions } from './src/scripoptions.js';
import {
  scripOptionsWithSpot, chainPrices, getOptionChain, resolveLeg,
} from './src/market.js';
import { getMargin, getCharges, placeBasket, book } from './src/orders.js';
import { Feed, wsType } from './src/feed.js';

const client = new Client();
const auth = new Auth(client);
const master = new MasterStore();
const feed = new Feed();

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

app.post('/api/angel/trade-book', h(async (req) => {
  const cc = req.body?.client || {};
  return book(client, auth, cc, '/rest/secure/angelbroking/order/v1/getTradeBook', 'trades');
}));

app.post('/api/angel/positions', h(async (req) => {
  const cc = req.body?.client || {};
  return book(client, auth, cc, '/rest/secure/angelbroking/order/v1/getPosition', 'positions');
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

const basketSync = h(async (req) => {
  const b = req.body || {};
  const res = feed.setBasketTokensItems(b.credentials || null, b.items || []);
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
    .then(() => console.log('Scrip master ready'))
    .catch((err) => console.log('Master warm-up failed:', err.message));
});
