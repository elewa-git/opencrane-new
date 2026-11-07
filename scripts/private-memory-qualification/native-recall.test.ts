import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { probeContainer } from './container-probe.ts';
import { probeHost } from './host-probe.ts';
import { runJourney } from './journey.ts';
import { checkNative } from './native-checks.ts';

vi.mock('./host-probe.ts', { spy: true });
vi.mock('./container-probe.ts', { spy: true });
vi.mock('./native-checks.ts', { spy: true });

const silo = 'recall-test-silo';
const hash = createHash('sha256');
hash.update(silo);
const request = {
  sourceSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`,
  environmentId: 'c'.repeat(64), siloId: `sha256:${hash.digest('hex')}`,
  installationId: `sha256:${'e'.repeat(64)}`, freshInstall: true,
  runId: '11111111-1111-4111-8111-111111111111',
  challengeId: '22222222-2222-4222-8222-222222222222', name: 'nativeRecall',
};

function prepare() {
  vi.mocked(checkNative).mockReset();
  vi.mocked(checkNative).mockResolvedValue(undefined);
  vi.mocked(probeHost).mockReset();
  vi.mocked(probeHost).mockReturnValue(true);
  vi.mocked(probeContainer).mockReset();
  vi.mocked(probeContainer).mockReturnValue(true);
  vi.stubEnv('SILO_ID', silo);
}
function restore() {
  vi.unstubAllEnvs();
}
beforeEach(prepare);
afterEach(restore);

async function checksNativeBeforeReceipt() {
  const receipt = await runJourney(JSON.stringify(request));
  expect(checkNative).toHaveBeenCalledExactlyOnceWith(request.challengeId);
  const observedAt: unknown = expect.any(Number);
  const expected = { ...request, result: 'NOT RUN', complete: false, observedAt };
  expect(receipt).toEqual(expected);
}
it('checks the pinned native runtime before returning an incomplete recall receipt',
  checksNativeBeforeReceipt);

async function refusesNativeFailure() {
  const failure = new Error('private child output');
  vi.mocked(checkNative).mockRejectedValueOnce(failure);
  const receipt = await runJourney(JSON.stringify(request));
  expect(receipt).toEqual({ result: 'FAIL', reason: 'journey_failed' });
  expect(checkNative).toHaveBeenCalledTimes(1);
}
it('refuses missing shipped Codex or failed native checks without exposing child output',
  refusesNativeFailure);

async function refusesWrongSilo(value: string | undefined) {
  vi.stubEnv('SILO_ID', value);
  const receipt = await runJourney(JSON.stringify(request));
  expect(receipt).toEqual({ result: 'FAIL', reason: 'journey_failed' });
  expect(checkNative).not.toHaveBeenCalled();
}
it.each([undefined, '', 'another-silo'])('refuses an absent or foreign silo: %s', refusesWrongSilo);

async function refusesSiloChange() {
  function changeSilo() {
    vi.stubEnv('SILO_ID', 'replacement-silo');
    return Promise.resolve();
  }
  vi.mocked(checkNative).mockImplementationOnce(changeSilo);
  const receipt = await runJourney(JSON.stringify(request));
  expect(receipt).toEqual({ result: 'FAIL', reason: 'journey_failed' });
}
it('rechecks the silo after awaited native work', refusesSiloChange);

async function refusesHostChange() {
  function changeHost() {
    vi.mocked(probeHost).mockReturnValue(false);
    return Promise.resolve();
  }
  vi.mocked(checkNative).mockImplementationOnce(changeHost);
  const receipt = await runJourney(JSON.stringify(request));
  expect(receipt).toEqual({ result: 'FAIL', reason: 'host_refused' });
  expect(probeContainer).not.toHaveBeenCalled();
}
it('refuses changed host protection after native work without switching protection paths',
  refusesHostChange);

async function refusesHostBeforeNative() {
  vi.mocked(probeHost).mockReturnValueOnce(true);
  vi.mocked(probeHost).mockReturnValue(false);
  const receipt = await runJourney(JSON.stringify(request));
  expect(receipt).toEqual({ result: 'FAIL', reason: 'host_refused' });
  expect(checkNative).not.toHaveBeenCalled();
}
it('rechecks host protection after loading the recall helper', refusesHostBeforeNative);

async function runnerOnlyProtection() {
  vi.mocked(probeHost).mockReturnValue(false);
  const receipt = await runJourney(JSON.stringify(request));
  expect(receipt).toMatchObject({ result: 'NOT RUN', complete: false });
  expect(checkNative).not.toHaveBeenCalled();
  expect(probeContainer).toHaveBeenCalledTimes(2);
}
it('starts no native work when protection covers only the container runner', runnerOnlyProtection);
