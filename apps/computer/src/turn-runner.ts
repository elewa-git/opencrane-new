import { createHash } from 'node:crypto';
import { modelForTask } from '@opencrane/models/routing';
import type { WorkspaceFile } from './files.ts';
import { record } from './http.ts';
import { reportJournal, type BridgeReport } from './report-journal.ts';
import { turnInput } from './turn-input.ts';

export interface Turn {
  id: string;
  conversationId: string;
  assistantId: string;
  requesterId?: string;
  text: string;
  token: string;
  expiresAt: number;
  taskKind: string;
  attachments?: unknown;
  omittedAttachments: number;
}

export interface TurnDriver {
  file?(file: WorkspaceFile, bytes: Buffer): Promise<void | 'kept_existing'>;
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
  grant(thread: string, conversation: string, token: string, expiresAt: number): Promise<void>;
  credential(): { value: string; expiresAt: number };
  journal: string;
}

interface TurnRunnerState {
  preparing: Map<string, Turn>;
  running: Map<string, Turn>;
  cancelled: Set<string>;
  codexTurns: Map<string, string>;
  waiting: Map<number, (grant: { token: string; expiresAt: number }) => void>;
}

function requiredString(value: Record<string, unknown>, name: string) {
  const result = value[name];
  if (typeof result !== 'string' || !result) {
    throw new Error('Invalid bridge field');
  }
  return result;
}

