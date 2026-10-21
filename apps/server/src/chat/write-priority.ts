type Pending = WeakMap<object, Map<string, Set<Promise<void>>>>;
const stops: Pending = new WeakMap();
const reports: Pending = new WeakMap();

function pendingWrites(pending: Pending, store: object, subject: string) {
  let subjects = pending.get(store);
  if (!subjects) {
    subjects = new Map();
    pending.set(store, subjects);
  }
  let writes = subjects.get(subject);
  if (!writes) {
    writes = new Set();
    subjects.set(subject, writes);
  }
  return writes;
}

export async function chatWrite<Result>(store: object, subject: string,
  kind: 'stop' | 'report', save: () => Promise<Result>): Promise<Result> {
  if (kind === 'report') {
    while (stops.get(store)?.get(subject)?.size) {
      await Promise.all(stops.get(store)!.get(subject)!);
    }
  }
  const pending = kind === 'stop' ? stops : reports;
  const writes = pendingWrites(pending, store, subject);
  const finished = Promise.withResolvers<void>();
  writes.add(finished.promise);
  try {
    // Wait only for report appends already running. Keep queued progress behind Stop.
    const activeReports = reports.get(store)?.get(subject);
    if (kind === 'stop' && activeReports) await Promise.all(activeReports);
    return await save();
  } finally {
    writes.delete(finished.promise);
    if (writes.size === 0) pending.get(store)!.delete(subject);
    finished.resolve();
  }
}
