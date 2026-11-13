import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { mcpServerDiscoveredDataSchema } from '@opencrane/events';
import { emptyToolPolicy } from '@opencrane/projections';
import { envelope } from '../src/actor.ts';
import { verifyBearerIdentity } from '../src/bearer-identity.ts';
import * as policyReader from '../src/tool-policy.ts';
import { remoteFixture } from './support/remote-mcp.ts';
import type { ToolPolicy } from '@opencrane/protocol';
import type { IncomingMessage, ServerResponse } from 'node:http';

function restore() { vi.restoreAllMocks(); }
afterEach(restore);

function policyFixture(): ToolPolicy {
  return { ...emptyToolPolicy(), serverId: 'server', connectionId: 'installed',
    accountMode: 'personal', published: true, identityTool: 'identity',
    catalogue: mcpServerDiscoveredDataSchema.parse({ serverId: 'server',
      connectionId: 'installed', tools: [], toolCount: 0, schemaDigest: 'a'.repeat(64) }),
    tools: [{ name: 'identity', revision: 'a'.repeat(64), reviewed: true,
      readOnly: true, costCents: 0, mode: 'allow', suggestion: 'allow' }] };
}

async function refuseInvalidIdentityPolicy(guard: string) {
  const policy = policyFixture();
  const tool = policy.tools[0]!;
  if (guard === 'read-only') tool.readOnly = false;
  if (guard === 'reviewed') tool.reviewed = false;
  if (guard === 'zero-cost') delete tool.costCents;
  if (guard === 'personal') policy.accountMode = 'company';
  if (guard === 'published') policy.published = false;
  if (guard === 'named-tool') policy.tools = [];
  // Isolate the verifier's policy checks from the projection's own refusal checks.
  vi.spyOn(policyReader, 'toolPolicyFromRows').mockReturnValue(policy);
  const resolve = vi.fn();
  const registration = envelope('test', 'mcp-server', 'mcp.server_registered', {
    serverId: 'server', kind: 'remote', locator: 'https://mcp.example.test/mcp',
    registeredBy: 'admin',
  });
  await expect(verifyBearerIdentity({ rows: [{ event: registration, sequence: 1 }],
    material: 'synthetic-key', network: { resolve } })).rejects.toThrow('Identity not verified');
  expect(resolve).not.toHaveBeenCalled();
}
it.each(['read-only', 'reviewed', 'zero-cost', 'personal', 'published', 'named-tool'])(
  'refuses an invalid identity policy: %s before contacting the server', refuseInvalidIdentityPolicy);

async function refusesForeignReplyId() {
  function handler(request: IncomingMessage, reply: ServerResponse) {
    request.resume();
    reply.writeHead(200, { 'content-type': 'application/json' });
    reply.end(JSON.stringify({ jsonrpc: '2.0', id: 'another-request',
      result: { isError: false, structuredContent: { subject: 'account-a' } } }));
  }
  const remote = await remoteFixture(false, handler);
  onTestFinished(remote.close);
  vi.spyOn(policyReader, 'toolPolicyFromRows').mockReturnValue(policyFixture());
  const registration = envelope('test', 'mcp-server', 'mcp.server_registered', {
    serverId: 'server', kind: 'remote', locator: 'https://mcp.example.test/mcp',
    registeredBy: 'admin',
  });
  await expect(verifyBearerIdentity({ rows: [{ event: registration, sequence: 1 }],
    material: 'synthetic-key', network: remote.network })).rejects.toThrow('Identity not verified');
  expect(remote.connections()).toBe(1);
}
it('refuses an otherwise valid identity reply for a different request', refusesForeignReplyId);
