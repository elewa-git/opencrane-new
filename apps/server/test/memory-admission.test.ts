import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { memoryAdmission } from '../src/chat/memory-admission.ts';

const evidenceSchema = z.object({
  result: z.string().optional(),
  checks: z.record(z.string(), z.object({ result: z.string().optional() })).optional(),
});

it('keeps private memory disabled while the qualification evidence is incomplete or has a failure', () => {
  const evidenceText = readFileSync(
    new URL('../../../docs/process/evidence/p4-14/private-turns.json', import.meta.url), 'utf8');
  const evidence = evidenceSchema.parse(JSON.parse(evidenceText));
  const checks = Object.values(evidence.checks ?? {});
  function passed(check: { result?: string | undefined }): boolean {
    return check.result === 'PASS';
  }
  const mayEnable = evidence.result === 'PASS' && checks.length > 0 && checks.every(passed);
  if (!mayEnable) expect(memoryAdmission.state).toBe('disabled');
});
