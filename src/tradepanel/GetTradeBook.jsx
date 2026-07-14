// Get TradeBook: current-day Angel fills with the same high-density trade panel
// language as OrderBook, but with trade/fill-specific columns and filters.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Filter, Info, Radio, ReceiptText, RefreshCw, Search, X } from 'lucide-react';
import { apiGet } from '../config/api';
import {
  classifyLoginError, isAuthError, isRateLimited,
} from '../feedmaster/angelSessionStore';
import {
  ensureBookSession, fetchBrokerBook, hasBookSession, isBookBroker, isKotakBroker,
  saveBookSession, useBrokerBookClient,
} from './brokerBookClient';
import { orderIsFill, useFillRefresh, useOrderUpdates } from './orderUpdates';
import { useSharedTradeAccount, useSignedInAccounts } from './accountScope';
import { getSavedTradeAccount, saveTradeAccount } from './tradeAccountStore';
import { compactProductTag, contractMeta } from './symbolParse';
import { CompactSelect, PositionSelect } from './PositionSelect';
import './tradepanel.css';

const TRADE_COLUMNS = ['trade', 'side', 'product', 'qty', 'price', 'value', 'time'];

// A trade book only ever changes when something fills, and the fill arrives on
// the order stream - so this page listens to the same stream the other two do.
// Behind it, the same slow re-read as everywhere else, for a fill the broker
// never got round to pushing.
const BACKGROUND_REFRESH_MS = 45000;

const defaultTradeFilters = {
  symbol: '',
  exchange: '',
  expiry: '',
  optionType: '',
  side: '',
  product: '',
  qtyState: '',
  priceState: '',
  valueState: '',
  orderText: '',
  timeText: '',
};

