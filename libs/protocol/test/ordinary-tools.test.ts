import { expect, it } from 'vitest';
import { isOrdinaryToolCatalogue, canReviewTool, toolPolicySchema } from '../src/index.ts';

function standardCatalogue() {
  const data = { serverId: 'standard', toolCount: 1, schemaDigest: 'a'.repeat(64),
    discoverResult: JSON.stringify({ capabilities: { tools: {} } }),
    tools: [{ name: 'read', revision: 'b'.repeat(64), reviewed: false }] };
  return toolPolicySchema.shape.catalogue.unwrap().parse(data);
}

it('recognises standard definitions without inventing a zero cost', () => {
  const catalogue = standardCatalogue();
  expect(isOrdinaryToolCatalogue(catalogue)).toBe(true);
  expect(canReviewTool(catalogue, catalogue.tools![0])).toBe(true);
  expect(catalogue.tools![0]).not.toHaveProperty('costCents');
});

it.each(['cost', 'review', 'revision', 'invalid', 'missing'])(
'keeps the strict contract for declarations and unavailable discovery: %s', mode => {
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
});
