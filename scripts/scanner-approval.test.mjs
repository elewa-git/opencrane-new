import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { scannerApprovalFixture } from '../infra/clamav/approval-fixture.mjs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('node:child_process', mockProcesses);
vi.mock('@opencrane/observability', mockLogging);
const logLines = [];
async function mockLogging(importOriginal) {
  const actual = await importOriginal();
  function write(line) {
    logLines.push(line);
  }
  function logger(name) {
    const options = { level: 'error', destination: { write } };
    return actual.createLogger(name, options);
  }
  return { ...actual, createLogger: vi.fn(logger) };
}
function clearTestState() {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  logLines.length = 0;
}
afterEach(clearTestState);
function mockProcesses() {
  return { execFileSync: vi.fn() };
}
const revision = 'a'.repeat(40);
const imageDigest = `sha256:${'b'.repeat(64)}`;

async function approvalFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'scanner-approval-fixture-'));
  const image = `k3d-ocn-registry:5000/opencrane/scanner@${imageDigest}`;
  const fixture = await scannerApprovalFixture(directory, { images: { scanner: image } });
  return { directory, image, ...fixture };
}

function setup(run, files, checkout = {}, candidates = [run], secondPage = []) {
  function execute(program, args) {
    if (program === 'git') {
      if (args.includes('HEAD')) return (checkout.revision ?? revision) + '\n';
      return (checkout.branch ?? 'work/pilot-15-s1') + '\n';
    }
    expect(program).toBe('gh');
    if (args[0] === 'api') {
      const query = new URL(args[2], 'https://api.github.com');
      const runs = query.searchParams.get('page') === '2' ? secondPage : candidates;
      return JSON.stringify({ workflow_runs: runs });
    }
    expect(args.slice(0, 3)).toEqual(['run', 'download', String(run.id)]);
    const directory = args[args.indexOf('--dir') + 1];
    for (const [name, bytes] of Object.entries(files)) {
      writeFileSync(join(directory, name), bytes);
    }
    return '';
  }
  vi.mocked(execFileSync).mockImplementation(execute);
}

async function loadApproval(includeImage = false) {
  const module = await import('../infra/clamav/approval.mjs');
  return module.fetchScannerApproval(undefined, includeImage);
}

