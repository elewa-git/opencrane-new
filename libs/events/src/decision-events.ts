import { event } from './definition.ts';
import { decisionRecordedDataSchema } from './data.ts';

export const decisionEvents = [
  event('decision.recorded', 'decision', 'The gateway decision was recorded before dispatch.', decisionRecordedDataSchema,
    { requestId: 'request_1', callId: 'call_1', requesterId: 'mem_1', assistantId: 'asst_1', route: 'mcp', outcome: 'ask', reason: 'approval_required', contextDigest: '0'.repeat(64) }),
];
