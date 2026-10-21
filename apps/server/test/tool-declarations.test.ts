import { expect, it } from 'vitest';
import { mcpServerDiscoveredDataSchema } from '@opencrane/events';
import { catalogueDigest, toolReviewDigest, validateMcpCatalogue } from '@opencrane/events/mcp-catalogue';
import { losslessJson } from '@opencrane/events/lossless-json';
import { envelope } from '@opencrane/models';
import { applyToolPolicy, emptyToolPolicy, isToolPolicyAvailable } from '@opencrane/projections';
import { discoverInventory } from '../src/integrations/inventory.ts';

const review = { action: 'Read a record', consequence: 'Show the record',
  targetArgument: 'id', fields: ['id'], stepUp: false };
const metadata = { resultType: 'complete', ttlMs: 300_000, cacheScope: 'public' };
const discovery = { ...metadata, supportedVersions: ['2026-07-28'], capabilities: { tools: {} },
  _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Fixture', version: '1' } } };
const tool = { name: 'read', inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true },
  _meta: { 'io.opencrane/costCents': 0, 'io.opencrane/review': review } };

async function capture(definitions: unknown[]) {
  function call(method: string) {
    const result = method === 'server/discover' ? discovery : { ...metadata, tools: definitions };
    return Promise.resolve(JSON.stringify(result));
  }
  const inventory = await discoverInventory(call);
  return mcpServerDiscoveredDataSchema.parse({ serverId: 'fixture',
    connectionId: 'installed-fixture', accountMode: 'none', ...inventory });
}

async function savesExactDeclaration() {
  const saved = await capture([tool]);
  const original = losslessJson(JSON.stringify(tool));
  expect(saved.tools).toEqual([{ name: 'read', revision: original.digest,
    definition: original.canonical, reviewed: false, readOnly: true, destructive: false,
    costCents: 0, review }]);
  expect(saved.schemaDigest).toBe(catalogueDigest(saved.tools!));
  validateMcpCatalogue(saved);
}
it('saves literal zero and approval details without changing the definition or reviewing it',
  savesExactDeclaration);

async function rejectsCost(cost: unknown) {
  const invalid = { ...tool, _meta: { ...tool._meta, 'io.opencrane/costCents': cost } };
  const sibling = { ...tool, name: 'sibling' };
  const saved = await capture([invalid, sibling]);
  expect(saved.tools).toHaveLength(1);
  expect(saved.tools![0]).toMatchObject({ name: 'sibling', costCents: 0, review });
  expect(saved.rejectedTools).toEqual([{ name: 'read',
    revision: losslessJson(JSON.stringify(invalid)).digest, reason: 'invalid_tool_cost' }]);
  expect(JSON.stringify(saved)).not.toContain('credential-canary');
}
it.each([1, -1, 0.5, '0', null, 'credential-canary'])(
  'excludes only the tool with malformed cost %j', rejectsCost);

async function rejectsReview(details: unknown) {
  const invalid = { ...tool, _meta: { ...tool._meta, 'io.opencrane/review': details } };
  const saved = await capture([invalid, { ...tool, name: 'sibling' }]);
  expect(saved.tools).toHaveLength(1);
  expect(saved.tools![0]?.name).toBe('sibling');
  expect(saved.rejectedTools).toEqual([{ name: 'read',
    revision: losslessJson(JSON.stringify(invalid)).digest, reason: 'invalid_tool_review' }]);
  expect(JSON.stringify(saved)).not.toContain('credential-canary');
}
const invalidReviews = [null, {}, { ...review, action: '' }, { ...review, action: 1 },
  { ...review, consequence: ' ' }, { ...review, consequence: null },
  { ...review, targetArgument: '' }, { ...review, targetArgument: 1 },
  { ...review, fields: [] }, { ...review, fields: ['bad field'] },
  { ...review, fields: [1] }, { ...review, stepUp: 'false' },
  { ...review, extra: 'credential-canary' }];
it.each(invalidReviews)('excludes only the tool with malformed approval details %j', rejectsReview);

