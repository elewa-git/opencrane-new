import { z } from 'zod';

export const computerRowSchema = z.object({
  assistantId: z.string().min(1), ownerId: z.string().min(1),
  kind: z.enum(['personal', 'team']), computerId: z.string().min(1).nullable(),
  generation: z.number().int().nonnegative(),
  status: z.enum(['claiming', 'starting', 'ready', 'suspended', 'lost', 'retired', 'taking_control', 'controlling', 'paused']),
  changedAt: z.iso.datetime({ offset: true }),
}).strict();
export const computersResponseSchema = z.object({
  rows: z.array(computerRowSchema), loadedAt: z.iso.datetime({ offset: true }),
}).strict();
export type ComputerRow = z.infer<typeof computerRowSchema>;
export type ComputersResponse = z.infer<typeof computersResponseSchema>;
