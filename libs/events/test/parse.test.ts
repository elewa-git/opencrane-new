import { describe, expect, it } from 'vitest';
import { parseEventByType } from '../src/parse.ts';

// A base envelope with every required field except `type`, `subject` and
// `data`, which each test fills in. Kept separate from envelope.test.ts's
// fixture because this file is about binding `type` to a real schema, not
// about the envelope shape itself. `subject` now has to match the event's
// own stream (see subject-binding.test.ts), so every caller below passes
// one that does, except where the test is deliberately about the type or
// data being wrong.
function baseEnvelope(type: string, data: unknown, subject: string): Record<string, unknown> {
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
    const result = parseEventByType(baseEnvelope('no.such.event', {}, 'test-subject'));
    expect(result.success).toBe(false);
    if (!result.success && result.reason === 'unknown_event_type') {
      expect(result.type).toBe('no.such.event');
    } else {
      expect.fail('expected reason to be unknown_event_type');
    }
  });

  describe('member.joined', () => {
    it('accepts valid member data on its own subject', () => {
      const result = parseEventByType(
        baseEnvelope(
          'member.joined',
          { memberId: 'mem_1', email: 'alice@example.com', displayName: 'Alice', role: 'member' },
          'member-mem_1',
        ),
      );
      expect(result.success).toBe(true);
    });

    it('rejects an invalid email', () => {
      const result = parseEventByType(
        baseEnvelope(
          'member.joined',
          { memberId: 'mem_1', email: 'not-an-email', displayName: 'Alice', role: 'member' },
          'member-mem_1',
        ),
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
        baseEnvelope(
          'message.posted',
          {
            conversationId: 'conv_1',
            authorId: 'alice',
            authorKind: 'human',
            ciphertext: 'YmFzZTY0LWxvb2tpbmctdGV4dA==',
            contentType: 'text',
          },
          'conversation-conv_1',
        ),
      );
      expect(result.success).toBe(true);
    });

    // events.md rule 5: "no secrets and no plaintext history in events" —
    // message text must never travel as a plain `text` field.
    it('rejects plaintext text instead of ciphertext', () => {
      const result = parseEventByType(
        baseEnvelope(
          'message.posted',
          {
            conversationId: 'conv_1',
            authorId: 'alice',
            authorKind: 'human',
            text: 'this should have been encrypted',
            contentType: 'text',
          },
          'conversation-conv_1',
        ),
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
        baseEnvelope(
          'approval.decided',
          { approvalId: 'appr_1', decision: 'approved', decidedBy: 'alice' },
          'approval-appr_1',
        ),
      );
      expect(result.success).toBe(true);
    });

    it('rejects a decision value that is not approved or rejected', () => {
      const result = parseEventByType(
        baseEnvelope(
          'approval.decided',
          { approvalId: 'appr_1', decision: 'maybe', decidedBy: 'alice' },
          'approval-appr_1',
        ),
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
        baseEnvelope(
          'effect.observed',
          { permitId: 'permit_1', computerId: 'computer_1', tool: 'odoo.read', destination: 'odoo-mcp', costEur: 0.02, outcome: 'success' },
          'effect-permit_1',
        ),
      );
      expect(result.success).toBe(true);
    });

    it('rejects a negative cost', () => {
      const result = parseEventByType(
        baseEnvelope(
          'effect.observed',
          { permitId: 'permit_1', computerId: 'computer_1', tool: 'odoo.read', destination: 'odoo-mcp', costEur: -1, outcome: 'success' },
          'effect-permit_1',
        ),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('invalid_event');
      }
    });
  });

  // Every event now has a real, strict schema (generated-examples.test.ts
  // covers the strictness for all 69); this just proves org.created's own
  // schema is wired into parseEventByType end to end, on its silo-keyed
  // subject (it has no data field of its own to key on).
  it('accepts a real org.created event on its silo-keyed subject', () => {
    const result = parseEventByType(baseEnvelope('org.created', { orgName: 'Acme Ltd' }, 'org-acme'));
    expect(result.success).toBe(true);
  });
});
