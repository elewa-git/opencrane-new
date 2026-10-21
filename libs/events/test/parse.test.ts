import { describe, expect, it } from 'vitest';
import { parseEventByType } from '../src/parse.ts';

// A base envelope with every required field except `type` and `data`,
// which each test fills in. Kept separate from envelope.test.ts's fixture
// because this file is about binding `type` to a real schema, not about
// the envelope shape itself.
function baseEnvelope(type: string, data: unknown): Record<string, unknown> {
  let subject = 'test-subject';
  if (type.startsWith('mcp.') && typeof data === 'object' && data !== null) {
    const serverId: unknown = Reflect.get(data, 'serverId');
    if (typeof serverId === 'string') {
      subject = `mcp-${serverId}`;
    }
  }
  return {
    id: 'evt_1',
    type,
    source: 'opencrane-server',
    time: '2026-09-30T10:00:00.000Z',
    subject,
    silo: 'acme',
    data,
  };
}

describe('parseEventByType', () => {
  it('rejects an event with no type field at all', () => {
    const result = parseEventByType({ data: {} });
    expect(result.success).toBe(false);
    if (!result.success && result.reason === 'unknown_event_type') {
      expect(result.type).toBeUndefined();
    } else {
      expect.fail('expected reason to be unknown_event_type');
    }
  });

  it('rejects a type the registry does not know', () => {
    const result = parseEventByType(baseEnvelope('no.such.event', {}));
    expect(result.success).toBe(false);
    if (!result.success && result.reason === 'unknown_event_type') {
      expect(result.type).toBe('no.such.event');
    } else {
      expect.fail('expected reason to be unknown_event_type');
    }
  });

  describe('member.joined', () => {
    it('accepts valid member data', () => {
      const result = parseEventByType(
        baseEnvelope('member.joined', {
          memberId: 'mem_1',
          email: 'alice@example.com',
          displayName: 'Alice',
          role: 'member',
        }),
      );
      expect(result.success).toBe(true);
    });

    it('rejects an invalid email', () => {
      const result = parseEventByType(
        baseEnvelope('member.joined', {
          memberId: 'mem_1',
          email: 'not-an-email',
          displayName: 'Alice',
          role: 'member',
        }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('invalid_event');
      }
    });
  });

  describe('message.posted', () => {
    const validMessageData = {
      conversationId: 'conv_1',
      authorId: 'alice',
      authorKind: 'human',
      ciphertext: 'YmFzZTY0LWxvb2tpbmctdGV4dA==',
      keyId: 'key:1',
      contentType: 'text',
    };

    it('accepts a message carrying encrypted ciphertext and its key id', () => {
      const result = parseEventByType(baseEnvelope('message.posted', validMessageData));
      expect(result.success).toBe(true);
    });

    // events.md rule 5: "no secrets and no plaintext history in events" —
    // message text must never travel as a plain `text` field, even next to
    // an otherwise valid ciphertext. Starting from the valid data and
    // adding only `text` means this can only fail for that one reason (see
    // security-rules.test.ts for the same check on every risky type).
    it('rejects plaintext text next to otherwise valid data', () => {
      const result = parseEventByType(
        baseEnvelope('message.posted', { ...validMessageData, text: 'this should have been encrypted' }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('invalid_event');
      }
    });
  });

  describe('approval.decided', () => {
    it('accepts a valid decision', () => {
      const result = parseEventByType(
        baseEnvelope('approval.decided', {
          approvalId: 'appr_1',
          decision: 'approved',
          decidedBy: 'alice',
        }),
      );
      expect(result.success).toBe(true);
    });

    it('rejects a decision value that is not approved or rejected', () => {
      const result = parseEventByType(
        baseEnvelope('approval.decided', {
          approvalId: 'appr_1',
          decision: 'maybe',
          decidedBy: 'alice',
        }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('invalid_event');
      }
    });
  });

  describe('effect.observed', () => {
    it('accepts a valid observed effect', () => {
      const result = parseEventByType(
        baseEnvelope('effect.observed', {
          permitId: 'permit_1',
          computerId: 'computer_1',
          tool: 'odoo.read',
          destination: 'odoo-mcp',
          costCents: 2,
          outcome: 'success',
        }),
      );
      expect(result.success).toBe(true);
    });

    it('rejects a negative cost', () => {
      const result = parseEventByType(
        baseEnvelope('effect.observed', {
          permitId: 'permit_1',
          computerId: 'computer_1',
          tool: 'odoo.read',
          destination: 'odoo-mcp',
          costCents: -1,
          outcome: 'success',
        }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('invalid_event');
      }
    });

    // Money is integer euro cents: a fractional value can't be a real
    // number of cents, and float euros are exactly the bug this avoids
    // (0.1 + 0.2 !== 0.3). This is the event the budget actor turns into
    // budget.settled, so it has to be the same integer shape.
    it('rejects a non-integer cost', () => {
      const result = parseEventByType(
        baseEnvelope('effect.observed', {
          permitId: 'permit_1',
          computerId: 'computer_1',
          tool: 'odoo.read',
          destination: 'odoo-mcp',
          costCents: 0.1 + 0.2,
          outcome: 'success',
        }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('invalid_event');
      }
    });
  });

  // Both kinds of MCP server go through parseEventByType (the field-by-field
  // cases are in security-rules.test.ts).
  describe('mcp.server_registered', () => {
    const register = (kind: string, locator: string) =>
      parseEventByType(baseEnvelope('mcp.server_registered', { serverId: 'mcp_1', kind, locator, registeredBy: 'mem_1' }));

    it('accepts a remote URL and a hosted image pinned by digest', () => {
      expect(register('remote', 'https://odoo.example.com/mcp').success).toBe(true);
      expect(register('hosted', `ghcr.io/elewa-git/odoo-mcp-server@sha256:${'ab'.repeat(32)}`).success).toBe(true);
    });

    it('accepts old events and optional catalogue and discovery metadata', () => {
      expect(register('remote', 'https://odoo.example.com/mcp').success).toBe(true);
      expect(parseEventByType(baseEnvelope('mcp.server_registered', { serverId: 'mcp_1', kind: 'remote',
        locator: 'https://odoo.example.com/mcp', registeredBy: 'mem_1', catalogueRef: 'catalogue:odoo' })).success).toBe(true);
      expect(parseEventByType(baseEnvelope('mcp.server_discovered', { serverId: 'mcp_1', toolCount: 3,
        schemaDigest: 'a'.repeat(64) })).success).toBe(true);
      expect(parseEventByType(baseEnvelope('mcp.server_discovered', { serverId: 'mcp_1', toolCount: 3,
        schemaDigest: 'a'.repeat(64), serverInfo: { name: 'Odoo', version: '1.4.2' } })).success).toBe(true);
    });

    it.each([
      ['hosted', 'ghcr.io/elewa-git/odoo-mcp-server:latest'],
      ['remote', 'https:admin:pass@odoo.example.com/mcp'],
      ['remote', 'https://odoo.example.com/mcp#access_token=abc'],
      ['remote', 'https://odoo.example.com/mcp?client_secret=abc'],
      ['remote', 'https://odoo.example.com/mcp?api%5Fkey=abc'],
      ['remote', 'file:///etc/passwd'],
    ])('rejects a %s locator of %j', (kind, locator) => {
      const result = register(kind, locator);
      expect(!result.success && result.reason).toBe('invalid_event');
    });
  });

  // Every event has a real, strict schema now (generated-examples.test.ts
  // covers all of them); this proves one that used to be a placeholder is
  // wired into parseEventByType end to end, and no longer takes any data.
  describe('org.created (was a placeholder schema)', () => {
    it('accepts its real data', () => {
      expect(parseEventByType(baseEnvelope('org.created', { orgName: 'Acme Ltd' })).success).toBe(true);
    });

    it('rejects arbitrary data', () => {
      const result = parseEventByType(baseEnvelope('org.created', { anything: 'goes' }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('invalid_event');
      }
    });
  });
});

it('keeps every report receipt ordered and confines batches to text deltas', () => {
  const receipt = { sequence: 1, digest: 'a'.repeat(64) };
  const report = { computerId: 'computer', sequence: 2, digest: 'b'.repeat(64),
    preceding: [receipt] };
  const event = { ...baseEnvelope('agent.message_delta', { conversationId: 'chat',
    turnId: 'turn', messageId: 'reply', contentType: 'text',
    ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:test' }), report };
  expect(parseEventByType(event).success).toBe(true);
  for (const preceding of [[receipt, receipt], [{ ...receipt, sequence: 2 }],
    Array.from({ length: 64 }, makeReceipt)]) {
    expect(parseEventByType({ ...event, report: { ...report, preceding } }).success).toBe(false);
  }
  const terminal = { ...baseEnvelope('agent.turn_completed',
    { conversationId: 'chat', turnId: 'turn' }), report };
  expect(parseEventByType(terminal).success).toBe(false);
  // Recheck invalid input after warming the validator with a valid event.
  expect(parseEventByType({ ...event, silo: '' }).success).toBe(false);
});

function makeReceipt(_value: unknown, index: number) {
  return { sequence: index + 1, digest: 'a'.repeat(64) };
}

const invalidEarlierReceipts = [
  { name: 'non-integer', preceding: [{ sequence: 1.5, digest: 'a'.repeat(64) }] },
  { name: 'bad digest', preceding: [{ sequence: 1, digest: 'invalid' }] },
  { name: 'extra field', preceding: [{ sequence: 1, digest: 'a'.repeat(64), extra: true }] },
  { name: 'empty array', preceding: [] },
  { name: '64 receipts', preceding: Array.from({ length: 64 }, makeReceipt) },
];
function rejectsInvalidEarlierReceipt(test: typeof invalidEarlierReceipts[number]) {
  const data = { conversationId: 'chat', turnId: 'turn', messageId: 'reply',
    contentType: 'text', ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:test' };
  const valid = { computerId: 'computer', sequence: 65, digest: 'b'.repeat(64),
    preceding: Array.from({ length: 63 }, makeReceipt) };
  const event = { ...baseEnvelope('agent.message_delta', data), report: valid };
  expect(parseEventByType(event).success).toBe(true);
  const report = { ...valid, preceding: test.preceding };
  expect(parseEventByType({ ...event, report }).success).toBe(false);
}
it.each(invalidEarlierReceipts)('refuses an earlier receipt with $name',
  rejectsInvalidEarlierReceipt);
