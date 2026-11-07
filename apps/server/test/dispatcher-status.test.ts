import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { dispatcherReady } from '../src/chat/dispatcher-status.ts';

it('requires the marker to belong to the recorded dispatcher process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dispatcher-status-'));
  const marker = join(directory, 'ready');
  const dispatcherProcess = join(directory, 'dispatcher.pid');
  const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const processStart = fields[19];
  try {
    expect(await dispatcherReady(undefined)).toBe(true);
    expect(await dispatcherReady(marker)).toBe(false);
    await writeFile(marker, String(process.pid));
    // This live test process is not the dispatcher without its matching start record.
    expect(await dispatcherReady(marker)).toBe(false);
    await writeFile(dispatcherProcess, `${process.pid} ${processStart}`);
    expect(await dispatcherReady(marker)).toBe(true);
    await writeFile(dispatcherProcess, `${process.pid} 0`);
    expect(await dispatcherReady(marker)).toBe(false);
    await writeFile(dispatcherProcess, `${process.pid} ${processStart}`);
    await writeFile(marker, '999999999');
    expect(await dispatcherReady(marker)).toBe(false);
    await writeFile(marker, 'upgrade-handlers');
    expect(await dispatcherReady(marker)).toBe(false);
    for (const invalidPid of ['0', '-1', '9007199254740992']) {
      await writeFile(marker, invalidPid);
      expect(await dispatcherReady(marker)).toBe(false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
