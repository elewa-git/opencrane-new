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
import type { EventDefinition } from './registry.ts';

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
