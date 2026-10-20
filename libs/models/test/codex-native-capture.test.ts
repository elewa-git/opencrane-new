import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage,
  type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { grantStream } from '@opencrane/authz';
import { decideApproval, readApproval } from '../src/index.ts';
import { catalogueEvidence, fixture, reviewCatalogue, toolEvidence } from './fixture.ts';

const run = promisify(execFile);
const image = process.env['CODEX_CAPTURE_IMAGE'];

async function captureNative() {
  const setup = await fixture(2000, 20000, false, 'gpt-6.1-sol');
  const directory = await mkdtemp(`${tmpdir()}/native-capture-`);
  const socket = `${directory}/gateway.sock`;
  const review = { action: 'Read fixture', consequence: 'Returns fixture data.',
    targetArgument: 'record', fields: ['record'], stepUp: false };
  const tool = toolEvidence({ name: 'read_before', reviewed: true, costCents: 0, review });
  const catalogue = catalogueEvidence([tool]);
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
    const input = schema.parse(JSON.parse(Buffer.concat(chunks).toString()));
    let result;
    if (request.url === '/bind') {
      const turn = { assistantId: 'assistant', computerId: 'computer',
        conversationId: 'conversation', turnId: input.turnId, threadId: input.thread,
        requesterId: 'alice', task: 'chat_turn', payingGroupId: 'personal-default' };
      await setup.append('computer-assistant', 'computer.turn_started', turn);
      await setup.append('conversation-conversation', 'agent.turn_started', {
        conversationId: 'conversation', assistantId: 'assistant', turnId: input.turnId,
      });
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
  const relay = createServer(serve);
  try {
    await setup.append('mcp-fixture', 'mcp.server_registered', { serverId: 'fixture',
      kind: 'remote', locator: 'https://fixture.example.test/mcp', registeredBy: 'alice' });
    await setup.append('mcp-fixture', 'mcp.server_discovered', { serverId: 'fixture',
      connectionId: 'installed', accountMode: 'none', ...catalogue });
    await reviewCatalogue(setup);
    await setup.append('mcp-fixture', 'mcp.tool_mode_set', { serverId: 'fixture',
      connectionId: 'installed', toolName: tool.name, toolRevision: tool.revision,
      mode: 'ask', setBy: 'alice' });
    await setup.append('mcp-fixture', 'mcp.server_published', {
      serverId: 'fixture', publishedBy: 'alice',
    });
    for (const [granteeId, granteeKind] of [['alice', 'member'], ['assistant', 'assistant']]) {
      const event = await setup.append(grantStream('mcp_server', 'fixture'), 'grant.given', {
        resourceType: 'mcp_server', resourceId: 'fixture', granteeId, granteeKind,
        grantedBy: 'alice',
      });
      await setup.auth.handler.handle(event, setup.db);
    }
    relay.listen(socket);
    await once(relay, 'listening');
    await chmod(socket, 0o666);
    const args = ['run', '--rm', '--network', 'none',
      '-v', `${resolve('apps/computer/test')}:/app/test:ro`,
      '-v', `${resolve('apps/computer/src')}:/app/src:ro`,
      '-v', `${directory}:/capture`, '-e', 'CAPTURE_SOCKET=/capture/gateway.sock',
      '--entrypoint', 'node', image!, '--experimental-strip-types',
      '/app/test/codex-on-request.mjs'];
    async function captureOutput() {
      try {
        return await run('docker', args, { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
      } catch (error) {
        const output = z.object({ stdout: z.string() }).parse(error);
        await writeFile('/tmp/pr12capture.json', output.stdout);
        throw error;
      }
    }
    const output = await captureOutput();
    await writeFile('/tmp/pr12capture.json', output.stdout);
    expect(setup.received()).toBe(0);
  } finally {
    relay.closeAllConnections();
    relay.close();
    await setup.close();
    await rm(directory, { recursive: true, force: true });
  }
}
it.skipIf(!image)('captures native consent through the proxy and gateway Ask', captureNative, 150_000);
