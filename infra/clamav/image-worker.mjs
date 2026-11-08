import { readHostedAdmission, readHostedImageScanAttempt } from '@opencrane/models';
import { writeHostedAdmission } from '@opencrane/models/image-admission-writer';
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
  const settings = await readSettings();
  const scanned = await scanHostedImageAttempt(attempt, image, settings, undefined, signal);
  if (scanned.verdict === 'unavailable') return;

  async function validate() {
    signal?.throwIfAborted();
    const currentAttempt = await readHostedImageScanAttempt(store, silo, serverId);
    if (!currentAttempt) return;
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

async function savedResultMatches(store, silo, result) {
  const saved = await readHostedAdmission(store, silo, result.serverId);
  const expected = hostedImageCheckedSchema.safeParse(result);
  if (!expected.success) return false;
  if (!saved || saved.attemptId !== result.attemptId ||
      saved.imageDigest !== result.imageDigest || saved.platform !== result.platform) return false;
  return JSON.stringify(saved.checks) === JSON.stringify(expected.data.checks);
}

// A caller may supply only the three separate image checks. The scanner supplies malware.
export async function runAndWriteHostedImageCheck(store, silo, serverId, attemptId, prepareImage,
  readSettings, readIndependentChecks, signal) {
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
      return await current.validate() === 'clean';
    }
    try {
      const written = await writeHostedAdmission(store, silo, result,
        undefined, validateEvidence);
      if (written.status === 'appended') return { status: 'appended' };
    } catch {
      // A lost reply may follow a successful append. Read the original event identity.
    }
    if (await savedResultMatches(store, silo, result)) return { status: 'appended' };
    return { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}
