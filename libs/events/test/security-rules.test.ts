// Security rules from docs/architecture/events.md rule 5 and plan.md,
// checked as schema rules:
// - no plaintext conversation content in any event (message and agent
//   text travel as `ciphertext` + `keyId`, never as `text` or `content`);
// - credentials only as a secret reference id, never a raw token or password;
// - tool arguments only as a digest, never the raw arguments;
// - reasons are short codes, never free text.
//
// Every negative test starts from the event type's own valid registry
// example and changes only the field under test, and `rejectedFields` names
// the field(s) the schema complained about. So a test passes only if the
// schema rejects *that field*: remove the rule and the result is an empty
// list. A test built from an incomplete object would fail for the wrong
// reason (a missing field) and keep passing after the rule was removed.
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

// Every event type whose schema declares a field of this name, read from the
// schemas (not the examples). Rules about a field then run over all of them,
// so a loosened or new event type cannot slip past a test that named a few.
function typesDeclaring(field: string): string[] {
  return eventRegistry
    .filter((entry) => propertyNames(z.toJSONSchema(entry.dataSchema)).has(field))
    .map((entry) => entry.type);
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

  // Each rule runs over every type that declares the field. The check on the
  // list stops these loops from passing by running over nothing.
  const ciphertextTypes = typesDeclaring('ciphertext');
  const keyIdTypes = typesDeclaring('keyId');

  it('finds the event types that carry ciphertext, and they all carry a key id too', () => {
    expect(ciphertextTypes).toEqual(
      expect.arrayContaining(['message.posted', 'agent.message_completed', 'agent.reasoning_summarised', 'memory.written', 'memory.corrected']),
    );
    expect(keyIdTypes).toEqual(ciphertextTypes);
  });

  describe.each(ciphertextTypes)('%s ciphertext', (type) => {
    it.each([
      'Please wire EUR 10,000 to IBAN NL91ABNA0417164300 today', // a sentence
      'Alice-salary-is-95k-and-she-is-on-sick-leave', // hyphens: base64url, not base64
      'Alice_salary_is_95k_and_she_is_sick',
      'ZmFrZS1jaXBoZXJ0ZXh0-_ZmFrZQ',
      'ZmFrZS1jaXBoZXJ0ZXh0Zg', // unpadded
      'hello',
      // Valid base64 under 16 characters: only the length rule can refuse these.
      'password',
      'Zm9vYmFyYmF6',
    ])('rejects "%s"', (ciphertext) => {
      expect(rejectedFields(type, { ciphertext })).toEqual(['ciphertext']);
    });

    it.each(['YmFzZTY0LWxvb2tpbmctdGV4dA==', 'YmFzZTY0LWxvb2s=' /* exactly 16 */])('accepts "%s"', (ciphertext) => {
      expect(rejectedFields(type, { ciphertext })).toEqual([]);
    });
  });

  describe.each(keyIdTypes)('%s keyId', (type) => {
    it.each(['key_1', '1', 'key:', 'key:has space', 'key:1\n', 'secret:1', 'c2VjcmV0LWtleS1ieXRlcw=='])('rejects "%s"', (keyId) => {
      expect(rejectedFields(type, { keyId })).toEqual(['keyId']);
    });

    it.each(['key:1', 'key:abc_DEF-123'])('accepts "%s"', (keyId) => {
      expect(rejectedFields(type, { keyId })).toEqual([]);
    });
  });

  it('message.posted carries a keyId, so a key change or a "forget" can find its messages', () => {
    const { example } = definitionFor('message.posted');
    expect(example).toHaveProperty('keyId');
    const { keyId: _removed, ...withoutKey } = example as Record<string, unknown>;
    expect(definitionFor('message.posted').dataSchema.safeParse(withoutKey).success).toBe(false);
  });
});

describe('credentials only as a reference id', () => {
  const secretRefTypes = typesDeclaring('secretRef');

  it('finds the event types that carry a secret reference', () => {
    expect(secretRefTypes).toEqual(expect.arrayContaining(['connection.created', 'connection.refreshed']));
  });

  describe.each(secretRefTypes)('%s', (type) => {
    it('rejects a raw token next to its valid secretRef', () => {
      expect(rejectedFields(type, { token: 'ya29.raw-oauth-token-value' })).toEqual(['token']);
    });

    it.each([
      'ya29.a0AfH6SMBx-real-google-oauth-access-token',
      'hunter2-my-odoo-password',
      'Bearer abc123',
      'secret_1', // no "secret:" prefix
      'secret:',
      'secret:has space',
      'secret:1\n',
      'key:1',
    ])('secretRef rejects "%s"', (secretRef) => {
      expect(rejectedFields(type, { secretRef })).toEqual(['secretRef']);
    });

    it.each(['secret:1', 'secret:conn_abc-123'])('secretRef accepts "%s"', (secretRef) => {
      expect(rejectedFields(type, { secretRef })).toEqual([]);
    });
  });
});

