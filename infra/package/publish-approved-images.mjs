import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
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

export async function publishApprovedApplication(directory) {
  const destination = join(directory, 'application-approval');
  await mkdir(destination, { mode: 0o700, recursive: true });
  const approval = await fetchApplicationApproval(destination, true);
  publishImage(destination, 'application.tar', approval.image);
  return approval;
}

export async function publishApprovedScanner(directory) {
  const destination = join(directory, 'scanner-approval');
  await mkdir(destination, { mode: 0o700, recursive: true });
  const approval = await fetchScannerApproval(destination, true);
  publishImage(destination, 'scanner.tar', approval.image);
  return { ...approval, destination };
}
