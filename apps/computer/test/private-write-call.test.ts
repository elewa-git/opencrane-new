import { execFile } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { record } from '../src/http.ts';

async function provesNativeWriteCalls() {
  const execute = promisify(execFile);
  const image = process.env['COMPUTER_TEST_IMAGE'] ?? 'ocn-upload-computer:test';
  const source = resolve('.');
  const fixture = new URL('./private-write-call-native.mjs', import.meta.url);
  const argumentsList = ['run', '--rm', '--network=none', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--entrypoint=nice',
    '--tmpfs', '/tmp:rw,nosuid,nodev', '-v', `${source}:/repo:ro`,
    image, '-n', '10', 'node', '--experimental-strip-types',
    `/repo/apps/computer/test/${basename(fixture.pathname)}`];
  let stdout: string;
  try {
    const result = await execute('docker', argumentsList, { timeout: 110_000 });
    stdout = result.stdout;
  } catch {
    // Keep child output out of test errors even when a protocol assertion fails.
    throw new Error('Native write fixture failed');
  }
  const observed = record(JSON.parse(stdout));
  expect(observed).toEqual({
    version: 'codex-cli 0.159.2',
    preparation: 'test-only',
    protocol: 'PASS',
    cases: [
      { name: 'no-grant', forwarded: 0, consumed: 0 },
      { name: 'remember', forwarded: 1, consumed: 1 },
      { name: 'correct', forwarded: 1, consumed: 1 },
      { name: 'forget', forwarded: 1, consumed: 1 },
      { name: 'foreign-caller', forwarded: 0, consumed: 0 },
      { name: 'foreign-thread', forwarded: 0, consumed: 0 },
      { name: 'ended', forwarded: 0, consumed: 0 },
      { name: 'expired', forwarded: 0, consumed: 0 },
      { name: 'expired-binding', forwarded: 0, consumed: 0 },
      { name: 'cancelled', forwarded: 1, consumed: 0 },
      { name: 'lost', forwarded: 1, consumed: 0 },
      { name: 'survivor', forwarded: 1, consumed: 1 },
    ],
  });
}
it('proves native write delivery and refusals without external services',
  provesNativeWriteCalls, 120_000);
