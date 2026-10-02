import { expect, it } from 'vitest';
import { costCents, reservationCents, models } from '../src/index.ts';

it('prices Astra short context in whole euro cents at the pinned planning FX', () => {
  // 100k input ($1) + 100k output ($5), at EUR 0.95/USD = 570 cents.
  expect(costCents('gpt-6-astra', 100_000, 100_000)).toBe(570);
});

it('charges reported cached tokens at the cached rate and selects the tier from total input', () => {
  // All 100k input cached ($0.10) + 100k output ($5) = 484.5 euro cents.
  expect(costCents('gpt-6-astra', 100_000, 100_000, 100_000)).toBe(485);
  expect(costCents('gpt-6-astra', 272_000, 0)).toBe(259);
  expect(costCents('gpt-6-astra', 272_001, 0)).toBe(517);
  expect(costCents('gpt-6-astra', 272_001, 0, 272_001)).toBe(52);
});

// Worked from the owner's USD table and the pinned EUR 0.95/USD tariff.
it.each([
  ['gpt-6-astra', 570, 1283, 10, 57, 119, 713],
  ['gpt-6.1-sol', 114, 257, 1, 6, 24, 143],
  ['gpt-6-luna', 6, 13, 1, 1, 2, 8],
  ['gpt-6-sol', 114, 257, 2, 12, 24, 143],
  ['gpt-5.6-sol', 228, 513, 4, 23, 48, 285],
  ['gpt-5.6-terra', 133, 285, 2, 12, 24, 143],
  ['gpt-5.6-luna', 14, 29, 1, 2, 3, 15],
  ['gpt-5.5', 333, 713, 5, 29, null, null],
  ['gpt-5.5-pro', 1995, 4275, null, null, null, null],
  ['gpt-5.4', 167, 357, 3, 15, null, null],
  ['gpt-5.4-pro', 1995, 4275, null, null, null, null],
] as const)('prices %s in both tiers, including supported cache reads/writes', (model, short, long, cachedShort, cachedLong, writeShort, writeLong) => {
  expect(costCents(model, 100_000, 100_000)).toBe(short);
  expect(costCents(model, 300_000, 100_000)).toBe(long);
  if (cachedShort !== null) {
    expect(costCents(model, 100_000, 0, 100_000)).toBe(cachedShort);
    expect(costCents(model, 300_000, 0, 300_000)).toBe(cachedLong);
  } else expect(() => costCents(model, 100_000, 0, 100_000)).toThrow('Unsupported cache usage');
  if (writeShort !== null) {
    expect(costCents(model, 100_000, 0, 0, 100_000)).toBe(writeShort);
    expect(costCents(model, 300_000, 0, 0, 300_000)).toBe(writeLong);
  } else expect(() => costCents(model, 100_000, 0, 0, 100_000)).toThrow('Unsupported cache usage');
});
it('refuses unknown/removed models and invalid usage, and rounds once per call', () => {
  expect(models).toHaveLength(11);
  for (const model of ['unknown', 'gpt-5-nano', 'gpt-5-mini']) {
    expect(() => costCents(model, 1, 1)).toThrow('Unknown model');
    expect(() => reservationCents(model, 1)).toThrow('Unknown model');
  }
  for (const count of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => costCents('gpt-6-luna', count, 1)).toThrow('Invalid usage');
    expect(() => reservationCents('gpt-6-luna', count)).toThrow('Invalid bound');
  }
  expect(() => costCents('gpt-6-luna', 1, 0, 2)).toThrow('Invalid usage');
  expect(() => costCents('gpt-6-luna', 1, 0, 1, 1)).toThrow('Invalid usage');
  expect(costCents('gpt-6-luna', 1, 1)).toBe(1);
  expect(costCents('gpt-6-luna', 0, 0)).toBe(0);
});
it('reserves long rates without a proven bound and covers cache writes as well as output', () => {
  expect(reservationCents('gpt-6-astra', 128)).toBe(2495);
  expect(reservationCents('gpt-6-astra', 2000)).toBe(2508);
  expect(reservationCents('gpt-6-astra', 100_000, 100_000)).toBe(594);
  expect(reservationCents('gpt-6-astra', 0, 272_000)).toBe(323);
  expect(reservationCents('gpt-6-astra', 0, 272_001)).toBe(647);
});
