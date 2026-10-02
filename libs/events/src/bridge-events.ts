import { event } from './definition.ts';
import * as data from './data.ts';

export const bridgeEvents = [
  event('computer.turn_started', 'computer', 'The server admitted a turn and fenced idle suspension.', data.computerTurnStartedDataSchema,
    { assistantId: 'asst_1', computerId: 'computer_1', conversationId: 'conv_1', turnId: 'turn_1', threadId: 'thread_1', requesterId: 'mem_1', task: 'chat_turn' }),
  event('computer.turn_closed', 'computer', 'The server permanently closed a turn and released its suspend fence.', data.computerTurnClosedDataSchema,
    { assistantId: 'asst_1', computerId: 'computer_1', conversationId: 'conv_1', turnId: 'turn_1', threadId: 'thread_1', requesterId: 'mem_1', task: 'chat_turn', status: 'completed' }),
  event('agent.message_delta', 'conversation', 'The bridge reported streamed assistant text.', data.agentMessageCompletedDataSchema,
    { conversationId: 'conv_1', turnId: 'turn_1', messageId: 'msg_1', ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1', contentType: 'text' }),
] as const;
