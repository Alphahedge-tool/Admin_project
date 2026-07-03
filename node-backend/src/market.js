// Market data operations on the Client: scripOptionsWithSpot (instant skeleton
// + spot/atm), chainPrices (LTP/OI/close per strike), getOptionChain (ATM
// window with greeks), resolveLeg (one contract). Port of Go market.go.
import { allScripOptions, segmentFor, SPOT_TOKENS } from './scripoptions.js';
import {
  parseExpiryMs, normalizeStrike, unionStrikes, indexOf, clampInt, nilIfEmpty,
  round2, strOr, toFloat, firstFetchedLTP, fetchedList, fetchedGreeks, firstNonZero,
  chunkTokens,
} from './util.js';
import { resolveSession, withoutSession } from './auth.js';

// scripOptionsWithSpot builds the master-only chain skeleton and, when a session
// is available, adds one cheap spot LTP quote so the response carries spot+atm
// immediately, plus the feed block + session for the live feed.
export async function scripOptionsWithSpot(client, auth, master, req, cc) {
  const res = await allScripOptions(master, req);
  const strikes = res.strikes;

  let spot = strikes.length ? strikes[Math.floor(strikes.length / 2)] : 0;

  let session = null;
  try {
    session = await auth.sessionOrLogin(cc);
  } catch {
    session = null;
  }

  const spotToken = res.spotToken || '';
  const spotExchange = res.spotExchange || '';
  if (session && spotToken) {
    const headers = client.smartHeaders(cc.apiKey);
    try {
      const q = await client.quote(headers, session.jwtToken, 'LTP', spotExchange, [spotToken]);
      const v = firstFetchedLTP(q);
      if (v > 0) spot = v;
    } catch {
      /* best-effort */
    }
  }

  let atm = 0;
  if (strikes.length) {
    atm = strikes[0];
    for (const s of strikes) {
      if (Math.abs(s - spot) < Math.abs(atm - spot)) atm = s;
    }
  }
  res.spot = spot;
  res.atm = atm;

  if (session) {
    res.feed = {
      jwtToken: session.jwtToken,
      feedToken: session.feedToken,
      apiKey: cc.apiKey,
      clientCode: cc.clientCode,
    };
    res.session = session;
  }
  return res;
}

// chainPrices returns ONLY the live prices (LTP/OI/close per strike, spot, atm,
// pcr) for a symbol+expiry, aligned by strike so the frontend merges by index.
export async function chainPrices(client, auth, master, req, cc) {
  const skel = await allScripOptions(master, req);
  const strikes = skel.strikes;
  const exchange = skel.exchange;
  const callTokens = skel.callTokens;
  const putTokens = skel.putTokens;
  const allTokens = skel.liveTokens;
  const spotToken = skel.spotToken || '';
  const spotExchange = skel.spotExchange || '';

  const session = await auth.sessionOrLogin(cc);
  if (!session) throw new Error('Angel session unavailable for prices');
  const jwt = session.jwtToken;
  const headers = client.smartHeaders(cc.apiKey);

  let spot = strikes.length ? strikes[Math.floor(strikes.length / 2)] : 0;

  const fetched = [];
  const jobs = [];
  if (spotToken) {
    jobs.push(
      client.quote(headers, jwt, 'LTP', spotExchange, [spotToken]).then((q) => {
        const v = firstFetchedLTP(q);
        if (v > 0) spot = v;
      }).catch(() => {})
    );
  }
  for (const chunk of chunkTokens(allTokens, 50)) {
    jobs.push(
      client.quote(headers, jwt, 'FULL', exchange, chunk).then((q) => {
        for (const row of fetchedList(q)) fetched.push(row);
      }).catch(() => {})
    );
  }
  await Promise.all(jobs);

  const byToken = new Map();
  for (const q of fetched) byToken.set(strOr(q.symbolToken, ''), q);

  const n = strikes.length;
  const callOI = new Array(n).fill(0);
  const putOI = new Array(n).fill(0);
  const callLtp = new Array(n).fill(0);
  const putLtp = new Array(n).fill(0);
  const callClose = new Array(n).fill(0);
  const putClose = new Array(n).fill(0);

  const readRow = (tokens, i) => {
    const tok = tokens[i];
    if (tok == null) return [0, 0, 0];
    const q = byToken.get(tok);
    if (!q) return [0, 0, 0];
    return [
      toFloat(q.opnInterest),
      firstNonZero(q, 'ltp', 'lastTradePrice', 'lastPrice', 'close'),
      firstNonZero(q, 'close', 'previousClose'),
    ];
  };

  let totalCall = 0;
  let totalPut = 0;
  for (let i = 0; i < strikes.length; i++) {
    [callOI[i], callLtp[i], callClose[i]] = readRow(callTokens, i);
    [putOI[i], putLtp[i], putClose[i]] = readRow(putTokens, i);
    totalCall += callOI[i];
    totalPut += putOI[i];
  }

  let atm = 0;
  if (strikes.length) {
    atm = strikes[0];
    for (const s of strikes) if (Math.abs(s - spot) < Math.abs(atm - spot)) atm = s;
  }
  const pcr = totalCall > 0 ? round2(totalPut / totalCall) : 0;

  return {
    status: true,
    strikes,
    spot,
    atm,
    pcr,
    callOI,
    putOI,
    callLtp,
    putLtp,
    callClose,
    putClose,
  };
}

