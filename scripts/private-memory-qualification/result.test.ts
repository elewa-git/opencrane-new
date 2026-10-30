import { afterEach, expect, it, vi } from 'vitest';
import { initialQualificationFixture } from '../../apps/server/test/support/initial-qualification.ts';
import { readDeploymentQualification } from './deployment.ts';

vi.mock('node:fs', { spy: true });
vi.mock('node:child_process', { spy: true });
afterEach(vi.restoreAllMocks);

async function collectorOutput() {
  const deployment = await initialQualificationFixture();
  expect(deployment.result.result).toBe('PASS');
  if (deployment.result.result !== 'PASS') throw new Error('Fixture collection failed');
  const proof = await readDeploymentQualification('test');
  expect(proof.runId).toBe(deployment.result.runId);
  expect(proof.confirm).not.toThrow();
  deployment.remove();
  expect(proof.confirm).toThrow();
}
it('reads the real collector output for the current deployment', collectorOutput);

async function foreignBinding(field: string) {
  const deployment = await initialQualificationFixture();
  const replacement: Record<string, unknown> = {
    sourceSha: 'd'.repeat(40), imageDigest: `sha256:${'d'.repeat(64)}`,
    environmentId: 'd'.repeat(64), siloId: `sha256:${'d'.repeat(64)}`,
    installationId: `sha256:${'d'.repeat(64)}`, freshInstall: false,
  };
  deployment.replace({ ...deployment.result, [field]: replacement[field] });
  await expect(readDeploymentQualification('test')).rejects.toThrow();
}
it.each(['sourceSha', 'imageDigest', 'environmentId', 'siloId', 'installationId', 'freshInstall'])(
  'rejects stored qualification with another %s', foreignBinding);

async function incompleteQualification(name: string) {
  const deployment = await initialQualificationFixture();
  if (deployment.result.result !== 'PASS') throw new Error('Fixture collection failed');
  const result = structuredClone(deployment.result);
  delete result.qualifications[name];
  deployment.replace(result);
  await expect(readDeploymentQualification('test')).rejects.toThrow();
}
it.each(['P4-14', 'P4-15'])(
  'requires the complete %s qualification from the collector', incompleteQualification);

async function missingFile() {
  const deployment = await initialQualificationFixture();
  deployment.remove();
  await expect(readDeploymentQualification('test')).rejects.toThrow();
}
it('refuses when the deployment has not saved collector output', missingFile);

async function otherSilo() {
  await initialQualificationFixture();
  await expect(readDeploymentQualification('other')).rejects.toThrow();
}
it('refuses a caller whose silo differs from the measured deployment', otherSilo);

async function incompleteRun(status: string) {
  const deployment = await initialQualificationFixture();
  if (deployment.result.result !== 'PASS') throw new Error('Fixture collection failed');
  const checks = { ...deployment.result.checks, invalidation: status };
  deployment.replace({ ...deployment.result, result: 'PARTIAL', checks });
  await expect(readDeploymentQualification('test')).rejects.toThrow();
}
it.each(['PARTIAL', 'NOT RUN'])('keeps %s journey results out of admission', incompleteRun);
