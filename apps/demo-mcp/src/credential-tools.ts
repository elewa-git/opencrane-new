import { z } from 'zod';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { losslessJson } from '@opencrane/events/lossless-json';
import { catalogue, changeArguments, createFixture, readArguments } from './tools.ts';

const demoAccountSchema = z.strictObject({
  account: z.string().min(1).max(100), key: z.string().min(1), permitted: z.boolean(),
});
export const demoAccountsSchema = z.tuple([demoAccountSchema, demoAccountSchema]);
export interface DemoCredentials {
  accounts: Readonly<z.infer<typeof demoAccountsSchema>>;
}
const identityArguments = z.strictObject({ check: z.literal('account').default('account') });
const identityOutput = z.strictObject({ subject: z.string(), actedAs: z.string() });
const identityTool = {
  name: 'who_am_i', description: 'Return the synthetic account for this key.',
  inputSchema: z.toJSONSchema(identityArguments), outputSchema: z.toJSONSchema(identityOutput),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true,
    openWorldHint: false },
  _meta: { 'io.opencrane/costCents': 0, 'io.opencrane/review': {
    action: 'Check account', consequence: 'Read the account without changing it.',
    targetArgument: 'check', fields: ['check'], stepUp: false,
  } },
};
function withAccount(tool: typeof catalogue.tools[number]) {
  const original = tool.outputSchema;
  const outputSchema = { ...original, properties: {
    ...original.properties, actedAs: { type: 'string' },
  }, required: [...(original.required ?? []), 'actedAs'] };
  return { ...tool, outputSchema };
}
function revisionOf(tool: { name: string }) {
  return { name: tool.name, revision: losslessJson(JSON.stringify(tool)).digest };
}
function result(structuredContent: Record<string, unknown>, isError = false) {
  const content = [{ type: 'text', text: JSON.stringify(structuredContent) }];
  return { content, structuredContent, isError };
}

export function credentialFixture(credentials: DemoCredentials) {
  const accounts = demoAccountsSchema.parse(credentials.accounts);
  if (accounts[0].key === accounts[1].key || accounts[0].account === accounts[1].account) {
    throw new Error('invalid_accounts');
  }
  const tools = catalogue.tools.map(withAccount);
  const checkedTools = [...tools, identityTool];
  const revisions = checkedTools.map(revisionOf);
  const revision = catalogueDigest(revisions);
  const defaultRevisions = catalogue.tools.map(revisionOf);
  const defaultRevision = catalogueDigest(defaultRevisions);
  const fixture = createFixture();
  const checkedCatalogue = { ...catalogue, tools: checkedTools };

  function call(name: string, args: unknown, expected: unknown, authorization: unknown) {
    if (expected !== revision) throw new Error('revision_mismatch');
    function matching(account: typeof accounts[number]) {
      return authorization === `Bearer ${account.key}`;
    }
    const account = accounts.find(matching);
    if (!account) throw new Error('invalid_request');
    if (name === identityTool.name) {
      identityArguments.parse(args);
      return result({ subject: account.account, actedAs: account.account });
    }
    if (name === 'read_fixture_quote') readArguments.parse(args);
    else if (name === 'change_delivery_slot') changeArguments.parse(args);
    else throw new Error('invalid_request');
    if (!account.permitted) {
      return result({ reason: 'not_permitted', actedAs: account.account }, true);
    }
    const response = fixture(name, args, defaultRevision);
    return result({ ...response.structuredContent, actedAs: account.account });
  }
  return { catalogue: checkedCatalogue, call };
}
