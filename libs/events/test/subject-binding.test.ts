// Stream binding: an event's envelope `subject` must match the stream its
// type belongs to (docs/architecture/events.md, the "Streams" table),
// e.g. `member.joined` must carry `subject: "member-<memberId>"`. This
// file has the specific example the task called out (member.joined),
// then a generated accept/reject pair for every event type in the
// registry, so every stream's binding rule is actually exercised, not
// only documented.
import { describe, expect, it } from 'vitest';
import { parseEventByType } from '../src/parse.ts';
import { expectedSubject } from '../src/subject.ts';
import { eventRegistry } from '../src/registry.ts';

function envelope(type: string, subject: string, data: unknown): Record<string, unknown> {
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

describe('member.joined (the task\'s own example: subject must be member-<id>)', () => {
  const data = { memberId: 'mem_1', email: 'alice@example.com', displayName: 'Alice', role: 'member' as const };

  it('accepts subject "member-mem_1", matching its own memberId', () => {
    const result = parseEventByType(envelope('member.joined', 'member-mem_1', data));
    expect(result.success).toBe(true);
  });

  it('rejects a subject that names a different member', () => {
    const result = parseEventByType(envelope('member.joined', 'member-someone-else', data));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('subject_mismatch');
      if (result.reason === 'subject_mismatch') {
        expect(result.expected).toBe('member-mem_1');
        expect(result.actual).toBe('member-someone-else');
      }
    }
  });

  it('rejects a subject from a completely different stream', () => {
    const result = parseEventByType(envelope('member.joined', 'team-team_1', data));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('subject_mismatch');
    }
  });
});

describe('connection.* (the one composite subject: connection-<user>-<server>-<profile>)', () => {
  it('accepts the three-part subject built from userId, serverId and profile', () => {
    const data = { userId: 'mem_1', serverId: 'mcp_1', profile: 'default', secretRef: 'secret:1' };
    const result = parseEventByType(envelope('connection.created', 'connection-mem_1-mcp_1-default', data));
    expect(result.success).toBe(true);
  });

  it('rejects a subject missing one of the three parts', () => {
    const data = { userId: 'mem_1', serverId: 'mcp_1', profile: 'default', secretRef: 'secret:1' };
    const result = parseEventByType(envelope('connection.created', 'connection-mem_1-mcp_1', data));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('subject_mismatch');
    }
  });
});

describe('every event type, generated from the registry', () => {
  for (const entry of eventRegistry) {
    describe(entry.type, () => {
      it('accepts the subject the Streams table says this stream should have', () => {
        const subject = expectedSubject(entry, entry.example, 'acme');
        const result = parseEventByType(envelope(entry.type, subject, entry.example));
        expect(result.success).toBe(true);
      });

      it('rejects an unrelated subject', () => {
        const correctSubject = expectedSubject(entry, entry.example, 'acme');
        const wrongSubject = `${correctSubject}-definitely-not-it`;
        const result = parseEventByType(envelope(entry.type, wrongSubject, entry.example));
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.reason).toBe('subject_mismatch');
        }
      });
    });
  }
});
