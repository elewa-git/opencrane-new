import { join } from 'node:path';
import { readApprovedRelease } from './release.mjs';
import { fetchCiApproval } from './ci-approval.mjs';

async function validateScanner(approval, directory) {
  const image = `k3d-ocn-registry:5000/opencrane/scanner@${approval.imageDigest}`;
  const manifestPath = join(directory, 'signatures.json');
  const releasePath = join(directory, 'release.json');
  const releaseOptions = { image, manifestPath, releasePath, approvedSha: approval.approvedSha };
  const manifest = await readApprovedRelease(releaseOptions, Date.now());
  return { ...releaseOptions, runId: approval.runId, databaseUpdatedAt: manifest.databaseUpdatedAt };
}

export async function fetchScannerApproval(destination, includeImage = false) {
  const approvalOptions = { name: 'scanner', destination, includeImage, validate: validateScanner,
    validationStage: 'release' };
  const approval = await fetchCiApproval(approvalOptions);
  if (destination !== undefined) {
    return approval;
  }
  const { image, approvedSha, runId, databaseUpdatedAt } = approval;
  return { image, approvedSha, runId, databaseUpdatedAt };
}

export async function fetchLatestScannerApproval(destination) {
  const options = { name: 'scanner', destination, includeImage: true, validate: validateScanner,
    validationStage: 'release', upstream: true };
  return fetchCiApproval(options);
}
