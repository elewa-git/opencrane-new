import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { checks, qualifications } from './collect.ts';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const containerSchema = z.object({
  Id: z.string().regex(/^[a-f0-9]{64}$/u), Image: digest, Created: z.iso.datetime(),
  RestartCount: z.literal(0), State: z.object({ Running: z.literal(true), StartedAt: z.iso.datetime() }),
  HostConfig: z.object({ ReadonlyRootfs: z.literal(true) }),
  Mounts: z.array(z.object({ Destination: z.string() })),
  Config: z.object({ Env: z.array(z.string()) }),
});
const imageSchema = z.object({
  Id: digest, Config: z.object({ Labels: z.record(z.string(), z.string()) }),
});
const bindingSchema = z.strictObject({
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/u), imageDigest: digest,
  environmentId: z.string().regex(/^[a-f0-9]{64}$/u), siloId: digest,
  installationId: digest, runId: z.uuid(), freshInstall: z.literal(true),
});
const receiptSchema = bindingSchema.extend({
  name: z.string(), challengeId: z.uuid(), observedAt: z.number().int(),
  result: z.literal('PASS'), complete: z.literal(true),
});
const freshSchema = z.strictObject({
  created: z.iso.datetime(), lastSequence: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
});
const freshProbe = `
import { connectNats } from '/app/libs/event-store/src/nats-connection.ts';
import { jetstreamManager } from '@nats-io/jetstream';
const connection = await connectNats();
try {
  const manager = await jetstreamManager(connection);
  const info = await manager.streams.info('EVENTS');
  const observation = {
    created: info.created, lastSequence: info.state.last_seq, eventCount: info.state.messages,
  };
  process.stdout.write(JSON.stringify(observation));
} finally {
  await connection.close();
}
`;
type Binding = z.infer<typeof bindingSchema>;
type Result = { result: 'FAIL'; reason: 'collection_failed' } | Binding & {
  result: 'PASS'; checks: Record<string, 'PASS'>; qualifications: Record<string, 'PASS'>;
  receiptDigests: string[];
};

function hash(value: string): string {
  const hasher = createHash('sha256');
  hasher.update(value);
  return `sha256:${hasher.digest('hex')}`;
}

function docker(args: string[], input = ''): unknown {
  const command = ['--host', 'unix:///var/run/docker.sock', ...args];
  const options = {
    encoding: 'utf8' as const, input, timeout: 120_000, killSignal: 'SIGKILL' as const,
    maxBuffer: 65_536, stdio: 'pipe' as const,
  };
  // Keep Docker errors and child output in memory; callers receive only a fixed refusal.
  const output = execFileSync('/usr/bin/docker', command, options);
  return JSON.parse(output) as unknown;
}

function exec(containerId: string, args: string[], input = ''): unknown {
  const settings = ['--workdir', '/app', '--env', 'NODE_OPTIONS=', '--env', 'NODE_PATH=',
    '--env', 'LD_PRELOAD='];
  return docker(['exec', ...settings, '-i', containerId, ...args], input);
}

function measure(containerId: string) {
  const containers = docker(['inspect', '--type', 'container', containerId]);
  const container = z.array(containerSchema).length(1).parse(containers)[0]!;
  if (container.Id !== containerId) {
    throw new Error('container_changed');
  }
  for (const mount of container.Mounts) {
    // Refuse overrides of the image's code, interpreter and installed libraries.
    if (!mount.Destination.startsWith('/run/') && !mount.Destination.startsWith('/var/')) {
      throw new Error('mutable_code');
    }
  }
  const images = docker(['image', 'inspect', container.Image]);
  const image = z.array(imageSchema).length(1).parse(images)[0]!;
  if (image.Id !== container.Image) {
    throw new Error('image_changed');
  }
  const host = z.string().min(1).max(200).parse(docker(['info', '--format', '{{json .ID}}']));
  const silos = container.Config.Env.filter(isSiloSetting);
  if (silos.length !== 1) {
    throw new Error('silo_missing');
  }
  const silo = z.string().min(1).max(200).parse(silos[0]!.slice(8));
  const siloId = hash(silo);
  const environmentId = hash(JSON.stringify([host, siloId])).slice(7);
  const installationId = hash(JSON.stringify([container.Id, container.State.StartedAt]));
  const sourceSha = image.Config.Labels['org.opencontainers.image.revision'];
  return { sourceSha, imageDigest: image.Id, environmentId, siloId, installationId,
    created: container.Created };
}

