import { expect, it } from 'vitest';
import { z } from 'zod';
import { memoryMaintenanceRecordedDataSchema } from '../src/memory.ts';
import { getEventDefinition } from '../src/registry.ts';
import { record } from './record.ts';

function integerCap() {
  const options = { io: 'input' } as const;
  const schema = z.toJSONSchema(memoryMaintenanceRecordedDataSchema, options);
  const properties = record(schema['properties']);
  const acceptedCap = record(properties['acceptedCapCents']);
  const expected = { type: 'integer', minimum: 0 };
  expect(acceptedCap).toMatchObject(expected);
}
it('declares the nightly cap as whole, non-negative euro cents', integerCap);

function exactCap() {
  const definition = getEventDefinition('memory.maintenance_recorded');
  if (!definition) {
    throw new Error('Missing nightly memory event');
  }
  const example = record(definition.example);
  const accepted = memoryMaintenanceRecordedDataSchema.safeParse(example);
  expect(accepted.success).toBe(true);
  const invalidAmounts = [99, 101, 0, -1, 1.5, 2 ** 53, Number.NaN,
    Number.POSITIVE_INFINITY, '100'];
  for (const acceptedCapCents of invalidAmounts) {
    const invalid = { ...example, acceptedCapCents };
    const parsed = memoryMaintenanceRecordedDataSchema.safeParse(invalid);
    expect(parsed.success).toBe(false);
  }
}
it('accepts only the fixed 100-cent nightly cap', exactCap);
