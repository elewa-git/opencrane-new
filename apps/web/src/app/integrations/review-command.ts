import type { ToolPolicy } from '@opencrane/protocol';

type Declaration = NonNullable<NonNullable<ToolPolicy['catalogue']>['tools']>[number];
type Choice = { name: string; revision: string; reviewDigest: string;
  mode: 'allow' | 'ask' | 'block' };

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (const entry of value) entries.push(sortedJson(entry));
    return `[${entries.join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries: string[] = [];
    for (const key of keys) entries.push(`${JSON.stringify(key)}:${sortedJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

async function reviewDigest(declaration: Declaration): Promise<string> {
  const evidence = { costCents: declaration.costCents ?? null,
    review: declaration.review ?? null };
  const bytes = new TextEncoder().encode(sortedJson(evidence));
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
  if (!policy.catalogue?.tools || !policy.connectionId || !policy.accountMode ||
      policy.expiresAt === null || Date.parse(policy.expiresAt) <= Date.now()) {
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
