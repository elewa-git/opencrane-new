import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { memoryAdmission } from '../src/chat/memory-admission.ts';

const evidenceSchema = z.object({
  result: z.string().optional(),
  checks: z.record(z.string(), z.object({ result: z.string().optional() })).optional(),
});

it('keeps private memory disabled while the qualification evidence has any failure', () => {
  const evidenceText = readFileSync(
    new URL('../../../docs/process/evidence/p4-14/private-turns.json', import.meta.url), 'utf8');
  const evidence = evidenceSchema.parse(JSON.parse(evidenceText));
  const results = Object.values(evidence.checks ?? {}).map(check => check.result);
  const hasFailure = evidence.result === 'FAIL' || results.includes('FAIL');

  if (hasFailure) expect(memoryAdmission.state).toBe('disabled');
  expect(memoryAdmission.state).toBe('disabled');
});
