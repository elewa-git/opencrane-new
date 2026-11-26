import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchApplicationApproval } from './application-approval.mjs';
import { fetchScannerApproval } from '../clamav/approval.mjs';

import { publishPackageImage } from './publish-package-image.mjs';

async function publishApproval(directory, name, fetchApproval) {
  const parent = join(directory, `${name}-approval`);
  await mkdir(parent, { mode: 0o700, recursive: true });
  // Keep earlier approval records. GitHub refuses to extract over an existing file.
  const destination = await mkdtemp(join(parent, 'attempt-'));
  const archive = `${name}.tar`;
  try {
    const approval = await fetchApproval(destination, true);
    publishPackageImage(join(destination, archive), approval.image);
    return { ...approval, destination };
  } finally {
    await rm(join(destination, archive), { force: true });
  }
}

export function publishApprovedApplication(directory) {
  return publishApproval(directory, 'application', fetchApplicationApproval);
}

export function publishApprovedScanner(directory) {
  return publishApproval(directory, 'scanner', fetchScannerApproval);
}
