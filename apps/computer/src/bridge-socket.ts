import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { record } from './http.ts';
import type { BridgeReport } from './report-journal.ts';
import { parseTurn, type TurnDriver } from './turn-runner.ts';
import { filePackets } from './files.ts';

export interface BridgeSocketState {
  socket?: WebSocket;
  resumed: boolean;
}

interface TurnRunnerPort {
  start(turn: ReturnType<typeof parseTurn>): Promise<void>;
  interrupt(value: Record<string, unknown>): Promise<void>;
  acknowledge(sequence: unknown, value?: Record<string, unknown>): void;
}

function verify(driver: TurnDriver, request: IncomingMessage) {
  try {
    const credential = driver.credential();
    const expected = Buffer.from(credential.value);
    const actual = Buffer.from(String(request.headers['x-bridge-token'] ?? ''));
    return credential.expiresAt > Date.now() && expected.length === actual.length
      && timingSafeEqual(expected, actual);
  } catch {
    return false;
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
    await runner.interrupt(input);
  } catch {
    next.close(1011, 'Interrupt unavailable');
  }
}

function dispatch(
  input: Record<string, unknown>,
  next: WebSocket,
  state: BridgeSocketState,
  runner: TurnRunnerPort,
  receiveFile: ReturnType<typeof filePackets>,
  sendReports: (since: unknown) => void,
) {
  const type = input['type'];
  if (type === 'resume') {
    sendReports(input['since']);
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
  if (type === 'stop' && state.resumed) {
    void interruptTurn(input, runner, next);
    return;
  }
  throw new Error('Invalid message');
}

function installHandlers(
  next: WebSocket,
  state: BridgeSocketState,
  driver: TurnDriver,
  runner: TurnRunnerPort,
  sendReports: (since: unknown) => void,
) {
  state.socket?.terminate();
  state.socket = next;
  state.resumed = false;
  const receiveFile = createFileReceiver(driver);
  const expiry = setTimeout(closeForCredentialExpiry(next),
    Math.max(1, driver.credential().expiresAt - Date.now()));
  next.once('close', clearExpiry(expiry));
  next.on('error', terminateSocket(next));
  next.on('message', receiveMessage(next, state, runner, receiveFile, sendReports));
}

function closeForCredentialExpiry(next: WebSocket) {
  return function closeExpiredSocket() {
    next.close(4001, 'Credential expired');
  };
}

function clearExpiry(expiry: NodeJS.Timeout) {
  return function clearSocketExpiry() {
    clearTimeout(expiry);
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
) {
  return function handleMessage(bytes: Buffer | ArrayBuffer | Buffer[]) {
    try {
      if (state.socket !== next) {
        return;
      }
      const input = parseMessage(bytes);
      dispatch(input, next, state, runner, receiveFile, sendReports);
    } catch {
      next.close(1008, 'Invalid bridge message');
    }
  };
}

function installConnectionHandler(
  state: BridgeSocketState,
  driver: TurnDriver,
  runner: TurnRunnerPort,
  sendReports: (since: unknown) => void,
) {
  return function handleConnection(next: WebSocket) {
    installHandlers(next, state, driver, runner, sendReports);
  };
}

export function bridgeSocket(
  server: Server,
  driver: TurnDriver,
  state: BridgeSocketState,
  runner: TurnRunnerPort,
  reportCount: () => number,
  replayReports: (since: number, send: (report: BridgeReport) => void) => void,
) {
  function send(report: BridgeReport) {
    const socket = state.socket;
    if (!state.resumed || !socket || socket.readyState !== socket.OPEN) {
      return;
    }
    if (socket.bufferedAmount > 1_048_576) {
      socket.close(1013);
      return;
    }
    socket.send(JSON.stringify(report));
  }

  function resume(since: unknown) {
    if (typeof since !== 'number' || !Number.isSafeInteger(since) || since < 0
      || since > reportCount()) {
      throw new Error('Sequence gap');
    }
    state.resumed = true;
    replayReports(since, send);
  }

  function verifyClient(info: { req: IncomingMessage }) {
    return verify(driver, info.req);
  }

  const wss = new WebSocketServer({
    server,
    path: '/bridge',
    maxPayload: 128 * 1024,
    verifyClient,
  });
  const handleConnection = installConnectionHandler(state, driver, runner, resume);
  wss.on('connection', handleConnection);

  function close() {
    function closeWebSocketServer(resolve: () => void) {
      for (const client of wss.clients) client.terminate();
      function resolveClosed() {
        resolve();
      }
      wss.close(resolveClosed);
    }
    return new Promise<void>(closeWebSocketServer);
  }

  return { send, close };
}
