/* eslint-disable max-lines -- Keep approval renewal and release beside the turn state they share. */
import type { approvalHolds } from './approval-holds.ts';
import { modelForTask } from '@opencrane/models/routing';
import type { WorkspaceFile } from './files.ts';
import { record } from './http.ts';
import { reportJournal, type BridgeReport } from './report-journal.ts';
import { requiredString, type Turn } from './turn-frame.ts';
export { parseTurn } from './turn-frame.ts';
export type { Turn } from './turn-frame.ts';
import { itemReport } from './item-reports.ts';
import { turnInput, privateTurnInput } from './turn-input.ts';
import { threadLoads, ThreadLoadFailed, type ThreadLoadDriver } from './thread-loads.ts';

const MAX_PRIVATE_TURNS = 2;
const PRIVATE_ITEM_TYPES = new Set(['userMessage', 'agentMessage', 'reasoning', 'contextCompaction']);
type Grant = { token: string; expiresAt: number; context?: unknown };
export interface PrivateSession {
  rpc(this: void, method: string, params: Record<string, unknown>): Promise<unknown>;
  close(this: void): void;
  closed: Promise<void>;
}

export interface TurnDriver extends ThreadLoadDriver {
  privateSession?(): Promise<PrivateSession>;
  file?(file: WorkspaceFile, bytes: Buffer): Promise<void | 'kept_existing'>;
  grant(thread: string, conversation: string, token: string, expiresAt: number): Promise<void>;
  credential(): { value: string; expiresAt: number };
  journal: string;
}

interface TurnRunnerState {
  preparing: Map<string, Turn>;
  running: Map<string, Turn>;
  cancelled: Set<string>;
  codexTurns: Map<string, string>;
  waiting: Map<number, (grant: Grant | Error) => void>;
  sessions: Map<string, PrivateSession>;
  refusedTools: Set<string>;
}

function containsTurn(turns: Iterable<Turn>, turnId: string) {
  for (const turn of turns) {
    if (turn.id === turnId) {
      return true;
    }
  }
  return false;
}

function findTurn(state: TurnRunnerState, turnId: string, conversationId: string) {
  const preparingTurn = state.preparing.get(conversationId);
  if (preparingTurn?.id === turnId) {
    return preparingTurn;
  }
  const runningTurns = state.running.values();
  for (const runningTurn of runningTurns) {
    if (runningTurn.id === turnId && runningTurn.conversationId === conversationId) {
      return runningTurn;
    }
  }
  return undefined;
}

function deleteTurn(state: TurnRunnerState, turnId: string) {
  for (const [conversationId, turn] of state.preparing) {
    if (turn.id === turnId) {
      state.preparing.delete(conversationId);
    }
  }
  for (const [threadId, turn] of state.running) {
    if (turn.id === turnId) {
      state.running.delete(threadId);
    }
  }
}

class TurnRunner {
  private readonly renewals = new Map<string, Promise<void>>();
  private readonly driver: TurnDriver;
  private readonly approvals: Pick<ReturnType<typeof approvalHolds>, 'endThread'> | undefined;
  private readonly loads: ReturnType<typeof threadLoads>;
  private readonly journal: ReturnType<typeof reportJournal>;
  private readonly send: (report: BridgeReport) => void;
  private readonly closeCurrentSocket: (code: number, reason: string) => void;
  private readonly signal: (value: Record<string, unknown>) => void;
  private readonly state: TurnRunnerState = {
    preparing: new Map(),
    running: new Map(),
    cancelled: new Set(),
    codexTurns: new Map(),
    waiting: new Map(),
    sessions: new Map(),
    refusedTools: new Set(),
  };

  constructor(
    driver: TurnDriver,
    journal: ReturnType<typeof reportJournal>,
    send: (report: BridgeReport) => void,
    closeCurrentSocket: (code: number, reason: string) => void,
    signal: (value: Record<string, unknown>) => void,
    approvals: Pick<ReturnType<typeof approvalHolds>, 'endThread'> | undefined,
  ) {
    this.driver = driver;
    this.approvals = approvals;
    this.signal = signal;
    this.loads = threadLoads(driver);
    this.journal = journal;
    this.send = send;
    this.closeCurrentSocket = closeCurrentSocket;
    this.recover();
  }


