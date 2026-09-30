// Unit tests for the parsing helpers in check-event-catalogue.mjs, using
// small made-up markdown fixtures rather than the real events.md, so a
// future edit to the real catalogue can't accidentally make these tests
// meaningless.
import { describe, expect, it } from 'vitest';
import { parseCatalogueEventTypes, parseStreamTypes } from '../check-event-catalogue.mjs';

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
