// Get Position: pill selectors for user/account + the selected account's positions.
// Angel One and Kotak Neo positions share one normalized table shape.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpDown, Check, Filter, Info, Layers, Radio, RefreshCw, Search, X } from 'lucide-react';
import { apiGet, apiPost } from '../config/api';
import { useFeedMasterAccount } from '../feedmaster/feedMasterStore';
import {
  classifyLoginError, isAngelBroker, isAuthError, isRateLimited,
} from '../feedmaster/angelSessionStore';
import {
  ensureBookSession, fetchBrokerPositions, hasBookSession, isBookBroker, isKotakBroker,
  saveBookSession, useBrokerBookClient,
} from './brokerBookClient';
import { orderIsFill, useFillRefresh, useOrderUpdates } from './orderUpdates';
import { useSharedTradeAccount, useSignedInAccounts } from './accountScope';
import { getSavedTradeAccount, saveTradeAccount } from './tradeAccountStore';
import { compactProductTag, contractMeta } from './symbolParse';
import { CompactSelect, PositionSelect } from './PositionSelect';
import { useKotakMarketFeed } from './useKotakMarketFeed';
import { useLiveLegFeed } from './useLiveLegFeed';
import './tradepanel.css';

const POSITION_COLUMNS = ['stock', 'product', 'netQty', 'buyAvg', 'sellAvg', 'ltp', 'pnl'];

// Last resort behind the order stream: a broker can simply fail to push an
// update, and no amount of reconnecting will surface a fill that was never
// announced.
const BACKGROUND_REFRESH_MS = 45000;

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

// Marks an open position to market from a live feed tick: recomputes ltp/pnl
// from the tick instead of the last REST snapshot. A flat (netqty 0) position
// has nothing to mark - its pnl is already fully realised.
// The token this row is marked to market with on the Angel Feedmaster feed. A
// Kotak row carries the Angel token the backend's position router resolved for
// it (masterFeedToken); an Angel row simply IS its own token.
//
// The router writes an empty STRING - not null - when it could not map a Kotak
// contract to an Angel one. `??` only falls through on null/undefined, so it
// handed that empty string straight back as the token and the row was dropped
// from the feed entirely. `||` is what was meant.
function angelMasterReference(row, selectedIsAngel) {
  const explicitBroker = String(row.masterFeedBroker || '').toLowerCase();
  if (explicitBroker && explicitBroker !== 'angel' && explicitBroker !== 'angelone') return null;

  const token = row.masterFeedToken
    || row.feedMasterToken
    || (selectedIsAngel && !row.brokerToken ? row.symboltoken : '');
  if (token == null || token === '') return null;
  return {
    token: String(token),
    exchange: String(
      row.masterFeedExchange
      || row.feedMasterExchange
      || (selectedIsAngel ? row.exchange : ''),
    ).toUpperCase(),
  };
}

function withLivePositionTick(row, liveTicks, selectedIsAngel) {
  const master = angelMasterReference(row, selectedIsAngel);
  const brokerToken = row.brokerToken ?? row.symboltoken;
  const token = brokerToken != null ? String(brokerToken) : '';
  const segment = String(row.brokerExchange || row.feedExchange || row.exchange || '').toLowerCase();
  const tick = (master && (
    liveTicks[`${master.exchange.toLowerCase()}|${master.token}`]
    || liveTicks[master.token]
  )) || (token ? liveTicks[`${segment}|${token}`] : null)
    || (!row.brokerToken && token ? liveTicks[token] : null);
  if (!tick || !(tick.ltp > 0)) return row;

  // A flat position (net qty 0) is squared off, so its P&L is already realised
  // and no longer moves with the price - but its LTP does, and that is what the
  // table shows. Bailing out on qty === 0 was what froze the price column for an
  // account whose positions are all closed.
  const qty = Number(row.netqty || 0);
  if (qty === 0) return { ...row, ltp: tick.ltp, liveDir: tick.dir };

  const buy = positionBuyAvg(row);
  const sell = positionSellAvg(row);
  const unrealised = qty > 0 ? (tick.ltp - buy) * qty : (sell - tick.ltp) * Math.abs(qty);
  const pnl = Number(row.realised || 0) + unrealised;

  return { ...row, ltp: tick.ltp, pnl, liveDir: tick.dir };
}

