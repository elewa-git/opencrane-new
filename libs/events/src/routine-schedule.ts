import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { routineScheduleSchema } from './routines.ts';

const identityFields = {
  silo: z.string().min(1).max(300),
  routineId: z.string().min(1).max(300),
  scheduleRevision: z.int().positive(),
  schedule: routineScheduleSchema,
};
const localDateSchema = z.iso.date();
const occurrenceFields = { ...identityFields, localDate: localDateSchema };
const occurrenceSchema = z.object(occurrenceFields).strict();
const instant = z.iso.datetime({ offset: true });
const previewFields = {
  ...identityFields,
  now: instant,
  effectiveAt: instant,
  afterLocalDate: localDateSchema.optional(),
  count: z.int().min(1).max(50).default(5),
};
const previewSchema = z.object(previewFields).strict();
type OccurrenceInput = z.infer<typeof occurrenceSchema>;

interface LocalOccurrence {
  occurrenceId: string;
  localDate: string;
  localTime: string;
  zone: string;
  checkAt: string;
}

type RoutineOccurrence = LocalOccurrence & (
  | { status: 'scheduled'; at: string; offsetMinutes: number; repeated: boolean }
  | { status: 'dst_skip'; at: null; offsetMinutes: null; repeated: false }
);

const minuteMilliseconds = 60_000;
const hourMilliseconds = 60 * minuteMilliseconds;
const dayMilliseconds = 24 * hourMilliseconds;

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  // Refuse offset-only zones: a routine needs the named zone's clock-change rules.
  if (zone.startsWith('+') || zone.startsWith('-')) {
    throw new RangeError('A routine needs a named time zone');
  }
  const options: Intl.DateTimeFormatOptions = {
    timeZone: zone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  };
  return new Intl.DateTimeFormat('en-GB', options);
}

function datePart(fields: Record<string, string>, name: string): string {
  const value = fields[name];
  if (value === undefined) {
    throw new RangeError(`The time zone formatter did not return ${name}`);
  }
  return value;
}

function localTimestamp(formatter: Intl.DateTimeFormat, at: number): number {
  const parts = formatter.formatToParts(at);
  const fields: Record<string, string> = {};
  for (const part of parts) {
    fields[part.type] = part.value;
  }
  const year = datePart(fields, 'year').padStart(4, '0');
  const month = datePart(fields, 'month');
  const day = datePart(fields, 'day');
  const hour = datePart(fields, 'hour');
  const minute = datePart(fields, 'minute');
  const second = datePart(fields, 'second');
  const date = `${year}-${month}-${day}`;
  const time = `${hour}:${minute}:${second}`;
  return Date.parse(`${date}T${time}.000Z`);
}

function nearbyOffsets(formatter: Intl.DateTimeFormat, intended: number): Set<number> {
  const offsets = new Set<number>();
  // Include both sides of a clock change, even when an entire local day is missing.
  for (let hours = -48; hours <= 48; hours += 6) {
    const at = intended + hours * hourMilliseconds;
    const local = localTimestamp(formatter, at);
    const offsetMinutes = (local - at) / minuteMilliseconds;
    if (!Number.isInteger(offsetMinutes)) {
      throw new RangeError('The time zone must use whole-minute offsets');
    }
    offsets.add(offsetMinutes);
  }
  return offsets;
}

function gapBoundary(formatter: Intl.DateTimeFormat, intended: number,
  candidates: number[]): number {
  let earlier = Math.min(...candidates);
  let later = Math.max(...candidates);
  // Find the jump itself, rather than shifting the missing time into the next hour.
  while (later - earlier > minuteMilliseconds) {
    const middleMinute = Math.floor((earlier + later) / (2 * minuteMilliseconds));
    const middle = middleMinute * minuteMilliseconds;
    if (localTimestamp(formatter, middle) > intended) {
      later = middle;
    } else {
      earlier = middle;
    }
  }
  if (localTimestamp(formatter, earlier) >= intended ||
      localTimestamp(formatter, later) <= intended) {
    throw new RangeError('Cannot find the missing local time boundary');
  }
  return later;
}

