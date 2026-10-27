import type { approvalHolds } from './approval-holds.ts';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { record } from './http.ts';
import { wireReport, type BridgeReport } from './report-journal.ts';
import { parseTurn, type TurnDriver } from './turn-runner.ts';
import { filePackets } from './files.ts';

export interface BridgeSocketState {
  socket?: WebSocket;
  resumed: boolean;
}

interface TurnRunnerPort {
  gate: { readonly closed: boolean };
  stopBridge(value: Record<string, unknown>,
    accept: (value: Record<string, unknown>) => void): Promise<Record<string, unknown>>;
  start(turn: ReturnType<typeof parseTurn>): Promise<void>;
  prepareRoutine(value: Record<string, unknown>): Promise<Record<string, unknown>>;
  interrupt(value: Record<string, unknown>, cleared?: () => void): Promise<void>;
  connectionLost(): void;
  acknowledge(sequence: unknown, value?: Record<string, unknown>): void;
}

function verify(driver: TurnDriver, request: IncomingMessage) {
  try {
    const credential = driver.credential();
    let expected: Buffer;
    let actual = Buffer.from(String(request.headers['x-bridge-token'] ?? ''));
    if ('digest' in credential) {
      expected = Buffer.from(credential.digest, 'hex');
      const hash = createHash('sha256');
      hash.update(actual);
      actual = hash.digest();
    } else {
      expected = Buffer.from(credential.value);
    }
    if (credential.expiresAt <= Date.now() || expected.length !== actual.length
      || !timingSafeEqual(expected, actual)) return undefined;
    return { value: String(request.headers['x-bridge-token'] ?? ''),
      expiresAt: credential.expiresAt };
  } catch {
    return undefined;
  }
}

function parseMessage(bytes: Buffer | ArrayBuffer | Buffer[]) {
  let messageBytes: Buffer;
  if (Buffer.isBuffer(bytes)) {
    messageBytes = bytes;
  } else if (Array.isArray(bytes)) {
    messageBytes = Buffer.concat(bytes);
  } else {
    messageBytes = Buffer.from(bytes);
  }
  return record(JSON.parse(messageBytes.toString()) as unknown);
}

function receiveFileUnavailable() {
  return Promise.reject(new Error('File receiver unavailable'));
}

function createFileReceiver(driver: TurnDriver) {
  if (driver.file) {
    const receiveFile = driver.file.bind(driver);
    return filePackets(receiveFile);
  }
  return filePackets(receiveFileUnavailable);
}

function sendFileReceipt(next: WebSocket, receipt: unknown) {
  if (receipt && next.readyState === next.OPEN) {
    next.send(JSON.stringify(receipt));
  }
}

async function deliverFile(
  next: WebSocket,
  receiveFile: ReturnType<typeof filePackets>,
  input: Record<string, unknown>,
) {
  try {
    const receipt = await receiveFile(input);
    sendFileReceipt(next, receipt);
  } catch {
    next.close(1008, 'File delivery refused');
  }
}

async function interruptTurn(
  input: Record<string, unknown>,
  runner: TurnRunnerPort,
  next: WebSocket,
) {
  try {
    function cleared() {
      if (typeof input['threadId'] !== 'string') return;
      const receipt = { type: 'private_output_cleared', conversationId: input['conversationId'],
        turnId: input['turnId'], threadId: input['threadId'] };
      sendFileReceipt(next, receipt);
    }
    await runner.interrupt(input, cleared);
  } catch {
    next.close(1011, 'Interrupt unavailable');
  }
}

async function prepareRoutine(input: Record<string, unknown>, runner: TurnRunnerPort,
  next: WebSocket, resumed: boolean) {
  try {
    if (!resumed) throw new Error('Bridge not resumed');
    const reply = await runner.prepareRoutine(input);
    sendFileReceipt(next, reply);
  } catch {
    // Keep other conversations running when only this preparation fails.
    const refusal = { type: 'routine_prepare_refused', id: input['id'] };
    sendFileReceipt(next, refusal);
  }
}

