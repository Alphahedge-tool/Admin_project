import { BrokerInstrumentStore } from './store.js';
import {
  downloadKotakMaster,
  downloadZerodhaMaster,
  normalizeAngelRows,
} from './loaders.js';

export class BrokerInstrumentManager {
  constructor(angelMaster, store = new BrokerInstrumentStore()) {
    this.angelMaster = angelMaster;
    this.store = store;
    this.loading = new Map();
  }

  async #singleflight(broker, loader) {
    if (this.loading.has(broker)) return this.loading.get(broker);
    const promise = loader().finally(() => this.loading.delete(broker));
    this.loading.set(broker, promise);
    return promise;
  }

  async loadAngel({ force = false } = {}) {
    if (!force && (this.store.isFresh('angel') || this.store.loadCache('angel'))) return 'cached';
    return this.#singleflight('angel', async () => {
      const rows = normalizeAngelRows(await this.angelMaster.data());
      return `loaded ${this.store.set('angel', rows)}`;
    });
  }

  async loadSessionBroker(broker, credentials, { force = false } = {}) {
    const key = String(broker || '').toLowerCase();
    if (!['kotak', 'zerodha'].includes(key)) throw new Error(`Unsupported session master: ${broker}`);
    if (!force && (this.store.isFresh(key) || this.store.loadCache(key))) return 'cached';
    return this.#singleflight(key, async () => {
      const rows = key === 'kotak'
        ? await downloadKotakMaster(credentials)
        : await downloadZerodhaMaster(credentials);
      return `loaded ${this.store.set(key, rows)}`;
    });
  }

  resolve(broker, symbol, exchange) {
    return this.store.resolve(String(broker || '').toLowerCase(), symbol, exchange);
  }

  resolveBroker(broker, symbol, exchange) {
    return this.store.resolveBroker(String(broker || '').toLowerCase(), symbol, exchange);
  }

  route(symbol, exchange) {
    return this.store.route(symbol, exchange);
  }

  search(broker, query, limit) {
    return this.store.search(String(broker || '').toLowerCase(), query, limit);
  }

  status() {
    return this.store.status();
  }
}
