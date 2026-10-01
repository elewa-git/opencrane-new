// Security rules from docs/architecture/events.md rule 5 and plan.md,
// checked as schema rules:
// - no plaintext conversation content in any event (message and agent
//   text travel as `ciphertext` + `keyId`, never as `text` or `content`);
// - credentials only as a secret reference id, never a raw token or password;
// - tool arguments only as a digest, never the raw arguments;
// - reasons are short codes, never free text.
//
// Every negative test starts from the event type's own valid registry
// example and changes only the field under test, and `rejectedFields`
// names exactly which field(s) the schema complained about. So a test can
// only pass if the schema rejects *that field*: if the rule is removed
// (say `text` becomes an allowed optional field), the result is an empty
// list and the test fails. A test built from an incomplete object would
// also fail, but for the wrong reason (a missing required field), and would
// keep passing after the rule was removed.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { eventRegistry, getEventDefinition } from '../src/registry.ts';

function definitionFor(type: string) {
  const definition = getEventDefinition(type);
  if (!definition) {
    throw new Error(`no such event type: ${type}`);
  }
  return definition;
}

/**
 * Parses the type's valid example with `patch` applied and returns the
 * names of the fields the schema rejected (sorted), or [] if it accepted
 * the patched data. An extra field counts as rejected under its own name.
 */
function rejectedFields(type: string, patch: Record<string, unknown>): string[] {
  const { dataSchema, example } = definitionFor(type);
  // The unpatched example must be valid, so any failure below is the patch's.
  expect(dataSchema.safeParse(example).success).toBe(true);
  const result = dataSchema.safeParse({ ...(example as Record<string, unknown>), ...patch });
  if (result.success) {
    return [];
  }
  const names = result.error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys' ? issue.keys : [String(issue.path[0])],
  );
  return [...new Set(names)].sort();
}

describe('no plaintext conversation content', () => {
  const plaintextFields: ReadonlyArray<[type: string, field: string, value: unknown]> = [
    ['message.posted', 'text', 'this should have been encrypted'],
    ['agent.message_completed', 'text', 'this should have been encrypted'],
    ['agent.reasoning_summarised', 'summary', 'the reasoning, in plain text'],
    ['memory.written', 'content', 'Alice prefers email over chat'],
    ['memory.corrected', 'content', 'corrected plain text'],
  ];

  for (const [type, field, value] of plaintextFields) {
    it(`${type} rejects a plaintext ${field} field next to its valid ciphertext`, () => {
      expect(rejectedFields(type, { [field]: value })).toEqual([field]);
    });
  }

  it.each([
    ['a plain sentence', 'Please wire EUR 10,000 to IBAN NL91ABNA0417164300 today'],
    ['a hyphenated phrase', 'Alice-salary-is-95k-and-she-is-on-sick-leave'],
    ['an underscored phrase', 'Alice_salary_is_95k_and_she_is_sick'],
    ['base64url text', 'ZmFrZS1jaXBoZXJ0ZXh0-_ZmFrZQ'],
    ['unpadded base64', 'ZmFrZS1jaXBoZXJ0ZXh0Zg'],
    ['a short word', 'hello'],
  ])('ciphertext rejects %s', (_label, ciphertext) => {
    expect(rejectedFields('memory.written', { ciphertext })).toEqual(['ciphertext']);
  });

  it('ciphertext accepts padded standard base64', () => {
    expect(rejectedFields('memory.written', { ciphertext: 'YmFzZTY0LWxvb2tpbmctdGV4dA==' })).toEqual([]);
  });

  it.each(['key_1', '1', 'key:', 'key:has space', 'secret:1'])('keyId rejects "%s"', (keyId) => {
    expect(rejectedFields('memory.written', { keyId })).toEqual(['keyId']);
  });

  it('message.posted carries a keyId, so a key change or a "forget" can find its messages', () => {
    const { example } = definitionFor('message.posted');
    expect(example).toHaveProperty('keyId');
    const { keyId: _removed, ...withoutKey } = example as Record<string, unknown>;
    expect(definitionFor('message.posted').dataSchema.safeParse(withoutKey).success).toBe(false);
  });
});

describe('credentials only as a reference id', () => {
  it.each(['connection.created', 'connection.refreshed'])('%s rejects a raw token next to its valid secretRef', (type) => {
    expect(rejectedFields(type, { token: 'ya29.raw-oauth-token-value' })).toEqual(['token']);
  });

  it.each([
    ['a raw OAuth token', 'ya29.a0AfH6SMBx-real-google-oauth-access-token'],
    ['a raw password', 'hunter2-my-odoo-password'],
    ['a bare id with no "secret:" prefix', 'secret_1'],
    ['a key reference', 'key:1'],
  ])('secretRef rejects %s', (_label, secretRef) => {
    expect(rejectedFields('connection.created', { secretRef })).toEqual(['secretRef']);
  });

  it.each([
    ['user:password in the URL', 'https://admin:SuperSecretPass@odoo.example.com/mcp'],
    ['an api_key query parameter', 'https://odoo.example.com/mcp?api_key=sk_live_abc'],
    ['an access_token query parameter', 'https://odoo.example.com/mcp?x=1&access_token=abc'],
    ['something that is not a URL', 'odoo-mcp'],
  ])('mcp.server_registered rejects a locator with %s', (_label, locator) => {
    expect(rejectedFields('mcp.server_registered', { locator })).toEqual(['locator']);
  });
});

