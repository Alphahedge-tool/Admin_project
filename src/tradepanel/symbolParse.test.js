import test from 'node:test';
import assert from 'node:assert/strict';

import { contractMeta, expiryDate } from './symbolParse.js';

test('contractMeta keeps a plain underlying root when the broker also sends a full option symbol', () => {
  const parsed = contractMeta({
    tradingsymbol: 'NIFTY26JUL22350PE',
    symbolname: 'NIFTY26JUL22350PE',
    stock_name: 'NIFTY',
    expirydate: '26 Jul 2022',
    strikeprice: '350',
    optiontype: 'PE',
  });

  assert.equal(parsed.root, 'NIFTY');
  assert.equal(parsed.expiry, '26 Jul 2022');
  assert.equal(parsed.strike, '350');
  assert.equal(parsed.optionType, 'PE');
});

test('contractMeta can derive a contract from stock_name when that is the only symbol field', () => {
  const parsed = contractMeta({
    stock_name: 'NIFTY26JUL22350PE',
  });

  assert.equal(parsed.root, 'NIFTY');
  assert.equal(parsed.expiry, '26 Jul 22');
  assert.equal(parsed.strike, '350');
  assert.equal(parsed.optionType, 'PE');
});

test('contractMeta reads a Kotak-monthly symbol with Kotak grammar (year+month+strike, no day)', () => {
  const parsed = contractMeta({
    trading_symbol: 'NIFTY26JUL22350PE',
    broker_name: 'Kotak Neo',
  });

  assert.equal(parsed.root, 'NIFTY');
  assert.equal(parsed.expiry, 'Jul 2026'); // NOT "26 Jul 22"
  assert.equal(parsed.strike, '22350');    // NOT "350"
  assert.equal(parsed.optionType, 'PE');
});

test('contractMeta reads a Zerodha-monthly symbol with the same year-first grammar as Kotak', () => {
  const parsed = contractMeta({
    trading_symbol: 'NIFTY26JUL24000CE',
    broker_name: 'Zerodha',
  });

  assert.equal(parsed.root, 'NIFTY');
  assert.equal(parsed.expiry, 'Jul 2026'); // NOT "26 Jul 24"
  assert.equal(parsed.strike, '24000');    // NOT "000"
  assert.equal(parsed.optionType, 'CE');
});

test('contractMeta keeps the Angel reading of the same string when the broker is not Kotak', () => {
  const parsed = contractMeta({ trading_symbol: 'NIFTY26JUL22350PE' });
  assert.equal(parsed.expiry, '26 Jul 22');
  assert.equal(parsed.strike, '350');

  const angel = contractMeta({ trading_symbol: 'NIFTY26JUL22350PE', broker_name: 'Angel One' });
  assert.equal(angel.expiry, '26 Jul 22');
  assert.equal(angel.strike, '350');
});

test('expiryDate reads a Kotak-monthly symbol as living to that month-end, not a 2022 expiry', () => {
  const d = expiryDate({ tradingsymbol: 'NIFTY26JUL22350PE', broker_name: 'Kotak Neo' });
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 6);   // July
  assert.equal(d.getDate(), 31);   // last day of the month
});

test('expiryDate parses the Angel compact form (14JUL2026)', () => {
  const d = expiryDate({ expiry: '14JUL2026' });
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 6);
  assert.equal(d.getDate(), 14);
});

test('expiryDate parses ISO and Kotak spaced forms', () => {
  assert.equal(expiryDate({ expiry_date: '2026-07-14' }).getDate(), 14);
  const kotak = expiryDate({ expiry: '28 Jul, 2026' });
  assert.equal(kotak.getMonth(), 6);
  assert.equal(kotak.getDate(), 28);
});

test('expiryDate treats a month-only monthly as the last day of that month', () => {
  const d = expiryDate({ expiry: 'AUG2026' });
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 31);
});

test('expiryDate falls back to the trading symbol when no explicit field is set', () => {
  const d = expiryDate({ tradingsymbol: 'NIFTY26JUL22350PE' });
  assert.equal(d.getFullYear(), 2022);
  assert.equal(d.getMonth(), 6);
  assert.equal(d.getDate(), 26);
});

test('expiryDate returns null when there is no readable expiry', () => {
  assert.equal(expiryDate({ tradingsymbol: 'NIFTY' }), null);
  assert.equal(expiryDate({}), null);
});

