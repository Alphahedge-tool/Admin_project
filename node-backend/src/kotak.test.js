import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkMargin, limits, normalizeKotakOrder, normalizeKotakPosition, normalizeKotakTrade, orderBook,
  positions, tradeBook,
} from './kotak.js';
import { normalizeKotakStreamMessage, realtimeUrl } from './kotakUserStream.js';
import {
  hsmConnectionFrame, hsmSubscriptionFrame, hsmSubscriptionFrames,
} from './kotakHsmFeed.js';

test('normalizes a Kotak order for the shared order-book UI', () => {
  const row = normalizeKotakOrder({
    nOrdNo: '250720000007242', ordSt: 'rejected', trdSym: 'ITBEES-EQ',
    qty: 10, fldQty: 3, prc: '20.50', avgPrc: '20.25', trnsTp: 'S',
    prcTp: 'L', exSeg: 'nse_cm', rejRsn: 'Adapter unavailable',
  });
  assert.equal(row.orderid, '250720000007242');
  assert.equal(row.transactiontype, 'SELL');
  assert.equal(row.ordertype, 'LIMIT');
  assert.equal(row.exchange, 'NSE');
  assert.equal(row.unfilledshares, 7);
  assert.equal(row.text, 'Adapter unavailable');
});

test('normalizes a Kotak trade for the shared trade-book UI', () => {
  const row = normalizeKotakTrade({
    nOrdNo: '221007000000354', trdSym: 'TCS-EQ', qty: 11, fldQty: 11,
    avgPrc: '3194.00', trnsTp: 'B', exSeg: 'nse_cm', exTm: '10:15:30',
  });
  assert.equal(row.transactiontype, 'BUY');
  assert.equal(row.fillsize, 11);
  assert.equal(row.fillprice, 3194);
  assert.equal(row.tradevalue, 35134);
  assert.equal(row.filltime, '10:15:30');
});

test('normalizes Kotak positions for the shared net-positions UI', () => {
  const row = normalizeKotakPosition({
    prod: 'CNC', exSeg: 'nse_cm', trdSym: 'AXISBANK-EQ', sym: 'AXISBANK',
    qty: '9', buyAmt: '5862.90', sellAmt: '0.00', flBuyQty: '9',
    flSellQty: '0', lotSz: '1', hsUpTm: '2022/06/21 15:11:02',
  });
  assert.equal(row.netqty, 9);
  assert.equal(row.totalbuyqty, 9);
  assert.equal(row.totalbuyavgprice, 651.4333333333333);
  assert.equal(row.exchange, 'NSE');
  assert.equal(row.producttype, 'CNC');
});

test('calls Kotak position and limits APIs with the documented session headers and form body', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(options.method === 'GET'
      ? { stat: 'Ok', data: [] }
      : { stat: 'Ok', Net: '1000', MarginUsed: '25' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = { session: { baseUrl: 'https://example.test/', sid: 'SID1', tradeToken: 'TOKEN1' } };
  try {
    await positions(client);
    const limitResult = await limits(client, {});
    assert.equal(limitResult.limits.availableCash, 1000);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests[0].url, 'https://example.test/quick/user/positions');
  assert.equal(requests[0].options.headers.Sid, 'SID1');
  assert.equal(requests[0].options.headers.Auth, 'TOKEN1');
  assert.equal(requests[1].url, 'https://example.test/quick/user/limits');
  assert.equal(requests[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(new URLSearchParams(requests[1].options.body).get('jData')), {
    seg: 'ALL', exch: 'ALL', prod: 'ALL',
  });
});

// Kotak answers an account that holds nothing with HTTP 200 and
// {stCode:5203, errMsg:"No Data", stat:"Not_Ok"}. That is an empty book, not a
// failure - reading it as one meant a flat account could not load its positions,
// orders or trades at all, and the position sync failed on it too.
test('an empty Kotak book reads back as an empty list, not an error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ stCode: 5203, errMsg: 'No Data', desc: 'data not found', stat: 'Not_Ok' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
  const client = { session: { baseUrl: 'https://example.test', sid: 'SID1', tradeToken: 'TOKEN1' } };
  try {
    assert.deepEqual((await positions(client)).positions, []);
    assert.deepEqual((await orderBook(client)).orders, []);
    assert.deepEqual((await tradeBook(client)).trades, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// A genuine failure must still surface, and must say what Kotak actually said -
// the message lives in `errMsg`, and reading `emsg` turned every one of them
// into a bare "Kotak HTTP 200".
test('a real Kotak error surfaces its own message', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ stCode: 5001, errMsg: 'Invalid Session', stat: 'Not_Ok' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
  const client = { session: { baseUrl: 'https://example.test', sid: 'SID1', tradeToken: 'TOKEN1' } };
  try {
    await assert.rejects(positions(client), /Invalid Session/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('maps shared order fields into the Kotak check-margin request', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ stat: 'Ok', avlCash: '5000', reqdMrgn: '125' }), { status: 200 });
  };
  try {
    const result = await checkMargin({
      session: { baseUrl: 'https://example.test', sid: 'SID1', tradeToken: 'TOKEN1' },
    }, {
      exchange: 'NSE', price: 125, orderType: 'LIMIT', productType: 'CNC',
      quantity: 1, token: '11536', side: 'BUY',
    });
    assert.equal(result.margin.requiredMargin, 125);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const body = JSON.parse(new URLSearchParams(request.options.body).get('jData'));
  assert.deepEqual(body, {
    brkName: 'KOTAK', brnchId: 'ONLINE', exSeg: 'nse_cm', prc: '125',
    prcTp: 'L', prod: 'CNC', qty: '1', tok: '11536', trnsTp: 'B',
  });
});

test('normalizes Kotak HSI order and position events', () => {
  const order = normalizeKotakStreamMessage({
    type: 'order',
    data: { nOrdNo: '123', ordSt: 'complete', sym: 'ITBEES', fldQty: 1, trnsTp: 'B' },
  });
  assert.equal(order.event, 'order');
  assert.equal(order.data.orderid, '123');
  assert.equal(order.data.orderstatus, 'complete');

  const position = normalizeKotakStreamMessage({
    type: 'position',
    data: { sym: 'ITBEES', flBuyQty: '2', flSellQty: '1', exSeg: 'nse_cm' },
  });
  assert.equal(position.event, 'position');
  assert.equal(position.data.netqty, 1);
  assert.equal(position.data.exchange, 'NSE');
  assert.equal(realtimeUrl({ dataCenter: 'E43' }), 'wss://e43.kotaksecurities.com/realtime');
});

test('encodes Kotak HSM connection and batched subscription frames', () => {
  const connection = hsmConnectionFrame('TOKEN1', 'SID1');
  assert.equal(connection.readUInt16BE(0), connection.length - 2);
  assert.equal(connection.readUInt8(2), 1);
  assert.ok(connection.includes(Buffer.from('TOKEN1')));
  assert.ok(connection.includes(Buffer.from('SID1')));
  assert.ok(connection.includes(Buffer.from('JS_API')));

  const item = { segment: 'nse_cm', token: '11536' };
  const subscription = hsmSubscriptionFrame([item]);
  assert.equal(subscription.readUInt8(2), 4);
  assert.ok(subscription.includes(Buffer.from('sf|nse_cm|11536')));

  const items = Array.from({ length: 101 }, (_, index) => ({ segment: 'nse_cm', token: String(index + 1) }));
  const frames = hsmSubscriptionFrames(items);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].at(-1), 1);
  assert.equal(frames[1].at(-1), 2);
});
