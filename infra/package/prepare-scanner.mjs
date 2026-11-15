import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { fetchScannerApproval } from '../clamav/approval.mjs';

const root = resolve(import.meta.dirname, '../..');
const directory = process.argv[2];
const artifactDirectory = join(directory, 'scanner-approval');
await mkdir(artifactDirectory, { mode: 0o700 });
const approved = await fetchScannerApproval(artifactDirectory, true);
const commandOptions = { encoding: 'utf8', timeout: 120_000,
  stdio: ['ignore', 'pipe', 'pipe'] };
const inspection = execFileSync('docker', ['inspect', 'k3d-ocn-registry'], commandOptions);
const registry = JSON.parse(inspection)[0];
const address = registry.NetworkSettings.Networks['k3d-ocn'].IPAddress;
if (isIP(address) !== 4) throw new Error('Development registry address is absent');
execFileSync('python3', [join(root, 'infra/package/publish-image.py'),
  join(artifactDirectory, 'scanner.tar'), `http://${address}:5000`, approved.image], commandOptions);
const review = JSON.parse(await readFile(join(root, 'infra/package/reviewed-images.json'), 'utf8'));
review.images.scanner = approved.image;
review.scanner = { approvedSha: approved.approvedSha };
const secrets = {};
for (const name of review.requiredSecrets) {
  secrets[name] = `package-${name.toLowerCase()}`;
}
const values = { chartVersion: review.chartVersion, images: review.images, secrets,
  scanner: review.scanner, exposure: { ingress: false, loadBalancer: false, funnel: false } };
await writeFile(join(directory, 'package-values.json'), JSON.stringify(values), { mode: 0o600 });
process.stdout.write(`PASS scanner approval fetched from GitHub run ${approved.runId}\n`);
