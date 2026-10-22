import { execFile } from 'node:child_process';
import { once } from 'node:events';
import * as captureFiles from 'node:fs/promises';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage,
  type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { grantStream } from '@opencrane/authz';
import { decideApproval, readApproval } from '../src/index.ts';
import { catalogueEvidence, fixture, reviewCatalogue, toolEvidence } from './fixture.ts';

vi.mock('node:fs/promises', { spy: true });

const run = promisify(execFile);
const image = process.env['CODEX_CAPTURE_IMAGE'];
type Setup = Awaited<ReturnType<typeof fixture>>;

function fixtureHandler(setup: Setup) {
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.url?.startsWith('/mcp/')) {
      const options = { method: request.method, headers: request.headers };
      function received(upstream: IncomingMessage) {
        response.writeHead(upstream.statusCode!, upstream.headers);
        upstream.pipe(response);
      }
      const upstream = httpRequest(`http://127.0.0.1:${setup.options.port}${request.url}`,
        options, received);
      function failed() { response.destroy(); }
      upstream.on('error', failed);
      request.pipe(upstream);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Expected fixture bytes');
      chunks.push(chunk);
    }
    const schema = z.object({ thread: z.string().default(''), turnId: z.string().default(''),
      approvalId: z.string().default('') });
    const bytes = Buffer.concat(chunks);
    const input = schema.parse(JSON.parse(bytes.toString()));
    let result;
    if (request.url === '/bind') {
      const turn = { assistantId: 'assistant', computerId: 'computer',
        conversationId: 'conversation', turnId: input.turnId, threadId: input.thread,
        requesterId: 'alice', task: 'chat_turn', payingGroupId: 'personal-default' };
      await setup.append('computer-assistant', 'computer.turn_started', turn);
      const started = {
        conversationId: 'conversation', assistantId: 'assistant', turnId: input.turnId,
      };
      await setup.append('conversation-conversation', 'agent.turn_started', started);
      const claims = { ...setup.t, turn: input.turnId, thread: input.thread };
      const token = await setup.sign(claims, 'decision-service');
      result = { token, computer: setup.headers.authorization.slice(7) };
    } else {
      expect(request.url).toBe('/deny');
      const beforeDecision = setup.received();
      expect(beforeDecision).toBe(0);
      const approval = await readApproval(setup.nats.store, 'test', input.approvalId);
      expect(approval.state).toBe('requested');
      async function currentAccess() {}
      const decision = await decideApproval(setup.nats.store, 'test', input.approvalId,
        'alice', 'rejected', true, currentAccess, approval, setup.actor.now());
      expect(decision.status).toBe('appended');
      result = { approvalId: input.approvalId, decision: 'rejected',
        beforeDecision, afterDecision: setup.received() };
    }
    response.end(JSON.stringify(result));
  }
  function serve(request: IncomingMessage, response: ServerResponse) {
    function failed(error: unknown) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: String(error) }));
    }
    void handle(request, response).catch(failed);
  }
  return serve;
}

