import { joinInventory, type InventoryContext, type InventorySnapshot,
  type InventoryCode } from './joined-inventory.ts';
import { persistenceScan } from './persistence.ts';

const toolClasses = [
  'shell', 'file', 'browser', 'codeHost', 'externalMcp', 'skills', 'plugins', 'spawn',
] as const;
type ToolClass = typeof toolClasses[number];
type Category = 'pvc' | 'rollout' | 'cache' | 'outbox' | 'logs' | 'dumps';
type Location = { category: Category; path: string };
type Installation = Pick<InventoryContext, 'serverInstallationId' | 'computerInstallationId'>;
type NativeTurn = {
  attemptTool(tool: ToolClass, canary: Buffer): Promise<'blocked' | 'wrote' | 'unknown' | 'not_run'>;
  stop(): Promise<void>;
};
export type PersistenceDriver = {
  context: InventoryContext;
  locations: readonly Location[];
  canary: Buffer;
  currentInstallations(): Installation;
  readInventory(): InventorySnapshot;
  startNative(): Promise<NativeTurn>;
};
type Outcome = { result: 'PARTIAL'; complete: false } |
  { result: 'FAIL'; complete: false; group: InventoryCode } |
  { result: 'FAIL' | 'NOT RUN'; complete: false; category: Category | 'inventory' } |
  { result: 'FAIL' | 'NOT RUN'; complete: false; tool: ToolClass };

function currentInstallation(driver: PersistenceDriver): boolean {
  const current = driver.currentInstallations();
  return current.serverInstallationId === driver.context.serverInstallationId &&
    current.computerInstallationId === driver.context.computerInstallationId;
}

function checkedInventory(driver: PersistenceDriver,
  first?: InventorySnapshot): { snapshot: InventorySnapshot } | Outcome {
  if (!currentInstallation(driver)) {
    return { result: 'NOT RUN', complete: false, category: 'inventory' };
  }
  const snapshot = driver.readInventory();
  if (!currentInstallation(driver)) {
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
  return { result: result.result, complete: false,
    category: result.category ?? 'inventory' };
}

function retainKnownFailure(previous: Outcome | undefined, next: Outcome): Outcome {
  if (previous?.result === 'FAIL' && next.result === 'NOT RUN') {
    return previous;
  }
  return next;
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
    if (!currentInstallation(driver)) {
      return { result: 'NOT RUN', complete: false, category: 'inventory' };
    }
    native = await driver.startNative();
    const first = checkedInventory(driver);
    if (isOutcome(first)) {
      return first;
    }
    for (const tool of toolClasses) {
      if (!currentInstallation(driver)) {
        return { result: 'NOT RUN', complete: false, category: 'inventory' };
      }
      // Never repeat a tool call after an unknown response. It may have written already.
      const response = await native.attemptTool(tool, canary);
      if (response === 'wrote') {
        outcome = { result: 'FAIL', complete: false, tool };
        break;
      }
      if (response !== 'blocked') {
        outcome = { result: 'NOT RUN', complete: false, tool };
        break;
      }
    }
    if (!currentInstallation(driver)) {
      return retainKnownFailure(outcome, {
        result: 'NOT RUN', complete: false, category: 'inventory',
      });
    }
    const live = scanner.scan('live', driver.context.computerInstallationId);
    const liveFailure = scanOutcome(live);
    if (liveFailure) {
      return retainKnownFailure(outcome, liveFailure);
    }
    const final = checkedInventory(driver, first.snapshot);
    if (isOutcome(final)) {
      return retainKnownFailure(outcome, final);
    }
    await native.stop();
    stopped = true;
    if (!currentInstallation(driver)) {
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
