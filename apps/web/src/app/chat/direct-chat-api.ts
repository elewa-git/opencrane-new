import {
  chatChangeSchema, chatColleaguesSchema, chatContextSchema, chatFeedSchema,
  chatListSchema, chatParticipantCommandSchema, chatParticipantsSchema,
} from '@opencrane/protocol';
import type { ChatRow } from '@opencrane/protocol';
import { z } from 'zod';

export type DirectFailure = 'access_changed' | 'refused' | 'invalid' | 'conflict'
  | 'unavailable' | 'access_applying' | 'not_found';
export type DirectOutcome<T> = { kind: 'ok'; value: T }
  | { kind: DirectFailure; status?: number };

const appendReceiptSchema = z.object({ status: z.literal('appended'), sequence: z.int().positive() });

export async function fetchChatContext(signal: AbortSignal) {
  return read('/api/chat', signal, chatContextSchema);
}

export async function fetchDirectConversations(signal: AbortSignal) {
  return read('/api/conversations', signal, chatListSchema);
}

export async function searchColleagues(query: string, signal: AbortSignal) {
  const params = new URLSearchParams({ q: query, limit: '20' });
  return read(`/api/chat/colleagues?${params.toString()}`, signal, chatColleaguesSchema);
}

export async function fetchDirectHistory(conversationId: string, signal: AbortSignal) {
  const id = encodeURIComponent(conversationId);
  const rows: ChatRow[] = [];
  let since = 0;
  let targetPosition: number | undefined;
  let generation: number | undefined;
  let latestFeed: ReturnType<typeof chatFeedSchema.parse> | undefined;
  let restarts = 0;

  while (true) {
    const url = `/api/conversations/${id}/messages?since=${since}`;
    const result = await read(url, signal, chatFeedSchema);
    if (result.kind !== 'ok') return result;
    latestFeed = result.value;

    if (generation === undefined) {
      generation = latestFeed.generation;
      targetPosition = latestFeed.position;
    } else if (generation !== latestFeed.generation) {
      restarts += 1;
      if (restarts > 1) return { kind: 'unavailable' as const };
      rows.length = 0;
      since = 0;
      generation = latestFeed.generation;
      targetPosition = latestFeed.position;
      continue;
    }

    if (targetPosition === undefined) return { kind: 'unavailable' as const };
    appendHistoryPage(rows, latestFeed.rows, targetPosition);
    const lastPosition = lastHistoryPosition(rows, since);
    if (lastPosition >= targetPosition || latestFeed.rows.length === 0) {
      return {
        kind: 'ok' as const,
        value: { ...latestFeed, rows, position: lastPosition },
      };
    }
    since = lastPosition;
  }
}

function appendHistoryPage(rows: ChatRow[], page: ChatRow[], targetPosition: number | undefined) {
  for (const row of page) {
    if (targetPosition !== undefined && row.position <= targetPosition) rows.push(row);
  }
}

function lastHistoryPosition(rows: ChatRow[], since: number): number {
  const lastRow = rows.at(-1);
  if (!lastRow) return since;
  return lastRow.position;
}

export async function createDirectChat(
  body: { id: string; conversationId: string; mode: 'direct'; colleagueId: string }
    | { id: string; conversationId: string; mode: 'group'; participantIds: string[];
      groupId?: string; groupSnapshotPosition?: number },
  signal: AbortSignal,
) {
  return write('/api/conversations', body, signal, appendReceiptSchema);
}

export async function sendDirectMessage(
  conversationId: string, body: { id: string; text: string }, signal: AbortSignal,
) {
  const id = encodeURIComponent(conversationId);
  return write(`/api/conversations/${id}/messages`, body, signal, appendReceiptSchema);
}

export async function checkDirectChange(
  conversationId: string, commandId: string, signal: AbortSignal,
) {
  const conversation = encodeURIComponent(conversationId);
  const command = encodeURIComponent(commandId);
  return read(`/api/conversations/${conversation}/changes/${command}`, signal, chatChangeSchema);
}

export async function fetchParticipants(conversationId: string, signal: AbortSignal) {
  const id = encodeURIComponent(conversationId);
  return read(`/api/conversations/${id}/participants`, signal, chatParticipantsSchema);
}

export async function changeParticipant(conversationId: string,
  body: z.infer<typeof chatParticipantCommandSchema>, signal: AbortSignal) {
  const id = encodeURIComponent(conversationId);
  return write(`/api/conversations/${id}/participants`, body, signal, appendReceiptSchema);
}

async function read<T>(url: string, signal: AbortSignal, schema: z.ZodType<T>)
  : Promise<DirectOutcome<T>> {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal });
    if (!response.ok) return failure(response.status);
    const raw: unknown = await response.json();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { kind: 'unavailable' };
    return { kind: 'ok', value: parsed.data };
  } catch {
    return { kind: 'unavailable' };
  }
}

async function write<T>(
  url: string, body: unknown, signal: AbortSignal, schema: z.ZodType<T>,
): Promise<DirectOutcome<T>> {
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal,
    });
    if (!response.ok) return failure(response.status);
    const raw: unknown = await response.json();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { kind: 'unavailable' };
    return { kind: 'ok', value: parsed.data };
  } catch {
    return { kind: 'unavailable' };
  }
}

function failure(status: number): DirectOutcome<never> {
  if (status === 425) return { kind: 'access_applying', status };
  if (status === 404) return { kind: 'not_found', status };
  if (status === 401 || status === 403) {
    return { kind: 'access_changed', status };
  }
  if (status === 400) return { kind: 'invalid', status };
  if (status === 409) return { kind: 'conflict', status };
  return { kind: 'unavailable', status };
}
