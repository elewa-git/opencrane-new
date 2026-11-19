import { expect, it } from 'vitest';
import { sameJson } from '../src/index.ts';

it('shares JSON comparison through the browser contract', sharesJsonComparison);

function sharesJsonComparison() {
  expect(sameJson({ a: [{ b: 1, c: 2 }] }, { a: [{ c: 2, b: 1 }] })).toBe(true);
  expect(sameJson([1, 2], [2, 1])).toBe(false);
}
