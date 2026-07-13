import test from 'node:test';
import assert from 'node:assert/strict';

import { BrokerInstrumentStore } from './store.js';
import { canonicalSymbol } from './symbol.js';
import { normalizeAngelRows, normalizeKotakFiles, normalizeZerodhaRows } from './loaders.js';

test('all three brokers normalize the same option to one canonical symbol', () => {
  const canonical = canonicalSymbol({ name: 'NIFTY', expiry: '30JUL2026', strike: 25000, type: 'CE' });
  const angel = normalizeAngelRows([{
    t: 'ANGEL-1', s: 'NIFTY30JUL2625000CE', n: 'NIFTY', e: '30JUL2026', k: 2500000, g: 'NFO', l: 75,
  }])[0];

  const rawKotakExpiry = (Date.parse('2026-07-30T00:00:00Z') / 1000) - 315_511_200;
  const kotak = normalizeKotakFiles([{
    url: 'https://example.test/nse_fo.csv',
    text: [
      'pSymbol,pTrdSymbol,pSymbolName,pExpiryDate,dStrikePrice;,pOptionType,pInstType,lLotSize,dTickSize',
      `KOTAK-2,NIFTY30JUL2625000CE,NIFTY,${rawKotakExpiry},2500000,CE,OPTIDX,75,0.05`,
    ].join('\n'),
  }])[0];

  const zerodha = normalizeZerodhaRows([{
    instrument_token: 'ZERODHA-3', exchange_token: '33', tradingsymbol: 'NIFTY30JUL2625000CE',
    name: 'NIFTY', expiry: '2026-07-30', strike: '25000', tick_size: '0.05', lot_size: '75',
    instrument_type: 'CE', segment: 'NFO-OPT', exchange: 'NFO',
  }])[0];

  assert.equal(angel.symbol, canonical);
  assert.equal(kotak.symbol, canonical);
  assert.equal(zerodha.symbol, canonical);
  assert.equal(kotak.brexchange, 'nse_fo');
  assert.equal(zerodha.brexchange, 'NFO');
});

test('store resolves the selected broker token instead of another broker token', () => {
  const store = new BrokerInstrumentStore('C:/tmp/admin-project-instrument-test-cache');
  const symbol = 'NIFTY30JUL2625000CE';
  store.set('angel', [{ symbol, exchange: 'NFO', token: 'A1', brsymbol: symbol }]);
  store.set('kotak', [{ symbol, exchange: 'NFO', token: 'K2', brsymbol: symbol, brexchange: 'nse_fo' }]);
  store.set('zerodha', [{ symbol, exchange: 'NFO', token: 'Z3', brsymbol: symbol, brexchange: 'NFO' }]);
  assert.equal(store.resolve('angel', symbol, 'NFO').token, 'A1');
  assert.equal(store.resolve('kotak', symbol, 'NFO').token, 'K2');
  assert.equal(store.resolve('zerodha', symbol, 'NFO').token, 'Z3');
});

test('store resolves a broker-native symbol and segment from report rows', () => {
  const store = new BrokerInstrumentStore('C:/tmp/admin-project-broker-symbol-test-cache');
  store.set('kotak', [{
    symbol: 'AXISBANK', exchange: 'NSE', brsymbol: 'AXISBANK-EQ',
    brexchange: 'nse_cm', token: '5900',
  }]);
  assert.equal(store.resolveBroker('kotak', 'AXISBANK-EQ', 'nse_cm')?.token, '5900');
  assert.equal(store.resolveBroker('kotak', 'AXISBANK-EQ', 'NSE')?.symbol, 'AXISBANK');
});
