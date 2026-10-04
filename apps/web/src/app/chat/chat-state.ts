import { z } from 'zod';
import type { ChatRow } from '@opencrane/protocol';

export interface Turn {
  id: string; author: 'you' | 'person' | 'agent'; text: string; time: string; endedAt?: string;
  state: 'working' | 'done' | 'failed' | 'stopped';
  tools: { id: string; label: string; detail: string; failed: boolean; time: string }[];
  files: string[]; refusal?: string;
}

/** Rendering is a replay of server rows. Stop freezes only its turn, at the recorded position. */
export function transcript(rows: ChatRow[], memberId: string): Turn[] {
  const turns: Turn[] = [], agents = new Map<string, Turn>(), messages = new Map<string, Map<string, string>>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const file = uploadedFile(row);
    if (file) {
      turns.push({ id: row.id, author: file.uploadedBy === memberId ? 'you' : 'person', text: '', time: row.time, state: 'done', tools: [], files: [file.path] });
      continue;
    }
    const data = row.data;
    if (row.type === 'message.posted') {
      turns.push({ id: row.id, author: data.authorId === memberId ? 'you' : 'person', text: data.text ?? '', time: row.time, state: 'done', tools: [], files: [] });
      const agent: Turn = { id: row.id, author: 'agent', text: '', time: row.time, state: 'working', tools: [], files: [] };
      turns.push(agent); agents.set(row.id, agent); messages.set(row.id, new Map());
      continue;
    }
    const turn = agents.get(data.turnId ?? '');
    if (!turn || turn.state === 'stopped') continue;
    if (row.type === 'agent.turn_stop_requested') { turn.state = 'stopped'; turn.endedAt = row.time; continue; }
    if (row.type === 'decision.recorded' && data.reason === 'budget_exhausted') turn.refusal = 'Spending limit reached. Ask an Owner or Admin to raise the budget, or wait for the next budget period.';
    updateTurn(turn, row, messages.get(turn.id)!);
  }
  return turns;
}

function updateTurn(turn: Turn, row: ChatRow, parts: Map<string, string>): void {
  const data = row.data;
    if (['agent.turn_completed', 'agent.turn_failed'].includes(row.type)) turn.endedAt = row.time;
    if (row.type === 'agent.turn_failed') turn.tools.push({ id: row.id, label: 'Reply failed', detail: 'Run interrupted', failed: true, time: row.time });
    if (row.type === 'agent.turn_completed') turn.state = 'done';
    if (row.type === 'agent.turn_failed') turn.state = 'failed';
    if (row.type === 'agent.command_ran') turn.tools.push({ id: row.id, label: data.exitCode === 0 ? 'Command completed' : 'Command failed',
      detail: `Exit code ${data.exitCode ?? 'unknown'}`, failed: data.exitCode !== 0, time: row.time });
    if (row.type === 'agent.file_changed' && data.path) turn.files.push(data.path);
    if (['agent.message_delta', 'agent.message_completed'].includes(row.type)) {
      const id = data.messageId ?? row.id;
      parts.set(id, (row.type === 'agent.message_delta' ? parts.get(id) ?? '' : '') + (data.text ?? ''));
      turn.text = [...parts.values()].join('\n\n');
    }
}

const attachment = z.object({ conversationId: z.string(), fileId: z.string(), name: z.string(), mime: z.string(), uploadedBy: z.string(), screenshot: z.object({ computerId: z.string(), generation: z.number(), capturedAt: z.string() }).optional() });
export function uploadedFile(row: ChatRow) {
  if (row.type !== 'file.uploaded') return undefined;
  const parsed = attachment.safeParse(row.data);
  if (!parsed.success) return undefined;
  const file = parsed.data, path = `uploads/${file.conversationId}/${file.fileId}/${file.name}`;
  return { ...file, path, textPath: file.mime === 'application/pdf' ? `${path}.md` : path };
}
