import type { Server, IncomingMessage } from 'node:http';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { timingSafeEqual, createHash } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { modelForTask } from '@opencrane/models/routing';
import { record } from './http.ts';

export interface BridgeReport {
  sequence: number; conversationId: string; turnId: string; assistantId: string;
  type: string; commandDigest?: string; exitCode?: number; threadId?: string; messageId?: string; text?: string;
}
interface Driver {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
  grant(thread: string, conversation: string, token: string, expiresAt: number): Promise<void>;
  credential(): { value: string; expiresAt: number };
  journal: string;
}
interface Turn { id: string; conversationId: string; assistantId: string; text: string; token: string; expiresAt: number; taskKind: string }
function string(value: Record<string, unknown>, name: string): string {
  const result = value[name]; if (typeof result !== 'string' || !result) throw new Error('Invalid bridge field'); return result;
}
function turn(value: Record<string, unknown>): Turn {
  const expiresAt = value['expiresAt'];
  const taskKind = value['taskKind'] ?? 'chat_turn';
  if (typeof taskKind !== 'string') throw new Error('Invalid task kind');
  modelForTask(taskKind); // Reject unknown task kinds at the bridge boundary.
  if (typeof expiresAt !== 'number' || expiresAt <= Date.now()) throw new Error('Expired turn');
  return { id: string(value, 'id'), conversationId: string(value, 'conversationId'), assistantId: string(value, 'assistantId'),
    text: string(value, 'text'), token: string(value, 'token'), expiresAt, taskKind };
}
function stored(line: string): BridgeReport {
  const value = record(JSON.parse(line) as unknown), sequence = value['sequence'];
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) throw new Error('Invalid journal');
  return { sequence, conversationId: string(value, 'conversationId'), turnId: string(value, 'turnId'), assistantId: string(value, 'assistantId'), type: string(value, 'type'),
    ...(typeof value['commandDigest'] === 'string' ? { commandDigest: value['commandDigest'] } : {}),
    ...(typeof value['exitCode'] === 'number' ? { exitCode: value['exitCode'] } : {}),
    ...(typeof value['threadId'] === 'string' ? { threadId: value['threadId'] } : {}),
    ...(typeof value['messageId'] === 'string' ? { messageId: value['messageId'] } : {}),
    ...(typeof value['text'] === 'string' ? { text: value['text'] } : {}) };
}

