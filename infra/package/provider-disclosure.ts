import assert from 'node:assert/strict';

export function assertNoBrowserDisclosure(secrets: readonly string[], body: string): void {
  for (const secret of secrets) {
    assert(!body.includes(secret), 'An API reply disclosed a key');
  }
}
