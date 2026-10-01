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
  const ceiling = { ceilingCents: 1000, setBy: 'mem_1' };
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
});

// The tests below look at every schema in the registry, so a new event type,
// or a new field on an old one, is held to the same rules without anyone
// remembering to add a test for it. The checks are plain functions so the last
// describe can prove they work: it runs them on a real event type's schema
// with one bad field added, which must be caught.

// What a schema accepts, as JSON Schema. `io: 'input'` is needed: the default
// (output) view shows `additionalProperties: false` even on an object that
// quietly drops unknown fields, so it cannot tell a strict object from a loose one.
function acceptedShape(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { io: 'input' });
}

// A field name that suggests content or a credential. It is matched anywhere
// in the name, ignoring case and camelCase or snake_case spelling, so
// refreshToken, access_token, replyText and BODY_TEXT are all caught.
// "arg" alone must be a whole word (so targetScopeId is fine).
const RISKY_FIELD_NAME = new RegExp(
  [
    'text', 'content', 'body', 'message', 'summary', 'prompt', 'note', 'markdown', 'html',
    'token', 'passw', 'secret', 'api_?key', 'credential', 'authoriz', 'cookie', 'bearer', 'private_?key', 'header',
    'args', 'arguments', 'command', '(^|[^a-z])arg([^a-z]|$)',
  ].join('|'),
);
// The risky-looking names that are approved: encrypted text and its key id, a
// secret reference, and a message's id. Any `...Digest` is approved too (a
// hash of a value, not the value). Matching is exact, so `Ciphertext` is not.
const APPROVED_FIELD_NAMES = new Set(['ciphertext', 'contentType', 'keyId', 'secretRef', 'messageId']);

// Declared field names, at any depth, that are risky and not approved. This is a
// net for accidents, not proof: a field with an innocent name still passes by
// name, and is held by the shape rules above and the structural check below.
function riskyFieldNames(jsonSchema: unknown): string[] {
  return [...propertyNames(jsonSchema)].filter((name) => {
    const spelled = name.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();
    return RISKY_FIELD_NAME.test(spelled) && !APPROVED_FIELD_NAMES.has(name) && !name.endsWith('Digest');
  });
}

// Where a schema is not fully pinned down: every object must be closed
// (`additionalProperties: false`), and every sub-schema, at any depth, must say
// what it accepts. An open object is where `{ text: '...' }` could hide, and an
// empty `{}` (z.unknown(), z.any(), an item or union member of unknown type)
// accepts anything. Returns one description per problem, with its position.
const CONSTRAINING = ['type', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', '$ref', 'not'];
function looseSpots(jsonSchema: unknown): string[] {
  const spots: string[] = [];
  const visit = (node: unknown, at: string): void => {
    if (node === false) return; // "nothing is allowed" is as tight as it gets
    if (typeof node !== 'object' || node === null) {
      spots.push(`${at}: accepts anything`); // a bare `true`
      return;
    }
    const schema = node as Record<string, unknown>;
    if (!CONSTRAINING.some((key) => key in schema)) spots.push(`${at}: says nothing about what it accepts`);
    if ((schema['type'] === 'object' || 'properties' in schema) && schema['additionalProperties'] !== false) {
      spots.push(`${at}: object is open to extra fields`);
    }
    for (const key of ['items', 'additionalProperties', 'propertyNames']) {
      if (key in schema) visit(schema[key], `${at}/${key}`);
    }
    for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
      const list = schema[key];
      if (Array.isArray(list)) list.forEach((item, index) => visit(item, `${at}/${key}/${String(index)}`));
    }
    for (const key of ['properties', '$defs']) {
      const map = schema[key];
      if (typeof map === 'object' && map !== null) {
        for (const [name, sub] of Object.entries(map)) visit(sub, `${at}/${key}/${name}`);
      }
    }
  };
  visit(jsonSchema, '#');
  return spots;
}