export default function GetPositions() {
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState('');
  const [configs, setConfigs] = useState([]);
  const [configId, setConfigId] = useState('');
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('Select a user and account');
  // Starts true: until the user/config/credential setup below settles one way
  // or another, we're still "preparing" - staying in the loading state avoids
  // a "No positions" flash before the real auto-load kicks in.
  const [loading, setLoading] = useState(true);
  const [configLoading, setConfigLoading] = useState(false);
  const [sort, setSort] = useState({ key: 'stock', dir: 'asc' });
  const [query, setQuery] = useState('');
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
  // The stream and the background timer both fire outside React's render cycle,
  // so they reach the current load() through a ref rather than closing over
  // whichever one existed when they started.
  const loadRef = useRef(null);
  const loadSeqRef = useRef(0);

  const signedIn = useSignedInAccounts();
  const selectedConfig = configs.find((config) => String(config.id) === String(configId));
  const selectedUser = users.find((user) => String(user.id) === String(userId));
  const selectedUserLabel = selectedUser
    ? (selectedUser.username || `${selectedUser.first_name || ''} ${selectedUser.last_name || ''}`.trim() || `User ${selectedUser.id}`)
    : '';
  const selectedBrokerName = selectedConfig?.broker_name || '';
  const selectedIsAngel = isAngelBroker(selectedBrokerName);
  const selectedIsKotak = isKotakBroker(selectedBrokerName);
  const selectedIsSupported = isBookBroker(selectedBrokerName);
  const { client, clientError } = useBrokerBookClient(configId, selectedBrokerName);

  const {
    setting: feedMasterSetting,
    client: feedMasterClient,
  } = useFeedMasterAccount();
  // Is the Feedmaster an Angel account? This used to demand the saved setting's
  // broker be the exact string 'angelone', so a Feedmaster saved as 'angel' (or
  // by any older build) read as "not Angel", the feed key below collapsed to ''
  // and Get Position subscribed NOTHING - frozen LTPs and an Offline pill, while
  // Client Dashboard, which never made that check, fed the same account fine.
  const angelMasterSelected = isAngelBroker(
    feedMasterSetting?.broker || feedMasterClient?.broker || '',
  ) && Boolean(feedMasterSetting?.configId || feedMasterClient?.configId);

  const strategyLegKeys = useMemo(
    () => buildStrategyLegKeySet(existingStrategies),
    [existingStrategies],
  );
  const positionRows = useMemo(
    () => rows.filter((row) => !strategyLegKeys.has(positionIdentityKey(row))),
    [rows, strategyLegKeys],
  );

  // Every position on the table, flat or not - the same rows Client Dashboard
  // feeds. This used to skip flat (net qty 0) rows on the grounds that a squared
  // off position has no P&L left to mark to market. True - but its PRICE still
  // moves, and the table still shows it. On an account whose positions are all
  // closed for the day that filter emptied the token list, so Get Position
  // subscribed nothing at all and every LTP on screen sat frozen.
  const legFeedKey = useMemo(() => {
    if (!angelMasterSelected) return '';
    const seen = new Set();
    positionRows.forEach((row) => {
      const master = angelMasterReference(row, selectedIsAngel);
      if (!master) return;
      seen.add(`${master.exchange || 'NFO'}|${master.token}`);
    });
    return [...seen].sort().join(',');
  }, [angelMasterSelected, positionRows, selectedIsAngel]);

  // The same shared Feedmaster feed Client Dashboard runs on. Get Position used
  // to carry its own copy of this plumbing - subscribe, SSE, tick batching - and
  // that copy is what quietly stopped feeding. One hook, one code path, so the
  // two pages can no longer disagree about whether the feed is up.
  const { liveTicks, feedStatus } = useLiveLegFeed(legFeedKey, {
    enabled: angelMasterSelected,
    subscriber: 'get-positions',
  });

  const kotakFeedItems = useMemo(() => {
    // The selected Feedmaster owns LTP routing. Never mix Kotak HSM ticks into
    // an Angel-master position set: numeric tokens are broker-specific and can
    // collide while referring to completely different contracts.
    if (!selectedIsKotak || angelMasterSelected) return [];
    return positionRows
      .filter((row) => row.symboltoken)
      .map((row) => ({
        segment: row.feedExchange || row.brokerExchange,
        token: String(row.symboltoken),
      }));
  }, [angelMasterSelected, positionRows, selectedIsKotak]);
  const { status: kotakFeedStatus, ticks: kotakTicks } = useKotakMarketFeed({
    configId,
    client,
    enabled: selectedIsKotak && !angelMasterSelected,
    items: kotakFeedItems,
    subscriber: 'get-positions',
  });

  const activeTicks = useMemo(
    () => (angelMasterSelected ? liveTicks : { ...kotakTicks, ...liveTicks }),
    [angelMasterSelected, kotakTicks, liveTicks],
  );
  const liveRows = useMemo(
    () => positionRows.map((row) => withLivePositionTick(row, activeTicks, selectedIsAngel)),
    [activeTicks, positionRows, selectedIsAngel],
  );

  // What the pill's tooltip reports: how many of the rows on screen actually
  // resolved to a feed token - which is exactly what got subscribed.
  const angelMappedPositionCount = useMemo(
    () => positionRows.filter((row) => angelMasterReference(row, selectedIsAngel)).length,
    [positionRows, selectedIsAngel],
  );
  const positionFeedStatus = angelMasterSelected
    ? feedStatus
    : selectedIsKotak ? kotakFeedStatus : feedStatus;
  const positionFeedTitle = angelMasterSelected
    ? `Angel Feedmaster: ${angelMappedPositionCount} of ${positionRows.length} contracts mapped`
    : selectedIsKotak ? 'Live Kotak HSM market feed' : 'Live LTP feed (Feedmaster)';

  // Manual picks here should also become the shared Trade Panel selection.
  // setLoading(true) here (not just inside the effects below) closes the gap
  // between clicking and the account-hydration effects actually running, so
  // the table never flashes "No positions" for a frame while switching account.
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

  // Switching tabs keeps the same client: whatever account another Trade Panel
  // page selected is adopted here too.
  useSharedTradeAccount({
    userId,
    setUserId,
    configId,
    setConfigId,
    configs,
    onAdopt: () => setLoading(true),
  });

  // Only signed-in accounts are offered. One that never logged in has no book to
  // read, and a user with no signed-in account has nothing to show at all.
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

  // A selection that is not on screen cannot stay selected - move to one that is.
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
        setExistingStrategies([]);
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
        setStatus(list.length ? 'Select account, then Get Positions' : 'No broker accounts configured for this user');
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
      setStatus(`${selectedBrokerName || 'Selected broker'} positions are not wired yet`);
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
      setStatus(`${selectedBrokerName || 'Selected broker'} positions are not wired yet`);
      return;
    }
    if (!client) {
      setStatus(`${selectedBrokerName || 'Selected broker'} account credentials are not ready`);
      return;
    }

    // Fills come in bursts, so several refreshes can be in flight at once and
    // they do not necessarily come back in the order they were sent. Only the
    // newest one may write to the table: an older snapshot landing last would
    // put the pre-fill positions back on screen and leave them there.
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    const isLatest = () => seq === loadSeqRef.current;

    if (!silent) {
      setLoading(true);
      setStatus('Loading positions...');
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
        body = await fetchBrokerPositions(selectedBrokerName, active);
      } catch (error) {
        if (!isAuthError(error)) throw error;
        if (!silent) setStatus(`${selectedBrokerName || 'Selected broker'} token expired - signing in again...`);
        active = await ensureBookSession(configId, selectedBrokerName, active, { force: true });
        body = await fetchBrokerPositions(selectedBrokerName, active);
      }

      // Save the refreshed session even for a superseded refresh - the token is
      // good regardless of whether this response is still the one on screen.
      if (body.session) saveBookSession(configId, selectedBrokerName, body.session);
      if (!isLatest()) return;

      const positions = body.positions || [];
      setRows(positions);
      setStatus(positions.length ? `${positions.length} positions` : 'No open positions');
    } catch (e) {
      if (isLatest()) setStatus(toPositionError(e));
    } finally {
      // Whoever turned the spinner on turns it off, superseded or not.
      if (!silent) setLoading(false);
    }
  }, [client, configId, selectedBrokerName, selectedConfig, selectedIsKotak, selectedIsSupported]);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    const accountKey = String(configId || '');
    if (!accountKey || !selectedConfig || !selectedIsSupported || !client) return;
    // `loading` is deliberately NOT part of this guard: it's now also true
    // while the account is still being prepared (see above), and
    // gating on it here would mean this effect never fires. autoLoadedAccountRef
    // alone is what prevents re-triggering load() for the same account.
    if (autoLoadedAccountRef.current === accountKey) return;

    autoLoadedAccountRef.current = accountKey;
    load();
  }, [client, configId, load, selectedConfig, selectedIsSupported]);

  const refreshPositions = useCallback(() => loadRef.current?.({ silent: true }), []);
  const scheduleFillRefresh = useFillRefresh(refreshPositions);

  // Brokers never push "your position changed" - only order status changes. So
  // the position LIST (not just its LTP) is kept in step with reality by
  // listening to the order-status stream and re-fetching whenever an order
  // moves the book. onResync covers the gap after a dropped stream: those
  // updates were pushed while nobody was listening and will not come again.
  const fillSyncStatus = useOrderUpdates({
    configId,
    client,
    brokerName: selectedBrokerName,
    enabled: selectedIsSupported,
    onResync: refreshPositions,
    onOrder: useCallback((order) => {
      if (!orderIsFill(order)) return;
      setStatus(`Order filled${order.tradingsymbol ? ` (${order.tradingsymbol})` : ''} - refreshing positions...`);
      scheduleFillRefresh();
    }, [scheduleFillRefresh]),
    onPosition: useCallback(() => {
      setStatus('Kotak live position update - refreshing positions...');
      scheduleFillRefresh();
    }, [scheduleFillRefresh]),
  });

  // Behind the stream, a slow re-check: a broker can simply fail to push an
  // update, and no amount of reconnecting will surface a fill that was never
  // announced. Skipped while the tab is in the background - nobody is looking,
  // and switching back re-checks anyway.
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

  const totalPnl = liveRows.reduce((sum, r) => sum + pnlOf(r), 0);
  const longCount = liveRows.filter((row) => Number(row.netqty || 0) > 0).length;
  const shortCount = liveRows.filter((row) => Number(row.netqty || 0) < 0).length;
  const filterOptions = useMemo(() => buildFilterOptions(liveRows), [liveRows]);
  const searchedRows = useMemo(() => filterPositionSearchRows(liveRows, query), [liveRows, query]);
  const visibleRows = useMemo(() => sortPositionRows(filterPositionRows(searchedRows, filters), sort), [searchedRows, filters, sort]);
  const tableRows = useMemo(
    () => (sort.key === 'stock'
      ? groupPositionsByExpiryAndExchange(visibleRows)
      : visibleRows.map((row) => ({ type: 'row', row }))),
    [visibleRows, sort.key],
  );
  const visiblePositionSelections = useMemo(() => (
    tableRows
      .map((item, index) => (item.type === 'row' ? positionRowKey(item.row, index) : null))
      .filter(Boolean)
  ), [tableRows]);
  const allVisibleSelected = visiblePositionSelections.length > 0
    && visiblePositionSelections.every((key) => selectedPositionKeys.has(key));
  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const togglePositionSelection = useCallback((key) => {
    setSelectedPositionKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const toggleVisibleSelection = useCallback(() => {
    if (!visiblePositionSelections.length) return;

    setSelectedPositionKeys((current) => {
      const next = new Set(current);
      const allSelected = visiblePositionSelections.every((key) => next.has(key));
      visiblePositionSelections.forEach((key) => {
        if (allSelected) next.delete(key);
        else next.add(key);
      });
      return next;
    });
  }, [visiblePositionSelections]);

  // Which positions are actually on the books, ignoring the identity of the
  // array they arrived in. Positions are now re-fetched on every fill and on a
  // background timer, and each of those hands back a brand new `rows` array -
  // keying the reset below on `rows` itself would throw away the user's ticked
  // rows (and close the Add-to-Group dialog) on a refresh that changed nothing.
  const rowsSignature = useMemo(
    () => rows.map((row) => positionIdentityKey(row)).sort().join(','),
    [rows],
  );

  useEffect(() => {
    setSelectedPositionKeys(new Set());
    setStrategyDialogOpen(false);
    setStrategyName('');
    setStrategyError('');
  }, [configId, rowsSignature]);

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

  const loadExistingStrategies = useCallback(async (nextUserId = userId) => {
    if (!nextUserId) {
      setExistingStrategies([]);
      return [];
    }

    try {
      const res = await apiGet(`/strategy-master/list.php?user_id=${nextUserId}`);
      const list = res.data || [];
      setExistingStrategies(list);
      return list;
    } catch {
      setExistingStrategies([]);
      return [];
    }
  }, [userId]);

  useEffect(() => {
    loadExistingStrategies(userId);
  }, [loadExistingStrategies, userId]);

  const openStrategyDialog = useCallback(async () => {
    if (!userId) {
      setStatus('Select a user first');
      return;
    }
    setStrategyError('');
    setStrategyName('');
    setStrategyMode('new');
    setSelectedStrategyCode('');
    setStrategyDialogOpen(true);

    // Load this user's existing strategies so they can add legs to one.
    loadExistingStrategies(userId);
  }, [loadExistingStrategies, userId]);

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
    const brokerTag = {
      broker_config_id: Number(configId || 0) || null,
      broker_name: selectedBrokerName || selectedConfig?.broker_name || '',
      broker_account_id: selectedConfig?.account_id || '',
    };

    let body;
    if (strategyMode === 'existing') {
      // Add to an existing strategy — reuse its strategy_code, no new strategy.
      if (!selectedStrategyCode) {
        setStrategyError('Pick a strategy to add to');
        return;
      }
      body = { user_id: Number(userId), strategy_code: selectedStrategyCode, ...brokerTag, legs };
    } else {
      const name = strategyName.trim();
      if (!name) {
        setStrategyError('Enter a strategy name');
        return;
      }
      body = { user_id: Number(userId), strategy_name: name, ...brokerTag, legs };
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
      await loadExistingStrategies(userId);
    } catch (error) {
      setStrategyError(error.message || 'Failed to save strategy');
    } finally {
      setSavingStrategy(false);
    }
  }, [configId, loadExistingStrategies, selectedBrokerName, selectedConfig, strategyMode, selectedStrategyCode, strategyName, userId, selectedLegs]);

  return (
    <div className="trade-panel">
      <div className="positions-view">
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
            {loading ? 'Loading' : 'Get Positions'}
          </button>
          {positionRows.length > 0 && (
            <span className={`positions-total ${totalPnl >= 0 ? 'up' : 'down'}`}>
              Total P&amp;L: {money(totalPnl)}
            </span>
          )}

          <span className={`orderbook-live-pill ${positionFeedStatus}`} title={positionFeedTitle}>
            <Radio size={13} />
            {positionFeedStatus === 'live' ? 'Live' : positionFeedStatus === 'connecting' ? 'Connecting' : 'Offline'}
          </span>

          <span className={`orderbook-live-pill ${fillSyncStatus}`} title="Auto re-syncs positions when an order fills">
            <RefreshCw size={13} />
            Auto-sync: {fillSyncStatus === 'live' ? 'On' : fillSyncStatus === 'connecting' ? 'Connecting' : 'Off'}
          </span>

          <label className="orderbook-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search symbol, qty, P&L..."
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Clear search">
                <X size={13} />
              </button>
            )}
          </label>

          {visiblePositionSelections.length > 0 && (
            <button
              className={`positions-select-all${allVisibleSelected ? ' active' : ''}`}
              type="button"
              onClick={toggleVisibleSelection}
            >
              <Check size={14} /> {allVisibleSelected ? 'Clear all' : 'Select all'}
            </button>
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

        {positionRows.length > 0 && (
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
              <em>{positionRows.length} Positions</em>
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
              {positionRows.length === 0 && (
                <tr>
                  <td className="positions-empty" colSpan={POSITION_COLUMNS.length}>
                    <div className="positions-empty-state">
                      <button
                        className="positions-empty-action"
                        type="button"
                        onClick={load}
                        disabled={loading || !selectedConfig || (selectedIsSupported && !client)}
                      >
                        <Info size={18} />
                      </button>
                      <strong>{loading ? 'Loading positions' : rows.length > 0 ? 'No positions outside strategies' : 'No positions'}</strong>
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
                        meta: strategyBrokerLabel(strategy) || `${(strategy.legs || []).length} legs`,
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
  const label = contractMeta(row).expiry || 'No Expiry';
  return { label, sort: expirySortValue(label) };
}

function positionStrike(row) {
  return Number(contractMeta(row).strike || 0);
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

function buildStrategyLegKeySet(strategies) {
  const keys = new Set();
  (strategies || []).forEach((strategy) => {
    (strategy.legs || []).forEach((leg) => {
      const key = strategyLegIdentityKey(leg);
      if (key) keys.add(key);
    });
  });
  return keys;
}

function strategyBrokerLabel(strategy) {
  const broker = String(strategy.broker_name || '').trim();
  const account = String(strategy.broker_account_id || '').trim();
  if (broker && account) return `${broker} ${account}`;
  return broker || account;
}

function positionIdentityKey(row) {
  return normalizedPositionIdentity({
    token: row.symboltoken,
    symbol: row.tradingsymbol || row.symbolname || row.symbol,
    exchange: row.exchange,
    product: row.producttype || row.product_type,
    qty: row.netqty,
  });
}

function strategyLegIdentityKey(leg) {
  return normalizedPositionIdentity({
    token: leg.symbol_token,
    symbol: leg.trading_symbol,
    exchange: leg.exchange,
    product: leg.product_type,
    qty: leg.net_qty,
  });
}

function normalizedPositionIdentity({ token, symbol, exchange, product, qty }) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  if (!normalizedSymbol) return '';

  return [
    String(token || '').trim(),
    normalizedSymbol,
    String(exchange || '').trim().toUpperCase(),
    compactProductTag(product || ''),
    String(Number(qty || 0)),
  ].join('|');
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
    const parsed = contractMeta(row);
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

function filterPositionSearchRows(rows, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return rows;

  return rows.filter((row) => positionSearchText(row).includes(needle));
}

function positionSearchText(row) {
  const parsed = contractMeta(row);
  return [
    row.tradingsymbol,
    row.symbolname,
    row.symbol,
    row.symboltoken,
    parsed.root,
    parsed.expiry,
    parsed.strike,
    parsed.optionType,
    row.exchange,
    compactProductTag(row.producttype || row.product_type || '-'),
    Number(row.netqty || 0),
    positionBuyAvg(row),
    positionSellAvg(row),
    positionValue(row, ['ltp', 'LTP', 'lasttradedprice']),
    pnlOf(row),
  ].filter((value) => value != null && value !== '').join(' ').toLowerCase();
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
  if (column === 'ltp') return <PositionPriceCell value={positionValue(row, ['ltp', 'LTP', 'lasttradedprice'])} strong dir={row.liveDir} />;
  if (column === 'pnl') return <PositionPnlCell row={row} />;
  return '-';
}

function PositionStockCell({ row, selection }) {
  const symbol = String(row.tradingsymbol || row.symbolname || row.symbol || '-');
  const parsed = contractMeta(row);
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

function PositionPriceCell({ value, strong = false, dir = '' }) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n === 0) return <span className="position-price-muted">-</span>;
  const cls = strong ? 'position-price ltp' : 'position-price';
  return <span className={`${cls}${dir ? ` flash-${dir}` : ''}`} key={dir ? `${n}-${dir}` : undefined}>{money(n)}</span>;
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
  if (isAuthError(error) || isRateLimited(error)) {
    const issue = classifyLoginError(error);
    return `${issue.title}. ${issue.hint}`;
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
