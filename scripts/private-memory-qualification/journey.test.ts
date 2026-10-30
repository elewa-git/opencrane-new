import { spawnSync } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';
import { checks, qualifications } from './collect.ts';
import { probeHost } from './host-probe.ts';
import { runJourney } from './journey.ts';

vi.mock('./host-probe.ts', { spy: true });
const request = {
  sourceSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`,
  environmentId: 'c'.repeat(64), siloId: `sha256:${'d'.repeat(64)}`,
  installationId: `sha256:${'e'.repeat(64)}`, freshInstall: true,
  runId: '11111111-1111-4111-8111-111111111111',
  challengeId: '22222222-2222-4222-8222-222222222222', name: 'privateTurns',
};
function prepare(): void {
  vi.mocked(probeHost).mockReset();
  vi.mocked(probeHost).mockReturnValue(true);
}
beforeEach(prepare);

function incomplete(name: string): void {
  expect(runJourney(JSON.stringify({ ...request, name }))).toEqual({
    result: 'FAIL', reason: 'journey_incomplete',
  });
  expect(probeHost).toHaveBeenCalledOnce();
}
it.each([...checks, ...qualifications])('never completes %s on host checks alone', incomplete);

const invalid: [string, unknown][] = [
  ['sourceSha', 'a'.repeat(39)], ['imageDigest', 'latest'], ['environmentId', '../private'],
  ['siloId', 'raw-silo'], ['installationId', 'old-install'], ['freshInstall', false],
  ['runId', 'not-a-uuid'], ['challengeId', '../../private'], ['name', 'unknown'],
  ['name', '../../private.mjs'], ['executable', '/private/program'], ['observations', {}],
  ['complete', true], ['result', 'PASS'],
];
function invalidField(field: string, value: unknown): void {
  expect(runJourney(JSON.stringify({ ...request, [field]: value }))).toEqual({
    result: 'FAIL', reason: 'input_invalid',
  });
  expect(probeHost).not.toHaveBeenCalled();
}
it.each(invalid)('refuses malformed or extra %s', invalidField);

function missingField(field: string): void {
  const missing: Record<string, unknown> = { ...request };
  delete missing[field];
  expect(runJourney(JSON.stringify(missing)).reason).toBe('input_invalid');
  expect(probeHost).not.toHaveBeenCalled();
}
it.each(Object.keys(request))('requires %s', missingField);

function malformed(input: string): void {
  expect(runJourney(input)).toEqual({ result: 'FAIL', reason: 'input_invalid' });
  expect(probeHost).not.toHaveBeenCalled();
}
it.each(['', '{', 'null', '[]', '{}\n{}', ' '.repeat(4097), 'é'.repeat(2049)])(
  'refuses malformed or oversized input %#', malformed);

function unsafeHost(): void {
  vi.mocked(probeHost).mockReturnValue(false);
  expect(runJourney(JSON.stringify(request))).toEqual({ result: 'FAIL', reason: 'host_refused' });
}
it('refuses a host whose observations are unsafe or unavailable', unsafeHost);

function entryRefuses(input: string, args: string[] = []): void {
  const options = { input, encoding: 'utf8' as const, timeout: 5000 };
  const command = ['--experimental-strip-types',
    'scripts/private-memory-qualification/journey.mjs', ...args];
  const result = spawnSync(process.execPath, command, options);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('{"result":"FAIL","reason":"input_invalid"}\n');
  expect(result.stderr).toBe('');
}
it.each(['{private', 'x'.repeat(4097), 'é'.repeat(2049)])(
  'bounds and sanitises the real entry input %#', entryRefuses);
function refusesArguments(): void {
  entryRefuses(JSON.stringify(request), ['/private/program']);
}
it('refuses command arguments without running a selected executable', refusesArguments);
