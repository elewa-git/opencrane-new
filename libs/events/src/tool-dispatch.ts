import { z } from 'zod';
import { isToolCallText } from './tool-call.ts';

export const toolCallFields = {
  conversationId: z.string().regex(/^[\w-]{1,200}$/u),
  turnId: z.string().regex(/^[\w-]{1,200}$/u),
  callId: z.string().refine(isToolCallText),
  serverId: z.string().regex(/^[\w-]{1,200}$/u),
  toolName: z.string().refine(isToolCallText),
};
export const toolDispatchRecordedDataSchema = z.object({
  ...toolCallFields, requestId: z.uuid(), logicalRequestId: z.string().regex(/^[a-f0-9]{64}$/u),
  approvalId: z.string().min(1).optional(), startedAt: z.iso.datetime(), durationMs: z.int().nonnegative(),
  outcome: z.enum(['not_dispatched', 'responded', 'outcome_unknown']),
  evidence: z.enum([
    'connection_refused', 'dispatch_refused', 'response_received', 'transport_uncertain',
    'adapter_response_received', 'adapter_transport_uncertain',
  ]),
  adapter: z.strictObject({
    decisionId: z.uuid(),
    startId: z.string().regex(/^[a-f0-9-]{36}:tool-dispatch-started$/u),
    connectionId: z.string().regex(/^[\w-]{1,200}$/u),
    generation: z.int().positive(), recordDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    reviewRevision: z.int().positive(),
  }).optional(),
}).strict().refine(validAdapterEvidence);

function validAdapterEvidence(data: {
  requestId: string; evidence: string; outcome: string; adapter?: { startId: string } | undefined;
}) {
  if (data.adapter && data.adapter.startId !== `${data.requestId}:tool-dispatch-started`) {
    return false;
  }
  if (data.evidence === 'adapter_response_received') {
    return data.adapter !== undefined && data.outcome === 'responded';
  }
  if (data.evidence === 'adapter_transport_uncertain') {
    return data.adapter !== undefined && data.outcome === 'outcome_unknown';
  }
  return data.adapter === undefined;
}
