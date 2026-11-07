import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { dispatcherReady } from '../src/chat/dispatcher-status.ts';

it('reads the dev marker without exposing its process details', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dispatcher-status-'));
  const marker = join(directory, 'ready');
  try {
    expect(await dispatcherReady(undefined)).toBe(true);
    expect(await dispatcherReady(marker)).toBe(false);
    await writeFile(marker, String(process.pid));
    expect(await dispatcherReady(marker)).toBe(true);
    await writeFile(marker, '999999999');
    expect(await dispatcherReady(marker)).toBe(false);
    await writeFile(marker, 'upgrade-handlers');
    expect(await dispatcherReady(marker)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
