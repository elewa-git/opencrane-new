import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

interface Result { result: string }
interface Evidence {
  checks: Record<string, Result>;
  measurements: Record<string, Result>;
  conditions: Record<string, Result>;
  error?: string;
  infrastructure?: string;
}

function completed(): Evidence {
  return {
    checks: { J1: { result: 'PASS' }, 'advertised private tools': { result: 'PASS' } },
    measurements: { coreLimits: { result: 'PASS' } },
    conditions: {},
  };
}

function exitStatus(evidence: Evidence) {
  const source = `import {finishQualification} from './apps/computer/test/private-result.mjs';
    finishQualification(JSON.parse(process.argv[1]), true);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source,
    JSON.stringify(evidence)], { encoding: 'utf8' });
  expect(child.stderr).toBe('');
  return child.status;
}

function failsForRequiredMeasurements() {
  for (const result of ['FAIL', 'NOT RUN', 'ACCEPTED']) {
    const evidence = completed();
    evidence.measurements['coreLimits'] = { result };
    expect(exitStatus(evidence), result).toBe(1);
  }
}
function failsForEveryCheck() {
  for (const result of ['FAIL', 'NOT RUN']) {
    const evidence = completed();
    evidence.checks['advertised private tools'] = { result };
    expect(exitStatus(evidence), result).toBe(1);
  }
}
function failsForInfrastructureError() {
  const evidence = completed();
  evidence.error = 'Connection lost after the last assertion';
  expect(exitStatus(evidence)).toBe(1);
}
function acceptsOnlyApprovedHostRisks() {
  const evidence = completed();
  evidence.measurements['nodeSwaps'] = { result: 'ACCEPTED' };
  evidence.measurements['swapCgroups'] = { result: 'ACCEPTED' };
  evidence.measurements['hostCorePattern'] = { result: 'ACCEPTED' };
  evidence.conditions['F1'] = { result: 'ACCEPTED (dev box, owner 12 Oct, #366)' };
  evidence.conditions['F2'] = { result: 'ACCEPTED (dev box, owner 12 Oct, #366)' };
  expect(exitStatus(evidence)).toBe(0);
}

it('fails the promotion gate for every required failed or missing measurement', failsForRequiredMeasurements);
it('fails the promotion gate for every failed or missing check', failsForEveryCheck);
it('fails the promotion gate for infrastructure errors even after passing checks', failsForInfrastructureError);
it('accepts only the owner-approved host swap and crash dump exceptions', acceptsOnlyApprovedHostRisks);
