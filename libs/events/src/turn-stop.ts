import { z } from 'zod';

const id = z.string().min(1);
export const agentTurnStopRequestedDataSchema = z.union([
  z.object({ conversationId: id, turnId: id, requestedBy: id }).strict(),
  z.object({ conversationId: id, turnId: id, reason: z.literal('budget'), stopId: id }).strict(),
]);
