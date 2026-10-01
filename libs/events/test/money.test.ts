// Money is integer euro cents everywhere (owner decision 8): every amount in an
// event is a whole, non-negative number of cents, and its name ends in `Cents`
// (costCents, ceilingCents), never a float in euros and never "MinorUnits".
//
// Two kinds of test. The first checks the real amount fields one by one. The
// second runs over every schema in the registry, so a new event type, or a new
// field on an old one, is held to the same rule without anyone remembering to
// add a test; the last describe proves those registry-wide checks work by adding
// one bad field to a real event type and expecting it to be caught.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { centsSchema } from '../src/data.ts';
import { eventRegistry, getEventDefinition } from '../src/registry.ts';

function definitionFor(type: string) {
  const definition = getEventDefinition(type);
  if (!definition) {
    throw new Error(`no such event type: ${type}`);
  }
  return definition;
}

/**
 * Parses the type's valid example with one field set to `value` and returns
 * the names of the fields the schema rejected, or [] if it accepted the data.
 */
function rejectedFields(type: string, field: string, value: unknown): string[] {
  const { dataSchema, example } = definitionFor(type);
  expect(dataSchema.safeParse(example).success).toBe(true); // so any failure below is the patch's
  const result = dataSchema.safeParse({ ...(example as Record<string, unknown>), [field]: value });
  return result.success ? [] : [...new Set(result.error.issues.map((issue) => String(issue.path[0])))].sort();
}

describe('amounts are whole euro cents', () => {
  it.each([
    ['effect.observed', 'costCents'],
    ['budget.ceiling_set', 'ceilingCents'],
    ['budget.reserved', 'amountCents'],
    ['budget.settled', 'settledCents'],
  ])('%s counts %s in integer cents', (type, field) => {
    expect(rejectedFields(type, field, 0.1 + 0.2)).toEqual([field]); // a float in euros is exactly the bug
    expect(rejectedFields(type, field, 1.5)).toEqual([field]);
    expect(rejectedFields(type, field, -1)).toEqual([field]);
    expect(rejectedFields(type, field, 2 ** 53)).toEqual([field]); // too big to add up exactly
    expect(rejectedFields(type, field, Number.NaN)).toEqual([field]);
    expect(rejectedFields(type, field, Number.POSITIVE_INFINITY)).toEqual([field]);
    expect(rejectedFields(type, field, '150')).toEqual([field]); // a number, not text
    expect(rejectedFields(type, field, 0)).toEqual([]);
    expect(rejectedFields(type, field, 150)).toEqual([]); // 150 cents = EUR 1.50
    expect(rejectedFields(type, field, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });
});

// Every declared property at any depth, as [name, its JSON Schema].
function declaredProperties(node: unknown, found: Array<[string, unknown]> = []): Array<[string, unknown]> {
  if (Array.isArray(node)) {
    for (const item of node) declaredProperties(item, found);
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'properties' && typeof value === 'object' && value !== null) {
        found.push(...Object.entries(value));
      }
      declaredProperties(value, found);
    }
  }
  return found;
}

function acceptedShape(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { io: 'input' });
}

// Words that mean money when they appear in a field name. A name with one of
// them must end in `Cents`, unless it is an id (`rootBudgetId` names a budget,
// it is not an amount). Names are split into words ignoring case and
// camelCase or snake_case spelling, so `cost_eur` and `amountMinorUnits` are caught.
const MONEY_WORDS = new Set([
  'eur', 'euro', 'euros', 'minor', 'units', 'cost', 'price', 'amount', 'fee', 'spend', 'spent',
  'charge', 'budget', 'ceiling', 'limit', 'reserved', 'settled', 'balance', 'total',
]);
function moneyFieldsNotInCents(jsonSchema: unknown): string[] {
  return declaredProperties(jsonSchema)
    .map(([name]) => name)
    .filter((name) => {
      const words = name.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase().split('_');
      const last = words[words.length - 1];
      return words.some((word) => MONEY_WORDS.has(word)) && last !== 'cents' && last !== 'id';
    });
}

// A `...Cents` field must be an integer that cannot go below zero. A plain
// number (a float), an integer with no lower bound or a string is wrong.
function centsFieldsWithWrongShape(jsonSchema: unknown): string[] {
  return declaredProperties(jsonSchema)
    .filter(([name]) => name.endsWith('Cents'))
    .filter(([, schema]) => {
      const shape = schema as { type?: unknown; minimum?: unknown };
      return !(shape.type === 'integer' && shape.minimum === 0);
    })
    .map(([name]) => name);
}

const typesCarryingCents = eventRegistry
  .filter((entry) => declaredProperties(acceptedShape(entry.dataSchema)).some(([name]) => name.endsWith('Cents')))
  .map((entry) => entry.type);

describe('every event schema in the registry', () => {
  it('finds the event types that carry an amount, so the checks below do not run over nothing', () => {
    expect(typesCarryingCents).toEqual(
      expect.arrayContaining(['effect.observed', 'budget.ceiling_set', 'budget.reserved', 'budget.settled']),
    );
  });

  it('declares no money field that is not named in cents', () => {
    for (const entry of eventRegistry) {
      expect(moneyFieldsNotInCents(acceptedShape(entry.dataSchema)), entry.type).toEqual([]);
    }
  });

  it('makes every ...Cents field a whole, non-negative number', () => {
    for (const type of typesCarryingCents) {
      expect(centsFieldsWithWrongShape(acceptedShape(definitionFor(type).dataSchema)), type).toEqual([]);
    }
  });
});

// Each case adds one field to a real event type's schema and expects the check
// to catch it.
describe('the money checks catch a bad field added to a real event type', () => {
  function withField(type: string, name: string, schema: z.ZodType): z.ZodType {
    const base = definitionFor(type).dataSchema;
    if (!(base instanceof z.ZodObject)) {
      throw new Error(`${type} is not a plain object schema`);
    }
    return base.extend({ [name]: schema });
  }

  it.each(['costEur', 'amountMinorUnits', 'cost_eur', 'priceEur', 'price', 'totalAmount', 'limit', 'balance', 'feeEuros'])(
    'effect.observed refuses an amount field named "%s"',
    (name) => {
      expect(moneyFieldsNotInCents(acceptedShape(withField('effect.observed', name, z.number())))).toEqual([name]);
    },
  );

  it.each(['rootBudgetId', 'reservationId', 'payingGroupId', 'toolCount'])('still allows the harmless name "%s"', (name) => {
    expect(moneyFieldsNotInCents(acceptedShape(z.object({ [name]: z.string() }).strict()))).toEqual([]);
  });

  it.each<[shape: string, schema: z.ZodType]>([
    ['a float', z.number()],
    ['a float with a lower bound', z.number().nonnegative()],
    ['an integer with no lower bound', z.int()],
    ['a negative-only integer', z.int().max(-1)],
    ['a string', z.string()],
    ['a number or a string', z.union([z.int().nonnegative(), z.string()])],
  ])('budget.reserved refuses a "taxCents" field that is %s', (_shape, schema) => {
    expect(centsFieldsWithWrongShape(acceptedShape(withField('budget.reserved', 'taxCents', schema)))).toEqual(['taxCents']);
  });

  it('accepts the real schemas and a new whole, non-negative amount, so the cases above fail only because of the added field', () => {
    for (const type of typesCarryingCents) {
      expect(centsFieldsWithWrongShape(acceptedShape(definitionFor(type).dataSchema)), type).toEqual([]);
    }
    expect(centsFieldsWithWrongShape(acceptedShape(withField('budget.reserved', 'taxCents', centsSchema)))).toEqual([]);
  });
});
