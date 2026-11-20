import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { applicationApprovalFixture } from './application-approval-fixture.mjs';
import { scannerApprovalFixture } from '../clamav/approval-fixture.mjs';

const image = 'k3d-ocn-registry:5000/opencrane/package@sha256:' + 'a'.repeat(64);

function check(options = {}, replacements = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'application-approval-'));
  try {
    const fixture = applicationApprovalFixture(directory, image, options);
    const values = { images: { server: image, web: image, ...replacements },
      secrets: { runtime: 'runtime-settings' },
      exposure: { ingress: false, loadBalancer: false, funnel: false } };
    const review = { images: { ...values.images }, packageImage: fixture.approval };
    writeFileSync(join(directory, 'values.json'), JSON.stringify(values));
    writeFileSync(join(directory, 'review.json'), JSON.stringify(review));
    return spawnSync('node', ['infra/package/preflight.mjs', join(directory, 'values.json'),
      join(directory, 'review.json')], { env: fixture.env, encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function acceptsCiOutput() {
  const result = check();
  assert.equal(result.status, 0, result.stderr);
}
test('application preflight accepts successful exact-source CI output', acceptsCiOutput);

function acceptsUnfilteredSuccessfulRun() {
  const result = check({ filteredEmpty: true });
  assert.equal(result.status, 0, result.stderr);
}
test('application preflight accepts a successful exact-source run omitted by GitHub status filtering',
  acceptsUnfilteredSuccessfulRun);

function refusesBuilderApproval() {
  const result = check({ noJob: true });
  assert.notEqual(result.status, 0, 'Builder-written matching pins and proof cannot approve an image');
  assert.match(result.stderr, /Application CI approval refused/u);
}
test('application preflight refuses a builder-written approval without CI', refusesBuilderApproval);

for (const role of ['server', 'web']) {
  function refusesRoleReplacement() {
    const replaced = image.replace('a'.repeat(64), 'b'.repeat(64));
    const result = check({}, { [role]: replaced });
    assert.notEqual(result.status, 0, `Replacing only ${role} must refuse`);
    assert.match(result.stderr, new RegExp(`Image is absent from the reviewed list: ${role}`, 'u'));
  }
  test(`application preflight refuses replacement of only the ${role} pin`, refusesRoleReplacement);
}

const refusals = [
  ['enterprise routing', { environment: { GH_HOST: 'enterprise.invalid' } }],
  ['different source', { approval: { revision: 'b'.repeat(40) } }],
  ['different run', { approval: { runId: 99 } }],
  ['mutable digest', { approval: { imageDigest: 'latest' } }],
  ['missing configuration digest', { approval: { imageId: undefined } }],
  ['null configuration digest', { approval: { imageId: null } }],
  ['mutable configuration digest', { approval: { imageId: 'latest' } }],
  ['short configuration digest', { approval: { imageId: 'sha256:' + 'c'.repeat(63) } }],
  ['non-hex configuration digest', { approval: { imageId: 'sha256:' + 'g'.repeat(64) } }],
  ['missing scan', { approval: { scanSha256: null } }],
  ['fork', { run: { head_repository: { full_name: 'fork/opencrane-new' } } }],
  ['pull request', { run: { event: 'pull_request' } }],
  ['failed run', { run: { conclusion: 'failure' } }],
  ['wrong workflow', { run: { path: '.github/workflows/ci.yml' } }],
  ['wrong branch', { run: { head_branch: 'other' } }],
  ['wrong source run', { run: { head_sha: 'b'.repeat(40) } }],
];
for (const [name, options] of refusals) {
  function refusesInvalidOutput() {
    const result = check(options);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /Application CI approval refused/u);
  }
  test(`application preflight refuses ${name}`, refusesInvalidOutput);
}

function preparationUsesCiOnly() {
  for (const noJob of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'application-preparation-'));
    try {
      const fixture = applicationApprovalFixture(directory, image, { noJob });
      const program = `import { fetchApplicationApproval } from './infra/package/application-approval.mjs';
const approved = await fetchApplicationApproval(process.argv[1], true);
process.stdout.write(JSON.stringify(approved));`;
      const result = spawnSync('node', ['--input-type=module', '-e', program, directory],
        { env: fixture.env, encoding: 'utf8' });
      if (noJob) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Application CI approval refused/u);
      } else {
        assert.equal(result.status, 0, result.stderr);
        const approved = JSON.parse(result.stdout);
        assert.equal(approved.image, image);
        assert.equal(approved.runId, 43);
        assert.equal(approved.revision, 'a'.repeat(40));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
test('preparation fetches only successful exact-source application output', preparationUsesCiOnly);

function refusesForkDispatch() {
  const workflow = parse(readFileSync('.github/workflows/application-package.yml', 'utf8'));
  assert.ok('workflow_dispatch' in workflow.on);
  const job = workflow.jobs.package;
  assert.equal(job.if, "github.repository == 'elewa-git/opencrane-new'");
  const upstream = { github: { repository: 'elewa-git/opencrane-new' } };
  const fork = { github: { repository: 'fork/opencrane-new' } };
  assert.equal(runInNewContext(job.if, upstream), true);
  assert.equal(runInNewContext(job.if, fork), false,
    'A manual fork dispatch must skip the complete job, including Docker and artifact uploads');
}
test('application workflow refuses fork dispatch before running its job', refusesForkDispatch);

const producerRefusals = [
  ['local invocation', { GITHUB_ACTIONS: '' }],
  ['fork invocation', { GITHUB_REPOSITORY: 'fork/opencrane-new' }],
  ['mismatched checkout', { GITHUB_SHA: 'b'.repeat(40) }],
];
for (const [name, environment] of producerRefusals) {
  function refusesProducerBeforeDocker() {
    const directory = mkdtempSync(join(tmpdir(), 'application-producer-'));
    try {
      const fixture = applicationApprovalFixture(directory, image);
      const marker = join(directory, 'docker-called');
      const docker = `#!/bin/sh\ntouch '${marker}'\nexit 1\n`;
      writeFileSync(join(fixture.bin, 'docker'), docker, { mode: 0o700 });
      const output = join(directory, 'application');
      const env = { ...fixture.env, GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'elewa-git/opencrane-new', GITHUB_SHA: 'a'.repeat(40),
        ...environment };
      const result = spawnSync('bash', ['infra/package/approve-application.sh', output],
        { env, encoding: 'utf8' });
      assert.notEqual(result.status, 0, `${name} must refuse`);
      assert.equal(existsSync(marker), false, 'Refuse before any Docker command');
      assert.equal(existsSync(output), false, 'Refuse before creating publication output');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  test(`application producer refuses ${name} before Docker and output`, refusesProducerBeforeDocker);
}

function fixedPolicyHasNoSetting() {
  const review = JSON.parse(readFileSync('infra/package/reviewed-images.json', 'utf8'));
  assert.equal('applicationApproval' in review, false,
    'The fixed workflow policy must not advertise an unused setting');
}
test('reviewed images do not advertise a configurable approval workflow', fixedPolicyHasNoSetting);

async function fixturesShareCheckout() {
  const { checkoutIdentity } = await import('../clamav/checkout-fixture.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'approval-checkout-'));
  try {
    const review = { images: { scanner: image } };
    const scannerBin = join(directory, 'bin');
    const scanner = await scannerApprovalFixture(scannerBin, review);
    const application = applicationApprovalFixture(directory, image, { scanner: true });
    assert.equal(scanner.run.head_sha, checkoutIdentity.revision);
    assert.equal(scanner.run.head_branch, checkoutIdentity.branch);
    assert.equal(application.approval.revision, checkoutIdentity.revision);
    for (const bin of [scannerBin, application.bin]) {
      const revision = spawnSync(join(bin, 'git'), ['rev-parse', 'HEAD'], { encoding: 'utf8' });
      const branch = spawnSync(join(bin, 'git'), ['branch', '--show-current'], { encoding: 'utf8' });
      assert.equal(revision.status, 0);
      assert.equal(branch.status, 0);
      assert.equal(revision.stdout, checkoutIdentity.revision);
      assert.equal(branch.stdout, checkoutIdentity.branch);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
test('application and scanner fixtures use the shared checkout identity and shim', fixturesShareCheckout);
