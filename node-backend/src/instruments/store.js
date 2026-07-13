import fs from 'node:fs';
import path from 'node:path';

const CACHE_VERSION = 1;
const TTL_MS = 20 * 60 * 60 * 1000;

function lookupKey(symbol, exchange) {
  return `${String(symbol || '').toUpperCase()}|${String(exchange || '').toUpperCase()}`;
}

function brokerLookupKey(symbol, exchange) {
  return `${String(symbol || '').toUpperCase()}|${String(exchange || '').toLowerCase()}`;
}

function indexes(rows) {
  const byKey = new Map();
  const byBrokerKey = new Map();
  for (const row of rows) {
    if (row.symbol) byKey.set(lookupKey(row.symbol, row.exchange), row);
    if (row.brsymbol) {
      byBrokerKey.set(brokerLookupKey(row.brsymbol, row.brexchange || row.segment), row);
      byBrokerKey.set(brokerLookupKey(row.brsymbol, row.exchange), row);
    }
  }
  return { byKey, byBrokerKey };
}

export class BrokerInstrumentStore {
  constructor(cacheDir = process.env.BROKER_MASTER_CACHE_DIR || path.resolve(process.cwd(), 'instrument_cache')) {
    this.cacheDir = cacheDir;
    this.brokers = new Map();
  }

  set(broker, rows) {
    const entry = { rows, ...indexes(rows), loadedAt: Date.now() };
    this.brokers.set(broker, entry);
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(path.join(this.cacheDir, `${broker}.json`), JSON.stringify({
        version: CACHE_VERSION,
        loadedAt: entry.loadedAt,
        rows,
      }));
    } catch {
      // The in-memory store remains usable if the cache directory is read-only.
    }
    return rows.length;
  }

  loadCache(broker) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.cacheDir, `${broker}.json`), 'utf8'));
      if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.rows)) return false;
      if (Date.now() - Number(parsed.loadedAt || 0) >= TTL_MS) return false;
      this.brokers.set(broker, { rows: parsed.rows, ...indexes(parsed.rows), loadedAt: parsed.loadedAt });
      return true;
    } catch {
      return false;
    }
  }

  isFresh(broker) {
    const entry = this.brokers.get(broker);
    return Boolean(entry && Date.now() - entry.loadedAt < TTL_MS);
  }

  resolve(broker, symbol, exchange) {
    return this.brokers.get(broker)?.byKey.get(lookupKey(symbol, exchange)) || null;
  }

  resolveBroker(broker, symbol, exchange) {
    return this.brokers.get(broker)?.byBrokerKey.get(brokerLookupKey(symbol, exchange)) || null;
  }

  route(symbol, exchange) {
    const result = {};
    for (const broker of this.brokers.keys()) result[broker] = this.resolve(broker, symbol, exchange);
    return result;
  }

  search(broker, query, limit = 50) {
    const text = String(query || '').toUpperCase().trim();
    if (!text) return [];
    const output = [];
    for (const row of this.brokers.get(broker)?.rows || []) {
      if (row.symbol.includes(text) || row.name?.toUpperCase().includes(text) || row.brsymbol?.toUpperCase().includes(text)) {
        output.push(row);
        if (output.length >= limit) break;
      }
    }
    return output;
  }

  status() {
    const result = {};
    for (const [broker, entry] of this.brokers) {
      result[broker] = {
        rows: entry.rows.length,
        loadedAt: new Date(entry.loadedAt).toISOString(),
        fresh: this.isFresh(broker),
      };
    }
    return result;
  }
}
