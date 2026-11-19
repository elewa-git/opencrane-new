import { describe, expect, it } from 'vitest';
import { sameJson } from '../src/same-json.ts';

describe('sameJson', sameJsonCases);

function sameJsonCases() {
  it('ignores object key order at every depth', ignoresNestedObjectOrder);
  it('ignores key order in objects inside nested arrays', ignoresObjectOrderInArrays);
  it('preserves array order at every depth', preservesArrayOrder);
  it('treats undefined properties as missing at every depth', omitsUndefinedProperties);
  it('distinguishes null from missing and numbers from strings', distinguishesJsonTypes);
  it('preserves JSON array holes and non-finite number behaviour', preservesJsonArrayAndNumberRules);
  it('preserves toJSON behaviour', preservesToJson);
  it('does not lose object keys named __proto__', preservesPrototypeNamedKeys);
  it('keeps stringify errors for cyclic values and big integers', preservesStringifyErrors);
}

function ignoresNestedObjectOrder() {
  const left = { outer: { first: 1, second: { a: true, b: false } }, other: 2 };
  const right = { other: 2, outer: { second: { b: false, a: true }, first: 1 } };
  expect(sameJson(left, right)).toBe(true);
  expect(sameJson(right, left)).toBe(true);
}

function ignoresObjectOrderInArrays() {
  const left = [[{ a: 1, b: [{ c: 2, d: 3 }] }]];
  const right = [[{ b: [{ d: 3, c: 2 }], a: 1 }]];
  expect(sameJson(left, right)).toBe(true);
}

function preservesArrayOrder() {
  expect(sameJson([1, 2], [2, 1])).toBe(false);
  expect(sameJson({ list: [[{ a: 1 }, { a: 2 }]] },
    { list: [[{ a: 2 }, { a: 1 }]] })).toBe(false);
}

function omitsUndefinedProperties() {
  expect(sameJson({ a: undefined, nested: { b: undefined } }, { nested: {} })).toBe(true);
  expect(sameJson([{ a: undefined }], [{}])).toBe(true);
}

function distinguishesJsonTypes() {
  expect(sameJson({ a: null }, {})).toBe(false);
  expect(sameJson(1, '1')).toBe(false);
  expect(sameJson(null, undefined)).toBe(false);
  expect(sameJson(null, null)).toBe(true);
  expect(sameJson(undefined, undefined)).toBe(true);
}

function preservesJsonArrayAndNumberRules() {
  expect(sameJson([undefined], [null])).toBe(true);
  expect(sameJson(Array(1), [null])).toBe(true);
  expect(sameJson(NaN, null)).toBe(true);
  expect(sameJson(Infinity, null)).toBe(true);
  expect(sameJson(-0, 0)).toBe(true);
}

function preservesToJson() {
  expect(sameJson(new Date('2026-11-12T00:00:00Z'), '2026-11-12T00:00:00.000Z')).toBe(true);
}

function preservesPrototypeNamedKeys() {
  const value: unknown = JSON.parse('{"__proto__":{"x":1},"a":2}');
  const reordered: unknown = JSON.parse('{"a":2,"__proto__":{"x":1}}');
  expect(sameJson(value, reordered)).toBe(true);
  expect(sameJson(value, { a: 2 })).toBe(false);
}

function preservesStringifyErrors() {
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  function compareCyclic() {
    return sameJson(cyclic, {});
  }
  function compareBigInteger() {
    return sameJson(1n, 1);
  }
  expect(compareCyclic).toThrow(TypeError);
  expect(compareBigInteger).toThrow(TypeError);
}