  approvalWaiting(thread: string, approvalId: string) {
    const turn = this.state.running.get(thread);
    if (!turn || this.state.cancelled.has(turn.id)) return false;
    const value = { type: 'approval_waiting', approvalId,
      conversationId: turn.conversationId, turnId: turn.id };
    this.signal(value);
    return true;
  }

  renew(thread: string) {
    const existing = this.renewals.get(thread);
    if (existing) return existing;
    const pending = this.renewGrant(thread);
    const clear = this.renewals.delete.bind(this.renewals, thread);
    const renewal = pending.finally(clear);
    this.renewals.set(thread, renewal);
    return renewal;
  }

  private async renewGrant(thread: string) {
    const turn = this.state.running.get(thread);
    const started = turn && this.lastStartedReport(turn.id);
    if (!turn || !started || this.state.cancelled.has(turn.id)) throw new Error('Turn ended');
    const pending = this.waitForGrant(started.sequence, started);
    const expire = this.expireRenewal.bind(this, started.sequence);
    const timer = setTimeout(expire, 10_000);
    try {
      const grant = await pending;
      if (this.state.running.get(thread) !== turn || this.state.cancelled.has(turn.id)) {
        throw new Error('Turn ended');
      }
      await this.driver.grant(thread, turn.conversationId, grant.token, grant.expiresAt);
    } finally { clearTimeout(timer); }
  }

  private expireRenewal(sequence: number) {
    const settle = this.state.waiting.get(sequence);
    this.state.waiting.delete(sequence);
    settle?.(new Error('No new turn pass'));
  }

  get waiting() {
    return this.state.waiting;
  }

  private appendReport(input: Turn | BridgeReport, type: string,
    extra: Partial<BridgeReport> = {}) {
    const report = this.journal.append(input, type, extra);
    this.send(report);
    return report;
  }

  private isFinished(turnId: string) {
    function reportFinishesTurn(report: BridgeReport) {
      return report.turnId === turnId
        && (report.type === 'agent.turn_completed' || report.type === 'agent.turn_failed');
    }
    return this.journal.reports.some(reportFinishesTurn);
  }

  private mayHaveExecuted(report: BridgeReport) {
    // A prepared turn has no execution marker and can safely wait for a fresh delivery.
    // Older journals lack that marker, so their started turns are uncertain and must fail.
    return this.journal.executions.has(report.turnId) || report.previousSequence === undefined;
  }

  private isStarted(report: BridgeReport) {
    return report.type === 'agent.turn_started';
  }

  private lastThreadReport(input: Turn) {
    function reportHasThread(report: BridgeReport) {
      return report.conversationId === input.conversationId
        && report.requesterId === input.requesterId && Boolean(report.threadId)
        && report.executionMode !== 'restricted';
    }
    return this.journal.findLast(reportHasThread);
  }

  private lastStartedReport(turnId: string) {
    function reportStartedTurn(report: BridgeReport) {
      return report.turnId === turnId && report.type === 'agent.turn_started';
    }
    return this.journal.findLast(reportStartedTurn);
  }

  private recover() {
    for (const report of [...this.journal.reports]) {
      // Fail private work because its old thread and process died with the bridge.
      // Re-running it would start new work without the member asking.
      if (this.isStarted(report)
        && (report.executionMode === 'restricted' || this.mayHaveExecuted(report))
        && !this.isFinished(report.turnId)) {
        this.journal.append(report, 'agent.turn_failed');
      }
    }
  }

  private hasActiveConversation(conversationId: string) {
    if (this.state.preparing.has(conversationId)) {
      return true;
    }
    for (const turn of this.state.running.values()) {
      if (turn.conversationId === conversationId) {
        return true;
      }
    }
    return false;
  }

  private isActiveTurn(turnId: string) {
    return containsTurn(this.state.preparing.values(), turnId)
      || containsTurn(this.state.running.values(), turnId);
  }

  private waitForGrant(sequence: number, previousStart?: BridgeReport) {
    const registerWaiter = this.registerWaiter.bind(this, sequence, previousStart);
    return new Promise<Grant>(registerWaiter);
  }

  private registerWaiter(
    sequence: number,
    previousStart: BridgeReport | undefined,
    resolve: (grant: Grant) => void,
    reject: (reason?: unknown) => void,
  ) {
    function settle(grant: Grant | Error) {
      if (grant instanceof Error) {
        reject(grant);
      } else {
        resolve(grant);
      }
    }
    this.state.waiting.set(sequence, settle);
    if (previousStart) {
      this.send(previousStart);
    }
  }

