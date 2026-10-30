import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runInContainer } from './container-process.ts';

let containerId: string;
let imageId: string;
function docker(args: string[]): string {
  const options = { encoding: 'utf8' as const, timeout: 30_000, stdio: 'pipe' as const };
  return execFileSync('/usr/bin/docker', args, options).trim();
}
function prepare(): void {
  const context = mkdtempSync(join(tmpdir(), 'private-host-fixture-'));
  try {
    cpSync('scripts/private-memory-qualification', join(context, 'scripts'), { recursive: true });
    cpSync('node_modules/zod', join(context, 'zod'), { recursive: true });
    const source = 'FROM node:22.23.1-bookworm-slim\nWORKDIR /app\n' +
      'COPY scripts /app/scripts/private-memory-qualification\nCOPY zod /app/node_modules/zod\n';
    writeFileSync(join(context, 'Dockerfile'), source);
    imageId = docker(['build', '--network=none', '-q', context]);
    containerId = docker(['run', '-d', '--init', '--network=none', '--read-only',
      '--tmpfs', '/run', '--cpus=0.5', imageId, 'sleep', 'infinity']);
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}
function cleanup(): void {
  if (containerId) docker(['rm', '-f', '-v', containerId]);
  if (imageId) docker(['image', 'rm', imageId]);
}
beforeAll(prepare, 60_000);
afterAll(cleanup, 30_000);

async function refusesRealHost(): Promise<void> {
  const request = {
    sourceSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`,
    environmentId: 'c'.repeat(64), siloId: `sha256:${'d'.repeat(64)}`,
    installationId: `sha256:${'e'.repeat(64)}`, freshInstall: true,
    runId: '11111111-1111-4111-8111-111111111111',
    challengeId: '22222222-2222-4222-8222-222222222222', name: 'privateTurns',
  };
  const args = ['/usr/local/bin/node', '--experimental-strip-types',
    '/app/scripts/private-memory-qualification/journey.mjs'];
  const options = { input: JSON.stringify(request), encoding: 'utf8' as const, timeout: 5000 };
  const direct = spawnSync('/usr/bin/docker', ['exec', '-i', containerId, ...args], options);
  expect(direct.status).toBe(1);
  expect(direct.stderr).toBe('');
  const refusal: unknown = JSON.parse(direct.stdout);
  const expected = [
    { result: 'FAIL', reason: 'host_refused' },
    { result: 'FAIL', reason: 'journey_incomplete' },
  ];
  expect(expected).toContainEqual(refusal);
  await expect(runInContainer(containerId, args, JSON.stringify(request))).rejects.toThrow();
  // Confirm cleanup permits another attempt without replacing the image's code.
  await expect(runInContainer(containerId, args, JSON.stringify(request))).rejects.toThrow();
  docker(['exec', containerId, 'test', '!', '-e', '/run/opencrane-memory-qualification.lock']);
  const processes = docker(['top', containerId, '-eo', 'pid,args']);
  expect(processes).not.toContain('/usr/local/bin/node');
}
it('runs the image-owned entry and releases its supervised process group', refusesRealHost, 30_000);
