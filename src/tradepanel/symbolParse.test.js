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

