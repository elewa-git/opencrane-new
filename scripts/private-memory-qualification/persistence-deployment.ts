import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { isAbsolute, dirname, join } from 'node:path';
import { z } from 'zod';
import { computerInstallation, containerIdentity } from './bridge-proof.ts';
import { assertFresh, assertInstallation, deploymentTarget, hash, measure,
  runCheck } from './deployment.ts';
import { readCurrentInventory, type InventoryContext } from './joined-inventory.ts';
import { startNativePersistenceClient } from './native-persistence-client.ts';
import { runPersistenceAttempt } from './persistence-attempt.ts';
import { hostDumpLocations, probeHost } from './host-probe.ts';
import { checkLocalTarget } from '../../infra/dev-stack/memory-qualification.ts';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const mountSchema = z.object({ Destination: z.string(), Source: z.string(),
  RW: z.boolean(), Type: z.string() });
const storageSchema = z.object({
  Id: z.string().regex(/^[a-f0-9]{64}$/u), Image: digest,
  Mounts: z.array(mountSchema), LogPath: z.string(),
  GraphDriver: z.object({ Data: z.object({ UpperDir: z.string() }) }),
});
type Location = { category: 'pvc' | 'rollout' | 'cache' | 'outbox' | 'logs' | 'dumps';
  path: string };
type AttemptResult = Awaited<ReturnType<typeof runPersistenceAttempt>>;
const incomplete = { result: 'NOT RUN', complete: false, category: 'inventory' } as const;

function computerStorage(containerId: string, expectedImage: string): Location[] {
  const command = ['--host', 'unix:///var/run/docker.sock', 'inspect', '--type',
    'container', containerId];
  const options = { timeout: 10_000, maxBuffer: 65_536, stdio: 'pipe' as const };
  const output = execFileSync('/usr/bin/docker', command, options);
  const parsed: unknown = JSON.parse(output.toString('utf8'));
  const container = z.array(storageSchema).length(1).parse(parsed)[0]!;
  if (container.Id !== containerId || container.Image !== expectedImage) {
    throw new Error('computer_changed');
  }
  const home = container.Mounts.filter(function isHome(mount): boolean {
    return mount.Destination === '/home/agent' && mount.RW;
  });
  const cache = container.Mounts.filter(function isCache(mount): boolean {
    return mount.Destination === '/home/codex' && mount.RW;
  });
  if (home.length !== 1 || cache.length !== 1 ||
      (home[0]!.Type !== 'bind' && home[0]!.Type !== 'volume')) {
    throw new Error('storage_missing');
  }
  const homePath = home[0]!.Source;
  const cachePath = cache[0]!.Source;
  const upperPath = container.GraphDriver.Data.UpperDir;
  const logPath = container.LogPath;
  for (const path of [homePath, cachePath, upperPath, logPath]) {
    if (!isAbsolute(path)) {
      throw new Error('storage_missing');
    }
  }
  const locations: Location[] = [
    { category: 'pvc', path: homePath },
    { category: 'rollout', path: upperPath },
    { category: 'cache', path: cachePath },
    { category: 'outbox', path: join(homePath, 'codex') },
    { category: 'logs', path: dirname(logPath) },
  ];
  for (const path of hostDumpLocations()) {
    locations.push({ category: 'dumps', path });
  }
  const covered = new Set(locations.map(function locationPath(location): string {
    return location.path;
  }));
  for (const mount of container.Mounts) {
    if (!mount.RW || mount.Source === '' || mount.Type === 'tmpfs') {
      continue;
    }
    if (!isAbsolute(mount.Source) || covered.has(mount.Source)) {
      continue;
    }
    locations.push({ category: 'pvc', path: mount.Source });
    covered.add(mount.Source);
  }
  return locations;
}

function releaseCanaryHelper(containerId: string): void {
  const source = "require('node:fs').writeFileSync(" +
    "'/run/opencrane-memory-qualification.lock/persistence-release', '')";
  const command = ['--host', 'unix:///var/run/docker.sock', 'exec', '--workdir', '/app',
    '--env', 'NODE_OPTIONS=', containerId, '/usr/local/bin/node', '--eval', source];
  const options = { timeout: 10_000, maxBuffer: 4096, stdio: 'pipe' as const };
  execFileSync('/usr/bin/docker', command, options);
}

