import { describe, expect, it } from 'vitest';
import { parseEventByType } from '../src/parse.ts';

// A base envelope with every required field except `type` and `data`,
// which each test fills in. Kept separate from envelope.test.ts's fixture
// because this file is about binding `type` to a real schema, not about
// the envelope shape itself.
function baseEnvelope(type: string, data: unknown): Record<string, unknown> {
  return {
    id: 'evt_1',
    type,
    source: 'opencrane-server',
    time: '2026-09-30T10:00:00.000Z',
    subject: 'test-subject',
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
    it('accepts a message carrying encrypted ciphertext', () => {
      const result = parseEventByType(
        baseEnvelope('message.posted', {
          conversationId: 'conv_1',
          authorId: 'alice',
          authorKind: 'human',
          ciphertext: 'YmFzZTY0LWxvb2tpbmctdGV4dA==',
          contentType: 'text',
        }),
      );
      expect(result.success).toBe(true);
    });

    // events.md rule 5: "no secrets and no plaintext history in events" —
    // message text must never travel as a plain `text` field.
    it('rejects plaintext text instead of ciphertext', () => {
      const result = parseEventByType(
        baseEnvelope('message.posted', {
          conversationId: 'conv_1',
          authorId: 'alice',
          authorKind: 'human',
          text: 'this should have been encrypted',
          contentType: 'text',
        }),
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
          costEur: 0.02,
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
          costEur: -1,
          outcome: 'success',
        }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('invalid_event');
      }
    });
  });

  it('accepts a placeholder-schema event with any data', () => {
    const result = parseEventByType(baseEnvelope('org.created', { anything: 'goes' }));
    expect(result.success).toBe(true);
  });
});