function occurrenceId(input: OccurrenceInput): string {
  const identity = [input.silo, input.routineId, input.scheduleRevision,
    input.localDate, input.schedule.localTime, input.schedule.zone];
  const text = JSON.stringify(identity);
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const digest = sha256(bytes);
  return bytesToHex(digest);
}

function calculate(input: OccurrenceInput, formatter: Intl.DateTimeFormat): RoutineOccurrence {
  const intended = Date.parse(`${input.localDate}T${input.schedule.localTime}:00.000Z`);
  const offsets = nearbyOffsets(formatter, intended);
  const candidates: number[] = [];
  const matches: number[] = [];
  for (const offsetMinutes of offsets) {
    const at = intended - offsetMinutes * minuteMilliseconds;
    candidates.push(at);
    // Round-trip all fields to refuse a missing local time and find both repeated instants.
    if (localTimestamp(formatter, at) === intended) {
      matches.push(at);
    }
  }
  const local = {
    occurrenceId: occurrenceId(input), localDate: input.localDate,
    localTime: input.schedule.localTime, zone: input.schedule.zone,
  };
  if (matches.length === 0) {
    const boundary = gapBoundary(formatter, intended, candidates);
    return { ...local, status: 'dst_skip', at: null, offsetMinutes: null,
      repeated: false, checkAt: new Date(boundary).toISOString() };
  }
  const first = Math.min(...matches);
  const at = new Date(first).toISOString();
  const offsetMinutes = (intended - first) / minuteMilliseconds;
  return { ...local, status: 'scheduled', at, offsetMinutes,
    repeated: matches.length > 1, checkAt: at };
}

/** Calculate one intended local slot without reading a clock or starting work. */
export function calculateRoutineOccurrence(input: unknown): RoutineOccurrence {
  const checked = occurrenceSchema.parse(input);
  const formatter = zoneFormatter(checked.schedule.zone);
  const date = Date.parse(`${checked.localDate}T00:00:00Z`);
  if (!isScheduledDate(checked.schedule, date)) {
    throw new RangeError('The local date is not scheduled for this weekday');
  }
  return calculate(checked, formatter);
}

function isScheduledDate(schedule: OccurrenceInput['schedule'], date: number): boolean {
  if (schedule.frequency === 'daily') {
    return true;
  }
  const day = new Date(date).getUTCDay();
  const isoWeekday = day === 0 ? 7 : day;
  return isoWeekday === schedule.weekday;
}

/** Preview future slots; count includes skips, which have no due instant. */
export function previewRoutineOccurrences(input: unknown): RoutineOccurrence[] {
  const checked = previewSchema.parse(input);
  const formatter = zoneFormatter(checked.schedule.zone);
  const earliest = Math.max(Date.parse(checked.now), Date.parse(checked.effectiveAt));
  const localNow = localTimestamp(formatter, earliest);
  let date = Math.floor(localNow / dayMilliseconds) * dayMilliseconds;
  if (checked.afterLocalDate !== undefined) {
    const consumedDate = Date.parse(`${checked.afterLocalDate}T00:00:00Z`);
    date = Math.max(date, consumedDate + dayMilliseconds);
  }
  const occurrences: RoutineOccurrence[] = [];
  while (occurrences.length < checked.count) {
    const dateText = new Date(date).toISOString();
    const localDate = dateText.slice(0, 10);
    localDateSchema.parse(localDate);
    if (isScheduledDate(checked.schedule, date)) {
      const slotInput = { silo: checked.silo, routineId: checked.routineId,
        scheduleRevision: checked.scheduleRevision, schedule: checked.schedule, localDate };
      const occurrence = calculate(slotInput, formatter);
      if (Date.parse(occurrence.checkAt) > earliest) {
        occurrences.push(occurrence);
      }
    }
    date += dayMilliseconds;
  }
  return occurrences;
}
