// Historical OHLC candle data, used to reconcile a leg's price on a PAST date
// instead of a live feed tick. Port of the same session/re-login pattern as
// orders.js's book()/getMargin().
import { withoutSession } from './auth.js';
import { isAuthFailure } from './httpClient.js';

const CANDLE_PATH = '/rest/secure/angelbroking/historical/v1/getCandleData';

export async function getHistoricalCandle(client, auth, cc, req) {
  const symboltoken = req.symboltoken != null ? String(req.symboltoken) : '';
  if (!symboltoken) throw new Error('symboltoken is required');

  const body = {
    exchange: req.exchange || 'NFO',
    symboltoken,
    interval: req.interval || 'ONE_DAY',
    fromdate: req.fromdate,
    todate: req.todate,
  };

  let session = await auth.sessionOrLogin(cc).catch(() => {
    throw new Error('Angel session unavailable for historical data');
  });
  const headers = client.smartHeaders(cc.apiKey);

  let result;
  try {
    result = await client.doJSON('POST', CANDLE_PATH, client.authHeaders(headers, session.jwtToken), body);
  } catch (err) {
    // Only a dead token earns a fresh login - a throttle (403) does not.
    if (!isAuthFailure(err)) throw err;
    const relogin = await auth.autoLogin(withoutSession(cc)).catch(() => null);
    if (!relogin) throw err;
    session = relogin.session;
    result = await client.doJSON('POST', CANDLE_PATH, client.authHeaders(headers, session.jwtToken), body);
  }

  return { status: true, candles: result.data || [], session };
}
