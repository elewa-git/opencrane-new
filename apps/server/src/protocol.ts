// The one WebSocket message this skeleton understands: a typed "hello".
// There is no business logic here yet (see plan.md Phase 1) — this only
// proves the socket is wired up and validates what comes over it, the way
// every later WebSocket message in the real protocol will.
import { z } from 'zod';

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