async function observedAttempt(signal?: AbortSignal): Promise<AttemptResult> {
  if (signal?.aborted) {
    return incomplete;
  }
  const id = process.env['DEV_STACK_ID'];
  const claimed = process.env['MEMORY_CLAIMED_ID'] ?? '';
  const checked = await checkLocalTarget(id, claimed);
  const target = checked.target;
  if (!target.computerContainerId || !probeHost()) {
    return incomplete;
  }
  const serverBefore = measure(target.containerId);
  if (serverBefore.siloId !== hash(target.siloId) ||
      !/^[a-f0-9]{40}$/u.test(serverBefore.sourceSha ?? '')) {
    return incomplete;
  }
  const streamCreated = await assertFresh(target.containerId, serverBefore.created);
  const serverInstallationId = hash(JSON.stringify([serverBefore.installationId, streamCreated]));
  const computerBefore = containerIdentity(target.computerContainerId);
  const computerInstallationId = computerInstallation(computerBefore);
  const challengeId = randomUUID();
  const context: InventoryContext = {
    serverInstallationId, computerInstallationId,
    serverImageDigest: serverBefore.imageDigest,
    computerImageDigest: computerBefore.Image,
    challengeId, generationId: computerInstallationId, helperIds: [challengeId],
  };
  const locations = computerStorage(target.computerContainerId, computerBefore.Image);
  const canary = Buffer.from(randomBytes(32).toString('hex'));
  const binding = {
    sourceSha: serverBefore.sourceSha!, imageDigest: serverBefore.imageDigest,
    environmentId: serverBefore.environmentId, siloId: serverBefore.siloId,
    installationId: serverInstallationId, runId: randomUUID(), freshInstall: true as const,
  };
  let helper: Promise<Awaited<ReturnType<typeof runCheck>> | undefined> | undefined;
  try {
    await assertInstallation(target.containerId, serverBefore, streamCreated);
    if (JSON.stringify(target) !== JSON.stringify(deploymentTarget())) {
      return incomplete;
    }
    helper = runCheck(target.containerId, binding, 'persistence', challengeId)
      .catch(function helperUnavailable(): undefined { return undefined; });
    const driver = {
      context, locations, canary, signal,
      async currentInstallations() {
        await assertInstallation(target.containerId, serverBefore, streamCreated);
        if (JSON.stringify(target) !== JSON.stringify(deploymentTarget())) {
          throw new Error('target_changed');
        }
        const currentComputer = containerIdentity(target.computerContainerId!);
        return { serverInstallationId, computerInstallationId:
          computerInstallation(currentComputer), serverImageDigest: serverBefore.imageDigest,
          computerImageDigest: currentComputer.Image,
          generationId: computerInstallation(currentComputer) };
      },
      readInventory() {
        const containers = { serverId: target.containerId,
          computerId: target.computerContainerId! };
        return readCurrentInventory(context, containers);
      },
      async startNative() {
        const current = await checkLocalTarget(id, claimed);
        if (JSON.stringify(current.target) !== JSON.stringify(target)) {
          throw new Error('target_changed');
        }
        await assertInstallation(target.containerId, serverBefore, streamCreated);
        const computer = containerIdentity(target.computerContainerId!);
        if (computerInstallation(computer) !== computerInstallationId ||
            computer.Image !== computerBefore.Image) {
          throw new Error('computer_changed');
        }
        return startNativePersistenceClient(target.computerContainerId!, challengeId);
      },
    };
    const result = await runPersistenceAttempt(driver);
    try {
      releaseCanaryHelper(target.containerId);
    } catch {
      if (result.result !== 'FAIL') {
        return incomplete;
      }
      return result;
    }
    const helperResult = await helper;
    if (!helperResult || helperResult.result !== 'NOT RUN') {
      if (result.result !== 'FAIL') {
        return incomplete;
      }
    }
    return result;
  } finally {
    canary.fill(0);
    if (helper) {
      try {
        releaseCanaryHelper(target.containerId);
        await helper;
      } catch {
        // Keep the fixed refusal; the supervisor still owns its deadline.
      }
    }
  }
}

export async function runDeploymentPersistenceAttempt(signal?: AbortSignal):
  Promise<AttemptResult> {
  try {
    return await observedAttempt(signal);
  } catch {
    return incomplete;
  }
}
