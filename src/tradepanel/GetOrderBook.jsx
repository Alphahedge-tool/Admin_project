// Get OrderBook: account selector + current Angel order book in the same
// compact trade-panel style used by Get Position.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, ClipboardList, Filter, Info, Radio, RefreshCw, Search, X } from 'lucide-react';
import { apiGet } from '../config/api';
import {
  classifyLoginError, isAuthError, isRateLimited,
} from '../feedmaster/angelSessionStore';
import {
  ensureBookSession, fetchBrokerBook, hasBookSession, isBookBroker, isKotakBroker,
  saveBookSession, useBrokerBookClient,
} from './brokerBookClient';
import { useOrderUpdates } from './orderUpdates';
import { useSharedTradeAccount, useSignedInAccounts } from './accountScope';
import { getSavedTradeAccount, saveTradeAccount } from './tradeAccountStore';
import { contractMeta, compactProductTag } from './symbolParse';
import { CompactSelect, PositionSelect } from './PositionSelect';
import './tradepanel.css';

const ORDER_COLUMNS = ['order', 'side', 'type', 'qty', 'price', 'status', 'updated'];

// Behind the live stream: a pushed update can be missed outright, and a merged
// row only reflects what was actually pushed. Re-reading the book on a slow
// timer is what stops it from quietly drifting away from the broker's.
const BACKGROUND_REFRESH_MS = 45000;

const defaultOrderColumnFilters = {
  symbol: '',
  exchange: '',
  expiry: '',
  optionType: '',
  side: '',
  product: '',
  orderType: '',
  variety: '',
  qtyState: '',
  priceState: '',
  avgState: '',
  orderStatus: '',
  updateState: '',
  updateText: '',
};

const statusFilters = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'complete', label: 'Complete' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Cancelled' },
];

