// The WebSocket messages both sides speak: the server (apps/server) and the
// browser (apps/web) import these schemas and types instead of each
// defining their own copy. There is no business logic here yet (see
// plan.md Phase 1) — this only proves the socket is wired up end to end and
// validates what comes over it, the way every later WebSocket message in
// the real protocol will.
//
// Moved out of apps/server/src/protocol.ts so apps/web can import the same
// types without depending on the server's Node-only package.
import { chatSubscribeSchema, chatMessageSchema } from './chat.ts';
import { z } from 'zod';
import { subscribeSchema, realtimeMessageSchema } from './realtime.ts';

export const helloMessageSchema = z
  .object({
    type: z.literal('hello'),
    text: z.string().min(1),
  })
  .strict();

export type HelloMessage = z.infer<typeof helloMessageSchema>;

export const helloEchoSchema = z
  .object({
    type: z.literal('hello'),
    text: z.string().min(1),
    echoedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type HelloEcho = z.infer<typeof helloEchoSchema>;

export const errorMessageSchema = z
  .object({
    type: z.literal('error'),
    message: z.string().min(1),
  })
  .strict();

export type ErrorMessage = z.infer<typeof errorMessageSchema>;

// A message carrying a raw event envelope to check against
// @opencrane/events' registry. This is the cross-package path: the same
// parse-by-type validation a real command handler, projection or reaction
// would run before accepting an event, exercised here over the socket so
// CI proves the two packages actually work together, not just that each
// typechecks alone.
export const validateEventMessageSchema = z
  .object({
    type: z.literal('validateEvent'),
    event: z.unknown(),
  })
  .strict();

export type ValidateEventMessage = z.infer<typeof validateEventMessageSchema>;

export const eventValidationResultSchema = z
  .object({
    type: z.literal('eventValidationResult'),
    valid: z.boolean(),
    reason: z.string().optional(),
  })
  .strict();

export type EventValidationResult = z.infer<typeof eventValidationResultSchema>;

// Every message the server can send down the socket.
export const serverMessageSchema = z.union([helloEchoSchema, errorMessageSchema, eventValidationResultSchema, realtimeMessageSchema, chatMessageSchema]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;

// Every message the browser can send up the socket.
export const clientMessageSchema = z.union([helloMessageSchema, validateEventMessageSchema, subscribeSchema, chatSubscribeSchema]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
