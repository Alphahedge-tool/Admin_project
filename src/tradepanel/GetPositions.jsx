// Get Position: pill selectors for user/account + the selected account's positions.
// Angel One and Kotak Neo positions share one normalized table shape.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpDown, BookmarkPlus, Check, ChevronDown, Filter, Info, Layers, Minus, Radio, RefreshCw, Search, X } from 'lucide-react';
import { apiGet, apiPost } from '../config/api';
import {
  classifyLoginError, ensureAccountsLoaded, getAngelClient, isAngelBroker, isAuthError,
  isRateLimited, useAngelSessions,
} from '../feedmaster/angelSessionStore';
import {
  ensureBookSession, fetchBrokerPositions, hasBookSession, isBookBroker,
  saveBookSession, useBrokerBookClient,
} from './brokerBookClient';
import { orderIsFill, useFillRefresh, useOrderUpdates } from './orderUpdates';
import { useSharedTradeAccount, useAvailableAccounts } from './accountScope';
import { getSavedTradeAccount, saveTradeAccount } from './tradeAccountStore';
import { compactProductTag, contractMeta } from './symbolParse';
import { CompactSelect, PositionSelect } from './PositionSelect';
import { BrokerMark } from './BrokerMark';
import { SkeletonRows } from './TableSkeleton';
import { useLiveLegFeed } from './useLiveLegFeed';
import './tradepanel.css';

const POSITION_COLUMNS = ['stock', 'product', 'netQty', 'buyAvg', 'sellAvg', 'ltp', 'pnl'];
// Group scope puts several clients' books on one table, where "which account is
// this?" stops being answerable from the page header - so the row says it.
const GROUP_POSITION_COLUMNS = ['stock', 'account', 'product', 'netQty', 'buyAvg', 'sellAvg', 'ltp', 'pnl'];

// Last resort behind the order stream: a broker can simply fail to push an
// update, and no amount of reconnecting will surface a fill that was never
// announced.
const BACKGROUND_REFRESH_MS = 45000;

// Group scope. Picking a group and leaving the Client picker on ALL_USERS reads
// every broker account of every client in that group into one table, instead of
// one client's one account. Both are sentinels, never real ids - ALL_USERS in
// particular must not reach the shared trade-account store, where the other
// Trade Panel pages would read it back as a user id.
const ALL_GROUPS = 'all-groups';
const ALL_USERS = 'all';

// Accounts are read one at a time. Brokers rate-limit per account, and a burst
// of parallel logins is exactly what trips that - the group walk is meant to be
// unattended, so it trades wall-clock time for not getting throttled.
async function fetchAccountPositions(account) {
  let client = getAngelClient(account.configId);
  if (!client) throw new Error('Credentials are not loaded for this account');

  if (!hasBookSession(account.brokerName, client)) {
    client = await ensureBookSession(account.configId, account.brokerName, client);
  }

  let body;
  try {
    body = await fetchBrokerPositions(account.brokerName, client);
  } catch (error) {
    if (!isAuthError(error)) throw error;
    client = await ensureBookSession(account.configId, account.brokerName, client, { force: true });
    body = await fetchBrokerPositions(account.brokerName, client);
  }

  if (body.session) saveBookSession(account.configId, account.brokerName, body.session);
  return body.positions || [];
}

// Which account a row came from, carried on the row itself. In group scope the
// table holds several accounts at once, so "the selected account" is no longer a
// property of the page - a leg has to say who owns it, or saving a mixed
// selection would tag every leg with whichever account happened to be picked.
function tagRowWithAccount(row, account) {
  return {
    ...row,
    _configId: String(account.configId),
    _brokerName: account.brokerName || '',
    _accountId: account.accountId || '',
    _userId: String(account.userId || ''),
    _username: account.username || '',
  };
}

