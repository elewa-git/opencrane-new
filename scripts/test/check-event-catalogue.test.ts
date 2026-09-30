// Unit tests for the parsing helpers in check-event-catalogue.mjs, using
// small made-up markdown fixtures rather than the real events.md, so a
// future edit to the real catalogue can't accidentally make these tests
// meaningless.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseCatalogueEventTypes, parseStreamTypes, wrongStreamAssignments } from '../check-event-catalogue.mjs';
import type { EventDefinition } from '../../libs/events/src/registry.ts';

// A minimal made-up registry entry, not one of the real 69 — this file
// checks wrongStreamAssignments's own rule (prefix must equal stream,
// except the listed exceptions), not any specific event.
function fakeEntry(type: string, stream: string): EventDefinition {
  const schema = z.object({}).strict();
  return { type, stream, description: 'test fixture', dataSchema: schema, subjectFields: 'silo', example: {} };
}

describe('parseStreamTypes', () => {
  it('reads the stream-type word out of each Streams table row', () => {
    const markdown = [
      '## Streams',
      '',
      '| Stream | One per | Examples |',
      '|---|---|---|',
      '| `org-<silo>` | silo | settings |',
      '| `connection-<user>-<server>-<profile>` | credential connection | created |',
      '',
      '## Catalogue',
      'nothing relevant here',
    ].join('\n');

    expect(parseStreamTypes(markdown)).toEqual(new Set(['org', 'connection']));
  });

  it('throws when there is no Streams heading', () => {
    expect(() => parseStreamTypes('## Catalogue\nno streams table here')).toThrow(/Streams/);
  });
});

describe('parseCatalogueEventTypes', () => {
  it('collects event names from any cell, and flags a malformed one instead of dropping it', () => {
    const markdown = [
      '## Catalogue',
      '',
      '### A section',
      '| Event | Emitted by | Projections | Reactions |',
      '|---|---|---|---|',
      '| `member.joined` | invitation | members | emit `assistant.created` |',
      // A three-part name a real event catalogue could plausibly contain
      // by mistake (see plan.md's `tool.list.changed` vs the registry's
      // `mcp.tool_list_changed`): it should be flagged, not silently lost.
      '| `tool.list.changed` | drift check | catalogue | — |',
      '| `ext_authz` | — | — | — |',
      '',
      '## Streams',
      'not part of the Catalogue section',
    ].join('\n');

    const { eventTypes, malformedNames } = parseCatalogueEventTypes(markdown);
    expect(eventTypes).toEqual(new Set(['member.joined', 'assistant.created']));
    expect(malformedNames).toEqual(new Set(['tool.list.changed']));
  });

  it('does not flag a token with no dot, even if it looks unusual', () => {
    const markdown = ['## Catalogue', '| Event | X |', '|---|---|', '| `ext_authz` | `Nats-Msg-Id` |'].join('\n');
    const { malformedNames } = parseCatalogueEventTypes(markdown);
    expect(malformedNames.size).toBe(0);
  });

  it('throws when there is no Catalogue heading', () => {
    expect(() => parseCatalogueEventTypes('# Nothing here')).toThrow(/Catalogue/);
  });
});

describe('wrongStreamAssignments', () => {
  it('accepts an event whose prefix equals its stream', () => {
    expect(wrongStreamAssignments([fakeEntry('widget.created', 'widget')])).toEqual([]);
  });

  it('flags an event on a stream that is neither its own prefix nor a known exception', () => {
    // The exact shape of the bug a reviewer found on this branch:
    // approval.used moved onto the "effect" stream. "effect" is a real
    // stream (parseStreamTypes would accept it), so only a check that
    // knows this event's *own* right stream can catch this.
    const problems = wrongStreamAssignments([fakeEntry('approval.used', 'effect')]);
    expect(problems).toEqual(['approval.used is on stream "effect", but should be on stream "approval"']);
  });

  it('flags an event moved onto an unrelated but real-looking stream', () => {
    // memory.written moved onto "budget" — the other failing scenario a
    // reviewer gave: memory.* belongs to the scope stream (an explicit
    // exception), not to its own "memory" prefix and not to "budget".
    const problems = wrongStreamAssignments([fakeEntry('memory.written', 'budget')]);
    expect(problems).toEqual(['memory.written is on stream "budget", but should be on stream "scope"']);
  });

  it('accepts every explicit exception on its documented stream', () => {
    const exceptions: [string, string][] = [
      ['participant.added', 'conversation'],
      ['message.posted', 'conversation'],
      ['agent.turn_started', 'conversation'],
      ['takeover.started', 'computer'],
      ['tool.approval_requested', 'approval'],
      ['memory.written', 'scope'],
    ];
    const problems = wrongStreamAssignments(exceptions.map(([type, stream]) => fakeEntry(type, stream)));
    expect(problems).toEqual([]);
  });

  it('finds every mismatch when several entries are wrong at once', () => {
    const problems = wrongStreamAssignments([
      fakeEntry('widget.created', 'widget'), // correct, should not be reported
      fakeEntry('approval.used', 'effect'), // wrong
      fakeEntry('team.member_added', 'member'), // wrong (should stay on "team")
    ]);
    expect(problems).toEqual([
      'approval.used is on stream "effect", but should be on stream "approval"',
      'team.member_added is on stream "member", but should be on stream "team"',
    ]);
  });
});
