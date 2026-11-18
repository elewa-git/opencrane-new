import { expect, it } from 'vitest';
import { recordIdPattern, recordIdSchema } from '../src/index.ts';

const oldPatterns = [/^[\w-]{1,200}$/u, /^[A-Za-z0-9_-]{1,200}$/u];
const cases = [
  { value: '', accepted: false },
  { value: 'a', accepted: true },
  { value: 'a'.repeat(200), accepted: true },
  { value: 'a'.repeat(201), accepted: false },
  { value: 'AZaz09_-', accepted: true },
  { value: '.', accepted: false },
  { value: 'a b', accepted: false },
  { value: 'a/b', accepted: false },
  { value: 'a:b', accepted: false },
  { value: 'a\n', accepted: false },
  { value: 'é', accepted: false },
  { value: 'K', accepted: false },
  { value: '中', accepted: false },
  { value: '😀', accepted: false },
  { value: 'e\u0301', accepted: false },
];

it('preserves both old ID patterns at length and character boundaries', () => {
  for (const { value, accepted } of cases) {
    for (const oldPattern of oldPatterns) {
      expect(oldPattern.test(value), value).toBe(accepted);
      expect(recordIdPattern.test(value), value).toBe(oldPattern.test(value));
      expect(recordIdSchema.safeParse(value).success, value).toBe(oldPattern.test(value));
    }
  }
});
