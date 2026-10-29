import { openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { collectDeployment } from './deployment.ts';

vi.mock('node:child_process');
vi.mock('node:fs');
const containerId = 'c'.repeat(64);
const imageDigest = `sha256:${'b'.repeat(64)}`;
const sourceSha = 'a'.repeat(40);
const names = ['privateTurns', 'nativeRecall', 'requesterIsolation', 'sessionIsolation',
  'invalidation', 'unrelatedActivity', 'stopReconnect', 'replacementReload', 'persistence',
  'P4-14', 'P4-15'];
let container: Record<string, unknown>;
let stream: { created: string; eventCount: number; lastSequence: number };
let host: string;
let responses: Record<string, unknown>[];
let alter: (value: Record<string, unknown>) => void;
let failChild: boolean;

function unchanged(): void {}

function docker(_file: unknown, args: unknown, options: unknown): string {
  expect(_file).toBe('/usr/bin/docker');
  const command = z.array(z.string()).parse(args);
  expect(command.slice(0, 2)).toEqual(['--host', 'unix:///var/run/docker.sock']);
  if (failChild) {
    throw new Error('private child output must not escape');
  }
  if (command[2] === 'info') {
    return JSON.stringify(host);
  }
  if (command[2] === 'inspect') {
    return JSON.stringify([container]);
  }
  if (command[2] === 'image') {
    return JSON.stringify([{ Id: imageDigest,
      Config: { Labels: { 'org.opencontainers.image.revision': sourceSha } } }]);
  }
  expect(command[2]).toBe('exec');
  expect(command).toContain(container['Id']);
  expect(command).toContain('NODE_OPTIONS=');
  expect(command).toContain('/usr/local/bin/node');
  if (command.includes('--eval')) {
    return JSON.stringify(stream);
  }
  expect(command.at(-1)).toBe('/app/scripts/private-memory-qualification/journey.mjs');
  const input = z.object({ input: z.string() }).parse(options).input;
  const parsed: unknown = JSON.parse(input);
  const request = z.record(z.string(), z.unknown()).parse(parsed);
  const response = { ...request, result: 'PASS', complete: true, observedAt: Date.now() };
  alter(response);
  responses.push(response);
  return JSON.stringify(response);
}

function prepare(): void {
  vi.mocked(execFileSync).mockReset();
  vi.mocked(openSync).mockReturnValue(42);
  vi.mocked(closeSync).mockReturnValue(undefined);
  vi.mocked(fstatSync).mockReturnValue({
    uid: 0, mode: 0o100600, size: 150, isFile: () => true,
  } as ReturnType<typeof fstatSync>);
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ containerId, siloId: 'fixture-silo' }));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:03Z'));
  container = {
    Id: containerId, Image: imageDigest, Created: '2026-01-01T00:00:00Z', RestartCount: 0,
    State: { Running: true, StartedAt: '2026-01-01T00:00:01Z' },
    HostConfig: { ReadonlyRootfs: true }, Mounts: [],
    Config: { Env: ['SILO_ID=fixture-silo'] },
  };
  stream = { created: '2026-01-01T00:00:02Z', eventCount: 0, lastSequence: 0 };
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
function responseName(response: Record<string, unknown>): unknown {
  return response['name'];
}
it('qualifies the fixture deployment only after all eleven observed runs',
  qualifiesObservedDeployment);

function refusesInventedBundle(): void {
  const invented = JSON.stringify({ result: 'PASS', sourceSha, imageDigest, checks: names });
  expect(collectDeployment(invented)).toEqual({ result: 'FAIL', reason: 'collection_failed' });
  expect(execFileSync).not.toHaveBeenCalled();
}
it('refuses an invented evidence bundle before executing anything', refusesInventedBundle);

function substitutes(field: string): void {
  const foreign: Record<string, string> = {
    sourceSha: 'd'.repeat(40), imageDigest: `sha256:${'d'.repeat(64)}`,
    environmentId: 'd'.repeat(64), siloId: `sha256:${'d'.repeat(64)}`,
    installationId: `sha256:${'d'.repeat(64)}`, runId: '11111111-1111-4111-8111-111111111111',
  };
  function change(response: Record<string, unknown>): void {
    response[field] = foreign[field];
  }
  alter = change;
  expect(collectDeployment(containerId).result).toBe('FAIL');
}
it.each(['sourceSha', 'imageDigest', 'environmentId', 'siloId', 'installationId', 'runId'])(
  'refuses a receipt from another %s', substitutes,
);

