// Security rules from docs/architecture/events.md rule 5 and plan.md,
// checked as schema rules on the risky event types the task calls out.
// generated-examples.test.ts already proves every schema accepts its own
// valid example, so this file only has to prove the *rejections* these
// three rules require:
// - no plaintext conversation content in any event (message and agent
//   text travel as `ciphertext` + `keyId`, never as `text` or `content`);
// - credentials and secrets only as a secret reference id, never a raw
//   token, password or key value;
// - tool arguments only as a digest, never the raw arguments.
//
// Each test below starts from that event type's own valid registry
// example (already accepted by its schema — generated-examples.test.ts
// proves that) and adds only the one forbidden field. That matters: a
// test built from an incomplete object (missing, say, `ciphertext`) would
// still fail if the forbidden field were wrongly allowed, just for the
// wrong reason — a missing required field, not the forbidden one — so it
// would keep "passing" even after the vulnerability it claims to test for
// was reintroduced. Starting from a complete, valid example and adding
// only the forbidden field means the test can fail for exactly one
// reason: that field being accepted.
import { describe, expect, it } from 'vitest';
import { getEventDefinition } from '../src/registry.ts';

function exampleFor(type: string): Record<string, unknown> {
  const definition = getEventDefinition(type);
  if (!definition) {
    throw new Error(`no such event type: ${type}`);
  }
  return definition.example as Record<string, unknown>;
}

function schemaFor(type: string) {
  const definition = getEventDefinition(type);
  if (!definition) {
    throw new Error(`no such event type: ${type}`);
  }
  return definition.dataSchema;
}

describe('no plaintext conversation content', () => {
  it('agent.message_completed rejects a plaintext text field alongside its valid ciphertext', () => {
    const schema = schemaFor('agent.message_completed');
    const result = schema.safeParse({ ...exampleFor('agent.message_completed'), text: 'this should have been encrypted' });
    expect(result.success).toBe(false);
  });

  it('agent.reasoning_summarised rejects a plain summary field alongside its valid ciphertext', () => {
    const schema = schemaFor('agent.reasoning_summarised');
    const result = schema.safeParse({
      ...exampleFor('agent.reasoning_summarised'),
      summary: 'the reasoning, in plain text',
    });
    expect(result.success).toBe(false);
  });

  it('memory.written rejects a plaintext content field alongside its valid ciphertext', () => {
    const schema = schemaFor('memory.written');
    const result = schema.safeParse({ ...exampleFor('memory.written'), content: 'Alice prefers email over chat' });
    expect(result.success).toBe(false);
  });

  it('memory.corrected rejects a plaintext content field alongside its valid ciphertext', () => {
    const schema = schemaFor('memory.corrected');
    const result = schema.safeParse({ ...exampleFor('memory.corrected'), content: 'corrected plain text' });
    expect(result.success).toBe(false);
  });

  it('message.posted rejects a plaintext text field alongside its valid ciphertext', () => {
    const schema = schemaFor('message.posted');
    const result = schema.safeParse({ ...exampleFor('message.posted'), text: 'this should have been encrypted' });
    expect(result.success).toBe(false);
  });

  it("ciphertext itself rejects a plaintext sentence (the field name alone isn't the rule)", () => {
    const schema = schemaFor('agent.message_completed');
    const result = schema.safeParse({
      ...exampleFor('agent.message_completed'),
      ciphertext: 'Please wire EUR 10,000 to IBAN NL91ABNA0417164300 today',
    });
    expect(result.success).toBe(false);
  });

  it('ciphertext rejects a short, letters-only word (the base64 charset alone is not enough)', () => {
    const schema = schemaFor('memory.written');
    const result = schema.safeParse({ ...exampleFor('memory.written'), ciphertext: 'hi' });
    expect(result.success).toBe(false);
  });

  it('keyId rejects a bare id with no "key:" reference prefix', () => {
    const schema = schemaFor('memory.written');
    const result = schema.safeParse({ ...exampleFor('memory.written'), keyId: 'key_1' });
    expect(result.success).toBe(false);
  });
});

describe('credentials and secrets only as a reference id', () => {
  it('connection.created rejects a raw OAuth token alongside its valid secretRef', () => {
    const schema = schemaFor('connection.created');
    const result = schema.safeParse({ ...exampleFor('connection.created'), token: 'ya29.raw-oauth-token-value' });
    expect(result.success).toBe(false);
  });

  it('connection.refreshed rejects a raw token alongside its valid secretRef', () => {
    const schema = schemaFor('connection.refreshed');
    const result = schema.safeParse({ ...exampleFor('connection.refreshed'), token: 'ya29.raw-oauth-token-value' });
    expect(result.success).toBe(false);
  });

  it("secretRef itself rejects a raw token (the field name alone isn't the rule)", () => {
    const schema = schemaFor('connection.created');
    const result = schema.safeParse({
      ...exampleFor('connection.created'),
      secretRef: 'ya29.a0AfH6SMBx-real-google-oauth-access-token',
    });
    expect(result.success).toBe(false);
  });

  it('secretRef rejects a raw password value', () => {
    const schema = schemaFor('connection.refreshed');
    const result = schema.safeParse({ ...exampleFor('connection.refreshed'), secretRef: 'hunter2-my-odoo-password' });
    expect(result.success).toBe(false);
  });
});

describe('an MCP server locator never carries a credential', () => {
  it('mcp.server_registered rejects a locator with "user:password@" in it', () => {
    const schema = schemaFor('mcp.server_registered');
    const result = schema.safeParse({
      ...exampleFor('mcp.server_registered'),
      locator: 'https://admin:SuperSecretPass@odoo.example.com/mcp',
    });
    expect(result.success).toBe(false);
  });

  it('mcp.server_registered rejects a locator with a secret-looking query parameter', () => {
    const schema = schemaFor('mcp.server_registered');
    const result = schema.safeParse({
      ...exampleFor('mcp.server_registered'),
      locator: 'https://odoo.example.com/mcp?api_key=sk_live_abc',
    });
    expect(result.success).toBe(false);
  });
});

describe('tool arguments only as a digest', () => {
  it('tool.approval_requested rejects the raw arguments object alongside its valid digest', () => {
    const schema = schemaFor('tool.approval_requested');
    const result = schema.safeParse({
      ...exampleFor('tool.approval_requested'),
      arguments: { recordId: 42, field: 'amount', value: 1000 },
    });
    expect(result.success).toBe(false);
  });

  it('tool.approval_requested rejects a digest that is not sha-256-shaped', () => {
    const schema = schemaFor('tool.approval_requested');
    const result = schema.safeParse({ ...exampleFor('tool.approval_requested'), argumentsDigest: 'not-a-digest' });
    expect(result.success).toBe(false);
  });

  it('agent.command_ran rejects a raw command line alongside its valid digest', () => {
    const schema = schemaFor('agent.command_ran');
    const result = schema.safeParse({
      ...exampleFor('agent.command_ran'),
      command: 'curl -H "Authorization: Bearer sekret" https://example.com',
    });
    expect(result.success).toBe(false);
  });
});
