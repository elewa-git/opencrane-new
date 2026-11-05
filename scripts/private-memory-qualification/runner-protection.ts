import { createRequire } from 'node:module';
import { isProtectionFailure, type ProtectionFailure } from './protection-failure.ts';

const require = createRequire(import.meta.url);
type Helper = { protect(): unknown; check(): unknown };
let helper: Helper | undefined;
let started: true | ProtectionFailure = 'helper_unavailable';

function isHelper(value: unknown): value is Helper {
  return value !== null && typeof value === 'object' &&
    'protect' in value && typeof value.protect === 'function' &&
    'check' in value && typeof value.check === 'function';
}

function measuredResult(value: unknown): true | ProtectionFailure {
  if (value === true || isProtectionFailure(value)) {
    return value;
  }
  return 'helper_unavailable';
}

export function runnerProtected(): true | ProtectionFailure {
  try {
    if (!helper) {
      const loaded: unknown = require('./runner-protection.node');
      if (!isHelper(loaded)) {
        return 'helper_unavailable';
      }
      helper = loaded;
      started = measuredResult(helper.protect());
    }
    // Measure again without repairing dumpability after an identity change.
    if (started !== true) {
      return started;
    }
    return measuredResult(helper.check());
  } catch {
    return 'helper_unavailable';
  }
}
