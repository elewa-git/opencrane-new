import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { privateCallers } from '@opencrane/models/private-callers';
import { memoryScopeId } from '@opencrane/projections';
import { approvalHolds } from '../src/approval-holds.ts';
import { mcpProxy } from '../src/mcp-proxy.ts';
import { threadLoads } from '../src/thread-loads.ts';
import { writeSession, readJson, scriptedWrite } from './private-write-call-session.mjs';

const scopeId = memoryScopeId('test', 'person', 'alice');
const grants = new Map();
const addresses = new Map();
const sessions = [];
const cases = [];
let state;
let survivor;
let failure = false;
function waiting() { return false; }
function renew() { throw new Error('No approval renewal'); }
const approvals = approvalHolds({ waiting, renew });
function refuse(response) {
  failure = true;
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(500);
  response.end('{}');
}
async function upstream(request, response) {
  const active = state;
  const body = await readJson(request);
  active.forwarded++;
  assert.equal(request.url, '/mcp/memory/server');
  assert.equal(request.headers['mcp-protocol-version'], '2026-07-28');
  assert.equal(request.headers['mcp-method'], 'tools/call');
  assert.equal(request.headers['mcp-name'], active.operation);
  assert.equal(request.headers['session-id'], active.grant.thread);
  assert.equal(request.headers.authorization, 'Bearer fixture-computer');
  assert.equal(request.headers['x-turn-token'], 'fixture-pass');
  assert.equal(request.headers['x-opencrane-tool-mode'], 'allow');
  assert.equal(body.method, 'tools/call');
  assert.equal(body.params.name, active.operation);
  assert.deepEqual(body.params.arguments, active.arguments);
  const metadata = body.params._meta;
  assert.equal(metadata['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
  assert.equal(metadata.threadId, active.grant.thread);
  assert.equal(metadata.callId, active.callId);
  assert.equal(typeof body.id, 'number');
  if (active.name === 'lost') {
    response.destroy();
    return;
  }
  const result = { content: [], structuredContent: active.receipt };
  const bytes = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
  const split = bytes.indexOf(active.receipt.changeId) + active.receipt.changeId.length;
  response.writeHead(200, { 'content-type': 'application/json' });
  if (active.name === 'cancelled') {
    response.write(bytes.slice(0, split));
    await pause(50);
    const disconnected = once(response, 'close');
    active.session.registration.close();
    await disconnected;
    assert.equal(response.destroyed, true);
  }
  response.end(bytes.slice(active.name === 'cancelled' ? split : 0));
}
function receiveUpstream(request, response) {
  function failed() { refuse(response); }
  void upstream(request, response).catch(failed);
}
const recording = createServer(receiveUpstream);
recording.listen(0, '127.0.0.1');
await once(recording, 'listening');
const gateway = `http://127.0.0.1:${recording.address().port}`;
const mcp = mcpProxy(gateway, grants, approvals);
function dropped(turnId, thread) {
  mcp.dropTurn(turnId);
  if (thread) grants.delete(thread);
}
const authority = privateCallers(dropped);
async function handle(request, response) {
  if (request.url === '/v1/responses') {
    await scriptedWrite(request, response, state);
    return;
  }
  const isCall = request.headers['mcp-method'] === 'tools/call';
  if (isCall) {
    state.nativeCalls++;
    // Substitute only the transport address or caller; Codex authors the complete call.
    if (state.name === 'foreign-caller') {
      request.headers.authorization = `Bearer ${survivor.registration.caller}`;
    }
    if (state.name === 'foreign-thread') {
      request.url = addresses.get('survivor');
      request.headers.authorization = `Bearer ${survivor.registration.caller}`;
    }
    if (state.name === 'ended') state.session.registration.close();
  }
  const caller = identifyCaller(request.headers.authorization ?? '', isCall);
  function permits(turnId, thread) { return authority.permits(caller, turnId, thread); }
  await mcp.handle(request, response, permits);
}
function identifyCaller(authorization, isCall) {
  if (!isCall || state?.name !== 'expired-binding') return authority.identify(authorization);
  const original = Date.now;
  function expired() { return state.grant.expires; }
  // Advance only the registry's synchronous expiry check, leaving other sessions live.
  Date.now = expired;
  try { return authority.identify(authorization); }
  finally { Date.now = original; }
}
function receive(request, response) {
  function rejected() {
    if (request.headers['mcp-method'] === 'tools/call' || request.url === '/v1/responses') {
      refuse(response);
      return;
    }
    response.writeHead(400);
    response.end('{}');
  }
  void handle(request, response).catch(rejected);
}
const listener = createServer(receive);
function catalogue(loadKey, conversation, tools, thread, turnId, generations) {
  const entry = { loadKey, conversation, tools, thread, turnId, ...generations };
  assert.equal(authority.check(entry), true);
  mcp.catalogue(entry, true);
  addresses.set(turnId, `/mcp/${loadKey}/${tools[0].key}`);
  return Promise.resolve();
}
function dropCatalogue(loadKey) { mcp.drop({ loadKey }); return Promise.resolve(); }
function discovered(loadKey) { return mcp.discovered({ loadKey }); }
function ordinaryRpc() { throw new Error('Ordinary RPC is forbidden'); }
const loads = threadLoads({ rpc: ordinaryRpc, catalogue, dropCatalogue, discovered });
function install(grant, expired = false) {
  assert.equal(authority.check(grant), true);
  const expires = expired ? Date.now() - 1 : Date.now() + 60_000;
  const pass = { ...grant, computer: 'fixture-computer', token: 'fixture-pass', expires };
  grants.set(grant.thread, pass);
}
async function runCase(name, operation, session, grant, receipt) {
  state = { name, operation, session, grant, receipt, arguments: writeArguments(operation),
    callId: `call_${name}`, forwarded: 0, consumed: 0,
    modelRequests: 0, nativeCalls: 0, unconfirmed: false };
  if (name !== 'no-grant') install(grant, name === 'expired');
  const native = await session.turn(grant.thread);
  assert.equal(failure, false);
  assert.equal(state.nativeCalls, 1);
  assert.equal(state.modelRequests, 2);
  const allowed = ['remember', 'correct', 'forget', 'survivor'].includes(name);
  assert.equal(state.consumed, Number(allowed));
  assert.equal(native.exposed, allowed);
  if (name === 'lost') assert.equal(state.unconfirmed, true);
  const delivered = ['remember', 'correct', 'forget', 'cancelled', 'lost', 'survivor'];
  const forwarded = Number(delivered.includes(name));
  assert.equal(state.forwarded, forwarded);
  if (allowed) {
    assert.deepEqual(native.result.content, []);
    assert.deepEqual(native.result.structuredContent, receipt);
  }
  cases.push({ name, forwarded: state.forwarded, consumed: state.consumed });
}
function writeArguments(operation) {
  const common = { scopeId, commandId: 'fixture-command', recallProof: 'fixture-proof' };
  const target = { memoryId: 'fixture-memory', expectedRevision: 1 };
  const value = { text: 'Fixture statement', kind: 'fact', pinned: false,
    expiresAt: null, dependsOn: [] };
  if (operation === 'forget') return { ...common, ...target };
  if (operation === 'correct') return { ...common, ...target, ...value };
  return { ...common, ...value, sources: [] };
}
function writeReceipt(operation) {
  const changeId = randomBytes(24).toString('hex');
  const common = { changeId, memoryId: 'fixture-memory', scopeId,
    audience: { kind: 'person', ownerId: 'alice' } };
  const time = '2026-10-01T00:00:00.000Z';
  if (operation === 'remember') {
    return { ...common, outcome: 'saved', revision: 1, savedAt: time };
  }
  const changed = { ...common, operation, outcome: 'accepted', revision: 2,
    acceptedAt: time, cleanupStatus: 'pending' };
  if (operation === 'forget') return { ...changed, hidden: true };
  return { ...changed, contentStatus: 'current' };
}
async function main() {
  listener.listen(8080, '127.0.0.1');
  await once(listener, 'listening');
  const versionOutput = execFileSync('/usr/local/bin/node', ['/usr/local/bin/codex', '--version'],
    { encoding: 'utf8' });
  const version = versionOutput.trim();
  assert.equal(version, 'codex-cli 0.159.2');
  const survivingReceipt = writeReceipt('remember');
  survivor = await writeSession('survivor', 'remember', authority, loads, survivingReceipt);
  sessions.push(survivor);
  const survivingGrant = await survivor.prepare();
  for (const name of ['no-grant', 'remember', 'correct', 'forget', 'foreign-caller', 'foreign-thread',
    'ended', 'expired', 'expired-binding', 'cancelled', 'lost']) {
    const operation = ['correct', 'forget'].includes(name) ? name : 'remember';
    const receipt = writeReceipt(operation);
    const session = await writeSession(name, operation, authority, loads, receipt);
    sessions.push(session);
    const grant = await session.prepare();
    assert.equal(grants.size, 0);
    await runCase(name, operation, session, grant, receipt);
    await loads.cancel(name);
    await session.dispose();
    sessions.pop();
  }
  await runCase('survivor', 'remember', survivor, survivingGrant, survivingReceipt);
  return { version, preparation: 'test-only', protocol: 'PASS', cases };
}
try {
  const result = await main();
  process.stdout.write(JSON.stringify(result));
} catch {
  process.stderr.write(`Native write fixture failed: ${state?.name ?? 'preparation'}\n`);
  process.exitCode = 1;
} finally {
  authority.close();
  approvals.stop();
  for (const session of sessions) await session.dispose();
  for (const server of [listener, recording]) {
    server.closeAllConnections();
    function close(resolve) { server.close(resolve); }
    await new Promise(close);
  }
}
