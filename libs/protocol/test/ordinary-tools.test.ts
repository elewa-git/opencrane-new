import { expect, it } from 'vitest';
import { isOrdinaryToolCatalogue, canReviewTool, toolPolicySchema } from '../src/index.ts';

function standardCatalogue() {
  const data = { serverId: 'standard', toolCount: 1, schemaDigest: 'a'.repeat(64),
    discoverResult: JSON.stringify({ capabilities: { tools: {} } }),
    tools: [{ name: 'read', revision: 'b'.repeat(64), reviewed: false }] };
  return toolPolicySchema.shape.catalogue.unwrap().unwrap().parse(data);
}

function recognisesOrdinaryCatalogue() {
  const catalogue = standardCatalogue();
  expect(isOrdinaryToolCatalogue(catalogue)).toBe(true);
  expect(canReviewTool(catalogue, catalogue.tools![0])).toBe(true);
  expect(catalogue.tools![0]).not.toHaveProperty('costCents');
}
it('recognises standard definitions without inventing a zero cost', recognisesOrdinaryCatalogue);

function refusesDeclaredOrUnavailableCatalogue(mode: string) {
  const catalogue = standardCatalogue();
  const tool = catalogue.tools![0]!;
  if (mode === 'cost') tool.costCents = 0;
  if (mode === 'review') tool.review = { action: 'Read', consequence: 'Read records',
    targetArgument: 'id', fields: ['id'], stepUp: false };
  if (mode === 'revision') catalogue.discoverResult = JSON.stringify({ capabilities: {
    tools: {}, experimental: { 'io.opencrane/expectedRevision': {} } } });
  if (mode === 'invalid') catalogue.discoverResult = 'invalid';
  if (mode === 'missing') delete catalogue.discoverResult;
  expect(isOrdinaryToolCatalogue(catalogue)).toBe(false);
  expect(canReviewTool(catalogue, tool)).toBe(false);
}
it.each(['cost', 'review', 'revision', 'invalid', 'missing'])(
'keeps the strict contract for declarations and unavailable discovery: %s', refusesDeclaredOrUnavailableCatalogue);

function refusesHostedCatalogue() {
  const catalogue = standardCatalogue();
  catalogue.hostedRun = { imageDigest: 'a'.repeat(64), platform: 'linux/amd64',
    podUid: 'pod', workloadSpecDigest: 'b'.repeat(64), runGeneration: 1 };
  expect(isOrdinaryToolCatalogue(catalogue)).toBe(false);
  expect(canReviewTool(catalogue, catalogue.tools![0])).toBe(false);
}
it('keeps a hosted run outside ordinary catalogue review', refusesHostedCatalogue);

function refusesIncompleteRejectedEvidence() {
  const catalogue = standardCatalogue();
  catalogue.rejectedTools = [{ name: 'paid', revision: 'c'.repeat(64),
    reason: 'invalid_tool_cost' }];
  expect(isOrdinaryToolCatalogue(catalogue)).toBe(false);
  catalogue.declared = true;
  expect(isOrdinaryToolCatalogue(catalogue)).toBe(false);
  catalogue.declared = false;
  expect(isOrdinaryToolCatalogue(catalogue)).toBe(true);
}
it('requires complete-list declaration evidence after a tool was rejected',
  refusesIncompleteRejectedEvidence);

function refusesSavedDeclaration() {
  const catalogue = standardCatalogue();
  catalogue.tools![0]!.definition = JSON.stringify({ name: 'read',
    inputSchema: { type: 'object' }, _meta: { 'io.opencrane/costCents': 1 } });
  expect(isOrdinaryToolCatalogue(catalogue)).toBe(false);
}
it('keeps saved tool declarations strict before complete-list flags were recorded',
  refusesSavedDeclaration);
