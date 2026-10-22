export async function measureRemoval(
  accept: () => Promise<number>,
  observations: Record<string, (accepted: Promise<number>) => Promise<void>>,
): Promise<{ passed: boolean; hops: Record<string, number | null> }> {
  const accepted = Promise.withResolvers<number>();
  const observedAt: Record<string, number | null> = {};
  async function observe(entry: [string, (accepted: Promise<number>) => Promise<void>]) {
    const [name, observation] = entry;
    try {
      await observation(accepted.promise);
      observedAt[name] = Date.now();
    } catch {
      observedAt[name] = null;
    }
  }
  // Start every observer before sending Remove, so none waits for the Owner's list.
  const entries = Object.entries(observations);
  const pending = entries.map(observe);
  let acceptedAt: number;
  try {
    acceptedAt = await accept();
    accepted.resolve(acceptedAt);
  } catch (error) {
    accepted.reject(error);
    await Promise.all(pending);
    throw error;
  }
  await Promise.all(pending);
  const hops: Record<string, number | null> = { removalAccepted: 0 };
  let passed = true;
  for (const [name, timestamp] of Object.entries(observedAt)) {
    const elapsed = timestamp === null ? null : timestamp - acceptedAt;
    hops[name] = elapsed;
    if (name !== 'ownerList' && (elapsed === null || elapsed > 2_000)) passed = false;
  }
  return { passed, hops };
}
