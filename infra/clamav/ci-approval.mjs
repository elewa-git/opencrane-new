import { execFileSync } from 'node:child_process';
import { createLogger } from '@opencrane/observability';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readBoundedBytes } from './release.mjs';

const repository = 'elewa-git/opencrane-new';
const root = resolve(import.meta.dirname, '../..');
const refusal = 'CI approval refused';
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

function approvedRun(revision, branch, name) {
  const workflow = `.github/workflows/${name}-package.yml`;
  // GitHub can omit a successful run when the listing uses status=success.
  // Check each returned run's status and exact source below instead.
  const query = `repos/${repository}/actions/workflows/${name}-package.yml/runs` +
    `?head_sha=${revision}&branch=${encodeURIComponent(branch)}&per_page=20`;
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

// Read only successful GitHub output. Local records cannot establish its producer.
export async function fetchCiApproval(options) {
  const { name, destination, includeImage, validate } = options;
  const logger = createLogger(`${name}-approval`);
  const temporary = await mkdtemp(join(tmpdir(), `${name}-ci-`));
  const directory = destination ?? temporary;
  let stage = 'environment';
  try {
    // Refuse inherited enterprise routing before any credential leaves this process.
    for (const setting of enterpriseSettings) requireApproval(process.env[setting] === undefined);
    stage = 'checkout';
    const revision = run('git', ['rev-parse', 'HEAD']);
    const branch = run('git', ['branch', '--show-current']);
    requireApproval(/^[a-f0-9]{40}$/.test(revision) && branch.length > 0);
    stage = 'metadata';
    const job = approvedRun(revision, branch, name);
    stage = 'approval_download';
    download(job.id, `${name}-approval`, directory);
    stage = 'approval';
    const bytes = await readBoundedBytes(join(directory, 'approval.json'), 1024);
    const approval = JSON.parse(bytes.toString('utf8'));
    requireApproval(approval.runId === job.id && approval.revision === revision);
    stage = options.validationStage ?? 'approval';
    const result = await validate(approval, directory);
    stage = 'image_download';
    if (includeImage) download(job.id, `${name}-image`, directory);
    return result;
  } catch (error) {
    let reason = 'malformed';
    if (error.cause === 'outage' || error.cause === 'expired') reason = error.cause;
    const label = name[0].toUpperCase() + name.slice(1);
    const message = `${label} CI approval refused`;
    logger.error({ stage, reason }, message);
    // eslint-disable-next-line preserve-caught-error -- Keep credential-bearing diagnostics private.
    throw new Error(message, { cause: { stage, reason } });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
