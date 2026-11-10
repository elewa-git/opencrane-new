import { joinInventory, type InventoryContext, type InventorySnapshot,
  type InventoryCode } from './joined-inventory.ts';
import { persistenceScan } from './persistence.ts';

const toolClasses = [
  'shell', 'file', 'browser', 'codeHost', 'externalMcp', 'skills', 'plugins', 'spawn',
] as const;
type ToolClass = typeof toolClasses[number];
type Category = 'pvc' | 'rollout' | 'cache' | 'outbox' | 'logs' | 'dumps';
type Location = { category: Category; path: string };
type Installation = Pick<InventoryContext, 'serverInstallationId' | 'computerInstallationId' |
  'serverImageDigest' | 'computerImageDigest' | 'generationId'>;
type NativeTurn = {
  assertHeld(): void | Promise<void>;
  attemptTool(tool: ToolClass, canary: Buffer): Promise<'blocked' | 'wrote' | 'unknown' | 'not_run'>;
  stop(): Promise<void>;
};
export type PersistenceDriver = {
  context: InventoryContext;
  locations: readonly Location[];
  canary: Buffer;
  signal?: AbortSignal | undefined;
  currentInstallations(): Installation | Promise<Installation>;
  readInventory(): InventorySnapshot;
  startNative(): Promise<NativeTurn>;
};
type FailureEvidence = { group: InventoryCode } |
  { category: Category | 'inventory' } | { tool: ToolClass };
type Outcome = { result: 'PARTIAL'; complete: false } |
  ({ result: 'FAIL'; complete: false; additionalFailures?: FailureEvidence[] } &
    FailureEvidence) |
  { result: 'NOT RUN'; complete: false; category: Category | 'inventory' } |
  { result: 'NOT RUN'; complete: false; tool: ToolClass };

async function currentInstallation(driver: PersistenceDriver): Promise<boolean> {
  const current = await driver.currentInstallations();
  return current.serverInstallationId === driver.context.serverInstallationId &&
    current.computerInstallationId === driver.context.computerInstallationId &&
    current.serverImageDigest === driver.context.serverImageDigest &&
    current.computerImageDigest === driver.context.computerImageDigest &&
    current.generationId === driver.context.generationId;
}

async function checkedInventory(driver: PersistenceDriver,
  first?: InventorySnapshot): Promise<{ snapshot: InventorySnapshot } | Outcome> {
  if (!await currentInstallation(driver)) {
    return { result: 'NOT RUN', complete: false, category: 'inventory' };
  }
  const snapshot = driver.readInventory();
  if (!await currentInstallation(driver)) {
    return { result: 'NOT RUN', complete: false, category: 'inventory' };
  }
  const joined = joinInventory(driver.context, first ?? snapshot, snapshot);
  if (!joined.ok) {
    return { result: 'FAIL', complete: false, group: joined.group };
  }
  return { snapshot };
}

function isOutcome(value: { snapshot: InventorySnapshot } | Outcome): value is Outcome {
  return 'result' in value;
}

function scanOutcome(result: ReturnType<ReturnType<typeof persistenceScan>['scan']>):
  Outcome | undefined {
  if (result.result === 'PARTIAL') {
    return undefined;
  }
  const category = result.category ?? 'inventory';
  if (result.result === 'FAIL') {
    return { result: 'FAIL', complete: false, category };
  }
  return { result: 'NOT RUN', complete: false, category };
}

function failureEvidence(outcome: Outcome & { result: 'FAIL' }): FailureEvidence {
  if ('tool' in outcome) {
    return { tool: outcome.tool };
  }
  if ('group' in outcome) {
    return { group: outcome.group };
  }
  return { category: outcome.category };
}

function retainKnownFailure(previous: Outcome | undefined, next: Outcome): Outcome {
  if (previous?.result === 'FAIL') {
    if (next.result === 'FAIL') {
      const additionalFailures = [...(previous.additionalFailures ?? []),
        failureEvidence(next)];
      return { ...previous, additionalFailures };
    }
    return previous;
  }
  return next;
}

