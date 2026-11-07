import { prepareWorkerInput } from './worker-input.ts';
import { workerRequest, type Binding, type Lookup } from './worker-request.ts';

type Plan = ReturnType<typeof workerRequest>;
type WorkerProcess = { exit: Promise<number>; kill: () => void };
type Readiness = { isolated: boolean; scanner: boolean; egress: boolean };
type Dispatch = {
  frame: Buffer;
  binding: Binding | undefined;
  lookup: Lookup;
  parent: string;
  active: (identity: Plan['identity']) => boolean;
  ready: Readiness;
  launch: (plan: Plan, root: string) => WorkerProcess;
  now?: () => number;
};

function ready(value: Readiness) {
  return value.isolated === true && value.scanner === true && value.egress === true;
}

function exitResult(worker: WorkerProcess, wallMs: number): Promise<number | undefined> {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(timedOut, wallMs);
    function finish(code: number | undefined) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    }
    function timedOut() {
      try {
        worker.kill();
      } catch {
        // A missing exit remains unknown even if signalling failed.
      }
      finish(undefined);
    }
    function exited(code: number) { finish(code); }
    function lost() { finish(undefined); }
    void worker.exit.then(exited, lost);
  });
}

// Keep the result at awaiting_scan until a separate scanner and publisher prove the files safe.
// No caller may turn a missing exit into a retry: validation consumes the saved registration.
export async function dispatchWorker(options: Dispatch): Promise<'refused' | 'unknown' | 'awaiting_scan'> {
  if (!ready(options.ready)) return 'refused';
  let plan: Plan;
  try {
    const now = options.now ?? Date.now;
    plan = workerRequest(options.frame, options.lookup, options.binding, now());
    if (!options.active(plan.identity) || !ready(options.ready)) return 'refused';
  } catch {
    return 'refused';
  }

  let prepared: ReturnType<typeof prepareWorkerInput>;
  try {
    prepared = prepareWorkerInput(plan, options.parent);
  } catch {
    return 'refused';
  }

  // This path is supervisor-owned. The supplied launcher must prove UID and filesystem
  // isolation before readiness can be true. Production does not supply such a launcher.
  const root = `${options.parent}/${plan.identity.operationId}`;
  let worker: WorkerProcess;
  try {
    if (!options.active(plan.identity) || !ready(options.ready)) {
      prepared.cleanup();
      return 'refused';
    }
    worker = options.launch(plan, root);
  } catch {
    // An exception from a launcher cannot prove that it started no process.
    return 'unknown';
  }

  const exit = await exitResult(worker, plan.limits.wallMs);
  if (exit !== 0) return 'unknown';
  return 'awaiting_scan';
}