function settleApproval(input: Record<string, unknown>,
  approvals: ReturnType<typeof approvalHolds> | undefined) {
  const approvalId = input['approvalId'];
  const approvalState = input['state'];
  if (typeof approvalId === 'string' && /^[a-f0-9]{64}$/u.test(approvalId)
    && typeof approvalState === 'string') {
    void approvals?.settle(approvalId, approvalState);
  }
}

function gateDispatch(input: Record<string, unknown>, next: WebSocket, runner: TurnRunnerPort) {
  const type = input['type'];
  if (type === 'bridge_gate') {
    function reply(value: Record<string, unknown>) { sendFileReceipt(next, value); }
    // Reply on this authenticated socket before reports resume. Repeat on every signed gate
    // so a lost connection cannot lose acceptance and delay the root supervisor stop.
    const receipt = runner.stopBridge(input, reply);
    void receipt.then(reply);
    return true;
  }
  if (runner.gate.closed && (type === 'turn'
    || (typeof type === 'string' && type.startsWith('file_')))) return true;
  return false;
}

function dispatch(
  input: Record<string, unknown>,
  next: WebSocket,
  state: BridgeSocketState,
  runner: TurnRunnerPort,
  receiveFile: ReturnType<typeof filePackets>,
  sendReports: (since: unknown) => void,
  approvals: ReturnType<typeof approvalHolds> | undefined,
) {
  const type = input['type'];
  if (gateDispatch(input, next, runner)) return;
  if (type === 'resume') {
    sendReports(input['since']);
    approvals?.resume(input['approvalWaiting'] === true);
    return;
  }
  if (type === 'approval_settled' && state.resumed) {
    settleApproval(input, approvals);
    return;
  }
  if (type === 'ack') {
    runner.acknowledge(input['sequence'], input);
    return;
  }
  if (typeof type === 'string' && type.startsWith('file_') && state.resumed) {
    void deliverFile(next, receiveFile, input);
    return;
  }
  if (type === 'turn' && state.resumed) {
    void runner.start(parseTurn(input));
    return;
  }
  if (type === 'routine_prepare') {
    void prepareRoutine(input, runner, next, state.resumed);
    return;
  }
  if (type === 'stop' && state.resumed) {
    void interruptTurn(input, runner, next);
    return;
  }
  throw new Error('Invalid message');
}

function installHandlers(
  next: WebSocket,
  expiresAt: number,
  state: BridgeSocketState,
  driver: TurnDriver,
  runner: TurnRunnerPort,
  sendReports: (since: unknown) => void,
  approvals: ReturnType<typeof approvalHolds> | undefined,
) {
  if (state.socket) {
    state.resumed = false;
    runner.connectionLost();
    state.socket.terminate();
  }
  state.socket = next;
  state.resumed = false;
  const receiveFile = createFileReceiver(driver);
  const expiry = setTimeout(closeForCredentialExpiry(next),
    Math.max(1, expiresAt - Date.now()));
  function closed() {
    clearTimeout(expiry);
    if (state.socket !== next) return;
    delete state.socket;
    state.resumed = false;
    runner.connectionLost();
  }
  next.once('close', closed);
  next.on('error', terminateSocket(next));
  next.on('message', receiveMessage(next, state, runner, receiveFile, sendReports, approvals));
}

function closeForCredentialExpiry(next: WebSocket) {
  return function closeExpiredSocket() {
    next.close(4001, 'Credential expired');
  };
}

function terminateSocket(next: WebSocket) {
  return function terminateOnSocketError() {
    next.terminate();
  };
}

function receiveMessage(
  next: WebSocket,
  state: BridgeSocketState,
  runner: TurnRunnerPort,
  receiveFile: ReturnType<typeof filePackets>,
  sendReports: (since: unknown) => void,
  approvals: ReturnType<typeof approvalHolds> | undefined,
) {
  return function handleMessage(bytes: Buffer | ArrayBuffer | Buffer[]) {
    try {
      if (state.socket !== next) {
        return;
      }
      const input = parseMessage(bytes);
      dispatch(input, next, state, runner, receiveFile, sendReports, approvals);
    } catch {
      next.close(1008, 'Invalid bridge message');
    }
  };
}

