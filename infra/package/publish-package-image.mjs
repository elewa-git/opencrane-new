import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';
import { join } from 'node:path';

const commandOptions = { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] };

export function publishPackageImage(archive, image) {
  const inspection = execFileSync('docker', ['inspect', 'k3d-ocn-registry'], commandOptions);
  const registry = JSON.parse(inspection)[0];
  const address = registry.NetworkSettings.Networks['k3d-ocn'].IPAddress;
  if (isIP(address) !== 4) {
    throw new Error('Development registry address is absent');
  }
  const publisher = join(import.meta.dirname, 'publish-image.py');
  const args = [publisher, archive, `http://${address}:5000`, image];
  execFileSync('python3', args, commandOptions);
}
