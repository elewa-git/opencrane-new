import { event } from './definition.ts';
import * as data from './data.ts';

export const bridgeEvents = [
  event(
    'agent.turn_stop_requested',
    'conversation',
    'A member or spending stop requested interruption; retain earlier recorded text.',
    data.agentTurnStopRequestedDataSchema,
    { conversationId: 'conv_1', turnId: 'turn_1', requestedBy: 'mem_1' },
  ),


  event('computer.view_refused', 'view', 'The proxy refused desktop admission without releasing pixels.', data.computerViewRefusedDataSchema,
    { attemptId: 'view_1', conversationId: 'conv_1', reason: 'admission' }),
  event('computer.view_started', 'view', 'An authorised person opened a bounded read-only desktop session.', data.computerViewDataSchema,
    { sessionId: 'view_1', conversationId: 'conv_1', computerId: 'computer_1', assistantId: 'asst_1', memberId: 'mem_1', generation: 1, expiresAt: '2026-10-03T12:02:00Z' }),
  event('computer.view_stopped', 'view', 'The proxy stopped a desktop session.', data.computerViewStoppedDataSchema,
    { sessionId: 'view_1', conversationId: 'conv_1', computerId: 'computer_1', assistantId: 'asst_1', memberId: 'mem_1', generation: 1, expiresAt: '2026-10-03T12:02:00Z', reason: 'access_changed' }),
  event('computer.turn_started', 'computer', 'The server admitted a turn and fenced idle suspension.', data.computerTurnStartedDataSchema,
    { assistantId: 'asst_1', computerId: 'computer_1', conversationId: 'conv_1', turnId: 'turn_1', threadId: 'thread_1', requesterId: 'mem_1', task: 'chat_turn' }),
  event('computer.turn_closed', 'computer', 'The server permanently closed a turn and released its suspend fence.', data.computerTurnClosedDataSchema,
    { assistantId: 'asst_1', computerId: 'computer_1', conversationId: 'conv_1', turnId: 'turn_1', threadId: 'thread_1', requesterId: 'mem_1', task: 'chat_turn', status: 'completed' }),
  event('agent.message_delta', 'conversation', 'The bridge reported streamed assistant text.', data.agentMessageCompletedDataSchema,
    { conversationId: 'conv_1', turnId: 'turn_1', messageId: 'msg_1', ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1', contentType: 'text' }),
  event(
    'agent.message_completed',
    'conversation',
    'The bridge reported a completed assistant message.',
    data.agentMessageCompletedDataSchema,
    {
      conversationId: 'conv_1',
      turnId: 'turn_1',
      messageId: 'msg_1',
      ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0',
      keyId: 'key:1',
      contentType: 'text',
    },
  ),
] as const;