describe('every event schema in the registry', () => {
  it('declares no field named like plaintext content or a credential', () => {
    for (const entry of eventRegistry) {
      expect(riskyFieldNames(acceptedShape(entry.dataSchema)), entry.type).toEqual([]);
    }
  });

  it('is closed and fully constrained (no open object, z.unknown() or z.any() hiding in a schema)', () => {
    for (const entry of eventRegistry) {
      expect(looseSpots(acceptedShape(entry.dataSchema)), entry.type).toEqual([]);
    }
  });
});

// Each case adds one field to a real event type's schema and expects the guard
// to catch it. Most of these cases passed unnoticed under the first version of
// the guards, which matched exact lower-case names and only looked at a
// field's own schema.
describe('the registry-wide guards catch a bad field added to a real event type', () => {
  function withField(type: string, name: string, schema: z.ZodType): z.ZodType {
    const base = definitionFor(type).dataSchema;
    if (!(base instanceof z.ZodObject)) {
      throw new Error(`${type} is not a plain object schema`);
    }
    return base.extend({ [name]: schema });
  }
  const text = z.string().optional();

  it.each([
    'accessToken', 'refreshToken', 'access_token', 'TOKEN', 'apiToken', 'bearerToken', 'clientSecret',
    'secretValue', 'Password', 'passwd', 'credential', 'credentials', 'authorization', 'cookie', 'privateKey', 'headers',
  ])('connection.refreshed refuses a "%s" field by name', (name) => {
    expect(riskyFieldNames(acceptedShape(withField('connection.refreshed', name, text)))).toEqual([name]);
  });

  it.each(['plainText', 'replyText', 'messageText', 'body_text', 'note', 'markdown', 'html'])(
    'agent.message_completed refuses a "%s" field by name',
    (name) => {
      expect(riskyFieldNames(acceptedShape(withField('agent.message_completed', name, text)))).toEqual([name]);
    },
  );

  it('finds a risky name nested inside an object or a list', () => {
    const nested = z.object({ text: z.string() }).strict();
    expect(riskyFieldNames(acceptedShape(withField('memory.written', 'inner', nested)))).toEqual(['text']);
    expect(riskyFieldNames(acceptedShape(withField('memory.written', 'inner', z.array(nested))))).toEqual(['text']);
  });

  it.each([
    ...APPROVED_FIELD_NAMES,
    'commandDigest', 'argumentsDigest', 'previousSchemaDigest', 'targetScopeId', 'authorId', 'conversationId',
  ])('still allows the approved or harmless name "%s"', (name) => {
    expect(riskyFieldNames(acceptedShape(z.object({ [name]: z.string() }).strict()))).toEqual([]);
  });

  it.each<[shape: string, schema: z.ZodType]>([
    ['a record of unknown', z.record(z.string(), z.unknown())],
    ['an array of unknown', z.array(z.unknown())],
    ['z.json()', z.json()],
    ['a loose object', z.object({}).loose()],
    ['a record of strings', z.record(z.string(), z.string())],
    ['an object with a catchall', z.object({ id: z.string() }).catchall(z.string())],
    ['a tuple with unknown', z.tuple([z.string(), z.unknown()])],
    ['a tuple with an unknown rest', z.tuple([z.string()], z.unknown())],
    ['a union with unknown', z.union([z.string(), z.unknown()])],
    ['z.unknown()', z.unknown()],
    ['z.unknown().optional()', z.unknown().optional()],
    ['z.any()', z.any()],
    ['an object that is not .strict()', z.object({ id: z.string() })],
  ])('memory.written refuses to hold %s in a new field', (_shape, schema) => {
    expect(looseSpots(acceptedShape(withField('memory.written', 'extra', schema)))).not.toEqual([]);
  });

  it('accepts the real schema, so the cases above fail only because of the added field', () => {
    expect(looseSpots(acceptedShape(definitionFor('memory.written').dataSchema))).toEqual([]);
    expect(looseSpots(acceptedShape(withField('memory.written', 'extra', z.string().max(10))))).toEqual([]);
  });
});
