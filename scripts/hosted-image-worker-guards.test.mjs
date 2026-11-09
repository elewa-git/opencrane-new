import { beforeEach, expect, test, vi } from 'vitest';

function mockModels() {
  return { readHostedAdmission: vi.fn(), readHostedImageScanAttempt: vi.fn() };
}
function mockWriter() {
  return { claimHostedImageScan: vi.fn(), writeHostedAdmission: vi.fn() };
}
function mockWalk() {
  return { scanHostedImageAttempt: vi.fn() };
}
vi.mock('@opencrane/models', mockModels);
vi.mock('@opencrane/models/image-admission-writer', mockWriter);
vi.mock('../infra/clamav/image-walk.mjs', mockWalk);

import { readHostedAdmission, readHostedImageScanAttempt } from '@opencrane/models';
import { claimHostedImageScan, writeHostedAdmission }
  from '@opencrane/models/image-admission-writer';
import { scanHostedImageAttempt } from '../infra/clamav/image-walk.mjs';
import { runAndWriteHostedImageCheck, runHostedImageScan }
  from '../infra/clamav/image-worker.mjs';

const attempt = { silo: 'test', serverId: 'server-one', attemptId: 1,
  platform: 'linux/amd64', imageDigest: 'a'.repeat(64), status: 'checking' };
let store;
let controller;
let prepareImage;
let readSettings;
let readChecks;
let scanned;

function setup() {
  vi.resetAllMocks();
  store = {};
  controller = new AbortController();
  prepareImage = vi.fn().mockResolvedValue({});
  readSettings = vi.fn().mockResolvedValue({});
  readChecks = vi.fn().mockResolvedValue({ signature: {}, licence: {}, vulnerability: {} });
  scanned = { verdict: 'clean', malware: { verdict: 'pass' },
    validate: vi.fn().mockResolvedValue('clean') };
  vi.mocked(readHostedAdmission).mockResolvedValue({ attemptId: 1 });
  vi.mocked(readHostedImageScanAttempt).mockResolvedValue(attempt);
  vi.mocked(scanHostedImageAttempt).mockResolvedValue(scanned);
  vi.mocked(claimHostedImageScan).mockResolvedValue({ status: 'claimed' });
  vi.mocked(writeHostedAdmission).mockResolvedValue({ status: 'appended' });
}
beforeEach(setup);

function scan(signal = controller.signal) {
  return runHostedImageScan(store, attempt.silo, attempt.serverId,
    prepareImage, readSettings, signal);
}
function write(signal = controller.signal) {
  return runAndWriteHostedImageCheck(store, attempt.silo, attempt.serverId,
    attempt.attemptId, prepareImage, readSettings, readChecks, signal);
}

async function abortBeforeSavedAttempt() {
  controller.abort();
  expect((await scan()).verdict).toBe('unavailable');
  expect(readHostedImageScanAttempt).not.toHaveBeenCalled();
}
test('an aborted scan does not read the saved attempt', abortBeforeSavedAttempt);

async function refusesAbsentSavedAttempt() {
  vi.mocked(readHostedImageScanAttempt).mockResolvedValue(undefined);
  expect((await scan()).verdict).toBe('unavailable');
  expect(prepareImage).not.toHaveBeenCalled();
}
test('an absent saved attempt cannot prepare image bytes', refusesAbsentSavedAttempt);

async function abortAfterSavedAttempt() {
  async function returnAndAbort() {
    controller.abort();
    return attempt;
  }
  vi.mocked(readHostedImageScanAttempt).mockImplementationOnce(returnAndAbort);
  expect((await scan()).verdict).toBe('unavailable');
  expect(prepareImage).not.toHaveBeenCalled();
}
test('cancellation after the attempt read stops image preparation', abortAfterSavedAttempt);

async function abortAfterScan() {
  async function returnAndAbort() {
    controller.abort();
    return scanned;
  }
  vi.mocked(scanHostedImageAttempt).mockImplementationOnce(returnAndAbort);
  expect((await scan()).verdict).toBe('unavailable');
  expect(readHostedImageScanAttempt).toHaveBeenCalledTimes(1);
}
test('cancellation after scanning stops the validation read', abortAfterScan);

async function missingCurrentAttempt() {
  const readAttempt = vi.mocked(readHostedImageScanAttempt);
  readAttempt.mockResolvedValueOnce(attempt);
  readAttempt.mockResolvedValueOnce(undefined);
  expect((await scan()).verdict).toBe('unavailable');
  expect(readSettings).toHaveBeenCalledTimes(1);
  expect(scanned.validate).not.toHaveBeenCalled();
}
test('a missing current attempt stops validation before reading scanner settings',
  missingCurrentAttempt);

async function abortDuringSettingsRead() {
  async function abortOnSecondRead() {
    controller.abort();
    return {};
  }
  const settings = vi.mocked(readSettings);
  settings.mockResolvedValueOnce({});
  settings.mockImplementationOnce(abortOnSecondRead);
  expect((await scan()).verdict).toBe('unavailable');
  expect(scanned.validate).not.toHaveBeenCalled();
}
test('cancellation during the current settings read stops part validation',
  abortDuringSettingsRead);

async function abortDuringPartValidation() {
  async function validateAndAbort() {
    controller.abort();
    return 'clean';
  }
  scanned.validate = vi.fn().mockImplementation(validateAndAbort);
  expect((await scan()).verdict).toBe('unavailable');
  expect(scanned.validate).toHaveBeenCalledTimes(1);
}
test('cancellation after part validation refuses the clean verdict',
  abortDuringPartValidation);

async function changedOriginalAttempt() {
  vi.mocked(readHostedImageScanAttempt).mockResolvedValue({ ...attempt, attemptId: 2 });
  expect((await write()).status).toBe('unavailable');
  expect(readChecks).not.toHaveBeenCalled();
}
test('the original delivery cannot write a newly selected attempt', changedOriginalAttempt);

async function readsResultAfterAnotherWorkerClaims() {
  const admission = vi.mocked(readHostedAdmission);
  admission.mockResolvedValueOnce(attempt);
  admission.mockResolvedValueOnce({ ...attempt, checks: {} });
  vi.mocked(claimHostedImageScan).mockResolvedValue({ status: 'unavailable' });

  expect((await write()).status).toBe('appended');
  expect(admission).toHaveBeenCalledTimes(2);
  expect(prepareImage).not.toHaveBeenCalled();
  expect(scanHostedImageAttempt).not.toHaveBeenCalled();
}
test('reads the saved result after another worker claims the scan',
  readsResultAfterAnotherWorkerClaims);

async function refusesScanWithoutOneRequiredFact(kind) {
  if (kind === 'verdict') scanned.verdict = 'infected';
  if (kind === 'malware') scanned.malware = undefined;
  expect((await write()).status).toBe('unavailable');
  expect(readChecks).not.toHaveBeenCalled();
}
test.each(['verdict', 'malware'])(
  'a scan without a clean %s stops before separate checks',
  refusesScanWithoutOneRequiredFact);

async function refusesEachMissingReceipt(kind) {
  const checks = { signature: {}, licence: {}, vulnerability: {} };
  delete checks[kind];
  readChecks.mockResolvedValue(checks);
  expect((await write()).status).toBe('unavailable');
  expect(claimHostedImageScan).toHaveBeenCalledTimes(1);
  expect(scanHostedImageAttempt).toHaveBeenCalledTimes(1);
  expect(writeHostedAdmission).not.toHaveBeenCalled();
}
test.each(['signature', 'licence', 'vulnerability'])(
  'a missing %s receipt stops before the writer', refusesEachMissingReceipt);
