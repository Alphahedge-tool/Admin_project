// MasterStore: owns the scrip master (slim rows + symbol→expiries index), with
// lazy load-from-disk / download-if-stale and de-duped concurrent loads.
// Port of the Go master.go. Slim row shape: t=token, s=symbol, n=name,
// e=expiry, k=strike, g=segment, l=lotsize.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MASTER_URL, MASTER_TTL_MS, config } from './config.js';
import { parseExpiryMs, normalizeStrike, strOr, toFloat } from './util.js';

const DATA_DIR = path.resolve(process.cwd());

// Index cash-segment names we keep for spot LTP.
const NEEDED_SPOT_SYMBOLS = new Set([
  'Nifty 50', 'Nifty Bank', 'Nifty Fin Service', 'Nifty Mid Select', 'SENSEX',
]);

export class MasterStore {
  constructor() {
    this.rows = [];
    this.index = {};
    this.loadedAt = 0;
    this._loading = null; // in-flight load promise (singleflight)
  }

  #masterPath() {
    return path.join(DATA_DIR, config.masterFile);
  }

  #indexPath() {
    return path.join(DATA_DIR, config.indexFile);
  }

  #fresh() {
    return this.rows.length > 0 && Date.now() - this.loadedAt < MASTER_TTL_MS;
  }

  async #ensure() {
    if (this.#fresh()) return;
    if (this._loading) return this._loading;
    this._loading = (async () => {
      if (this.#fresh()) return;
      if (await this.#loadFromDisk()) return;
      await this.#download();
    })().finally(() => {
      this._loading = null;
    });
    return this._loading;
  }

  async data() {
    await this.#ensure();
    return this.rows;
  }

  async getIndex() {
    await this.#ensure();
    return this.index;
  }

  async warm() {
    return this.#ensure();
  }

  async #loadFromDisk() {
    try {
      const stat = await fsp.stat(this.#masterPath());
      if (Date.now() - stat.mtimeMs >= MASTER_TTL_MS) return false;
      const [rawMaster, rawIndex] = await Promise.all([
        fsp.readFile(this.#masterPath(), 'utf8'),
        fsp.readFile(this.#indexPath(), 'utf8'),
      ]);
      const rows = JSON.parse(rawMaster);
      const index = JSON.parse(rawIndex);
      if (!Array.isArray(rows) || typeof index !== 'object') return false;
      this.rows = rows;
      this.index = index;
      this.loadedAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  // Refresh forces a re-download; returns a small summary for /refresh-master.
  async refresh() {
    await this.#download();
    return {
      status: true,
      symbolCount: Object.keys(this.index).length,
      totalTokens: this.rows.length,
    };
  }

  // download fetches the full master, slims it to derivatives + needed spots,
  // builds the expiry index, writes both slim files, and updates the cache.
  async #download() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    let resp;
    try {
      resp = await fetch(MASTER_URL, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) throw new Error(`Master download failed: HTTP ${resp.status}`);
    const all = await resp.json();

    const rows = [];
    const indexSet = {}; // name -> Set(expiry)
    for (const raw of all) {
      const seg = raw.exch_seg;
      const name = raw.name || '';
      const isDerivative = seg === 'NFO' || seg === 'BFO' || seg === 'MCX';
      const isNeededSpot = (seg === 'NSE' || seg === 'BSE') && NEEDED_SPOT_SYMBOLS.has(name);
      if (!isDerivative && !isNeededSpot) continue;
      const expiry = strOr(raw.expiry, '').toUpperCase();
      let lot = Math.trunc(toFloat(raw.lotsize));
      if (lot === 0) lot = 1;
      rows.push({
        t: strOr(raw.token, ''),
        s: strOr(raw.symbol, ''),
        n: name,
        e: expiry,
        k: toFloat(raw.strike),
        g: seg,
        l: lot,
      });
      if (isDerivative && expiry !== '') {
        (indexSet[name] ||= new Set()).add(expiry);
      }
    }

    const index = {};
    for (const [name, set] of Object.entries(indexSet)) {
      index[name] = [...set].sort((a, b) => parseExpiryMs(a) - parseExpiryMs(b));
    }

    // Persist slim files (best-effort; the in-memory cache is authoritative).
    try {
      fs.writeFileSync(this.#masterPath(), JSON.stringify(rows));
      fs.writeFileSync(this.#indexPath(), JSON.stringify(index));
    } catch {
      /* ignore write errors */
    }

    this.rows = rows;
    this.index = index;
    this.loadedAt = Date.now();
  }

  // SearchScrips finds FUT/OPT contracts matching a free-text query (never
  // cash). Every whitespace token must appear in the trading symbol or name.
  // Ordered: best name match, FUT before OPT, nearest expiry, strike, CE before PE.
  async searchScrips(query, limit = 80) {
    const q = String(query || '').toUpperCase().trim();
    if (!q) return [];
    if (limit <= 0) limit = 80;
    const tokens = q.split(/\s+/);
    const primary = tokens[0];

    const rows = await this.data();
    const out = [];
    for (const row of rows) {
      const sym = String(row.s).toUpperCase();
      let optType;
      let instrument;
      if (sym.endsWith('CE')) {
        optType = 'CE';
        instrument = 'OPT';
      } else if (sym.endsWith('PE')) {
        optType = 'PE';
        instrument = 'OPT';
      } else if (sym.endsWith('FUT')) {
        optType = 'FUT';
        instrument = 'FUT';
      } else {
        continue;
      }

      const name = String(row.n).toUpperCase();
      let matched = true;
      for (const t of tokens) {
        if (!sym.includes(t) && !name.includes(t)) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      let nameScore = 2;
      if (name === primary) nameScore = 0;
      else if (name.startsWith(primary)) nameScore = 1;

      const instOrder = instrument === 'FUT' ? 0 : 1;
      const strike = instrument === 'FUT' ? 0 : normalizeStrike(row.k, row.g);

      out.push({
        r: {
          token: row.t,
          tradingSymbol: row.s,
          name: row.n,
          expiry: row.e,
          strike,
          optionType: optType,
          exchange: row.g,
          lotSize: row.l,
          instrument,
        },
        nameScore,
        instOrder,
        expiryMs: parseExpiryMs(row.e),
      });
    }

    out.sort((a, b) => {
      if (a.nameScore !== b.nameScore) return a.nameScore - b.nameScore;
      if (a.instOrder !== b.instOrder) return a.instOrder - b.instOrder;
      if (a.expiryMs !== b.expiryMs) return a.expiryMs - b.expiryMs;
      if (a.r.strike !== b.r.strike) return a.r.strike - b.r.strike;
      return a.r.optionType < b.r.optionType ? -1 : a.r.optionType > b.r.optionType ? 1 : 0;
    });

    return out.slice(0, limit).map((x) => x.r);
  }
}
