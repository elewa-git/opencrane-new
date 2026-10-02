import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// Opt-in qualification uses the owned dev stack: real OIDC sessions, k3d Codex,
// NATS, PostgreSQL, OpenFGA and agentgateway's stub. It never selects OpenAI.
it.runIf(process.env['BRIDGE_K3D'] === '1')('streams a joined member reply and wakes the suspended k3d computer on another message', async () => {
  const run = promisify(execFile);
  expect((await run('kubectl', ['config', 'current-context'])).stdout.trim()).toBe('k3d-ocn');
  const { stdout } = await run('sh', ['infra/dev-stack/journey.sh'], { timeout: 180_000, maxBuffer: 1_048_576 });
  expect(stdout).toContain('PASS joined member HTTP message');
  expect(stdout).toContain('PASS suspended computer wakes on HTTP message');
}, 190_000);
