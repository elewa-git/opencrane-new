import { describe, expect, it } from 'vitest';
import { sameJson } from '../src/same-json.ts';

describe('sameJson', () => {
  it('ignores object key order at every depth', () => {
    const left = { outer: { first: 1, second: { a: true, b: false } }, other: 2 };
    const right = { other: 2, outer: { second: { b: false, a: true }, first: 1 } };
    expect(sameJson(left, right)).toBe(true);
    expect(sameJson(right, left)).toBe(true);
  });

  it('ignores key order in objects inside nested arrays', () => {
    const left = [[{ a: 1, b: [{ c: 2, d: 3 }] }]];
    const right = [[{ b: [{ d: 3, c: 2 }], a: 1 }]];
    expect(sameJson(left, right)).toBe(true);
  });

  it('preserves array order at every depth', () => {
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson({ list: [[{ a: 1 }, { a: 2 }]] },
      { list: [[{ a: 2 }, { a: 1 }]] })).toBe(false);
  });

  it('treats undefined properties as missing at every depth', () => {
    expect(sameJson({ a: undefined, nested: { b: undefined } }, { nested: {} })).toBe(true);
    expect(sameJson([{ a: undefined }], [{}])).toBe(true);
  });

  it('distinguishes null from missing and numbers from strings', () => {
    expect(sameJson({ a: null }, {})).toBe(false);
    expect(sameJson(1, '1')).toBe(false);
    expect(sameJson(null, undefined)).toBe(false);
    expect(sameJson(null, null)).toBe(true);
    expect(sameJson(undefined, undefined)).toBe(true);
  });

  it('preserves JSON array holes and non-finite number behaviour', () => {
    expect(sameJson([undefined], [null])).toBe(true);
    expect(sameJson(Array(1), [null])).toBe(true);
    expect(sameJson(NaN, null)).toBe(true);
    expect(sameJson(Infinity, null)).toBe(true);
    expect(sameJson(-0, 0)).toBe(true);
  });

  it('preserves toJSON behaviour', () => {
    expect(sameJson(new Date('2026-11-12T00:00:00Z'), '2026-11-12T00:00:00.000Z')).toBe(true);
  });

  it('does not lose object keys named __proto__', () => {
    const value: unknown = JSON.parse('{"__proto__":{"x":1},"a":2}');
    const reordered: unknown = JSON.parse('{"a":2,"__proto__":{"x":1}}');
    expect(sameJson(value, reordered)).toBe(true);
    expect(sameJson(value, { a: 2 })).toBe(false);
  });

  it('keeps stringify errors for cyclic values and big integers', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => sameJson(cyclic, {})).toThrow(TypeError);
    expect(() => sameJson(1n, 1)).toThrow(TypeError);
  });
});
