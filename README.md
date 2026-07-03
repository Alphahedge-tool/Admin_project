# Admin Project

Admin panel for the portfolio / trading platform. React 19 + Vite + MUI front end,
with a small Node backend that powers the **Trade Panel** (Angel One option chain,
live feed, and basket orders).

## Structure

```
admin/
├─ src/                 # React admin app (MUI, React Router)
│  ├─ pages/            # Dashboard, Users, Login, reports
│  ├─ components/       # Sidebar, topbar, dialogs, shared DataTable
│  │  └─ users/         # Broker config + per-broker auto-login
│  ├─ masters/          # Broker master
│  ├─ transactions/     # User balances, sync net positions
│  └─ tradepanel/       # Enter Trade (option chain + basket) & Get Position
└─ node-backend/        # Node/Express SmartAPI proxy (/api/angel/*) — see its README
```

## Run

**1. Front end**

```bash
npm install
npm run dev        # Vite dev server
```

The admin app talks to the PHP backend at `http://localhost/api` and proxies
`/api/angel/*` to the Node backend (see `vite.config.js`).

**2. Trade Panel backend** (option chain + basket + live feed)

```bash
cd node-backend
npm install
npm start          # http://localhost:3001
```

On first boot it downloads the Angel scrip master (or reuses the cached
`scrip_master.json` if present). See `node-backend/README.md` for details and the
full `/api/angel/*` endpoint list.

## Trade Panel

**Sidebar → Trade Panel** has two views:

- **Enter Trade** — pick a user + their Angel account (from Users → Broker
  Configuration), which auto-logs-in and loads the live option chain. Buy/Sell on
  any strike fills the basket, with real margin/charges and order placement.
- **Get Position** — the selected account's net positions with live P&L.

Angel credentials (Client Code / PIN / TOTP Secret / API Key) come from each user's
Angel broker config, managed under **Users → Broker Configuration**.