async function prepareAsk(setup: Setup) {
  const review = { action: 'Read fixture', consequence: 'Returns fixture data.',
    targetArgument: 'record', fields: ['record'], stepUp: false };
  const reviewed = { name: 'read_before', reviewed: true, costCents: 0, review };
  const tool = toolEvidence(reviewed);
  const catalogue = catalogueEvidence([tool]);
  const registration = { serverId: 'fixture', kind: 'remote',
    locator: 'https://fixture.example.test/mcp', registeredBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_registered', registration);
  const discovered = { serverId: 'fixture', connectionId: 'installed',
    accountMode: 'none', ...catalogue };
  await setup.append('mcp-fixture', 'mcp.server_discovered', discovered);
  await reviewCatalogue(setup);
  const mode = { serverId: 'fixture', connectionId: 'installed', toolName: tool.name,
    toolRevision: tool.revision, mode: 'ask', setBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.tool_mode_set', mode);
  const publication = { serverId: 'fixture', publishedBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_published', publication);
  for (const [granteeId, granteeKind] of [['alice', 'member'], ['assistant', 'assistant']]) {
    const grant = { resourceType: 'mcp_server', resourceId: 'fixture',
      granteeId, granteeKind, grantedBy: 'alice' };
    const event = await setup.append(grantStream('mcp_server', 'fixture'), 'grant.given', grant);
    await setup.auth.handler.handle(event, setup.db);
  }
}

async function captureNative() {
  const setup = await fixture(2000, 20000, false, 'gpt-6.1-sol');
  const directory = await mkdtemp(`${tmpdir()}/native-capture-`);
  const socket = `${directory}/gateway.sock`;
  const handler = fixtureHandler(setup);
  const relay = createServer(handler);
  try {
    await prepareAsk(setup);
    relay.listen(socket);
    await once(relay, 'listening');
    await chmod(socket, 0o666);
    const args = ['run', '--rm', '--network', 'none',
      '-v', `${resolve('apps/computer/test')}:/app/test:ro`,
      '-v', `${resolve('apps/computer/src')}:/app/src:ro`,
      '-v', `${directory}:/capture`, '-e', 'CAPTURE_SOCKET=/capture/gateway.sock',
      '--entrypoint', 'node', image!, '--experimental-strip-types',
      '/app/test/codex-on-request.mjs'];
    async function executeCapture() {
      const limits = { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 };
      return await run('docker', args, limits);
    }
    await captureOutput(directory, executeCapture);
    expect(setup.received()).toBe(0);
  } finally {
    relay.closeAllConnections();
    relay.close();
    await setup.close();
    await rm(directory, { recursive: true, force: true });
  }
}
it.skipIf(!image)('captures native consent through the proxy and gateway Ask', captureNative, 150_000);

async function captureOutput(directory: string, execute: () => Promise<{ stdout: string }>) {
  let output;
  try {
    output = await execute();
  } catch (error) {
    const failedOutput = z.object({ stdout: z.string() }).parse(error);
    await writeFile(`${directory}/capture.json`, failedOutput.stdout,
      { mode: 0o600, flag: 'wx' });
    throw error;
  }
  await writeFile(`${directory}/capture.json`, output.stdout, { mode: 0o600, flag: 'wx' });
}

async function keepsCapturePrivate(outcome: string) {
  const directory = await mkdtemp(`${tmpdir()}/native-capture-output-`);
  const path = `${directory}/capture.json`;
  const stdout = '{"fixture":"private capture"}';
  const failure = Object.assign(new Error('Fixture capture failed'), { stdout });
  const actualFiles = await vi.importActual<typeof captureFiles>('node:fs/promises');
  const originalWrite = actualFiles.writeFile;
  async function requirePrivateWrite(...args: Parameters<typeof writeFile>) {
    // Refuse a shared write before it can replace another run's capture.
    expect(args[0]).toBe(path);
    expect(args[2]).toEqual({ mode: 0o600, flag: 'wx' });
    await originalWrite(...args);
  }
  const writes = vi.spyOn(captureFiles, 'writeFile').mockImplementation(requirePrivateWrite);
  function execute() {
    if (outcome === 'failure') {
      return Promise.reject(failure);
    }
    return Promise.resolve({ stdout });
  }
  try {
    const capturing = captureOutput(directory, execute);
    if (outcome === 'failure') {
      await expect(capturing).rejects.toBe(failure);
    } else {
      await capturing;
    }
    expect(writes).toHaveBeenCalledTimes(1);
    expect(await readFile(path, 'utf8')).toBe(stdout);
    const file = await stat(path);
    expect(file.mode & 0o777).toBe(0o600);
  } finally {
    writes.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
}
it.each(['success', 'failure'])(
  'keeps %s output private and removes it with the run directory', keepsCapturePrivate);