function staleOrReplayed(kind: string): void {
  function change(response: Record<string, unknown>): void {
    if (kind === 'stale') {
      response['observedAt'] = Date.now() - 1;
    }
    if (kind === 'future') {
      response['observedAt'] = Date.now() + 1;
    }
    if (kind === 'replayed' && responses.length > 0) {
      response['challengeId'] = responses[0]!['challengeId'];
    }
    if (kind === 'edited') {
      response['complete'] = false;
    }
  }
  alter = change;
  expect(collectDeployment(containerId).result).toBe('FAIL');
}
it.each(['stale', 'future', 'replayed', 'edited'])('refuses %s receipts', staleOrReplayed);

function refusesMissingCheck(name: string): void {
  function change(response: Record<string, unknown>): void {
    if (response['name'] === name) {
      response['result'] = 'NOT RUN';
    }
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
    if (field === 'image') {
      container['Image'] = `sha256:${'d'.repeat(64)}`;
    }
    if (field === 'host') {
      host = 'another-host';
    }
    if (field === 'silo') {
      container['Config'] = { Env: ['SILO_ID=another-silo'] };
    }
    if (field === 'event-store') {
      stream.created = '2026-01-01T00:00:03Z';
    }
    if (field === 'restart') {
      container['RestartCount'] = 1;
    }
  }
  alter = change;
  expect(collectDeployment(containerId).result).toBe('FAIL');
}
it.each(['image', 'host', 'silo', 'restart', 'event-store'])(
  'refuses a deployment whose %s changes during a run', refusesDeploymentChange,
);

function refusesOldInstallation(kind: string): void {
  if (kind === 'events') {
    stream.eventCount = 1;
  }
  if (kind === 'purged') {
    stream.lastSequence = 5;
  }
  if (kind === 'old') {
    stream.created = '2025-01-01T00:00:00Z';
  }
  if (kind === 'future') {
    stream.created = '2027-01-01T00:00:00Z';
  }
  expect(collectDeployment(containerId).result).toBe('FAIL');
  expect(responses).toHaveLength(0);
}
it.each(['events', 'purged', 'old', 'future'])(
  'refuses %s event-store state before journeys start', refusesOldInstallation,
);

function refusesMutableRunner(kind: string): void {
  if (kind === 'writable') {
    container['HostConfig'] = { ReadonlyRootfs: false };
  }
  if (kind === 'mounted') {
    container['Mounts'] = [{ Destination: '/app/scripts' }];
  }
  expect(collectDeployment(containerId).result).toBe('FAIL');
}
it.each(['writable', 'mounted'])('refuses %s deployment code', refusesMutableRunner);

function hidesFailures(): void {
  failChild = true;
  expect(collectDeployment(containerId)).toEqual({ result: 'FAIL', reason: 'collection_failed' });
}
it('keeps child output out of failures', hidesFailures);

function refusesNonPassingChild(status: string): void {
  function change(response: Record<string, unknown>): void {
    response['result'] = status;
  }
  alter = change;
  expect(collectDeployment(containerId)).toEqual({ result: 'FAIL', reason: 'collection_failed' });
}
it.each(['FAIL', 'PARTIAL'])('refuses a child reporting %s', refusesNonPassingChild);

function refusesExtraChildOutput(): void {
  function change(response: Record<string, unknown>): void {
    response['extra'] = 'fixture output that must stay private';
  }
  alter = change;
  expect(collectDeployment(containerId)).toEqual({ result: 'FAIL', reason: 'collection_failed' });
}
it('refuses extra child fields without exposing their values', refusesExtraChildOutput);

function refusesAnotherLocalSilo(): void {
  const otherContainerId = 'd'.repeat(64);
  container['Id'] = otherContainerId;
  container['Config'] = { Env: ['SILO_ID=other-local-silo'] };
  expect(collectDeployment(otherContainerId)).toEqual({
    result: 'FAIL', reason: 'collection_failed',
  });
  expect(execFileSync).not.toHaveBeenCalled();
}
it('refuses a caller selecting another local silo before Docker runs', refusesAnotherLocalSilo);
