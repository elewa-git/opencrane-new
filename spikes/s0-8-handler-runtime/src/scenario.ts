// The one scenario every candidate runtime is asked to run, and the checks
// applied to what the handlers actually did. Keeping both here (not copied
// into each runtime's tests) is what makes the comparison fair: the same
// workload goes in, and the same checker judges the result.

/** What a handler observed about its own run: which event, and when it ran. */
export interface HandlerRun {
  key: string;
  seq: number;
  /** performance.now() at the start of the handler body. */
  start: number;
  /** performance.now() at the end of the handler body. */
  end: number;
}

export function keyName(index: number): string {
  return `key-${index}`;
}

/**
 * A small deterministic random number generator (mulberry32). Used so that
 * the "random" handler delay for a given (key, seq) is the same in every
 * run and in every runtime. The delays are random-looking but repeatable.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Handler delay for one event, between `min` and `max` milliseconds inclusive. */
export function handlerDelayMs(keyIndex: number, seq: number, min = 2, max = 12): number {
  const next = mulberry32(keyIndex * 100003 + seq * 7919 + 17);
  return min + Math.floor(next() * (max - min + 1));
}

export interface RunAnalysis {
  totalRuns: number;
  keysSeen: number;
  /** Human-readable rule breaches. Empty means every rule held. */
  violations: string[];
  /** The most handlers observed running at the same instant. */
  maxConcurrent: number;
}

/** The highest number of overlapping [start, end] intervals (sweep line). */
export function maxConcurrency(runs: HandlerRun[]): number {
  const edges: { t: number; delta: number }[] = [];
  for (const r of runs) {
    edges.push({ t: r.start, delta: 1 });
    edges.push({ t: r.end, delta: -1 });
  }
  // Ends sort before starts at the same instant, so back-to-back runs do not count as overlapping.
  edges.sort((a, b) => a.t - b.t || a.delta - b.delta);
  let current = 0;
  let max = 0;
  for (const e of edges) {
    current += e.delta;
    if (current > max) max = current;
  }
  return max;
}

/**
 * Judge a whole run against the delivery rules in events.md:
 *  - every event ran exactly once (none lost, none duplicated);
 *  - within a key, events ran in sequence order;
 *  - within a key, no two handlers ever overlapped (one writer at a time).
 * Order is judged from the handlers' own observed start and end times, not
 * from anything the runtime reports about itself.
 */
export function analyseRuns(runs: HandlerRun[], expectedKeys: number, eventsPerKey: number): RunAnalysis {
  const violations: string[] = [];
  const add = (message: string) => {
    if (violations.length < 20) violations.push(message);
  };

  const byKey = new Map<string, HandlerRun[]>();
  for (const r of runs) {
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end) || r.end < r.start) {
      add(`${r.key}: invalid handler interval`);
    }
    const list = byKey.get(r.key) ?? [];
    list.push(r);
    byKey.set(r.key, list);
  }
  if (byKey.size !== expectedKeys) add(`expected ${expectedKeys} keys, saw ${byKey.size}`);

  for (const [key, list] of byKey) {
    if (list.length !== eventsPerKey) add(`${key}: expected ${eventsPerKey} runs, saw ${list.length}`);
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i < list.length; i++) {
      const cur = list[i] as HandlerRun;
      if (cur.seq !== i) {
        add(`${key}: run #${i} (by start time) was seq ${cur.seq}, expected seq ${i}`);
        break; // one report per key is enough
      }
    }
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1] as HandlerRun;
      const cur = list[i] as HandlerRun;
      if (cur.start < prev.end) {
        add(`${key}: seq ${cur.seq} started before seq ${prev.seq} had finished (two writers at once)`);
        break;
      }
    }
  }

  return { totalRuns: runs.length, keysSeen: byKey.size, violations, maxConcurrent: maxConcurrency(runs) };
}
