export async function measureRemoval(
  accept: () => Promise<{ sentAt: number; acceptedAt: number }>,
  observations: Record<string, (accepted: Promise<number>) => Promise<number | void>>,
): Promise<{ passed: boolean; hops: Record<string, number | null> }> {
  const accepted = Promise.withResolvers<number>();
  const observedAt: Record<string, number | null> = {};
  async function observe(entry: [string,
    (accepted: Promise<number>) => Promise<number | void>]) {
    const [name, observation] = entry;
    try {
      const timestamp = await observation(accepted.promise);
      observedAt[name] = timestamp ?? Date.now();
    } catch {
      observedAt[name] = null;
    }
  }
  // Start every observer before sending Remove, so none waits for the Owner's list.
  const entries = Object.entries(observations);
  const pending = entries.map(observe);
  let timing: { sentAt: number; acceptedAt: number };
  try {
    timing = await accept();
    accepted.resolve(timing.acceptedAt);
  } catch (error) {
    accepted.reject(error);
    await Promise.all(pending);
    throw error;
  }
  await Promise.all(pending);
  const hops: Record<string, number | null> = {
    removalSent: 0,
    removalAccepted: timing.acceptedAt - timing.sentAt,
  };
  let passed = true;
  for (const [name, timestamp] of Object.entries(observedAt)) {
    const elapsed = timestamp === null ? null : timestamp - timing.sentAt;
    hops[name] = elapsed;
    const limit = name === 'ownerList' ? 10_000 : 2_000;
    if (elapsed === null || elapsed > limit) {
      passed = false;
    }
  }
  return { passed, hops };
}
