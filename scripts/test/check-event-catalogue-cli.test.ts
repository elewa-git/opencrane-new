// Runs the real `check:events` script (as a separate process, the way CI
// does) against the real catalogue and against doctored copies of it, and
// checks the exit code. The parsing tests next door prove what the script
// *finds*; this proves it actually *fails the build* when it finds it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const realCatalogue = readFileSync(path.join(repoRoot, 'docs/architecture/events.md'), 'utf8');
const scratch = mkdtempSync(path.join(tmpdir(), 'check-events-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function runCheck(markdown: string): { status: number | null; output: string } {
  const file = path.join(scratch, 'events.md');
  writeFileSync(file, markdown);
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', path.join(repoRoot, 'scripts/check-event-catalogue.mjs'), '--catalogue', file],
    { encoding: 'utf8' },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

// Adds one row straight under the first table in the Catalogue section.
function withExtraRow(markdown: string, row: string): string {
  const lines = markdown.split('\n');
  const heading = lines.indexOf('## Catalogue');
  const separator = lines.findIndex((line, index) => index > heading && line.startsWith('|---'));
  lines.splice(separator + 1, 0, row);
  return lines.join('\n');
}

describe('check:events as a process', () => {
  it('passes on the real catalogue', () => {
    expect(runCheck(realCatalogue)).toMatchObject({ status: 0 });
  });

  it.each([
    ['a hyphenated name in the Event column', '| `member-joined` | x | x | x |'],
    ['a camelCase name in the Event column', '| `memberJoined` | x | x | x |'],
    ['a three-part name in the Event column', '| `tool.list.changed` | x | x | x |'],
    ['a three-part name in a Reactions cell', '| `member.joined` | x | x | emit `tool.list.changed` |'],
  ])('fails on %s', (_label, row) => {
    const { status, output } = runCheck(withExtraRow(realCatalogue, row));
    expect(status).toBe(1);
    expect(output).toContain('not valid event names');
  });

  it('only warns, and still passes, for a hyphenated name outside the Event column', () => {
    const { status, output } = runCheck(withExtraRow(realCatalogue, '| `member.joined` | x | x | emit `member-joined` |'));
    expect(status).toBe(0);
    expect(output).toContain('may have been meant as event types');
  });

  it('fails when the catalogue drops an event the registry has', () => {
    expect(runCheck(realCatalogue.replaceAll('`approval.expired`', '`approval.timed_out`')).status).toBe(1);
  });

  it('fails when an event the registry puts on a stream is missing from the Streams table', () => {
    const withoutRow = realCatalogue
      .split('\n')
      .filter((line) => !line.startsWith('| `approval-<id>`'))
      .join('\n');
    const { status, output } = runCheck(withoutRow);
    expect(status).toBe(1);
    expect(output).toContain('not in the catalogue\'s "Streams" table');
  });
});