  async start(input: Turn) {
    if (this.isFinished(input.id) || this.isActiveTurn(input.id)) {
      return;
    }
    if (this.hasActiveConversation(input.conversationId)) {
      return;
    }

    if (input.executionMode === 'restricted' && this.privateTurnCount() >= MAX_PRIVATE_TURNS) {
      return;
    }
    const previousStart = this.lastStartedReport(input.id);
    if (previousStart && (previousStart.executionMode ?? 'memory_free') !== input.executionMode) {
      this.appendReport(input, 'agent.turn_failed');
      return;
    }
    // Reserve the conversation before thread/start so concurrent delivery cannot start it twice.
    this.state.preparing.set(input.conversationId, input);
    try {
      await this.prepareAndRun(input);
    } catch (error) {
      if (error instanceof ThreadLoadFailed) {
        const text = 'The tools for this conversation could not be reloaded. '
          + 'Send your message again.';
        this.appendReport(input, 'agent.message_completed', { messageId: input.id, text });
      }
      this.failTurn(input);
    }
  }

  private privateTurnCount() {
    let count = 0;
    for (const turn of this.state.preparing.values()) {
      if (turn.executionMode === 'restricted') count++;
    }
    for (const turn of this.state.running.values()) {
      if (turn.executionMode === 'restricted') count++;
    }
    return count;
  }

  private rpcFor(turn: Turn) {
    if (turn.executionMode !== 'restricted') return this.driver.rpc.bind(this.driver);
    const session = this.state.sessions.get(turn.id);
    if (!session) throw new Error('Missing private session');
    return session.rpc;
  }

  private releaseTurn(turnId: string) {
    const threadId = this.findRunningThread(turnId);
    const turn = threadId && this.state.running.get(threadId);
    if (threadId) this.approvals?.endThread(threadId);
    deleteTurn(this.state, turnId);
    this.state.codexTurns.delete(turnId);
    this.state.cancelled.delete(turnId);
    this.state.refusedTools.delete(turnId);
    const session = this.state.sessions.get(turnId);
    this.state.sessions.delete(turnId);
    session?.close();
    for (const [sequence, settle] of this.state.waiting) {
      if (this.journal.reports[sequence - 1]?.turnId !== turnId) continue;
      this.state.waiting.delete(sequence);
      settle(new Error('Turn ended'));
    }
    if (threadId && turn) {
      void releaseLoad(this.loads, this.driver, threadId, turn.conversationId);
    }
  }

  private failTurn(input: Turn) {
    if (!this.isFinished(input.id)) {
      const extra: Partial<BridgeReport> = {};
      if (this.state.refusedTools.has(input.id)) extra.reason = 'restricted_tool_refused';
      this.appendReport(input, 'agent.turn_failed', extra);
    }
    this.releaseTurn(input.id);
  }

  private privateSessionClosed(input: Turn) {
    if (this.isActiveTurn(input.id)) this.failTurn(input);
  }

  private async preparePrivateThread(input: Turn) {
    if (!this.driver.privateSession) throw new Error('Private sessions unavailable');
    const session = await this.driver.privateSession();
    this.state.sessions.set(input.id, session);
    const sessionClosed = this.privateSessionClosed.bind(this, input);
    void session.closed.then(sessionClosed, sessionClosed);
    const params = { model: modelForTask(input.taskKind), approvalPolicy: 'never',
      sandbox: 'read-only', ephemeral: true, environments: [] };
    const response = record(await session.rpc('thread/start', params));
    const thread = record(response['thread']);
    const environments = thread['environments'];
    if (thread['ephemeral'] !== true || thread['path'] !== null
      || (environments !== undefined && (!Array.isArray(environments) || environments.length))) {
      session.close();
      throw new Error('Private thread is not ephemeral');
    }
    return response;
  }

  private async prepareAndRun(input: Turn) {
    let response: Record<string, unknown>;
    if (input.executionMode === 'restricted') response = await this.preparePrivateThread(input);
    else response = await this.prepareMemoryFreeThread(input);
    if (!this.isActiveTurn(input.id)) return;
    const threadValue = record(response['thread'])['id'];
    if (typeof threadValue !== 'string') throw new Error('Missing thread');
    const activeTurn = this.state.running.get(threadValue);
    if (activeTurn && (input.executionMode === 'restricted'
      || activeTurn.executionMode === 'restricted')) {
      throw new Error('Private thread is already active');
    }
    this.state.preparing.delete(input.conversationId);
    this.state.running.set(threadValue, input);
    await this.runThread(input, threadValue);
  }

