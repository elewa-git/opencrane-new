import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { record } from '../src/http.ts';

async function usesNativePrivateProtocol() {
  const execute = promisify(execFile);
  const image = process.env['COMPUTER_TEST_IMAGE'] ?? 'ocn-upload-computer:test';
  const source = resolve('apps/computer/src');
  const fixture = resolve('apps/computer/test/private-config-native.mjs');
  const argumentsList = ['run', '--rm', '--network=none', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--entrypoint=nice',
    '-v', `${source}:/app/src:ro`, '-v', `${fixture}:/app/test/private-config-native.mjs:ro`,
    image, '-n', '10', 'node', '--experimental-strip-types', '/app/test/private-config-native.mjs'];
  const result = await execute('docker', argumentsList, { timeout: 25_000 });
  const observed = record(JSON.parse(result.stdout));
  expect(observed['version']).toBe('codex-cli 0.159.2');
  expect(observed['methods']).toEqual(['server/discover', 'tools/list']);
  expect(observed['protocols']).toEqual(['2026-07-28', '2026-07-28']);
  expect(observed['discovered']).toBe(true);
  expect(observed['thread']).toMatchObject({ ephemeral: true, path: null, environments: [] });
  expect(observed['grants']).toBe(0);
}
it('uses native private configuration to discover through the real proxy', usesNativePrivateProtocol);

async function loadsNativePrivateCatalogue(name: 'recall' | 'remember' | 'correct') {
  const execute = promisify(execFile);
  const image = process.env['COMPUTER_TEST_IMAGE'] ?? 'ocn-upload-computer:test';
  const source = resolve('.');
  const argumentsList = ['run', '--rm', '--network=none', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--entrypoint=nice',
    '-v', `${source}:/repo:ro`, image, '-n', '10', 'node', '--experimental-strip-types',
    '/repo/apps/computer/test/private-thread-load-native.mjs', name];
  const result = await execute('docker', argumentsList, { timeout: 25_000 });
  const observed = record(JSON.parse(result.stdout));
  expect(observed['version']).toBe('codex-cli 0.159.2');
  expect(observed['methods']).toContain('server/discover');
  expect(observed['methods']).toContain('tools/list');
  const protocols = array(observed['protocols']);
  expect(new Set(protocols)).toEqual(new Set(['2026-07-28']));
  expect(observed['unapprovedDiscoveries']).toBe(1);
  expect(observed['beforeApproval']).toBe(0);
  expect(observed['approvedId']).toBe(observed['startedId']);
  expect(record(observed['thread'])['id']).toBe(observed['startedId']);
  const listing = record(observed['listing']);
  const servers = array(listing['data']);
  expect(servers).toHaveLength(1);
  const server = record(servers[0]);
  const tools = record(server['tools']);
  expect(Object.keys(tools)).toEqual([name]);
  expect(observed['discovered']).toBe(true);
  expect(observed['thread']).toMatchObject({ ephemeral: true, path: null, environments: [] });
  expect(observed['grants']).toBe(0);
}
it.each(['recall', 'remember', 'correct'] as const)(
  'loads approved %s on the same native ephemeral thread', loadsNativePrivateCatalogue);

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected an array');
  return value;
}
