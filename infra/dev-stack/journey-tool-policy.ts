import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Page } from 'playwright';
import type { EventStore } from '@opencrane/event-store';
import type { mcpServerDiscoveredDataSchema } from '@opencrane/events';
import { losslessJson } from '@opencrane/events/lossless-json';
import { catalogueDigest, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { readToolPolicy } from '@opencrane/models';
import { toolPolicySchema } from '@opencrane/protocol';

type Catalogue = ReturnType<typeof mcpServerDiscoveredDataSchema.parse>;
type Tool = NonNullable<Catalogue['tools']>[number];
type Append = (type: string, subject: string, data: Record<string, unknown>) => Promise<void>;
const policyToolSchema = toolPolicySchema.shape.tools.element;
const reviewedModeSchema = policyToolSchema.pick({ name: true, mode: true });
const reviewReplySchema = z.object({ status: z.string(), sequence: z.number().optional(),
  policy: z.object({ tools: z.array(reviewedModeSchema).optional() }).optional() });

function selectedToolMode(tool: { name?: unknown; mode?: unknown }) {
  return { name: tool.name, mode: tool.mode };
}

export function journeyTool(name: string, readOnly: boolean, review?: Tool['review']): Tool {
  const annotations = { readOnlyHint: readOnly, destructiveHint: !readOnly };
  const definition = { name, inputSchema: { type: 'object' }, annotations };
  const encoded = JSON.stringify(definition);
  const parsed = losslessJson(encoded);
  const tool: Tool = { name, revision: parsed.digest, definition: parsed.canonical,
    reviewed: false, readOnly, destructive: !readOnly, costCents: 0 };
  if (review) {
    tool.review = review;
  } else if (readOnly) {
    // Declare safe review details even for read-only fixtures selected as Allow.
    tool.review = { action: 'Read fixture data',
      consequence: 'Returns fixture data without changing it.',
      targetArgument: 'target', fields: ['target'], stepUp: false };
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
  const saved = await readToolPolicy(store, silo, serverId);
  assert.equal(saved.catalogue?.schemaDigest, catalogue.schemaDigest);
  assert.equal(saved.tools.length, tools.length);

  const input = { ownerPage, store, silo, origin, serverId };
  await reviewSavedJourneyTools(input, modes);
}

export type JourneyToolReview = {
  ownerPage: Page;
  store: EventStore;
  silo: string;
  origin: string;
  serverId: string;
};

export async function reviewSavedJourneyTools(input: JourneyToolReview,
  modes: ('allow' | 'ask' | 'block')[]) {
  const { ownerPage, store, silo, origin, serverId } = input;
  // Read saved definitions so a slow projection cannot supply an older review revision.
  const url = `${origin}/api/org/integrations/${serverId}`;
  const policy = await readToolPolicy(store, silo, serverId);
  const catalogue = policy.catalogue;
  assert(catalogue?.tools, 'Discovery supplies the exact definitions for review');
  const tools = catalogue.tools;
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
  const savedReply = reviewReplySchema.parse(await saved.json());
  assert.equal(savedReply.status, 'appended');
  assert(Number.isInteger(savedReply.sequence) && Number(savedReply.sequence) > 0,
    'The saved review has a positive sequence');
  if (savedReply.policy) {
    const savedModes = savedReply.policy.tools?.map(selectedToolMode);
    const expectedModes = choices.map(selectedToolMode);
    assert.deepEqual(savedModes, expectedModes);
  }
  const reviewed = await readToolPolicy(store, silo, serverId);
  const publication = { commandId: randomUUID(), expectedSequence: reviewed.sequence,
    reviewRevision: reviewed.reviewRevision };
  const publishRequest = { headers: { origin }, data: publication };
  const published = await ownerPage.request.post(`${url}/publication`, publishRequest);
  assert.equal(published.status(), 200, 'Owner publishes the exact saved review');
  const publicationReply = reviewReplySchema.parse(await published.json());
  assert.equal(publicationReply.status, 'appended');
}
