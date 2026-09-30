#!/usr/bin/env node
// Checks that the event registry (libs/events/src/registry.ts) and the
// event catalogue (docs/architecture/events.md) agree, in four ways:
// - they name exactly the same event types, in both directions;
// - every event's `stream` in the registry is one of the stream-type
//   prefixes the catalogue's own "Streams" table lists (e.g. "member" for
//   `member-<user>`), and every prefix the table lists is used by at
//   least one event;
// - that stream is the *right* one for the event, not just some real one:
//   an event type's own prefix (the word before the first dot) has to be
//   its stream's name too, except for the handful of types the Streams
//   table's "Examples" column says belong to a different stream (see
//   EVENT_PREFIX_STREAM_EXCEPTIONS below) — this is what catches, say,
//   `approval.used` moved onto the `effect` stream, which the check above
//   alone would wave through because `effect` is still a real stream;
// - a backticked name in the "## Catalogue" section that looks like it
//   was meant to be an event, but doesn't match the strict event-name
//   shape (three dotted parts, a hyphen, camelCase), is flagged instead
//   of silently dropped, so a typo doesn't just vanish from the check.
// If the registry and the catalogue disagree, the catalogue is no longer
// the contract it claims to be, so this fails the build; a malformed name
// is only a warning, since it may just be an unrelated technical term.
//
// Run with: npm run check:events (wired into CI too).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventRegistry } from '../libs/events/src/registry.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const cataloguePath = path.join(repoRoot, 'docs/architecture/events.md');

// An event type is always written `<stream-word>.<past-tense-words>`, all
// lower case, e.g. `member.joined` or `mcp.tool_list_changed`. Other things
// the catalogue writes in backticks — an OpenFGA relation like `member` or
// `acts_for`, or `ext_authz` — never contain a dot, so this pattern is
// enough to tell an event name apart from everything else in backticks.
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

// A backticked token that contains a dot and otherwise looks like a plain
// identifier (letters, digits, dots, underscores, hyphens — no angle
// brackets, slashes or spaces). Anything matching this but failing
// EVENT_TYPE_PATTERN is a candidate: maybe a three-part name
// (`tool.list.changed`), a hyphenated one, or camelCase, and maybe
// something unrelated (a stray version number). It's cheap to check by
// eye, so this reports it rather than silently leaving it out of the
// comparison the way the old, narrower regex did.
const MALFORMED_CANDIDATE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

// Which stream an event type's own prefix (the word before the first dot,
// e.g. "member" in "member.joined") belongs to, for the handful of event
// types whose prefix is not the stream's name. Taken directly from the
// Streams table's own "Examples" column in events.md:
// - `conversation-<id>` | ... | "participants, messages, agent activity"
//   -> participant.*, message.posted and agent.* all belong to the
//   conversation stream, not their own prefix.
// - `computer-<assistant>` | ... | "... takeover" -> takeover.* belongs to
//   the computer stream.
// - `approval-<id>` | ... | "requested, decided, used, expired" ->
//   "requested" is tool.approval_requested, not approval.requested (there
//   is no such event), so tool.* belongs to the approval stream.
// - `scope-<id>` | ... | "memory written, corrected, forgotten,
//   consolidated, promoted" -> memory.* belongs to the scope stream.
// Every other event type's prefix is its stream's name directly (checked
// below without needing an entry here).
const EVENT_PREFIX_STREAM_EXCEPTIONS = {
  participant: 'conversation',
  message: 'conversation',
  agent: 'conversation',
  takeover: 'computer',
  tool: 'approval',
  memory: 'scope',
};

/**
 * Checks every registry entry's own `stream` against the event type's
 * prefix, using the catalogue's Streams table "Examples" column to decide
 * which prefixes are exceptions (see EVENT_PREFIX_STREAM_EXCEPTIONS). This
 * is a different, and stricter, check than "the stream is one of the
 * table's known prefixes": it catches an event moved onto some *other*
 * real stream, which parseStreamTypes alone can't, because that stream is
 * still a perfectly valid prefix — just not this event's.
 *
 * @param {import('../libs/events/src/registry.ts').EventDefinition[]} registry
 * @returns {string[]} one message per event whose stream doesn't match its prefix
 */
export function wrongStreamAssignments(registry) {
  const problems = [];
  for (const entry of registry) {
    const prefix = entry.type.split('.')[0] ?? entry.type;
    const expectedStream = EVENT_PREFIX_STREAM_EXCEPTIONS[prefix] ?? prefix;
    if (entry.stream !== expectedStream) {
      problems.push(`${entry.type} is on stream "${entry.stream}", but should be on stream "${expectedStream}"`);
    }
  }
  return problems.sort();
}

/**
 * Extracts the stream-type word from one row of the "Streams" table, e.g.
 * "org" from `` `org-<silo>` `` or "connection" from
 * `` `connection-<user>-<server>-<profile>` ``.
 *
 * @param {string} markdown
 * @returns {Set<string>}
 */