function event(type: string, data: Record<string, unknown>) {
  return { ...envelope('test', 'mcp-fixture', type, data),
    principal: { kind: 'human' as const, id: 'admin' } };
}
function reviewPolicy(saved: Awaited<ReturnType<typeof capture>>, mode: 'allow' | 'ask') {
  const discovered = applyToolPolicy(emptyToolPolicy(), event('mcp.server_discovered', saved), 1);
  expect(discovered.tools[0]).toMatchObject({ reviewed: false, mode: 'block' });
  function choice(declaration: NonNullable<typeof saved.tools>[number]) {
    return { name: declaration.name, revision: declaration.revision,
      reviewDigest: toolReviewDigest(declaration), mode };
  }
  const command = { serverId: 'fixture', connectionId: 'installed-fixture', accountMode: 'none',
    catalogueDigest: saved.schemaDigest, policyRevision: 1, reviewedBy: 'admin',
    tools: saved.tools!.map(choice) };
  return applyToolPolicy(discovered, event('mcp.server_reviewed', command), 2);
}
async function requiresDeclarations(missing: 'cost' | 'review', mode: 'allow' | 'ask') {
  const declared: Record<string, unknown> = { ...tool._meta };
  delete declared[`io.opencrane/${missing === 'cost' ? 'costCents' : 'review'}`];
  const saved = await capture([{ ...tool, _meta: declared }]);
  expect(saved.tools).toHaveLength(1);
  if (missing === 'cost') {
    expect(saved.tools![0]).not.toHaveProperty('costCents');
  }
  function attemptReview() {
    return reviewPolicy(saved, mode);
  }
  if (missing === 'review' && mode === 'allow') {
    expect(attemptReview().tools[0]).toMatchObject({ reviewed: false, mode: 'block' });
  } else {
    expect(attemptReview).toThrow('Tool review does not match the saved catalogue');
  }
}
it.each([['cost', 'allow'], ['cost', 'ask'], ['review', 'allow'], ['review', 'ask']] as const)(
  'keeps missing %s blocked even after exact %s review', requiresDeclarations);

async function enablesExactReview(mode: 'allow' | 'ask') {
  const saved = await capture([tool]);
  expect(reviewPolicy(saved, mode).tools[0]).toMatchObject({ reviewed: true, mode });
}
it.each(['allow', 'ask'] as const)('enables declared tools only after exact %s review',
  enablesExactReview);

async function rejectsOmittedStepUp() {
  const incompleteReview = { action: review.action, consequence: review.consequence,
    targetArgument: review.targetArgument, fields: review.fields };
  const invalid = { ...tool,
    _meta: { ...tool._meta, 'io.opencrane/review': incompleteReview } };
  const sibling = { ...tool, name: 'sibling' };
  const saved = await capture([invalid, sibling]);
  const reviewed = reviewPolicy(saved, 'ask');
  function matchesOmittedTool(candidate: { name: string }) {
    return candidate.name === 'read';
  }
  const omittedTool = reviewed.tools.find(matchesOmittedTool);
  // Keep excluded tools blocked: there is no reviewed policy that can enable them.
  expect.soft(omittedTool?.mode ?? 'block').toBe('block');
  expect.soft(omittedTool).toBeUndefined();
  expect.soft(reviewed.tools).toMatchObject([
    { name: 'sibling', reviewed: true, mode: 'ask' },
  ]);
  expect.soft(saved.tools).toHaveLength(1);
  expect(saved.rejectedTools).toEqual([{ name: 'read',
    revision: losslessJson(JSON.stringify(invalid)).digest, reason: 'invalid_tool_review' }]);
}
it('keeps an omitted stepUp blocked through discovery and exact Ask review with a valid sibling',
  rejectsOmittedStepUp);

