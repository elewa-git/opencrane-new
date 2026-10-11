import { expect, it } from 'vitest';
import { z } from 'zod';
import { memoryMaintenanceBoundDataSchema } from '@opencrane/events';

const binding = {
  scopeId: 'a'.repeat(64),
  scopeKind: 'person',
  ownerId: 'alice',
  memberId: 'alice',
  assistantId: 'alice-assistant',
  payingGroupId: 'sales',
  enabled: true,
  acceptedCapCents: 100,
  revision: 1,
};

function exportsIntegerCents() {
  const schema = z.toJSONSchema(memoryMaintenanceBoundDataSchema, { io: 'input' });
  expect(schema.properties?.['acceptedCapCents']).toMatchObject({
    type: 'integer',
    minimum: 0,
  });
}
it('exports the accepted nightly cap as non-negative integer cents', exportsIntegerCents);

function acceptsExactlyOneHundredCents() {
  const parsed = memoryMaintenanceBoundDataSchema.parse(binding);
  expect(parsed.acceptedCapCents).toBe(100);
}
it('accepts an explicit nightly cap of exactly 100 cents', acceptsExactlyOneHundredCents);

function refusesOtherCaps(acceptedCapCents: unknown) {
  const input = { ...binding, acceptedCapCents };
  const result = memoryMaintenanceBoundDataSchema.safeParse(input);
  expect(result.success).toBe(false);
}
const refusedCaps = [
  undefined, 0, 99, 101, 100.5, -1, Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, '100',
];
it.each(refusedCaps)('refuses the nightly cap %s', refusesOtherCaps);
