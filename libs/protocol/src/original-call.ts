import { z } from 'zod';

const attempt = z.strictObject({
  requestId: z.string().min(1),
  usedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().optional(),
  observedAt: z.iso.datetime().optional(),
  outcome: z.enum(['not_dispatched', 'responded', 'outcome_unknown']).optional(),
  evidence: z.enum([
    'connection_refused', 'dispatch_refused', 'response_received', 'transport_uncertain',
    'adapter_response_received', 'adapter_transport_uncertain', 'adapter_dispatch_refused',
  ]).optional(),
});

export const originalCallStatusSchema = z.strictObject({
  logicalRequestId: z.string().regex(/^[a-f0-9]{64}$/u),
  approvalId: z.string().regex(/^[a-f0-9]{64}$/u),
  turnId: z.string(),
  requesterId: z.string(),
  requestedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().optional(),
  endedAt: z.iso.datetime().optional(),
  attempts: z.array(attempt),
  retry: z.enum(['eligible', 'unknown', 'ended']),
});

export type OriginalCallStatus = z.infer<typeof originalCallStatusSchema>;