const defaultPositionFilters = {
  symbol: '',
  account: '',
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
// Whether THIS row came off an Angel account. In group scope the table holds
// several accounts at once, so the page no longer has a single broker - a row
// carries its own (_brokerName) and only falls back to the page's selection for
// a single-account read.
function rowIsAngel(row, selectedIsAngel) {
  return row._brokerName ? isAngelBroker(row._brokerName) : selectedIsAngel;
}

function angelMasterReference(row, selectedIsAngel) {
  const explicitBroker = String(row.masterFeedBroker || '').toLowerCase();
  if (explicitBroker && explicitBroker !== 'angel' && explicitBroker !== 'angelone') return null;

  // Resolved per row. Handing a Kotak row the page's "this is an Angel account"
  // answer would let its own symboltoken through as an Angel feed token, which
  // does not fail - it silently returns a DIFFERENT contract's price.
  const isAngel = rowIsAngel(row, selectedIsAngel);
  const token = row.masterFeedToken
    || row.feedMasterToken
    || (isAngel && !row.brokerToken ? row.symboltoken : '');
  if (token == null || token === '') return null;
  return {
    token: String(token),
    exchange: String(
      row.masterFeedExchange
      || row.feedMasterExchange
      || (isAngel ? row.exchange : ''),
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
  const [groups, setGroups] = useState([]);
  const [groupId, setGroupId] = useState(ALL_GROUPS);
  // Which account of the group walk is in flight, so the toolbar can report
  // progress on what is otherwise a long silent loop.
  const [groupProgress, setGroupProgress] = useState(null);
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
  // 'expiry' groups the table under expiry-date headers (only meaningful while
  // sorted by stock, the expiry-ordered sort); 'none' shows one flat list.
  const [grouping, setGrouping] = useState('expiry');
  // Expiry-group keys the user has collapsed (their rows hidden under the header).
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState(defaultPositionFilters);
  const [openFilter, setOpenFilter] = useState('');
  const [selectedPositionKeys, setSelectedPositionKeys] = useState(() => new Set());
  const [strategyDialogOpen, setStrategyDialogOpen] = useState(false);
  const [strategyName, setStrategyName] = useState('');
  const [strategyError, setStrategyError] = useState('');
  const [savingStrategy, setSavingStrategy] = useState(false);
  const [savingOpenPositions, setSavingOpenPositions] = useState(false);
  const [existingStrategies, setExistingStrategies] = useState([]);
  const [strategyMode, setStrategyMode] = useState('new'); // 'new' | 'existing'
  const [selectedStrategyCode, setSelectedStrategyCode] = useState('');
  const autoLoadedAccountRef = useRef('');
  // The stream and the background timer both fire outside React's render cycle,
  // so they reach the current load() through a ref rather than closing over
  // whichever one existed when they started.
  const loadRef = useRef(null);
  const loadSeqRef = useRef(0);

  const available = useAvailableAccounts();
  // Group scope reads its accounts from the session store rather than the
  // per-user config list: the store already holds every account of every user,
  // hydrated with the credentials each broker's login needs, so the walk does not
  // have to re-fetch a config list per client.
  const { accounts: storeAccounts } = useAngelSessions();
  const groupMode = userId === ALL_USERS;
  const columns = groupMode ? GROUP_POSITION_COLUMNS : POSITION_COLUMNS;
  const selectedGroup = groups.find((group) => String(group.id) === String(groupId)) || null;
  const selectedConfig = configs.find((config) => String(config.id) === String(configId));
  const selectedUser = users.find((user) => String(user.id) === String(userId));
  const selectedUserLabel = selectedUser
    ? (selectedUser.username || `${selectedUser.first_name || ''} ${selectedUser.last_name || ''}`.trim() || `User ${selectedUser.id}`)
    : '';
  const selectedBrokerName = selectedConfig?.broker_name || '';
  const selectedIsAngel = isAngelBroker(selectedBrokerName);
  const selectedIsSupported = isBookBroker(selectedBrokerName);
  const { client, clientError } = useBrokerBookClient(configId, selectedBrokerName);

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
    const seen = new Set();
    positionRows.forEach((row) => {
      const master = angelMasterReference(row, selectedIsAngel);
      if (!master) return;
      seen.add(`${master.exchange || 'NFO'}|${master.token}`);
    });
    return [...seen].sort().join(',');
  }, [positionRows, selectedIsAngel]);

  // One shared feed again: Kotak and Zerodha rows map to Angel feed tokens
  // through `masterFeedToken`, and Angel rows use their own token directly.
  const { liveTicks, feedStatus } = useLiveLegFeed(legFeedKey, {
    enabled: Boolean(legFeedKey),
    subscriber: 'get-positions',
  });
  const activeTicks = liveTicks;
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
  const positionFeedStatus = feedStatus;
  const positionFeedTitle = `Live LTP feed: ${angelMappedPositionCount} of ${positionRows.length} contracts mapped`;

  // Manual picks here should also become the shared Trade Panel selection.
  // setLoading(true) here (not just inside the effects below) closes the gap
  // between clicking and the account-hydration effects actually running, so
  // the table never flashes "No positions" for a frame while switching account.
  // ALL_USERS is a scope for this page only. Persisting it would hand the other
  // Trade Panel pages the string 'all' where they expect a user id.
  const handleUserId = useCallback((value) => {
    setUserId(value);
    setLoading(true);
    if (value !== ALL_USERS) saveTradeAccount({ userId: value, configId: '' });
  }, []);

  // Picking a group shows that whole group at once rather than leaving one of its
  // clients selected - the point of the picker is the group-wide read.
  const handleGroupId = useCallback((value) => {
    setGroupId(value);
    setUserId(ALL_USERS);
    setConfigId('');
    setRows([]);
    setLoading(true);
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
    // A group read spans many accounts, so there is no single selection for the
    // shared store to adopt into - staying subscribed would collapse it to one.
    enabled: !groupMode,
  });

  // Load the account list once (all configured accounts, no auto-login), so every
  // account is offered in the pickers and the picked one can sign in on demand -
  // the app no longer logs brokers in at startup.
  useEffect(() => { ensureAccountsLoaded(); }, []);

  // Every configured account is offered - logged in or not. Picking one that is
  // not signed in yet signs it in on demand (see load()), which is how an account
  // that was never logged in still shows up here and becomes usable.
  const visibleUsers = useMemo(
    () => (available.ready ? users.filter((user) => available.userIds.has(String(user.id))) : users),
    [users, available],
  );
  const visibleConfigs = useMemo(
    () => (available.ready
      ? configs.filter((config) => available.configIds.has(String(config.id)))
      : configs),
    [configs, available],
  );

  // The clients a group selection narrows the page down to. 'All groups' means
  // every client, which is what makes ALL_USERS under it read the entire book.
  const groupUsers = useMemo(() => (
    groupId === ALL_GROUPS
      ? visibleUsers
      : visibleUsers.filter((user) => String(user.group_id || '') === String(groupId))
  ), [visibleUsers, groupId]);

  // Every readable broker account inside the current group scope - exactly what
  // a group load walks. Unsupported brokers are dropped here rather than failing
  // one by one inside the loop.
  const scopedAccounts = useMemo(() => {
    const ids = new Set(groupUsers.map((user) => String(user.id)));
    return storeAccounts.filter((account) => (
      ids.has(String(account.userId))
      && isBookBroker(account.brokerName)
      && (!available.ready || available.configIds.has(String(account.configId)))
    ));
  }, [storeAccounts, groupUsers, available]);

  // A selection that is not on screen cannot stay selected - move to one that is.
  // ALL_USERS is exempt: it is a scope, not a client, so it is never "missing".
  useEffect(() => {
    if (!visibleUsers.length || !userId || groupMode) return;
    if (!visibleUsers.some((user) => String(user.id) === String(userId))) {
      handleUserId(String(visibleUsers[0].id));
    }
  }, [visibleUsers, userId, handleUserId, groupMode]);

  useEffect(() => {
    if (!visibleConfigs.length || !configId || groupMode) return;
    if (!visibleConfigs.some((config) => String(config.id) === String(configId))) {
      handleConfigId(String(visibleConfigs[0].id));
    }
  }, [visibleConfigs, configId, handleConfigId, groupMode]);

  // Narrowing the group must not leave a client selected who is no longer in it.
  useEffect(() => {
    if (groupMode || !userId || groupId === ALL_GROUPS) return;
    if (!groupUsers.some((user) => String(user.id) === String(userId))) {
      handleUserId(groupUsers.length ? String(groupUsers[0].id) : ALL_USERS);
    }
  }, [groupUsers, groupId, groupMode, userId, handleUserId]);

  useEffect(() => {
    let cancelled = false;

    async function loadUsers() {
      try {
        const [usersOut, authOut, groupsOut] = await Promise.allSettled([
          apiGet('/users/list.php'),
          apiGet('/auth/me.php'),
          apiGet('/masters/groups/list.php'),
        ]);
        if (cancelled) return;

        // Only groups that actually have members are offered - an empty one
        // would read as a broken selection rather than an empty result.
        if (groupsOut.status === 'fulfilled') {
          const peopled = new Set(
            (usersOut.status === 'fulfilled' ? usersOut.value.data || [] : [])
              .map((user) => String(user.group_id || '')),
          );
          setGroups((groupsOut.value.data || []).filter((group) => peopled.has(String(group.id))));
        }

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

      // ALL_USERS is a scope, not a client - there is no single config list to
      // fetch, and asking for `user_id=all` would just 400. The group walk reads
      // its accounts from the session store instead.
      if (userId === ALL_USERS) {
        setConfigs([]);
        setConfigId('');
        setConfigLoading(false);
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
    // Group scope has no configId, and its rows come from many accounts - this
    // single-account reset would wipe a finished group read on every render that
    // touches configId.
    if (groupMode) return;

    setRows([]);
    if (!configId) return;

    if (!selectedIsSupported) {
      setStatus(`${selectedBrokerName || 'Selected broker'} positions are not wired yet`);
      setLoading(false);
      return;
    }
    setLoading(true);
    setStatus('');
  }, [configId, selectedBrokerName, selectedIsSupported, groupMode]);

  useEffect(() => {
    if (!clientError) return;
    setStatus(clientError);
    setLoading(false);
  }, [clientError]);

  useEffect(() => {
    autoLoadedAccountRef.current = '';
  }, [configId]);

  // Reads every account in the group scope into one table, one account at a
  // time. Each row is tagged with the account it came from, because from here on
  // "the selected account" is no longer a property of the page.
  //
  // One account failing does not fail the read: its accounts are independent
  // books, so the rest are still worth showing. Failures are counted and named
  // in the status line rather than replacing the whole result with an error.
  const loadGroup = useCallback(async (options) => {
    const silent = options?.silent === true;

    if (!scopedAccounts.length) {
      setRows([]);
      setStatus(selectedGroup
        ? `No readable broker accounts in ${selectedGroup.name}`
        : 'No readable broker accounts');
      setLoading(false);
      setGroupProgress(null);
      return;
    }

    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    const isLatest = () => seq === loadSeqRef.current;

    if (!silent) setLoading(true);

    const collected = [];
    const failures = [];

    for (let i = 0; i < scopedAccounts.length; i += 1) {
      const account = scopedAccounts[i];
      if (!isLatest()) return;

      setGroupProgress({ done: i, total: scopedAccounts.length, label: account.alias || account.accountId });
      if (!silent) {
        setStatus(`Reading ${account.username || 'client'} · ${account.accountId || account.brokerName} (${i + 1}/${scopedAccounts.length})...`);
      }

      try {
        const positions = await fetchAccountPositions(account);
        positions.forEach((position) => collected.push(tagRowWithAccount(position, account)));
      } catch (error) {
        failures.push(`${account.accountId || account.brokerName}: ${toPositionError(error)}`);
      }
    }

    if (!isLatest()) return;

    setRows(collected);
    setGroupProgress(null);
    const scopeLabel = selectedGroup ? selectedGroup.name : 'all clients';
    const read = scopedAccounts.length - failures.length;
    const parts = [`${collected.length} positions · ${read}/${scopedAccounts.length} accounts · ${scopeLabel}`];
    if (failures.length) parts.push(`${failures.length} failed (${failures.join('; ')})`);
    setStatus(parts.join(' · '));
    if (!silent) setLoading(false);
  }, [scopedAccounts, selectedGroup]);

  // `options` is only ever passed internally - this is also wired straight to
  // onClick, where the first argument is a DOM event (which has no `.silent`).
  const load = useCallback(async (options) => {
    const silent = options?.silent === true;

    if (groupMode) {
      await loadGroup(options);
      return;
    }

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

      // Single-account rows carry their account too, so a leg saved from here is
      // tagged exactly the same way a group-scope leg is.
      const positions = (body.positions || []).map((position) => tagRowWithAccount(position, {
        configId,
        brokerName: selectedBrokerName,
        accountId: selectedConfig?.account_id || '',
        userId,
        username: selectedUserLabel,
      }));
      setRows(positions);
      setStatus(positions.length ? `${positions.length} positions` : 'No open positions');
    } catch (e) {
      if (isLatest()) setStatus(toPositionError(e));
    } finally {
      // Whoever turned the spinner on turns it off, superseded or not.
      if (!silent) setLoading(false);
    }
  }, [client, configId, selectedBrokerName, selectedConfig, selectedIsSupported,
    groupMode, loadGroup, userId, selectedUserLabel]);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    // In group scope the "account" being auto-loaded is the whole scope, keyed by
    // the accounts it resolved to. Keying on the account list (not just groupId)
    // is what makes the read wait for the session store to finish hydrating:
    // while it is empty the key is empty and nothing fires, and the walk starts
    // on the render where the accounts actually arrive.
    if (groupMode) {
      if (!scopedAccounts.length) return;
      const scopeKey = `group:${groupId}:${scopedAccounts.map((a) => a.configId).join(',')}`;
      if (autoLoadedAccountRef.current === scopeKey) return;

      autoLoadedAccountRef.current = scopeKey;
      load();
      return;
    }

    const accountKey = String(configId || '');
    if (!accountKey || !selectedConfig || !selectedIsSupported || !client) return;
    // `loading` is deliberately NOT part of this guard: it's now also true
    // while the account is still being prepared (see above), and
    // gating on it here would mean this effect never fires. autoLoadedAccountRef
    // alone is what prevents re-triggering load() for the same account.
    if (autoLoadedAccountRef.current === accountKey) return;

    autoLoadedAccountRef.current = accountKey;
    load();
  }, [client, configId, load, selectedConfig, selectedIsSupported,
    groupMode, groupId, scopedAccounts]);

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
  // Single-account only, and deliberately so: configId is empty in group scope,
  // so this never arms there. A group re-walk is N logins and N position calls,
  // and firing that every 45s is exactly the burst brokers rate-limit. Prices
  // still move there - the live feed marks every row - only the position LIST
  // waits for a manual Refresh.
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
  // Group under expiry headers only when the user has left grouping on AND the
  // table is in its expiry-ordered (stock) sort; ungrouped, or sorted by another
  // column, it is a single flat list.
  const tableRows = useMemo(
    () => {
      // Account grouping is independent of the sort: it re-buckets the rows, so
      // unlike expiry grouping it does not need the table to be in stock order.
      if (grouping === 'account') {
        return groupPositionRows(visibleRows, positionAccountGroupMeta, { contiguous: false });
      }
      if (grouping === 'expiry' && sort.key === 'stock') {
        return groupPositionRows(visibleRows, positionGroupMeta);
      }
      return visibleRows.map((row) => ({ type: 'row', row }));
    },
    [visibleRows, sort.key, grouping],
  );
  // Every expiry-group header currently on the table, so "Collapse all" knows
  // what to close and the Groups dropdown can reflect whether all are shut.
  const groupKeys = useMemo(
    () => tableRows.filter((item) => item.type === 'group').map((item) => item.key),
    [tableRows],
  );
  const showGroupControls = groupKeys.length > 0;
  const allGroupsCollapsed = showGroupControls && groupKeys.every((key) => collapsedGroups.has(key));
  const groupView = allGroupsCollapsed ? 'collapsed' : 'expanded';

  // Entering group scope defaults to per-client grouping: several clients'
  // books interleaved under one expiry header is unreadable, and segregating
  // them is the reason to be in group scope at all. Still a plain default - the
  // View picker overrides it. Leaving group scope drops back, since 'account'
  // groups a single-account table into exactly one group.
  useEffect(() => {
    setGrouping((current) => {
      if (groupMode) return current === 'expiry' ? 'account' : current;
      return current === 'account' ? 'expiry' : current;
    });
  }, [groupMode]);

  const toggleGroupCollapsed = useCallback((key) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const setAllGroupsCollapsed = useCallback((collapsed) => {
    setCollapsedGroups(collapsed ? new Set(groupKeys) : new Set());
  }, [groupKeys]);

  // A collapsed group's rows are hidden, so they are not part of the "select all"
  // set either - only what is actually on screen can be selected.
  const visiblePositionSelections = useMemo(() => (
    tableRows
      .map((item, index) => (
        item.type === 'row' && !collapsedGroups.has(item.groupKey)
          ? positionRowKey(item.row, index)
          : null
      ))
      .filter(Boolean)
  ), [tableRows, collapsedGroups]);
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

  // The row keys belonging to each expiry-group header, so a header can tick
  // exactly its own legs. Built off the same tableRows index the rows themselves
  // render with - positionRowKey folds that index in, so keys derived any other
  // way would not match the ones the row checkboxes produce.
  //
  // Unlike the select-all in the Stock header, a COLLAPSED group is still
  // included here: ticking a group's own checkbox is an explicit act about that
  // group, and the header states the count being ticked.
  const groupSelections = useMemo(() => {
    const map = new Map();
    tableRows.forEach((item, index) => {
      if (item.type !== 'row' || !item.groupKey) return;
      const keys = map.get(item.groupKey) || [];
      keys.push(positionRowKey(item.row, index));
      map.set(item.groupKey, keys);
    });
    return map;
  }, [tableRows]);

  const toggleGroupSelection = useCallback((groupKey) => {
    const keys = groupSelections.get(groupKey) || [];
    if (!keys.length) return;

    setSelectedPositionKeys((current) => {
      const next = new Set(current);
      const allSelected = keys.every((key) => next.has(key));
      keys.forEach((key) => {
        if (allSelected) next.delete(key);
        else next.add(key);
      });
      return next;
    });
  }, [groupSelections]);

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

  // Row keys fold in the row's index within tableRows, so re-grouping or
  // re-sorting renumbers every row and the held keys stop matching anything.
  // Left alone that reads as "5 selected" with nothing ticked on screen, and the
  // save would act on rows the user can no longer see. Clearing is the honest
  // outcome - the selection genuinely no longer refers to anything.
  useEffect(() => {
    setSelectedPositionKeys(new Set());
  }, [grouping, sort.key, sort.dir]);

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

  // Which clients the ticked rows belong to. One client is the normal case and
  // the only one "Add Group" can accept - a strategy has a single owner. Save
  // Open Positions has no such limit and takes them all.
  const selectionOwners = useMemo(() => {
    const owners = new Set();
    selectedLegs.forEach((row) => {
      const owner = String(row._userId || '');
      if (owner) owners.add(owner);
    });
    return [...owners];
  }, [selectedLegs]);

  const selectionOwnerNames = useMemo(() => selectionOwners
    .map((owner) => {
      const match = users.find((user) => String(user.id) === owner);
      return match?.username || `User ${owner}`;
    })
    .join(', '), [selectionOwners, users]);

  // What the dialog names as the destination. In group scope the page has no
  // selected client or account, so both come off the ticked legs instead - the
  // header used to fall back to its "Selected client" placeholder there and say
  // nothing at all about what was being saved.
  const selectionAccountLabel = useMemo(() => {
    const accounts = new Set(selectedLegs
      .map((row) => [row._brokerName, row._accountId].filter(Boolean).join(' '))
      .filter(Boolean));
    if (accounts.size === 1) return [...accounts][0];
    if (accounts.size > 1) return `${accounts.size} accounts`;
    return selectedConfig?.account_id || selectedBrokerName || 'Selected account';
  }, [selectedLegs, selectedConfig, selectedBrokerName]);

  // Only the selection owner's groups may be offered as a destination.
  // existingStrategies spans the whole group scope so the saved-leg filter can
  // see every client's legs - offering all of them here would let a client's
  // positions be filed into another client's strategy, which the backend would
  // then reject as "not found for this user".
  const ownerStrategies = useMemo(() => {
    const owner = selectionOwners.length === 1 ? selectionOwners[0] : '';
    if (!owner) return existingStrategies;
    return existingStrategies.filter((strategy) => (
      // A single-client read tags nothing, so an untagged strategy is this
      // client's by construction.
      !strategy._userId || String(strategy._userId) === owner
    ));
  }, [existingStrategies, selectionOwners]);

  // In group scope this covers every client in the group, not just one: the
  // saved-leg set below is what hides already-saved positions from the table, so
  // missing a client's strategies would show their saved legs as unsaved.
  // Each strategy carries its owner (_userId) because the API is per-user and
  // the response does not repeat it in a form the dialog can group by.
  const loadExistingStrategies = useCallback(async (nextUserId = userId) => {
    const owners = nextUserId === ALL_USERS
      ? groupUsers.map((user) => String(user.id))
      : (nextUserId ? [String(nextUserId)] : []);

    if (!owners.length) {
      setExistingStrategies([]);
      return [];
    }

    try {
      const results = await Promise.all(owners.map(async (owner) => {
        try {
          const res = await apiGet(`/strategy-master/list.php?user_id=${owner}`);
          return (res.data || []).map((strategy) => ({ ...strategy, _userId: owner }));
        } catch {
          return [];
        }
      }));
      const list = results.flat();
      setExistingStrategies(list);
      return list;
    } catch {
      setExistingStrategies([]);
      return [];
    }
  }, [userId, groupUsers]);

  useEffect(() => {
    loadExistingStrategies(userId);
  }, [loadExistingStrategies, userId]);

  useEffect(() => {
    if (!strategyDialogOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape' && !savingStrategy) setStrategyDialogOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [savingStrategy, strategyDialogOpen]);

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
    // A strategy belongs to exactly one client (strategy_master.user_id), so a
    // selection spanning clients cannot become one - splitting it silently into
    // several strategies would be worse than saying so.
    if (selectionOwners.length > 1) {
      setStrategyError(`This selection spans ${selectionOwners.length} clients (${selectionOwnerNames}). A group holds one client's legs - select one client's positions.`);
      return;
    }

    const ownerId = selectionOwners[0] || (userId === ALL_USERS ? '' : userId);
    if (!ownerId) {
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
      // The account this row was actually read from. In group scope the legs can
      // come from several of one client's accounts, and the request-level tag
      // below can only describe one of them.
      broker_config_id: Number(row._configId || 0) || null,
      broker_name: row._brokerName || '',
      broker_account_id: row._accountId || '',
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
      body = { user_id: Number(ownerId), strategy_code: selectedStrategyCode, ...brokerTag, legs };
    } else {
      const name = strategyName.trim();
      if (!name) {
        setStrategyError('Enter a strategy name');
        return;
      }
      body = { user_id: Number(ownerId), strategy_name: name, ...brokerTag, legs };
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
  }, [configId, loadExistingStrategies, selectedBrokerName, selectedConfig, strategyMode,
    selectedStrategyCode, strategyName, userId, selectedLegs, selectionOwners, selectionOwnerNames]);

  // Dump the selected positions into the backend open_positions table, tagged
  // with the user and the broker account they came from, so they can be mapped
  // back to their source later. Separate from "Add Group": that saves them as a
  // managed strategy, this just captures the raw selection.
  // Unlike Add Group this happily spans clients: open_positions is keyed per
  // (user, account, contract), so a whole group's books can be captured in one
  // go as long as each leg says who it belongs to.
  const saveOpenPositions = useCallback(async () => {
    if (!groupMode && !userId) {
      setStatus('Select a user first');
      return;
    }
    if (!groupMode && !selectedConfig) {
      setStatus('Select an account first');
      return;
    }
    if (!selectedLegs.length) return;

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
      user_id: Number(row._userId || 0) || null,
      broker_config_id: Number(row._configId || 0) || null,
      broker_name: row._brokerName || '',
      broker_account_id: row._accountId || '',
    }));

    setSavingOpenPositions(true);
    try {
      const res = await apiPost('/open-positions/create.php', {
        // Only a fallback now - every leg above carries its own owner. Kept so a
        // row that somehow arrived untagged still lands on the selected client
        // rather than being rejected.
        user_id: Number(groupMode ? (selectionOwners[0] || 0) : userId) || 0,
        broker_config_id: Number(configId || 0) || null,
        broker_name: selectedBrokerName || selectedConfig?.broker_name || '',
        broker_account_id: selectedConfig?.account_id || '',
        legs,
      });
      setStatus(res.message || 'Open positions saved');
      setSelectedPositionKeys(new Set());
    } catch (error) {
      setStatus(error.message || 'Failed to save open positions');
    } finally {
      setSavingOpenPositions(false);
    }
  }, [userId, configId, selectedConfig, selectedBrokerName, selectedLegs, groupMode, selectionOwners]);

  return (
    <div className="trade-panel">
      <div className="positions-view positions-view-compact get-positions-view">
        <div className="positions-toolbar">
          {groups.length > 0 && (
            <CompactSelect
              title="Group"
              icon="group"
              menuMinWidth={220}
              value={groupId}
              onChange={handleGroupId}
              options={[
                { value: ALL_GROUPS, label: 'All groups', meta: `${visibleUsers.length} client${visibleUsers.length === 1 ? '' : 's'}` },
                ...groups.map((group) => ({
                  value: String(group.id),
                  label: group.name,
                  meta: `${visibleUsers.filter((user) => String(user.group_id || '') === String(group.id)).length} clients`,
                })),
              ]}
            />
          )}
          <CompactSelect
            title="Client"
            icon="user"
            menuMinWidth={240}
            value={userId}
            onChange={handleUserId}
            options={[
              // Reading the whole scope at once is a choice in the Client picker
              // itself, so the group selection above stays a pure filter.
              {
                value: ALL_USERS,
                label: selectedGroup ? `All of ${selectedGroup.name}` : 'All clients',
                meta: `${scopedAccounts.length} account${scopedAccounts.length === 1 ? '' : 's'}`,
              },
              ...groupUsers.map((user) => ({
                value: String(user.id),
                label: user.username || `${user.first_name || ''} ${user.last_name || ''}`.trim() || `User ${user.id}`,
              })),
            ]}
          />
          <CompactSelect
            title="Account"
            value={groupMode ? ALL_USERS : configId}
            onChange={handleConfigId}
            disabled={groupMode || configLoading || !visibleConfigs.length}
            options={groupMode
              ? [{ value: ALL_USERS, label: 'Every account', meta: `${scopedAccounts.length} in scope` }]
              : visibleConfigs.map((config) => ({
                value: String(config.id),
                label: config.account_id || `Account ${config.id}`,
                meta: config.broker_name || 'Broker',
              }))}
          />
          <button
            className="positions-load-btn"
            onClick={load}
            disabled={loading || (groupMode
              ? !scopedAccounts.length
              : (!selectedConfig || (selectedIsSupported && !client)))}
            type="button"
          >
            <RefreshCw size={13} className={loading ? 'spin' : ''} />
            {loading
              ? (groupProgress ? `${groupProgress.done}/${groupProgress.total}` : 'Loading')
              : 'Refresh'}
          </button>

          {selectedCount > 0 && (
            <div className="positions-selection-actions">
              <span className="positions-selection-count">{selectedCount} selected</span>
              <button type="button" className="positions-group-btn" onClick={openStrategyDialog}>
                <Layers size={13} /> Add Group
              </button>
              <button
                type="button"
                className="positions-group-btn"
                onClick={saveOpenPositions}
                // Group scope has no single selected account - every ticked leg
                // carries its own, which is exactly what this save writes. Gating
                // on selectedConfig left the button permanently dead there.
                disabled={savingOpenPositions || (!groupMode && !selectedConfig)}
                title="Save the selected positions to the Open Positions table, tagged by user and broker account"
              >
                <BookmarkPlus size={13} /> {savingOpenPositions ? 'Saving…' : 'Save Open Positions'}
              </button>
              <button type="button" className="positions-selection-clear" onClick={() => setSelectedPositionKeys(new Set())}>
                Clear
              </button>
            </div>
          )}

          <span className="positions-toolbar-divider" aria-hidden="true" />

          <CompactSelect
            title="View"
            value={grouping}
            onChange={setGrouping}
            className="position-group-select"
            options={[
              // Only meaningful when the table actually holds several accounts.
              ...(groupMode ? [{ value: 'account', label: 'By client', meta: `${scopedAccounts.length} accounts` }] : []),
              { value: 'expiry', label: 'By expiry' },
              { value: 'none', label: 'Ungrouped' },
            ]}
          />
          {showGroupControls && (
            <CompactSelect
              title="Groups"
              value={groupView}
              onChange={(value) => setAllGroupsCollapsed(value === 'collapsed')}
              className="position-group-select"
              options={[
                { value: 'expanded', label: 'Expanded' },
                { value: 'collapsed', label: 'Collapsed' },
              ]}
            />
          )}
          <label className="orderbook-search positions-search">
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search positions" />
            {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear search"><X size={13} /></button>}
          </label>

          {activeFilterCount > 0 && (
            <button className="positions-clear-filters" type="button" onClick={() => setFilters(defaultPositionFilters)}>
              <X size={13} /> Clear {activeFilterCount}
            </button>
          )}

          <span className="positions-toolbar-divider" aria-hidden="true" />
          <span className="positions-toolbar-summary" title={`${longCount} long · ${shortCount} short`}>
            <strong>{positionRows.length}</strong> positions
          </span>
          <span className={`positions-toolbar-pnl ${totalPnl >= 0 ? 'up' : 'down'}`}>
            P&amp;L <strong>{money(totalPnl)}</strong>
          </span>
          <span className={`orderbook-live-pill ${positionFeedStatus}`} title={positionFeedTitle}>
            <Radio size={12} /> {positionFeedStatus === 'live' ? 'Market live' : positionFeedStatus === 'connecting' ? 'Connecting' : 'Offline'}
          </span>
          <span className={`orderbook-live-pill ${fillSyncStatus}`} title="Auto re-syncs positions when an order fills">
            <RefreshCw size={12} /> {fillSyncStatus === 'live' ? 'Auto-sync' : fillSyncStatus === 'connecting' ? 'Syncing' : 'Sync off'}
          </span>
          {status && <span className="positions-toolbar-status" title={status}><Info size={12} /> {status}</span>}
        </div>

        <div className="positions-table-wrap">
          {/* Column widths are declared positionally (nth-child) for the shared
              7-column book table, so the 8-column group read needs its own set:
              without it the extra Client/Account column pushes every width one
              place along and the last column (P&L) is left with nothing at all -
              on a table-layout:fixed table that collapses it to zero and the
              numbers are simply not on screen. The `col-*` classes below are
              what those width rules key on, so the layout follows the COLUMN
              rather than its position. */}
          <table className={`positions-table position-book-table position-book-compact${groupMode ? ' position-book-grouped' : ''}`}>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column} className={`col-${column}${positionColumnIsNumeric(column) ? ' num' : ''}`}>
                    <PositionColumnHeader
                      column={column}
                      sort={sort}
                      setSort={setSort}
                      filters={filters}
                      setFilters={setFilters}
                      filterOptions={filterOptions}
                      openFilter={openFilter}
                      setOpenFilter={setOpenFilter}
                      selectAllVisible={visiblePositionSelections.length > 0}
                      allSelected={allVisibleSelected}
                      onToggleSelectAll={toggleVisibleSelection}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* First load only: skeleton rows while there's nothing on screen
                  yet. Silent background refreshes (the timer / order stream) keep
                  loading false and never reach here, so live rows never flash. */}
              {loading && positionRows.length === 0 ? (
                <SkeletonRows count={8} columns={columns.length} />
              ) : (
                <>
              {tableRows.map((item, i) => (
                item.type === 'group' ? (
                  (() => {
                    const memberKeys = groupSelections.get(item.key) || [];
                    const groupAllSelected = memberKeys.length > 0
                      && memberKeys.every((key) => selectedPositionKeys.has(key));
                    const groupSomeSelected = !groupAllSelected
                      && memberKeys.some((key) => selectedPositionKeys.has(key));
                    // An expiry group's title already IS the expiry - repeating
                    // it on the same bar says nothing. A client group's title is
                    // a person, so it needs both.
                    const groupExpiries = item.kind === 'expiry' ? [] : item.expiries;
                    const groupContracts = [
                      item.roots.join(', '),
                      groupExpiries.join(', '),
                    ].filter(Boolean).join(' · ');
                    return (
                  <tr
                    key={`group-${item.key}-${i}`}
                    className={`position-expiry-row${collapsedGroups.has(item.key) ? ' collapsed' : ''}`}
                  >
                    <td className="position-group-label" colSpan={Math.max(1, columns.length - 1)}>
                      {/* The collapse target is itself a button, so the group
                          checkbox has to sit beside it rather than inside it -
                          nesting one button in another is invalid, and the click
                          would collapse the group as well as tick it. */}
                      <div className="position-expiry-row-bar">
                        {memberKeys.length > 0 && (
                          <button
                            type="button"
                            className={`position-row-check position-group-check${groupAllSelected ? ' checked' : groupSomeSelected ? ' partial' : ''}`}
                            aria-pressed={groupAllSelected}
                            aria-label={`${groupAllSelected ? 'Clear' : 'Select'} all ${memberKeys.length} positions in ${item.title}`}
                            title={groupAllSelected
                              ? `Clear all ${memberKeys.length} in this group`
                              : `Select all ${memberKeys.length} in this group`}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleGroupSelection(item.key);
                            }}
                          >
                            {groupAllSelected
                              ? <Check size={12} strokeWidth={3} />
                              : groupSomeSelected ? <Minus size={12} strokeWidth={3} /> : null}
                          </button>
                        )}
                        <button
                          type="button"
                          className="position-expiry-row-content"
                          onClick={() => toggleGroupCollapsed(item.key)}
                          aria-expanded={!collapsedGroups.has(item.key)}
                          title={collapsedGroups.has(item.key) ? 'Expand group' : 'Collapse group'}
                        >
                          <ChevronDown size={14} className="position-expiry-caret" aria-hidden="true" />
                          {item.brokerName && (
                            <BrokerMark brokerName={item.brokerName} className="position-group-broker" />
                          )}
                          {/* Identity first and truncatable, stats after: a long
                              client name shortens itself rather than pushing the
                              counts out of a cell that clips its overflow. */}
                          <span className="position-group-name" title={item.title}>{item.title}</span>
                          <small className="position-group-sub" title={item.subtitle}>{item.subtitle}</small>
                          {/* What the group is actually holding - underlying,
                              then expiries in front-month order. A collapsed
                              client group is otherwise just a name and a number:
                              nothing on the bar says it is NIFTY at all. Capped
                              at two of each, with the full list on hover. */}
                          {groupContracts && (
                            <span className="position-group-contracts" title={groupContracts}>
                              {item.roots.slice(0, 2).map((root) => (
                                <em className="position-group-root" key={root}>{root}</em>
                              ))}
                              {item.roots.length > 2 && (
                                <em className="position-group-more">+{item.roots.length - 2}</em>
                              )}
                              {groupExpiries.slice(0, 2).map((expiry) => (
                                <em className="position-group-exp" key={expiry}>{expiry}</em>
                              ))}
                              {groupExpiries.length > 2 && (
                                <em className="position-group-more">+{groupExpiries.length - 2}</em>
                              )}
                            </span>
                          )}
                          {/* Long / short / flat at a glance, so a collapsed
                              account still says what shape its book is in. */}
                          <span className="position-group-mix">
                            {item.longs > 0 && <em className="is-long">{item.longs} long</em>}
                            {item.shorts > 0 && <em className="is-short">{item.shorts} short</em>}
                            {item.closed > 0 && <em className="is-flat">{item.closed} flat</em>}
                          </span>
                          <small className="position-group-count">{item.count} positions</small>
                        </button>
                      </div>
                    </td>
                    {/* The subtotal sits IN the P&L column instead of floating at
                        the end of a full-width bar, so it lines up with the
                        numbers it totals - and the label it would otherwise have
                        to carry is already the column header. */}
                    <td className="col-pnl num position-group-total">
                      <strong
                        className={`position-group-pnl ${item.pnl >= 0 ? 'up' : 'down'}`}
                        title={`Group P&L · ${item.count} position${item.count === 1 ? '' : 's'}`}
                      >
                        {money(item.pnl)}
                      </strong>
                    </td>
                  </tr>
                    );
                  })()
                ) : collapsedGroups.has(item.groupKey) ? null : (
                  (() => {
                    const rowKey = positionRowKey(item.row, i);
                    const selected = selectedPositionKeys.has(rowKey);
                    return (
                  <tr
                    key={rowKey}
                    className={`${Number(item.row.netqty || 0) < 0 ? 'position-row-short' : ''}${Number(item.row.netqty || 0) === 0 ? ' position-row-closed' : ''}${selected ? ' position-row-selected' : ''}`}
                  >
                    {columns.map((column) => (
                      <td key={column} className={`col-${column}${positionColumnIsNumeric(column) ? ' num' : ''}`}>
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
                  <td className="positions-empty" colSpan={columns.length}>
                    <div className="positions-empty-state">
                      <button
                        className="positions-empty-action"
                        type="button"
                        onClick={load}
                        disabled={loading || (groupMode
                          ? !scopedAccounts.length
                          : (!selectedConfig || (selectedIsSupported && !client)))}
                      >
                        <Info size={18} />
                      </button>
                      <strong>{loading ? 'Loading positions' : rows.length > 0 ? 'No positions outside strategies' : 'No positions'}</strong>
                    </div>
                  </td>
                </tr>
              )}
                </>
              )}
            </tbody>
          </table>
        </div>

        {strategyDialogOpen && createPortal(
          <div
            className="strategy-dialog-backdrop"
            onMouseDown={() => { if (!savingStrategy) setStrategyDialogOpen(false); }}
          >
            <div
              className="strategy-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="strategy-dialog-title"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="strategy-dialog-head">
                <div className="strategy-dialog-title">
                  <span className="strategy-dialog-title-icon"><Layers size={17} /></span>
                  <span className="strategy-dialog-heading">
                    <strong id="strategy-dialog-title">Add positions to group</strong>
                    <small>Save selected contracts as one managed strategy</small>
                  </span>
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
                <div className="strategy-dialog-selection">
                  <span className="strategy-dialog-selection-count">
                    <strong>{selectedCount}</strong>
                    <small>Selected {selectedCount === 1 ? 'position' : 'positions'}</small>
                  </span>
                  <span className="strategy-dialog-selection-scope">
                    <small>Client</small>
                    <strong>{selectionOwnerNames || selectedUserLabel || 'Selected client'}</strong>
                  </span>
                  <span className="strategy-dialog-selection-scope">
                    <small>Account</small>
                    <strong>{selectionAccountLabel}</strong>
                  </span>
                </div>

                {ownerStrategies.length > 0 && (
                  <div className="strategy-mode-toggle">
                    <button
                      type="button"
                      className={strategyMode === 'new' ? 'active' : ''}
                      onClick={() => { setStrategyMode('new'); setStrategyError(''); }}
                    >
                      New group
                    </button>
                    <button
                      type="button"
                      className={strategyMode === 'existing' ? 'active' : ''}
                      onClick={() => { setStrategyMode('existing'); setStrategyError(''); }}
                    >
                      Existing group
                    </button>
                  </div>
                )}

                {strategyMode === 'existing' ? (
                  <label className="strategy-dialog-field">
                    <span>Existing group</span>
                    <PositionSelect
                      value={selectedStrategyCode}
                      onChange={setSelectedStrategyCode}
                      emptyLabel="Select a group"
                      portal
                      options={ownerStrategies.map((strategy) => ({
                        value: strategy.strategy_code,
                        label: strategy.strategy_name,
                        meta: strategyBrokerLabel(strategy) || `${(strategy.legs || []).length} legs`,
                      }))}
                    />
                  </label>
                ) : (
                  <label className="strategy-dialog-field">
                    <span>Group name</span>
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
                    : (strategyMode === 'existing' ? 'Add to Group' : 'Create Group')}
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

// One header row per distinct group, then that group's rows.
//
// `contiguous` is the difference between the two groupings. Expiry groups ride
// the table's own expiry-ordered sort, so equal keys already sit together and a
// header is emitted whenever the key changes - that keeps the user's sort
// intact. Account groups do NOT: rows arrive interleaved by expiry (which is the
// whole complaint), so they have to be gathered per account first, and only the
// order WITHIN each account stays as sorted.
function groupPositionRows(rows, metaOf, { contiguous = true } = {}) {
  const emptyStat = () => ({
    count: 0,
    pnl: 0,
    longs: 0,
    shorts: 0,
    closed: 0,
    // What the group actually HOLDS, which a client-grouped header cannot say
    // any other way: its title is a person, not a contract. Roots are counted
    // (not just collected) so the dominant underlying leads; expiries carry
    // their sort value so they read front-month first, like the rows do.
    roots: new Map(),
    expiries: new Map(),
  });

  const stats = new Map();
  for (const row of rows) {
    const group = metaOf(row);
    const stat = stats.get(group.key) || emptyStat();
    const qty = Number(row.netqty || 0);
    stat.count += 1;
    stat.pnl += pnlOf(row);
    if (qty > 0) stat.longs += 1;
    else if (qty < 0) stat.shorts += 1;
    else stat.closed += 1;

    const root = String(contractMeta(row).root || '').trim();
    if (root) stat.roots.set(root, (stat.roots.get(root) || 0) + 1);
    const expiry = positionExpiryMeta(row);
    if (expiry.label && expiry.label !== 'No Expiry') stat.expiries.set(expiry.label, expiry.sort);

    stats.set(group.key, stat);
  }

  const header = (group) => {
    const stat = stats.get(group.key) || emptyStat();
    return {
      type: 'group',
      key: group.key,
      kind: group.kind || '',
      title: group.title,
      subtitle: group.subtitle,
      brokerName: group.brokerName || '',
      count: stat.count,
      pnl: stat.pnl,
      longs: stat.longs,
      shorts: stat.shorts,
      closed: stat.closed,
      roots: [...stat.roots.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([root]) => root),
      expiries: [...stat.expiries.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([label]) => label),
    };
  };

  if (contiguous) {
    const out = [];
    let last = '';
    for (const row of rows) {
      const group = metaOf(row);
      if (group.key !== last) {
        out.push(header(group));
        last = group.key;
      }
      out.push({ type: 'row', groupKey: group.key, row });
    }
    return out;
  }

  // Insertion-ordered, so the groups appear in the order the sort first met them.
  const buckets = new Map();
  for (const row of rows) {
    const group = metaOf(row);
    const bucket = buckets.get(group.key);
    if (bucket) bucket.rows.push(row);
    else buckets.set(group.key, { group, rows: [row] });
  }

  const out = [];
  buckets.forEach(({ group, rows: bucketRows }) => {
    out.push(header(group));
    bucketRows.forEach((row) => out.push({ type: 'row', groupKey: group.key, row }));
  });
  return out;
}

function positionGroupMeta(row) {
  const expiry = positionExpiryMeta(row).label;
  const exchange = String(row.exchange || 'No Exchange');
  return { kind: 'expiry', title: expiry, subtitle: exchange, key: `${expiry}::${exchange}` };
}

// Groups a group-scope read by the account each row came from, so one client's
// book is not interleaved with another's. Keyed on configId rather than the
// labels: two clients can share an account label, and one client can hold
// several accounts.
function positionAccountGroupMeta(row) {
  const client = String(row._username || '').trim();
  const account = String(row._accountId || '').trim();
  const broker = String(row._brokerName || '').trim();
  const key = String(row._configId || `${client}::${account}`) || 'unknown';

  return {
    key,
    kind: 'account',
    title: client || account || 'Unknown account',
    subtitle: [broker, account].filter(Boolean).join(' · ') || 'No account',
    brokerName: broker,
  };
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
    configId: row._configId,
    token: row.symboltoken,
    symbol: row.tradingsymbol || row.symbolname || row.symbol,
    exchange: row.exchange,
    product: row.producttype || row.product_type,
    qty: row.netqty,
  });
}

function strategyLegIdentityKey(leg) {
  return normalizedPositionIdentity({
    configId: leg.broker_config_id,
    token: leg.symbol_token,
    symbol: leg.trading_symbol,
    exchange: leg.exchange,
    product: leg.product_type,
    qty: leg.net_qty,
  });
}

// Identity is per ACCOUNT as well as per contract. A group read puts several
// clients' books on one table, and two of them holding NIFTY 24500 CE hold two
// different positions - keyed on the contract alone, one client having saved it
// into a strategy would hide the other client's from the table entirely.
//
// A leg with no account (none exist after the broker backfill, but the read is
// defensive) simply fails to match a tagged row. That errs towards showing a
// position that is already saved, which is visible and harmless - the opposite
// error hides someone else's position with no indication it happened.
function normalizedPositionIdentity({ configId, token, symbol, exchange, product, qty }) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  if (!normalizedSymbol) return '';

  return [
    String(configId ?? '').trim(),
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
    account: 'Client / Account',
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
  selectAllVisible = false,
  allSelected = false,
  onToggleSelectAll,
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
      {/* Select-all sits in the Stock header, directly above the row checkboxes,
          so one click ticks (or clears) every position on screen. */}
      {column === 'stock' && selectAllVisible && (
        <button
          type="button"
          className={`position-row-check position-head-check${allSelected ? ' checked' : ''}`}
          aria-pressed={allSelected}
          aria-label={allSelected ? 'Clear all positions' : 'Select all positions'}
          title={allSelected ? 'Clear all' : 'Select all'}
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelectAll?.();
          }}
        >
          {allSelected && <Check size={12} strokeWidth={3} />}
        </button>
      )}
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
  } else if (column === 'account') {
    reset = ['account'];
    body = select('Account', 'account', filterOptions.accounts);
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
  if (column === 'account') return Boolean(filters.account);
  if (column === 'product') return Boolean(filters.product || filters.side);
  return Boolean(filters[column]);
}

function buildFilterOptions(rows) {
  const exchanges = new Set();
  const expiries = new Map();
  const products = new Set();
  // Keyed by configId so two clients with the same account label stay distinct.
  const accounts = new Map();

  for (const row of rows) {
    if (row.exchange) exchanges.add(String(row.exchange));
    const meta = positionExpiryMeta(row);
    if (meta.label && meta.label !== 'No Expiry') expiries.set(meta.label, meta.sort);
    products.add(compactProductTag(row.producttype || row.product_type || '-'));
    if (row._configId) {
      accounts.set(String(row._configId), [row._username, row._accountId].filter(Boolean).join(' · ')
        || String(row._configId));
    }
  }

  return {
    exchanges: [...exchanges].sort(),
    expiries: [...expiries.entries()].sort((a, b) => a[1] - b[1]).map(([label]) => label),
    products: [...products].filter(Boolean).sort(),
    accounts: [...accounts.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
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
    if (filters.account && String(row._configId || '') !== filters.account) return false;
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
    // So a group-scope search can find "everything of NP Berlia" or one account.
    row._username,
    row._accountId,
    row._brokerName,
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
  if (key === 'account') {
    // Client first, then account - which is the order the cell reads in, so
    // sorting by this column groups a client's accounts together.
    const clientDiff = String(a._username || '').localeCompare(String(b._username || ''));
    if (clientDiff) return clientDiff;
    return String(a._accountId || '').localeCompare(String(b._accountId || ''));
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
  if (column === 'account') return <PositionAccountCell row={row} />;
  if (column === 'product') return <PositionProductCell row={row} />;
  if (column === 'netQty') return <PositionQtyCell row={row} />;
  if (column === 'buyAvg') return <PositionPriceCell value={positionBuyAvg(row)} />;
  if (column === 'sellAvg') return <PositionPriceCell value={positionSellAvg(row)} />;
  if (column === 'ltp') return <PositionPriceCell value={positionValue(row, ['ltp', 'LTP', 'lasttradedprice'])} strong dir={row.liveDir} />;
  if (column === 'pnl') return <PositionPnlCell row={row} />;
  return '-';
}

// Who this row belongs to, shown only in group scope. The client is the headline
// because that is what the reader is scanning for; the account id sits under it,
// since one client can hold several. The broker mark leads, so scanning the
// column separates Angel from Kotak rows without reading anything.
function PositionAccountCell({ row }) {
  const client = row._username || '';
  const account = row._accountId || '';
  if (!client && !account) return <span className="position-price-muted">-</span>;

  return (
    <span className="position-account-cell">
      <BrokerMark brokerName={row._brokerName} />
      <span className="position-account-cell-text">
        <strong>{client || account}</strong>
        {client && account && <small>{account}</small>}
      </span>
    </span>
  );
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
