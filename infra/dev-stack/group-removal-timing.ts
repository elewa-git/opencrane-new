export async function measureRemoval(
  accept: () => Promise<number>,
  observations: Record<string, () => Promise<void>>,
): Promise<{ passed: boolean; hops: Record<string, number | null> }> {
  const observedAt: Record<string, number | null> = {};
  async function observe(entry: [string, () => Promise<void>]) {
    const [name, observation] = entry;
    try {
      await observation();
      observedAt[name] = Date.now();
    } catch {
      observedAt[name] = null;
    }
  }
  // Start every observer before sending Remove, so none waits for the Owner's list.
  const entries = Object.entries(observations);
  const pending = entries.map(observe);
  const acceptedAt = await accept();
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
