import { expect, it } from 'vitest';
import { sessionConfiguration, type SessionConfiguration,
  type SessionConfigurationInput } from '../src/session-configuration.ts';

type ConfigurationCase = {
  name: string;
  input: SessionConfigurationInput;
  expected: SessionConfiguration;
};

const personal: SessionConfiguration = {
  kind: 'personal', payer: 'installation_default', payerMatchesAssistant: false,
  assistantPayerRequired: false,
  executionMode: 'memory_free', process: 'persistent_thread', context: 'thread',
  tools: 'reviewed_mcp', credentials: { personal: true, company: 'never' },
  memory: 'none', uploads: true, attachments: true, localTools: true,
  sharingClass: undefined,
};
const privatePersonal: SessionConfiguration = {
  kind: 'personal', payer: 'installation_default', payerMatchesAssistant: false,
  assistantPayerRequired: false,
  executionMode: 'restricted', process: 'fresh_isolated', context: 'own_exchanges',
  tools: 'memory_only', credentials: { personal: false, company: 'never' },
  memory: 'personal', uploads: true, attachments: false, localTools: false,
  sharingClass: undefined,
};
const teamPrivate: SessionConfiguration = {
  kind: 'team_private', payer: 'assistant_group', payerMatchesAssistant: true,
  assistantPayerRequired: true,
  executionMode: 'restricted', process: 'fresh_isolated', context: 'own_exchanges',
  tools: 'none', credentials: { personal: false, company: 'never' },
  memory: 'none', uploads: false, attachments: false, localTools: false,
  sharingClass: undefined,
};
const teamMemoryFree: SessionConfiguration = {
  kind: 'team_private', payer: 'assistant_group', payerMatchesAssistant: true,
  assistantPayerRequired: true,
  executionMode: 'memory_free', process: 'persistent_thread', context: 'thread',
  tools: 'none', credentials: { personal: false, company: 'never' },
  memory: 'none', uploads: false, attachments: true, localTools: true,
  sharingClass: undefined,
};
const child: SessionConfiguration = {
  kind: 'shared_child', payer: 'root_allowance', payerMatchesAssistant: true,
  assistantPayerRequired: true,
  executionMode: 'restricted', process: 'fresh_isolated', context: 'shared_exchanges',
  tools: 'none', credentials: { personal: false, company: 'never' },
  memory: 'none', uploads: false, attachments: false, localTools: false,
  sharingClass: 'shared_only',
};
const routine: SessionConfiguration = {
  kind: 'routine', payer: 'root_allowance', payerMatchesAssistant: true,
  assistantPayerRequired: true,
  executionMode: 'restricted', process: 'fresh_isolated', context: 'routine_input',
  tools: 'reviewed_mcp', credentials: { personal: false, company: 'routine_ask' },
  memory: 'none', uploads: false, attachments: false, localTools: false,
  sharingClass: undefined,
};
const personalInput: SessionConfigurationInput = {
  conversation: {}, assistantKind: 'personal', memoryEnabled: false,
};
const teamInput: SessionConfigurationInput = {
  conversation: { payingGroupId: 'group' }, assistantKind: 'team',
  assistantPayingGroupId: 'group', memoryEnabled: false,
};
const cases: ConfigurationCase[] = [
  { name: 'personal without qualified memory', input: personalInput, expected: personal },
  { name: 'personal with qualified memory',
    input: { ...personalInput, memoryEnabled: true }, expected: privatePersonal },
  { name: 'personal explicitly without memory on a qualified installation',
    input: { ...personalInput, memoryEnabled: true, requestedMode: 'memory_free' },
    expected: personal },
  { name: 'private session with a shared assistant in restricted mode',
    input: teamInput, expected: teamPrivate },
  { name: 'private session with a shared assistant in memory-free mode',
    input: { ...teamInput, requestedMode: 'memory_free' }, expected: teamMemoryFree },
  { name: 'subchat with a shared assistant',
    input: { ...teamInput, conversation: { payingGroupId: 'group', contextKind: 'shared_child' } },
    expected: child },
  { name: 'subchat with a personal assistant', input: { ...personalInput,
    conversation: { contextKind: 'shared_child' } },
    expected: { ...child, payerMatchesAssistant: false, assistantPayerRequired: false, uploads: true } },
  { name: 'routine run', input: { ...teamInput,
    conversation: { payingGroupId: 'group', routinePreparation: {} } }, expected: routine },
  { name: 'shared assistant with a different payer', input: { ...teamInput,
    conversation: { payingGroupId: 'other' } },
    expected: { ...teamPrivate, payerMatchesAssistant: false } },
  { name: 'shared assistant without a payer',
    input: { ...teamInput, conversation: {}, assistantPayingGroupId: undefined },
    expected: { ...teamPrivate, payerMatchesAssistant: false } },
];

function matchesFullConfiguration(test: ConfigurationCase) {
  expect(sessionConfiguration(test.input)).toEqual(test.expected);
}
it.each(cases)('$name', matchesFullConfiguration);

function acceptsSharedContextWithTools() {
  const sharedWithTools: SessionConfiguration = { ...child, tools: 'reviewed_mcp' };
  expect(sharedWithTools.context).toBe('shared_exchanges');
  expect(sharedWithTools.tools).toBe('reviewed_mcp');
}
it('keeps context and tools independent in the configuration type', acceptsSharedContextWithTools);

function derivesSharedSessionFromSignedClaims() {
  const input = { ...teamInput, sharingClass: 'shared_only' as const };
  expect(sessionConfiguration(input)).toEqual(child);
}
it('derives the same subchat configuration from signed turn claims',
  derivesSharedSessionFromSignedClaims);
