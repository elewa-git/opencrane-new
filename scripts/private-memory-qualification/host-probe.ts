import { readFileSync, readdirSync } from 'node:fs';

function coreLimitDisabled(path: string): boolean {
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n');
  const limits = lines.filter(isCoreLimit);
  return limits.length === 1 && /^Max core file size\s+0\s+0\s+bytes$/u.test(limits[0]!);
}
function isCoreLimit(line: string): boolean {
  return line.startsWith('Max core file size');
}
function settingDisabled(path: string): boolean {
  return readFileSync(path, 'utf8') === '0\n';
}
function kernelSafe(): boolean {
  const swaps = readFileSync('/proc/swaps', 'utf8');
  if (!/^Filename\s+Type\s+Size\s+Used\s+Priority\n$/u.test(swaps)) {
    return false;
  }
  // Require an empty pattern as well as zero limits: pipe collectors ignore RLIMIT_CORE.
  if (readFileSync('/proc/sys/kernel/core_pattern', 'utf8') !== '\n') {
    return false;
  }
  return settingDisabled('/proc/sys/kernel/core_uses_pid') &&
    settingDisabled('/proc/sys/fs/suid_dumpable') &&
    settingDisabled('/sys/kernel/kexec_crash_loaded');
}

// Check every visible process so server, bridge and proxy buffers receive the same rule.
// Other process namespaces still need their own live checks before a journey can pass.
export function probeHost(): boolean {
  try {
    if (!kernelSafe() || !coreLimitDisabled('/proc/self/limits')) {
      return false;
    }
    const entries = readdirSync('/proc');
    if (!entries.includes('1') || entries.length > 65_536) {
      return false;
    }
    for (const entry of entries) {
      if (entry.includes('/')) {
        return false;
      }
      if (!/^[1-9][0-9]*$/u.test(entry)) {
        continue;
      }
      if (!coreLimitDisabled(`/proc/${entry}/limits`)) {
        return false;
      }
    }
    return true;
  } catch {
    // Refuse disappearing processes and unreadable observations without exposing their data.
    return false;
  }
}
