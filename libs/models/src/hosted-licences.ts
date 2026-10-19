import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { currentHostedVerification, verifyHostedImage } from './hosted-verification.ts';

const execute = promisify(execFile);
const privateFile = { mode: 0o600 };
const cleanupOptions = { recursive: true, force: true };
const gatePath = fileURLToPath(new URL('./hosted-licences.py', import.meta.url));
type Options = { cosign: string; syft: string; osiPath: string; reviewPath: string };
type RegistryRead = Parameters<typeof verifyHostedImage>[2];

function digest(value: string | Uint8Array) {
  const hash = createHash('sha256');
  hash.update(value);
  return hash.digest('hex');
}

async function readReview(path: string) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function stageImage(directory: string, blobs: Map<string, Buffer>, imageDigest: string) {
  const blobDirectory = join(directory, 'blobs', 'sha256');
  const directoryOptions = { recursive: true };
  await mkdir(blobDirectory, directoryOptions);
  for (const [name, bytes] of blobs) {
    await writeFile(join(blobDirectory, name), bytes, privateFile);
  }
  const manifest = blobs.get(imageDigest)!;
  const index = { schemaVersion: 2, manifests: [{
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    digest: `sha256:${imageDigest}`, size: manifest.length,
  }] };
  await writeFile(join(directory, 'index.json'), JSON.stringify(index));
  await writeFile(join(directory, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}');
}

export async function inspectHostedLicences(request: unknown, trust: unknown,
  read: RegistryRead, options: Options) {
  const blobs = new Map<string, Buffer>();
  async function capture(repository: string, resource: string, signal: AbortSignal) {
    const received = await read(repository, resource, signal);
    const bytes = Buffer.from(received);
    // Retain the same copy the verifier reads; never fetch candidate bytes a second time.
    if (/^sha256:[a-f0-9]{64}$/u.test(resource)) {
      blobs.set(resource.slice(7), bytes);
    }
    return bytes;
  }
  const verification = await verifyHostedImage(request, trust, capture, options.cosign);
  if (verification.verdict !== 'pass') {
    return verification;
  }
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'hosted-licences-'));
    const imageDirectory = join(directory, 'image');
    await stageImage(imageDirectory, blobs, verification.evidence.imageDigest);
    const review = await readReview(options.reviewPath);
    if (!review) {
      return { verdict: 'fail', reasonCode: 'licence_refused' } as const;
    }
    const reviewPath = join(directory, 'review.json');
    await writeFile(reviewPath, review, privateFile);
    const scannerConfig = join(directory, 'syft.json');
    await writeFile(scannerConfig, '{}');
    const environment = { HOME: directory, TMPDIR: directory, PATH: '/usr/bin:/bin',
      SYFT_CHECK_FOR_APP_UPDATE: 'false', SYFT_PARALLELISM: '1' };
    const processOptions = { cwd: directory, env: environment,
      timeout: 60_000, maxBuffer: 16 * 1024 * 1024 };
    // Read notices without extracting or executing any candidate file before invoking Syft.
    const gateArguments = [gatePath, imageDirectory, reviewPath, options.osiPath];
    const preflight = await execute('python3', gateArguments, processOptions);
    if (preflight.stdout.trim() !== 'pass') {
      return { verdict: 'fail', reasonCode: 'licence_refused' } as const;
    }
    const scannerBytes = await readFile(options.syft);
    if (digest(scannerBytes) !==
        'd46a9a61a6ae3d367f0a03748c5e9c59253e586c4388ab26ddcacebc2efa0d92') {
      return { verdict: 'unavailable', reasonCode: 'scanner_unavailable' } as const;
    }
    const scannerArguments = ['scan', `oci-dir:${imageDirectory}`, '--scope', 'all-layers',
      '--config', scannerConfig, '-o', 'syft-json'];
    const scanned = await execute(options.syft, scannerArguments, processOptions);
    const sbomPath = join(directory, 'sbom.json');
    await writeFile(sbomPath, scanned.stdout, privateFile);
    const checkedArguments = [...gateArguments, sbomPath];
    const result = await execute('python3', checkedArguments, processOptions);
    if (result.stdout.trim() !== 'pass') {
      return { verdict: 'fail', reasonCode: 'licence_refused' } as const;
    }
    if (!currentHostedVerification(verification.evidence, request, trust)) {
      return { verdict: 'fail', reasonCode: 'signature_refused' } as const;
    }
    const evidence = { ...verification.evidence, sbomDigest: digest(scanned.stdout),
      reviewDigest: digest(review) };
    return { verdict: 'pass', evidence } as const;
  } catch {
    // Keep subprocess output and package data out of errors, logs and receipts.
    return { verdict: 'unavailable', reasonCode: 'scanner_unavailable' } as const;
  } finally {
    if (directory) {
      await rm(directory, cleanupOptions);
    }
  }
}
