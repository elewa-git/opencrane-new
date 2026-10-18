import { expect, it } from 'vitest';
import { utcInstant } from '../src/approval-record.ts';

const instants = [
  ['one fractional digit', '2026-10-12T12:01:00.1+02:00', '2026-10-12T10:01:00.1Z'],
  ['three fractional digits', '2026-10-12T12:01:00.123+02:00', '2026-10-12T10:01:00.123Z'],
  ['six fractional digits', '2026-10-12T12:01:00.123456+02:00',
    '2026-10-12T10:01:00.123456Z'],
  ['negative offset across midnight', '2026-10-12T00:15:00.123456-02:00',
    '2026-10-12T02:15:00.123456Z'],
] as const;

function keepsOffsetPrecision(_name: string, savedTime: string, expected: string) {
  expect(utcInstant(savedTime)).toBe(expected);
}
it.each(instants)('converts %s to UTC and keeps its fractional digits', keepsOffsetPrecision);

function keepsUtcValueUnchanged() {
  const savedTime = '2026-10-12T10:01:00.120000Z';
  expect(utcInstant(savedTime)).toBe(savedTime);
}
it('leaves a saved UTC value unchanged', keepsUtcValueUnchanged);