async function callTool(
  native: NativeTurn, tool: ToolClass, canary: Buffer, signal?: AbortSignal,
): Promise<Awaited<ReturnType<NativeTurn['attemptTool']>> | undefined> {
  if (!signal) {
    return native.attemptTool(tool, canary);
  }
  if (signal.aborted) {
    return undefined;
  }
  let abort: (() => void) | undefined;
  const cancelled = new Promise<undefined>(function waitForAbort(resolve): void {
    abort = function cancelledCall(): void {
      resolve(undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const pending = native.attemptTool(tool, canary);
    return await Promise.race([pending, cancelled]);
  } finally {
    if (abort) {
      signal.removeEventListener('abort', abort);
    }
  }
}

// Keep the native pair and helper alive through both process reads and the live storage scan.
// Start the pinned turn and read storage outside its namespace when calling this helper.
export async function runPersistenceAttempt(driver: PersistenceDriver): Promise<Outcome> {
  const canary = Buffer.from(driver.canary);
  const scanner = persistenceScan(driver.locations, canary,
    driver.context.computerInstallationId);
  let native: NativeTurn | undefined;
  let outcome: Outcome | undefined;
  let stopped = false;
  try {
    if (driver.signal?.aborted || !await currentInstallation(driver)) {
      return { result: 'NOT RUN', complete: false, category: 'inventory' };
    }
    const preparationFailure = scanner.prepare();
    if (preparationFailure) {
      return { result: 'NOT RUN', complete: false, category: preparationFailure.category };
    }
    native = await driver.startNative();
    await native.assertHeld();
    const first = await checkedInventory(driver);
    if (isOutcome(first)) {
      return first;
    }
    for (const tool of toolClasses) {
      await native.assertHeld();
      if (driver.signal?.aborted) {
        return retainKnownFailure(outcome, {
          result: 'NOT RUN', complete: false, category: 'inventory',
        });
      }
      if (!await currentInstallation(driver)) {
        return { result: 'NOT RUN', complete: false, category: 'inventory' };
      }
      // Never repeat a tool call after an unknown response. It may have written already.
      const response = await callTool(native, tool, canary, driver.signal);
      if (response === 'wrote') {
        outcome = { result: 'FAIL', complete: false, tool };
        break;
      }
      if (response === undefined) {
        outcome = { result: 'NOT RUN', complete: false, category: 'inventory' };
        break;
      }
      if (response !== 'blocked') {
        outcome = { result: 'NOT RUN', complete: false, tool };
        break;
      }
    }
    await native.assertHeld();
    if (driver.signal?.aborted) {
      return retainKnownFailure(outcome, {
        result: 'NOT RUN', complete: false, category: 'inventory',
      });
    }
    if (!await currentInstallation(driver)) {
      return retainKnownFailure(outcome, {
        result: 'NOT RUN', complete: false, category: 'inventory',
      });
    }
    const live = scanner.scan('live', driver.context.computerInstallationId);
    const liveFailure = scanOutcome(live);
    if (liveFailure) {
      return retainKnownFailure(outcome, liveFailure);
    }
    const final = await checkedInventory(driver, first.snapshot);
    if (isOutcome(final)) {
      return retainKnownFailure(outcome, final);
    }
    await native.assertHeld();
    await native.stop();
    stopped = true;
    if (!await currentInstallation(driver)) {
      return retainKnownFailure(outcome, {
        result: 'NOT RUN', complete: false, category: 'inventory',
      });
    }
    const afterStop = scanner.scan('stopped', driver.context.computerInstallationId);
    const stoppedFailure = scanOutcome(afterStop);
    if (stoppedFailure) {
      return retainKnownFailure(outcome, stoppedFailure);
    }
    return outcome ?? { result: 'PARTIAL', complete: false };
  } catch {
    if (outcome?.result === 'FAIL') {
      return outcome;
    }
    return { result: 'NOT RUN', complete: false, category: 'inventory' };
  } finally {
    if (native && !stopped) {
      try {
        await native.stop();
      } catch {
        // Keep the refusal; the caller's supervisor owns termination on failed Stop.
      }
    }
    scanner.close();
    canary.fill(0);
  }
}
