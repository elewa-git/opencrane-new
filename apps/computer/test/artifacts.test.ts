import { artifactListSchema } from '@opencrane/events';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
async function boundsArtifactReads() {
  const root = await mkdtemp(`${tmpdir()}/artifacts-`);
  async function scan() {
    const args = ['apps/computer/src/artifacts.py', `${root}/workspace`];
    const pending = execute('python3', args);
    pending.child.stdin!.end();
    const result = await pending;
    return artifactListSchema.parse(JSON.parse(result.stdout) as unknown);
  }
  try {
    await symlink(root, `${root}/workspace`);
    await mkdir(`${root}/artifacts/nested`, { recursive: true });
    await writeFile(`${root}/outside.txt`, 'Outside');
    await writeFile(`${root}/artifacts/nested/report.txt`, 'A report');
    await symlink(`${root}/outside.txt`, `${root}/artifacts/link.txt`);
    await writeFile(`${root}/artifacts/large.txt`, '');
    await truncate(`${root}/artifacts/large.txt`, 20 * 1024 * 1024 + 1);
    const entries = await scan();
    expect(entries).toHaveLength(3);
    function named(entry: typeof entries[number]) { return 'name' in entry && entry.name === 'report.txt'; }
    const report = entries.find(named)!;
    expect(report).toBeDefined();
    expect(entries.some(isTooLarge)).toBe(true);
    expect(entries.some(isUnsafe)).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('nested');
    const args = ['apps/computer/src/artifacts.py', `${root}/workspace`, report.id, '0'];
    const read = await execute('python3', args);
    expect(read.stdout).toBe('A report');
    await writeFile(`${root}/artifacts/nested/report.txt`, 'Changed');
    expect(await scan()).not.toEqual(entries);
    for (let index = 0; index < 17; index++) {
      await writeFile(`${root}/artifacts/item-${index}.txt`, 'Item');
    }
    const limited = await scan();
    expect(limited.length).toBeLessThanOrEqual(17);
    expect(limited.some(isTooMany)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
it('bounds artifact files and refuses symlinks without reporting private paths', boundsArtifactReads);

type Artifact = ReturnType<typeof artifactListSchema.parse>[number];
function isTooLarge(file: Artifact) { return 'reason' in file && file.reason === 'too_large'; }
function isUnsafe(file: Artifact) { return 'reason' in file && file.reason === 'unsafe_name'; }
function isTooMany(file: Artifact) { return 'reason' in file && file.reason === 'too_many_parts'; }
