import { readFileSync } from 'node:fs';

const digestPath = 'apps/computer/test/base-image-digest.txt';
const imageName = 'ghcr.io/elewa-git/opencrane-ci-computer-base';

export function baseImage(digest) {
  const value = digest.trim();
  if (value === '') return '';
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${digestPath} must contain one full sha256 digest`);
  }
  return `${imageName}@${value}`;
}

if (process.argv[1]?.endsWith('/base-image.mjs')) {
  const digest = readFileSync(digestPath, 'utf8');
  process.stdout.write(baseImage(digest));
}
