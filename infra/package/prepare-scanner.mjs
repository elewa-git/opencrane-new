import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  publishApprovedApplication, publishApprovedScanner,
} from './publish-approved-images.mjs';

const root = resolve(import.meta.dirname, '../..');
const directory = process.argv[2];
const approved = await publishApprovedScanner(directory);
const application = await publishApprovedApplication(directory);
const review = JSON.parse(await readFile(join(root, 'infra/package/reviewed-images.json'), 'utf8'));
review.images.server = application.image;
review.images.web = application.image;
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
process.stdout.write(`PASS application approval fetched from GitHub run ${application.runId}\n`);
