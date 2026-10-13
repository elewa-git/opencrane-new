import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { memoryAdmission } from '../src/chat/memory-admission.ts';

const evidenceSchema = z.object({
  result: z.string().optional(),
  checks: z.record(z.string(), z.object({ result: z.string().optional() })).optional(),
});

function qualificationPassed(receiptPath: URL): boolean {
  if (!existsSync(receiptPath)) return false;

  const receiptText = readFileSync(receiptPath, 'utf8');
  const receipt = evidenceSchema.parse(JSON.parse(receiptText));
  const checks = Object.values(receipt.checks ?? {});
  function passed(check: { result?: string | undefined }): boolean {
    return check.result === 'PASS';
  }

  return receipt.result === 'PASS' && checks.length > 0 && checks.every(passed);
}

it('keeps private memory disabled until both private memory qualifications pass', () => {
  const p414Passed = qualificationPassed(
    new URL('../../../docs/process/evidence/p4-14/private-turns.json', import.meta.url),
  );
  const p415Passed = qualificationPassed(
    new URL('../../../docs/process/evidence/p4-15/private-memory.json', import.meta.url),
  );

  if (!p414Passed || !p415Passed) {
    expect(memoryAdmission.state).toBe('disabled');
  }
});
