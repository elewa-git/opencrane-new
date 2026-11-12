import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const execute = promisify(execFile);

test('the scanner image gives its separate wrapper exactly three readable databases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'package-scanner-image-'));
  const image = `package-scanner-image-${randomUUID()}:test`;
  try {
    for (const name of ['main', 'daily', 'bytecode']) {
      await writeFile(join(directory, `${name}.cvd`), Buffer.alloc(512, name));
    }
    const build = ['build', '--build-context', `signatures=${directory}`,
      '-f', 'infra/package/Scanner.Dockerfile', '-t', image, '.'];
    await execute('docker', build, { timeout: 180000 });
    const script = 'ls -A /var/lib/clamav && cat /var/lib/clamav/*.cvd >/dev/null';
    const run = ['run', '--rm', '--read-only', '--network', 'none', '--user', '1000:1000',
      '--entrypoint', 'sh', image, '-ec', script];
    const result = await execute('docker', run, { timeout: 30000 });
    expect(result.stdout.trim().split('\n')).toEqual(['bytecode.cvd', 'daily.cvd', 'main.cvd']);
  } finally {
    await execute('docker', ['image', 'rm', image], { timeout: 30000 });
    await rm(directory, { recursive: true, force: true });
  }
}, 240000);