async function holdsMetadataChanges(field: 'cost' | 'review') {
  const sibling = { ...tool, name: 'sibling' };
  const before = await capture([tool, sibling]);
  const reviewed = reviewPolicy(before, 'allow');
  const changedMeta: Record<string, unknown> = { ...tool._meta };
  if (field === 'cost') {
    delete changedMeta['io.opencrane/costCents'];
  } else {
    changedMeta['io.opencrane/review'] = { ...review, consequence: 'Show another record' };
  }
  const after = await capture([{ ...tool, _meta: changedMeta }, sibling]);
  expect(after.schemaDigest).not.toBe(before.schemaDigest);
  const changed = event('mcp.tools_changed', { serverId: 'fixture',
    previousSchemaDigest: before.schemaDigest, newSchemaDigest: after.schemaDigest,
    catalogue: after });
  const state = applyToolPolicy({ ...reviewed, published: true }, changed, 3);
  expect(state).toMatchObject({ driftHeld: true, published: false,
    tools: [{ reviewed: false, mode: 'block' }, { reviewed: true, mode: 'allow' }] });
  expect(isToolPolicyAvailable(state)).toBe(false);
}
it.each(['cost', 'review'] as const)('holds the whole server after only %s metadata changes',
  holdsMetadataChanges);

async function preservesUnchangedReview() {
  const before = await capture([tool]);
  const state = reviewPolicy(before, 'allow');
  const after = await capture([tool]);
  const check = event('mcp.catalogue_checked', { serverId: 'fixture', outcome: 'unchanged',
    schemaDigest: after.schemaDigest, checkedAt: after.checkedAt, expiresAt: after.expiresAt });
  const checked = applyToolPolicy(state, check, 3);
  expect(checked.tools).toEqual(state.tools);
  expect(checked.policyRevision).toBe(state.policyRevision);
  const legacy = { ...before, checkedAt: undefined, expiresAt: undefined };
  const blocked = applyToolPolicy(emptyToolPolicy(), event('mcp.server_discovered', legacy), 1);
  expect(blocked.tools[0]).toMatchObject({ reviewed: false, mode: 'block' });
}
it('preserves review on an unchanged check and blocks incomplete legacy records',
  preservesUnchangedReview);

async function rejectsRoundedCost(lexeme: string) {
  const encoded = JSON.stringify({ ...metadata, tools: [tool] });
  const raw = encoded.replace('"io.opencrane/costCents":0', `"io.opencrane/costCents":${lexeme}`);
  function call(method: string) {
    return Promise.resolve(method === 'server/discover' ? JSON.stringify(discovery) : raw);
  }
  const saved = await discoverInventory(call);
  expect(saved.tools).toEqual([]);
  expect(saved.rejectedTools).toMatchObject([{ name: 'read', reason: 'invalid_tool_cost' }]);
}
it.each(['1e-400', '-1e-400'])(
  'does not turn the nonzero cost %s into zero through JSON number rounding', rejectsRoundedCost);

async function refusesModeWithoutDetails() {
  const saved = await capture([tool]);
  const reviewed = reviewPolicy(saved, 'allow');
  const incomplete = { ...saved, tools: [{ ...saved.tools![0]!, review: undefined }] };
  const state = { ...reviewed, catalogue: incomplete,
    tools: [{ ...reviewed.tools[0]!, mode: 'block' as const }] };
  const mode = event('mcp.tool_mode_set', { serverId: 'fixture', connectionId: state.connectionId,
    toolName: 'read', toolRevision: state.tools[0]!.revision, mode: 'allow', setBy: 'admin' });
  expect(applyToolPolicy(state, mode, 3).tools[0]?.mode).toBe('block');
}
it('keeps an incomplete older review blocked when Allow is requested', refusesModeWithoutDetails);

async function replaysIncompleteAllowReview() {
  const complete = await capture([{ ...tool, _meta: undefined }]);
  const declaration = { ...complete.tools![0]!, costCents: 0, review: undefined };
  const older = { ...complete, tools: [declaration] };
  const blocked = reviewPolicy(older, 'allow');
  expect(blocked.tools[0]).toMatchObject({ reviewed: false, mode: 'block' });
  expect(blocked.reviewRevision).toBeUndefined();
  expect(blocked.published).toBe(false);
}
it('replays an older Allow review without approval details as blocked', replaysIncompleteAllowReview);
