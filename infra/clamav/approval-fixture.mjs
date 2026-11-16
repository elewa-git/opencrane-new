import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toolImage } from './refresh.mjs';
import { checkoutIdentity, writeCheckoutShim } from './checkout-fixture.mjs';

// Simulate only GitHub's authenticated boundary; consumers still validate all files.
export async function scannerApprovalFixture(bin, review) {
  await mkdir(bin, { recursive: true });
  const { revision, branch } = checkoutIdentity;
  const updatedAt = new Date().toISOString();
  const databases = [];
  const checks = [];
  for (const name of ['main', 'daily', 'bytecode']) {
    const file = `${name}.cvd`;
    databases.push({ file, sha256: 'd'.repeat(64), version: 1, builtAt: updatedAt });
    checks.push({ file, version: 1, result: 'up-to-date' });
  }
  const manifest = { formatVersion: 1, toolImage, databaseUpdatedAt: updatedAt,
    updaterEvidence: { tool: 'FreshClam', exitCode: 0, databases: checks }, databases };
  const manifestBytes = JSON.stringify(manifest);
  const hash = createHash('sha256');
  hash.update(manifestBytes);
  const approvedSha = hash.digest('hex');
  const imageDigest = review.images.scanner.split('@')[1];
  review.images.scanner = `k3d-ocn-registry:5000/opencrane/scanner@${imageDigest}`;
  const run = { id: 42, status: 'completed', conclusion: 'success', event: 'push',
    path: '.github/workflows/scanner-package.yml', head_branch: branch, head_sha: revision,
    repository: { full_name: 'elewa-git/opencrane-new' },
    head_repository: { full_name: 'elewa-git/opencrane-new' } };
  const approval = { runId: run.id, revision, imageDigest, approvedSha };
  const release = { formatVersion: 1, imageDigest, manifestDigest: `sha256:${approvedSha}`,
    databaseUpdatedAt: updatedAt, inspectedAt: updatedAt };
  const files = { 'approval.json': JSON.stringify(approval), 'signatures.json': manifestBytes,
    'release.json': JSON.stringify(release) };
  const github = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'api') process.stdout.write(${JSON.stringify(JSON.stringify({ workflow_runs: [run] }))});
else {
  const directory = args[args.indexOf('--dir') + 1];
  for (const [name, bytes] of Object.entries(${JSON.stringify(files)})) {
    fs.writeFileSync(directory + '/' + name, bytes);
  }
}
`;
  await writeFile(join(bin, 'gh'), github, { mode: 0o700 });
  writeCheckoutShim(bin);
  review.scanner = { approvedSha };
  return { run, files, approval };
}
