import { z } from 'zod';
import type { StoredEvent } from '@opencrane/event-store';

type CompletedExchange = { at: string; member: string; assistant: string[] };
type UnfinishedExchange = { at: string; outcome: 'not_completed' };
export type PrivateContext = {
  exchanges: (CompletedExchange | UnfinishedExchange)[];
  omittedExchanges: number;
};
export const PRIVATE_CONTEXT_LIMIT_BYTES = 24 * 1024;

function eventData(row: StoredEvent) {
  const data = row.event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return z.record(z.string(), z.unknown()).parse(data);
}

// Read replies across the stream. An earlier turn can finish after the next message is posted.
export function privateContext(rows: StoredEvent[], message: StoredEvent, requesterId: string,
  decrypt: (data: unknown) => string): PrivateContext | undefined {
  const messages: StoredEvent[] = [];
  const completed = new Set<string>();
  const lost = new Set<string>();
  const memoryTurns = new Set<string>();
  const replies = new Map<string, StoredEvent[]>();
  for (const row of rows) {
    const type = row.event.type;
    if (type === 'message.posted') {
      if (isEarlierMessage(row, message, requesterId)) {
        messages.push(row);
      }
      continue;
    }
    if (type === 'agent.memory_context_recorded') {
      const turnId = eventData(row)['turnId'];
      if (typeof turnId === 'string') memoryTurns.add(turnId);
      continue;
    }
    if (!['agent.turn_completed', 'agent.output_lost', 'agent.message_completed'].includes(type)) {
      continue;
    }
    const turnId = eventData(row)['turnId'];
    if (typeof turnId !== 'string' || turnId === message.event.id) continue;
    if (type === 'agent.turn_completed') completed.add(turnId);
    if (type === 'agent.output_lost') lost.add(turnId);
    if (type === 'agent.message_completed') {
      const texts = replies.get(turnId) ?? [];
      texts.push(row);
      replies.set(turnId, texts);
    }
  }
  // Exclude the whole turn before decryption, including replies saved before its first recall.
  for (const turnId of memoryTurns) replies.delete(turnId);
  if (!messages.length) return undefined;
  const result: PrivateContext = { exchanges: [], omittedExchanges: messages.length };
  for (const earlier of messages.reverse()) {
    const exchange = exchangeFor(earlier, completed, lost, replies, decrypt);
    result.exchanges.unshift(exchange);
    result.omittedExchanges--;
    if (Buffer.byteLength(JSON.stringify(result)) > PRIVATE_CONTEXT_LIMIT_BYTES) {
      result.exchanges.shift();
      result.omittedExchanges++;
      break;
    }
  }
  return result;
}

function exchangeFor(message: StoredEvent, completed: Set<string>, lost: Set<string>,
  replies: Map<string, StoredEvent[]>, decrypt: (data: unknown) => string) {
  const at = message.event.time;
  const turnId = message.event.id;
  if (!completed.has(turnId) || lost.has(turnId)) {
    return { at, outcome: 'not_completed' as const };
  }
  const assistant: string[] = [];
  for (const reply of replies.get(turnId) ?? []) assistant.push(decrypt(reply.event.data));
  return { at, member: decrypt(message.event.data), assistant };
}


function isEarlierMessage(row: StoredEvent, message: StoredEvent, requesterId: string) {
  const data = eventData(row);
  return row.sequence < message.sequence && row.event.id !== message.event.id
    && data['authorKind'] === 'human' && data['authorId'] === requesterId;
}
