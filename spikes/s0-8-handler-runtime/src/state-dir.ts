import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';

/** Every owned data directory lives inside this spike and is removed on exit. */
export function stateDir(label: string): string {
  const root = resolve(import.meta.dirname, '../.state');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, `${label}-`));
}
