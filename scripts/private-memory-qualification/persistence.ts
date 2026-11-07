import {
  closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, readSync,
} from 'node:fs';
import { isAbsolute, normalize } from 'node:path';

const categories = ['pvc', 'rollout', 'cache', 'outbox', 'logs', 'dumps'] as const;
type Category = typeof categories[number];
type Location = { category: Category; path: string };
type Result = {
  result: 'PARTIAL' | 'FAIL'; complete: false; files: number; bytes: number;
  category?: Category | 'inventory';
};
type InventoryEntry = Location & { identity?: string };
const statOptions = { bigint: true } as const;
const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function mountId(descriptor: number): string {
  const information = readFileSync(`/proc/self/fdinfo/${descriptor}`, 'utf8');
  const match = /^mnt_id:\s+(\d+)$/mu.exec(information);
  if (!match?.[1]) {
    throw new Error('inventory');
  }
  return match[1];
}

function identity(descriptor: number): string {
  const information = fstatSync(descriptor, statOptions);
  return `${mountId(descriptor)}:${information.dev}:${information.ino}`;
}

function openDirectory(path: string): number {
  let descriptor = openSync('/', flags | constants.O_DIRECTORY);
  try {
    const relative = path.slice(1);
    const components = relative.split('/');
    for (const component of components) {
      // Resolve each component through an owned descriptor; never follow a redirect.
      const child = openSync(`/proc/self/fd/${descriptor}/${component}`,
        flags | constants.O_DIRECTORY);
      closeSync(descriptor);
      descriptor = child;
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function patternsFor(canary: Buffer): Buffer[] {
  const text = canary.toString('utf8');
  if (!/^[a-f0-9]{48,128}$/u.test(text)) {
    throw new Error('inventory');
  }
  const hexadecimal = canary.toString('hex');
  const patterns = [Buffer.from(canary), Buffer.from(text, 'utf16le'),
    Buffer.from(hexadecimal)];
  for (let offset = 0; offset < 3; offset++) {
    const padding = Buffer.alloc(offset);
    const padded = Buffer.concat([padding, canary]);
    const encoded = padded.toString('base64');
    const start = offset === 0 ? 0 : 4;
    const fragment = encoded.slice(start, -4);
    const pattern = Buffer.from(fragment);
    patterns.push(pattern);
    padded.fill(0);
  }
  return patterns;
}

function matches(bytes: Buffer, patterns: Buffer[]): boolean {
  for (const pattern of patterns) {
    if (bytes.includes(pattern)) {
      return true;
    }
  }
  return false;
}

function readContents(descriptor: number, patterns: Buffer[], counts: Result): void {
  const before = fstatSync(descriptor, statOptions);
  const buffer = Buffer.alloc(65_536 + 256);
  let retained = 0;
  let total = 0;
  try {
    for (;;) {
      const read = readSync(descriptor, buffer, retained, 65_536, null);
      if (read === 0) {
        break;
      }
      total += read;
      counts.bytes += read;
      if (total > 64 * 1024 * 1024 || counts.bytes > 256 * 1024 * 1024) {
        throw new Error('inventory');
      }
      const available = buffer.subarray(0, retained + read);
      if (matches(available, patterns)) {
        throw new Error('persistence');
      }
      retained = Math.min(256, available.length);
      buffer.copy(buffer, 0, available.length - retained, available.length);
    }
    const after = fstatSync(descriptor, statOptions);
    if (before.size !== BigInt(total) || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error('inventory');
    }
    counts.files++;
  } finally {
    buffer.fill(0);
  }
}

function scanDirectory(
  descriptor: number, mount: string, patterns: Buffer[], counts: Result,
  budget: { entries: number }, depth = 0,
): void {
  const information = fstatSync(descriptor, statOptions);
  if (depth > 64 || (information.mode & 0o444n) === 0n ||
      (information.mode & 0o111n) === 0n) {
    throw new Error('inventory');
  }
  const path = `/proc/self/fd/${descriptor}`;
  const before = readdirSync(path);
  before.sort();
  for (const name of before) {
    budget.entries++;
    if (budget.entries > 10_000 || matches(Buffer.from(name), patterns)) {
      throw new Error('inventory');
    }
    const child = openSync(`${path}/${name}`, flags);
    try {
      const childInformation = fstatSync(child);
      // Refuse hidden mounts and special files instead of reading outside the named tree.
      if (mountId(child) !== mount || (childInformation.mode & 0o444) === 0) {
        throw new Error('inventory');
      }
      if (childInformation.isDirectory()) {
        scanDirectory(child, mount, patterns, counts, budget, depth + 1);
      } else if (childInformation.isFile() && childInformation.nlink === 1) {
        readContents(child, patterns, counts);
      } else {
        throw new Error('inventory');
      }
    } finally {
      closeSync(child);
    }
  }
  const after = readdirSync(path);
  after.sort();
  const finalInformation = fstatSync(descriptor, statOptions);
  if (information.mtimeNs !== finalInformation.mtimeNs ||
      information.ctimeNs !== finalInformation.ctimeNs ||
      JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('inventory');
  }
}

function inventoryEntries(locations: readonly Location[]): InventoryEntry[] {
  const entries: InventoryEntry[] = [];
  if (locations.length > 128) {
    throw new Error('inventory');
  }
  const present = new Set<Category>();
  const paths = new Set<string>();
  for (const location of locations) {
    const { category, path } = location;
    if (!categories.includes(category) || !isAbsolute(path) || path === '/' ||
        normalize(path) !== path || path.endsWith('/') || paths.has(path)) {
      throw new Error('inventory');
    }
    paths.add(path);
    present.add(category);
    const entry = { category, path };
    entries.push(entry);
  }
  if (present.size !== categories.length) {
    throw new Error('inventory');
  }
  return entries;
}

export function persistenceScan(
  locations: readonly Location[], canary: Buffer, installationId: string,
) {
  let entries: InventoryEntry[] = [];
  let patterns: Buffer[] = [];
  let phase: 'live' | 'stopped' | 'closed' = 'live';
  let failed: Category | 'inventory' | undefined;
  try {
    if (!/^sha256:[a-f0-9]{64}$/u.test(installationId)) {
      throw new Error('inventory');
    }
    entries = inventoryEntries(locations);
    patterns = patternsFor(canary);
  } catch {
    failed = 'inventory';
  }

  function close(): void {
    phase = 'closed';
    for (const pattern of patterns) {
      pattern.fill(0);
    }
    patterns = [];
  }

  function scan(requested: 'live' | 'stopped', currentInstallation: string): Result {
    const counts: Result = { result: 'PARTIAL', complete: false, files: 0, bytes: 0 };
    let category: Category | 'inventory' = 'inventory';
    try {
      if (failed || phase === 'closed' || requested !== phase ||
          currentInstallation !== installationId) {
        throw new Error('inventory');
      }
      const budget = { entries: 0 };
      for (const entry of entries) {
        category = entry.category;
        const descriptor = openDirectory(entry.path);
        try {
          const observed = identity(descriptor);
          if (entry.identity !== undefined && entry.identity !== observed) {
            throw new Error('inventory');
          }
          entry.identity = observed;
          scanDirectory(descriptor, mountId(descriptor), patterns, counts, budget);
          const current = openDirectory(entry.path);
          try {
            if (identity(current) !== observed) {
              throw new Error('inventory');
            }
          } finally {
            closeSync(current);
          }
        } finally {
          closeSync(descriptor);
        }
      }
      if (phase === 'live') {
        phase = 'stopped';
      } else {
        close();
      }
      // Keep scans incomplete: caller-supplied paths and phase names cannot prove a native journey.
      return counts;
    } catch {
      failed ??= category;
      close();
      return { ...counts, result: 'FAIL', category: failed };
    }
  }
  return { scan, close };
}
