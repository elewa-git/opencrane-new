import type { z } from 'zod';

export interface EventDefinition<DataSchema extends z.ZodType = z.ZodType> {
  /** The event type, in past tense, e.g. "member.joined". */
  readonly type: string;
  /** The stream-type prefix this event is appended to, e.g. "member" for `member-<user>`. */
  readonly stream: string;
  /** One line describing what the event means. */
  readonly description: string;
  /** The zod schema for this event's `data` field. */
  readonly dataSchema: DataSchema;
  /** One valid `data` value for this event type. */
  readonly example: z.infer<DataSchema>;
}

// Builds one registry entry. `example` is typed against this call's own
// `dataSchema`, so an example that does not fit its schema is a compile
// error, not only a test failure.
export function event<DataSchema extends z.ZodType>(
  type: string,
  stream: string,
  description: string,
  dataSchema: DataSchema,
  example: z.infer<DataSchema>,
): EventDefinition<DataSchema> {
  return { type, stream, description, dataSchema, example };
}