// getOptionChain builds the ATM-centered option chain (OI, LTP, close, greek
// exposure, live-feed tokens) for a symbol+expiry.
export async function getOptionChain(client, auth, master, req) {
  const cc = req.client;
  if (!req.expiry) throw new Error('Expiry is required');
  let session = await auth.sessionOrLogin(cc);
  let jwt = session.jwtToken;
  const headers = client.smartHeaders(cc.apiKey);

  const rows = await master.data();
  const symbol = String(req.symbol).toUpperCase();
  const expiry = String(req.expiry).toUpperCase();
  const exchange = segmentFor(symbol);

  const ce = new Map();
  const pe = new Map();
  let lotSize = 1;
  const futs = [];

  for (const row of rows) {
    if (row.n !== symbol || row.g !== exchange) continue;
    const sym = row.s;
    if (exchange === 'MCX' && sym.endsWith('FUT')) {
      futs.push({ token: row.t, expiryMs: parseExpiryMs(row.e) });
    }
    if (row.e !== expiry) continue;
    const strike = normalizeStrike(row.k, exchange);
    if (row.l > 0) lotSize = row.l;
    if (sym.endsWith('CE')) ce.set(strike, { token: row.t, tradingSymbol: sym });
    else if (sym.endsWith('PE')) pe.set(strike, { token: row.t, tradingSymbol: sym });
  }

  if (ce.size === 0 && pe.size === 0) {
    throw new Error(`No option tokens found for ${symbol} ${expiry}`);
  }

  let futToken = '';
  if (futs.length) {
    futs.sort((a, b) => a.expiryMs - b.expiryMs);
    const optMs = parseExpiryMs(expiry);
    futToken = futs[0].token;
    for (const f of futs) {
      if (f.expiryMs >= optMs) {
        futToken = f.token;
        break;
      }
    }
  }

  const strikes = unionStrikes(ce, pe);

  let spotExchange = '';
  let spotToken = '';
  if (SPOT_TOKENS[symbol]) {
    [spotExchange, spotToken] = SPOT_TOKENS[symbol];
  } else if (futToken) {
    spotExchange = exchange;
    spotToken = futToken;
  }

  let spot = strikes.length ? strikes[Math.floor(strikes.length / 2)] : 0;
  if (spotToken) {
    try {
      const r = await client.quote(headers, jwt, 'LTP', spotExchange, [spotToken]);
      const v = firstFetchedLTP(r);
      if (v > 0) spot = v;
    } catch {
      /* best-effort */
    }
  }

  let atm = strikes[0];
  for (const s of strikes) if (Math.abs(s - spot) < Math.abs(atm - spot)) atm = s;
  const atmIndex = Math.max(0, indexOf(strikes, atm));
  let side = req.window ? clampInt(req.window, 1, 30) : 12;
  const lo = Math.max(0, atmIndex - side);
  const hi = Math.min(strikes.length, atmIndex + side + 1);
  const finalStrikes = strikes.slice(lo, hi);

  const callTokens = new Array(finalStrikes.length).fill(null);
  const putTokens = new Array(finalStrikes.length).fill(null);
  const callSymbols = new Array(finalStrikes.length).fill(null);
  const putSymbols = new Array(finalStrikes.length).fill(null);
  const liveTokens = [];
  finalStrikes.forEach((s, i) => {
    const c = ce.get(s);
    if (c) {
      callTokens[i] = c.token;
      callSymbols[i] = c.tradingSymbol;
      liveTokens.push(c.token);
    }
    const p = pe.get(s);
    if (p) {
      putTokens[i] = p.token;
      putSymbols[i] = p.tradingSymbol;
      liveTokens.push(p.token);
    }
  });

  const chunks = chunkTokens(liveTokens, 50);
  let fetched = [];
  let greekRes = {};
  let liveErr = null;

  await Promise.all([
    ...chunks.map((chunk) =>
      client.quote(headers, jwt, 'FULL', exchange, chunk).then(
        (res) => {
          for (const r of fetchedList(res)) fetched.push(r);
        },
        (err) => {
          if (!liveErr) liveErr = err;
        }
      )
    ),
    client.doJSON('POST', '/rest/secure/angelbroking/marketData/v1/optionGreek', client.authHeaders(headers, jwt), {
      name: symbol,
      expirydate: expiry,
    }).then((r) => {
      greekRes = r;
    }).catch(() => {}),
  ]);

  // If any quote chunk failed (commonly a dead JWT), re-login once and refetch.
  if (liveErr) {
    const relogin = await auth.autoLogin(withoutSession(cc));
    session = relogin.session;
    jwt = session.jwtToken;
    fetched = [];
    for (const chunk of chunks) {
      const res = await client.quote(headers, jwt, 'FULL', exchange, chunk);
      for (const r of fetchedList(res)) fetched.push(r);
    }
  }

  const ceByToken = new Map();
  for (const [strike, c] of ce) ceByToken.set(c.token, strike);
  const peByToken = new Map();
  for (const [strike, p] of pe) peByToken.set(p.token, strike);

  const callOI = new Map();
  const putOI = new Map();
  const callLtp = new Map();
  const putLtp = new Map();
  const callClose = new Map();
  const putClose = new Map();
  for (const q of fetched) {
    const token = strOr(q.symbolToken, '');
    const oi = toFloat(q.opnInterest);
    const ltp = firstNonZero(q, 'ltp', 'lastTradePrice', 'lastPrice', 'close');
    const cl = firstNonZero(q, 'close', 'previousClose');
    if (ceByToken.has(token)) {
      const s = ceByToken.get(token);
      callOI.set(s, oi);
      callLtp.set(s, ltp);
      callClose.set(s, cl);
    }
    if (peByToken.has(token)) {
      const s = peByToken.get(token);
      putOI.set(s, oi);
      putLtp.set(s, ltp);
      putClose.set(s, cl);
    }
  }

  const callDelta = new Map();
  const putDelta = new Map();
  for (const g of fetchedGreeks(greekRes)) {
    const s = Math.trunc(toFloat(g.strikePrice));
    const ot = strOr(g.optionType, '');
    if (ot.includes('CE')) callDelta.set(s, toFloat(g.delta));
    if (ot.includes('PE')) putDelta.set(s, toFloat(g.delta));
  }

  const n = finalStrikes.length;
  const outCall = new Array(n).fill(0);
  const outPut = new Array(n).fill(0);
  const outCallLtp = new Array(n).fill(0);
  const outPutLtp = new Array(n).fill(0);
  const outCallClose = new Array(n).fill(0);
  const outPutClose = new Array(n).fill(0);
  const expCall = new Array(n).fill(0);
  const expPut = new Array(n).fill(0);
  let totalCall = 0;
  let totalPut = 0;
  finalStrikes.forEach((s, i) => {
    outCall[i] = callOI.get(s) || 0;
    outPut[i] = putOI.get(s) || 0;
    outCallLtp[i] = callLtp.get(s) || 0;
    outPutLtp[i] = putLtp.get(s) || 0;
    outCallClose[i] = callClose.get(s) || 0;
    outPutClose[i] = putClose.get(s) || 0;
    expCall[i] = Math.abs((callOI.get(s) || 0) * (callDelta.get(s) || 0));
    expPut[i] = Math.abs((putOI.get(s) || 0) * (putDelta.get(s) || 0));
    totalCall += outCall[i];
    totalPut += outPut[i];
  });
  const pcr = totalCall > 0 ? round2(totalPut / totalCall) : 0;

  return {
    status: true,
    symbol,
    expiry,
    spot,
    atm,
    pcr,
    strikes: finalStrikes,
    callOI: outCall,
    putOI: outPut,
    callLtp: outCallLtp,
    putLtp: outPutLtp,
    callClose: outCallClose,
    putClose: outPutClose,
    manipulatedCallOI: expCall,
    manipulatedPutOI: expPut,
    exchange,
    lotSize,
    callTokens,
    putTokens,
    callSymbols,
    putSymbols,
    liveTokens,
    spotToken: nilIfEmpty(spotToken),
    spotExchange: nilIfEmpty(spotExchange),
    feed: {
      jwtToken: jwt,
      feedToken: session.feedToken,
      apiKey: cc.apiKey,
      clientCode: cc.clientCode,
    },
    session,
  };
}

