// Binds an event to its stream: computes the subject an event of this
// type must carry, from its own `data` and the envelope's `silo`, so
// parse.ts can check the envelope's `subject` field really is that value.
//
// The format comes straight from the "Streams" table in
// docs/architecture/events.md, e.g. `member-<user>`: every stream is
// `<stream-type>-<entity-id>`, where the entity id is one field in `data`
// (or several, joined with `-`, for the one composite stream:
// `connection-<user>-<server>-<profile>`). The three silo-wide streams
// (org, budget, security) key on the envelope's own `silo` field instead,
// since there is exactly one of each per silo.
//
// This envelope `subject` (hyphen-joined, e.g. "member-mem_1") is a
// different string from the NATS JetStream subject the "How events are
// delivered" section of events.md describes (`ev.<stream-type>.<id>`,
// dot-joined). They name the same stream, but one is a CloudEvents field
// stored on every event and the other is the wire routing key JetStream
// uses; this file only builds the former.
//
// Every id that goes into a subject (here, and the envelope's own `silo`
// field in envelope.ts) is restricted to this character set. Two reasons:
// - `-` is the join separator above, so an id containing `-` could make
//   two different entities collide on the same subject string (e.g.
//   serverId "x-odoo" + profile "work" would build the same subject as
//   serverId "x" + profile "odoo-work"). Since no id may contain `-`,
//   joining with `-` can never be ambiguous: the id boundaries are fixed.
// - NATS subjects give `.`, `*`, `>` and whitespace special meaning
//   (token separator and wildcards), so an id carrying any of those could
//   silently change which JetStream subject an event lands on.
import type { EventDefinition } from './registry.ts';

export const SUBJECT_ID_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * The subject an event of this type must carry, given its own `data` and
 * the envelope's `silo`. `data` is read loosely here (it has already
 * passed the event's own strict schema by the time this runs), so a
 * missing or non-string field simply produces an empty segment rather
 * than throwing.
 */
export function expectedSubject(definition: EventDefinition, data: unknown, silo: string): string {
  if (definition.subjectFields === 'silo') {
    return `${definition.stream}-${silo}`;
  }

  const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const parts = definition.subjectFields.map((field) => {
    const value = record[field];
    return typeof value === 'string' ? value : '';
  });
  return `${definition.stream}-${parts.join('-')}`;
}