  private async prepareMemoryFreeThread(input: Turn) {
    const previousReport = this.lastThreadReport(input);
    const previousThread = previousReport?.threadId;
    const params = { cwd: '/workspace', model: modelForTask(input.taskKind),
      approvalPolicy: 'never', sandbox: 'danger-full-access' };
    return this.loads.load(input, previousThread, params);
  }

  private async runThread(input: Turn, threadId: string) {
    const previousStart = this.lastStartedReport(input.id);
    let sequence: number;
    if (previousStart) {
      sequence = previousStart.sequence;
    } else {
      const startedReport = this.appendReport(input, 'agent.turn_started', { threadId });
      sequence = startedReport.sequence;
    }

    const grant = await this.waitForGrant(sequence, previousStart);
    if (!this.isActiveTurn(input.id)) return;
    await this.driver.grant(threadId, input.conversationId, grant.token, grant.expiresAt);
    if (!this.isActiveTurn(input.id)) return;
    if (this.state.cancelled.has(input.id)) {
      this.failTurn(input);
      await this.driver.grant(threadId, input.conversationId, '', 0);
      return;
    }

    const inputText = await this.inputFor(input, grant.context);
    if (!this.isActiveTurn(input.id)) return;
    // Mark execution after validating the input. Memory-free prepared turns can still retry.
    this.journal.recordExecution(input.id);
    const turnParams = {
      threadId,
      model: modelForTask(input.taskKind),
      input: [{ type: 'text', text: inputText, text_elements: [] }],
    };
    const turnResponse = record(await this.rpcFor(input)('turn/start', turnParams));
    await this.rememberTurn(input, threadId, turnResponse);
  }

  private async inputFor(input: Turn, context: unknown) {
    if (input.executionMode === 'restricted') {
      if ((input.attachments !== undefined
        && (!Array.isArray(input.attachments) || input.attachments.length > 0))
        || input.omittedAttachments > 0) throw new Error('Private attachments refused');
      return privateTurnInput(input.text, context);
    }
    if (context !== undefined) throw new Error('Private context on memory-free turn');
    return turnInput(input.text, input.conversationId, input.attachments,
      undefined, input.omittedAttachments);
  }

  private async rememberTurn(input: Turn, threadId: string, result: Record<string, unknown>) {
    const turnResult = result['turn'];
    if (!turnResult || !this.state.running.has(threadId)) {
      return;
    }
    const codexTurnId = requiredString(record(turnResult), 'id');
    this.state.codexTurns.set(input.id, codexTurnId);
    if (!this.state.cancelled.has(input.id)) {
      return;
    }
    try {
      const interruptParams = { threadId, turnId: codexTurnId };
      await this.rpcFor(input)('turn/interrupt', interruptParams);
    } catch {
      if (input.executionMode === 'restricted') {
        this.state.sessions.get(input.id)?.close();
        return;
      }
      // Keep the active turn so a reconnect can retry Stop after the transport recovers.
      this.closeCurrentSocket(1011, 'Interrupt unavailable');
    }
  }