export function parseTurn(value: Record<string, unknown>): Turn {
  const expiresAt = value['expiresAt'];
  const taskKind = value['taskKind'] ?? 'chat_turn';
  const omittedAttachments = value['omittedAttachments'] ?? 0;
  if (typeof omittedAttachments !== 'number' || !Number.isSafeInteger(omittedAttachments)
    || omittedAttachments < 0) {
    throw new Error('Invalid attachment count');
  }
  if (typeof taskKind !== 'string') {
    throw new Error('Invalid task kind');
  }
  modelForTask(taskKind);
  if (typeof expiresAt !== 'number' || expiresAt <= Date.now()) {
    throw new Error('Expired turn');
  }
  const requesterId = value['requesterId'];
  if (requesterId !== undefined && (typeof requesterId !== 'string' || !requesterId)) {
    throw new Error('Invalid requester');
  }
  return {
    ...(typeof requesterId === 'string' ? { requesterId } : {}),
    id: requiredString(value, 'id'),
    conversationId: requiredString(value, 'conversationId'),
    assistantId: requiredString(value, 'assistantId'),
    text: requiredString(value, 'text'),
    token: requiredString(value, 'token'),
    expiresAt,
    taskKind,
    attachments: value['attachments'],
    omittedAttachments,
  };
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
  private readonly driver: TurnDriver;
  private readonly journal: ReturnType<typeof reportJournal>;
  private readonly send: (report: BridgeReport) => void;
  private readonly closeCurrentSocket: (code: number, reason: string) => void;
  private readonly state: TurnRunnerState = {
    preparing: new Map(),
    running: new Map(),
    cancelled: new Set(),
    codexTurns: new Map(),
    waiting: new Map(),
  };

  constructor(
    driver: TurnDriver,
    journal: ReturnType<typeof reportJournal>,
    send: (report: BridgeReport) => void,
    closeCurrentSocket: (code: number, reason: string) => void,
  ) {
    this.driver = driver;
    this.journal = journal;
    this.send = send;
    this.closeCurrentSocket = closeCurrentSocket;
    this.recover();
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
        && report.requesterId === input.requesterId && Boolean(report.threadId);
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
      if (this.isStarted(report) && this.mayHaveExecuted(report)
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
    return new Promise<{ token: string; expiresAt: number }>(registerWaiter);
  }

  private registerWaiter(
    sequence: number,
    previousStart: BridgeReport | undefined,
    resolve: (grant: { token: string; expiresAt: number }) => void,
    _reject: (reason?: unknown) => void,
  ) {
    this.state.waiting.set(sequence, resolve);
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

    // Reserve the conversation before thread/start so concurrent delivery cannot start it twice.
    this.state.preparing.set(input.conversationId, input);
    try {
      await this.prepareAndRun(input);
    } catch {
      this.appendReport(input, 'agent.turn_failed');
      deleteTurn(this.state, input.id);
    }
  }

  private async prepareAndRun(input: Turn) {
    const previousReport = this.lastThreadReport(input);
    const previousThread = previousReport?.threadId;
    let method: string;
    let params: Record<string, unknown>;
    if (previousThread) {
      method = 'thread/resume';
      params = { threadId: previousThread };
    } else {
      method = 'thread/start';
      params = {
        cwd: '/workspace',
        model: modelForTask(input.taskKind),
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      };
    }

    const response = record(await this.driver.rpc(method, params));
    const threadValue = record(response['thread'])['id'];
    if (typeof threadValue !== 'string') {
      throw new Error('Missing thread');
    }
    const threadId = threadValue;

    // Move the reservation synchronously before awaiting the first turn operation.
    // Another delivered turn can then see the conversation as active throughout.
    this.state.preparing.delete(input.conversationId);
    this.state.running.set(threadId, input);
    await this.runThread(input, threadId);
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
    await this.driver.grant(threadId, input.conversationId, grant.token, grant.expiresAt);
    if (this.state.cancelled.has(input.id)) {
      this.appendReport(input, 'agent.turn_failed');
      deleteTurn(this.state, input.id);
      await this.driver.grant(threadId, input.conversationId, '', 0);
      return;
    }

    // Mark execution only once grant is accepted; recovery leaves earlier prepared turns alone.
    this.journal.recordExecution(input.id);
    const inputText = await turnInput(input.text, input.conversationId, input.attachments,
      undefined, input.omittedAttachments);
    const turnParams = {
      threadId,
      model: modelForTask(input.taskKind),
      input: [{ type: 'text', text: inputText, text_elements: [] }],
    };
    const turnResponse = record(await this.driver.rpc('turn/start', turnParams));
    await this.rememberTurn(input, threadId, turnResponse);
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
      await this.driver.rpc('turn/interrupt', interruptParams);
    } catch {
      // Keep the active turn so a reconnect can retry Stop after the transport recovers.
      this.closeCurrentSocket(1011, 'Interrupt unavailable');
    }
  }

  acknowledge(sequence: unknown, value?: Record<string, unknown>) {
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)
      || sequence < 1 || sequence > this.journal.reports.length) {
      throw new Error('Invalid ack');
    }
    const resolve = this.state.waiting.get(sequence);
    if (resolve && typeof value?.['token'] === 'string'
      && typeof value['expiresAt'] === 'number' && value['expiresAt'] > Date.now()) {
      this.state.waiting.delete(sequence);
      resolve({ token: value['token'], expiresAt: value['expiresAt'] });
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
    await this.driver.rpc('turn/interrupt', interruptParams);
  }

  private findRunningThread(turnId: string) {
    for (const [threadId, turn] of this.state.running) {
      if (turn.id === turnId) {
        return threadId;
      }
    }
    return undefined;
  }

  private completedItem(input: Turn, params: Record<string, unknown>) {
    const completed = record(params['item']);
    if (completed['type'] === 'commandExecution' && typeof completed['command'] === 'string'
      && typeof completed['exitCode'] === 'number') {
      const commandHash = createHash('sha256');
      commandHash.update(completed['command']);
      const commandDigest = commandHash.digest('hex');
      this.appendReport(input, 'agent.command_ran', {
        commandDigest,
        exitCode: completed['exitCode'],
      });
    }
    if (completed['type'] === 'agentMessage' && typeof completed['text'] === 'string') {
      this.appendReport(input, 'agent.message_completed', {
        messageId: String(completed['id']),
        text: completed['text'],
      });
    }
  }

  complete(value: unknown) {
    const event = record(value);
    const params = record(event['params'] ?? {});
    const threadId = params['threadId'];
    if (typeof threadId !== 'string') {
      return;
    }
    const input = this.state.running.get(threadId);
    if (!input) {
      return;
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
    if (event['method'] === 'item/completed') {
      this.completedItem(input, params);
    }
    if (event['method'] !== 'turn/completed') {
      return;
    }
    this.completeTurn(input, threadId, params);
  }

  private completeTurn(input: Turn, threadId: string, params: Record<string, unknown>) {
    const turn = record(params['turn']);
    let reportType = 'agent.turn_failed';
    if (turn['status'] === 'completed') {
      reportType = 'agent.turn_completed';
    }
    this.appendReport(input, reportType);
    this.state.running.delete(threadId);
    void revokeGrant(this.driver, threadId, input.conversationId);
    this.state.codexTurns.delete(input.id);
    this.state.cancelled.delete(input.id);
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
) {
  return new TurnRunner(driver, journal, send, closeCurrentSocket);
}
