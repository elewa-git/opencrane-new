import { readHostedImageScanAttempt } from '@opencrane/models';
import { scanHostedImageAttempt } from './image-walk.mjs';

const unavailable = Object.freeze({ verdict: 'unavailable', reasonCode: 'image_scan_unavailable' });

// Keep this result private. The other three image checks and the event writer are separate work.
export async function runHostedImageScan(store, silo, serverId, prepareImage,
  readSettings, signal) {
  try {
    signal?.throwIfAborted();
    // Read the saved attempt before fetching or unpacking any customer image bytes.
    const attempt = await readHostedImageScanAttempt(store, silo, serverId);
    if (!attempt) return unavailable;

    signal?.throwIfAborted();
    const image = await prepareImage(attempt, signal);
    const settings = await readSettings();
    const scanned = await scanHostedImageAttempt(attempt, image, settings, undefined, signal);
    if (scanned.verdict === 'unavailable') return unavailable;

    // Read the event history again after the slow scan. The walk checks every part's
    // current proof, image bytes and scanner settings when the result is used.
    signal?.throwIfAborted();
    const currentAttempt = await readHostedImageScanAttempt(store, silo, serverId);
    if (!currentAttempt) return unavailable;
    const currentSettings = await readSettings();
    signal?.throwIfAborted();
    const verdict = await scanned.validate(currentAttempt, image, currentSettings);
    signal?.throwIfAborted();
    if (verdict !== 'clean' && verdict !== 'infected') return unavailable;
    return { verdict };
  } catch {
    return unavailable;
  }
}
