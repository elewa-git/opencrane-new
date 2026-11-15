import { execFileSync } from 'node:child_process';
import { createLogger } from '@opencrane/observability';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readApprovedRelease, readBoundedBytes } from './release.mjs';

const repository = 'elewa-git/opencrane-new';
const workflow = '.github/workflows/scanner-package.yml';
const root = resolve(import.meta.dirname, '../..');
const refusal = 'Scanner CI approval refused';
const logger = createLogger('scanner-approval');
const enterpriseSettings = ['GH_HOST', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

function run(program, args) {
  const env = { ...process.env };
  for (const name of enterpriseSettings) delete env[name];
  const options = { cwd: root, env, encoding: 'utf8', timeout: 120_000,
    maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    const output = execFileSync(program, args, options);
    return output.trim();
  } catch {
    // Retain the failure category without retaining credential-bearing CLI diagnostics.
    throw new Error(refusal, { cause: 'outage' });
  }
}

function requireApproval(condition) {
  if (!condition) throw new Error(refusal);
}

function approvedRun(revision, branch) {
  const query = `repos/${repository}/actions/workflows/scanner-package.yml/runs` +
    `?status=success&head_sha=${revision}&branch=${encodeURIComponent(branch)}&per_page=20`;
  const result = JSON.parse(run('gh', ['api', '--hostname=github.com', query]));
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
  run('gh', ['run', 'download', String(runId), '--repo', `https://github.com/${repository}`,
    '--name', name, '--dir', directory]);
}

// Read approval only from GitHub's successful workflow output. Local records and
// environment variables cannot establish who produced an approval.
export async function fetchScannerApproval(destination, includeImage = false) {
  const temporary = await mkdtemp(join(tmpdir(), 'scanner-ci-'));
  const directory = destination ?? temporary;
  let stage = 'environment';
  try {
    // Refuse inherited enterprise routing before any credential can leave this process.
    for (const name of enterpriseSettings) requireApproval(process.env[name] === undefined);
    stage = 'checkout';
    const revision = run('git', ['rev-parse', 'HEAD']);
    const branch = run('git', ['branch', '--show-current']);
    requireApproval(/^[a-f0-9]{40}$/.test(revision) && branch.length > 0);
    stage = 'metadata';
    const job = approvedRun(revision, branch);
    stage = 'approval_download';
    download(job.id, 'scanner-approval', directory);
    stage = 'approval';
    const bytes = await readBoundedBytes(join(directory, 'approval.json'), 1024);
    const approval = JSON.parse(bytes.toString('utf8'));
    requireApproval(approval.runId === job.id && approval.revision === revision);
    const image = `k3d-ocn-registry:5000/opencrane/scanner@${approval.imageDigest}`;
    const manifestPath = join(directory, 'signatures.json');
    const releasePath = join(directory, 'release.json');
    stage = 'release';
    await readApprovedRelease({ image, manifestPath, releasePath,
      approvedSha: approval.approvedSha }, Date.now());
    stage = 'image_download';
    if (includeImage) download(job.id, 'scanner-image', directory);
    return { image, approvedSha: approval.approvedSha, runId: job.id };
  } catch (error) {
    let reason = 'malformed';
    if (error.cause === 'outage' || error.cause === 'expired') reason = error.cause;
    logger.error({ stage, reason }, refusal);
    // eslint-disable-next-line preserve-caught-error -- Keep credential-bearing diagnostics private.
    throw new Error(refusal, { cause: { stage, reason } });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