describe('tool arguments only as a digest', () => {
  it('tool.approval_requested rejects the raw arguments next to its valid digest', () => {
    expect(rejectedFields('tool.approval_requested', { arguments: { recordId: 42, value: 1000 } })).toEqual([
      'arguments',
    ]);
  });

  it('agent.command_ran rejects a raw command line next to its valid digest', () => {
    const command = 'curl -H "Authorization: Bearer sekret" https://example.com';
    expect(rejectedFields('agent.command_ran', { command })).toEqual(['command']);
  });

  it.each([
    ['tool.approval_requested', 'argumentsDigest'],
    ['agent.command_ran', 'commandDigest'],
    ['mcp.server_discovered', 'schemaDigest'],
  ])('%s rejects a %s that is not a sha-256 hex digest', (type, field) => {
    expect(rejectedFields(type, { [field]: 'not-a-digest' })).toEqual([field]);
    expect(rejectedFields(type, { [field]: 'A'.repeat(64) })).toEqual([field]); // upper case is not the format
  });

  it('tool.approval_requested names the assistant (approvals are bound to requester, conversation, turn, assistant and digest)', () => {
    const { example, dataSchema } = definitionFor('tool.approval_requested');
    const { assistantId: _removed, ...withoutAssistant } = example as Record<string, unknown>;
    expect(dataSchema.safeParse(withoutAssistant).success).toBe(false);
  });
});

describe('reasons are short codes, not free text', () => {
  const reasonFields: ReadonlyArray<[type: string, example: string]> = [
    ['agent.turn_failed', 'model_error'],
    ['mcp.server_rejected', 'ssrf_guard_failed'],
    ['security.alert_raised', 'effect_without_permit'],
    ['member.removed', 'left_company'],
  ];

  for (const [type, code] of reasonFields) {
    it(`${type} accepts a code and rejects a sentence`, () => {
      expect(rejectedFields(type, { reason: code })).toEqual([]);
      expect(rejectedFields(type, { reason: 'Alice told me in the chat that she is leaving' })).toEqual(['reason']);
      expect(rejectedFields(type, { reason: 'Model_Error' })).toEqual(['reason']);
    });
  }
});

describe('budget scopes say what they apply to', () => {
  const ceiling = { ceilingMinorUnits: 1000, setBy: 'mem_1' };
  const parse = (type: string, data: unknown) => definitionFor(type).dataSchema.safeParse(data).success;

  it.each(['budget.ceiling_set', 'budget.exhausted'])('%s needs a scopeId for a group or assistant, and refuses one for global', (type) => {
    const extra = type === 'budget.ceiling_set' ? ceiling : {};
    expect(parse(type, { scope: 'global', ...extra })).toBe(true);
    expect(parse(type, { scope: 'paying_group', scopeId: 'team_1', ...extra })).toBe(true);
    expect(parse(type, { scope: 'assistant', scopeId: 'asst_1', ...extra })).toBe(true);
    expect(parse(type, { scope: 'assistant', ...extra })).toBe(false);
    expect(parse(type, { scope: 'paying_group', ...extra })).toBe(false);
    expect(parse(type, { scope: 'global', scopeId: 'asst_1', ...extra })).toBe(false);
  });

  it('budget.reserved names the assistant, so a per-assistant ceiling can be checked', () => {
    expect(rejectedFields('budget.reserved', { assistantId: undefined })).toEqual(['assistantId']);
  });

  it.each([
    ['budget.reserved', 'amountMinorUnits'],
    ['budget.settled', 'settledMinorUnits'],
    ['effect.observed', 'costMinorUnits'],
  ])('%s counts %s in whole cents', (type, field) => {
    expect(rejectedFields(type, { [field]: 0.1 + 0.2 })).toEqual([field]);
    expect(rejectedFields(type, { [field]: -1 })).toEqual([field]);
    expect(rejectedFields(type, { [field]: 30 })).toEqual([]);
  });
});

// The two tests below look at every schema in the registry, so a new event
// type, or a new field on an old one, is held to the same rules without
// anyone remembering to add a test for it.

// Every property name a JSON Schema document declares, at any depth.
function propertyNames(node: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) propertyNames(item, found);
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'properties' && typeof value === 'object' && value !== null) {
        for (const name of Object.keys(value)) found.add(name);
      }
      propertyNames(value, found);
    }
  }
  return found;
}

// Names that would hold content or a credential, if an event had them.
const FORBIDDEN_FIELD_NAMES = [
  'text', 'content', 'body', 'message', 'summary', 'prompt', 'plaintext',
  'token', 'password', 'secret', 'apikey', 'api_key', 'accesstoken',
  'arguments', 'args', 'command',
];

describe('every event schema in the registry', () => {
  it('declares no field named like plaintext content or a credential', () => {
    for (const entry of eventRegistry) {
      const names = [...propertyNames(z.toJSONSchema(entry.dataSchema))].map((name) => name.toLowerCase());
      expect(names.filter((name) => FORBIDDEN_FIELD_NAMES.includes(name)), entry.type).toEqual([]);
    }
  });

  it('constrains every field (no z.unknown() or z.any() hiding in a schema)', () => {
    const constraining = ['type', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', '$ref'];
    const unconstrained: string[] = [];
    const walk = (type: string, node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(type, item, `${path}[${String(index)}]`));
      } else if (typeof node === 'object' && node !== null) {
        const record = node as Record<string, unknown>;
        const properties = record['properties'];
        if (typeof properties === 'object' && properties !== null) {
          for (const [name, schema] of Object.entries(properties)) {
            if (!constraining.some((key) => key in (schema as object))) unconstrained.push(`${type}.${path}${name}`);
          }
        }
        for (const [key, value] of Object.entries(record)) walk(type, value, `${path}${key}.`);
      }
    };
    for (const entry of eventRegistry) walk(entry.type, z.toJSONSchema(entry.dataSchema), '');
    expect(unconstrained).toEqual([]);
  });
});
