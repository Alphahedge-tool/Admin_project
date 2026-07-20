# Admin Angel Trade Panel — Node backend

Node/Express port of the Angel SmartAPI proxy that powers the admin **Trade Panel**
(option chain + basket). Serves the same `/api/angel/*` surface the frontend expects.

## Run

```bash
cd admin/node-backend
npm install      # first time only
npm start        # → http://localhost:3001
```

Then start the admin frontend (`cd admin && npm run dev`). Vite proxies
`/api/angel/*` to this server (see `admin/vite.config.js`), so open the app and go
to **Trade Panel** in the sidebar.

The scrip master (`scrip_master.json` / `scrip_index.json`) is loaded from disk if
present and fresh (< 24h), else downloaded from Angel on boot. Hit **↻** in the
panel (or POST `/api/angel/refresh-master`) to force a refresh.

## How the Trade Panel gets credentials

The panel's account picker reads a user's **Angel** broker config from the PHP
admin API (`/users/broker-config/get.php`) — the same rows managed in
**Users → Broker Configuration** — and uses Client Code / PIN / TOTP Secret /
API Key to auto-login and drive the live chain. So configure an Angel account for
a user first (with the auto-login fields filled in).

## Endpoints

- `POST /api/angel/auto-login`, `POST /api/angel/logout`
- `GET  /api/angel/master-index`, `POST /api/angel/refresh-master`, `GET /api/angel/search-scrips`
- `GET|POST /api/angel/all-scrip-options`, `POST /api/angel/chain-prices`, `POST /api/angel/option-chain`, `POST /api/angel/resolve-leg`
- `POST /api/angel/margin`, `POST /api/angel/charges`, `POST /api/angel/place-basket`
- `POST /api/angel/order-book`, `POST /api/angel/trade-book`
- `POST /api/angel/subscribe`, `POST /api/angel/basket-tokens`, `GET /api/angel/stream` (SSE live feed)
- `POST /api/zerodha/basket-margin` (Kite `/margins/basket`; same `{ client, legs }` contract as `/api/angel/margin`)

## Env (all optional)

`PORT` (3001), `ANGEL_LOCAL_IP`, `ANGEL_PUBLIC_IP`, `ANGEL_MAC_ADDRESS`,
`ANGEL_MASTER_FILE`, `ANGEL_INDEX_FILE`, `FEED_DEBUG=1`.
Zerodha is also available as a broker config. Kite Connect still requires the
browser login plus `request_token` exchange before the backend can mint an
access token.

## Zerodha portfolio proxy

The backend now also proxies the core Kite portfolio APIs:

- `GET /api/zerodha/portfolio/holdings`
- `GET /api/zerodha/portfolio/positions`
- `GET /api/zerodha/portfolio/holdings/auctions`
- `PUT /api/zerodha/portfolio/positions`
- `POST /api/zerodha/portfolio/holdings/authorise`
- `GET /api/zerodha/login-url`
