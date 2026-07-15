import test from 'node:test';
import assert from 'node:assert/strict';

import { parseZerodhaContract } from './zerodha.js';

test('monthly option: year, month and full strike (the ambiguous case)', () => {
  // NIFTY26AUG24000PE = year 2026, AUG, strike 24000, PE - NOT "26 AUG 24 / 000".
  assert.deepEqual(parseZerodhaContract('NIFTY26AUG24000PE'), {
    name: 'NIFTY', expiry: 'AUG2026', strike: 24000, optionType: 'PE', instrumentType: 'PE',
  });
  assert.deepEqual(parseZerodhaContract('NIFTY26AUG24100PE'), {
    name: 'NIFTY', expiry: 'AUG2026', strike: 24100, optionType: 'PE', instrumentType: 'PE',
  });
  assert.deepEqual(parseZerodhaContract('NIFTY26JUL23950PE'), {
    name: 'NIFTY', expiry: 'JUL2026', strike: 23950, optionType: 'PE', instrumentType: 'PE',
  });
});

test('monthly option: months whose 3-letter name starts with a weekly code letter', () => {
  // OCT / NOV / DEC start with O / N / D - must still read as monthly, not weekly.
  assert.deepEqual(parseZerodhaContract('NIFTY26OCT24000CE'), {
    name: 'NIFTY', expiry: 'OCT2026', strike: 24000, optionType: 'CE', instrumentType: 'CE',
  });
  assert.deepEqual(parseZerodhaContract('BANKNIFTY26DEC52000PE'), {
    name: 'BANKNIFTY', expiry: 'DEC2026', strike: 52000, optionType: 'PE', instrumentType: 'PE',
  });
});

test('weekly option: single-char month + day gives an exact date', () => {
  assert.deepEqual(parseZerodhaContract('NIFTY2672124100PE'), {
    name: 'NIFTY', expiry: '2026-07-21', strike: 24100, optionType: 'PE', instrumentType: 'PE',
  });
  // O / N / D weekly month codes.
  assert.deepEqual(parseZerodhaContract('NIFTY26O0724000CE'), {
    name: 'NIFTY', expiry: '2026-10-07', strike: 24000, optionType: 'CE', instrumentType: 'CE',
  });
  assert.deepEqual(parseZerodhaContract('NIFTY26D3124000CE'), {
    name: 'NIFTY', expiry: '2026-12-31', strike: 24000, optionType: 'CE', instrumentType: 'CE',
  });
});

test('futures carry a monthly expiry and no strike/option type', () => {
  assert.deepEqual(parseZerodhaContract('NIFTY26AUGFUT'), {
    name: 'NIFTY', expiry: 'AUG2026', strike: '', optionType: '', instrumentType: 'FUT',
  });
});

test('equity and unrecognised symbols are left for the caller to keep as-is', () => {
  assert.equal(parseZerodhaContract('RELIANCE'), null);
  assert.equal(parseZerodhaContract('INFY'), null);
  assert.equal(parseZerodhaContract(''), null);
  assert.equal(parseZerodhaContract(null), null);
});
