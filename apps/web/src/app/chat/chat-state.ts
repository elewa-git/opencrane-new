import { z } from 'zod';
import type { ChatRow } from '@opencrane/protocol';

export interface Turn {
  id: string; author: 'you' | 'person' | 'agent'; text: string; time: string; endedAt?: string;
  state: 'working' | 'done' | 'failed' | 'stopped' | 'lost';
  tools: ToolActivityRecord[];
  files: string[]; budgetStop?: 'budget_exhausted'; screenshotRejected?: true;
  reason?: string; executionMode?: 'restricted' | 'memory_free';
}

export interface ChatAttachment {
  conversationId: string;
  fileId: string;
  name: string;
  size: number;
  mime: string;
  uploadedBy: string;
  screenshot?: {
    computerId: string;
    generation: number;
    capturedAt: string;
    width: number;
    height: number;
  } | undefined;
  path: string;
  textPath: string;
}

export interface ToolActivityRecord {
  id: string;
  label: string;
  detail: string;
  failed: boolean;
  time: string;
}

export function toolKind(record: ToolActivityRecord): string {
  if (record.label === 'Reply failed') {
    return 'Agent run';
  }
  return 'Computer command';
}

/** Rendering is a replay of server rows. Stop freezes only its turn, at the recorded position. */
export function transcript(rows: ChatRow[], memberId: string): Turn[] {
  const turns: Turn[] = [], agents = new Map<string, Turn>(), messages = new Map<string, Map<string, string>>();
  const seen = new Set<string>();
  const lostOutput = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const file = uploadedFile(row);
    if (file) {
      turns.push({ id: row.id, author: file.uploadedBy === memberId ? 'you' : 'person', text: '', time: row.time, state: 'done', tools: [], files: [file.path] });
      continue;
    }
    const rejected = rejectedScreenshotTurn(row, memberId);
    if (rejected) {
      turns.push(rejected);
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
    if (row.type === 'decision.recorded' && data.reason === 'budget_exhausted') {
      turn.budgetStop = 'budget_exhausted';
    }
    updateTurn(turn, row, messages.get(turn.id)!, lostOutput);
  }
  return turns;
}

function updateTurn(turn: Turn, row: ChatRow, parts: Map<string, string>,
  lostOutput: Set<string>): void {
  updateTurnOutcome(turn, row, lostOutput);
  updateTurnTools(turn, row);
  if (row.type === 'agent.file_changed') addAvailableFile(turn, row.data);
  updateTurnText(turn, row, parts);
}

function updateTurnOutcome(turn: Turn, row: ChatRow, lostOutput: Set<string>): void {
  if (row.type === 'agent.turn_started') {
    turn.executionMode = row.data['executionMode'] === 'restricted' ? 'restricted' : 'memory_free';
    return;
  }
  if (row.type === 'agent.output_lost') {
    lostOutput.add(row.data.turnId ?? '');
    turn.state = 'lost';
    turn.endedAt = row.time;
    return;
  }
  if (row.type === 'agent.turn_failed') {
    turn.state = 'failed';
    turn.endedAt = row.time;
    if (row.data.reason) turn.reason = row.data.reason;
    return;
  }
  if (row.type === 'agent.turn_completed') {
    turn.state = lostOutput.has(turn.id) ? 'lost' : 'done';
    turn.endedAt = row.time;
  }
}

function updateTurnTools(turn: Turn, row: ChatRow): void {
  if (row.type === 'agent.turn_failed') {
    turn.tools.push({ id: row.id, label: 'Reply failed',
      detail: row.data.reason ?? 'Run interrupted', failed: true, time: row.time });
    return;
  }
  if (row.type !== 'agent.command_ran') return;
  const succeeded = row.data.exitCode === 0;
  const label = succeeded ? 'Command completed' : 'Command failed';
  turn.tools.push({ id: row.id, label, detail: `Exit code ${row.data.exitCode ?? 'unknown'}`,
    failed: !succeeded, time: row.time });
}

function updateTurnText(turn: Turn, row: ChatRow, parts: Map<string, string>): void {
  if (!['agent.message_delta', 'agent.message_completed'].includes(row.type)) return;
  const messageId = row.data.messageId ?? row.id;
  let text = row.data.text ?? '';
  if (row.type === 'agent.message_delta') {
    text = `${parts.get(messageId) ?? ''}${text}`;
  }
  parts.set(messageId, text);
  turn.text = [...parts.values()].join('\n\n');
}

function addAvailableFile(turn: Turn, data: ChatRow['data']): void {
  if (!data.path || data['changeType'] === 'deleted') return;
  turn.files.push(data.path);
}

const attachment = z.object({ conversationId: z.string(), fileId: z.string(), name: z.string(),
  size: z.number(), mime: z.string(), uploadedBy: z.string(), screenshot: z.object({
    computerId: z.string(), generation: z.number(), capturedAt: z.string(), width: z.number(),
    height: z.number(),
  }).optional() });
const rejectedScreenshotSchema = z.object({ fileId: z.string(), uploadedBy: z.string(),
  screenshot: z.object({ capturedAt: z.string() }) });
export function uploadedFile(row: ChatRow) {
  if (row.type !== 'file.uploaded') return undefined;
  const parsed = attachment.safeParse(row.data);
  if (!parsed.success) return undefined;
  const file = parsed.data, path = `uploads/${file.conversationId}/${file.fileId}/${file.name}`;
  return { ...file, path, textPath: file.mime === 'application/pdf' ? `${path}.md` : path };
}

function rejectedScreenshot(
  row: ChatRow,
): { fileId: string; uploadedBy: string; capturedAt: string } | undefined {
  if (row.type !== 'file.rejected') return undefined;
  const parsed = rejectedScreenshotSchema.safeParse(row.data);
  if (!parsed.success) return undefined;
  return { fileId: parsed.data.fileId, uploadedBy: parsed.data.uploadedBy,
    capturedAt: parsed.data.screenshot.capturedAt };
}

function rejectedScreenshotTurn(row: ChatRow, memberId: string): Turn | undefined {
  const rejected = rejectedScreenshot(row);
  if (!rejected) return undefined;
  return {
    id: row.id,
    author: rejected.uploadedBy === memberId ? 'you' : 'person',
    text: '',
    time: row.time,
    state: 'done',
    tools: [],
    files: [],
    screenshotRejected: true,
  };
}

export function rejectedScreenshotIds(rows: ChatRow[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    const rejected = rejectedScreenshot(row);
    if (rejected) ids.push(rejected.fileId);
  }
  return ids;
}
