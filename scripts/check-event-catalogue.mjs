#!/usr/bin/env node
// Checks that the event registry (libs/events/src/registry.ts) and the
// event catalogue (docs/architecture/events.md) name exactly the same
// event types, in both directions. If they disagree, the catalogue is no
// longer the contract it claims to be, so this fails the build.
//
// Run with: npm run check:events (wired into CI too).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventRegistry } from '../libs/events/src/registry.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const cataloguePath = path.join(repoRoot, 'docs/architecture/events.md');

/**
 * Pulls every backticked event name out of the "## Catalogue" section's
 * tables. Each table's first column lists one or more event types, like
 * `` `a.b` `` or `` `a.b` / `c.d` / `e.f` ``; a row's other columns are
 * prose, not event names, so only the first cell is read.
 *
 * @param {string} markdown
 * @returns {Set<string>}
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
  let inEventTable = false;

  for (const line of section) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      // A blank line (or anything else) ends whatever table we were in.
      inEventTable = false;
      continue;
    }

    const cells = trimmed
      .slice(1, trimmed.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((cell) => cell.trim());
    const firstCell = cells[0] ?? '';

    if (firstCell === 'Event') {
      inEventTable = true;
      continue;
    }
    // The header separator row, e.g. "|---|---|---|---|".
    if (/^:?-+:?$/.test(firstCell)) {
      continue;
    }
    if (!inEventTable) {
      continue;
    }

    for (const match of firstCell.matchAll(/`([^`]+)`/g)) {
      eventTypes.add(match[1]);
    }
  }

  return eventTypes;
}

async function main() {
  const markdown = await readFile(cataloguePath, 'utf8');
  const catalogueTypes = parseCatalogueEventTypes(markdown);
  const registryTypes = new Set(eventRegistry.map((entry) => entry.type));

  const missingFromRegistry = [...catalogueTypes].filter((type) => !registryTypes.has(type)).sort();
  const missingFromCatalogue = [...registryTypes].filter((type) => !catalogueTypes.has(type)).sort();

  if (missingFromRegistry.length === 0 && missingFromCatalogue.length === 0) {
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
  process.exitCode = 1;
}

await main();