function installConnectionHandler(
  accepted: WeakMap<IncomingMessage, { value: string; expiresAt: number }>,
  state: BridgeSocketState,
  driver: TurnDriver,
  runner: TurnRunnerPort,
  sendReports: (since: unknown) => void,
  approvals: ReturnType<typeof approvalHolds> | undefined,
) {
  return function handleConnection(next: WebSocket, request: IncomingMessage) {
    const credential = accepted.get(request);
    if (!credential || credential.expiresAt <= Date.now()) {
      next.terminate();
      return;
    }
    driver.authenticated?.(credential.value);
    installHandlers(next, credential.expiresAt, state, driver, runner, sendReports, approvals);
  };
}

export function bridgeSocket(
  server: Server,
  driver: TurnDriver,
  state: BridgeSocketState,
  runner: TurnRunnerPort,
  reportCount: () => number,
  replayReports: (since: number, send: (report: BridgeReport) => void) => void,
  approvals?: ReturnType<typeof approvalHolds>,
) {
  const pending = new Map<number, BridgeReport>();
  const inFlight = new Map<number, number>();
  let inFlightBytes = 0;

  function flushReports() {
    const socket = state.socket;
    if (!state.resumed || !socket || socket.readyState !== socket.OPEN) return;
    // Leave room below the server's 64-report limit so Stop can share this connection.
    for (const [sequence, report] of pending) {
      if (inFlight.size >= 32) return;
      if (socket.bufferedAmount > 1_048_576) {
        socket.close(1013);
        return;
      }
      const frame = JSON.stringify(wireReport(report));
      const bytes = Buffer.byteLength(frame);
      if (inFlightBytes + bytes > 524_288 && inFlight.size > 0) return;
      pending.delete(sequence);
      inFlight.set(sequence, bytes);
      inFlightBytes += bytes;
      socket.send(frame);
    }
  }

  function send(report: BridgeReport) {
    if (!state.resumed || inFlight.has(report.sequence)) return;
    pending.set(report.sequence, report);
    flushReports();
  }

  function acknowledge(sequence: unknown, value?: Record<string, unknown>) {
    runner.acknowledge(sequence, value);
    if (typeof sequence !== 'number') return;
    inFlightBytes -= inFlight.get(sequence) ?? 0;
    inFlight.delete(sequence);
    flushReports();
  }

  const pacedRunner: TurnRunnerPort = {
    gate: runner.gate,
    stopBridge: runner.stopBridge.bind(runner),
    start: runner.start.bind(runner),
    prepareRoutine: runner.prepareRoutine.bind(runner),
    interrupt: runner.interrupt.bind(runner),
    connectionLost: runner.connectionLost.bind(runner),
    acknowledge,
  };

  function resume(since: unknown) {
    if (typeof since !== 'number' || !Number.isSafeInteger(since) || since < 0
      || since > reportCount()) {
      throw new Error('Sequence gap');
    }
    pending.clear();
    inFlight.clear();
    inFlightBytes = 0;
    state.resumed = true;
    replayReports(since, send);
  }

  // Keep the expiry checked at authentication, even if rotation happens during the upgrade.
  const accepted = new WeakMap<IncomingMessage, { value: string; expiresAt: number }>();
  function verifyClient(info: { req: IncomingMessage }) {
    const credential = verify(driver, info.req);
    if (!credential) return false;
    accepted.set(info.req, credential);
    return true;
  }

  const wss = new WebSocketServer({
    server,
    path: '/bridge',
    maxPayload: 128 * 1024,
    verifyClient,
  });
  const handleConnection = installConnectionHandler(accepted, state, driver, pacedRunner,
    resume, approvals);
  function advertiseSupport(headers: string[]) {
    if (approvals) headers.push('x-opencrane-approval-waiting: true');
  }
  wss.on('headers', advertiseSupport);
  wss.on('connection', handleConnection);

  function close() {
    state.resumed = false;
    runner.connectionLost();
    function closeWebSocketServer(resolve: () => void) {
      for (const client of wss.clients) {
        client.terminate();
      }
      function resolveClosed() {
        resolve();
      }
      wss.close(resolveClosed);
    }
    return new Promise<void>(closeWebSocketServer);
  }

  return { send, close };
}