export function parseStreamTypes(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## Streams');
  if (start === -1) {
    throw new Error('could not find a "## Streams" heading in events.md');
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }

  const streamTypes = new Set();
  for (const line of lines.slice(start + 1, end)) {
    const match = /^\|\s*`([a-z][a-z0-9_]*)-<[^`]+>`\s*\|/.exec(line.trim());
    if (match) {
      streamTypes.add(match[1]);
    }
  }
  return streamTypes;
}

/**
 * Pulls every backticked event name out of the "## Catalogue" section's
 * tables — from *any* cell, not only the first column. An event is
 * sometimes only named in a Reactions cell (for example "→ `mcp.server_
 * rejected`"), and that still counts: if it isn't caught here, the
 * catalogue can drift from the registry without this check ever noticing.
 *
 * Also collects, separately, any backticked token in the same tables that
 * looks like it was meant to be an event name but doesn't match the
 * strict shape (see MALFORMED_CANDIDATE_PATTERN above).
 *
 * @param {string} markdown
 * @returns {{ eventTypes: Set<string>, malformedNames: Set<string> }}
 */
export function parseCatalogueEventTypes(markdown) {
  const lines = markdown.split('\n');

  // Narrow to the "## Catalogue" section: from its heading to the next
  // top-level ("## ") heading, or the end of the file.
  const start = lines.findIndex((line) => line.trim() === '## Catalogue');
  if (start === -1) {
    throw new Error('could not find a "## Catalogue" heading in events.md');
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start + 1, end);

  const eventTypes = new Set();
  const malformedNames = new Set();

  for (const line of section) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      // Not a table row (a heading, a blank line, prose).
      continue;
    }

    const cells = trimmed
      .slice(1, trimmed.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((cell) => cell.trim());
    const firstCell = cells[0] ?? '';

    // Skip the header row ("| Event | Emitted by | ... |") and the header
    // separator row ("|---|---|---|---|"). Every other row in this section
    // belongs to one of the catalogue's event tables.
    if (firstCell === 'Event' || /^:?-+:?$/.test(firstCell)) {
      continue;
    }

    for (const cell of cells) {
      for (const match of cell.matchAll(/`([^`]+)`/g)) {
        const token = match[1];
        if (EVENT_TYPE_PATTERN.test(token)) {
          eventTypes.add(token);
        } else if (token.includes('.') && MALFORMED_CANDIDATE_PATTERN.test(token)) {
          // Looks like an identifier and contains a dot, but not in the
          // `word.word` shape every real event name uses: a three-part
          // name, a hyphen, or camelCase. Flag it rather than dropping it.
          malformedNames.add(token);
        }
      }
    }
  }

  return { eventTypes, malformedNames };
}

async function main() {
  const markdown = await readFile(cataloguePath, 'utf8');
  const { eventTypes: catalogueTypes, malformedNames } = parseCatalogueEventTypes(markdown);
  const streamTypes = parseStreamTypes(markdown);
  const registryTypes = new Set(eventRegistry.map((entry) => entry.type));

  const missingFromRegistry = [...catalogueTypes].filter((type) => !registryTypes.has(type)).sort();
  const missingFromCatalogue = [...registryTypes].filter((type) => !catalogueTypes.has(type)).sort();

  // Every event's own `stream` must be one of the prefixes the "Streams"
  // table lists (e.g. an event can't claim stream "members" if the table
  // only lists "member"), and every prefix the table lists should be used
  // by at least one event, or the table is describing a stream nothing
  // ever writes to.
  const unknownStreams = eventRegistry
    .filter((entry) => !streamTypes.has(entry.stream))
    .map((entry) => `${entry.type} declares stream "${entry.stream}", which is not in the Streams table`)
    .sort();
  const streamTypesUsedByRegistry = new Set(eventRegistry.map((entry) => entry.stream));
  const unusedStreamTypes = [...streamTypes].filter((type) => !streamTypesUsedByRegistry.has(type)).sort();

  // Beyond "is this a real stream", check *which* real stream: an event
  // moved onto some other stream that's still in the table (e.g.
  // approval.used onto "effect") would pass the checks above but is still
  // wrong, and that's a mistake CI should catch, not just documentation.
  const wrongStreams = wrongStreamAssignments(eventRegistry);

  const ok =
    missingFromRegistry.length === 0 &&
    missingFromCatalogue.length === 0 &&
    unknownStreams.length === 0 &&
    unusedStreamTypes.length === 0 &&
    wrongStreams.length === 0;

  if (malformedNames.size > 0) {
    console.warn(
      `check:events — warning: ${String(malformedNames.size)} backticked name(s) in the Catalogue section look like they were meant to be event types, but don't match the word.word shape:`,
    );
    for (const name of [...malformedNames].sort()) {
      console.warn(`  - \`${name}\``);
    }
  }

  if (ok) {
    console.log(
      `check:events — OK: ${String(catalogueTypes.size)} event types agree between the registry and the catalogue.`,
    );
    return;
  }

  console.error('check:events — FAILED: the registry and the catalogue disagree.');
  if (missingFromRegistry.length > 0) {
    console.error('\nIn docs/architecture/events.md but missing from libs/events/src/registry.ts:');
    for (const type of missingFromRegistry) {
      console.error(`  - ${type}`);
    }
  }
  if (missingFromCatalogue.length > 0) {
    console.error('\nIn libs/events/src/registry.ts but missing from docs/architecture/events.md:');
    for (const type of missingFromCatalogue) {
      console.error(`  - ${type}`);
    }
  }
  if (unknownStreams.length > 0) {
    console.error('\nEvents whose stream is not in the catalogue\'s "Streams" table:');
    for (const line of unknownStreams) {
      console.error(`  - ${line}`);
    }
  }
  if (unusedStreamTypes.length > 0) {
    console.error('\nStream-type prefixes in the "Streams" table that no event in the registry uses:');
    for (const type of unusedStreamTypes) {
      console.error(`  - ${type}`);
    }
  }
  if (wrongStreams.length > 0) {
    console.error('\nEvents on the wrong stream (see EVENT_PREFIX_STREAM_EXCEPTIONS in this file):');
    for (const line of wrongStreams) {
      console.error(`  - ${line}`);
    }
  }
  process.exitCode = 1;
}

// Only run when this file is executed directly (`npm run check:events`),
// not when a test imports it for its exported parsing helpers — otherwise
// importing the module would read the real catalogue and print to the
// console as a side effect of loading it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