// resolveLeg resolves one option contract (token, tradingsymbol, lot size) for a
// (symbol, expiry, strike, side), snapping to the nearest strike, and fetches
// its live LTP/close.
export async function resolveLeg(client, auth, master, req) {
  const symbol = String(req.symbol).toUpperCase();
  const expiry = String(req.expiry).toUpperCase();
  const side = String(req.optionType || '').toUpperCase().endsWith('PE') ? 'PE' : 'CE';
  const want = Math.trunc(Number(req.strike) || 0);
  if (!symbol || !expiry || want === 0) {
    throw new Error('symbol, expiry and strike are required');
  }
  const exchange = segmentFor(symbol);

  const rows = await master.data();
  const cands = [];
  for (const row of rows) {
    if (row.n !== symbol || row.g !== exchange || row.e !== expiry) continue;
    if (!row.s.endsWith(side)) continue;
    const lot = row.l > 0 ? row.l : 1;
    cands.push({ strike: normalizeStrike(row.k, exchange), token: row.t, symbol: row.s, lotSize: lot });
  }
  if (cands.length === 0) {
    throw new Error(`No ${side} contracts for ${symbol} ${expiry}`);
  }

  let found = cands[0];
  let snapped = found.strike;
  let exact = false;
  for (const cd of cands) {
    if (cd.strike === want) {
      found = cd;
      snapped = cd.strike;
      exact = true;
      break;
    }
  }
  if (!exact) {
    let best = cands[0];
    for (const cd of cands) {
      if (Math.abs(cd.strike - want) < Math.abs(best.strike - want)) best = cd;
    }
    found = best;
    snapped = best.strike;
  }

  let ltp = null;
  let cl = null;
  let quoteErr = null;
  const session = resolveSession(req.client);
  if (!session || !session.jwtToken) {
    quoteErr = 'no session (log in to fetch price)';
  } else {
    const headers = client.smartHeaders(req.client.apiKey);
    try {
      const q = await client.quote(headers, session.jwtToken, 'FULL', exchange, [found.token]);
      const list = fetchedList(q);
      if (list.length > 0) {
        const raw = firstNonZero(list[0], 'ltp', 'lastTradePrice');
        const closeV = firstNonZero(list[0], 'close', 'previousClose');
        ltp = raw > 0 ? raw : closeV;
        if (closeV > 0) cl = closeV;
      } else {
        quoteErr = strOr(q.message, 'quote returned no rows');
      }
    } catch (err) {
      quoteErr = err.message;
    }
  }

  let changePct = null;
  if (ltp != null && cl != null && cl > 0) {
    changePct = round2(((ltp - cl) / cl) * 100);
  }

  return {
    status: true,
    token: found.token,
    tradingSymbol: found.symbol,
    exchange,
    lotSize: found.lotSize,
    strike: snapped,
    expiry,
    optionType: side,
    ltp,
    close: cl,
    changePct,
    quoteError: quoteErr,
  };
}
