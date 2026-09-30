// A hand-written table of the subject every event type must carry,
// independent of subject.ts's own `expectedSubject` function. This is the
// direct answer to "the generated test in subject-binding.test.ts computes
// its expected subject with the same function parseEventByType uses to
// check it, so a bug in that function (or in a registry entry's own
// `stream`/`subjectFields`) can't be caught by it": every string below was
// written out by hand from the Streams table in docs/architecture/
// events.md plus each event's own registry example, not computed by
// calling any code under test.
//
// If a registry entry's `stream` or `subjectFields` is wrong — the wrong
// field, the wrong stream, a field from the wrong entity — the subject
// parseEventByType computes will stop matching the literal string below,
// and the matching "accepts" test here will fail.
import { describe, expect, it } from 'vitest';
import { parseEventByType } from '../src/parse.ts';
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

// Hand-written: <event type> -> <the subject it must carry>. Built from
// the Streams table (`<stream>-<id>`, or `<stream>-<silo>` for the three
// silo-wide streams) and each event's own registry example.
const EXPECTED_SUBJECT: Readonly<Record<string, string>> = {
  'org.created': 'org-acme',

  'member.invited': 'member-mem_2',
  'member.joined': 'member-mem_1',
  'member.role_changed': 'member-mem_1',
  'member.removed': 'member-mem_1',

  'team.created': 'team-team_1',
  'team.member_added': 'team-team_1',
  'team.member_removed': 'team-team_1',

  'assistant.created': 'assistant-asst_1',
  'assistant.settings_changed': 'assistant-asst_1',

  'computer.claimed': 'computer-asst_1',
  'computer.ready': 'computer-asst_1',
  'computer.suspended': 'computer-asst_1',
  'computer.resumed': 'computer-asst_1',
  'computer.lost': 'computer-asst_1',
  'computer.retired': 'computer-asst_1',
  'takeover.started': 'computer-asst_1',
  'takeover.ended': 'computer-asst_1',

  'conversation.created': 'conversation-conv_1',
  'participant.added': 'conversation-conv_1',
  'participant.removed': 'conversation-conv_1',
  'message.posted': 'conversation-conv_1',
  'agent.turn_started': 'conversation-conv_1',
  'agent.turn_completed': 'conversation-conv_1',
  'agent.turn_failed': 'conversation-conv_1',
  'agent.message_completed': 'conversation-conv_1',
  'agent.reasoning_summarised': 'conversation-conv_1',
  'agent.command_ran': 'conversation-conv_1',
  'agent.file_changed': 'conversation-conv_1',
  'conversation.closed': 'conversation-conv_1',

  'tool.approval_requested': 'approval-appr_1',
  'approval.decided': 'approval-appr_1',
  'approval.expired': 'approval-appr_1',
  'approval.used': 'approval-appr_1',

  'effect.observed': 'effect-permit_1',
  'effect.uncertain': 'effect-permit_1',
  'effect.resolved': 'effect-permit_1',

  'mcp.server_registered': 'mcp-mcp_1',
  'mcp.server_discovered': 'mcp-mcp_1',
  'mcp.server_rejected': 'mcp-mcp_1',
  'mcp.tool_mode_set': 'mcp-mcp_1',
  'mcp.server_published': 'mcp-mcp_1',
  'mcp.server_unpublished': 'mcp-mcp_1',
  'mcp.tool_list_changed': 'mcp-mcp_1',

  'grant.given': 'grant-mcp_1',
  'grant.revoked': 'grant-mcp_1',

  'connection.created': 'connection-mem_1-mcp_1-default',
  'connection.refreshed': 'connection-mem_1-mcp_1-default',
  'connection.revoked': 'connection-mem_1-mcp_1-default',

  'budget.ceiling_set': 'budget-acme',
  'budget.reserved': 'budget-acme',
  'budget.settled': 'budget-acme',
  'budget.period_started': 'budget-acme',
  'budget.exhausted': 'budget-acme',

  'memory.written': 'scope-scope_1',
  'memory.corrected': 'scope-scope_1',
  'memory.forgotten': 'scope-scope_1',
  'memory.consolidated': 'scope-scope_1',
  'scope.promotion_requested': 'scope-scope_1',
  'scope.promoted': 'scope-scope_1',

  'routine.created': 'routine-routine_1',
  'routine.updated': 'routine-routine_1',
  'routine.paused': 'routine-routine_1',
  'routine.resumed': 'routine-routine_1',
  'routine.retired': 'routine-routine_1',
  'routine.due': 'routine-routine_1',

  'delegation.started': 'delegation-deleg_1',
  'delegation.completed': 'delegation-deleg_1',

  'security.alert_raised': 'security-acme',
};

describe('hand-written subject table (not computed by expectedSubject)', () => {
  it('covers every event type in the registry, both ways', () => {
    const registryTypes = new Set(eventRegistry.map((entry) => entry.type));
    const tableTypes = new Set(Object.keys(EXPECTED_SUBJECT));
    expect(tableTypes).toEqual(registryTypes);
  });

  for (const entry of eventRegistry) {
    const subject = EXPECTED_SUBJECT[entry.type];

    it(`${entry.type}: accepts its own hand-written subject "${String(subject)}"`, () => {
      if (subject === undefined) {
        expect.fail(`no hand-written subject for ${entry.type} — add one to EXPECTED_SUBJECT above`);
        return;
      }
      const result = parseEventByType(envelope(entry.type, subject, entry.example));
      expect(result.success).toBe(true);
    });

    it(`${entry.type}: rejects a subject one character off the hand-written one`, () => {
      if (subject === undefined) {
        return;
      }
      const result = parseEventByType(envelope(entry.type, `${subject}x`, entry.example));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('subject_mismatch');
      }
    });
  }
});

describe('the connection composite subject cannot collide across a "-" boundary', () => {
  // Same reasoning as the hand-written table above, but for the one
  // composite stream: two different (userId, serverId, profile) triples
  // must never build the same subject string. Since every id used in a
  // subject is restricted to [A-Za-z0-9_] (see subject.ts), none of them
  // can contain the "-" the three parts are joined with, so the join can
  // never be ambiguous — this is what proves that, not just states it.
  it('serverId "x-odoo" is rejected outright (ids may not contain "-")', () => {
    const definition = eventRegistry.find((entry) => entry.type === 'connection.created');
    if (!definition) {
      expect.fail('connection.created missing from the registry');
      return;
    }
    const data = { userId: 'alice', serverId: 'x-odoo', profile: 'default', secretRef: 'secret:1' };
    expect(definition.dataSchema.safeParse(data).success).toBe(false);
  });

  it('two different id triples that would collide under a naive join build different subjects', () => {
    // (userId "alice-x", serverId "odoo") vs (userId "alice", serverId
    // "x-odoo") would both join to "connection-alice-x-odoo-default" if
    // ids could contain "-". Both are rejected by the schema itself before
    // a subject is ever computed, so there is no id pair left that could
    // collide — the schema is where this is actually prevented.
    const definition = eventRegistry.find((entry) => entry.type === 'connection.created');
    if (!definition) {
      expect.fail('connection.created missing from the registry');
      return;
    }
    const first = { userId: 'alice-x', serverId: 'odoo', profile: 'default', secretRef: 'secret:1' };
    const second = { userId: 'alice', serverId: 'x-odoo', profile: 'default', secretRef: 'secret:1' };
    expect(definition.dataSchema.safeParse(first).success).toBe(false);
    expect(definition.dataSchema.safeParse(second).success).toBe(false);
  });
});
