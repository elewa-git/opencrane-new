import { z } from 'zod';
import { chatContextSchema, type ChatContext } from '@opencrane/protocol';
import { retryRead } from '../core/read-retry';
import type { PendingChatMessage } from './conversations-data';

const identitySchema = z.object({
  authenticated: z.boolean(), user: z.object({ name: z.string().optional() }).nullable(),
});

type ChatIdentity = { context: ChatContext; displayName: string };

export async function readChatIdentity(): Promise<ChatIdentity> {
  const context = chatContextSchema.parse(await requestChat('/api/chat'));
  const identity = identitySchema.parse(await requestChat('/auth/me'));
  const name = identity.authenticated ? identity.user?.name?.trim() : undefined;
  return { context, displayName: name || 'You' };
}

export class ReadFailure extends Error {
  readonly status: number;
  constructor(status: number) {
    super('Chat request failed');
    this.status = status;
  }
}

export class MessageUnconfirmed extends Error {}

export function isChatAccessFailure(error: unknown): boolean {
  return error instanceof ReadFailure && (error.status === 401 || error.status === 403);
}

function chatReply(response: Response): Promise<unknown> {
  if (response.status !== 200) {
    throw new ReadFailure(response.status);
  }
  return response.json() as Promise<unknown>;
}

export async function requestChat(path: string, body?: unknown): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const options: RequestInit = { signal: AbortSignal.timeout(15_000) };
    if (body) {
      options.method = 'POST';
      options.headers = { 'content-type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    const response = await fetch(path, options);
    // Retry a competing append with the same id so the saved command cannot be repeated.
    if (body && response.status === 409 && attempt < 2) continue;
    return chatReply(response);
  }
}

export async function savedChatChange(
  command: { id: string; conversationId: string }, waitUntil?: AbortSignal,
): Promise<boolean> {
  const path = `/api/conversations/${command.conversationId}/changes/${command.id}`;
  function readStatus(signal: AbortSignal): Promise<Response> {
    return fetch(path, { signal });
  }
  try {
    const response = waitUntil
      ? await retryRead(readStatus, waitUntil, {
        attempts: 5, delayMs: 250, shouldRetry: changeStatusPending,
      })
      : await readStatus(AbortSignal.timeout(15_000));
    const result = await chatReply(response);
    const receipt = z.object({ status: z.literal('appended'),
      commandId: z.string() }).parse(result);
    return receipt.commandId === command.id;
  } catch (error) {
    if (error instanceof ReadFailure && error.status === 404) return false;
    throw error;
  }
}

function changeStatusPending(response: Response): boolean {
  return [404, 425, 503].includes(response.status);
}

export async function sendChatMessage(command: PendingChatMessage): Promise<void> {
  const { conversationId, ...body } = command;
  try {
    await requestChat(`/api/conversations/${conversationId}/messages`, body);
  } catch (sendError) {
    // These replies prove the send was refused before it could be saved.
    if (sendError instanceof ReadFailure && [400, 401, 403, 409, 425].includes(sendError.status)) {
      throw sendError;
    }
    let recorded;
    try {
      // A proxy can lose the reply while the original request is still finishing.
      recorded = await savedChatChange(command, AbortSignal.timeout(2_500));
    } catch (statusError) {
      if (isChatAccessFailure(statusError)) throw statusError;
      const cause = new AggregateError([sendError, statusError]);
      throw new MessageUnconfirmed('Could not confirm the message', { cause });
    }
    if (!recorded) throw new MessageUnconfirmed('Could not confirm the message', { cause: sendError });
  }
}
