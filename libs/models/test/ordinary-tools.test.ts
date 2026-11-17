import { expect, it } from 'vitest';
import { toolPolicySchema } from '@opencrane/protocol';
import { toolDecision } from '../src/mcp.ts';

const reviewedTool = toolPolicySchema.shape.tools.element.parse({
  name: 'read', revision: 'b'.repeat(64), reviewed: true, readOnly: true,
  mode: 'allow', suggestion: 'allow',
});

function refusesUndeclaredCost() {
  expect(toolDecision(reviewedTool)).toEqual({ outcome: 'deny', reason: 'unknown_cost' });
  expect(toolDecision(reviewedTool, true)).toEqual({ outcome: 'allow', reason: 'policy_allow' });
  expect(toolDecision({ ...reviewedTool, costCents: 0 })).toEqual({
    outcome: 'allow', reason: 'policy_allow',
  });
}
it('keeps unknown cost refused unless the catalogue is explicitly ordinary', refusesUndeclaredCost);

function refusesUnreviewedOrdinaryTools() {
  const unreviewed = { ...reviewedTool, reviewed: false };
  expect(toolDecision(unreviewed, true)).toEqual({ outcome: 'deny', reason: 'policy_block' });
  const blocked = { ...reviewedTool, mode: 'block' as const };
  expect(toolDecision(blocked, true)).toEqual({ outcome: 'deny', reason: 'policy_block' });
  expect(toolDecision(undefined, true)).toEqual({ outcome: 'deny', reason: 'policy_block' });
}
it('keeps unreviewed and blocked ordinary tools refused', refusesUnreviewedOrdinaryTools);
