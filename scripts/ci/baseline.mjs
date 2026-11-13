import { execFileSync } from 'node:child_process';

export function baseCommit() {
  if (process.env.BASE_SHA) return process.env.BASE_SHA;
  try {
    const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    return execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], options).trim();
  } catch {
    // A new clone may not have a remote base to compare with yet.
    return undefined;
  }
}

export function readAtBase(path) {
  const base = baseCommit();
  if (!base) return undefined;
  try {
    const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    return execFileSync('git', ['show', `${base}:${path}`], options);
  } catch {
    // Treat a file absent from the base as an empty starting ledger.
    return undefined;
  }
}

export function mustNotRise(label, before, after) {
  if (after > before) return `${label} rose from ${before} to ${after}`;
  return undefined;
}
