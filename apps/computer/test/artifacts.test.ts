import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
async function boundsArtifactReads() {
  const root = await mkdtemp(`${tmpdir()}/artifacts-`);
  async function scan() {
    const args = ['apps/computer/src/artifacts.py', root];
    const result = await execute('python3', args);
    return JSON.parse(result.stdout) as { id: string; name?: string; reason?: string }[];
  }
  try {
    await mkdir(`${root}/artifacts/nested`, { recursive: true });
    await writeFile(`${root}/outside.txt`, 'Outside');
    await writeFile(`${root}/artifacts/nested/report.txt`, 'A report');
    await symlink(`${root}/outside.txt`, `${root}/artifacts/link.txt`);
    await writeFile(`${root}/artifacts/large.txt`, '');
    await truncate(`${root}/artifacts/large.txt`, 20 * 1024 * 1024 + 1);
    const entries = await scan();
    expect(entries).toHaveLength(3);
    function named(entry: typeof entries[number]) { return entry.name === 'report.txt'; }
    const report = entries.find(named)!;
    expect(report).toBeDefined();
    expect(entries).toContainEqual({ id: expect.any(String), reason: 'too_large' });
    expect(entries).toContainEqual({ id: expect.any(String), reason: 'unsafe_name' });
    expect(JSON.stringify(entries)).not.toContain('nested');
    const args = ['apps/computer/src/artifacts.py', root, report.id, '0'];
    const read = await execute('python3', args);
    expect(read.stdout).toBe('A report');
    await writeFile(`${root}/artifacts/nested/report.txt`, 'Changed');
    expect(await scan()).not.toEqual(entries);
    for (let index = 0; index < 17; index++) {
      await writeFile(`${root}/artifacts/item-${index}.txt`, 'Item');
    }
    const limited = await scan();
    expect(limited.length).toBeLessThanOrEqual(17);
    expect(limited).toContainEqual({ id: expect.any(String), reason: 'too_many_parts' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
it('bounds artifact files and refuses symlinks without reporting private paths', boundsArtifactReads);
