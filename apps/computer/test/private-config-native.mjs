import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { privateCallers } from '@opencrane/models/private-callers';
import { privateCatalogue, privateToolOffer, checkPrivateTurnTools }
  from '../../server/test/support/private-catalogue.ts';
import { threadLoads } from '../src/thread-loads.ts';
import { parseTurn } from '../src/turn-frame.ts';
import { approvalHolds } from '../src/approval-holds.ts';
import { privateConfig, privateEnvironments } from '../src/codex-config.ts';
import { codexConnection } from '../src/codex-connection.ts';
import { mcpProxy } from '../src/mcp-proxy.ts';

const home = await mkdtemp(`${tmpdir()}/private-config-`);
const grants = new Map();
function waiting() { return false; }
function renew() { return Promise.reject(new Error('No fixture grant')); }
const approvals = approvalHolds({ waiting, renew });
const mcp = mcpProxy('http://127.0.0.1:1', grants, approvals);
const methods = [];
const protocols = [];
function dropped(turnId) { mcp.dropTurn(turnId); }
const authority = privateCallers(dropped);
async function handle(request, response) {
  methods.push(request.headers['mcp-method'] ?? 'legacy');
  protocols.push(request.headers['mcp-protocol-version'] ?? 'legacy');
  try {
    const caller = authority.identify(request.headers.authorization ?? '');
    function permits(turnId, thread) { return authority.permits(caller, turnId, thread); }
    await mcp.handle(request, response, permits);
  } catch {
    response.writeHead(400);
    response.end('{}');
  }
}
function receive(request, response) { void handle(request, response); }
const listener = createServer(receive);
listener.listen(8080, '127.0.0.1');
await once(listener, 'listening');
const name = process.argv[2] ?? 'recall';
const input = parseTurn({ id: 'turn', conversationId: 'chat', requesterId: 'alice',
  assistantId: 'assistant', executionMode: 'restricted', text: 'Hello', token: 'fixture',
  expiresAt: Date.now() + 60_000, tools: privateToolOffer(name) });
const identity = { turnId: input.id, conversation: input.conversationId, generation: 1,
  inputGeneration: 1, expires: input.expiresAt };
const registration = authority.register(identity);
function catalogue(loadKey, conversation, tools, thread, turnId, generations) {
  const request = { loadKey, conversation, tools, thread, turnId, ...generations };
  if (!authority.check(request)) throw new Error('Unbound catalogue');
  mcp.catalogue(request, true);
  return Promise.resolve();
}
function dropCatalogue(loadKey) { mcp.drop({ loadKey }); return Promise.resolve(); }
function discovered(loadKey) { return mcp.discovered({ loadKey }); }
function ordinaryRpc() { throw new Error('Ordinary RPC is forbidden'); }
const loads = threadLoads({ rpc: ordinaryRpc, catalogue, dropCatalogue, discovered });
let child;
try {
  await writeFile(`${home}/config.toml`, privateConfig('gpt-6.1-sol'));
  await writeFile(`${home}/environments.toml`, privateEnvironments());
  const version = execFileSync('/usr/local/bin/node', ['/usr/local/bin/codex', '--version'],
    { encoding: 'utf8' }).trim();
  const options = { cwd: home, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home,
    PROXY_CALLER_TOKEN: registration.caller }, stdio: ['pipe', 'pipe', 'ignore'] };
  child = spawn('/usr/local/bin/node',
    ['/usr/local/bin/codex', 'app-server', '--stdio', '--strict-config'], options);
  function message() { /* No model turn or native tool call is requested. */ }
  function failed() { throw new Error('Native fixture connection failed'); }
  const handlers = { message, failed };
  const connection = codexConnection(child.stdin, child.stdout, handlers);
  const initialise = { clientInfo: { name: 'private-config-test', version: '1' },
    capabilities: { experimentalApi: true } };
  await connection.rpc('initialize', initialise);
  connection.notify('initialized', {});
  const ended = Promise.withResolvers();
  function close() { ended.resolve(); }
  const session = { rpc: connection.rpc, close, closed: ended.promise };
  const owner = { ...identity, caller: registration.caller, authority, registration, session };
  const started = await loads.startPrivate(input, owner);
  // Let the initial unapproved discovery fail before recording and binding the real id.
  await pause(200);
  const beforeApproval = mcp.size;
  const grant = { ...identity, silo: 'test', requesterId: input.requesterId,
    assistantId: input.assistantId, computerId: 'computer', thread: started.thread.id };
  registration.bind(grant.thread);
  const approval = await privateCatalogue(authority, registration.caller, grant, name);
  const binding = { ...owner, grant, tools: approval.tools, checkTools: checkPrivateTurnTools };
  const response = await loads.loadPrivate(input, binding);
  const listing = await connection.rpc('mcpServerStatus/list', { threadId: grant.thread });
  const result = { version, discovered: true, methods, protocols, thread: response.thread,
    startedId: started.thread.id, approvedId: grant.thread, beforeApproval,
    listing, grants: grants.size };
  await loads.stop();
  process.stdout.write(JSON.stringify(result));
} finally {
  if (child) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  authority.close();
  approvals.stop();
  listener.closeAllConnections();
  function close(resolve) { listener.close(resolve); }
  await new Promise(close);
  await rm(home, { recursive: true, force: true });
}
