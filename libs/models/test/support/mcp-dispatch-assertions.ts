import { body, tool, publishedFixture } from './mcp-dispatch-fixture.ts';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { mcpCatalogue, readPublication, rebuildMcpCatalogueProjection }
  from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { z } from 'zod';
import { expect } from 'vitest';
import { auditTrail, conversations } from '@opencrane/projections';
import { decideApproval, readApproval } from '../../src/index.ts';
import { fixture } from '../fixture.ts';
import { projectionReplay } from './projection-replay.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function grantToolApproval(setup: Fixture, headers: Record<string, string>, approve = true) {
  const mode = { serverId: 'fixture', connectionId: 'installed', toolName: 'write',
    toolRevision: tool.revision, mode: 'ask', setBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.tool_mode_set', mode);
  const publication = { serverId: 'fixture', publishedBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_published', publication);
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  const answer = z.object({ approvalId: z.string() }).parse(await response.json());
  const current = await readApproval(setup.nats.store, 'test', answer.approvalId);
  if (!approve) return answer.approvalId;
  async function fresh() {}
  const result = await decideApproval(setup.nats.store, 'test', answer.approvalId,
    'alice', 'approved', true, fresh, current, setup.actor.now());
  expect(result.status).toBe('appended');
  const approved = await readApproval(setup.nats.store, 'test', answer.approvalId);
  expect(approved.state).toBe('approved');
  return answer.approvalId;
}

export async function approvalPermit(setup: Fixture, headers: Record<string, string>, approvalId: string) {
  const approvalHeaders = { ...headers, 'x-opencrane-approval-id': approvalId };
  const request = { method: 'POST', headers: approvalHeaders, body };
  return fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`, request);
}

export async function verifyRestorationReplay(setup: Fixture, received = 1) {
  await setup.stopDispatch();
  await setup.runtime.stop();
  await setup.decisionDown();
  await setup.runner.initialise(mcpCatalogue);
  await setup.runner.run(mcpCatalogue);
  const before = await setup.db.query('SELECT policy FROM mcp_catalogue');
  const position = await setup.nats.store.head();
  const env = { ...process.env, ...setup.nats.env('projection'),
    DATABASE_URL: setup.databaseUrl };
  const verifyCatalogue = ['mcp-catalogue', '--verify'];
  const result = await projectionReplay(env, verifyCatalogue);
  expect(result.stdout).toContain('rebuilt state matched the live projection');
  const after = await setup.db.query('SELECT policy FROM mcp_catalogue');
  expect(after.rows).toEqual(before.rows);
  await setup.runner.initialise(conversations);
  await setup.runner.run(conversations);
  const verifyConversations = ['conversations', '--verify'];
  const unsupported = projectionReplay(env, verifyConversations);
  await expect(unsupported).rejects.toMatchObject({ code: 1 });
  const rebuildConversations = ['conversations', '--confirm-conversations-stopped'];
  const rebuilt = await projectionReplay(env, rebuildConversations);
  expect(rebuilt.stdout).toContain('PASS: conversations rebuilt');
  await setup.runner.initialise(auditTrail);
  await setup.runner.run(auditTrail);
  const verifyAudit = ['audit', '--verify'];
  const audit = await projectionReplay(env, verifyAudit);
  expect(audit.stdout).toContain('rebuilt state matched the live projection');
  expect(await setup.nats.store.head()).toBe(position);
  expect(setup.received()).toBe(received);
}

export function gatewayCall(context: Awaited<ReturnType<typeof publishedFixture>>,
  extra: Record<string, string | string[]> = {}, raw = body) {
  const headers = { ...context.headers, ...extra };
  const options = { method: 'POST', headers };
  const url = `http://127.0.0.1:${context.setup.options.port}/mcp/fixture/installed`;
  function sendRequest(resolve: (status: number) => void, reject: (error: Error) => void) {
    function receive(response: IncomingMessage) {
      function finished() {
        resolve(response.statusCode!);
      }
      response.on('end', finished);
      response.on('error', reject);
      response.resume();
    }
    const request = httpRequest(url, options, receive);
    request.on('error', reject);
    request.end(raw);
  }
  return new Promise<number>(sendRequest);
}

export async function approvalForReviewedTool(setup: Fixture, headers: Record<string, string>,
  approve: boolean) {
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  const answer = z.object({ approvalId: z.string() }).parse(await response.json());
  const waiting = await readApproval(setup.nats.store, 'test', answer.approvalId);
  if (approve) {
    async function fresh() {}
    const result = await decideApproval(setup.nats.store, 'test', answer.approvalId,
      'alice', 'approved', true, fresh, waiting);
    expect(result.status).toBe('appended');
  }
  return answer.approvalId;
}

export async function verifyCatalogueRecoveryReplay(setup: Fixture, received = 1) {
  await setup.stopDispatch();
  await setup.runtime.stop();
  await setup.decisionDown();
  await setup.runner.initialise(mcpCatalogue);
  await setup.runner.run(mcpCatalogue);
  const before = await readPublication(setup.db, 'test', 'fixture');
  const position = await setup.nats.store.head();
  const logger = createLogger('catalogue-recovery', { level: 'silent' });
  const options = { verify: true };
  await rebuildMcpCatalogueProjection(setup.db, setup.nats.reader, logger, options);
  const after = await readPublication(setup.db, 'test', 'fixture');
  expect(after).toEqual(before);
  expect(await setup.nats.store.head()).toBe(position);
  expect(setup.received()).toBe(received);
}
