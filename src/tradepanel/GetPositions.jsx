// Get Position: pill selectors for user/account + the selected account's positions.
// Angel One is wired today; other brokers can be selected and added later.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpDown, Check, Filter, Info, Layers, X } from 'lucide-react';
import { apiGet, apiPost } from '../config/api';
import { getSavedSession, isAngelBroker, saveSession } from '../feedmaster/feedMasterStore';
import { compactProductTag, parseTradingSymbol } from './symbolParse';
import { CompactSelect, PositionSelect } from './PositionSelect';
import './tradepanel.css';

const POSITION_COLUMNS = ['stock', 'product', 'netQty', 'buyAvg', 'sellAvg', 'ltp', 'pnl'];

const defaultPositionFilters = {
  symbol: '',
  exchange: '',
  expiry: '',
  optionType: '',
  product: '',
  side: '',
  netQty: '',
  buyAvg: '',
  sellAvg: '',
  ltp: '',
  pnl: '',
};

function money(v) {
  const n = Number(v || 0);
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Angel returns pnl on some payloads; otherwise derive from realised+unrealised.
function pnlOf(row) {
  if (row.pnl != null && row.pnl !== '') return Number(row.pnl);
  return Number(row.realised || 0) + Number(row.unrealised || 0);
}

export default function GetPositions() {
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState('');
  const [configs, setConfigs] = useState([]);
  const [configId, setConfigId] = useState('');
  const [client, setClient] = useState(null);
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('Select a user and account');
  const [loading, setLoading] = useState(false);
  const [configLoading, setConfigLoading] = useState(false);
  const [sort, setSort] = useState({ key: 'stock', dir: 'asc' });
  const [filters, setFilters] = useState(defaultPositionFilters);
  const [openFilter, setOpenFilter] = useState('');
  const [selectedPositionKeys, setSelectedPositionKeys] = useState(() => new Set());
  const [strategyDialogOpen, setStrategyDialogOpen] = useState(false);
  const [strategyName, setStrategyName] = useState('');
  const [strategyError, setStrategyError] = useState('');
  const [savingStrategy, setSavingStrategy] = useState(false);
  const [existingStrategies, setExistingStrategies] = useState([]);
  const [strategyMode, setStrategyMode] = useState('new'); // 'new' | 'existing'
  const [selectedStrategyCode, setSelectedStrategyCode] = useState('');
  const autoLoadedAccountRef = useRef('');

  const selectedConfig = configs.find((config) => String(config.id) === String(configId));
  const selectedUser = users.find((user) => String(user.id) === String(userId));
  const selectedUserLabel = selectedUser
    ? (selectedUser.username || `${selectedUser.first_name || ''} ${selectedUser.last_name || ''}`.trim() || `User ${selectedUser.id}`)
    : '';
  const selectedBrokerName = selectedConfig?.broker_name || '';
  const selectedIsAngel = isAngelBroker(selectedBrokerName);

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
          return;
        }

        const list = usersOut.value.data || [];
        setUsers(list);
        const auth = authOut.status === 'fulfilled' ? authOut.value : null;
        const principal = auth?.user || auth?.admin || auth?.data || auth || {};
        const current = findLoggedInUser(list, principal) || list[0];
        if (current?.id) {
          setUserId(String(current.id));
          setStatus(`Select account for ${current.username || 'user'}`);
        } else {
          setStatus('No users available');
        }
      } catch {
        if (!cancelled) setStatus('Failed to load users');
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
        setClient(null);
        return;
      }

      setConfigLoading(true);
      setRows([]);
      setClient(null);
      try {
        const res = await apiGet(`/users/broker-config/list.php?user_id=${userId}`);
        if (cancelled) return;

        const list = res.data || [];
        setConfigs(list);
        setConfigId(String(list[0]?.id || ''));
        setStatus(list.length ? 'Select account, then Get Positions' : 'No broker accounts configured for this user');
      } catch {
        if (!cancelled) setStatus('Failed to load broker accounts');
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
    let cancelled = false;

    async function hydrateConfig() {
      setRows([]);
      setClient(null);
      if (!configId) return;

      if (!selectedIsAngel) {
        setStatus(`${selectedBrokerName || 'Selected broker'} positions are not wired yet`);
        return;
      }

      setStatus('Loading account credentials...');
      try {
        const res = await apiGet(`/users/broker-config/get.php?id=${configId}`);
        if (cancelled) return;

        const c = res.data || {};
        if (!c.account_id || !c.app_key || !c.pin || !c.totp_secret) {
          setStatus('This Angel account is missing Client Code / PIN / TOTP / API Key');
          return;
        }

        const session = getSavedSession(configId);
        setClient({
          enabled: true,
          alias: `${selectedBrokerName} - ${c.account_id}`,
          clientCode: c.account_id,
          apiKey: c.app_key,
          pin: c.pin,
          totpSecret: c.totp_secret,
          loggedIn: !!session?.jwtToken,
          session,
        });
        setStatus(session?.jwtToken ? '' : 'This account is not logged in. Login from Broker Configuration first.');
      } catch {
        if (!cancelled) setStatus('Failed to load account credentials');
      }
    }

    hydrateConfig();
    return () => {
      cancelled = true;
    };
  }, [configId, selectedBrokerName, selectedIsAngel]);

  useEffect(() => {
    autoLoadedAccountRef.current = '';
  }, [configId]);

  const load = useCallback(async () => {
    if (!selectedConfig) {
      setStatus('Select an account first');
      return;
    }
    if (!selectedIsAngel) {
      setStatus(`${selectedBrokerName || 'Selected broker'} positions are not wired yet`);
      return;
    }
    if (!client) {
      setStatus('Angel account credentials are not ready');
      return;
    }
    if (!client.session?.jwtToken) {
      setStatus('This account is not logged in. Login from Broker Configuration first.');
      return;
    }
    setLoading(true);
    setStatus('Loading positions...');
    try {
      const res = await fetch('/api/angel/positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status === false) throw new Error(body.message || `HTTP ${res.status}`);
      if (body.session?.jwtToken) {
        saveSession(configId, body.session);
        setClient((current) => (current ? { ...current, session: body.session, loggedIn: true } : current));
      }
      const positions = body.positions || [];
      setRows(positions);
      setStatus(positions.length ? `${positions.length} positions` : 'No open positions');
    } catch (e) {
      setStatus(toPositionError(e));
    } finally {
      setLoading(false);
    }
  }, [client, configId, selectedBrokerName, selectedConfig, selectedIsAngel]);

  useEffect(() => {
    const accountKey = String(configId || '');
    if (!accountKey || !selectedConfig || !selectedIsAngel || !client?.session?.jwtToken || loading) return;
    if (autoLoadedAccountRef.current === accountKey) return;

    autoLoadedAccountRef.current = accountKey;
    load();
  }, [client, configId, load, loading, selectedConfig, selectedIsAngel]);

  const totalPnl = rows.reduce((sum, r) => sum + pnlOf(r), 0);
  const longCount = rows.filter((row) => Number(row.netqty || 0) > 0).length;
  const shortCount = rows.filter((row) => Number(row.netqty || 0) < 0).length;
  const filterOptions = useMemo(() => buildFilterOptions(rows), [rows]);
  const visibleRows = useMemo(() => sortPositionRows(filterPositionRows(rows, filters), sort), [rows, filters, sort]);
  const tableRows = useMemo(
    () => (sort.key === 'stock'
      ? groupPositionsByExpiryAndExchange(visibleRows)
      : visibleRows.map((row) => ({ type: 'row', row }))),
    [visibleRows, sort.key],
  );
  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const togglePositionSelection = useCallback((key) => {
    setSelectedPositionKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  useEffect(() => {
    setSelectedPositionKeys(new Set());
    setStrategyDialogOpen(false);
    setStrategyName('');
    setStrategyError('');
  }, [configId, rows]);

  const selectedCount = selectedPositionKeys.size;

  // Map the checked row keys back to the actual position rows (the strategy legs).
  const selectedLegs = useMemo(() => {
    const legs = [];
    tableRows.forEach((item, index) => {
      if (item.type !== 'row') return;
      if (selectedPositionKeys.has(positionRowKey(item.row, index))) legs.push(item.row);
    });
    return legs;
  }, [tableRows, selectedPositionKeys]);

  const openStrategyDialog = useCallback(async () => {
    if (!userId) {
      setStatus('Select a user first');
      return;
    }
    setStrategyError('');
    setStrategyName('');
    setStrategyMode('new');
    setSelectedStrategyCode('');
    setExistingStrategies([]);
    setStrategyDialogOpen(true);

    // Load this user's existing strategies so they can add legs to one.
    try {
      const res = await apiGet(`/strategy-master/list.php?user_id=${userId}`);
      setExistingStrategies(res.data || []);
    } catch {
      setExistingStrategies([]);
    }
  }, [userId]);

  const saveStrategy = useCallback(async () => {
    if (!userId) {
      setStrategyError('Select a user first');
      return;
    }

    const legs = selectedLegs.map((row) => ({
      symbol_token: row.symboltoken ?? '',
      trading_symbol: row.tradingsymbol ?? row.symbolname ?? row.symbol ?? '',
      exchange: row.exchange ?? '',
      product_type: row.producttype ?? row.product_type ?? '',
      net_qty: Number(row.netqty ?? 0),
      buy_avg: positionBuyAvg(row),
      sell_avg: positionSellAvg(row),
      ltp: positionValue(row, ['ltp', 'LTP', 'lasttradedprice']),
      pnl: pnlOf(row),
    }));

    let body;
    if (strategyMode === 'existing') {
      // Add to an existing strategy — reuse its strategy_code, no new strategy.
      if (!selectedStrategyCode) {
        setStrategyError('Pick a strategy to add to');
        return;
      }
      body = { user_id: Number(userId), strategy_code: selectedStrategyCode, legs };
    } else {
      const name = strategyName.trim();
      if (!name) {
        setStrategyError('Enter a strategy name');
        return;
      }
      body = { user_id: Number(userId), strategy_name: name, legs };
    }

    setSavingStrategy(true);
    setStrategyError('');
    try {
      const res = await apiPost('/strategy-master/create.php', body);
      const legsSaved = res.data?.legs_saved;
      const parts = [res.message || 'Strategy saved'];
      if (typeof legsSaved === 'number') parts.push(`${legsSaved} leg${legsSaved === 1 ? '' : 's'}`);
      setStatus(parts.join(' · '));
      setStrategyDialogOpen(false);
      setStrategyName('');
      setSelectedStrategyCode('');
      setSelectedPositionKeys(new Set());
    } catch (error) {
      setStrategyError(error.message || 'Failed to save strategy');
    } finally {
      setSavingStrategy(false);
    }
  }, [strategyMode, selectedStrategyCode, strategyName, userId, selectedLegs]);

  return (
    <div className="trade-panel">
      <div className="positions-view">
        <div className="positions-toolbar">
          <CompactSelect
            title="User"
            value={userId}
            onChange={setUserId}
            options={users.map((user) => ({
              value: String(user.id),
              label: user.username || `${user.first_name || ''} ${user.last_name || ''}`.trim() || `User ${user.id}`,
            }))}
          />

          <CompactSelect
            title="Account"
            value={configId}
            onChange={setConfigId}
            disabled={configLoading || !configs.length}
            options={configs.map((config) => ({
              value: String(config.id),
              label: config.account_id || `Account ${config.id}`,
              meta: config.broker_name || 'Broker',
            }))}
          />

          <button className="positions-load-btn" onClick={load} disabled={loading || !selectedConfig || (selectedIsAngel && !client)} type="button">
            {loading ? 'Loading' : 'Get Positions'}
          </button>
          {rows.length > 0 && (
            <span className={`positions-total ${totalPnl >= 0 ? 'up' : 'down'}`}>
              Total P&amp;L: {money(totalPnl)}
            </span>
          )}
          {activeFilterCount > 0 && (
            <button className="positions-clear-filters" type="button" onClick={() => setFilters(defaultPositionFilters)}>
              <X size={14} /> Clear filters
            </button>
          )}
          {status && <span className="positions-status">{status}</span>}
        </div>

        {selectedCount > 0 && (
          <div className="positions-selection-bar">
            <span className="positions-selection-count">{selectedCount} selected</span>
            <button type="button" className="positions-group-btn" onClick={openStrategyDialog}>
              <Layers size={14} /> Add to Group
            </button>
            <button
              type="button"
              className="positions-selection-clear"
              onClick={() => setSelectedPositionKeys(new Set())}
            >
              Clear
            </button>
          </div>
        )}

        {rows.length > 0 && (
          <div className="position-book-summary">
            <div>
              <span className="buy">Long Positions</span>
              <strong>{longCount}</strong>
              <em>Net qty above zero</em>
            </div>
            <div>
              <span className="sell">Short Positions</span>
              <strong>{shortCount}</strong>
              <em>Net qty below zero</em>
            </div>
            <div>
              <span>Total P&amp;L</span>
              <strong className={totalPnl >= 0 ? 'up' : 'down'}>{money(totalPnl)}</strong>
              <em>{rows.length} Positions</em>
            </div>
          </div>
        )}

        <div className="positions-table-wrap">
          <table className="positions-table position-book-table">
            <thead>
              <tr>
                {POSITION_COLUMNS.map((column) => (
                  <th key={column} className={positionColumnIsNumeric(column) ? 'num' : ''}>
                    <PositionColumnHeader
                      column={column}
                      sort={sort}
                      setSort={setSort}
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
              {tableRows.map((item, i) => (
                item.type === 'group' ? (
                  <tr key={`group-${item.expiry}-${item.exchange}-${i}`} className="position-expiry-row">
                    <td colSpan={POSITION_COLUMNS.length}>
                      <div className="position-expiry-row-content">
                        <span>{item.expiry}</span>
                        <small>{item.exchange}</small>
                        <small>{item.count} positions</small>
                        <strong className={item.pnl >= 0 ? 'up' : 'down'}>
                          Group P&amp;L: {money(item.pnl)}
                        </strong>
                      </div>
                    </td>
                  </tr>
                ) : (
                  (() => {
                    const rowKey = positionRowKey(item.row, i);
                    const selected = selectedPositionKeys.has(rowKey);
                    return (
                  <tr
                    key={rowKey}
                    className={`${Number(item.row.netqty || 0) < 0 ? 'position-row-short' : ''}${selected ? ' position-row-selected' : ''}`}
                  >
                    {POSITION_COLUMNS.map((column) => (
                      <td key={column} className={positionColumnIsNumeric(column) ? 'num' : ''}>
                        {renderPositionCell(item.row, column, {
                          selected,
                          rowKey,
                          onToggle: togglePositionSelection,
                        })}
                      </td>
                    ))}
                  </tr>
                    );
                  })()
                )
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="positions-empty" colSpan={POSITION_COLUMNS.length}>
                    <div className="positions-empty-state">
                      <button
                        className="positions-empty-action"
                        type="button"
                        onClick={load}
                        disabled={loading || !selectedConfig || (selectedIsAngel && !client)}
                      >
                        <Info size={18} />
                      </button>
                      <strong>{loading ? 'Loading positions' : 'No positions'}</strong>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {strategyDialogOpen && createPortal(
          <div
            className="strategy-dialog-backdrop"
            onMouseDown={() => { if (!savingStrategy) setStrategyDialogOpen(false); }}
          >
            <div className="strategy-dialog" onMouseDown={(event) => event.stopPropagation()}>
              <div className="strategy-dialog-head">
                <div className="strategy-dialog-title">
                  <Layers size={16} />
                  <strong>Add to Group</strong>
                </div>
                <button
                  type="button"
                  className="strategy-dialog-close"
                  onClick={() => setStrategyDialogOpen(false)}
                  disabled={savingStrategy}
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="strategy-dialog-body">
                <p className="strategy-dialog-meta">
                  {selectedCount} position{selectedCount === 1 ? '' : 's'} selected
                  {selectedUserLabel && <> &middot; for <strong>{selectedUserLabel}</strong></>}
                </p>

                {existingStrategies.length > 0 && (
                  <div className="strategy-mode-toggle">
                    <button
                      type="button"
                      className={strategyMode === 'new' ? 'active' : ''}
                      onClick={() => { setStrategyMode('new'); setStrategyError(''); }}
                    >
                      New strategy
                    </button>
                    <button
                      type="button"
                      className={strategyMode === 'existing' ? 'active' : ''}
                      onClick={() => { setStrategyMode('existing'); setStrategyError(''); }}
                    >
                      Add to existing
                    </button>
                  </div>
                )}

                {strategyMode === 'existing' ? (
                  <label className="strategy-dialog-field">
                    <span>Existing strategy</span>
                    <PositionSelect
                      value={selectedStrategyCode}
                      onChange={setSelectedStrategyCode}
                      emptyLabel="Select a strategy"
                      portal
                      options={existingStrategies.map((strategy) => ({
                        value: strategy.strategy_code,
                        label: strategy.strategy_name,
                        meta: `${(strategy.legs || []).length} legs`,
                      }))}
                    />
                  </label>
                ) : (
                  <label className="strategy-dialog-field">
                    <span>Strategy name</span>
                    <input
                      autoFocus
                      type="text"
                      value={strategyName}
                      maxLength={100}
                      placeholder="e.g. Nifty Iron Condor"
                      onChange={(event) => setStrategyName(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter') saveStrategy(); }}
                    />
                  </label>
                )}
                {strategyError && <p className="strategy-dialog-error">{strategyError}</p>}
              </div>

              <div className="strategy-dialog-actions">
                <button
                  type="button"
                  className="strategy-dialog-cancel"
                  onClick={() => setStrategyDialogOpen(false)}
                  disabled={savingStrategy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="strategy-dialog-save"
                  onClick={saveStrategy}
                  disabled={savingStrategy || (strategyMode === 'existing' ? !selectedStrategyCode : !strategyName.trim())}
                >
                  {savingStrategy
                    ? 'Saving…'
                    : (strategyMode === 'existing' ? 'Add to Strategy' : 'Save Strategy')}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
      </div>
    </div>
  );
}

function groupPositionsByExpiryAndExchange(rows) {
  const counts = new Map();
  const pnlSums = new Map();
  for (const row of rows) {
    const group = positionGroupMeta(row);
    counts.set(group.key, (counts.get(group.key) || 0) + 1);
    pnlSums.set(group.key, (pnlSums.get(group.key) || 0) + pnlOf(row));
  }

  const out = [];
  let last = '';
  for (const row of rows) {
    const group = positionGroupMeta(row);
    if (group.key !== last) {
      out.push({
        type: 'group',
        expiry: group.expiry,
        exchange: group.exchange,
        count: counts.get(group.key) || 0,
        pnl: pnlSums.get(group.key) || 0,
      });
      last = group.key;
    }
    out.push({ type: 'row', row });
  }
  return out;
}

function positionGroupMeta(row) {
  const expiry = positionExpiryMeta(row).label;
  const exchange = String(row.exchange || 'No Exchange');
  return { expiry, exchange, key: `${expiry}::${exchange}` };
}

function positionExpiryMeta(row) {
  const symbol = String(row.tradingsymbol || row.symbolname || row.symbol || '-');
  const parsed = parseTradingSymbol(symbol);
  const label = parsed.expiry || 'No Expiry';
  return { label, sort: expirySortValue(label) };
}

function positionStrike(row) {
  const symbol = String(row.tradingsymbol || row.symbolname || row.symbol || '-');
  return Number(parseTradingSymbol(symbol).strike || 0);
}

function positionRowKey(row, fallback = '') {
  return [
    row.symboltoken,
    row.tradingsymbol,
    row.exchange,
    row.producttype || row.product_type,
    row.netqty,
    fallback,
  ].filter((value) => value != null && value !== '').join('|');
}

function positionLabel(key) {
  const labels = {
    stock: 'Stock Name',
    product: 'Product Type',
    netQty: 'Net Qty.',
    buyAvg: 'Buy Avg',
    sellAvg: 'Sell Avg',
    ltp: 'LTP',
    pnl: 'P&L',
  };
  return labels[key] || key;
}

function positionColumnIsNumeric(key) {
  return ['netQty', 'buyAvg', 'sellAvg', 'ltp', 'pnl'].includes(key);
}

function PositionColumnHeader({
  column,
  sort,
  setSort,
  filters,
  setFilters,
  filterOptions,
  openFilter,
  setOpenFilter,
}) {
  const active = columnFilterActive(column, filters);
  const sortActive = sort.key === column;
  const filterButtonRef = useRef(null);

  const toggleSort = () => {
    setSort((current) => {
      if (current.key !== column) return { key: column, dir: 'asc' };
      return { key: column, dir: current.dir === 'asc' ? 'desc' : 'asc' };
    });
  };

  return (
    <div className="position-col-head">
      <button className={`position-sort-btn${sortActive ? ' active' : ''}`} type="button" onClick={toggleSort}>
        <span>{positionLabel(column)}</span>
        <ArrowUpDown size={13} />
      </button>
      <button
        ref={filterButtonRef}
        className={`position-filter-btn${active ? ' active' : ''}`}
        type="button"
        title={`Filter ${positionLabel(column)}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpenFilter(openFilter === column ? '' : column);
        }}
      >
        <Filter size={13} />
      </button>
      {openFilter === column && (
        <PositionFilterMenu
          column={column}
          filters={filters}
          setFilters={setFilters}
          filterOptions={filterOptions}
          anchorRef={filterButtonRef}
          align={column === 'stock' ? 'left' : 'right'}
          onClose={() => setOpenFilter('')}
        />
      )}
    </div>
  );
}

function PositionFilterMenu({ column, filters, setFilters, filterOptions, anchorRef, align, onClose }) {
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

      const menuWidth = 230;
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
  }, [align, anchorRef]);

  useEffect(() => {
    const closeOnOutsideClick = (event) => {
      if (menuRef.current?.contains(event.target)) return;
      if (anchorRef.current?.contains(event.target)) return;
      // A nested dropdown renders in a portal (outside this menu's DOM), so
      // ignore clicks landing inside one — otherwise picking an option here
      // would close the whole filter popover.
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

  if (column === 'stock') {
    reset = ['symbol', 'exchange', 'expiry', 'optionType'];
    body = (
      <>
        <label className="position-filter-field">
          <span>Search</span>
          <input value={filters.symbol} onChange={(event) => patch('symbol', event.target.value)} placeholder="NIFTY, 23750..." />
        </label>
        {select('Exchange', 'exchange', filterOptions.exchanges)}
        {select('Expiry', 'expiry', filterOptions.expiries)}
        {select('Option', 'optionType', ['CE', 'PE'])}
      </>
    );
  } else if (column === 'product') {
    reset = ['product', 'side'];
    body = (
      <>
        {select('Product', 'product', filterOptions.products)}
        {select('Side', 'side', [{ value: 'long', label: 'Long' }, { value: 'short', label: 'Short' }])}
      </>
    );
  } else if (column === 'netQty') {
    reset = ['netQty'];
    body = select('Quantity', 'netQty', [
      { value: 'long', label: 'Long only' },
      { value: 'short', label: 'Short only' },
      { value: 'flat', label: 'Flat only' },
    ]);
  } else if (['buyAvg', 'sellAvg', 'ltp'].includes(column)) {
    reset = [column];
    body = select('Value', column, [
      { value: 'has', label: 'Has value' },
      { value: 'missing', label: 'Missing' },
    ]);
  } else if (column === 'pnl') {
    reset = ['pnl'];
    body = select('P&L', 'pnl', [
      { value: 'profit', label: 'Profit' },
      { value: 'loss', label: 'Loss' },
    ]);
  }

  const menu = (
    <div
      ref={menuRef}
      className="position-filter-menu position-filter-menu-portal"
      style={menuStyle}
      onClick={(event) => event.stopPropagation()}
    >
      {body}
      <div className="position-filter-actions">
        <button type="button" onClick={() => resetKeys(reset)}>Reset</button>
        <button type="button" onClick={onClose}><Check size={13} /> Done</button>
      </div>
    </div>
  );

  return createPortal(menu, document.body);
}

function columnFilterActive(column, filters) {
  if (column === 'stock') return Boolean(filters.symbol || filters.exchange || filters.expiry || filters.optionType);
  if (column === 'product') return Boolean(filters.product || filters.side);
  return Boolean(filters[column]);
}

function buildFilterOptions(rows) {
  const exchanges = new Set();
  const expiries = new Map();
  const products = new Set();

  for (const row of rows) {
    if (row.exchange) exchanges.add(String(row.exchange));
    const meta = positionExpiryMeta(row);
    if (meta.label && meta.label !== 'No Expiry') expiries.set(meta.label, meta.sort);
    products.add(compactProductTag(row.producttype || row.product_type || '-'));
  }

  return {
    exchanges: [...exchanges].sort(),
    expiries: [...expiries.entries()].sort((a, b) => a[1] - b[1]).map(([label]) => label),
    products: [...products].filter(Boolean).sort(),
  };
}

function filterPositionRows(rows, filters) {
  return rows.filter((row) => {
    const parsed = parseTradingSymbol(String(row.tradingsymbol || row.symbolname || row.symbol || '-'));
    const symbolText = [
      row.tradingsymbol,
      row.symbolname,
      row.symbol,
      parsed.root,
      parsed.expiry,
      parsed.strike,
      parsed.optionType,
      row.exchange,
    ].filter(Boolean).join(' ').toLowerCase();
    const qty = Number(row.netqty || 0);
    const product = compactProductTag(row.producttype || row.product_type || '-');
    const buyAvg = positionBuyAvg(row);
    const sellAvg = positionSellAvg(row);
    const ltp = positionValue(row, ['ltp', 'LTP', 'lasttradedprice']);
    const pnl = pnlOf(row);

    if (filters.symbol && !symbolText.includes(filters.symbol.toLowerCase())) return false;
    if (filters.exchange && String(row.exchange || '') !== filters.exchange) return false;
    if (filters.expiry && parsed.expiry !== filters.expiry) return false;
    if (filters.optionType && parsed.optionType !== filters.optionType) return false;
    if (filters.product && product !== filters.product) return false;
    if (filters.side === 'long' && qty <= 0) return false;
    if (filters.side === 'short' && qty >= 0) return false;
    if (filters.netQty === 'long' && qty <= 0) return false;
    if (filters.netQty === 'short' && qty >= 0) return false;
    if (filters.netQty === 'flat' && qty !== 0) return false;
    if (filters.buyAvg === 'has' && !buyAvg) return false;
    if (filters.buyAvg === 'missing' && buyAvg) return false;
    if (filters.sellAvg === 'has' && !sellAvg) return false;
    if (filters.sellAvg === 'missing' && sellAvg) return false;
    if (filters.ltp === 'has' && !ltp) return false;
    if (filters.ltp === 'missing' && ltp) return false;
    if (filters.pnl === 'profit' && pnl < 0) return false;
    if (filters.pnl === 'loss' && pnl >= 0) return false;
    return true;
  });
}

function sortPositionRows(rows, sort) {
  const dir = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => comparePositionRows(a, b, sort.key) * dir);
}

function comparePositionRows(a, b, key) {
  if (key === 'stock') {
    const ax = positionExpiryMeta(a);
    const bx = positionExpiryMeta(b);
    if (ax.sort !== bx.sort) return ax.sort - bx.sort;
    const exchangeDiff = String(a.exchange || '').localeCompare(String(b.exchange || ''));
    if (exchangeDiff) return exchangeDiff;
    const strikeDiff = positionStrike(a) - positionStrike(b);
    if (strikeDiff) return strikeDiff;
    return String(a.tradingsymbol || '').localeCompare(String(b.tradingsymbol || ''));
  }
  if (key === 'product') {
    return compactProductTag(a.producttype || a.product_type || '-').localeCompare(compactProductTag(b.producttype || b.product_type || '-'));
  }
  if (key === 'netQty') return Number(a.netqty || 0) - Number(b.netqty || 0);
  if (key === 'buyAvg') return positionBuyAvg(a) - positionBuyAvg(b);
  if (key === 'sellAvg') return positionSellAvg(a) - positionSellAvg(b);
  if (key === 'ltp') return positionValue(a, ['ltp', 'LTP', 'lasttradedprice']) - positionValue(b, ['ltp', 'LTP', 'lasttradedprice']);
  if (key === 'pnl') return pnlOf(a) - pnlOf(b);
  return 0;
}

function renderPositionCell(row, column, selection = {}) {
  if (column === 'stock') return <PositionStockCell row={row} selection={selection} />;
  if (column === 'product') return <PositionProductCell row={row} />;
  if (column === 'netQty') return <PositionQtyCell row={row} />;
  if (column === 'buyAvg') return <PositionPriceCell value={positionBuyAvg(row)} />;
  if (column === 'sellAvg') return <PositionPriceCell value={positionSellAvg(row)} />;
  if (column === 'ltp') return <PositionPriceCell value={positionValue(row, ['ltp', 'LTP', 'lasttradedprice'])} strong />;
  if (column === 'pnl') return <PositionPnlCell row={row} />;
  return '-';
}

function PositionStockCell({ row, selection }) {
  const symbol = String(row.tradingsymbol || row.symbolname || row.symbol || '-');
  const parsed = parseTradingSymbol(symbol);
  return (
    <div className="position-symbol-line" title={symbol}>
      <button
        className={`position-row-check${selection.selected ? ' checked' : ''}`}
        type="button"
        aria-pressed={selection.selected}
        aria-label={`${selection.selected ? 'Unselect' : 'Select'} ${symbol}`}
        onClick={(event) => {
          event.stopPropagation();
          selection.onToggle?.(selection.rowKey);
        }}
      >
        {selection.selected && <Check size={12} strokeWidth={3} />}
      </button>
      <strong>{parsed.root}</strong>
      {parsed.expiry && <span className="position-expiry">{parsed.expiry}</span>}
      {parsed.strike && <span className="position-strike">{parsed.strike}</span>}
      {parsed.optionType && <span className={`book-tag option ${parsed.optionType.toLowerCase()}`}>{parsed.optionType}</span>}
      {row.exchange && <span className="book-tag exchange">{row.exchange}</span>}
    </div>
  );
}

function PositionProductCell({ row }) {
  const product = compactProductTag(row.producttype || row.product_type || '-');
  const qty = Number(row.netqty || 0);
  return (
    <div className="book-product-cell">
      {qty !== 0 && <span className={`book-tag side ${qty > 0 ? 'buy' : 'sell'}`}>{qty > 0 ? 'LONG' : 'SHORT'}</span>}
      <span className="book-tag product">{product}</span>
    </div>
  );
}

function PositionQtyCell({ row }) {
  const qty = Number(row.netqty || 0);
  const lotSize = Number(row.lotsize || row.lotSize || row.lot_size || 0) || 0;
  const absQty = Math.abs(qty);
  const lots = lotSize > 1 && absQty ? absQty / lotSize : null;
  return (
    <div className="book-qty-cell">
      <span className={qty >= 0 ? 'up' : 'down'}>{qty.toLocaleString('en-IN')}</span>
      {lots != null && (
        <small className="position-lots-badge">
          {Number.isInteger(lots) ? lots : lots.toFixed(2)} Lots
        </small>
      )}
    </div>
  );
}

function PositionPnlCell({ row }) {
  const pnl = pnlOf(row);
  return (
    <span className={`position-pnl-value ${pnl >= 0 ? 'up' : 'down'}`}>
      {money(pnl)}
    </span>
  );
}

function PositionPriceCell({ value, strong = false }) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n === 0) return <span className="position-price-muted">-</span>;
  return <span className={strong ? 'position-price ltp' : 'position-price'}>{money(n)}</span>;
}

function positionValue(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value != null && value !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

function positionBuyAvg(row) {
  const direct = positionValue(row, [
    'totalbuyavgprice',
    'totalBuyAvgPrice',
    'total_buy_avg_price',
    'buyavgprice',
    'buyAvgPrice',
    'buyaverageprice',
    'buyAveragePrice',
    'buy_avg_price',
    'buyAvg',
    'cfbuyavgprice',
    'cfBuyAvgPrice',
    'cf_buy_avg_price',
  ]);
  if (direct) return direct;

  const amount = positionValue(row, [
    'totalbuyvalue',
    'totalBuyValue',
    'buyamount',
    'buyAmount',
    'cfbuyamount',
    'cfBuyAmount',
    'buy_value',
    'buyValue',
  ]);
  const qty = Math.abs(positionValue(row, [
    'totalbuyqty',
    'totalBuyQty',
    'buyqty',
    'buyQty',
    'buyquantity',
    'buyQuantity',
    'cfbuyqty',
    'cfBuyQty',
  ]));
  return amount && qty ? amount / qty : 0;
}

function positionSellAvg(row) {
  const direct = positionValue(row, [
    'totalsellavgprice',
    'totalSellAvgPrice',
    'total_sell_avg_price',
    'sellavgprice',
    'sellAvgPrice',
    'sellaverageprice',
    'sellAveragePrice',
    'sell_avg_price',
    'sellAvg',
    'cfsellavgprice',
    'cfSellAvgPrice',
    'cf_sell_avg_price',
  ]);
  if (direct) return direct;

  const amount = positionValue(row, [
    'totalsellvalue',
    'totalSellValue',
    'sellamount',
    'sellAmount',
    'cfsellamount',
    'cfSellAmount',
    'sell_value',
    'sellValue',
  ]);
  const qty = Math.abs(positionValue(row, [
    'totalsellqty',
    'totalSellQty',
    'sellqty',
    'sellQty',
    'sellquantity',
    'sellQuantity',
    'cfsellqty',
    'cfSellQty',
  ]));
  return amount && qty ? amount / qty : 0;
}

function expirySortValue(label) {
  const match = String(label || '').match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})$/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const [, day, mon, year] = match;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(mon.toLowerCase());
  if (month < 0) return Number.MAX_SAFE_INTEGER;
  const fullYear = Number(year.length === 2 ? `20${year}` : year);
  return new Date(fullYear, month, Number(day)).getTime();
}

function toPositionError(error) {
  const message = String(error?.message || '');
  if (/session|login|auth|token|jwt|unauthor/i.test(message)) {
    return 'This account is not logged in. Login from Broker Configuration first.';
  }
  return message || 'Failed to load positions';
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
