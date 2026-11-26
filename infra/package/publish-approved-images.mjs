import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fetchApplicationApproval } from './application-approval.mjs';
import { fetchScannerApproval } from '../clamav/approval.mjs';

const commandOptions = { encoding: 'utf8', timeout: 120_000,
  stdio: ['ignore', 'pipe', 'pipe'] };

function developmentRegistryAddress() {
  const inspection = execFileSync('docker', ['inspect', 'k3d-ocn-registry'], commandOptions);
  const registry = JSON.parse(inspection)[0];
  const address = registry.NetworkSettings.Networks['k3d-ocn'].IPAddress;
  if (isIP(address) !== 4) throw new Error('Development registry address is absent');
  return address;
}

function publishImage(source, filename, image) {
  const address = developmentRegistryAddress();
  const args = [join(import.meta.dirname, 'publish-image.py'),
    join(source, filename), `http://${address}:5000`, image];
  execFileSync('python3', args, commandOptions);
}

async function publishApproval(directory, name, fetchApproval) {
  const parent = join(directory, `${name}-approval`);
  await mkdir(parent, { mode: 0o700, recursive: true });
  // Keep earlier approval records. GitHub refuses to extract over an existing file.
  const destination = await mkdtemp(join(parent, 'attempt-'));
  const archive = `${name}.tar`;
  try {
    const approval = await fetchApproval(destination, true);
    publishImage(destination, archive, approval.image);
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