function money(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n === 0) return '-';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function GetTradeBook() {
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState('');
  const [configs, setConfigs] = useState([]);
  const [configId, setConfigId] = useState('');
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('Select a user and account');
  // Starts true: until the user/config/credential setup below settles one way
  // or another, we're still "preparing" - staying in the loading state avoids
  // a "No trades" flash before the real auto-load kicks in.
  const [loading, setLoading] = useState(true);
  const [configLoading, setConfigLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState(defaultTradeFilters);
  const [openFilter, setOpenFilter] = useState('');
  const autoLoadedAccountRef = useRef('');
  // The stream and the background timer fire outside React's render cycle, so
  // they reach the current load() through a ref instead of closing over
  // whichever one existed when they started.
  const loadRef = useRef(null);
  const loadSeqRef = useRef(0);

  const signedIn = useSignedInAccounts();
  const selectedConfig = configs.find((config) => String(config.id) === String(configId));
  const selectedBrokerName = selectedConfig?.broker_name || '';
  const selectedIsKotak = isKotakBroker(selectedBrokerName);
  const selectedIsSupported = isBookBroker(selectedBrokerName);
  const { client, clientError } = useBrokerBookClient(configId, selectedBrokerName);

  // Manual picks here should also become the shared Trade Panel selection.
  // setLoading(true) here (not just inside the effects below) closes the gap
  // between clicking and the account-hydration effects actually running, so
  // the table never flashes "No trades" for a frame while switching account.
  const handleUserId = useCallback((value) => {
    setUserId(value);
    setLoading(true);
    saveTradeAccount({ userId: value, configId: '' });
  }, []);

  const handleConfigId = useCallback((value) => {
    setConfigId(value);
    setLoading(true);
    saveTradeAccount({ userId, configId: value });
  }, [userId]);

  // The account picked on any Trade Panel page is adopted here too, so switching
  // tabs keeps the same client's book on screen.
  useSharedTradeAccount({
    userId,
    setUserId,
    configId,
    setConfigId,
    configs,
    onAdopt: () => setLoading(true),
  });

  // Only signed-in accounts are offered - one that never logged in has no book.
  const visibleUsers = useMemo(
    () => (signedIn.ready ? users.filter((user) => signedIn.userIds.has(String(user.id))) : users),
    [users, signedIn],
  );
  const visibleConfigs = useMemo(
    () => (signedIn.ready
      ? configs.filter((config) => signedIn.configIds.has(String(config.id)))
      : configs),
    [configs, signedIn],
  );

  useEffect(() => {
    if (!visibleUsers.length || !userId) return;
    if (!visibleUsers.some((user) => String(user.id) === String(userId))) {
      handleUserId(String(visibleUsers[0].id));
    }
  }, [visibleUsers, userId, handleUserId]);

  useEffect(() => {
    if (!visibleConfigs.length || !configId) return;
    if (!visibleConfigs.some((config) => String(config.id) === String(configId))) {
      handleConfigId(String(visibleConfigs[0].id));
    }
  }, [visibleConfigs, configId, handleConfigId]);

  useEffect(() => {
    let cancelled = false;

    async function loadUsers() {
      try {
        const [usersOut, authOut] = await Promise.allSettled([
          apiGet('/users/list.php'),
          apiGet('/auth/me.php'),
        ]);
        if (cancelled) return;

        if (usersOut.status !== 'fulfilled') {
          setStatus('Failed to load users');
          setLoading(false);
          return;
        }

        const list = usersOut.value.data || [];
        setUsers(list);
        const auth = authOut.status === 'fulfilled' ? authOut.value : null;
        const principal = auth?.user || auth?.admin || auth?.data || auth || {};

        // Reuse whichever user/account was last picked on any Trade Panel
        // page (Get Position, Get OrderBook, Get TradeBook, Sync Net
        // Positions), so switching pages keeps the same account selected.
        const saved = getSavedTradeAccount();
        const savedUser = saved.userId && list.some((u) => String(u.id) === String(saved.userId))
          ? list.find((u) => String(u.id) === String(saved.userId))
          : null;
        const current = savedUser || findLoggedInUser(list, principal) || list[0];
        if (current?.id) {
          setUserId(String(current.id));
          saveTradeAccount({ userId: String(current.id) });
          setStatus(`Select account for ${current.username || 'user'}`);
        } else {
          setStatus('No users available');
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setStatus('Failed to load users');
          setLoading(false);
        }
      }
    }

    loadUsers();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadConfigs() {
      if (!userId) {
        setConfigs([]);
        setConfigId('');
        return;
      }

      setLoading(true);
      setConfigLoading(true);
      setRows([]);
      try {
        const res = await apiGet(`/users/broker-config/list.php?user_id=${userId}`);
        if (cancelled) return;

        const list = res.data || [];
        setConfigs(list);
        const saved = getSavedTradeAccount();
        const savedConfigId = String(saved.userId || '') === String(userId) && saved.configId
          && list.some((c) => String(c.id) === String(saved.configId))
          ? saved.configId
          : '';
        const nextConfigId = String(savedConfigId || list[0]?.id || '');
        setConfigId(nextConfigId);
        if (nextConfigId) saveTradeAccount({ userId: String(userId), configId: nextConfigId });
        setStatus(list.length ? 'Select account, then Get TradeBook' : 'No broker accounts configured for this user');
        if (!list.length) setLoading(false);
      } catch {
        if (!cancelled) {
          setStatus('Failed to load broker accounts');
          setLoading(false);
        }
      } finally {
        if (!cancelled) setConfigLoading(false);
      }
    }

    loadConfigs();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    setRows([]);
    if (!configId) return;

    if (!selectedIsSupported) {
      setStatus(`${selectedBrokerName || 'Selected broker'} trade book is not wired yet`);
      setLoading(false);
      return;
    }
    setLoading(true);
    setStatus('');
  }, [configId, selectedBrokerName, selectedIsSupported]);

  useEffect(() => {
    if (!clientError) return;
    setStatus(clientError);
    setLoading(false);
  }, [clientError]);

  useEffect(() => {
    autoLoadedAccountRef.current = '';
  }, [configId]);

  // `options` is only ever passed internally - this is also wired straight to
  // onClick, where the first argument is a DOM event (which has no `.silent`).
  const load = useCallback(async (options) => {
    const silent = options?.silent === true;

    if (!selectedConfig) {
      setStatus('Select an account first');
      return;
    }
    if (!selectedIsSupported) {
      setStatus(`${selectedBrokerName || 'Selected broker'} trade book is not wired yet`);
      return;
    }
    if (!client) {
      setStatus(`${selectedBrokerName || 'Selected broker'} account credentials are not ready`);
      return;
    }

    // Refreshes overlap (a fill, a background re-read, the user hitting Get
    // TradeBook) and do not necessarily come back in the order they were sent.
    // Only the newest may write to the table - an older book landing last would
    // drop the fills that arrived after it.
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    const isLatest = () => seq === loadSeqRef.current;

    if (!silent) {
      setLoading(true);
      setStatus('Loading trade book...');
    }
    try {
      // Startup already logged this account in; only a missing or expired token
      // goes back to the shared (deduped) login.
      let active = client;
      if (!hasBookSession(selectedBrokerName, active)) {
        if (!silent) setStatus('Signing in this account...');
        active = await ensureBookSession(configId, selectedBrokerName, active);
      }

      let body;
      try {
        body = await fetchBrokerBook('trade', selectedBrokerName, active);
      } catch (error) {
        if (!isAuthError(error)) throw error;
        if (!silent) setStatus(`${selectedBrokerName || 'Selected broker'} token expired - signing in again...`);
        active = await ensureBookSession(configId, selectedBrokerName, active, { force: true });
        body = await fetchBrokerBook('trade', selectedBrokerName, active);
      }

      // Worth saving even if this response is superseded - the token is good
      // regardless of whether its trade book is still the one on screen.
      if (body.session) saveBookSession(configId, selectedBrokerName, body.session);
      if (!isLatest()) return;

      const trades = body.trades || [];
      setRows(trades);
      setStatus(trades.length ? `${trades.length} trades for today` : 'No trades in trade book');
    } catch (error) {
      if (isLatest()) setStatus(toTradeError(error));
    } finally {
      // Whoever turned the spinner on turns it off, superseded or not.
      if (!silent) setLoading(false);
    }
  }, [client, configId, selectedBrokerName, selectedConfig, selectedIsKotak, selectedIsSupported]);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  const refreshTrades = useCallback(() => loadRef.current?.({ silent: true }), []);
  const scheduleFillRefresh = useFillRefresh(refreshTrades);

  // A fill is the only thing that ever adds a row here, and the broker announces
  // it on the order stream - so without listening to it, this page showed the
  // trade book as it stood when the account was selected and never moved again.
  // Every fill after that had to be found by pressing Get TradeBook.
  const liveStatus = useOrderUpdates({
    configId,
    client,
    brokerName: selectedBrokerName,
    enabled: selectedIsSupported,
    onResync: refreshTrades,
    onOrder: useCallback((order) => {
      if (!orderIsFill(order)) return;
      setStatus(`Order filled${order.tradingsymbol ? ` (${order.tradingsymbol})` : ''} - refreshing trade book...`);
      scheduleFillRefresh();
    }, [scheduleFillRefresh]),
  });

  // Behind the stream: a fill the broker never pushed can only be found by
  // asking. Skipped while the tab is hidden - coming back re-reads anyway.
  useEffect(() => {
    if (!configId || !selectedIsSupported) return undefined;

    const timer = window.setInterval(() => {
      if (document.hidden) return;
      loadRef.current?.({ silent: true });
    }, BACKGROUND_REFRESH_MS);

    const onVisible = () => {
      if (!document.hidden) loadRef.current?.({ silent: true });
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [configId, selectedIsSupported]);

  useEffect(() => {
    const accountKey = String(configId || '');
    if (!accountKey || !selectedConfig || !selectedIsSupported || !client) return;
    // `loading` is deliberately NOT part of this guard: it's now also true
    // while hydrateConfig is still preparing the account (see above), and
    // gating on it here would mean this effect never fires. autoLoadedAccountRef
    // alone is what prevents re-triggering load() for the same account.
    if (autoLoadedAccountRef.current === accountKey) return;

    autoLoadedAccountRef.current = accountKey;
    load();
  }, [client, configId, load, selectedConfig, selectedIsSupported]);

  const summary = useMemo(() => buildTradeSummary(rows), [rows]);
  const filterOptions = useMemo(() => buildTradeFilterOptions(rows), [rows]);
  const visibleRows = useMemo(() => filterTrades(rows, query, filters), [filters, query, rows]);
  const tableRows = useMemo(() => groupTradesByExpiry(visibleRows), [visibleRows]);
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  return (
    <div className="trade-panel">
      <div className="positions-view orderbook-view tradebook-view">
        <div className="positions-toolbar">
          <CompactSelect
            title="User"
            value={userId}
            onChange={handleUserId}
            options={visibleUsers.map((user) => ({
              value: String(user.id),
              label: user.username || `${user.first_name || ''} ${user.last_name || ''}`.trim() || `User ${user.id}`,
            }))}
          />

          <CompactSelect
            title="Account"
            value={configId}
            onChange={handleConfigId}
            disabled={configLoading || !visibleConfigs.length}
            options={visibleConfigs.map((config) => ({
              value: String(config.id),
              label: config.account_id || `Account ${config.id}`,
              meta: config.broker_name || 'Broker',
            }))}
          />

          <button className="positions-load-btn" onClick={load} disabled={loading || !selectedConfig || (selectedIsSupported && !client)} type="button">
            {loading ? 'Loading' : 'Get TradeBook'}
          </button>

          <span className={`orderbook-live-pill ${liveStatus}`} title="Auto-refreshes the trade book as orders fill">
            <Radio size={13} />
            {liveStatus === 'live' ? 'Live' : liveStatus === 'connecting' ? 'Connecting' : 'Offline'}
          </span>

          <label className="orderbook-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search symbol, fill id, order id..."
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Clear search">
                <X size={13} />
              </button>
            )}
          </label>

          {status && <span className="positions-status">{status}</span>}
        </div>

        {rows.length > 0 && (
          <>
            <div className="position-book-summary orderbook-summary tradebook-summary">
              <div>
                <span>Total Trades</span>
                <strong>{rows.length}</strong>
                <em>{summary.buy} buy / {summary.sell} sell</em>
              </div>
              <div>
                <span className="buy">Buy Quantity</span>
                <strong>{summary.buyQty.toLocaleString('en-IN')}</strong>
                <em>Executed buy fills</em>
              </div>
              <div>
                <span className="sell">Sell Quantity</span>
                <strong>{summary.sellQty.toLocaleString('en-IN')}</strong>
                <em>Executed sell fills</em>
              </div>
              <div>
                <span>Turnover</span>
                <strong>{money(summary.turnover)}</strong>
                <em>Trade value total</em>
              </div>
            </div>

            <div className="orderbook-filter-strip">
              <button className="orderbook-refresh-chip" type="button" onClick={load} disabled={loading}>
                <RefreshCw size={13} className={loading ? 'spin' : ''} /> Refresh
              </button>
              {activeFilterCount > 0 && (
                <button className="orderbook-refresh-chip orderbook-clear-column-filters" type="button" onClick={() => setFilters(defaultTradeFilters)}>
                  <X size={13} /> Clear filters
                </button>
              )}
            </div>
          </>
        )}

        <div className="positions-table-wrap">
          <table className="positions-table position-book-table orderbook-table tradebook-table">
            <thead>
              <tr>
                {TRADE_COLUMNS.map((column) => (
                  <th key={column} className={tradeColumnIsNumeric(column) ? 'num' : ''}>
                    <TradeColumnHeader
                      column={column}
                      filters={filters}
                      setFilters={setFilters}
                      filterOptions={filterOptions}
                      openFilter={openFilter}
                      setOpenFilter={setOpenFilter}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((item, index) => (
                item.type === 'group' ? (
                  <tr key={`trade-group-${item.key}-${index}`} className="position-expiry-row orderbook-expiry-row tradebook-expiry-row">
                    <td colSpan={7}>
                      <div className="position-expiry-row-content orderbook-expiry-content">
                        <span>{item.expiry}</span>
                        <small>{item.exchanges}</small>
                        <small>{item.count} trade{item.count === 1 ? '' : 's'}</small>
                        <div className="orderbook-expiry-stats">
                          {item.buy > 0 && <em className="complete">{item.buy} buy</em>}
                          {item.sell > 0 && <em className="rejected">{item.sell} sell</em>}
                          <em className="open">Value {money(item.value)}</em>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={tradeRowKey(item.row, index)} className={tradeSide(item.row) === 'SELL' ? 'position-row-short' : ''}>
                    <td><TradeSymbolCell row={item.row} /></td>
                    <td><TradeSideCell row={item.row} /></td>
                    <td><TradeProductCell row={item.row} /></td>
                    <td className="num"><TradeQtyCell row={item.row} /></td>
                    <td className="num"><TradePriceCell row={item.row} /></td>
                    <td className="num"><TradeValueCell row={item.row} /></td>
                    <td><TradeTimeCell row={item.row} /></td>
                  </tr>
                )
              ))}
              {visibleRows.length === 0 && (
                <tr>
                  <td className="positions-empty" colSpan={7}>
                    <div className="positions-empty-state">
                      <button
                        className="positions-empty-action"
                        type="button"
                        onClick={load}
                        disabled={loading || !selectedConfig || (selectedIsSupported && !client)}
                      >
                        {rows.length ? <Search size={18} /> : <Info size={18} />}
                      </button>
                      <strong>{emptyTradeLabel(rows.length, loading)}</strong>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function TradeSymbolCell({ row }) {
  const symbol = String(row.tradingsymbol || row.symbolname || row.symbol || '-');
  const parsed = contractMeta(row);
  return (
    <div className="position-symbol-line orderbook-symbol-line tradebook-symbol-line" title={symbol}>
      <span className="orderbook-icon-chip tradebook-icon-chip"><ReceiptText size={13} /></span>
      <strong>{parsed.root}</strong>
      {parsed.expiry && <span className="position-expiry">{parsed.expiry}</span>}
      {parsed.strike && <span className="position-strike">{parsed.strike}</span>}
      {parsed.optionType && <span className={`book-tag option ${parsed.optionType.toLowerCase()}`}>{parsed.optionType}</span>}
      {row.exchange && <span className="book-tag exchange">{row.exchange}</span>}
    </div>
  );
}

function TradeSideCell({ row }) {
  const side = tradeSide(row);
  return <span className={`book-tag side ${side === 'SELL' ? 'sell' : 'buy'}`}>{side}</span>;
}

function TradeProductCell({ row }) {
  const product = compactProductTag(row.producttype || row.product_type || '-');
  const group = String(row.symbolgroup || '').toUpperCase();
  return (
    <div className="book-product-cell orderbook-type-cell tradebook-product-cell">
      <span className="book-tag product">{product}</span>
      {group && <span className="orderbook-mini-tag market">{group}</span>}
    </div>
  );
}

function TradeQtyCell({ row }) {
  const qty = Number(row.fillsize || row.fillSize || row.quantity || 0);
  const lot = Number(row.marketlot || row.lotsize || 0);
  return (
    <div className="book-qty-cell orderbook-qty-cell">
      <span>{qty.toLocaleString('en-IN')}</span>
      {lot > 1 && <small className="orderbook-filled-badge"><span>{lot}</span> lot</small>}
    </div>
  );
}

function TradePriceCell({ row }) {
  return (
    <div className="orderbook-price-cell">
      <span className="position-price ltp">{money(row.fillprice || row.price)}</span>
    </div>
  );
}

function TradeValueCell({ row }) {
  const value = tradeValue(row);
  return <span className="tradebook-value">{money(value)}</span>;
}

function TradeTimeCell({ row }) {
  return (
    <div className="orderbook-time-cell tradebook-time-cell">
      <span>{row.filltime || '-'}</span>
      {row.fillid && <small>Fill {row.fillid}</small>}
      {row.orderid && <small>Order {row.orderid}</small>}
    </div>
  );
}

function tradeSide(row) {
  return String(row.transactiontype || row.transaction_type || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
}

function tradeValue(row) {
  const direct = Number(row.tradevalue || row.trade_value || 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return Number(row.fillprice || 0) * Number(row.fillsize || 0);
}

function buildTradeSummary(rows) {
  return rows.reduce((acc, row) => {
    const qty = Number(row.fillsize || row.quantity || 0);
    const value = tradeValue(row);
    acc.turnover += value;
    if (tradeSide(row) === 'SELL') {
      acc.sell += 1;
      acc.sellQty += qty;
    } else {
      acc.buy += 1;
      acc.buyQty += qty;
    }
    return acc;
  }, { buy: 0, sell: 0, buyQty: 0, sellQty: 0, turnover: 0 });
}

function TradeColumnHeader({ column, filters, setFilters, filterOptions, openFilter, setOpenFilter }) {
  const active = tradeColumnFilterActive(column, filters);
  const filterButtonRef = useRef(null);

  return (
    <div className="position-col-head orderbook-col-head">
      <span className="orderbook-col-title">{tradeColumnLabel(column)}</span>
      <button
        ref={filterButtonRef}
        className={`position-filter-btn${active ? ' active' : ''}`}
        type="button"
        title={`Filter ${tradeColumnLabel(column)}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpenFilter(openFilter === column ? '' : column);
        }}
      >
        <Filter size={13} />
      </button>
      {openFilter === column && (
        <TradeFilterMenu
          column={column}
          filters={filters}
          setFilters={setFilters}
          filterOptions={filterOptions}
          anchorRef={filterButtonRef}
          align={column === 'trade' ? 'left' : 'right'}
          onClose={() => setOpenFilter('')}
        />
      )}
    </div>
  );
}

function TradeFilterMenu({ column, filters, setFilters, filterOptions, anchorRef, align, onClose }) {
  const menuRef = useRef(null);
  const [menuStyle, setMenuStyle] = useState({ visibility: 'hidden' });
  const patch = (key, value) => setFilters((current) => ({ ...current, [key]: value }));
  const resetKeys = (keys) => setFilters((current) => {
    const next = { ...current };
    keys.forEach((key) => { next[key] = ''; });
    return next;
  });

  useLayoutEffect(() => {
    const updatePosition = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menuWidth = column === 'trade' ? 250 : 230;
      const viewportPad = 8;
      const wantedLeft = align === 'left' ? rect.left : rect.right - menuWidth;
      const left = Math.min(Math.max(viewportPad, wantedLeft), window.innerWidth - menuWidth - viewportPad);
      const top = Math.min(rect.bottom + 8, window.innerHeight - viewportPad);
      setMenuStyle({ top: `${top}px`, left: `${left}px`, width: `${menuWidth}px`, visibility: 'visible' });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [align, anchorRef, column]);

  useEffect(() => {
    const closeOnOutsideClick = (event) => {
      if (menuRef.current?.contains(event.target)) return;
      if (anchorRef.current?.contains(event.target)) return;
      if (event.target.closest?.('.position-select-menu')) return;
      onClose();
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [anchorRef, onClose]);

  const select = (label, key, options) => (
    <label className="position-filter-field">
      <span>{label}</span>
      <PositionSelect
        value={filters[key]}
        onChange={(nextValue) => patch(key, nextValue)}
        options={[
          { value: '', label: 'All' },
          ...options.map((option) => ({
            value: option.value || option,
            label: option.label || option,
          })),
        ]}
        compact
        portal
      />
    </label>
  );

  let body = null;
  let reset = [];

  if (column === 'trade') {
    reset = ['symbol', 'exchange', 'expiry', 'optionType'];
    body = (
      <>
        <label className="position-filter-field">
          <span>Search</span>
          <input value={filters.symbol} onChange={(event) => patch('symbol', event.target.value)} placeholder="SENSEX, fill id..." />
        </label>
        {select('Exchange', 'exchange', filterOptions.exchanges)}
        {select('Expiry', 'expiry', filterOptions.expiries)}
        {select('Option', 'optionType', filterOptions.optionTypes)}
      </>
    );
  } else if (column === 'side') {
    reset = ['side'];
    body = select('Side', 'side', ['BUY', 'SELL']);
  } else if (column === 'product') {
    reset = ['product'];
    body = select('Product', 'product', filterOptions.products);
  } else if (column === 'qty') {
    reset = ['qtyState'];
    body = select('Quantity', 'qtyState', [
      { value: 'has', label: 'Has quantity' },
      { value: 'lot', label: 'Lot size above 1' },
    ]);
  } else if (column === 'price') {
    reset = ['priceState'];
    body = select('Fill Price', 'priceState', [
      { value: 'has', label: 'Has fill price' },
      { value: 'missing', label: 'Missing fill price' },
    ]);
  } else if (column === 'value') {
    reset = ['valueState'];
    body = select('Trade Value', 'valueState', [
      { value: 'has', label: 'Has value' },
      { value: 'missing', label: 'Missing value' },
    ]);
  } else if (column === 'time') {
    reset = ['orderText', 'timeText'];
    body = (
      <>
        <label className="position-filter-field">
          <span>Time</span>
          <input value={filters.timeText} onChange={(event) => patch('timeText', event.target.value)} placeholder="13:27..." />
        </label>
        <label className="position-filter-field">
          <span>Order / Fill</span>
          <input value={filters.orderText} onChange={(event) => patch('orderText', event.target.value)} placeholder="Order id, fill id..." />
        </label>
      </>
    );
  }

  return createPortal(
    <div
      ref={menuRef}
      className="position-filter-menu position-filter-menu-portal orderbook-filter-menu"
      style={menuStyle}
      onClick={(event) => event.stopPropagation()}
    >
      {body}
      <div className="position-filter-actions">
        <button type="button" onClick={() => resetKeys(reset)}>Reset</button>
        <button type="button" onClick={onClose}><Check size={13} /> Done</button>
      </div>
    </div>,
    document.body,
  );
}

function tradeColumnLabel(key) {
  return {
    trade: 'Trade',
    side: 'Side',
    product: 'Product',
    qty: 'Qty',
    price: 'Fill Price',
    value: 'Value',
    time: 'Fill / Order',
  }[key] || key;
}

function tradeColumnIsNumeric(key) {
  return ['qty', 'price', 'value'].includes(key);
}

function tradeColumnFilterActive(column, filters) {
  if (column === 'trade') return Boolean(filters.symbol || filters.exchange || filters.expiry || filters.optionType);
  if (column === 'side') return Boolean(filters.side);
  if (column === 'product') return Boolean(filters.product);
  if (column === 'qty') return Boolean(filters.qtyState);
  if (column === 'price') return Boolean(filters.priceState);
  if (column === 'value') return Boolean(filters.valueState);
  if (column === 'time') return Boolean(filters.orderText || filters.timeText);
  return false;
}

function buildTradeFilterOptions(rows) {
  const exchanges = new Set();
  const expiries = new Map();
  const optionTypes = new Set();
  const products = new Set();

  for (const row of rows) {
    if (row.exchange) exchanges.add(String(row.exchange));
    const expiry = tradeExpiryMeta(row);
    if (expiry.label && expiry.label !== 'No Expiry') expiries.set(expiry.label, expiry.sort);
    const parsed = contractMeta(row);
    if (parsed.optionType) optionTypes.add(parsed.optionType);
    const product = compactProductTag(row.producttype || row.product_type || '-');
    if (product && product !== '-') products.add(product);
  }

  return {
    exchanges: [...exchanges].sort(),
    expiries: [...expiries.entries()].sort((a, b) => a[1] - b[1]).map(([label]) => label),
    optionTypes: [...optionTypes].sort(),
    products: [...products].sort(),
  };
}

function filterTrades(rows, query, filters) {
  const text = query.trim().toLowerCase();
  return rows.filter((row) => {
    const parsed = contractMeta(row);
    const rowText = [
      row.tradingsymbol,
      row.symbolname,
      row.symbol,
      parsed.root,
      parsed.expiry,
      parsed.strike,
      parsed.optionType,
      row.exchange,
      row.orderid,
      row.fillid,
      row.filltime,
      row.symbolgroup,
    ].filter(Boolean).join(' ').toLowerCase();

    if (text && !rowText.includes(text)) return false;
    if (filters.symbol && !rowText.includes(filters.symbol.toLowerCase())) return false;
    if (filters.exchange && String(row.exchange || '') !== filters.exchange) return false;
    if (filters.expiry && parsed.expiry !== filters.expiry) return false;
    if (filters.optionType && parsed.optionType !== filters.optionType) return false;
    if (filters.side && tradeSide(row) !== filters.side) return false;

    const product = compactProductTag(row.producttype || row.product_type || '-');
    if (filters.product && product !== filters.product) return false;

    const qty = Number(row.fillsize || row.quantity || 0);
    const lot = Number(row.marketlot || row.lotsize || 0);
    if (filters.qtyState === 'has' && qty <= 0) return false;
    if (filters.qtyState === 'lot' && lot <= 1) return false;

    const price = Number(row.fillprice || row.price || 0);
    if (filters.priceState === 'has' && price <= 0) return false;
    if (filters.priceState === 'missing' && price > 0) return false;

    const value = tradeValue(row);
    if (filters.valueState === 'has' && value <= 0) return false;
    if (filters.valueState === 'missing' && value > 0) return false;

    const ids = [row.orderid, row.fillid].filter(Boolean).join(' ').toLowerCase();
    if (filters.orderText && !ids.includes(filters.orderText.toLowerCase())) return false;
    if (filters.timeText && !String(row.filltime || '').toLowerCase().includes(filters.timeText.toLowerCase())) return false;

    return true;
  });
}

function groupTradesByExpiry(rows) {
  const sorted = [...rows].sort(compareTradesForGroup);
  const groups = new Map();

  for (const row of sorted) {
    const meta = tradeExpiryMeta(row);
    const current = groups.get(meta.key) || {
      key: meta.key,
      expiry: meta.label,
      exchanges: new Set(),
      count: 0,
      buy: 0,
      sell: 0,
      value: 0,
    };
    current.count += 1;
    current.value += tradeValue(row);
    if (tradeSide(row) === 'SELL') current.sell += 1;
    else current.buy += 1;
    if (row.exchange) current.exchanges.add(String(row.exchange));
    groups.set(meta.key, current);
  }

  const out = [];
  let lastKey = '';
  for (const row of sorted) {
    const meta = tradeExpiryMeta(row);
    if (meta.key !== lastKey) {
      const group = groups.get(meta.key);
      out.push({
        type: 'group',
        key: group.key,
        expiry: group.expiry,
        exchanges: [...group.exchanges].sort().join(' / ') || 'No Exchange',
        count: group.count,
        buy: group.buy,
        sell: group.sell,
        value: group.value,
      });
      lastKey = meta.key;
    }
    out.push({ type: 'row', row });
  }
  return out;
}

function compareTradesForGroup(a, b) {
  const ax = tradeExpiryMeta(a);
  const bx = tradeExpiryMeta(b);
  if (ax.sort !== bx.sort) return ax.sort - bx.sort;
  const exchangeDiff = String(a.exchange || '').localeCompare(String(b.exchange || ''));
  if (exchangeDiff) return exchangeDiff;
  const symbolDiff = String(a.tradingsymbol || '').localeCompare(String(b.tradingsymbol || ''));
  if (symbolDiff) return symbolDiff;
  return String(b.filltime || '').localeCompare(String(a.filltime || ''));
}

function tradeExpiryMeta(row) {
  const parsed = contractMeta(row);
  const label = parsed.expiry || row.expirydate || 'No Expiry';
  return {
    key: label,
    label,
    sort: label === 'No Expiry' ? Number.MAX_SAFE_INTEGER : expirySortValue(label),
  };
}

function expirySortValue(label) {
  const match = String(label || '').match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})$/);
  if (!match) return Number.MAX_SAFE_INTEGER - 1;
  const [, day, mon, year] = match;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(mon.toLowerCase());
  if (month < 0) return Number.MAX_SAFE_INTEGER - 1;
  const fullYear = Number(year.length === 2 ? `20${year}` : year);
  return new Date(fullYear, month, Number(day)).getTime();
}

function tradeRowKey(row, fallback) {
  return [row.fillid, row.orderid, row.tradingsymbol, row.filltime, fallback].filter(Boolean).join('|');
}

function emptyTradeLabel(rowCount, loading) {
  if (loading) return 'Loading trade book';
  if (rowCount) return 'No matching trades';
  return 'No trades';
}

function toTradeError(error) {
  const message = String(error?.message || '');
  if (isAuthError(error) || isRateLimited(error)) {
    const issue = classifyLoginError(error);
    return `${issue.title}. ${issue.hint}`;
  }
  return message || 'Failed to load trade book';
}

function findLoggedInUser(users, principal = {}) {
  const candidates = [
    principal.id,
    principal.user_id,
    principal.userId,
    principal.admin_id,
  ].filter((value) => value != null).map(String);

  if (candidates.length) {
    const byId = users.find((user) => candidates.includes(String(user.id)));
    if (byId) return byId;
  }

  const names = [
    principal.username,
    principal.user_name,
    principal.email,
  ].filter(Boolean).map((value) => String(value).toLowerCase());

  if (!names.length) return null;
  return users.find((user) => {
    const username = String(user.username || '').toLowerCase();
    const email = String(user.email || '').toLowerCase();
    return names.includes(username) || names.includes(email);
  }) || null;
}
