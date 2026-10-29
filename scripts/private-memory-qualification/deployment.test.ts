import { execFileSync } from 'node:child_process';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { collectDeployment } from './deployment.ts';

vi.mock('node:child_process');
const containerId = 'c'.repeat(64);
const imageDigest = `sha256:${'b'.repeat(64)}`;
const sourceSha = 'a'.repeat(40);
const names = ['privateTurns', 'nativeRecall', 'requesterIsolation', 'sessionIsolation',
  'invalidation', 'unrelatedActivity', 'stopReconnect', 'replacementReload', 'persistence',
  'P4-14', 'P4-15'];
let container: Record<string, unknown>;
let stream: { created: string; state: { messages: number; last_seq: number } };
let host: string;
let responses: Record<string, unknown>[];
let alter: (value: Record<string, unknown>) => void;
let failChild: boolean;

function unchanged(): void {}

function docker(_file: unknown, args: unknown, options: unknown): string {
  expect(_file).toBe('/usr/bin/docker');
  const command = args as string[];
  expect(command.slice(0, 2)).toEqual(['--host', 'unix:///var/run/docker.sock']);
  if (failChild) throw new Error('private child output must not escape');
  if (command[2] === 'info') return JSON.stringify(host);
  if (command[2] === 'inspect') return JSON.stringify([container]);
  if (command[2] === 'image') {
    return JSON.stringify([{ Id: imageDigest,
      Config: { Labels: { 'org.opencontainers.image.revision': sourceSha } } }]);
  }
  expect(command.slice(2, 5)).toEqual(['exec', '-i', containerId]);
  if (command.includes('--eval')) return JSON.stringify(stream);
  expect(command.at(-1)).toBe('/app/scripts/private-memory-qualification/journey.mjs');
  const request = JSON.parse((options as { input: string }).input) as Record<string, unknown>;
  const response = { ...request, result: 'PASS', complete: true, observedAt: Date.now() };
  alter(response);
  responses.push(response);
  return JSON.stringify(response);
}

function prepare(): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:03Z'));
  container = {
    Id: containerId, Image: imageDigest, Created: '2026-01-01T00:00:00Z', RestartCount: 0,
    State: { Running: true, StartedAt: '2026-01-01T00:00:01Z' },
    HostConfig: { ReadonlyRootfs: true }, Mounts: [],
    Config: { Env: ['SILO_ID=fixture-silo'] },
  };
  stream = { created: '2026-01-01T00:00:02Z', state: { messages: 0, last_seq: 0 } };
  host = 'fixture-docker-host';
  responses = [];
  alter = unchanged;
  failChild = false;
  vi.mocked(execFileSync).mockImplementation(docker);
}
beforeEach(prepare);
afterEach(vi.useRealTimers);

function qualifiesObservedDeployment(): void {
  const result = collectDeployment(containerId);
  expect(result.result).toBe('PASS');
  expect(result).toMatchObject({ sourceSha, imageDigest });
  expect(responses.map(responseName)).toEqual(names);
  expect(JSON.stringify(result)).not.toContain('fixture-silo');
  expect(JSON.stringify(result)).not.toContain('fixture-docker-host');
}
function responseName(response: Record<string, unknown>): unknown { return response['name']; }
it('qualifies the fixture deployment only after all eleven observed runs',
  qualifiesObservedDeployment);

function refusesInventedBundle(): void {
  const invented = JSON.stringify({ result: 'PASS', sourceSha, imageDigest, checks: names });
  expect(collectDeployment(invented)).toEqual({ result: 'FAIL', reason: 'collection_failed' });
  expect(execFileSync).not.toHaveBeenCalled();
}
it('refuses an invented evidence bundle before executing anything', refusesInventedBundle);

function substitutes(field: string): void {
  function change(response: Record<string, unknown>): void { response[field] = 'foreign'; }
  alter = change;
  expect(collectDeployment(containerId).result).toBe('FAIL');
}
it.each(['sourceSha', 'imageDigest', 'environmentId', 'siloId', 'installationId', 'runId'])(
  'refuses a receipt from another %s', substitutes,
);

function staleOrReplayed(kind: string): void {
  function change(response: Record<string, unknown>): void {
    if (kind === 'stale') response['observedAt'] = Date.now() - 1;
    if (kind === 'future') response['observedAt'] = Date.now() + 1;
    if (kind === 'replayed') response['challengeId'] = responses[0]?.['challengeId'] ?? 'old';
    if (kind === 'edited') response['complete'] = false;
  }
  alter = change;
  expect(collectDeployment(containerId).result).toBe('FAIL');
}
it.each(['stale', 'future', 'replayed', 'edited'])('refuses %s receipts', staleOrReplayed);

function refusesMissingCheck(name: string): void {
  function change(response: Record<string, unknown>): void {
    if (response['name'] === name) response['result'] = 'NOT RUN';
  }
  alter = change;
  expect(collectDeployment(containerId).result).toBe('FAIL');
}
it.each(names)('refuses missing check %s', refusesMissingCheck);

function refusesCopiedRun(): void {
  expect(collectDeployment(containerId).result).toBe('PASS');
  const copied = structuredClone(responses);
  let index = 0;
  function replay(response: Record<string, unknown>): void {
    Object.assign(response, copied[index]);
    index += 1;
  }
  alter = replay;
  expect(collectDeployment(containerId).result).toBe('FAIL');
}
it('refuses a complete copied bundle on the same deployment', refusesCopiedRun);

function refusesDeploymentChange(field: string): void {
  function change(): void {
    if (field === 'image') container['Image'] = `sha256:${'d'.repeat(64)}`;
    if (field === 'host') host = 'another-host';
    if (field === 'silo') container['Config'] = { Env: ['SILO_ID=another-silo'] };
    if (field === 'restart') container['RestartCount'] = 1;
  }
  alter = change;
  expect(collectDeployment(containerId).result).toBe('FAIL');
}
it.each(['image', 'host', 'silo', 'restart'])(
  'refuses a deployment whose %s changes during a run', refusesDeploymentChange,
);

function refusesOldInstallation(kind: string): void {
  if (kind === 'events') stream.state.messages = 1;
  if (kind === 'purged') stream.state.last_seq = 5;
  if (kind === 'old') stream.created = '2025-01-01T00:00:00Z';
  if (kind === 'future') stream.created = '2027-01-01T00:00:00Z';
  expect(collectDeployment(containerId).result).toBe('FAIL');
  expect(responses).toHaveLength(0);
}
it.each(['events', 'purged', 'old', 'future'])(
  'refuses %s event-store state before journeys start', refusesOldInstallation,
);

function refusesMutableRunner(kind: string): void {
  if (kind === 'writable') container['HostConfig'] = { ReadonlyRootfs: false };
  if (kind === 'mounted') container['Mounts'] = [{ Destination: '/app/scripts' }];
  expect(collectDeployment(containerId).result).toBe('FAIL');
}
it.each(['writable', 'mounted'])('refuses %s deployment code', refusesMutableRunner);

function hidesFailures(): void {
  failChild = true;
  expect(collectDeployment(containerId)).toEqual({ result: 'FAIL', reason: 'collection_failed' });
}
it('keeps child output out of failures', hidesFailures);
