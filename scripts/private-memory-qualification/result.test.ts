import { afterEach, expect, it, vi } from 'vitest';
import { initialQualificationFixture } from '../../../apps/server/test/support/initial-qualification.ts';

vi.mock('node:fs', { spy: true });
vi.mock('node:child_process', { spy: true });
afterEach(vi.restoreAllMocks);
async function collectorOutput() {
  const deployment = await initialQualificationFixture();
  expect(deployment.result.result).toBe('PASS');
}
it('produces the real result shape at the deployment boundary', collectorOutput);
