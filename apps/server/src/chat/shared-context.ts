import { z } from 'zod';
import type { StoredEvent } from '@opencrane/event-store';

const maximumBytes = 24 * 1024;
type Exchange = { at: string; member: string; assistant: string[] }
  | { at: string; outcome: 'not_completed' };
type Turn = { message: StoredEvent; replies: StoredEvent[]; completed: boolean; lost: boolean };

export function sharedContext(rows: StoredEvent[], message: StoredEvent,
  decrypt: (data: unknown) => string) {
  const turns = new Map<string, Turn>();
  for (const row of rows) {
    const data = z.record(z.string(), z.unknown()).parse(row.event.data);
    const turnId = data['turnId'];
    // Keep retries stable when more reports arrive after the first saved start.
    if (row.event.type === 'agent.turn_started' && turnId === message.event.id) break;
    if (row.event.type === 'message.posted') {
      if (row.sequence < message.sequence && data['authorKind'] === 'human'
        && isText(data)) {
        const turn: Turn = { message: row, replies: [], completed: false, lost: false };
        turns.set(row.event.id, turn);
      }
      continue;
    }
    const turn = typeof turnId === 'string' ? turns.get(turnId) : undefined;
    if (turn) applyReport(turn, row, data);
  }
  if (!turns.size) return undefined;
  const result = { exchanges: [] as Exchange[], omittedExchanges: turns.size };
  const newestFirst = [...turns.values()].reverse();
  for (const turn of newestFirst) {
    const exchange = exchangeFor(turn, decrypt);
    result.exchanges.unshift(exchange);
    result.omittedExchanges--;
    if (Buffer.byteLength(JSON.stringify(result)) > maximumBytes) {
      result.exchanges.shift();
      result.omittedExchanges++;
      break;
    }
  }
  return result;
}

function isText(data: Record<string, unknown>) {
  return data['contentType'] === 'text' || data['contentType'] === 'markdown';
}

function applyReport(turn: Turn, row: StoredEvent, data: Record<string, unknown>) {
  const type = row.event.type;
  if (type === 'agent.turn_completed') turn.completed = true;
  if (['agent.output_lost', 'agent.turn_failed', 'agent.turn_stop_requested'].includes(type)) {
    turn.lost = true;
  }
  if (type === 'agent.message_completed' && isText(data)) turn.replies.push(row);
}

function exchangeFor(turn: Turn, decrypt: (data: unknown) => string): Exchange {
  const at = turn.message.event.time;
  if (!turn.completed || turn.lost) return { at, outcome: 'not_completed' };
  const assistant: string[] = [];
  for (const reply of turn.replies) assistant.push(decrypt(reply.event.data));
  return { at, member: decrypt(turn.message.event.data), assistant };
}
