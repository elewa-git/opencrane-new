import type { PersistenceDriver } from './persistence-attempt.ts';

type NativeTurn = Awaited<ReturnType<PersistenceDriver['startNative']>>;

export async function startNativePersistenceClient(
  _containerId: string, _challengeId: string,
): Promise<NativeTurn> {
  throw new Error('native_persistence_unavailable');
}
