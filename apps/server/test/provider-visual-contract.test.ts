import { expect, it } from 'vitest';
import { acceptsProviderVerification } from './support/provider-verification-fixture.ts';

const common = { commandId: 'fixture-command', expectedRevision: 2 };
const testBody = { ...common, action: 'test', model: 'gpt-6.1-sol', priceTableId: 'price-one',
  reservedCents: 1, consent: true };
const refusedBodies = [
  { ...common, action: 'reachability', providerId: 'one' },
  { ...common, action: 'reachability', extra: true },
  { ...common, action: 'reachability', expectedRevision: 0 },
  { ...testBody, consent: false },
  { ...testBody, model: undefined },
  { ...testBody, reservedCents: 0.1 },
  { ...testBody, reservedCents: -1 },
  { ...testBody, action: 'skip' },
  { ...common, action: 'something_else' },
];

it.each(refusedBodies)('rejects a visual fixture body the real route refuses: %#', body => {
  expect(acceptsProviderVerification(body, 'one')).toBe(false);
});

it.each(['reachability', 'skip'])('accepts the real %s request body', action => {
  const body = { ...common, action };
  expect(acceptsProviderVerification(body, 'one')).toBe(true);
});

it('accepts the real priced test shape without making any request', () => {
  expect(acceptsProviderVerification(testBody, 'one')).toBe(true);
});
