import { agentOutputLostDataSchema, agentPrivateExitedDataSchema } from './data.ts';
import { event } from './definition.ts';

export const privateReportEvents = [
  event(
    'agent.output_lost',
    'conversation',
    'Part of a private reply was lost when the computer restarted before the server stored it',
    agentOutputLostDataSchema,
    { conversationId: 'conv_1', turnId: 'turn_1' },
  ),
  event(
    'agent.private_exited',
    'conversation',
    'The computer confirmed that the private process for a turn exited.',
    agentPrivateExitedDataSchema,
    { conversationId: 'conv_1', turnId: 'turn_1' },
  ),
];
