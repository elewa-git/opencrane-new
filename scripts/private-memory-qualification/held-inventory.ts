import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { runInContainer } from './container-process.ts';
import {
  joinInventory, readCurrentInventory, type InventoryCode, type InventoryContext,
} from './joined-inventory.ts';

type Containers = { serverId: string; computerId: string };

export class InventoryRefusal extends Error {
  readonly group: InventoryCode;

  constructor(group: InventoryCode) {
    super('private_process_missing');
    this.group = group;
  }
}

function control(containerId: string,
  operation: 'stage' | 'release' | 'releaseNative' | 'nativeReady',
  context: InventoryContext): unknown {
  const probePath = operation === 'releaseNative' || operation === 'nativeReady' ?
    '/scripts/private-memory-qualification/live-inventory-probe.ts' :
    '/app/scripts/private-memory-qualification/live-inventory-probe.ts';
  const args = ['--host', 'unix:///var/run/docker.sock', 'exec', '--workdir', '/app',
    '--env', 'NODE_OPTIONS=', '--env', 'NODE_PATH=', '--env', 'LD_PRELOAD=',
    containerId, '/usr/local/bin/node', '--experimental-strip-types', probePath,
    operation, context.challengeId];
  if (operation !== 'releaseNative' && operation !== 'nativeReady') {
    args.push(context.serverImageDigest, context.serverInstallationId);
  }
  const options = { timeout: 10_000, maxBuffer: 4096, stdio: 'pipe' as const };
  const output = execFileSync('/usr/bin/docker', args, options);
  return JSON.parse(output.toString('utf8')) as unknown;
}

async function waitForStage(containerId: string, expected: 'ready' | 'workDone',
  context: InventoryContext): Promise<void> {
  const deadline = Date.now() + 110_000;
  while (Date.now() < deadline) {
    if (control(containerId, 'stage', context) === expected) {
      return;
    }
    await delay(50);
  }
  throw new InventoryRefusal('canaryHelper');
}

async function waitForNative(containerId: string, context: InventoryContext): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (control(containerId, 'nativeReady', context) === true) {
      return;
    }
    await delay(50);
  }
  throw new InventoryRefusal('nativeWrapper');
}

function requireInventory(context: InventoryContext, first: unknown, final: unknown): void {
  const joined = joinInventory(context, first, final);
  if (!joined.ok) {
    throw new InventoryRefusal(joined.group);
  }
}

function ignoreFailure(): void {}

function collectionFailed(): never {
  throw new Error('collection_failed');
}

// Hold the native pair and canary until both reads and the work between them finish.
export async function collectHeldInventory<Receipt>(context: InventoryContext,
  containers: Containers, runWork: (signal: AbortSignal) => Promise<Receipt>,
  verifyBinding: () => Promise<void>):
  Promise<Receipt> {
  const boundContainers = { ...containers };
  const cancellation = new AbortController();
  const nativeArgs = ['/usr/local/bin/node', '--experimental-strip-types',
    '/scripts/private-memory-qualification/native-hold.ts'];
  const nativeRequest = { challengeId: context.challengeId,
    imageDigest: context.computerImageDigest,
    installationId: context.computerInstallationId };
  const nativeTask = runInContainer(boundContainers.computerId, nativeArgs,
    JSON.stringify(nativeRequest), cancellation.signal);
  nativeTask.catch(ignoreFailure);
  function startWork(): Promise<Receipt> {
    return runWork(cancellation.signal);
  }
  const workTask = Promise.resolve().then(startWork);
  workTask.catch(ignoreFailure);
  try {
    await waitForStage(boundContainers.serverId, 'ready', context);
    await waitForNative(boundContainers.computerId, context);
    const first = readCurrentInventory(context, boundContainers);
    requireInventory(context, first, first);
    await verifyBinding();
    if (control(boundContainers.serverId, 'release', context) !== true) {
      throw new InventoryRefusal('canaryHelper');
    }
    await waitForStage(boundContainers.serverId, 'workDone', context);
    const final = readCurrentInventory(context, boundContainers);
    requireInventory(context, first, final);
    await verifyBinding();
    if (control(boundContainers.serverId, 'release', context) !== true) {
      throw new InventoryRefusal('canaryHelper');
    }
    const receipt = await workTask;
    if (control(boundContainers.computerId, 'releaseNative', context) !== true) {
      throw new InventoryRefusal('nativeWrapper');
    }
    const nativeResult = await nativeTask;
    if (nativeResult === null || typeof nativeResult !== 'object' ||
        Object.keys(nativeResult).length !== 5 ||
        !('result' in nativeResult) || nativeResult.result !== 'PARTIAL' ||
        !('complete' in nativeResult) || nativeResult.complete !== false ||
        !('challengeId' in nativeResult) ||
        nativeResult.challengeId !== context.challengeId ||
        !('imageDigest' in nativeResult) ||
        nativeResult.imageDigest !== context.computerImageDigest ||
        !('installationId' in nativeResult) ||
        nativeResult.installationId !== context.computerInstallationId) {
      throw new InventoryRefusal('nativeWrapper');
    }
    return receipt;
  } catch (error) {
    if (error instanceof InventoryRefusal) {
      throw error;
    }
    // Replace Docker and proc errors before they can expose private process paths.
    collectionFailed();
  } finally {
    cancellation.abort();
    await Promise.allSettled([nativeTask, workTask]);
  }
}
