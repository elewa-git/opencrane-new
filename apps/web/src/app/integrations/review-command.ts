import type { ToolPolicy } from '@opencrane/protocol';
import { compareToolCatalogues } from './tool-changes';

type Declaration = NonNullable<NonNullable<ToolPolicy['catalogue']>['tools']>[number];
type Choice = { name: string; revision: string; reviewDigest: string;
  mode: 'allow' | 'ask' | 'block' };

async function reviewDigest(declaration: Declaration): Promise<string> {
  const review = declaration.review;
  const sortedReview = review ? {
    action: review.action, consequence: review.consequence, fields: review.fields,
    stepUp: review.stepUp, targetArgument: review.targetArgument,
  } : null;
  const evidence = { costCents: declaration.costCents ?? null,
    review: sortedReview };
  // Use the same key order as the server's saved review digest.
  const bytes = new TextEncoder().encode(JSON.stringify(evidence));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex: string[] = [];
  for (const byte of new Uint8Array(digest)) hex.push(byte.toString(16).padStart(2, '0'));
  return hex.join('');
}

function choiceMode(policy: ToolPolicy, declaration: Declaration): Choice['mode'] {
  let saved: ToolPolicy['tools'][number] | undefined;
  let previous: Declaration | undefined;
  for (const tool of policy.tools) {
    if (tool.name === declaration.name) saved = tool;
  }
  for (const tool of policy.previousCatalogue?.tools ?? []) {
    if (tool.name === declaration.name) previous = tool;
  }
  if (!previous || !saved || declaration.costCents !== 0) return 'block';
  if (saved.mode === 'ask' && declaration.review) return 'ask';
  if (saved.mode === 'allow') return 'allow';
  return 'block';
}

async function reviewChoice(policy: ToolPolicy, declaration: Declaration): Promise<Choice> {
  return { name: declaration.name, revision: declaration.revision,
    reviewDigest: await reviewDigest(declaration), mode: choiceMode(policy, declaration) };
}

export async function reviewCommand(policy: ToolPolicy, commandId: string) {
  const comparison = compareToolCatalogues(policy);
  if (!policy.catalogue?.tools || !policy.connectionId || !policy.accountMode ||
      policy.expiresAt === null || Date.parse(policy.expiresAt) <= Date.now() ||
      !comparison?.reviewable) {
    throw new Error('A fresh tool policy is needed');
  }
  const tools: Choice[] = [];
  for (const declaration of policy.catalogue.tools) {
    tools.push(await reviewChoice(policy, declaration));
  }
  return { commandId, expectedSequence: policy.sequence,
    catalogueDigest: policy.catalogue.schemaDigest,
    connectionId: policy.connectionId, accountMode: policy.accountMode,
    policyRevision: policy.policyRevision, tools };
}
