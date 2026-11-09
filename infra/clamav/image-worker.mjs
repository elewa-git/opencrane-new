import { readHostedAdmission, readHostedImageScanAttempt } from '@opencrane/models';
import { writeHostedAdmission } from '@opencrane/models/image-admission-writer';
import { hostedImageCheckedSchema } from '@opencrane/events';
import { scanHostedImageAttempt } from './image-walk.mjs';

const unavailable = Object.freeze({ verdict: 'unavailable', reasonCode: 'image_scan_unavailable' });
const activeAttempts = new WeakMap();

function attemptsFor(store) {
  let attempts = activeAttempts.get(store);
  if (!attempts) {
    attempts = new Map();
    activeAttempts.set(store, attempts);
  }
  return attempts;
}

async function scanCurrentAttempt(store, silo, serverId, prepareImage, readSettings, signal) {
  signal?.throwIfAborted();
  // Read the saved attempt before fetching or unpacking any customer image bytes.
  const attempt = await readHostedImageScanAttempt(store, silo, serverId);
  if (!attempt) return;

  signal?.throwIfAborted();
  const image = await prepareImage(attempt, signal);
  signal?.throwIfAborted();
  const settings = await readSettings();
  const scanned = await scanHostedImageAttempt(attempt, image, settings, undefined, signal);
  if (scanned.verdict === 'unavailable') return;

  async function validate() {
    signal?.throwIfAborted();
    const currentAttempt = await readHostedImageScanAttempt(store, silo, serverId);
    if (!currentAttempt) return;
    signal?.throwIfAborted();
    const currentSettings = await readSettings();
    signal?.throwIfAborted();
    const verdict = await scanned.validate(currentAttempt, image, currentSettings);
    signal?.throwIfAborted();
    return verdict;
  }
  return { attempt, scanned, validate };
}

// Keep this result private. It does not write an event or admit an image.
export async function runHostedImageScan(store, silo, serverId, prepareImage,
  readSettings, signal) {
  try {
    const current = await scanCurrentAttempt(store, silo, serverId,
      prepareImage, readSettings, signal);
    if (!current) return unavailable;
    const verdict = await current.validate();
    if (verdict !== 'clean' && verdict !== 'infected') return unavailable;
    return { verdict };
  } catch {
    return unavailable;
  }
}

export async function savedResultMatches(store, silo, result) {
  const saved = await readHostedAdmission(store, silo, result.serverId);
  const expected = hostedImageCheckedSchema.safeParse(result);
  if (!expected.success) return false;
  if (!saved || saved.attemptId !== result.attemptId ||
      saved.imageDigest !== result.imageDigest || saved.platform !== result.platform) return false;
  return JSON.stringify(saved.checks) === JSON.stringify(expected.data.checks);
}

// A caller may supply only the three separate image checks. The scanner supplies malware.
async function writeCurrentImageCheck(store, silo, serverId, attemptId, prepareImage,
  readSettings, readIndependentChecks, signal, entry) {
  try {
    const saved = await readHostedAdmission(store, silo, serverId);
    if (!saved || saved.attemptId !== attemptId) return { status: 'unavailable' };
    if (saved?.checks) return { status: 'appended' };
    const current = await scanCurrentAttempt(store, silo, serverId,
      prepareImage, readSettings, signal);
    if (!current || current.attempt.attemptId !== attemptId ||
        current.scanned.verdict !== 'clean' || !current.scanned.malware) {
      return { status: 'unavailable' };
    }
    const checks = await readIndependentChecks(current.attempt, signal);
    if (!checks?.signature || !checks.licence || !checks.vulnerability) {
      return { status: 'unavailable' };
    }
    const result = { serverId, attemptId: current.attempt.attemptId,
      imageDigest: current.attempt.imageDigest, platform: current.attempt.platform,
      checks: { signature: checks.signature, licence: checks.licence,
        vulnerability: checks.vulnerability, malware: current.scanned.malware } };
    signal?.throwIfAborted();
    async function validateEvidence() {
      const verdict = await current.validate();
      return { verdict, malware: current.scanned.malware };
    }
    try {
      const written = await writeHostedAdmission(store, silo, result,
        undefined, current.scanned, validateEvidence);
      if (written.status === 'appended') return { status: 'appended' };
    } catch {
      // Keep the original result until its uncertain append is visible.
      entry.uncertainResult = result;
    }
    if (await savedResultMatches(store, silo, result)) {
      entry.uncertainResult = undefined;
      return { status: 'appended' };
    }
    return { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

async function recoverUncertainAttempt(store, silo, entry) {
  try {
    const matched = await savedResultMatches(store, silo, entry.uncertainResult);
    if (matched) {
      entry.uncertainResult = undefined;
      return { status: 'appended' };
    }
  } catch {
    // A read failure cannot establish whether the original append committed.
  }
  return { status: 'unavailable' };
}

// Share work by the saved attempt, including a write whose reply was lost.
export function runAndWriteHostedImageCheck(store, silo, serverId, attemptId, prepareImage,
  readSettings, readIndependentChecks, signal) {
  if (signal?.aborted) return Promise.resolve({ status: 'unavailable' });
  const attempts = attemptsFor(store);
  const key = JSON.stringify([silo, serverId, attemptId]);
  let entry = attempts.get(key);
  if (entry?.pending) return entry.promise;

  if (!entry) {
    entry = { pending: false, promise: undefined, uncertainResult: undefined };
    attempts.set(key, entry);
  }
  entry.pending = true;
  if (entry.uncertainResult) {
    entry.promise = recoverUncertainAttempt(store, silo, entry);
  } else {
    entry.promise = writeCurrentImageCheck(store, silo, serverId, attemptId,
      prepareImage, readSettings, readIndependentChecks, signal, entry);
  }
  async function finish() {
    try {
      return await entry.promise;
    } finally {
      entry.pending = false;
      if (!entry.uncertainResult) attempts.delete(key);
    }
  }
  return finish();
}
