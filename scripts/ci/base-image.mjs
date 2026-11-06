import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const digestPath = 'apps/computer/test/base-image-digest.txt';
const inputsPath = 'apps/computer/test/base-image-inputs.txt';
const imageName = 'ghcr.io/elewa-git/opencrane-ci-computer-base';
const buildInputs = [
  '.dockerignore',
  'apps/computer/apt.lock',
  'apps/computer/tool-user.c',
  'apps/computer/test/upload-base.Dockerfile',
  'spikes/s0-1b-proxy-gvisor/package.json',
  'spikes/s0-1b-proxy-gvisor/package-lock.json',
];
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

export function buildInputsHash() {
  const hash = createHash('sha256');
  for (const path of buildInputs) {
    // Include file names and separators so moving bytes between files changes the hash.
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export function baseImage(digest, recordedInputsHash) {
  const value = digest.trim();
  if (value === '') return '';
  if (!digestPattern.test(value)) {
    throw new Error(`${digestPath} must contain one full sha256 digest`);
  }
  const recordedHash = recordedInputsHash.trim();
  if (recordedHash === '') return '';
  if (!digestPattern.test(recordedHash)) {
    throw new Error(`${inputsPath} must contain one full sha256 hash`);
  }
  if (recordedHash !== buildInputsHash()) return '';
  return `${imageName}@${value}`;
}

if (process.argv[1]?.endsWith('/base-image.mjs')) {
  if (process.argv[2] === 'hash') {
    process.stdout.write(buildInputsHash());
  } else {
    const digest = readFileSync(digestPath, 'utf8');
    const recordedInputsHash = readFileSync(inputsPath, 'utf8');
    process.stdout.write(baseImage(digest, recordedInputsHash));
  }
}
