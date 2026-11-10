import type { PersistenceDriver } from './persistence-attempt.ts';

type NativeTurn = Awaited<ReturnType<PersistenceDriver['startNative']>>;

export function startNativePersistenceClient(
  _containerId: string, _challengeId: string,
): Promise<NativeTurn> {
  return Promise.reject(new Error('native_persistence_unavailable'));
}
