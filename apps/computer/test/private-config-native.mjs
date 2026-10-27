import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
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
function permits() { return true; }
async function handle(request, response) {
  methods.push(request.headers['mcp-method'] ?? 'legacy');
  protocols.push(request.headers['mcp-protocol-version'] ?? 'legacy');
  try {
    await mcp.handle(request, response, permits);
  } catch {
    response.writeHead(400);
    response.end('{}');
  }
}
function receive(request, response) { void handle(request, response); }
const listener = createServer(receive);
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
const loadKey = 'a'.repeat(32);
const key = 'oc_0123456789';
const definition = { name: 'recall', inputSchema: { type: 'object' } };
const tools = [{ key, serverId: 'memory', connectionId: 'server',
  serverInfo: { name: 'OpenCrane memory', version: '1' },
  definitions: [JSON.stringify(definition)], modes: { recall: 'allow' } }];
const catalogue = { loadKey, conversation: 'chat', turnId: 'turn', tools };
mcp.catalogue(catalogue, true);
let child;
try {
  await writeFile(`${home}/config.toml`, privateConfig('gpt-6.1-sol'));
  await writeFile(`${home}/environments.toml`, privateEnvironments());
  const version = execFileSync('/usr/local/bin/node', ['/usr/local/bin/codex', '--version'],
    { encoding: 'utf8' }).trim();
  const options = { cwd: home, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home,
    PROXY_CALLER_TOKEN: 'fixture-only' }, stdio: ['pipe', 'pipe', 'ignore'] };
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
  const server = { url: `http://127.0.0.1:${port}/mcp/${loadKey}/${key}`,
    bearer_token_env_var: 'PROXY_CALLER_TOKEN', startup_timeout_sec: 2 };
  const config = { mcp_servers: { [key]: server } };
  const params = { model: 'gpt-6.1-sol', ephemeral: true, environments: [],
    approvalPolicy: 'never', sandbox: 'read-only', config };
  const response = await connection.rpc('thread/start', params);
  let discovered = false;
  try {
    await mcp.discovered({ loadKey });
    discovered = true;
  } catch {
    // Return the observed requests so the test reports a protocol mismatch directly.
  }
  const result = { version, discovered, methods, protocols, thread: response.thread,
    grants: grants.size };
  process.stdout.write(JSON.stringify(result));
} finally {
  if (child) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  mcp.drop({ loadKey });
  approvals.stop();
  listener.closeAllConnections();
  function close(resolve) { listener.close(resolve); }
  await new Promise(close);
  await rm(home, { recursive: true, force: true });
}
