import { readHostedAdmission, readHostedImageScanAttempt } from '@opencrane/models';
import { claimHostedImageScan, writeHostedAdmission }
  from '@opencrane/models/image-admission-writer';
import { hostedImageCheckedSchema } from '@opencrane/events';
import { scanHostedImageAttempt } from './image-walk.mjs';

const unavailable = Object.freeze({ verdict: 'unavailable', reasonCode: 'image_scan_unavailable' });

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
  readSettings, readIndependentChecks, signal) {
  try {
    const saved = await readHostedAdmission(store, silo, serverId);
    if (!saved || saved.attemptId !== attemptId) return { status: 'unavailable' };
    signal?.throwIfAborted();
    if (saved.checks) return { status: 'appended' };
    const claim = { serverId, attemptId, imageDigest: saved.imageDigest,
      platform: saved.platform };
    const ownership = await claimHostedImageScan(store, silo, claim);
    signal?.throwIfAborted();
    if (ownership.status === 'completed') return { status: 'appended' };
    if (ownership.status !== 'claimed') {
      // Read a completed result after losing the claim. Never start a second scan.
      const current = await readHostedAdmission(store, silo, serverId);
      if (current && current.attemptId === attemptId &&
          current.imageDigest === saved.imageDigest &&
          current.platform === saved.platform && current.checks) {
        return { status: 'appended' };
      }
      return { status: 'unavailable' };
    }
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
      // Read the original event once; a later delivery can read it again after a lost reply.
    }
    if (await savedResultMatches(store, silo, result)) {
      return { status: 'appended' };
    }
    return { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

export function runAndWriteHostedImageCheck(store, silo, serverId, attemptId, prepareImage,
  readSettings, readIndependentChecks, signal) {
  if (signal?.aborted) return Promise.resolve({ status: 'unavailable' });
  return writeCurrentImageCheck(store, silo, serverId, attemptId,
    prepareImage, readSettings, readIndependentChecks, signal);
}
