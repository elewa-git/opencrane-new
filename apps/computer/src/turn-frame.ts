import { modelForTask } from '@opencrane/models/routing';

export interface Turn {
  executionMode: 'restricted' | 'memory_free';
  id: string;
  conversationId: string;
  assistantId: string;
  requesterId?: string;
  text: string;
  token: string;
  expiresAt: number;
  taskKind: string;
  attachments?: unknown;
  omittedAttachments: number;
}

export function requiredString(value: Record<string, unknown>, name: string) {
  const result = value[name];
  if (typeof result !== 'string' || !result) {
    throw new Error('Invalid bridge field');
  }
  return result;
}

export function parseTurn(value: Record<string, unknown>): Turn {
  const executionMode = parseExecutionMode(value['executionMode']);
  const expiresAt = value['expiresAt'];
  const taskKind = value['taskKind'] ?? 'chat_turn';
  const omittedAttachments = value['omittedAttachments'] ?? 0;
  if (typeof omittedAttachments !== 'number' || !Number.isSafeInteger(omittedAttachments)
    || omittedAttachments < 0) {
    throw new Error('Invalid attachment count');
  }
  if (typeof taskKind !== 'string') {
    throw new Error('Invalid task kind');
  }
  modelForTask(taskKind);
  if (typeof expiresAt !== 'number' || expiresAt <= Date.now()) {
    throw new Error('Expired turn');
  }
  const requesterId = value['requesterId'];
  if (requesterId !== undefined && (typeof requesterId !== 'string' || !requesterId)) {
    throw new Error('Invalid requester');
  }
  const turn: Turn = {
    executionMode,
    id: requiredString(value, 'id'),
    conversationId: requiredString(value, 'conversationId'),
    assistantId: requiredString(value, 'assistantId'),
    text: requiredString(value, 'text'),
    token: requiredString(value, 'token'),
    expiresAt,
    taskKind,
    attachments: value['attachments'],
    omittedAttachments,
  };
  if (typeof requesterId === 'string') turn.requesterId = requesterId;
  return turn;
}

function parseExecutionMode(value: unknown) {
  if (value === undefined) return 'memory_free';
  if (value === 'restricted' || value === 'memory_free') return value;
  throw new Error('Invalid execution mode');
}
