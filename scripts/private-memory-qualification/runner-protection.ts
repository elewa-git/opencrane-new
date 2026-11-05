import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type Helper = { protect(): unknown; check(): unknown };
let helper: Helper | undefined;
let started = false;

function isHelper(value: unknown): value is Helper {
  return value !== null && typeof value === 'object' &&
    'protect' in value && typeof value.protect === 'function' &&
    'check' in value && typeof value.check === 'function';
}

export function runnerProtected(): boolean {
  try {
    if (!helper) {
      const loaded: unknown = require('./runner-protection.node');
      if (!isHelper(loaded)) {
        return false;
      }
      helper = loaded;
      started = helper.protect() === true;
    }
    // Measure again without repairing dumpability after an identity change.
    return started && helper.check() === true;
  } catch {
    return false;
  }
}
