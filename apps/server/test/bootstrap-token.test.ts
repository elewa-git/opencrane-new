import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';

it('prints one random installation token and retains only a private expiring hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bootstrap-cli-'));
  const path = join(directory, 'token.json');
  const run = () => spawnSync(process.execPath, ['--experimental-strip-types', resolve('apps/server/src/bootstrap-token.ts')], {
    env: { ...process.env, BOOTSTRAP_TOKEN_FILE: path, SILO_ID: 'test' }, encoding: 'utf8',
  });
  try {
    const before = Date.now();
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    const token = result.stdout.trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.stderr).toBe('');
    const stored = await readFile(path, 'utf8');
    expect(stored).not.toContain(token);
    const record: unknown = JSON.parse(stored);
    expect(record).toMatchObject({ silo: 'test' });
    const saved = z.object({ hash: z.string(), expiresAt: z.string() }).parse(record);
    expect(saved.hash).toMatch(/^[a-f0-9]{64}$/u);
    const expires = Date.parse(saved.expiresAt);
    expect(expires - before).toBeGreaterThanOrEqual(86_400_000);
    expect(expires - Date.now()).toBeLessThanOrEqual(86_400_000);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const again = run();
    expect(again.status).not.toBe(0);
    expect(again.stdout).toBe('');
    expect(await readFile(path, 'utf8')).toBe(stored);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
