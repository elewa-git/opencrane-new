import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync,
  renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { collectDeployment, readDeploymentQualification }
  from '../../scripts/private-memory-qualification/deployment.ts';
import { requireStageBStack } from './stage-b-guard.ts';

const root = resolve(import.meta.dirname, '../..');
const targetPath = '/etc/opencrane/private-memory-qualification.json';
const resultPath = '/etc/opencrane/private-memory-qualification-result.json';
const targetSchema = z.strictObject({
  containerId: z.string().regex(/^[a-f0-9]{64}$/u), siloId: z.string().min(1).max(200),
});
const containerSchema = z.object({
  Id: z.string(), Image: z.string(), Config: z.object({
    Env: z.array(z.string()), Labels: z.record(z.string(), z.string()),
  }),
});
let attempted = false;

function readTarget(): string {
  for (const parent of ['/etc', '/etc/opencrane']) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error('unsafe_target');
    }
  }
  const descriptor = openSync(targetPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 1024) {
      throw new Error('unsafe_target');
    }
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function command(file: string, args: string[]): string {
  const options = { cwd: root, encoding: 'utf8' as const, stdio: 'pipe' as const,
    timeout: 30_000, maxBuffer: 65_536 };
  return execFileSync(file, args, options).trim();
}
function docker(args: string[]): unknown {
  const arguments_ = ['--host', 'unix:///var/run/docker.sock', ...args];
  return JSON.parse(command('/usr/bin/docker', arguments_)) as unknown;
}
async function checkLocalTarget(id: string | undefined, claimed: string) {
  const directory = await requireStageBStack(id, claimed, homedir(), root);
  const settings = await readFile(`${directory}/settings.env`, 'utf8');
  const lines = settings.split('\n');
  function siloSetting(line: string): boolean {
    return line.startsWith('SILO_ID=');
  }
  const silos = lines.filter(siloSetting);
  const savedTarget = readTarget();
  const target = targetSchema.parse(JSON.parse(savedTarget));
  if (silos.length !== 1 || silos[0] !== `SILO_ID=${target.siloId}`) {
    throw new Error('wrong_silo');
  }
  const observation = docker(['inspect', '--type', 'container', target.containerId]);
  const container = z.array(containerSchema).length(1).parse(observation)[0]!;
  const labels = container.Config.Labels;
  const containerSilos = container.Config.Env.filter(siloSetting);
  if (containerSilos.length !== 1 || containerSilos[0] !== silos[0]) {
    throw new Error('wrong_container_silo');
  }
  if (container.Id !== target.containerId ||
      labels['com.docker.compose.project'] !== `opencrane-dev-${id}` ||
      labels['com.docker.compose.project.working_dir'] !== `${root}/infra/dev-stack`) {
    throw new Error('wrong_container');
  }
  const images = docker(['image', 'inspect', container.Image]);
  const imageSchema = z.object({ Id: z.string(), Config: z.object({
    Labels: z.record(z.string(), z.string()),
  }) });
  const image = z.array(imageSchema).length(1).parse(images)[0]!;
  const source = command('/usr/bin/git', ['rev-parse', 'HEAD']);
  if (image.Id !== container.Image ||
      image.Config.Labels['org.opencontainers.image.revision'] !== source) {
    throw new Error('wrong_source');
  }
  await requireStageBStack(id, claimed, homedir(), root);
  if (readTarget() !== savedTarget) {
    throw new Error('target_changed');
  }
  return { target, savedTarget };
}

function withdrawResult(): void {
  const temporary = `${resultPath}.${randomUUID()}`;
  const failure = { result: 'FAIL', reason: 'collection_failed' };
  writeFileSync(temporary, JSON.stringify(failure), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, resultPath);
}

// Leave owner setup to the runner in the image; it may populate the installation itself.
export async function prepareMemoryQualification(signal?: AbortSignal): Promise<void> {
  let cancelled = signal?.aborted ?? false;
  let collectionStarted = false;
  let savedTarget: string | undefined;
  function cancel(): void {
    cancelled = true;
  }
  signal?.addEventListener('abort', cancel);
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(name, cancel);
  }
  try {
    if (attempted || cancelled) {
      throw new Error('already_attempted');
    }
    attempted = true;
    const id = process.env['DEV_STACK_ID'];
    const claimed = process.env['MEMORY_CLAIMED_ID'] ?? '';
    const checked = await checkLocalTarget(id, claimed);
    savedTarget = checked.savedTarget;
    if (cancelled) {
      throw new Error('cancelled');
    }
    collectionStarted = true;
    // Wait for the collector and every supervisor to finish cleanup before cancelling.
    const result = await collectDeployment();
    if (cancelled || result.result !== 'PASS') {
      throw new Error('collection_failed');
    }
    await requireStageBStack(id, claimed, homedir(), root);
    if (readTarget() !== savedTarget) {
      throw new Error('target_changed');
    }
    const qualification = await readDeploymentQualification(checked.target.siloId);
    if (cancelled || qualification.runId !== result.runId) {
      throw new Error('collection_changed');
    }
    qualification.confirm();
  } catch {
    if (collectionStarted && savedTarget !== undefined) {
      try {
        if (readTarget() === savedTarget) {
          withdrawResult();
        }
      } catch {
        // Refuse continuation even when the protected result cannot be withdrawn.
      }
    }
    throw new Error('memory_qualification_refused');
  } finally {
    signal?.removeEventListener('abort', cancel);
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.off(name, cancel);
    }
  }
}
