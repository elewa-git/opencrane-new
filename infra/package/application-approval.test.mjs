import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applicationApprovalFixture } from './application-approval-fixture.mjs';

const image = 'k3d-ocn-registry:5000/opencrane/package@sha256:' + 'a'.repeat(64);

function check(options = {}, replacement = image) {
  const directory = mkdtempSync(join(tmpdir(), 'application-approval-'));
  try {
    const fixture = applicationApprovalFixture(directory, image, options);
    const values = { images: { server: replacement, web: replacement },
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

function refusesBuilderApproval() {
  const result = check({ noJob: true });
  assert.notEqual(result.status, 0, 'Builder-written matching pins and proof cannot approve an image');
  assert.match(result.stderr, /Application CI approval refused/u);
}
test('application preflight refuses a builder-written approval without CI', refusesBuilderApproval);

function refusesReplacement() {
  const replaced = image.replace('a'.repeat(64), 'b'.repeat(64));
  const result = check({}, replaced);
  assert.notEqual(result.status, 0, 'A builder cannot replace both the values and reviewed image');
  assert.match(result.stderr, /Image is absent from the reviewed list: server/u);
}
test('application preflight refuses matching locally replaced image pins', refusesReplacement);

const refusals = [
  ['enterprise routing', { environment: { GH_HOST: 'enterprise.invalid' } }],
  ['different source', { approval: { revision: 'b'.repeat(40) } }],
  ['different run', { approval: { runId: 99 } }],
  ['mutable digest', { approval: { imageDigest: 'latest' } }],
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
