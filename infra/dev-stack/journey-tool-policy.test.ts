import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogueDigest, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { envelope } from '@opencrane/models';
import { applyToolPolicy, emptyToolPolicy, reviewedToolChoices } from '@opencrane/projections';
import { journeyTool } from './journey-tool-policy.ts';

function nightlyReview() {
  const readTool = journeyTool('read', true);
  const writeTool = journeyTool('write', false);
  const tools = [readTool, writeTool];
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 300_000);
  const catalogue = {
    serverId: 'nightly', connectionId: 'installed', accountMode: 'none' as const,
    tools, toolCount: tools.length, schemaDigest: catalogueDigest(tools),
    checkedAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
  };
  const discovery = envelope('test', 'mcp-nightly', 'mcp.server_discovered', catalogue);
  const state = applyToolPolicy(emptyToolPolicy(), discovery, 2);
  function choice(tool: typeof readTool) {
    let mode: 'allow' | 'block' = 'block';
    if (tool.name === 'read') {
      mode = 'allow';
    }
    return { name: tool.name, revision: tool.revision,
      reviewDigest: toolReviewDigest(tool), mode };
  }
  const review = {
    serverId: 'nightly', reviewedBy: 'owner', policyRevision: state.policyRevision,
    catalogueDigest: catalogue.schemaDigest, connectionId: 'installed',
    accountMode: 'none' as const, tools: tools.map(choice),
  };
  return { state, review, now: now.getTime() };
}

function acceptsNightlyReadTool() {
  const { state, review, now } = nightlyReview();
  assert.deepEqual(state.tools, [
    { name: 'read', revision: state.tools[0]?.revision, reviewed: false,
      readOnly: true, mode: 'block', suggestion: 'allow', costCents: 0 },
    { name: 'write', revision: state.tools[1]?.revision, reviewed: false,
      readOnly: false, mode: 'block', suggestion: 'ask', costCents: 0 },
  ]);
  // Exercise the API's review validator with the nightly tool choices and saved discovery.
  const accepted = reviewedToolChoices(state, review, now);
  assert(accepted, 'The nightly Allow choice needs complete review details');
  assert.equal(accepted[0]?.mode, 'allow');
  assert.equal(accepted[1]?.mode, 'block');
}
test('nightly tool discovery stays blocked until its exact Allow review is valid',
  acceptsNightlyReadTool);

function refusesIncompleteReadTool() {
  const { state, review, now } = nightlyReview();
  const readDeclaration = state.catalogue?.tools?.[0];
  assert(readDeclaration);
  delete readDeclaration.review;
  const readChoice = review.tools[0];
  assert(readChoice);
  readChoice.reviewDigest = toolReviewDigest(readDeclaration);
  assert.equal(reviewedToolChoices(state, review, now), null);
}
test('a matching digest cannot authorise Allow without declared review details',
  refusesIncompleteReadTool);