async function readNewestMainApproval() {
  const fixture = await approvalFixture();
  try {
    const { fetchLatestScannerApproval } = await import('../infra/clamav/approval.mjs');
    const main = { ...fixture.run, head_branch: 'main', head_sha: 'c'.repeat(40) };
    const foreign = { ...main, id: 43, head_repository: { full_name: 'elsewhere/opencrane' } };
    const failed = { ...main, id: 44, conclusion: 'failure' };
    const candidates = [foreign, failed, fixture.run, main];
    setup(main, fixture.files, {}, candidates);
    await expect(fetchLatestScannerApproval(fixture.directory)).rejects.toThrow(
      'Scanner CI approval refused',
    );
    fixture.approval.revision = main.head_sha;
    fixture.files['approval.json'] = JSON.stringify(fixture.approval);
    setup(main, fixture.files, {}, candidates);
    const result = await fetchLatestScannerApproval(fixture.directory);
    expect(result).toMatchObject({ image: fixture.image, runId: main.id });
    const calls = vi.mocked(execFileSync).mock.calls;
    for (const [program] of calls) {
      expect(program).toBe('gh');
    }
    expect(calls[0][1][2]).toContain('branch=main');
    expect(calls.at(-1)[1]).toContain('scanner-image');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
}
test('daily refresh selects the newest successful upstream run and checks its exact source',
  readNewestMainApproval);

async function pagedMainApproval() {
  const fixture = await approvalFixture();
  try {
    const { fetchLatestScannerApproval } = await import('../infra/clamav/approval.mjs');
    const main = { ...fixture.run, head_branch: 'main' };
    const recent = [];
    for (let index = 0; index < 20; index++) {
      const conclusion = ['failure', 'cancelled', null][index % 3];
      const status = conclusion === null ? 'queued' : 'completed';
      recent.push({ ...main, id: main.id + index + 1, conclusion, status });
    }
    setup(main, fixture.files, {}, recent, [main]);
    const result = await fetchLatestScannerApproval(fixture.directory);
    expect(result).toMatchObject({ image: fixture.image, runId: main.id });
    expect(result.manifestPath).toBe(join(fixture.directory, 'signatures.json'));
    expect(result.releasePath).toBe(join(fixture.directory, 'release.json'));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
}
test('finds a successful upstream run after twenty unsuccessful runs', pagedMainApproval);

async function refusesMatchingMalformedMainRevision() {
  const fixture = await approvalFixture();
  try {
    const { fetchLatestScannerApproval } = await import('../infra/clamav/approval.mjs');
    const main = { ...fixture.run, head_branch: 'main', head_sha: 'z'.repeat(40) };
    fixture.approval.revision = main.head_sha;
    fixture.files['approval.json'] = JSON.stringify(fixture.approval);
    setup(main, fixture.files);
    await expect(fetchLatestScannerApproval(fixture.directory)).rejects.toThrow('CI approval refused');
    expect(execFileSync).toHaveBeenCalledTimes(1);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
}
test('refuses a malformed main SHA even when the approval has the same SHA',
  refusesMatchingMalformedMainRevision);

async function refusesAnotherCheckoutRevision() {
  const fixture = await approvalFixture();
  try {
    const checkout = { revision: 'c'.repeat(40) };
    setup(fixture.run, fixture.files, checkout);
    await expect(loadApproval()).rejects.toThrow('CI approval refused');
    expect(execFileSync).toHaveBeenCalledTimes(3);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
}
test('refuses an approval for another valid SHA in the same branch',
  refusesAnotherCheckoutRevision);

async function noTemporaryEvidencePaths() {
  const fixture = await approvalFixture();
  try {
    setup(fixture.run, fixture.files);
    const result = await loadApproval();
    expect(result).toMatchObject({ runId: fixture.run.id, image: fixture.image });
    expect(result).not.toHaveProperty('manifestPath');
    expect(result).not.toHaveProperty('releasePath');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
}
test('leaves temporary evidence paths private when the caller owns no directory',
  noTemporaryEvidencePaths);

async function latestWithoutCallerDirectoryKeepsPathsPrivate() {
  const fixture = await approvalFixture();
  try {
    const { fetchLatestScannerApproval } = await import('../infra/clamav/approval.mjs');
    const main = { ...fixture.run, head_branch: 'main' };
    setup(main, fixture.files);
    const result = await fetchLatestScannerApproval();
    expect(result).toMatchObject({ image: fixture.image, runId: main.id });
    expect(result).not.toHaveProperty('manifestPath');
    expect(result).not.toHaveProperty('releasePath');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
}
test('also keeps upstream temporary paths private when the caller owns no directory',
  latestWithoutCallerDirectoryKeepsPathsPrivate);

for (const field of ['status', 'conclusion', 'event', 'path', 'head_branch', 'head_sha',
  'repository', 'head_repository']) {
  async function refuseUntrustedRun() {
    const fixture = await approvalFixture();
    try {
      fixture.run[field] = 'untrusted';
      setup(fixture.run, fixture.files);
      await expect(loadApproval()).rejects.toThrow('Scanner CI approval refused');
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
  test(`refuses a forged or wrong CI ${field}`, refuseUntrustedRun);
}

async function noLocalApproval() {
  vi.mocked(execFileSync).mockImplementation(noJob);
  function noJob(program, args) {
    if (program === 'git') return args.includes('HEAD') ? revision : 'work/pilot-15-s1';
    return '{"workflow_runs":[]}';
  }
  await expect(loadApproval()).rejects.toThrow('Scanner CI approval refused');
}
test('a builder cannot approve without a successful GitHub job', noLocalApproval);

async function realJobPasses() {
  const directory = await mkdtemp(join(tmpdir(), 'scanner-approval-fixture-'));
  try {
    const image = `k3d-ocn-registry:5000/opencrane/scanner@${imageDigest}`;
    const fixture = await scannerApprovalFixture(directory, { images: { scanner: image } });
    setup(fixture.run, fixture.files);
    const approval = await loadApproval();
    expect(approval.image).toBe(image);
    expect(approval.approvedSha).toBe(fixture.approval.approvedSha);
    expect(approval.runId).toBe(42);
    const forged = JSON.parse(fixture.files['approval.json']);
    forged.approvedSha = 'f'.repeat(64);
    fixture.files['approval.json'] = JSON.stringify(forged);
    const release = JSON.parse(fixture.files['release.json']);
    release.manifestDigest = `sha256:${forged.approvedSha}`;
    fixture.files['release.json'] = JSON.stringify(release);
    setup(fixture.run, fixture.files);
    await expect(loadApproval()).rejects.toThrow('Scanner CI approval refused');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('only the job output with its exact checked bytes can approve the scanner', realJobPasses);

for (const field of ['runId', 'revision', 'imageDigest']) {
  async function mismatchedArtifactRefuses() {
    const directory = await mkdtemp(join(tmpdir(), 'scanner-artifact-fixture-'));
    try {
      const image = `k3d-ocn-registry:5000/opencrane/scanner@${imageDigest}`;
      const fixture = await scannerApprovalFixture(directory, { images: { scanner: image } });
      fixture.approval[field] = 'wrong';
      fixture.files['approval.json'] = JSON.stringify(fixture.approval);
      setup(fixture.run, fixture.files);
      await expect(loadApproval()).rejects.toThrow('Scanner CI approval refused');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  test(`CI artifact must bind its ${field}`, mismatchedArtifactRefuses);
}

async function staleArtifactRefuses() {
  const directory = await mkdtemp(join(tmpdir(), 'scanner-expiry-fixture-'));
  try {
    const image = `k3d-ocn-registry:5000/opencrane/scanner@${imageDigest}`;
    const fixture = await scannerApprovalFixture(directory, { images: { scanner: image } });
    setup(fixture.run, fixture.files);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 86400000);
    await expect(loadApproval()).rejects.toThrow('Scanner CI approval refused');
  } finally {
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  }
}
test('even authentic job outputs refuse after the checked databases expire', staleArtifactRefuses);

const guardCases = [
  'safe run id', 'integer run id', 'checkout revision', 'non-empty branch', 'image digest syntax',
  'approval byte limit', 'release image binding',
];
function changeGuardInput(fixture, guard) {
  const checkout = {};
  if (guard === 'safe run id') {
    fixture.run.id = 0;
    fixture.approval.runId = 0;
  }
  if (guard === 'integer run id') {
    fixture.run.id = Number.MAX_SAFE_INTEGER + 1;
    fixture.approval.runId = fixture.run.id;
  }
  if (guard === 'checkout revision') {
    checkout.revision = 'z'.repeat(40);
    fixture.run.head_sha = checkout.revision;
    fixture.approval.revision = checkout.revision;
  }
  if (guard === 'non-empty branch') {
    checkout.branch = '';
    fixture.run.head_branch = '';
  }
  const release = JSON.parse(fixture.files['release.json']);
  if (guard === 'image digest syntax') {
    fixture.approval.imageDigest = 'sha256:' + 'g'.repeat(64);
    release.imageDigest = fixture.approval.imageDigest;
  }
  if (guard === 'release image binding') release.imageDigest = 'sha256:' + 'c'.repeat(64);
  fixture.files['release.json'] = JSON.stringify(release);
  fixture.files['approval.json'] = JSON.stringify(fixture.approval);
  if (guard === 'approval byte limit') {
    fixture.files['approval.json'] = fixture.files['approval.json'].padEnd(1025, ' ');
  }
  return checkout;
}
for (const guard of guardCases) {
  async function isolatedGuardRefuses() {
    const fixture = await approvalFixture();
    try {
      const checkout = changeGuardInput(fixture, guard);
      setup(fixture.run, fixture.files, checkout);
      await expect(loadApproval(true)).rejects.toThrow('Scanner CI approval refused');
      const downloads = vi.mocked(execFileSync).mock.calls;
      for (const [, args] of downloads) expect(args).not.toContain('scanner-image');
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
  test(`isolates ${guard} before downloading publishable image bytes`, isolatedGuardRefuses);
}
async function pinnedGithubCalls() {
  const fixture = await approvalFixture();
  try {
    setup(fixture.run, fixture.files);
    await loadApproval(true);
    for (const [program, args, options] of vi.mocked(execFileSync).mock.calls) {
      if (program !== 'gh') continue;
      if (args[0] === 'api') expect(args).toContain('--hostname=github.com');
      else expect(args[args.indexOf('--repo') + 1]).toBe('https://github.com/elewa-git/opencrane-new');
      expect(options.env.GH_HOST).toBeUndefined();
      expect(options.env.GH_ENTERPRISE_TOKEN).toBeUndefined();
      expect(options.env.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
}
test('pins metadata and both artifact downloads to github.com', pinnedGithubCalls);

for (const failure of ['outage', 'expired', 'malformed']) {
  async function safeFailureClassification() {
    const fixture = await approvalFixture();
    const canary = 'synthetic-credential-canary-DO-NOT-LOG';
    try {
      setup(fixture.run, fixture.files);
      if (failure === 'outage') {
        function unavailable() {
          const error = new Error(canary);
          error.stderr = canary;
          error.stdout = canary;
          throw error;
        }
        vi.mocked(execFileSync).mockImplementationOnce(unavailable);
      }
      if (failure === 'expired') {
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 86400000);
      }
      if (failure === 'malformed') fixture.files['approval.json'] = '{' + canary;
      const result = loadApproval();
      await expect(result).rejects.toThrow(/^Scanner CI approval refused$/);
      const output = logLines.join('');
      expect(output).not.toContain(canary);
      expect(logLines).toHaveLength(1);
      const record = JSON.parse(logLines[0]);
      expect(record.reason).toBe(failure);
      let expectedStage = 'approval';
      if (failure === 'outage') expectedStage = 'checkout';
      if (failure === 'expired') expectedStage = 'release';
      expect(record.stage).toBe(expectedStage);
      await expect(result).rejects.toMatchObject({ cause: { stage: expectedStage, reason: failure } });
      expect(record.name).toBe('scanner-approval');
    } finally {
      vi.useRealTimers();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
  test(`logs only safe stage and ${failure} reason`, safeFailureClassification);
}

for (const name of ['GH_HOST', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
  async function enterpriseEnvironmentRefuses() {
    vi.stubEnv(name, 'synthetic-enterprise-canary');
    await expect(loadApproval()).rejects.toThrow(/^Scanner CI approval refused$/);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(logLines.join('')).not.toContain('synthetic-enterprise-canary');
  }
  test(`refuses inherited ${name} before running any CLI`, enterpriseEnvironmentRefuses);
}
