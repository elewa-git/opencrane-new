import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readApprovedRelease, readBoundedBytes } from './release.mjs';

const repository = 'elewa-git/opencrane-new';
const workflow = '.github/workflows/scanner-package.yml';
const root = resolve(import.meta.dirname, '../..');
const refusal = 'Scanner CI approval refused';

function run(program, args) {
  const options = { cwd: root, encoding: 'utf8', timeout: 120_000,
    maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
  const output = execFileSync(program, args, options);
  return output.trim();
}

function requireApproval(condition) {
  if (!condition) throw new Error(refusal);
}

function approvedRun(revision, branch) {
  const query = `repos/${repository}/actions/workflows/scanner-package.yml/runs` +
    `?status=success&head_sha=${revision}&branch=${encodeURIComponent(branch)}&per_page=20`;
  const result = JSON.parse(run('gh', ['api', query]));
  for (const candidate of result.workflow_runs) {
    if (candidate.status !== 'completed' || candidate.conclusion !== 'success') continue;
    if (!['push', 'schedule', 'workflow_dispatch'].includes(candidate.event)) continue;
    if (candidate.path !== workflow || candidate.head_sha !== revision ||
        candidate.head_branch !== branch) continue;
    if (candidate.repository?.full_name !== repository ||
        candidate.head_repository?.full_name !== repository) continue;
    requireApproval(Number.isSafeInteger(candidate.id) && candidate.id > 0);
    return candidate;
  }
  throw new Error(refusal);
}

function download(runId, name, directory) {
  run('gh', ['run', 'download', String(runId), '--repo', repository,
    '--name', name, '--dir', directory]);
}

// Read approval only from GitHub's successful workflow output. Local records and
// environment variables cannot establish who produced an approval.
export async function fetchScannerApproval(destination, includeImage = false) {
  const temporary = await mkdtemp(join(tmpdir(), 'scanner-ci-'));
  const directory = destination ?? temporary;
  try {
    const revision = run('git', ['rev-parse', 'HEAD']);
    const branch = run('git', ['branch', '--show-current']);
    requireApproval(/^[a-f0-9]{40}$/.test(revision) && branch.length > 0);
    const job = approvedRun(revision, branch);
    download(job.id, 'scanner-approval', directory);
    const bytes = await readBoundedBytes(join(directory, 'approval.json'), 1024);
    const approval = JSON.parse(bytes.toString('utf8'));
    requireApproval(approval.runId === job.id && approval.revision === revision);
    requireApproval(/^sha256:[a-f0-9]{64}$/.test(approval.imageDigest));
    const image = `k3d-ocn-registry:5000/opencrane/scanner@${approval.imageDigest}`;
    const manifestPath = join(directory, 'signatures.json');
    const releasePath = join(directory, 'release.json');
    await readApprovedRelease({ image, manifestPath, releasePath,
      approvedSha: approval.approvedSha }, Date.now());
    if (includeImage) download(job.id, 'scanner-image', directory);
    return { image, approvedSha: approval.approvedSha, runId: job.id };
  } catch {
    // Discard CLI diagnostics, which can include local credential and directory details.
    throw new Error(refusal);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
