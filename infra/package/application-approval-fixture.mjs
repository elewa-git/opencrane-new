import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutIdentity, writeCheckoutShim } from '../clamav/checkout-fixture.mjs';

// Replace only the authenticated GitHub boundary; run the real approval consumer.
export function applicationApprovalFixture(directory, image, options = {}) {
  const bin = join(directory, 'application-bin');
  mkdirSync(bin, { recursive: true });
  const { revision, branch } = checkoutIdentity;
  const run = { id: 43, status: 'completed', conclusion: 'success', event: 'push',
    path: '.github/workflows/application-package.yml', head_branch: branch, head_sha: revision,
    repository: { full_name: 'elewa-git/opencrane-new' },
    head_repository: { full_name: 'elewa-git/opencrane-new' }, ...options.run };
  const approval = { runId: 43, revision, imageDigest: image.split('@')[1],
    imageId: 'sha256:' + 'c'.repeat(64), scanSha256: 'd'.repeat(64), ...options.approval };
  const scanner = join(directory, 'bin', 'gh');
  if (options.scanner) copyFileSync(scanner, join(bin, 'scanner-gh'));
  const github = `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
function namesApplicationWorkflow(value) {
  return value.includes('application-package.yml');
}
const application = args.some(namesApplicationWorkflow) ||
  args[args.indexOf('--name') + 1] === 'application-approval' ||
  args[args.indexOf('--name') + 1] === 'application-image';
if (!application) {
  const child = cp.spawnSync(${JSON.stringify(join(bin, 'scanner-gh'))}, args, {stdio: 'inherit'});
  process.exit(child.status ?? 1);
}
if (args[0] === 'api') {
  if (!args.includes('--hostname=github.com')) process.exit(2);
  const filtered = args.some(function hasStatusFilter(argument) {
    return argument.includes('status=success');
  });
  const missing = ${JSON.stringify(Boolean(options.noJob))} ||
    (${JSON.stringify(Boolean(options.filteredEmpty))} && filtered);
  const runs = missing ? [] : [${JSON.stringify(run)}];
  process.stdout.write(JSON.stringify({ workflow_runs: runs }));
} else {
  if (!args.includes('https://github.com/elewa-git/opencrane-new')) process.exit(2);
  const destination = args[args.indexOf('--dir') + 1];
  fs.writeFileSync(destination + '/approval.json', ${JSON.stringify(JSON.stringify(approval))});
}
`;
  writeFileSync(join(bin, 'gh'), github, { mode: 0o700 });
  writeCheckoutShim(bin);
  return { bin, env: { ...process.env, ...options.environment, PATH: `${bin}:${process.env.PATH}` }, approval };
}
