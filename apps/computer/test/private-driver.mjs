import { WebSocket } from '/app/node_modules/ws/wrapper.mjs';
import { createInterface } from 'node:readline';
import { connect } from 'node:net';
import { request } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { codexConnection } from '/app/src/codex-connection.ts';

let socket;
let since = Number(process.env.P414_SINCE ?? 0);
const settings = new Map();
const textReportTypes = ['agent.message_delta', 'agent.message_completed',
  'agent.reasoning_summarised'];

function write(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}
function socketFailed() {
  socket.terminate();
}
function receiveReport(raw) {
  const report = JSON.parse(raw.toString());
  const setting = settings.get(report.turnId) ?? {};
  let acknowledged = true;
  if (setting.hold && textReportTypes.includes(report.type)) acknowledged = false;
  write({ report, acknowledged });
  if (!acknowledged) return;
  const acknowledgement = { type: 'ack', sequence: report.sequence,
    token: 'probe-turn', expiresAt: Date.now() + 120_000 };
  if (report.type === 'agent.turn_started' && setting.context !== undefined) {
    acknowledgement.context = setting.context;
  }
  socket.send(JSON.stringify(acknowledgement));
}
function fixtureCredential() {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = { typ: 'computer', jti: 'probe', iat: issuedAt, exp: issuedAt + 600 };
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
  const payload = Buffer.from(JSON.stringify(claims));
  const content = `${header.toString('base64url')}.${payload.toString('base64url')}`;
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const signingOptions = { key: keyPair.privateKey, dsaEncoding: 'ieee-p1363' };
  const signature = sign('sha256', Buffer.from(content), signingOptions);
  const value = `${content}.${signature.toString('base64url')}`;
  return { id: claims.jti, value, expiresAt: claims.exp * 1000 };
}

async function open() {
  // Deliver through the root process started by authenticated Pod exec, as the server does.
  const credential = fixtureCredential();
  const argumentsForInstaller = ['-u', 'NODE_OPTIONS', '/usr/local/bin/node',
    '--disable-sigusr1', '--experimental-strip-types', '/app/src/install-credential.ts'];
  const installerOptions = { input: JSON.stringify(credential), stdio: ['pipe', 'ignore', 'ignore'] };
  execFileSync('/usr/bin/env', argumentsForInstaller, installerOptions);
  const headers = { 'x-bridge-token': credential.value };
  socket = new WebSocket('ws://127.0.0.1:8081/bridge', { headers });
  socket.on('error', socketFailed);
  socket.on('message', receiveReport);
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'resume', since }));
}
async function grant(threadId) {
  const options = { socketPath: '/run/codex/control.sock', path: '/grant', method: 'POST' };
  const value = { thread: threadId, computer: 'probe-computer', token: 'probe-turn',
    expires: Date.now() + 120_000 };
  function send(resolve, reject) {
    function receive(response) {
      response.resume();
      if (response.statusCode !== 200) {
        reject(new Error('Probe grant refused'));
        return;
      }
      response.on('end', resolve);
    }
    const outgoing = request(options, receive);
    outgoing.on('error', reject);
    outgoing.end(JSON.stringify(value));
  }
  await new Promise(send);
}
function eventName(event) {
  return event.method;
}
function isTurnCompleted(event) {
  return event.method === 'turn/completed';
}
function isCompactionCompleted(event) {
  if (event.method === 'thread/compacted') return true;
  return event.method === 'item/completed' && event.params?.item?.type === 'contextCompaction';
}
async function waitForNotification(notifications, predicate, after = 0) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const recent = notifications.slice(after);
    if (recent.some(predicate)) return true;
    await delay(20);
  }
  return false;
}
async function compact(connection, notifications, data) {
  const options = { model: 'gpt-6.1-sol', approvalPolicy: 'never',
    sandbox: 'read-only', ephemeral: true, environments: [] };
  const response = await connection.rpc('thread/start', options);
  const threadId = response.thread.id;
  await grant(threadId);
  const input = [{ type: 'text', text: data.text, text_elements: [] }];
  await connection.rpc('turn/start', { threadId, input });
  if (!await waitForNotification(notifications, isTurnCompleted)) {
    throw new Error('Probe turn timed out');
  }
  const previousCount = notifications.length;
  await connection.rpc('thread/compact/start', { threadId });
  return waitForNotification(notifications, isCompactionCompleted, previousCount);
}
async function direct(data) {
  if (process.getuid() !== 1000) {
    process.setgroups([]);
    process.setgid(1000);
    process.setuid(1000);
  }
  const started = performance.now();
  const session = connect('/run/executor/private.sock');
  const notifications = [];
  function received(message) {
    if (message.id !== undefined && typeof message.method === 'string') {
      connection.reply(message.id, { code: -32601,
        message: 'Not available in a private turn' });
      return;
    }
    notifications.push(message);
  }
  function failed() {
    session.destroy();
  }
  const connection = codexConnection(session, session, { message: received, failed });
  try {
    await once(session, 'connect');
    const options = { clientInfo: { name: 'probe', version: '1' },
      capabilities: { experimentalApi: true } };
    await connection.rpc('initialize', options);
    connection.notify('initialized', {});
    const elapsed = performance.now() - started;
    if (data.compact) {
      const compactCompleted = await compact(connection, notifications, data);
      const names = notifications.map(eventName);
      return { elapsed, compactCompleted, notifications: names };
    }
    const names = notifications.map(eventName);
    return { elapsed, notifications: names };
  } finally {
    session.destroy();
  }
}
async function execute(data) {
  if (data.operation === 'turn') {
    const setting = { context: data.context, hold: data.hold ?? false };
    settings.set(data.frame.id, setting);
    socket.send(JSON.stringify(data.frame));
    return {};
  }
  if (data.operation === 'stop') {
    socket.send(JSON.stringify(data.frame));
    return {};
  }
  if (data.operation === 'reconnect') {
    socket.terminate();
    await once(socket, 'close');
    since = data.since;
    await open();
    return {};
  }
  if (data.operation === 'direct') return direct(data);
  throw new Error('Unknown probe operation');
}

await open();
write({ ready: true });
const lines = createInterface({ input: process.stdin });
let queue = Promise.resolve();
function receiveCommand(line) {
  const data = JSON.parse(line);
  async function run() {
    try {
      const result = await execute(data);
      write({ id: data.id, result });
    } catch (error) {
      write({ id: data.id, error: error.name });
    }
  }
  queue = queue.then(run);
}
function close() {
  socket.terminate();
  process.exit(0);
}
lines.on('line', receiveCommand);
lines.on('close', close);
