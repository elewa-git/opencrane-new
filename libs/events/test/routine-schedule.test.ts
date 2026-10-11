import { expect, it, vi } from 'vitest';
import {
  calculateRoutineOccurrence, previewRoutineOccurrences,
} from '@opencrane/events/routine-schedule';

const identity = { silo: 'test', routineId: 'orders', scheduleRevision: 1 };
const daily = { frequency: 'daily' as const, localTime: '02:30', zone: 'Europe/Brussels' };
const weekly = { ...daily, frequency: 'weekly' as const, weekday: 7 };
const request = { ...identity, schedule: daily, effectiveAt: '2026-01-01T00:00:00Z' };

function summarise(occurrence: ReturnType<typeof calculateRoutineOccurrence>) {
  return [occurrence.localDate, occurrence.at, occurrence.offsetMinutes,
    occurrence.status, occurrence.repeated, occurrence.checkAt];
}

function dailyAcrossSpring() {
  const input = { ...request, now: '2027-03-26T12:00:00Z', count: 3 };
  const occurrences = previewRoutineOccurrences(input);
  const summary = occurrences.map(summarise);
  expect(summary).toEqual([
    ['2027-03-27', '2027-03-27T01:30:00.000Z', 60,
      'scheduled', false, '2027-03-27T01:30:00.000Z'],
    ['2027-03-28', null, null, 'dst_skip', false, '2027-03-28T01:00:00.000Z'],
    ['2027-03-29', '2027-03-29T00:30:00.000Z', 120,
      'scheduled', false, '2027-03-29T00:30:00.000Z'],
  ]);
}
it('keeps daily local dates across the Brussels spring gap', dailyAcrossSpring);

function dailyAcrossAutumn() {
  const input = { ...request, now: '2026-10-23T12:00:00Z', count: 3 };
  const occurrences = previewRoutineOccurrences(input);
  const summary = occurrences.map(summarise);
  expect(summary).toEqual([
    ['2026-10-24', '2026-10-24T00:30:00.000Z', 120,
      'scheduled', false, '2026-10-24T00:30:00.000Z'],
    ['2026-10-25', '2026-10-25T00:30:00.000Z', 120,
      'scheduled', true, '2026-10-25T00:30:00.000Z'],
    ['2026-10-26', '2026-10-26T01:30:00.000Z', 60,
      'scheduled', false, '2026-10-26T01:30:00.000Z'],
  ]);
}
it('chooses the first repeated Brussels hour once for daily slots', dailyAcrossAutumn);

function weeklyAcrossSpring() {
  const input = { ...request, schedule: weekly, now: '2027-03-27T12:00:00Z', count: 2 };
  const occurrences = previewRoutineOccurrences(input);
  const summary = occurrences.map(summarise);
  expect(summary).toEqual([
    ['2027-03-28', null, null, 'dst_skip', false, '2027-03-28T01:00:00.000Z'],
    ['2027-04-04', '2027-04-04T00:30:00.000Z', 120,
      'scheduled', false, '2027-04-04T00:30:00.000Z'],
  ]);
}
it('previews a weekly Brussels skip followed by the next Sunday', weeklyAcrossSpring);

function weeklyAcrossAutumn() {
  const input = { ...request, schedule: weekly, now: '2026-10-24T12:00:00Z', count: 2 };
  const occurrences = previewRoutineOccurrences(input);
  expect(occurrences[0]).toMatchObject({ localDate: '2026-10-25',
    at: '2026-10-25T00:30:00.000Z', repeated: true });
  expect(occurrences[1]).toMatchObject({ localDate: '2026-11-01',
    at: '2026-11-01T01:30:00.000Z', repeated: false });
  const betweenRepeats = { ...input, now: '2026-10-25T00:45:00Z', count: 1 };
  expect(previewRoutineOccurrences(betweenRepeats)[0]?.localDate).toBe('2026-11-01');
}
it('never offers the second repeated hour as another weekly occurrence', weeklyAcrossAutumn);

function nonHourDst() {
  const repeatSchedule = { ...daily, localTime: '01:45', zone: 'Australia/Lord_Howe' };
  const repeatInput = { ...identity, schedule: repeatSchedule, localDate: '2026-04-05' };
  expect(calculateRoutineOccurrence(repeatInput)).toMatchObject({
    at: '2026-04-04T14:45:00.000Z', offsetMinutes: 660, repeated: true,
  });
  const gapSchedule = { ...repeatSchedule, localTime: '02:15' };
  const gapInput = { ...identity, schedule: gapSchedule, localDate: '2026-10-04' };
  expect(calculateRoutineOccurrence(gapInput)).toMatchObject({
    at: null, offsetMinutes: null, status: 'dst_skip', checkAt: '2026-10-03T15:30:00.000Z',
  });
}
it('handles both half-hour clock changes on Lord Howe', nonHourDst);