/** Durable reports are sent in arrival order; each thread waits only for its own start acknowledgement. */
export function bridgeChannel(server: Server, driver: Driver) {
  // ponytail: retain the small prototype outbox; compact acknowledged reports when volume warrants it.
  const reports: BridgeReport[] = existsSync(driver.journal) ? readFileSync(driver.journal, 'utf8').trim().split('\n').filter(Boolean).map(stored) : [];
  let socket: WebSocket | undefined, acknowledged = 0, resumed = false;
  const active = new Map<string, Turn>();
  const waiting = new Map<number, () => void>();
  const send = (report: BridgeReport) => {
    if (resumed && socket && socket.readyState === socket.OPEN) {
      if (socket.bufferedAmount > 1_048_576) { socket.close(1013); return; }
      socket.send(JSON.stringify(report));
    }
  };
  function report(input: Turn | BridgeReport, type: string, extra: Partial<BridgeReport> = {}) {
    const item: BridgeReport = { conversationId: input.conversationId, assistantId: input.assistantId,
      turnId: 'id' in input ? input.id : input.turnId, type, ...extra, sequence: reports.length + 1 };
    appendFileSync(driver.journal, JSON.stringify(item) + '\n', { mode: 0o600, flush: true });
    reports.push(item); send(item); return item.sequence;
  }
  // An interrupted process cannot know whether an external effect happened. Never replay a turn automatically.
  for (const item of [...reports]) {
    if (item.type === 'agent.turn_started' && !reports.some(r => r.turnId === item.turnId && ['agent.turn_completed', 'agent.turn_failed'].includes(r.type))) report(item, 'agent.turn_failed');
  }
  async function start(input: Turn) {
    if (reports.some(r => r.turnId === input.id) || [...active.values()].some(t => t.id === input.id)) return;
    if ([...active.values()].some(t => t.conversationId === input.conversationId)) return;
    // Mark preparation immediately; a second request cannot start the same conversation during thread/start.
    active.set(input.conversationId, input);
    try {
      const previous = reports.findLast(r => r.conversationId === input.conversationId && r.threadId)?.threadId;
      const response = record(await driver.rpc(previous ? 'thread/resume' : 'thread/start', previous
        ? { threadId: previous } : { cwd: '/workspace', model: modelForTask(input.taskKind), approvalPolicy: 'never', sandbox: 'danger-full-access' }));
      const thread = record(response['thread'])['id']; if (typeof thread !== 'string') throw new Error('Missing thread');
      active.delete(input.conversationId); active.set(thread, input);
      const sequence = report(input, 'agent.turn_started', { threadId: thread });
      await new Promise<void>(resolve => { if (acknowledged >= sequence) resolve(); else waiting.set(sequence, resolve); });
      await driver.grant(thread, input.conversationId, input.token, input.expiresAt);
      await driver.rpc('turn/start', { threadId: thread, model: modelForTask(input.taskKind), input: [{ type: 'text', text: input.text, text_elements: [] }] });
    } catch {
      report(input, 'agent.turn_failed');
      for (const [id, t] of active) if (t.id === input.id) active.delete(id);
    }
  }
  function acknowledge(sequence: unknown) {
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < acknowledged || sequence > reports.length) throw new Error('Invalid ack');
    acknowledged = sequence;
    for (const [position, resolve] of waiting) if (position <= sequence) { waiting.delete(position); resolve(); }
  }
  function resume(since: unknown) {
    if (typeof since !== 'number' || !Number.isSafeInteger(since) || since < 0 || since > reports.length) throw new Error('Sequence gap');
    acknowledged = 0; acknowledge(since); resumed = true;
    for (const item of reports.slice(since)) send(item);
  }
  const wss = new WebSocketServer({ server, path: '/bridge', maxPayload: 128 * 1024, verifyClient: (info: { req: IncomingMessage }) => {
    try {
      const credential = driver.credential(), expected = Buffer.from(credential.value), actual = Buffer.from(String(info.req.headers['x-bridge-token'] ?? ''));
      return credential.expiresAt > Date.now() && expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch { return false; }
  } });
  wss.on('connection', next => {
    socket?.terminate(); socket = next; resumed = false;
    const expiry = setTimeout(() => next.close(1008), Math.max(1, driver.credential().expiresAt - Date.now()));
    next.once('close', () => clearTimeout(expiry)); next.on('error', () => next.terminate());
    next.on('message', bytes => {
      try {
        if (socket !== next) return;
        const input = record(JSON.parse((Buffer.isBuffer(bytes) ? bytes : Buffer.concat(Array.isArray(bytes) ? bytes : [Buffer.from(bytes)])).toString()) as unknown);
        if (input['type'] === 'resume') resume(input['since']);
        else if (input['type'] === 'ack') acknowledge(input['sequence']);
        else if (input['type'] === 'turn' && resumed) void start(turn(input));
        else throw new Error('Invalid message');
      } catch { next.close(1008, 'Invalid bridge message'); }
    });
  });
  function completedItem(input: Turn, params: Record<string, unknown>) {
        const completed = record(params['item']);
        if (completed['type'] === 'commandExecution' && typeof completed['command'] === 'string' && typeof completed['exitCode'] === 'number') report(input, 'agent.command_ran', { commandDigest: createHash('sha256').update(completed['command']).digest('hex'), exitCode: completed['exitCode'] });
        if (completed['type'] === 'agentMessage' && typeof completed['text'] === 'string') report(input, 'agent.message_completed', { messageId: String(completed['id']), text: completed['text'] });
  }
  return {
    notification(value: unknown) {
      const event = record(value), params = record(event['params'] ?? {}), thread = params['threadId'];
      if (typeof thread !== 'string') return;
      const input = active.get(thread); if (!input) return;
      const item = typeof params['itemId'] === 'string' ? params['itemId'] : input.id;
      if (event['method'] === 'item/agentMessage/delta' && typeof params['delta'] === 'string') report(input, 'agent.message_delta', { messageId: item, text: params['delta'] });
      if (event['method'] === 'item/reasoning/summaryTextDelta' && typeof params['delta'] === 'string') report(input, 'agent.reasoning_summarised', { text: params['delta'] });
      if (event['method'] === 'item/completed') completedItem(input, params);
      if (event['method'] === 'turn/completed') {
        report(input, record(params['turn'])['status'] === 'completed' ? 'agent.turn_completed' : 'agent.turn_failed');
        active.delete(thread); void driver.grant(thread, input.conversationId, '', 0).catch(() => undefined);
      }
    },
    close: () => new Promise<void>(resolve => { for (const client of wss.clients) client.terminate(); wss.close(() => resolve()); }),
  };
}
