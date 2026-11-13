import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

const spike = 'spikes/s0-9-postgres-event-store';

async function qualifiesUnprotectedLatency() {
  const readme = await readFile(`${spike}/README.md`, 'utf8');
  const adr = await readFile('docs/adr/0007-postgres-event-store-comparison.md', 'utf8');
  // Keep the recorded timing from becoming evidence for access work it did not measure.
  expect(readme).toMatch(/\| \(a\)[^\n]*\| PARTIAL \|/u);
  expect(readme).toMatch(/transactional access-subject comparisons[^.]*NOT RUN/u);
  expect(adr).toMatch(/\(a\)[^\n]*\*\*PARTIAL\*\*/u);
  expect(adr).toMatch(/transactional access-subject comparisons[^.]*NOT RUN/u);
}
it('marks latency partial while the recorded PostgreSQL run omits transactional access checks',
  qualifiesUnprotectedLatency);

async function documentsContractDatabase() {
  const readme = await readFile(`${spike}/README.md`, 'utf8');
  const runner = await readFile(`${spike}/run.sh`, 'utf8');
  // A fresh machine needs this server before the first contract command, not after it.
  for (const document of [readme, runner]) {
    expect(document).toContain('docker run -d --name pg-test');
    expect(document).toContain('127.0.0.1:55432:5432');
    expect(document).toContain('postgres://postgres:test@127.0.0.1:55432/postgres');
    expect(document).toContain('CREATE');
  }
}
it('documents the disposable contract server, connection and schema permissions before running',
  documentsContractDatabase);
