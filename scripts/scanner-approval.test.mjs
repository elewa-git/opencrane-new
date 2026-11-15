import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';

vi.mock('node:child_process', mockProcesses);
function mockProcesses() {
  return { execFileSync: vi.fn() };
}
const revision = 'a'.repeat(40);
const imageDigest = `sha256:${'b'.repeat(64)}`;
const approvedSha = 'c'.repeat(64);

function runRecord() {
  return { id: 42, status: 'completed', conclusion: 'success', event: 'push',
    path: '.github/workflows/scanner-package.yml', head_branch: 'work/pilot-15-s1',
    head_sha: revision, repository: { full_name: 'elewa-git/opencrane-new' },
    head_repository: { full_name: 'elewa-git/opencrane-new' } };
}

function setup(run = runRecord()) {
  function execute(program, args) {
    if (program === 'git') {
      if (args.includes('HEAD')) return revision + '\n';
      return 'work/pilot-15-s1\n';
    }
    expect(program).toBe('gh');
    if (args[0] === 'api') return JSON.stringify({ workflow_runs: [run] });
    expect(args.slice(0, 3)).toEqual(['run', 'download', '42']);
    const directory = args[args.indexOf('--dir') + 1];
    execFileSync.approvalDirectory = directory;
    return '';
  }
  vi.mocked(execFileSync).mockImplementation(execute);
}

async function loadApproval() {
  const module = await import('../infra/clamav/approval.mjs');
  return module.fetchScannerApproval();
}

for (const field of ['conclusion', 'event', 'path', 'head_branch', 'head_sha',
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
