import { spawnSync } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';
import { qualifications } from './collect.ts';
import { probeHost } from './host-probe.ts';
import { runJourney } from './journey.ts';
import { probeContainer } from './container-probe.ts';
import { checkNative } from './native-checks.ts';

vi.mock('./host-probe.ts', { spy: true });
vi.mock('./container-probe.ts', { spy: true });
vi.mock('./native-checks.ts', { spy: true });
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
  vi.mocked(probeContainer).mockReturnValue('swap_measurement_failed');
}
beforeEach(prepare);

async function incomplete(name: string): Promise<void> {
  const namedRequest = { ...request, name };
  const result = await runJourney(JSON.stringify(namedRequest));
  expect(result).toMatchObject({ ...request, name, result: 'NOT RUN', complete: false });
  expect(result).toHaveProperty('observedAt', expect.any(Number));
  expect(probeHost).toHaveBeenCalledTimes(2);
}
it.each(['nativeRecall',
  'persistence', ...qualifications])('never completes %s on host checks alone', incomplete);

const invalid: [string, unknown][] = [
  ['sourceSha', 'a'.repeat(39)], ['imageDigest', 'latest'], ['environmentId', '../private'],
  ['siloId', 'raw-silo'], ['installationId', 'old-install'], ['freshInstall', false],
  ['runId', 'not-a-uuid'], ['challengeId', '../../private'], ['name', 'unknown'],
  ['name', '../../private.mjs'], ['executable', '/private/program'], ['observations', {}],
  ['complete', true], ['result', 'PASS'],
  ['sourceSha', `${request.sourceSha}\n`], ['imageDigest', `${request.imageDigest}\n`],
  ['environmentId', `${request.environmentId}\n`], ['siloId', `${request.siloId}\n`],
  ['installationId', `${request.installationId}\n`], ['runId', `${request.runId}\n`],
  ['challengeId', `${request.challengeId}\n`],
];
async function invalidField(field: string, value: unknown): Promise<void> {
  const invalidRequest = { ...request, [field]: value };
  expect(await runJourney(JSON.stringify(invalidRequest))).toEqual({
    result: 'FAIL', reason: 'input_invalid',
  });
  expect(probeHost).not.toHaveBeenCalled();
}
it.each(invalid)('refuses malformed or extra %s', invalidField);

async function missingField(field: string): Promise<void> {
  const missing: Record<string, unknown> = { ...request };
  delete missing[field];
  expect(await runJourney(JSON.stringify(missing))).toEqual({
    result: 'FAIL', reason: 'input_invalid',
  });
  expect(probeHost).not.toHaveBeenCalled();
}
it.each(Object.keys(request))('requires %s', missingField);

async function malformed(input: string): Promise<void> {
  expect(await runJourney(input)).toEqual({ result: 'FAIL', reason: 'input_invalid' });
  expect(probeHost).not.toHaveBeenCalled();
}
it.each(['', '{', 'null', '[]', '{}\n{}', ' '.repeat(4097), 'é'.repeat(2049)])(
  'refuses malformed or oversized input %#', malformed);

async function unsafeHost(): Promise<void> {
  vi.mocked(probeHost).mockReturnValue(false);
  expect(await runJourney(JSON.stringify(request))).toEqual({
    result: 'FAIL', reason: 'host_refused', protectionFailure: 'swap_measurement_failed',
  });
}
it('refuses a host whose observations are unsafe or unavailable', unsafeHost);

async function containerPrerequisite(name: string): Promise<void> {
  vi.mocked(probeHost).mockReturnValue(false);
  vi.mocked(probeContainer).mockReturnValue(true);
  const namedRequest = { ...request, name };
  const input = JSON.stringify(namedRequest);
  expect(await runJourney(input)).toMatchObject({ result: 'NOT RUN', complete: false });
  expect(probeContainer).toHaveBeenCalledTimes(2);
}
it.each(['privateTurns', 'invalidation', 'P4-14', 'P4-15'])(
  'keeps %s unrun when only the container runner is protected', containerPrerequisite);

async function changedDuringWork(): Promise<void> {
  function changeHost(): Promise<void> {
    vi.mocked(probeHost).mockReturnValue(false);
    vi.mocked(probeContainer).mockReturnValue(true);
    return Promise.resolve();
  }
  vi.mocked(checkNative).mockImplementationOnce(changeHost);
  expect(await runJourney(JSON.stringify(request))).toEqual({
    result: 'FAIL', reason: 'host_refused',
  });
}
it('refuses changed protection after awaited work without switching paths', changedDuringWork);
async function changedBeforeReceipt(): Promise<void> {
  vi.mocked(probeHost).mockReturnValue(false);
  vi.mocked(probeContainer).mockReturnValueOnce(true).mockReturnValue('helper_unavailable');
  expect(await runJourney(JSON.stringify(request))).toEqual({
    result: 'FAIL', reason: 'host_refused', protectionFailure: 'helper_unavailable',
  });
}
it('remeasures container protection before returning the prerequisite receipt', changedBeforeReceipt);

function entryRefuses(input: string, args: string[] = []): void {
  const options = { input, encoding: 'utf8' as const, timeout: 5000 };
  const command = ['--experimental-strip-types',
    'scripts/private-memory-qualification/journey.mjs', ...args];
  const result = spawnSync(process.execPath, command, options);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('{"result":"FAIL","reason":"input_invalid"}\n');
  expect(result.stderr).toBe('');
}
function refusesEntryInput(input: string): void {
  entryRefuses(input);
}
it.each(['{private', 'x'.repeat(4097), 'é'.repeat(2049)])(
  'bounds and sanitises the real entry input %#', refusesEntryInput);
function refusesArguments(): void {
  entryRefuses(JSON.stringify(request), ['/private/program']);
}
it('refuses command arguments without running a selected executable', refusesArguments);

async function missingNative(): Promise<void> {
  expect(await runJourney(JSON.stringify(request))).toEqual({
    result: 'FAIL', reason: 'journey_failed',
  });
}
it('refuses a host-only result when the native binary is absent', missingNative);
