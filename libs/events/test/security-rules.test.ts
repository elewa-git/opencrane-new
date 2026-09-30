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
import { describe, expect, it } from 'vitest';
import { getEventDefinition } from '../src/registry.ts';

function schemaFor(type: string) {
  const definition = getEventDefinition(type);
  if (!definition) {
    throw new Error(`no such event type: ${type}`);
  }
  return definition.dataSchema;
}

describe('no plaintext conversation content', () => {
  it('agent.message_completed rejects plaintext text instead of ciphertext', () => {
    const schema = schemaFor('agent.message_completed');
    const result = schema.safeParse({
      conversationId: 'conv_1',
      turnId: 'turn_1',
      messageId: 'msg_1',
      text: 'this should have been encrypted',
      contentType: 'text',
    });
    expect(result.success).toBe(false);
  });

  it('agent.reasoning_summarised rejects a plain summary field', () => {
    const schema = schemaFor('agent.reasoning_summarised');
    const result = schema.safeParse({
      conversationId: 'conv_1',
      turnId: 'turn_1',
      summary: 'the reasoning, in plain text',
    });
    expect(result.success).toBe(false);
  });

  it('memory.written rejects plaintext content instead of ciphertext', () => {
    const schema = schemaFor('memory.written');
    const result = schema.safeParse({
      scopeId: 'scope_1',
      memoryId: 'memory_1',
      content: 'Alice prefers email over chat',
    });
    expect(result.success).toBe(false);
  });

  it('memory.corrected rejects plaintext content instead of ciphertext', () => {
    const schema = schemaFor('memory.corrected');
    const result = schema.safeParse({
      scopeId: 'scope_1',
      memoryId: 'memory_1',
      content: 'corrected plain text',
    });
    expect(result.success).toBe(false);
  });
});

describe('credentials and secrets only as a reference id', () => {
  it('connection.created rejects a raw OAuth token', () => {
    const schema = schemaFor('connection.created');
    const result = schema.safeParse({
      userId: 'mem_1',
      serverId: 'mcp_1',
      profile: 'default',
      token: 'ya29.raw-oauth-token-value',
    });
    expect(result.success).toBe(false);
  });

  it('connection.refreshed rejects a raw token even alongside a secretRef', () => {
    const schema = schemaFor('connection.refreshed');
    const result = schema.safeParse({
      userId: 'mem_1',
      serverId: 'mcp_1',
      profile: 'default',
      secretRef: 'secret_1',
      token: 'ya29.raw-oauth-token-value',
    });
    expect(result.success).toBe(false);
  });
});

describe('tool arguments only as a digest', () => {
  it('tool.approval_requested rejects the raw arguments object', () => {
    const schema = schemaFor('tool.approval_requested');
    const result = schema.safeParse({
      approvalId: 'appr_1',
      conversationId: 'conv_1',
      turnId: 'turn_1',
      tool: 'odoo.write',
      requesterId: 'mem_1',
      arguments: { recordId: 42, field: 'amount', value: 1000 },
    });
    expect(result.success).toBe(false);
  });

  it('tool.approval_requested rejects a digest that is not sha-256-shaped', () => {
    const schema = schemaFor('tool.approval_requested');
    const result = schema.safeParse({
      approvalId: 'appr_1',
      conversationId: 'conv_1',
      turnId: 'turn_1',
      tool: 'odoo.write',
      requesterId: 'mem_1',
      argumentsDigest: 'not-a-digest',
    });
    expect(result.success).toBe(false);
  });

  it('agent.command_ran rejects the raw command line', () => {
    const schema = schemaFor('agent.command_ran');
    const result = schema.safeParse({
      conversationId: 'conv_1',
      turnId: 'turn_1',
      command: 'curl -H "Authorization: Bearer sekret" https://example.com',
      exitCode: 0,
    });
    expect(result.success).toBe(false);
  });
});