  acknowledge(sequence: unknown, value?: Record<string, unknown>) {
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)
      || sequence < 1 || sequence > this.journal.reports.length) {
      throw new Error('Invalid ack');
    }
    this.journal.forgetText(sequence);
    const resolve = this.state.waiting.get(sequence);
    if (resolve && typeof value?.['refused'] === 'string') {
      this.state.waiting.delete(sequence);
      resolve(new Error(value['refused']));
      return;
    }
    if (resolve && typeof value?.['token'] === 'string'
      && typeof value['expiresAt'] === 'number' && value['expiresAt'] > Date.now()) {
      this.state.waiting.delete(sequence);
      resolve({ token: value['token'], expiresAt: value['expiresAt'], context: value['context'] });
    }
  }

  async interrupt(value: Record<string, unknown>) {
    const turnId = requiredString(value, 'turnId');
    const conversationId = requiredString(value, 'conversationId');
    const input = findTurn(this.state, turnId, conversationId);
    if (!input) {
      return;
    }

    this.state.cancelled.add(turnId);
    const heldThread = this.findRunningThread(turnId);
    if (heldThread) this.approvals?.endThread(heldThread);
    const codexTurnId = this.state.codexTurns.get(turnId);
    if (!codexTurnId) {
      return;
    }
    const threadId = this.findRunningThread(turnId);
    if (!threadId) {
      return;
    }
    // Leave the turn in the running map if interrupt fails so a reconnect can retry Stop.
    const interruptParams = { threadId, turnId: codexTurnId };
    try {
      await this.rpcFor(input)('turn/interrupt', interruptParams);
    } catch (error) {
      if (input.executionMode !== 'restricted') throw error;
      this.state.sessions.get(input.id)?.close();
    }
  }

  private findRunningThread(turnId: string) {
    for (const [threadId, turn] of this.state.running) {
      if (turn.id === turnId) {
        return threadId;
      }
    }
    return undefined;
  }

  private releaseClosedThread(threadId: string, input: Turn | undefined) {
    if (input) this.failTurn(input);
    else void releaseLoad(this.loads, this.driver, threadId, '');
  }

  complete(value: unknown) {
    const event = record(value);
    const params = record(event['params'] ?? {});
    const threadId = params['threadId'];
    if (typeof threadId !== 'string') {
      return;
    }
    const input = this.state.running.get(threadId);
    if (event['method'] === 'thread/closed') {
      this.releaseClosedThread(threadId, input);
      return;
    }
    if (!input) {
      return;
    }

    if (input.executionMode === 'restricted'
      && ['item/started', 'item/completed'].includes(String(event['method']))) {
      const item = record(params['item']);
      if (!PRIVATE_ITEM_TYPES.has(String(item['type']))) {
        this.refuseTool(input, threadId);
        return;
      }
    }
    let itemId = input.id;
    if (typeof params['itemId'] === 'string') {
      itemId = params['itemId'];
    }
    if (event['method'] === 'item/agentMessage/delta' && typeof params['delta'] === 'string') {
      this.appendReport(input, 'agent.message_delta', { messageId: itemId, text: params['delta'] });
    }
    if (event['method'] === 'item/reasoning/summaryTextDelta' && typeof params['delta'] === 'string') {
      this.appendReport(input, 'agent.reasoning_summarised', { text: params['delta'] });
    }
    const report = itemReport(input, params, event['method']);
    if (report) this.appendReport(input, report.type, report.data);
    if (event['method'] !== 'turn/completed') {
      return;
    }
    this.completeTurn(input, threadId, params);
  }

  private refuseTool(input: Turn, threadId: string) {
    if (this.state.refusedTools.has(input.id)) return;
    this.state.refusedTools.add(input.id);
    const session = this.state.sessions.get(input.id);
    const codexTurnId = this.state.codexTurns.get(input.id);
    if (!codexTurnId) { session?.close(); return; }
    function interruptFailed() { session?.close(); }
    const params = { threadId, turnId: codexTurnId };
    void this.rpcFor(input)('turn/interrupt', params).catch(interruptFailed);
  }

  private completeTurn(input: Turn, _threadId: string, params: Record<string, unknown>) {
    const turn = record(params['turn']);
    if (this.state.refusedTools.has(input.id) || turn['status'] !== 'completed') {
      this.failTurn(input);
      return;
    }
    this.appendReport(input, 'agent.turn_completed');
    this.releaseTurn(input.id);
  }
}

async function releaseLoad(loads: ReturnType<typeof threadLoads>, driver: TurnDriver,
  threadId: string, conversationId: string) {
  // Start revocation before waiting so a slow catalogue drop does not delay it.
  const revoking = revokeGrant(driver, threadId, conversationId);
  try {
    await loads.forget(threadId);
  } catch {
    // Keep the independent grant revocation and catalogue expiry after a failed drop.
  } finally {
    await revoking;
  }
}

async function revokeGrant(driver: TurnDriver, threadId: string, conversationId: string) {
  try {
    await driver.grant(threadId, conversationId, '', 0);
  } catch {
    // The completed report is durable; a later grant refresh cannot revive the finished turn.
  }
}

export function turnRunner(
  driver: TurnDriver,
  journal: ReturnType<typeof reportJournal>,
  send: (report: BridgeReport) => void,
  closeCurrentSocket: (code: number, reason: string) => void,
  signal: (value: Record<string, unknown>) => void = ignoreSignal,
  approvals?: Pick<ReturnType<typeof approvalHolds>, 'endThread'>,
) {
  return new TurnRunner(driver, journal, send, closeCurrentSocket, signal, approvals);
}

function ignoreSignal() {}
