import { event } from './definition.ts';
import { decisionRecordedDataSchema } from './data.ts';
import { z } from 'zod';

const toolDispatchStartedDataSchema = z.strictObject({
  requestId: z.uuid(),
  serverId: z.string().regex(/^[\w-]{1,200}$/u),
  connectionId: z.string().regex(/^[\w-]{1,200}$/u),
  generation: z.int().positive(),
  recordDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  reviewRevision: z.int().positive(),
  adapter: z.literal('remote_https').optional(),
});

export const decisionEvents = [
  event('tool.dispatch_started', 'decision',
    'The models process consumed a published tool permit before sending any bytes.',
    toolDispatchStartedDataSchema, {
      requestId: '00000000-0000-4000-8000-000000000001', serverId: 'mcp_1',
      connectionId: 'installed', generation: 1, recordDigest: '0'.repeat(64), reviewRevision: 1,
    }),
  event('decision.recorded', 'decision', 'The gateway or budget turn admission decision was recorded before dispatch.', decisionRecordedDataSchema,
    { requestId: 'request_1', callId: 'call_1', requesterId: 'mem_1', assistantId: 'asst_1', route: 'mcp', outcome: 'ask', reason: 'approval_required', contextDigest: '0'.repeat(64) }),
];