function noDstAndCalendarRollover() {
  const schedule = { ...daily, localTime: '09:00', zone: 'Asia/Kolkata' };
  const input = { ...request, schedule, now: '2028-02-28T12:00:00Z', count: 2 };
  const occurrences = previewRoutineOccurrences(input);
  expect(occurrences[0]).toMatchObject({ localDate: '2028-02-29',
    at: '2028-02-29T03:30:00.000Z', offsetMinutes: 330 });
  expect(occurrences[1]?.localDate).toBe('2028-03-01');
}
it('uses local calendar dates in a zone without DST', noDstAndCalendarRollover);

function refusesBadInput() {
  const invalidSchedules = [
    { ...daily, zone: 'Europe/Not_A_Zone' },
    { ...daily, zone: '+02:00' },
    { ...daily, localTime: '24:00' },
    { ...weekly, weekday: 0 },
  ];
  for (const schedule of invalidSchedules) {
    const input = { ...request, schedule, now: '2026-10-11T00:00:00Z' };
    function calculate() {
      return previewRoutineOccurrences(input);
    }
    expect(calculate).toThrow();
  }
  const invalidDate = { ...identity, schedule: daily, localDate: '2026-02-30' };
  function calculateInvalidDate() {
    return calculateRoutineOccurrence(invalidDate);
  }
  expect(calculateInvalidDate).toThrow();
}
it('refuses invalid zones, offset-only zones and malformed local schedules', refusesBadInput);

function futureOnly() {
  const input = { ...request, now: '2026-10-23T12:00:00Z',
    effectiveAt: '2026-10-25T00:30:00Z', count: 1 };
  expect(previewRoutineOccurrences(input)[0]?.localDate).toBe('2026-10-26');
  const afterGap = { ...input, now: '2027-03-28T01:00:00Z' };
  expect(previewRoutineOccurrences(afterGap)[0]?.localDate).toBe('2027-03-29');
}
it('starts strictly after both the supplied time and the edit or resume time', futureOnly);

function backwardsClock() {
  const input = { ...request, now: '2026-10-25T00:00:00Z', count: 1 };
  const consumed = previewRoutineOccurrences(input)[0]!;
  const backwards = { ...input, now: '2026-10-23T00:00:00Z',
    afterLocalDate: consumed.localDate };
  expect(previewRoutineOccurrences(backwards)[0]?.localDate).toBe('2026-10-26');
}
it('does not revisit a consumed local date when the caller clock moves backwards', backwardsClock);

function deterministicIds() {
  const input = { ...identity, schedule: daily, localDate: '2026-10-25' };
  const original = calculateRoutineOccurrence(input);
  const preview = { ...request, now: '2026-10-24T12:00:00Z', count: 1 };
  expect(previewRoutineOccurrences(preview)[0]?.occurrenceId).toBe(original.occurrenceId);
  const changedInputs = [
    { ...input, silo: 'other' }, { ...input, routineId: 'other' },
    { ...input, scheduleRevision: 2 }, { ...input, localDate: '2026-10-26' },
    { ...input, schedule: { ...daily, localTime: '02:31' } },
    { ...input, schedule: { ...daily, zone: 'UTC' } },
  ];
  for (const changed of changedInputs) {
    expect(calculateRoutineOccurrence(changed).occurrenceId).not.toBe(original.occurrenceId);
  }
  const skipInput = { ...input, localDate: '2027-03-28' };
  const skipped = calculateRoutineOccurrence(skipInput);
  expect(skipped.occurrenceId).toMatch(/^[a-f0-9]{64}$/u);
  expect(calculateRoutineOccurrence(skipInput).occurrenceId).toBe(skipped.occurrenceId);
}
it('derives stable ids from the local identity, including slots with no instant', deterministicIds);

function ignoresWallClock() {
  vi.useFakeTimers();
  try {
    const input = { ...request, now: '2026-10-24T12:00:00Z', count: 2 };
    vi.setSystemTime('2030-01-01T00:00:00Z');
    const first = previewRoutineOccurrences(input);
    vi.setSystemTime('2020-01-01T00:00:00Z');
    expect(previewRoutineOccurrences(input)).toEqual(first);
  } finally {
    vi.useRealTimers();
  }
}
it('depends only on caller time, never the process clock', ignoresWallClock);
