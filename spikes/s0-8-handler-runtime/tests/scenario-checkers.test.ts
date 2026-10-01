import { assertCents } from '../src/money.ts';
// The checkers in src/scenario.ts decide every PASS in this spike. This file
// proves they can actually fail: each rule is broken on purpose with a
// hand-made run list and must be reported, and a clean run must pass.
import { describe, expect, it } from 'vitest';
import { analyseRuns, handlerDelayMs, maxConcurrency, type HandlerRun } from '../src/scenario.ts';

/** Build runs for `keys` keys, each running seq 0..n-1 one after another, 10 ms each. */
function cleanRuns(keys: number, n: number): HandlerRun[] {
  const runs: HandlerRun[] = [];
  for (let k = 0; k < keys; k++) {
    for (let seq = 0; seq < n; seq++) {
      runs.push({ key: `key-${k}`, seq, start: seq * 12 + k, end: seq * 12 + k + 10 });
    }
  }
  return runs;
}

describe('scenario checkers', () => {
  it('accepts a clean run and sees cross-key parallelism', () => {
    const result = analyseRuns(cleanRuns(5, 10), 5, 10);
    expect(result.violations).toEqual([]);
    expect(result.maxConcurrent).toBe(5);
  });

  it('reports two handlers of one key running at the same time', () => {
    const runs = cleanRuns(2, 5);
    // Make key-0 seq 3 start before seq 2 has finished.
    const r = runs.find((x) => x.key === 'key-0' && x.seq === 3) as HandlerRun;
    r.start = 2 * 12 + 5;
    const result = analyseRuns(runs, 2, 5);
    expect(result.violations.join('\n')).toContain('key-0');
    expect(result.violations.join('\n')).toContain('two writers at once');
  });

  it('reports events of one key running out of order', () => {
    const runs = cleanRuns(2, 5);
    const a = runs.find((x) => x.key === 'key-1' && x.seq === 1) as HandlerRun;
    const b = runs.find((x) => x.key === 'key-1' && x.seq === 2) as HandlerRun;
    [a.seq, b.seq] = [b.seq, a.seq]; // seq 2 now ran before seq 1
    const result = analyseRuns(runs, 2, 5);
    expect(result.violations.join('\n')).toContain('key-1');
    expect(result.violations.join('\n')).toContain('expected seq');
  });

  it('reports a lost event and a duplicated event', () => {
    const lost = cleanRuns(2, 5).filter((x) => !(x.key === 'key-0' && x.seq === 4));
    expect(analyseRuns(lost, 2, 5).violations.join('\n')).toContain('expected 5 runs, saw 4');

    const duplicated = [...cleanRuns(2, 5), { key: 'key-0', seq: 2, start: 500, end: 510 }];
    expect(analyseRuns(duplicated, 2, 5).violations.join('\n')).toContain('key-0');
  });

  it('rejects missing or reversed timestamps instead of silently accepting them', () => {
    for (const [start, end] of [[NaN, 10], [0, Infinity], [10, 0]]) {
      const runs = [{ key: 'key-0', seq: 0, start: start!, end: end! }];
      expect(analyseRuns(runs, 1, 1).violations).toContain('key-0: invalid handler interval');
    }
  });

  it('reports a missing key', () => {
    expect(analyseRuns(cleanRuns(3, 5), 4, 5).violations.join('\n')).toContain('expected 4 keys, saw 3');
  });

  it('measures concurrency, treating back-to-back runs as not overlapping', () => {
    const back: HandlerRun[] = [
      { key: 'a', seq: 0, start: 0, end: 10 },
      { key: 'b', seq: 0, start: 10, end: 20 },
    ];
    expect(maxConcurrency(back)).toBe(1);
    expect(maxConcurrency([...back, { key: 'c', seq: 0, start: 5, end: 15 }])).toBe(2);
  });

  it('gives the same handler delay for the same event every time, within 2 to 12 ms', () => {
    const seen = new Set<number>();
    for (let k = 0; k < 20; k++) {
      for (let seq = 0; seq < 20; seq++) {
        const d = handlerDelayMs(k, seq);
        expect(d).toBe(handlerDelayMs(k, seq));
        expect(d).toBeGreaterThanOrEqual(2);
        expect(d).toBeLessThanOrEqual(12);
        seen.add(d);
      }
    }
    expect(seen.size).toBeGreaterThan(6); // the delays really vary
  });
});

describe('integer money input', () => {
  it('rejects fractions, negatives and unsafe numbers', () => {
    for (const invalid of [0.1, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => assertCents(invalid)).toThrow('integer euro cents');
    }
    for (const valid of [0, 1, 500]) expect(() => assertCents(valid)).not.toThrow();
  });
});
