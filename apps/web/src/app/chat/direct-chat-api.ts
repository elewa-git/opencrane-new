import {
  chatChangeSchema, chatColleaguesSchema, chatContextSchema, chatFeedSchema,
  chatListSchema, chatParticipantCommandSchema, chatParticipantsSchema, chatStateCommandSchema,
} from '@opencrane/protocol';
import type { ChatRow } from '@opencrane/protocol';
import { z } from 'zod';
import { findConversation } from './conversations-data';

export type DirectFailure = 'access_changed' | 'refused' | 'invalid' | 'conflict'
  | 'unavailable' | 'access_applying' | 'not_found';
export type DirectOutcome<T> = { kind: 'ok'; value: T }
  | { kind: DirectFailure; status?: number };

const appendReceiptSchema = z.object({ status: z.literal('appended'), sequence: z.int().positive() });

export async function fetchChatContext(signal: AbortSignal) {
  return read('/api/chat', signal, chatContextSchema);
}

export async function fetchDirectConversations(signal: AbortSignal) {
  return read('/api/conversations', signal, chatListSchema, fetchConversationRead);
}

export async function fetchDirectPageAndRequested(requestedId: string, signal: AbortSignal) {
  const page = await fetchDirectConversations(signal);
  if (page.kind !== 'ok') return page;
  let requested = page.value.rows.find(row => row.conversationId === requestedId);
  if (requestedId && !requested) {
    try {
      requested = await findConversation(requestedId, fetch, signal) ?? undefined;
    } catch (error) {
      if (error instanceof Error && error.message === 'access_changed') {
        return { kind: 'access_changed' as const };
      }
      const lookupFailure = error instanceof Error && error.message === 'list_changed'
        ? 'changed' as const : 'unavailable' as const;
      return { kind: 'ok' as const, value: {
        ...page.value, requested: undefined, lookupFailure,
      } };
    }
  }
  return { kind: 'ok' as const, value: { ...page.value, requested, lookupFailure: false } };
}

export async function searchColleagues(query: string, signal: AbortSignal, after = '') {
  const params = new URLSearchParams({ q: query, limit: '20' });
  if (after) params.set('after', after);
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
    const result = await read(url, signal, chatFeedSchema, fetchConversationRead);
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
  fetcher: typeof fetch = fetch,
) {
  const conversation = encodeURIComponent(conversationId);
  const command = encodeURIComponent(commandId);
  return read(`/api/conversations/${conversation}/changes/${command}`, signal,
    chatChangeSchema, fetcher);
}

export async function changeArchive(conversationId: string,
  body: Extract<z.infer<typeof chatStateCommandSchema>, { action: 'archive' }>,
  signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const id = encodeURIComponent(conversationId);
  return write(`/api/conversations/${id}/state`, body, signal, appendReceiptSchema, fetcher);
}

export async function changeRead(conversationId: string,
  body: Extract<z.infer<typeof chatStateCommandSchema>, { action: 'read' }>,
  signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const id = encodeURIComponent(conversationId);
  return write(`/api/conversations/${id}/state`, body, signal, appendReceiptSchema, fetcher);
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

// Retry only conversation reads whose saved rows or permissions are still being applied.
// Keep POSTs and access refusals outside this retry loop.
async function fetchConversationRead(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(10_000);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const request = { ...init, signal };
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    const response = await fetch(url, request);
    if ((response.status !== 425 && response.status !== 409) || attempt === 49) return response;
    await response.body?.cancel();
    await waitForConversationRead(signal);
  }
}

function waitForConversationRead(signal: AbortSignal): Promise<void> {
  return new Promise<void>(scheduleRetry);

  function scheduleRetry(resolve: () => void): void {
    const timer = globalThis.setTimeout(finish, 100);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();

    function finish(): void {
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  }
}

async function read<T>(url: string, signal: AbortSignal, schema: z.ZodType<T>,
  fetcher: typeof fetch = fetch)
  : Promise<DirectOutcome<T>> {
  try {
    const response = await fetcher(url, { headers: { accept: 'application/json' }, signal });
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
  fetcher: typeof fetch = fetch,
): Promise<DirectOutcome<T>> {
  try {
    const response = await fetcher(url, {
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
