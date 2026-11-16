import { onTestFinished, vi } from 'vitest';
import * as projections from '@opencrane/projections';
import type { Db } from '@opencrane/projections';

export function captureSession() {
  let session: Db;
  const connect = projections.connectProjectionDb;
  function observed(...args: Parameters<typeof connect>) {
    const database = connect(...args);
    const lock = database.db.lock!.bind(database.db);
    async function observe<Result>(name: string, work: (db: Db) => Promise<Result>,
      options?: { timeoutMs: number; signal?: AbortSignal }) {
      function held(locked: Db) {
        session = locked;
        return work(locked);
      }
      return lock(name, held, options);
    }
    database.db.lock = observe;
    return database;
  }
  const connectSpy = vi.spyOn(projections, 'connectProjectionDb');
  connectSpy.mockImplementationOnce(observed);
  function restore() {
    vi.restoreAllMocks();
  }
  onTestFinished(restore);
  return function current() {
    return session;
  };
}
