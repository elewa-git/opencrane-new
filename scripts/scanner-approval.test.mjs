import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { scannerApprovalFixture } from '../infra/clamav/approval-fixture.mjs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';

vi.mock('node:child_process', mockProcesses);
function mockProcesses() {
  return { execFileSync: vi.fn() };
}
const revision = 'a'.repeat(40);
const imageDigest = `sha256:${'b'.repeat(64)}`;

function runRecord() {
  return { id: 42, status: 'completed', conclusion: 'success', event: 'push',
    path: '.github/workflows/scanner-package.yml', head_branch: 'work/pilot-15-s1',
    head_sha: revision, repository: { full_name: 'elewa-git/opencrane-new' },
    head_repository: { full_name: 'elewa-git/opencrane-new' } };
}

function setup(run = runRecord(), files = {}) {
  function execute(program, args) {
    if (program === 'git') {
      if (args.includes('HEAD')) return revision + '\n';
      return 'work/pilot-15-s1\n';
    }
    expect(program).toBe('gh');
    if (args[0] === 'api') return JSON.stringify({ workflow_runs: [run] });
    expect(args.slice(0, 3)).toEqual(['run', 'download', '42']);
    const directory = args[args.indexOf('--dir') + 1];
    for (const [name, bytes] of Object.entries(files)) {
      writeFileSync(join(directory, name), bytes);
    }
    return '';
  }
  vi.mocked(execFileSync).mockImplementation(execute);
}

async function loadApproval() {
  const module = await import('../infra/clamav/approval.mjs');
  return module.fetchScannerApproval();
}

for (const field of ['status', 'conclusion', 'event', 'path', 'head_branch', 'head_sha',
  'repository', 'head_repository']) {
  async function refuseUntrustedRun() {
    const run = runRecord();
    run[field] = 'untrusted';
    setup(run);
    await expect(loadApproval()).rejects.toThrow('Scanner CI approval refused');
  }
  test(`refuses a forged or wrong CI ${field}`, refuseUntrustedRun);
}

async function noLocalApproval() {
  setup();
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
