import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import type { EventStore } from '@opencrane/event-store';
import type { mcpServerDiscoveredDataSchema } from '@opencrane/events';
import { losslessJson } from '@opencrane/events/lossless-json';
import { catalogueDigest, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { readToolPolicy } from '@opencrane/models';

type Catalogue = ReturnType<typeof mcpServerDiscoveredDataSchema.parse>;
type Tool = NonNullable<Catalogue['tools']>[number];
type Append = (type: string, subject: string, data: Record<string, unknown>) => Promise<void>;

export function journeyTool(name: string, readOnly: boolean, review?: Tool['review']): Tool {
  const annotations = { readOnlyHint: readOnly, destructiveHint: !readOnly };
  const definition = { name, inputSchema: { type: 'object' }, annotations };
  const encoded = JSON.stringify(definition);
  const parsed = losslessJson(encoded);
  const tool: Tool = { name, revision: parsed.digest, definition: parsed.canonical,
    reviewed: false, readOnly, destructive: !readOnly, costCents: 0 };
  if (review) {
    tool.review = review;
  }
  return tool;
}

export function approvalJourneyTool(): Tool {
  const review = { action: 'Update order note',
    consequence: 'The recording stub receives this order note once.',
    targetArgument: 'order', fields: ['order', 'note'], stepUp: false };
  return journeyTool('write', false, review);
}

export async function reviewJourneyTools(ownerPage: Page, store: EventStore, silo: string,
  origin: string, append: Append,
  serverId: string, tools: Tool[], modes: ('allow' | 'ask' | 'block')[],
  serverInfo?: Catalogue['serverInfo']): Promise<void> {
  const checkedAt = new Date();
  const expiresAt = new Date(checkedAt.getTime() + 300_000);
  const catalogue: Catalogue = { serverId, connectionId: 'installed', accountMode: 'none',
    tools, toolCount: tools.length, schemaDigest: catalogueDigest(tools),
    checkedAt: checkedAt.toISOString(), expiresAt: expiresAt.toISOString() };
  if (serverInfo) {
    catalogue.serverInfo = serverInfo;
  }
  await append('mcp.server_discovered', `mcp-${serverId}`, catalogue);

  // Read the saved events so a slow projection cannot supply an older review revision.
  const url = `${origin}/api/org/integrations/${serverId}`;
  const policy = await readToolPolicy(store, silo, serverId);
  assert.equal(policy.catalogue?.schemaDigest, catalogue.schemaDigest);
  assert.equal(policy.tools.length, tools.length);
  for (const tool of policy.tools) {
    assert.equal(tool.reviewed, false, 'Discovery cannot authorise a tool');
    assert.equal(tool.mode, 'block', 'Unreviewed tools stay blocked');
  }
  function reviewedChoice(tool: Tool, index: number) {
    const mode = modes[index];
    assert(mode, 'Every discovered tool needs an explicit choice');
    return { name: tool.name, revision: tool.revision, reviewDigest: toolReviewDigest(tool), mode };
  }
  const choices = tools.map(reviewedChoice);
  const command = { commandId: randomUUID(), expectedSequence: policy.sequence,
    policyRevision: policy.policyRevision, catalogueDigest: catalogue.schemaDigest,
    connectionId: catalogue.connectionId, accountMode: catalogue.accountMode, tools: choices };
  const request = { headers: { origin }, data: command };
  const saved = await ownerPage.request.post(`${url}/review`, request);
  assert.equal(saved.status(), 200, 'Owner saves the exact tool review');
  const savedReply = await saved.json() as {
    status?: unknown;
    sequence?: unknown;
    policy?: { tools?: Array<{ name?: unknown; mode?: unknown }> };
  };
  assert.equal(savedReply.status, 'appended');
  assert(Number.isInteger(savedReply.sequence) && Number(savedReply.sequence) > 0,
    'The saved review has a positive sequence');
  if (savedReply.policy) {
    assert.deepEqual(savedReply.policy.tools?.map((tool) => ({ name: tool.name, mode: tool.mode })),
      choices.map((choice) => ({ name: choice.name, mode: choice.mode })));
  }
  const publication = { serverId, publishedBy: 'zitadel-owner' };
  await append('mcp.server_published', `mcp-${serverId}`, publication);
}
