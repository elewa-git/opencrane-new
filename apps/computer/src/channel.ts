import type { Server, IncomingMessage } from 'node:http';
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { timingSafeEqual, createHash } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { modelForTask } from '@opencrane/models/routing';
import { record } from './http.ts';

export interface BridgeReport {
  sequence: number; previousSequence?: number; conversationId: string; turnId: string; assistantId: string;
  type: string; commandDigest?: string; exitCode?: number; threadId?: string; messageId?: string; text?: string;
}
interface Driver {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
  grant(thread: string, conversation: string, token: string, expiresAt: number): Promise<void>;
  credential(): { value: string; expiresAt: number };
  journal: string;
  localControl?: (action: 'pause' | 'resume', leaseId: string) => Promise<void>;
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
  return { sequence, ...(typeof value['previousSequence'] === 'number' ? { previousSequence: value['previousSequence'] } : {}), conversationId: string(value, 'conversationId'), turnId: string(value, 'turnId'), assistantId: string(value, 'assistantId'), type: string(value, 'type'),
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
  const executions = new Set(existsSync(`${driver.journal}.executions`) ? readFileSync(`${driver.journal}.executions`, 'utf8').trim().split('\n') : []);
  let socket: WebSocket | undefined, resumed = false;
  let pauseId = existsSync(`${driver.journal}.paused`) ? readFileSync(`${driver.journal}.paused`, 'utf8').trim() : undefined;
  let paused = Boolean(pauseId);
  const active = new Map<string, Turn>();
  const cancelled = new Set<string>();
  const codexTurns = new Map<string, string>();
  const waiting = new Map<number, (grant: { token: string; expiresAt: number }) => void>();
  const send = (report: BridgeReport) => {
    if (resumed && socket && socket.readyState === socket.OPEN) {
      if (socket.bufferedAmount > 1_048_576) { socket.close(1013); return; }
      socket.send(JSON.stringify(report));
    }
  };
  function report(input: Turn | BridgeReport, type: string, extra: Partial<BridgeReport> = {}) {
    const item: BridgeReport = { conversationId: input.conversationId, assistantId: input.assistantId,
      turnId: 'id' in input ? input.id : input.turnId, type, ...extra, previousSequence: reports.findLast(r => r.conversationId === input.conversationId)?.sequence ?? 0, sequence: reports.length + 1 };
    appendFileSync(driver.journal, JSON.stringify(item) + '\n', { mode: 0o600, flush: true });
    reports.push(item); send(item); return item.sequence;
  }
  // Prepared turns can retry. Executing turns (and older journals without that distinction) have an uncertain effect.
  for (const item of [...reports]) {
    if (item.type === 'agent.turn_started' && (executions.has(item.turnId) || item.previousSequence === undefined) && !reports.some(r => r.turnId === item.turnId && ['agent.turn_completed', 'agent.turn_failed'].includes(r.type))) report(item, 'agent.turn_failed');
  }
  const cancelledTurn = (input: Turn) => paused || cancelled.has(input.id);
  async function prepareGrant(thread: string, input: Turn, grant: { token: string; expiresAt: number }) {
    if (!paused) await driver.grant(thread, input.conversationId, grant.token, grant.expiresAt);
  }
  async function start(input: Turn) {
    if (paused) return;
    if (reports.some(r => r.turnId === input.id && ['agent.turn_completed', 'agent.turn_failed'].includes(r.type)) || [...active.values()].some(t => t.id === input.id)) return;
    if ([...active.values()].some(t => t.conversationId === input.conversationId)) return;
    // Mark preparation immediately; a second request cannot start the same conversation during thread/start.
    active.set(input.conversationId, input);
    try {
      const previous = reports.findLast(r => r.conversationId === input.conversationId && r.threadId)?.threadId;
      const response = record(await driver.rpc(previous ? 'thread/resume' : 'thread/start', previous
        ? { threadId: previous } : { cwd: '/workspace', model: modelForTask(input.taskKind), approvalPolicy: 'never', sandbox: 'danger-full-access' }));
      const thread = record(response['thread'])['id']; if (typeof thread !== 'string') throw new Error('Missing thread');
      active.delete(input.conversationId); active.set(thread, input);
      const previousStart = reports.find(r => r.turnId === input.id && r.type === 'agent.turn_started');
      const sequence = previousStart?.sequence ?? report(input, 'agent.turn_started', { threadId: thread });
      const grant = await new Promise<{ token: string; expiresAt: number }>(resolve => {
        waiting.set(sequence, resolve); if (previousStart) send(previousStart);
      });
      await prepareGrant(thread, input, grant);
      if (cancelledTurn(input)) {
        report(input, 'agent.turn_failed'); active.delete(thread);
        await driver.grant(thread, input.conversationId, '', 0); return;
      }
      appendFileSync(`${driver.journal}.executions`, input.id + '\n', { mode: 0o600, flush: true });
      executions.add(input.id);
      const result = record(await driver.rpc('turn/start', { threadId: thread, model: modelForTask(input.taskKind), input: [{ type: 'text', text: input.text, text_elements: [] }] }));
      await rememberTurn(input, thread, result);
    } catch {
      report(input, 'agent.turn_failed');
      for (const [id, t] of active) if (t.id === input.id) active.delete(id);
    }
  }
  async function rememberTurn(input: Turn, thread: string, result: Record<string, unknown>) {
    if (!result['turn'] || !active.has(thread)) return;
    const id = string(record(result['turn']), 'id'); codexTurns.set(input.id, id);
    // An interrupt failure says nothing about execution. Reconnect and retry Stop with the active turn intact.
    if (cancelled.has(input.id)) await driver.rpc('turn/interrupt', { threadId: thread, turnId: id })
      .catch(() => socket?.close(1011, 'Interrupt unavailable'));
  }
  function acknowledge(sequence: unknown, value?: Record<string, unknown>) {
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > reports.length) throw new Error('Invalid ack');
    const resolve = waiting.get(sequence);
    if (resolve && typeof value?.['token'] === 'string' && typeof value['expiresAt'] === 'number' && value['expiresAt'] > Date.now()) {
      waiting.delete(sequence); resolve({ token: value['token'], expiresAt: value['expiresAt'] });
    }
  }
  async function interrupt(value: Record<string, unknown>) {
    const id = string(value, 'turnId'), conversationId = string(value, 'conversationId');
    const entry = [...active].find(([, input]) => input.id === id && input.conversationId === conversationId);
    if (!entry) return;
    cancelled.add(id);
    const turnId = codexTurns.get(id);
    if (turnId) await driver.rpc('turn/interrupt', { threadId: entry[0], turnId });
  }
  function resume(since: unknown) {
    if (typeof since !== 'number' || !Number.isSafeInteger(since) || since < 0 || since > reports.length) throw new Error('Sequence gap');
    resumed = true;
    for (const item of reports) if (item.sequence > since || waiting.has(item.sequence)) send(item);
  }
  async function pause(leaseId: string) {
    pauseId = leaseId; paused = true;
    writeFileSync(`${driver.journal}.paused`, leaseId, { mode: 0o600, flush: true });
    if (!driver.localControl) throw new Error('Local pause unavailable');
    const local = driver.localControl('pause', leaseId);
    for (const input of active.values()) cancelled.add(input.id);
    // Wake prepared turns without minting a grant. A late acknowledgement cannot restart them.
    for (const resolve of waiting.values()) resolve({ token: '', expiresAt: 0 });
    waiting.clear();
    await Promise.all([local, ...[...active].map(async ([thread, input]) => {
      await driver.grant(thread, input.conversationId, '', 0);
      const turnId = codexTurns.get(input.id);
      if (turnId) await driver.rpc('turn/interrupt', { threadId: thread, turnId });
    })]);
    const deadline = Date.now() + 10_000;
    while (active.size) {
      if (Date.now() >= deadline) throw new Error('Pause timeout');
      await delay(20);
    }
  }
  async function release(leaseId: string) {
    if (!paused) return;
    if (leaseId !== pauseId) throw new Error('Pause changed');
    if (active.size || !driver.localControl) throw new Error('Not quiescent');
    await driver.localControl('resume', leaseId);
    if (leaseId !== pauseId) throw new Error('Pause changed');
    rmSync(`${driver.journal}.paused`, { force: true }); paused = false;
  }
  const wss = new WebSocketServer({ server, path: '/bridge', maxPayload: 128 * 1024, verifyClient: (info: { req: IncomingMessage }) => {
    try {
      const credential = driver.credential(), expected = Buffer.from(credential.value), actual = Buffer.from(String(info.req.headers['x-bridge-token'] ?? ''));
      return credential.expiresAt > Date.now() && expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch { return false; }
  } });
  wss.on('connection', next => {
    socket?.terminate(); socket = next; resumed = false;
    const expiry = setTimeout(() => next.close(4001, 'Credential expired'), Math.max(1, driver.credential().expiresAt - Date.now()));
    next.once('close', () => clearTimeout(expiry)); next.on('error', () => next.terminate());
    next.on('message', bytes => {
      try {
        if (socket !== next) return;
        const input = record(JSON.parse((Buffer.isBuffer(bytes) ? bytes : Buffer.concat(Array.isArray(bytes) ? bytes : [Buffer.from(bytes)])).toString()) as unknown);
        if (input['type'] === 'resume') resume(input['since']);
        else if (input['type'] === 'ack') acknowledge(input['sequence'], input);
        else if (input['type'] === 'turn' && resumed) void start(turn(input));
        else if (input['type'] === 'stop' && resumed) void interrupt(input).catch(() => next.close(1011, 'Interrupt unavailable'));
        else if (input['type'] === 'pause' && resumed) void pause(string(input, 'id')).then(() => next.send(JSON.stringify({ type: 'paused', id: input['id'] })), () => next.close(1011, 'Pause unavailable'));
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
    pause, release,
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
        codexTurns.delete(input.id); cancelled.delete(input.id);
      }
    },
    close: () => new Promise<void>(resolve => { for (const client of wss.clients) client.terminate(); wss.close(() => resolve()); }),
  };
}
