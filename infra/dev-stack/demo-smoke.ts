type Step = { name: string; run: (remainingMs: number) => Promise<void> };

export async function timedSmoke(steps: Step[], now = performance.now.bind(performance)) {
  const started = now();
  const results: Array<{ name: string; result: string; elapsedMs: number }> = [];
  for (const step of steps) {
    const before = now();
    const remainingMs = 180_000 - (before - started);
    let result = 'NOT RUN';
    if (remainingMs > 0) {
      try {
        await step.run(remainingMs);
        result = 'PASS';
      } catch {
        result = 'FAIL';
      }
    }
    results.push({ name: step.name, result, elapsedMs: Math.round(now() - before) });
  }
  const elapsedMs = Math.round(now() - started);
  function passed(step: typeof results[number]) {
    return step.result === 'PASS';
  }
  const result = results.every(passed) && elapsedMs <= 180_000 ? 'PASS' : 'FAIL';
  return { elapsedMs, result, steps: results };
}
