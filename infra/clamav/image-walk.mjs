import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { scanImagePart } from './image-client.mjs';

const execute = promisify(execFile);
const walker = fileURLToPath(new URL('./image-walk.py', import.meta.url));
const unavailable = Object.freeze({ verdict: 'unavailable', reasonCode: 'image_scan_unavailable' });
const hex = /^[a-f0-9]{64}$/u;
const sha = /^sha256:[a-f0-9]{64}$/u;
const layerTypes = new Set(['application/vnd.oci.image.layer.v1.tar',
  'application/vnd.oci.image.layer.v1.tar+gzip']);
const privateFile = { mode: 0o600 };

function hash(bytes) {
  const hasher = createHash('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}
function requireImage(condition) {
  if (!condition) throw new Error('Image scan unavailable');
}
function imageIdentity(image) {
  requireImage(image && hex.test(image.imageDigest) &&
    ['linux/amd64', 'linux/arm64'].includes(image.platform) &&
    /^[\w-]{1,200}$/u.test(image.silo) && /^[\w-]{1,200}$/u.test(image.serverId) &&
    Number.isSafeInteger(image.attemptId) && image.attemptId > 0);
  requireImage(Buffer.isBuffer(image.manifest) && Buffer.isBuffer(image.config) &&
    image.manifest.length <= 1024 * 1024 && image.config.length <= 1024 * 1024 &&
    hash(image.manifest) === image.imageDigest);
  const manifest = JSON.parse(image.manifest.toString());
  const config = JSON.parse(image.config.toString());
  requireImage(manifest.schemaVersion === 2 &&
    manifest.mediaType === 'application/vnd.oci.image.manifest.v1+json' &&
    manifest.config.digest === `sha256:${hash(image.config)}` &&
    manifest.config.size === image.config.length &&
    `${config.os}/${config.architecture}` === image.platform);
  requireImage(Array.isArray(manifest.layers) && manifest.layers.length > 0 &&
    manifest.layers.length <= 64 && Array.isArray(config.rootfs.diff_ids) &&
    config.rootfs.diff_ids.length === manifest.layers.length &&
    Array.isArray(image.layers) && image.layers.length === manifest.layers.length);
  let total = 0;
  const layers = [];
  for (let index = 0; index < image.layers.length; index++) {
    const supplied = image.layers[index];
    const descriptor = manifest.layers[index];
    requireImage(Buffer.isBuffer(supplied.bytes) && supplied.bytes.length <= 32 * 1024 * 1024);
    total += supplied.bytes.length;
    requireImage(total <= 128 * 1024 * 1024 && layerTypes.has(descriptor.mediaType) &&
      supplied.mediaType === descriptor.mediaType && supplied.digest === descriptor.digest &&
      supplied.bytes.length === descriptor.size && sha.test(descriptor.digest) &&
      `sha256:${hash(supplied.bytes)}` === descriptor.digest &&
      supplied.diffId === config.rootfs.diff_ids[index] && sha.test(supplied.diffId));
    layers.push({ mediaType: descriptor.mediaType, diffId: supplied.diffId });
  }
  return layers;
}
function sameImage(current, original) {
  requireImage(current.imageDigest === original.imageDigest &&
    current.platform === original.platform && current.silo === original.silo &&
    current.serverId === original.serverId && current.attemptId === original.attemptId &&
    hash(current.manifest) === original.manifestHash &&
    hash(current.config) === original.configHash);
  requireImage(current.layers.length === original.layerHashes.length);
  for (let index = 0; index < current.layers.length; index++) {
    requireImage(hash(current.layers[index].bytes) === original.layerHashes[index]);
  }
}
function identitySnapshot(image) {
  return { imageDigest: image.imageDigest, platform: image.platform, silo: image.silo,
    serverId: image.serverId, attemptId: image.attemptId,
    manifestHash: hash(image.manifest), configHash: hash(image.config),
    layerHashes: image.layers.map(layer => hash(layer.bytes)) };
}
function scannerSnapshot(settings) {
  requireImage(settings && sha.test(settings.imageDigest) && sha.test(settings.manifestDigest));
  return JSON.stringify(settings);
}
function bindingFor(image) {
  return { silo: image.silo, serverId: image.serverId, attemptId: image.attemptId,
    platform: image.platform, targetImageDigest: image.imageDigest };
}
async function stage(directory, image, layers, signal) {
  await writeFile(join(directory, 'layers.json'), JSON.stringify(layers), privateFile);
  for (let index = 0; index < image.layers.length; index++) {
    signal.throwIfAborted();
    await writeFile(join(directory, `layer-${index}`), image.layers[index].bytes, privateFile);
  }
}
async function extract(directory, signal) {
  const args = [walker, directory];
  const options = { timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
    signal, env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } };
  const output = await execute('python3', args, options);
  const files = JSON.parse(output.stdout);
  requireImage(Array.isArray(files) && files.length > 0 && files.length <= 50_000);
  return files;
}

export async function scanHostedImage(image, settings, scanPart = scanImagePart, signal) {
  let directory;
  const controller = new AbortController();
  function cancel() {
    controller.abort();
  }
  const timer = setTimeout(cancel, 600_000);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    controller.signal.throwIfAborted();
    const layers = imageIdentity(image);
    const scannerBinding = scannerSnapshot(settings);
    const original = identitySnapshot(image);
    directory = await mkdtemp(join(tmpdir(), 'hosted-image-scan-'));
    await stage(directory, image, layers, controller.signal);
    const files = await extract(directory, controller.signal);
    const binding = bindingFor(image);
    const validations = [];
    let infected = false;
    for (const file of files) {
      controller.signal.throwIfAborted();
      requireImage(/^part-[0-9]+$/u.test(file.name) && hex.test(file.sha256) &&
        Number.isSafeInteger(file.byteCount) && file.byteCount <= 20 * 1024 * 1024);
      const bytes = await readFile(join(directory, file.name));
      requireImage(bytes.length === file.byteCount && hash(bytes) === file.sha256);
      const validate = await scanPart(settings, bytes, binding, controller.signal);
      controller.signal.throwIfAborted();
      const verdict = validate(bytes, binding, settings);
      requireImage(verdict === 'clean' || verdict === 'infected');
      if (verdict === 'infected') infected = true;
      validations.push({ validate, bytes });
    }
    async function validate(currentImage, currentSettings) {
      try {
        requireImage(!signal?.aborted);
        imageIdentity(currentImage);
        sameImage(currentImage, original);
        requireImage(scannerSnapshot(currentSettings) === scannerBinding);
        let currentVerdict = 'clean';
        for (const part of validations) {
          const verdict = part.validate(part.bytes, binding, currentSettings);
          requireImage(verdict === 'clean' || verdict === 'infected');
          if (verdict === 'infected') currentVerdict = 'infected';
        }
        return currentVerdict;
      } catch {
        throw new Error('Image scan unavailable');
      }
    }
    await validate(image, settings);
    return { verdict: infected ? 'infected' : 'clean', imageDigest: image.imageDigest,
      platform: image.platform, fileCount: files.length,
      layerDigests: image.layers.map(layer => layer.digest), validate };
  } catch {
    // Discard candidate paths, bytes and scanner diagnostics at the result boundary.
    return unavailable;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        // Keep private scratch paths out of errors returned to the caller.
        return unavailable;
      }
    }
  }
}