function money(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n === 0) return '-';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function GetOrderBook() {
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState('');
  const [configs, setConfigs] = useState([]);
  const [configId, setConfigId] = useState('');
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('Select a user and account');
  // Starts true: until the user/config/credential setup below settles one way
  // or another, we're still "preparing" - staying in the loading state avoids
  // a "No orders" flash before the real auto-load kicks in.
  const [loading, setLoading] = useState(true);
  const [configLoading, setConfigLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [columnFilters, setColumnFilters] = useState(defaultOrderColumnFilters);
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
  // the table never flashes "No orders" for a frame while switching account.
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

  // Viewing bberlia in Get Position and switching here shows bberlia's order book:
  // the account picked on any Trade Panel page is adopted by all of them.
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
        setStatus(list.length ? 'Select account, then Get OrderBook' : 'No broker accounts configured for this user');
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
      setStatus(`${selectedBrokerName || 'Selected broker'} order book is not wired yet`);
      setLoading(false);
      return;
    }
    // An Angel account that failed the startup login says why (bad PIN, bad
    // TOTP, backend down) instead of a dead "not logged in". load() below
    // still tries a fresh login, so a fixed credential works on retry.
    setLoading(true);
    setStatus('');
  }, [configId, selectedBrokerName, selectedIsSupported]);

  useEffect(() => {
    if (!clientError) return;
    setStatus(clientError);
    setLoading(false);
  }, [clientError]);

  useEffect(() => {
    // Any in-flight load for the old selection must be ignored once the user
    // or account changes, otherwise a late response can repaint the old book.
    loadSeqRef.current += 1;
    autoLoadedAccountRef.current = '';
  }, [userId, configId]);

  // `options` is only ever passed internally - this is also wired straight to
  // onClick, where the first argument is a DOM event (which has no `.silent`).
  const load = useCallback(async (options) => {
    const silent = options?.silent === true;

    if (!selectedConfig) {
      setStatus('Select an account first');
      return;
    }
    if (!selectedIsSupported) {
      setStatus(`${selectedBrokerName || 'Selected broker'} order book is not wired yet`);
      return;
    }
    if (!client) {
      setStatus(`${selectedBrokerName || 'Selected broker'} account credentials are not ready`);
      return;
    }

    // Refreshes overlap (a background re-read, a resync after a dropped stream,
    // the user hitting Refresh) and do not necessarily come back in the order
    // they were sent. Only the newest may write to the table - an older book
    // landing last would put superseded order states back on screen.
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    const isLatest = () => seq === loadSeqRef.current;

    if (!silent) {
      setLoading(true);
      setStatus('Loading order book...');
    }
    try {
      // The startup login already saved this account's token; only a missing or
      // expired one goes back to the shared login (deduped across pages).
      let active = client;
      if (!hasBookSession(selectedBrokerName, active)) {
        if (!silent) setStatus('Signing in this account...');
        active = await ensureBookSession(configId, selectedBrokerName, active);
      }

      let body;
      try {
        body = await fetchBrokerBook('order', selectedBrokerName, active);
      } catch (error) {
        if (!isAuthError(error)) throw error;
        if (!silent) setStatus(`${selectedBrokerName || 'Selected broker'} token expired - signing in again...`);
        active = await ensureBookSession(configId, selectedBrokerName, active, { force: true });
        body = await fetchBrokerBook('order', selectedBrokerName, active);
      }

      // Worth saving even if this response is superseded - the token is good
      // regardless of whether its order book is still the one on screen.
      if (body.session) saveBookSession(configId, selectedBrokerName, body.session);
      if (!isLatest()) return;

      const orders = body.orders || [];
      setRows(orders);
      setStatus(orders.length ? `${orders.length} orders` : 'No orders in the order book');
    } catch (error) {
      if (isLatest()) setStatus(toOrderError(error));
    } finally {
      // Whoever turned the spinner on turns it off, superseded or not.
      if (!silent) setLoading(false);
    }
  }, [client, configId, selectedBrokerName, selectedConfig, selectedIsKotak, selectedIsSupported]);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  // The live stream is no longer started from the tail of load(). It used to be,
  // which meant an order book that failed to fetch even once - a rate limit is
  // enough - never connected at all, and never retried: the page just sat there
  // "Not live" until someone hit Refresh. The stream now stands on its own and
  // keeps itself up, whatever the REST call did.
  const liveStatus = useOrderUpdates({
    configId,
    client,
    brokerName: selectedBrokerName,
    enabled: selectedIsSupported,
    // Reconnected after a drop. Every update pushed while it was down is gone -
    // merging only ever patches in what actually arrives - so the book has to be
    // re-read rather than left with rows frozen at their pre-drop state.
    onResync: useCallback(() => loadRef.current?.({ silent: true }), []),
    onOrder: useCallback((order) => {
      setRows((current) => mergeOrderUpdate(current, order));
      const state = order.orderstatus || order.status;
      setStatus(state
        ? `Live update: ${order.tradingsymbol || 'order'} ${state}`
        : 'Live order update received');
    }, []),
  });

  // Last resort behind the stream: a push that never arrives cannot be
  // reconnected into existence. Skipped while the tab is hidden - nobody is
  // reading it, and coming back re-reads anyway.
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

  const summary = useMemo(() => buildOrderSummary(rows), [rows]);
  const filterOptions = useMemo(() => buildOrderFilterOptions(rows), [rows]);
  const visibleRows = useMemo(
    () => filterOrders(rows, statusFilter, query, columnFilters),
    [rows, statusFilter, query, columnFilters],
  );
  const tableRows = useMemo(() => groupOrdersByExpiry(visibleRows), [visibleRows]);
  const activeColumnFilterCount = Object.values(columnFilters).filter(Boolean).length;

  return (
    <div className="trade-panel">
      <div className="positions-view orderbook-view">
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
            {loading ? 'Loading' : 'Get OrderBook'}
          </button>

          <span className={`orderbook-live-pill ${liveStatus}`}>
            <Radio size={13} />
            {liveStatusLabel(liveStatus)}
          </span>

          <label className="orderbook-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search symbol, order id..."
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
            <div className="position-book-summary orderbook-summary">
              <div>
                <span>Total Orders</span>
                <strong>{rows.length}</strong>
                <em>{summary.buy} buy / {summary.sell} sell</em>
              </div>
              <div>
                <span className="buy">Open Orders</span>
                <strong>{summary.open}</strong>
                <em>Pending or trigger-pending</em>
              </div>
              <div>
                <span>Completed</span>
                <strong className="up">{summary.complete}</strong>
                <em>Fully traded orders</em>
              </div>
              <div>
                <span className="sell">Rejected / Cancelled</span>
                <strong className="down">{summary.rejected + summary.cancelled}</strong>
                <em>{summary.rejected} rejected / {summary.cancelled} cancelled</em>
              </div>
            </div>

            <div className="orderbook-filter-strip">
              {statusFilters.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  className={`orderbook-filter-chip${statusFilter === filter.value ? ' active' : ''}`}
                  onClick={() => setStatusFilter(filter.value)}
                >
                  {filter.label}
                  <span>{countForFilter(summary, filter.value, rows.length)}</span>
                </button>
              ))}
              <button className="orderbook-refresh-chip" type="button" onClick={load} disabled={loading}>
                <RefreshCw size={13} className={loading ? 'spin' : ''} /> Refresh
              </button>
              {activeColumnFilterCount > 0 && (
                <button className="orderbook-refresh-chip orderbook-clear-column-filters" type="button" onClick={() => setColumnFilters(defaultOrderColumnFilters)}>
                  <X size={13} /> Clear column filters
                </button>
              )}
            </div>
          </>
        )}

        <div className="positions-table-wrap">
          <table className="positions-table position-book-table orderbook-table">
            <thead>
              <tr>
                {ORDER_COLUMNS.map((column) => (
                  <th key={column} className={orderColumnIsNumeric(column) ? 'num' : ''}>
                    <OrderColumnHeader
                      column={column}
                      filters={columnFilters}
                      setFilters={setColumnFilters}
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
                  <tr key={`expiry-${item.key}-${index}`} className="position-expiry-row orderbook-expiry-row">
                    <td colSpan={7}>
                      <div className="position-expiry-row-content orderbook-expiry-content">
                        <span>{item.expiry}</span>
                        <small>{item.exchanges}</small>
                        <small>{item.count} order{item.count === 1 ? '' : 's'}</small>
                        <div className="orderbook-expiry-stats">
                          {item.open > 0 && <em className="open">{item.open} open</em>}
                          {item.complete > 0 && <em className="complete">{item.complete} complete</em>}
                          {item.rejected > 0 && <em className="rejected">{item.rejected} rejected</em>}
                          {item.cancelled > 0 && <em className="cancelled">{item.cancelled} cancelled</em>}
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={orderRowKey(item.row, index)} className={orderSide(item.row) === 'SELL' ? 'position-row-short' : ''}>
                    <td><OrderSymbolCell row={item.row} /></td>
                    <td><OrderSideCell row={item.row} /></td>
                    <td><OrderTypeCell row={item.row} /></td>
                    <td className="num"><OrderQtyCell row={item.row} /></td>
                    <td className="num"><OrderPriceCell row={item.row} /></td>
                    <td><OrderStatusCell row={item.row} /></td>
                    <td><OrderTimeCell row={item.row} /></td>
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
                      <strong>{emptyLabel(rows.length, loading)}</strong>
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

function OrderSymbolCell({ row }) {
  const symbol = String(row.tradingsymbol || row.symbolname || row.symbol || '-');
  const parsed = contractMeta(row);
  return (
    <div className="position-symbol-line orderbook-symbol-line" title={symbol}>
      <span className="orderbook-icon-chip"><ClipboardList size={13} /></span>
      <strong>{parsed.root}</strong>
      {parsed.expiry && <span className="position-expiry">{parsed.expiry}</span>}
      {parsed.strike && <span className="position-strike">{parsed.strike}</span>}
      {parsed.optionType && <span className={`book-tag option ${parsed.optionType.toLowerCase()}`}>{parsed.optionType}</span>}
      {row.exchange && <span className="book-tag exchange">{row.exchange}</span>}
      {row.orderid && <small className="orderbook-order-id">#{row.orderid}</small>}
    </div>
  );
}

function OrderSideCell({ row }) {
  const side = orderSide(row);
  return <span className={`book-tag side ${side === 'SELL' ? 'sell' : 'buy'}`}>{side}</span>;
}

function OrderTypeCell({ row }) {
  const product = compactProductTag(row.producttype || row.product_type || '-');
  const orderType = String(row.ordertype || row.order_type || '-').toUpperCase();
  const variety = String(row.variety || '').toUpperCase();
  return (
    <div className="book-product-cell orderbook-type-cell">
      <span className="book-tag product">{product}</span>
      <span className={`orderbook-mini-tag ${orderTypeClass(orderType)}`}>{orderType}</span>
      {variety && <span className={`orderbook-mini-tag variety ${orderVarietyClass(variety)}`}>{variety}</span>}
    </div>
  );
}

function OrderQtyCell({ row }) {
  const qty = Number(row.quantity || row.qty || 0);
  const filled = Number(row.filledshares || row.filled_qty || row.filled || 0);
  return (
    <div className="book-qty-cell orderbook-qty-cell">
      <span>{qty.toLocaleString('en-IN')}</span>
      {filled > 0 && (
        <small className="orderbook-filled-badge">
          <span>{filled.toLocaleString('en-IN')}</span> filled
        </small>
      )}
    </div>
  );
}

function OrderPriceCell({ row }) {
  const price = Number(row.price || 0);
  const avg = Number(row.averageprice || row.average_price || 0);
  return (
    <div className="orderbook-price-cell">
      <span className={price > 0 ? 'position-price' : 'position-price-muted'}>{money(price)}</span>
      {avg > 0 && (
        <small className="orderbook-avg-chip">
          <span>Avg</span> {money(avg)}
        </small>
      )}
    </div>
  );
}

function orderTypeClass(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('stoploss')) return 'stoploss';
  if (text.includes('market')) return 'market';
  if (text.includes('limit')) return 'limit';
  return 'default';
}

function orderVarietyClass(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('stoploss')) return 'stoploss';
  if (text.includes('robo')) return 'robo';
  if (text.includes('normal')) return 'normal';
  return 'default';
}

function OrderStatusCell({ row }) {
  const status = normalizedStatus(row);
  const label = String(row.orderstatus || row.status || '-').toUpperCase();
  const rejectionText = String(row.text || '').trim();
  const hasRejection = status === 'rejected' && rejectionText;
  const rejectionCause = rejectionCauseText(rejectionText);
  return (
    <div className="orderbook-status-cell">
      {hasRejection ? (
        <div className="orderbook-status-row">
          <span className={`orderbook-status-chip ${status}`}>{label}</span>
          <div className="orderbook-rejection-line">
            <RejectionTooltipButton text={rejectionText} cause={rejectionCause} />
          </div>
        </div>
      ) : (
        <>
          <span className={`orderbook-status-chip ${status}`}>{label}</span>
          {row.text && <small title={row.text}>{row.text}</small>}
        </>
      )}
    </div>
  );
}

function RejectionTooltipButton({ text, cause }) {
  const [tooltip, setTooltip] = useState(null);

  const show = useCallback((event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setTooltip({
      text,
      cause,
      left: rect.left + (rect.width / 2),
      top: rect.top,
    });
  }, [cause, text]);

  const hide = useCallback(() => setTooltip(null), []);

  return (
    <>
      <button
        className="orderbook-rejection-trigger"
        type="button"
        aria-label="Show rejection reason"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        <AlertTriangle size={13} strokeWidth={2.4} />
      </button>
      {tooltip && createPortal(
        <div
          className="orderbook-rejection-tooltip orderbook-rejection-tooltip-portal"
          role="tooltip"
          style={{
            left: `${tooltip.left}px`,
            top: `${tooltip.top}px`,
          }}
        >
          <div className="orderbook-rejection-tooltip-head">
            <span><AlertTriangle size={14} strokeWidth={2.4} /></span>
            <em>Rejected Reason</em>
          </div>
          <strong>{tooltip.cause}</strong>
          <p>{tooltip.text}</p>
        </div>,
        document.body
      )}
    </>
  );
}

function rejectionCauseText(text) {
  const message = String(text || '').trim();
  if (!message) return 'Order rejected';
  const [firstPart] = message.split(/[.;|]/);
  return (firstPart || message).trim();
}

function OrderTimeCell({ row }) {
  const time = row.updatetime || row.exchorderupdatetime || row.exchtime || row.filltime || '-';
  return (
    <div className="orderbook-time-cell">
      <span>{time}</span>
      {row.uniqueorderid && <small>{row.uniqueorderid}</small>}
    </div>
  );
}

function orderSide(row) {
  return String(row.transactiontype || row.transaction_type || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
}

function normalizedStatus(row) {
  const text = String(row.orderstatus || row.status || '').toLowerCase();
  if (text.includes('cancel')) return 'cancelled';
  if (text.includes('reject')) return 'rejected';
  if (text.includes('complete') || text.includes('traded')) return 'complete';
  if (text.includes('open') || text.includes('pending') || text.includes('trigger')) return 'open';
  return 'other';
}

function buildOrderSummary(rows) {
  return rows.reduce((acc, row) => {
    const status = normalizedStatus(row);
    acc[status] = (acc[status] || 0) + 1;
    if (orderSide(row) === 'SELL') acc.sell += 1;
    else acc.buy += 1;
    return acc;
  }, { buy: 0, sell: 0, open: 0, complete: 0, rejected: 0, cancelled: 0, other: 0 });
}

function countForFilter(summary, filter, total) {
  if (filter === 'all') return total;
  return summary[filter] || 0;
}

function orderColumnLabel(key) {
  const labels = {
    order: 'Order',
    side: 'Side',
    type: 'Type',
    qty: 'Qty',
    price: 'Price',
    status: 'Status',
    updated: 'Updated',
  };
  return labels[key] || key;
}

function orderColumnIsNumeric(key) {
  return ['qty', 'price'].includes(key);
}

function OrderColumnHeader({
  column,
  filters,
  setFilters,
  filterOptions,
  openFilter,
  setOpenFilter,
}) {
  const active = orderColumnFilterActive(column, filters);
  const filterButtonRef = useRef(null);

  return (
    <div className="position-col-head orderbook-col-head">
      <span className="orderbook-col-title">{orderColumnLabel(column)}</span>
      <button
        ref={filterButtonRef}
        className={`position-filter-btn${active ? ' active' : ''}`}
        type="button"
        title={`Filter ${orderColumnLabel(column)}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpenFilter(openFilter === column ? '' : column);
        }}
      >
        <Filter size={13} />
      </button>
      {openFilter === column && (
        <OrderFilterMenu
          column={column}
          filters={filters}
          setFilters={setFilters}
          filterOptions={filterOptions}
          anchorRef={filterButtonRef}
          align={column === 'order' ? 'left' : 'right'}
          onClose={() => setOpenFilter('')}
        />
      )}
    </div>
  );
}

function OrderFilterMenu({ column, filters, setFilters, filterOptions, anchorRef, align, onClose }) {
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

      const menuWidth = column === 'order' ? 250 : 230;
      const viewportPad = 8;
      const wantedLeft = align === 'left' ? rect.left : rect.right - menuWidth;
      const left = Math.min(
        Math.max(viewportPad, wantedLeft),
        window.innerWidth - menuWidth - viewportPad,
      );
      const top = Math.min(rect.bottom + 8, window.innerHeight - viewportPad);

      setMenuStyle({
        top: `${top}px`,
        left: `${left}px`,
        width: `${menuWidth}px`,
        visibility: 'visible',
      });
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

  if (column === 'order') {
    reset = ['symbol', 'exchange', 'expiry', 'optionType'];
    body = (
      <>
        <label className="position-filter-field">
          <span>Search</span>
          <input value={filters.symbol} onChange={(event) => patch('symbol', event.target.value)} placeholder="SENSEX, order id..." />
        </label>
        {select('Exchange', 'exchange', filterOptions.exchanges)}
        {select('Expiry', 'expiry', filterOptions.expiries)}
        {select('Option', 'optionType', filterOptions.optionTypes)}
      </>
    );
  } else if (column === 'side') {
    reset = ['side'];
    body = select('Side', 'side', ['BUY', 'SELL']);
  } else if (column === 'type') {
    reset = ['product', 'orderType', 'variety'];
    body = (
      <>
        {select('Product', 'product', filterOptions.products)}
        {select('Order Type', 'orderType', filterOptions.orderTypes)}
        {select('Variety', 'variety', filterOptions.varieties)}
      </>
    );
  } else if (column === 'qty') {
    reset = ['qtyState'];
    body = select('Quantity', 'qtyState', [
      { value: 'filled', label: 'Has filled qty' },
      { value: 'unfilled', label: 'No filled qty' },
      { value: 'partial', label: 'Partial fill' },
      { value: 'complete', label: 'Fully filled' },
    ]);
  } else if (column === 'price') {
    reset = ['priceState', 'avgState'];
    body = (
      <>
        {select('Order Price', 'priceState', [
          { value: 'has', label: 'Has price' },
          { value: 'missing', label: 'No price' },
        ])}
        {select('Average', 'avgState', [
          { value: 'has', label: 'Has average' },
          { value: 'missing', label: 'No average' },
        ])}
      </>
    );
  } else if (column === 'status') {
    reset = ['orderStatus'];
    body = select('Status', 'orderStatus', filterOptions.statuses);
  } else if (column === 'updated') {
    reset = ['updateState', 'updateText'];
    body = (
      <>
        {select('Time', 'updateState', [
          { value: 'has', label: 'Has update time' },
          { value: 'missing', label: 'No update time' },
        ])}
        <label className="position-filter-field">
          <span>Search</span>
          <input value={filters.updateText} onChange={(event) => patch('updateText', event.target.value)} placeholder="08-Jul, 09:27..." />
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

function orderColumnFilterActive(column, filters) {
  if (column === 'order') return Boolean(filters.symbol || filters.exchange || filters.expiry || filters.optionType);
  if (column === 'side') return Boolean(filters.side);
  if (column === 'type') return Boolean(filters.product || filters.orderType || filters.variety);
  if (column === 'qty') return Boolean(filters.qtyState);
  if (column === 'price') return Boolean(filters.priceState || filters.avgState);
  if (column === 'status') return Boolean(filters.orderStatus);
  if (column === 'updated') return Boolean(filters.updateState || filters.updateText);
  return false;
}

function buildOrderFilterOptions(rows) {
  const exchanges = new Set();
  const expiries = new Map();
  const optionTypes = new Set();
  const products = new Set();
  const orderTypes = new Set();
  const varieties = new Set();
  const statuses = new Set();

  for (const row of rows) {
    if (row.exchange) exchanges.add(String(row.exchange));
    const expiry = orderExpiryMeta(row);
    if (expiry.label && expiry.label !== 'No Expiry') expiries.set(expiry.label, expiry.sort);
    const parsed = contractMeta(row);
    if (parsed.optionType) optionTypes.add(parsed.optionType);
    const product = compactProductTag(row.producttype || row.product_type || '-');
    if (product && product !== '-') products.add(product);
    const orderType = String(row.ordertype || row.order_type || '').toUpperCase();
    if (orderType) orderTypes.add(orderType);
    const variety = String(row.variety || '').toUpperCase();
    if (variety) varieties.add(variety);
    const status = String(row.orderstatus || row.status || '').toUpperCase();
    if (status) statuses.add(status);
  }

  return {
    exchanges: [...exchanges].sort(),
    expiries: [...expiries.entries()].sort((a, b) => a[1] - b[1]).map(([label]) => label),
    optionTypes: [...optionTypes].sort(),
    products: [...products].sort(),
    orderTypes: [...orderTypes].sort(),
    varieties: [...varieties].sort(),
    statuses: [...statuses].sort(),
  };
}

function filterOrders(rows, statusFilter, query, filters = defaultOrderColumnFilters) {
  const text = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (statusFilter !== 'all' && normalizedStatus(row) !== statusFilter) return false;
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
      row.uniqueorderid,
      row.exchangeorderid,
      row.status,
      row.orderstatus,
      row.text,
    ].filter(Boolean).join(' ').toLowerCase();

    if (text && !rowText.includes(text)) return false;
    if (filters.symbol && !rowText.includes(filters.symbol.toLowerCase())) return false;
    if (filters.exchange && String(row.exchange || '') !== filters.exchange) return false;
    if (filters.expiry && parsed.expiry !== filters.expiry) return false;
    if (filters.optionType && parsed.optionType !== filters.optionType) return false;
    if (filters.side && orderSide(row) !== filters.side) return false;

    const product = compactProductTag(row.producttype || row.product_type || '-');
    const orderType = String(row.ordertype || row.order_type || '').toUpperCase();
    const variety = String(row.variety || '').toUpperCase();
    if (filters.product && product !== filters.product) return false;
    if (filters.orderType && orderType !== filters.orderType) return false;
    if (filters.variety && variety !== filters.variety) return false;

    const qty = Number(row.quantity || row.qty || 0);
    const filled = Number(row.filledshares || row.filled_qty || row.filled || 0);
    if (filters.qtyState === 'filled' && filled <= 0) return false;
    if (filters.qtyState === 'unfilled' && filled > 0) return false;
    if (filters.qtyState === 'partial' && !(filled > 0 && filled < qty)) return false;
    if (filters.qtyState === 'complete' && !(qty > 0 && filled >= qty)) return false;

    const price = Number(row.price || 0);
    const avg = Number(row.averageprice || row.average_price || 0);
    if (filters.priceState === 'has' && price <= 0) return false;
    if (filters.priceState === 'missing' && price > 0) return false;
    if (filters.avgState === 'has' && avg <= 0) return false;
    if (filters.avgState === 'missing' && avg > 0) return false;

    const status = String(row.orderstatus || row.status || '').toUpperCase();
    if (filters.orderStatus && status !== filters.orderStatus) return false;

    const updated = orderUpdateText(row);
    if (filters.updateState === 'has' && !updated) return false;
    if (filters.updateState === 'missing' && updated) return false;
    if (filters.updateText && !updated.toLowerCase().includes(filters.updateText.toLowerCase())) return false;

    return true;
  });
}

function orderUpdateText(row) {
  return String(row.updatetime || row.exchorderupdatetime || row.exchtime || row.filltime || '');
}

function mergeOrderUpdate(rows, incoming) {
  const key = orderIdentity(incoming);
  if (!key) return [incoming, ...rows];

  let matched = false;
  const next = rows.map((row) => {
    if (orderIdentity(row) !== key) return row;
    matched = true;
    return { ...row, ...incoming };
  });
  return matched ? next : [incoming, ...next];
}

function orderIdentity(row) {
  return String(row.uniqueorderid || row.orderid || row.exchangeorderid || '').trim();
}

function liveStatusLabel(status) {
  if (status === 'live') return 'Live';
  if (status === 'connecting') return 'Connecting';
  if (status === 'offline') return 'Offline';
  return 'Not live';
}

function groupOrdersByExpiry(rows) {
  const sorted = [...rows].sort(compareOrdersForExpiryGroup);
  const groups = new Map();

  for (const row of sorted) {
    const meta = orderExpiryMeta(row);
    const current = groups.get(meta.key) || {
      key: meta.key,
      expiry: meta.label,
      sort: meta.sort,
      exchanges: new Set(),
      count: 0,
      open: 0,
      complete: 0,
      rejected: 0,
      cancelled: 0,
    };
    const status = normalizedStatus(row);
    current.count += 1;
    current[status] = (current[status] || 0) + 1;
    if (row.exchange) current.exchanges.add(String(row.exchange));
    groups.set(meta.key, current);
  }

  const out = [];
  let lastKey = '';
  for (const row of sorted) {
    const meta = orderExpiryMeta(row);
    if (meta.key !== lastKey) {
      const group = groups.get(meta.key);
      out.push({
        type: 'group',
        key: group.key,
        expiry: group.expiry,
        count: group.count,
        open: group.open || 0,
        complete: group.complete || 0,
        rejected: group.rejected || 0,
        cancelled: group.cancelled || 0,
        exchanges: [...group.exchanges].sort().join(' / ') || 'No Exchange',
      });
      lastKey = meta.key;
    }
    out.push({ type: 'row', row });
  }
  return out;
}

function compareOrdersForExpiryGroup(a, b) {
  const ax = orderExpiryMeta(a);
  const bx = orderExpiryMeta(b);
  if (ax.sort !== bx.sort) return ax.sort - bx.sort;
  const exchangeDiff = String(a.exchange || '').localeCompare(String(b.exchange || ''));
  if (exchangeDiff) return exchangeDiff;
  const symbolDiff = String(a.tradingsymbol || '').localeCompare(String(b.tradingsymbol || ''));
  if (symbolDiff) return symbolDiff;
  return String(b.updatetime || b.exchorderupdatetime || '').localeCompare(String(a.updatetime || a.exchorderupdatetime || ''));
}

function orderExpiryMeta(row) {
  const parsed = contractMeta(row);
  const label = parsed.expiry || 'No Expiry';
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

function orderRowKey(row, fallback) {
  return [
    row.uniqueorderid,
    row.orderid,
    row.exchangeorderid,
    row.tradingsymbol,
    fallback,
  ].filter(Boolean).join('|');
}

function emptyLabel(rowCount, loading) {
  if (loading) return 'Loading order book';
  if (rowCount) return 'No matching orders';
  return 'No orders';
}

// A login that could not be recovered says what is actually wrong with the
// account (PIN, TOTP, API key, backend down) - the user can only fix it if the
// screen names it.
function toOrderError(error) {
  const message = String(error?.message || '');
  if (isAuthError(error) || isRateLimited(error)) {
    const issue = classifyLoginError(error);
    return `${issue.title}. ${issue.hint}`;
  }
  return message || 'Failed to load order book';
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