function isSiloSetting(value: string): boolean {
  return value.startsWith('SILO_ID=');
}

function assertSame(expected: object, actual: object): void {
  for (const [name, value] of Object.entries(expected)) {
    if (Reflect.get(actual, name) !== value) {
      throw new Error('deployment_changed');
    }
  }
}

function readEventState(containerId: string) {
  const args = ['/usr/local/bin/node', '--experimental-strip-types',
    '--input-type=module', '--eval', freshProbe];
  return freshSchema.parse(exec(containerId, args));
}

function assertFresh(containerId: string, containerCreated: string): string {
  const observation = readEventState(containerId);
  if (observation.lastSequence !== 0 || observation.eventCount !== 0) {
    throw new Error('installation_used');
  }
  const created = Date.parse(observation.created);
  const now = Date.now();
  // Require a newly created event stream, including no history hidden by a purge.
  const installationCreated = Date.parse(containerCreated);
  if (created < installationCreated || created > now || now - installationCreated > 300_000) {
    throw new Error('installation_not_fresh');
  }
  return observation.created;
}

function assertInstallation(
  containerId: string, before: ReturnType<typeof measure>, streamCreated: string,
): void {
  assertSame(before, measure(containerId));
  if (readEventState(containerId).created !== streamCreated) {
    throw new Error('event_store_replaced');
  }
}

function runCheck(containerId: string, binding: Binding, name: string): string {
  const challengeId = randomUUID();
  const request = { ...binding, name, challengeId };
  const input = JSON.stringify(request);
  const startedAt = Date.now();
  const args = ['/usr/local/bin/node', '--experimental-strip-types',
    '/app/scripts/private-memory-qualification/journey.mjs'];
  const receipt = receiptSchema.parse(exec(containerId, args, input));
  assertSame(request, receipt);
  if (receipt.observedAt < startedAt || receipt.observedAt > Date.now()) {
    throw new Error('stale_receipt');
  }
  return hash(JSON.stringify(receipt));
}

function deploymentTarget() {
  const path = '/etc/opencrane/private-memory-qualification.json';
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 1024) {
      throw new Error('unsafe_target_configuration');
    }
    const content = readFileSync(descriptor, 'utf8');
    const targetSchema = z.strictObject({
      containerId: z.string().regex(/^[a-f0-9]{64}$/u),
      siloId: z.string().min(1).max(200),
    });
    return targetSchema.parse(JSON.parse(content));
  } finally {
    closeSync(descriptor);
  }
}

// Read the permitted deployment from a root-owned file, never from the caller.
export function collectDeployment(...unexpectedArguments: unknown[]): Result {
  try {
    if (unexpectedArguments.length !== 0) {
      throw new Error('unexpected_argument');
    }
    const target = deploymentTarget();
    const containerId = target.containerId;
    const before = measure(containerId);
    if (before.siloId !== hash(target.siloId)) {
      throw new Error('wrong_silo');
    }
    const streamCreated = assertFresh(containerId, before.created);
    const installationId = hash(JSON.stringify([before.installationId, streamCreated]));
    const binding = bindingSchema.parse({
      sourceSha: before.sourceSha, imageDigest: before.imageDigest,
      environmentId: before.environmentId, siloId: before.siloId,
      installationId, runId: randomUUID(), freshInstall: true,
    });
    const results: Record<string, 'PASS'> = {};
    const complete: Record<string, 'PASS'> = {};
    const receiptDigests: string[] = [];
    for (const name of [...checks, ...qualifications]) {
      assertInstallation(containerId, before, streamCreated);
      receiptDigests.push(runCheck(containerId, binding, name));
      assertInstallation(containerId, before, streamCreated);
      if (checks.includes(name)) {
        results[name] = 'PASS';
      } else {
        complete[name] = 'PASS';
      }
    }
    return { ...binding, result: 'PASS', checks: results, qualifications: complete, receiptDigests };
  } catch {
    return { result: 'FAIL', reason: 'collection_failed' };
  }
}
