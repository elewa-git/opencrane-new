import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { restoreKube } from './pilot-restore-kube.ts';

it('passes private patch bytes to the real kubectl file reader', async function appliesPatch() {
  const directory = await mkdtemp(join(tmpdir(), 'restore-patch-test-'));
  try {
    const resource = join(directory, 'resource.json');
    const config = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'fixture' }, data: {} };
    await writeFile(resource, JSON.stringify(config), { mode: 0o600 });
    const patch = Buffer.from(JSON.stringify({ data: { canary: 'private-patch-canary' } }));
    const args = ['patch', '--local', '-f', resource, '--type=merge',
      '--patch-file=/dev/stdin', '-o', 'json'];
    const output = await restoreKube(args, Date.now() + 10000, patch);
    expect(JSON.parse(output)).toEqual({ ...config, data: { canary: 'private-patch-canary' } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
