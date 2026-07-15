// Multiplexed order-status hub: ONE SSE connection to the browser carrying the
// order/fill events of MANY broker accounts at once.
//
// A browser holds at most ~6 connections per host, and the old design opened one
// order-status stream PER account - so the Client Dashboard could only stream
// fills for a handful of a group's members before the browser ran out of
// connections (which is why the overview had to cap them). A Node server has no
// such limit: it keeps one upstream order socket per logged-in account here -
// Angel's smart-order-update socket for Angel accounts, Kotak's user stream for
// Kotak accounts - and fans every event down a single SSE, tagged with the
// account it came from. The browser then refreshes just that member's book.
//
// The upstream sockets are owned by the server and reconnect with backoff on
// their own, so the browser's single SSE never has to babysit N reconnections.

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;
const IDLE_CLOSE_MS = 10000;

// One account's upstream order socket, kept alive across drops. `openUpstream`
// is the broker-specific factory (injected by the server, where the Angel auth
// and Kotak helpers live); it returns a handle with close() and emits events
// through the callback it is given - including a terminal 'end' that tells this
// wrapper to reconnect.
class AccountStream {
  constructor(account, openUpstream, onEvent) {
    this.account = account;
    this.openUpstream = openUpstream;
    this.onEvent = onEvent;
    this.handle = null;
    this.closed = false;
    this.retries = 0;
    this.retryTimer = null;
    this.#connect();
  }

  updateAccount(account) {
    // Latest credentials for this account. Picked up on the next reconnect rather
    // than forcing one now - a healthy socket keeps running on the token it has.
    this.account = account;
  }

  #connect() {
    if (this.closed) return;
    let ended = false;
    const emit = (event, data) => {
      if (this.closed) return;
      if (event === 'end') {
        if (!ended) {
          ended = true;
          this.#scheduleReconnect();
        }
        return;
      }
      // A socket that reached "connected" is healthy: reset the backoff so the
      // NEXT drop retries quickly rather than at the tail of the old ramp.
      if (event === 'status' && (data?.connected || data?.status)) this.retries = 0;
      this.onEvent(event, data);
    };
    try {
      this.handle = this.openUpstream(this.account, emit);
    } catch (error) {
      emit('error', { status: false, message: error.message || 'Order stream unavailable' });
      emit('end', {});
    }
  }

  #scheduleReconnect() {
    this.handle = null;
    if (this.closed) return;
    const delay = Math.min(RETRY_BASE_MS * (2 ** this.retries), RETRY_MAX_MS);
    this.retries += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.#connect();
    }, delay);
  }

  close() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    try {
      this.handle?.close();
    } catch {
      /* already down */
    }
    this.handle = null;
  }
}

export class OrderHub {
  // openAngelStream/openKotakStream: (account, emit) => ({ close() }). `account`
  // carries { configId, broker, userId, client }; `emit(event, data)` forwards a
  // normalized event ('session' | 'status' | 'order' | 'position' | 'error' |
  // 'end'). 'end' means the socket is gone and should be reconnected.
  constructor({ openAngelStream, openKotakStream }) {
    this.openAngelStream = openAngelStream;
    this.openKotakStream = openKotakStream;
    this.clients = new Set(); // SSE handles
    this.streams = new Map(); // "broker:configId" -> AccountStream
    this.groups = new Map(); // subscriber -> Map("broker:configId" -> account)
    this.idleTimer = null;
  }

  addClient(handle) {
    this.#cancelIdleClose();
    this.clients.add(handle);
    handle.write({
      event: 'status',
      data: JSON.stringify({ connected: this.streams.size > 0, accounts: this.streams.size, message: 'Order hub open' }),
    });
    return this.streams.size;
  }

  removeClient(handle) {
    if (this.clients.delete(handle) && this.clients.size === 0) {
      // Don't tear every upstream socket down the instant the page's SSE blips
      // (EventSource reconnects on its own); give it a moment to come back.
      this.#scheduleIdleClose();
    }
  }

  // Reconciles ONE subscriber (a page) to exactly the accounts it wants streamed.
  // An account is dropped only when no subscriber still wants it.
  setAccounts(subscriber, accounts) {
    const map = new Map();
    for (const account of accounts || []) {
      if (!account || !account.configId || !account.client) continue;
      const broker = account.broker === 'kotak' ? 'kotak' : 'angelone';
      map.set(`${broker}:${account.configId}`, { ...account, broker });
    }
    if (map.size) this.groups.set(subscriber, map);
    else this.groups.delete(subscriber);
    this.#reconcile();
    return this.streams.size;
  }

  #wanted() {
    const wanted = new Map();
    for (const group of this.groups.values()) {
      for (const [key, account] of group) if (!wanted.has(key)) wanted.set(key, account);
    }
    return wanted;
  }

  #reconcile() {
    const wanted = this.#wanted();
    for (const [key, entry] of this.streams) {
      if (!wanted.has(key)) {
        entry.close();
        this.streams.delete(key);
      }
    }
    for (const [key, account] of wanted) {
      const existing = this.streams.get(key);
      if (existing) {
        existing.updateAccount(account);
        continue;
      }
      const open = account.broker === 'kotak' ? this.openKotakStream : this.openAngelStream;
      const entry = new AccountStream(account, open, (event, data) => this.#emit(account, event, data));
      this.streams.set(key, entry);
    }
  }

  #emit(account, event, data) {
    const payload = {
      configId: String(account.configId),
      broker: account.broker,
      userId: String(account.userId || ''),
      type: event,
      payload: data,
    };
    const ev = { event: '', data: JSON.stringify(payload) };
    for (const client of this.clients) {
      try {
        client.write(ev);
      } catch {
        /* slow/broken SSE client: skip */
      }
    }
  }

  #scheduleIdleClose() {
    this.#cancelIdleClose();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.clients.size === 0) this.closeAll();
    }, IDLE_CLOSE_MS);
  }

  #cancelIdleClose() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  closeAll() {
    for (const entry of this.streams.values()) entry.close();
    this.streams.clear();
    this.groups.clear();
  }
}