// plan.md: "the admin enters a URL or picks an image". Neither kind may hold
// a credential. The example is a remote server, so `kind` and `locator` are
// patched together.
describe('mcp.server_registered locator', () => {
  const type = 'mcp.server_registered';
  const url = 'https://odoo.example.com/mcp';
  const repo = 'ghcr.io/elewa-git/odoo-mcp-server';
  const digest = '0123456789abcdef'.repeat(4);
  const image = `${repo}@sha256:${digest}`;
  const asRemote = (locator: string) => rejectedFields(type, { kind: 'remote', locator });
  const asHosted = (locator: string) => rejectedFields(type, { kind: 'hosted', locator });

  it.each([url, 'http://mcp.example.com:8080/mcp', 'HTTPS://ODOO.EXAMPLE.COM/mcp', `${url}/@scope/mcp`])(
    'a remote server accepts %j',
    (locator) => {
      expect(asRemote(locator)).toEqual([]);
    },
  );

  it.each([
    // Not a web address.
    'file:///etc/passwd',
    'javascript:alert(1)',
    'odoo-mcp',
    image,
    // Credentials in the address, however it is spelled.
    'https://admin:SuperSecretPass@odoo.example.com/mcp',
    'https://admin@odoo.example.com/mcp',
    'https://:SuperSecretPass@odoo.example.com/mcp',
    'https:admin:pass@odoo.example.com/mcp',
    'https:///admin:pass@odoo.example.com/mcp',
    // Any query string or fragment, whatever it is named or spelled.
    `${url}?api_key=sk_live_abc`,
    `${url}?client_secret=abc`,
    `${url}?api%5Fkey=abc`,
    `${url}?x=1&Authorization=Bearer%20abc`,
    `${url}?x=1`,
    `${url}?`,
    `${url}#access_token=abc`,
    `${url}#`,
    // Whitespace and backslashes: parsers read them differently or quietly clean them up.
    ` ${url}`,
    `${url}\n`,
    'https://odoo.example.com/\tmcp',
    'https://odoo.example.com\\@evil.example.com/mcp',
  ])('a remote server rejects %j', (locator) => {
    expect(asRemote(locator)).toEqual(['locator']);
  });

  it.each([image, `registry.example.com:5000/team/app/server@sha256:${digest}`, `localhost:5000/odoo_mcp.server__v2@sha256:${digest}`])(
    'a hosted server accepts %j',
    (locator) => {
      expect(asHosted(locator)).toEqual([]);
    },
  );

  it.each([
    repo, // no digest
    `${repo}:latest`, // a tag can be moved after the image was scanned
    `${repo}:1.2.3@sha256:${digest}`,
    `${repo}@sha256:${digest.toUpperCase()}`,
    `${repo}@sha256:${digest.slice(1)}`, // one character short
    `${repo}@sha256:${'z'.repeat(64)}`,
    `${repo}@sha512:${digest}`,
    `elewa-git/odoo-mcp-server@sha256:${digest}`, // registry not named
    `ghcr.io@sha256:${digest}`, // no repository
    `ghcr.io/Elewa/odoo-mcp-server@sha256:${digest}`,
    `https://${image}`,
    `admin:pass@${image}`,
    `${image}\n`,
    url,
  ])('a hosted server rejects %j', (locator) => {
    expect(asHosted(locator)).toEqual(['locator']);
  });

  it('refuses a kind that is neither remote nor hosted, or missing', () => {
    expect(rejectedFields(type, { kind: 'local' })).toEqual(['kind']);
    expect(rejectedFields(type, { kind: undefined })).toEqual(['kind']);
  });

  it('keeps a hosted registration strict: an extra field is refused', () => {
    expect(rejectedFields(type, { kind: 'hosted', locator: image, token: 'x' })).toEqual(['token']);
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
