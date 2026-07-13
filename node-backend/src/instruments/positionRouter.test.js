import test from 'node:test';
import assert from 'node:assert/strict';

import { BrokerInstrumentStore } from './store.js';
import { mapKotakPositionToAngelFeed } from './positionRouter.js';

function resolver(kotak = [], angel = []) {
  const store = new BrokerInstrumentStore('C:/tmp/admin-project-position-router-test-cache');
  store.set('kotak', kotak);
  store.set('angel', angel);
  return store;
}

test('Kotak option resolves to Angel by exchange, expiry, strike and CE/PE', () => {
  const canonical = 'NIFTY30JUL2625000CE';
  const instruments = resolver(
    [{
      symbol: canonical, exchange: 'NFO', brsymbol: 'NIFTY26JUL3025000C',
      brexchange: 'nse_fo', token: 'K-700', name: 'NIFTY', expiry: '2026-07-30',
      strike: 25000, optionType: 'CE', instrumentType: 'OPTIDX', lotsize: 75,
    }],
    [{
      symbol: canonical, exchange: 'NFO', brsymbol: 'NIFTY30JUL2625000CE',
      brexchange: 'NFO', token: 'A-900', name: 'NIFTY', expiry: '30JUL2026',
      strike: 25000, optionType: 'CE', instrumentType: 'CE', lotsize: 75,
    }],
  );

  const row = mapKotakPositionToAngelFeed({
    tradingsymbol: 'NIFTY26JUL3025000C', exSeg: 'nse_fo', netqty: 75,
  }, instruments);

  assert.equal(row.symboltoken, 'K-700');
  assert.equal(row.brokerToken, 'K-700');
  assert.equal(row.masterFeedToken, 'A-900');
  assert.equal(row.masterFeedExchange, 'NFO');
  assert.equal(row.masterFeedMapped, true);
  assert.equal(row.canonicalUnderlying, 'NIFTY');
  assert.equal(row.canonicalExpiry, '2026-07-30');
  assert.equal(row.canonicalStrike, 25000);
  assert.equal(row.canonicalOptionType, 'CE');
});

test('raw Kotak contract fields can resolve Angel when Kotak master lookup misses', () => {
  const instruments = resolver([], [{
    symbol: 'BANKNIFTY30JUL2655000PE', exchange: 'NFO',
    brsymbol: 'BANKNIFTY30JUL2655000PE', token: 'A-901', brexchange: 'NFO',
  }]);
  const row = mapKotakPositionToAngelFeed({
    trdSym: 'BANKNIFTY-OTHER-FORMAT', sym: 'BANKNIFTY', exSeg: 'nse_fo',
    expDt: '2026-07-30', stkPrc: '55000', optTp: 'PE', symboltoken: 'K-701',
  }, instruments);

  assert.equal(row.canonicalSymbol, 'BANKNIFTY30JUL2655000PE');
  assert.equal(row.masterFeedToken, 'A-901');
  assert.equal(row.symboltoken, 'K-701');
});

test('Kotak equity maps to Angel while preserving the Kotak trading token', () => {
  const instruments = resolver(
    [{
      symbol: 'AXISBANK', exchange: 'NSE', brsymbol: 'AXISBANK-EQ',
      brexchange: 'nse_cm', token: 'K-5900', name: 'AXISBANK',
    }],
    [{
      symbol: 'AXISBANK', exchange: 'NSE', brsymbol: 'AXISBANK-EQ',
      brexchange: 'NSE', token: 'A-5900', name: 'AXISBANK',
    }],
  );
  const row = mapKotakPositionToAngelFeed({
    tradingsymbol: 'AXISBANK-EQ', exSeg: 'nse_cm',
  }, instruments);

  assert.equal(row.symboltoken, 'K-5900');
  assert.equal(row.masterFeedToken, 'A-5900');
  assert.equal(row.canonicalExchange, 'NSE');
  assert.equal(row.canonicalInstrumentType, 'EQ');
});

test('an unmatched Angel contract never replaces the Kotak token', () => {
  const instruments = resolver([{
    symbol: 'NIFTY30JUL2626000PE', exchange: 'NFO', brsymbol: 'KOTAK-NIFTY-PE',
    brexchange: 'nse_fo', token: 'K-702', name: 'NIFTY', expiry: '2026-07-30',
    strike: 26000, optionType: 'PE', instrumentType: 'OPTIDX',
  }], []);
  const row = mapKotakPositionToAngelFeed({
    tradingsymbol: 'KOTAK-NIFTY-PE', exSeg: 'nse_fo',
  }, instruments);

  assert.equal(row.symboltoken, 'K-702');
  assert.equal(row.masterFeedToken, '');
  assert.equal(row.masterFeedMapped, false);
});

