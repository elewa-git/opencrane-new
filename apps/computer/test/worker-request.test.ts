import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { workerRequest } from '../src/worker-request.ts';

const npmArgv = ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'];
const gitArgv = ['git', 'clone', '--no-checkout', 'https://github.com/elewa-git/demo.git'];
const lockfile = JSON.stringify({ lockfileVersion: 3, packages: {
  '': { dependencies: { demo: '1.2.3' } },
  'node_modules/demo': { version: '1.2.3',
    resolved: 'https://registry.npmjs.org/demo/-/demo-1.2.3.tgz',
    integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
} });
function fixture(argv = npmArgv, input = lockfile) {
  const context = { executorId: 'executor-1', siloId: 'silo-1', personId: 'person-1',
    computerId: 'computer-1', processId: 'process-1', generation: 3 };
  const lookups: unknown[] = [];
  let consumed = false;
  function consume() {
    if (consumed) return false;
    consumed = true;
    return true;
  }
  const params = { processId: 'process-1', argv, cwd: 'file:///workspace', env: {},
tty: false, pipeStdin: false, arg0: null,
metadata: { threadId: 'thread-1', toolCallId: 'call-1' } };
  const hash = createHash('sha256');
  hash.update(JSON.stringify([argv, params.cwd, input]));
  const registration = { ...context, threadId: 'thread-1', toolCallId: 'call-1', turnId: 'turn-1',
operationId: 'operation-1', operationDigest: hash.digest('hex'), generation: 3,
host: argv[0] === 'npm' ? 'registry.npmjs.org' : 'github.com', port: 443,
expiresAt: 2000 };
  function lookup(identity: unknown) {
    lookups.push(identity);
    return { generation: context.generation, registration, input, consume };
  }
  const request = { id: 1, method: 'process/start', params };
  function validate() {
return workerRequest(Buffer.from(`${JSON.stringify(request)}\n`), lookup, context, 1000);
  }
  return { request, registration, context, lookups, lookup, consume, validate };
}

function checksInstall() {
  const test = fixture();
  const result = test.validate();
  expect(result.argv).toEqual(['/usr/bin/npm', 'ci', '--ignore-scripts', '--no-audit',
    '--no-fund', '--registry=https://registry.npmjs.org', '--userconfig=/dev/null',
    '--globalconfig=/dev/null']);
  expect(result.limits).toEqual({ wallMs: 300_000, idleMs: 30_000,
    outputBytes: 65_536, excerptLimit: 2000, frameBytes: 65_536 });
  expect(result.identity).toEqual(test.registration);
  expect(result.execution).toBe('disabled');
  test.registration.turnId = 'changed';
  expect(result.identity.turnId).toBe('turn-1');
  expect(Object.isFrozen(result.identity)).toBe(true);
  expect(Object.isFrozen(result.argv)).toBe(true);
}
it('prepares a locked install with fixed limits and immutable identity, without execution',
    checksInstall);

function checksClone() {
const result = fixture(gitArgv, '').validate();
expect(result.argv).toEqual(['/usr/bin/git', '-c', 'credential.helper=', '-c',
  'core.hooksPath=/var/empty', '-c', 'protocol.allow=never', '-c',
  'protocol.https.allow=always', '-c', 'http.followRedirects=false', 'clone',
  '--no-checkout', '--no-recurse-submodules', '--template=/var/empty', '--',
  'https://github.com/elewa-git/demo.git', '/operation/repository']);
expect(result.env).toEqual({ HOME: '/operation', PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '0' });
}
it('prepares HTTPS clone with configuration, helpers, hooks and checkout disabled', checksClone);

function refusesChangedRegistration(field: string) {
  const test = fixture();
  let value: string | number = 'other';
  if (field === 'expiresAt') value = 999;
  if (field === 'generation') value = 2;
  if (field === 'port') value = 444;
  Object.assign(test.registration, { [field]: value });
  expect(test.validate).toThrow('worker_request_refused');
}
it.each(['threadId', 'toolCallId', 'operationDigest', 'generation', 'host', 'port', 'expiresAt'])(
  'refuses a mismatched or stale registered %s', refusesChangedRegistration);
function refusesSibling(field: string) {
const test = fixture();
Object.assign(test.request.params.metadata, { [field]: 'sibling' });
expect(test.validate).toThrow('worker_request_refused');
}
it.each(['threadId', 'toolCallId'])('refuses sibling metadata %s', refusesSibling);
function refusesCommand(...argv: string[]) {
expect(fixture(argv).validate).toThrow('worker_request_refused');
}
it.each([
['bash', '-c', 'npm ci'], ['sh', '-c', 'npm ci | cat'],
['npm', 'install', 'demo@latest'], ['npm', 'install', 'demo@1.2.3'],
[...npmArgv, '--ignore-scripts=false'], [...npmArgv, '$(id)'],
['git', 'clone', '--recursive', gitArgv[3]!],
['git', '-c', 'filter.lfs.process=evil', 'clone', gitArgv[3]!],
[...gitArgv, '--upload-pack=evil'], [...gitArgv, '--config=core.hooksPath=/tmp'],
[...gitArgv, '--recurse-submodules'], [...gitArgv, '--config=credential.helper=evil'],
])('refuses unsupported command %j', refusesCommand);
function refusesDestination(destination: string) {
expect(fixture(['git', 'clone', '--no-checkout', destination], '').validate)
  .toThrow('worker_request_refused');
}
it.each(['http://github.com/a.git', 'https://127.0.0.1/a.git', 'https://[::1]/a.git',
'https://user:canary@github.com/a.git', 'https://github.com/a.git?canary',
'git@github.com:a.git', 'ext::evil', 'https://github.com/a.git#main',
'https://github.com/%2e%2e/a.git', 'https://github.com/../a.git',
])('refuses unsafe Git destination %s', refusesDestination);
function refusesEnvironment(key: string) {
const test = fixture();
test.request.params.env = { [key]: 'canary' };
expect(test.validate).toThrow(/^worker_request_refused$/);
}
it.each(['HTTPS_PROXY', 'npm_config_userconfig', 'GIT_CONFIG_COUNT', 'GIT_ASKPASS',
'NODE_OPTIONS', 'TOKEN'])('refuses inherited setting %s without echoing it', refusesEnvironment);
function refusesSettings(settings: Record<string, unknown>) {
  const test = fixture();
  Object.assign(test.request.params, settings);
  expect(test.validate).toThrow('worker_request_refused');
}
it.each([{ envPolicy: { inherit: 'all' } }, { shellSnapshot: {} }, { networkProxy: {} },
  { tty: true }, { pipeStdin: true }, { arg0: 'sh' }, { extra: 'canary' },
  { metadata: {} }, { cwd: 'file:///workspace/../home/codex' }])(
  'refuses unsupported process settings %j', refusesSettings);
function refusesLockfile(input: string) {
  expect(fixture(npmArgv, input).validate).toThrow('worker_request_refused');
}
it.each([
  lockfile.replace('https://registry.npmjs.org', 'https://evil.org'),
  lockfile.replace('https://registry.npmjs.org', 'http://registry.npmjs.org'),
  lockfile.replace('https://registry.npmjs.org', 'https://canary@registry.npmjs.org'),
  lockfile.replace('sha512-', 'sha1-'), lockfile.replaceAll('1.2.3', '^1.2.3'),
  lockfile.replace('node_modules/demo', '../demo'),
  lockfile.replace('"version":"1.2.3"', '"version":"1.2.3","link":true'),
  lockfile.replace('"version":"1.2.3"', '"version":"1.2.3","hasInstallScript":true'),
  '{"lockfileVersion":3}', '{}', lockfile.padEnd(65_537, ' '),
])('refuses unpinned or unsafe lock input %#', refusesLockfile);
function refusesFrame(frame: string) {
  const test = fixture();
  function validate() {
    return workerRequest(Buffer.from(frame), test.lookup, test.context, 1000);
  }
  expect(validate).toThrow(/^worker_request_refused$/);
}
it.each(['', '{}\n', '{"method":"worker/register"}\n', '{',
  ' '.repeat(65_537), '{"id":1}\n{"id":2}\n'])('refuses invalid IPC frame %#', refusesFrame);
function refusesPartial() {
  const test = fixture();
  const partial = Buffer.from(JSON.stringify(test.request));
  function validate() { return workerRequest(partial, test.lookup, test.context, 1000); }
  expect(validate).toThrow('worker_request_refused');
}
it('requires exactly one complete bounded frame', refusesPartial);
function refusesCallerRegistration() {
  const test = fixture();
  function missing() { return undefined; }
  function validateMissing() {
    return workerRequest(Buffer.from(`${JSON.stringify(test.request)}\n`), missing, test.context, 1000);
  }
  expect(validateMissing).toThrow('worker_request_refused');
  Object.assign(test.request, { registration: test.registration });
  expect(test.validate).toThrow('worker_request_refused');
}
it('refuses missing registration and does not accept a request-owned registration', refusesCallerRegistration);
function stripsExtraFields() {
  const test = fixture();
  Object.assign(test.registration, { bearer: 'canary' });
  const result = test.validate();
  expect(JSON.stringify(result)).not.toContain('canary');
  expect(result.env).toEqual({ HOME: '/operation', PATH: '/usr/bin:/bin' });
  expect(Object.isFrozen(result.env)).toBe(true);
  expect(Object.isFrozen(result.limits)).toBe(true);
}
it('does not copy extra trusted fields or inherited process settings into a plan', stripsExtraFields);
function boundsValidFrames() {
  const test = fixture();
  const json = JSON.stringify(test.request);
  const maximum = Buffer.from(`${json.padEnd(65_535, ' ')}\n`);
  expect(workerRequest(maximum, test.lookup, test.context, 1000).execution).toBe('disabled');
  const oversizedTest = fixture();
  function oversized() {
    const frame = Buffer.from(`${json.padEnd(65_536, ' ')}\n`);
    return workerRequest(frame, oversizedTest.lookup, oversizedTest.context, 1000);
  }
  expect(oversized).toThrow('worker_request_refused');
}
it('bounds a valid frame by bytes including its final newline', boundsValidFrames);

const ownerFields = ['executorId', 'siloId', 'personId', 'computerId'] as const;
function refusesCopiedRequest(field: typeof ownerFields[number]) {
  const test = fixture();
  test.context[field] = 'another-owner';
  expect(test.context.generation).toBe(test.registration.generation);
  expect(test.validate).toThrow(/^worker_request_refused$/);
  expect(test.consume()).toBe(true);
}
it.each(ownerFields)(
  'refuses copied valid metadata and input from another %s at the same generation',
  refusesCopiedRequest);

function refusesForeignRegistration(field: typeof ownerFields[number]) {
  const test = fixture();
  test.registration[field] = 'another-owner';
  expect(test.validate).toThrow(/^worker_request_refused$/);
}
it.each(ownerFields)('refuses a lookup returning another %s', refusesForeignRegistration);

function refusesForgedProcessId() {
  const test = fixture();
  test.request.params.processId = 'forged-process';
  expect(test.validate).toThrow(/^worker_request_refused$/);
  expect(test.lookups).toEqual([]);
}
it('refuses a forged processId before reading a registration', refusesForgedProcessId);

function refusesDifferentRegisteredProcess() {
  const test = fixture();
  test.registration.processId = 'another-process';
  expect(test.validate).toThrow(/^worker_request_refused$/);
}
it('checks the registered process against the trusted connection binding',
  refusesDifferentRegisteredProcess);

function looksUpBoundIdentity() {
  const test = fixture();
  test.validate();
  expect(test.lookups).toEqual([{ executorId: 'executor-1', siloId: 'silo-1',
    personId: 'person-1', computerId: 'computer-1', processId: 'process-1', generation: 3 }]);
}
it('looks up by the trusted binding without caller thread or call metadata', looksUpBoundIdentity);

function refusesReuse(changeRequestId: boolean) {
  const test = fixture();
  expect(test.validate().execution).toBe('disabled');
  if (changeRequestId) test.request.id = 2;
  expect(test.validate).toThrow(/^worker_request_refused$/);
}
it.each([false, true])('consumes a registration once even when the request id changes: %s',
  refusesReuse);

function refusesAlreadyConsumed() {
  const test = fixture();
  expect(test.consume()).toBe(true);
  expect(test.validate).toThrow(/^worker_request_refused$/);
}
it('refuses a registration already consumed through another lookup', refusesAlreadyConsumed);

function preservesRegistrationAfterRefusal() {
  const test = fixture();
  test.request.params.metadata.toolCallId = 'forged-call';
  expect(test.validate).toThrow(/^worker_request_refused$/);
  test.request.params.metadata.toolCallId = 'call-1';
  expect(test.validate().execution).toBe('disabled');
  expect(test.validate).toThrow(/^worker_request_refused$/);
}
it('consumes only after every request check passes', preservesRegistrationAfterRefusal);

function refusesMissingBinding() {
  const test = fixture();
  function validate() {
    const frame = Buffer.from(`${JSON.stringify(test.request)}\n`);
    return workerRequest(frame, test.lookup, undefined, 1000);
  }
  expect(validate).toThrow(/^worker_request_refused$/);
  expect(test.lookups).toEqual([]);
}
it('refuses a missing trusted connection binding before lookup', refusesMissingBinding);

function refusesEmptyBinding(field: typeof ownerFields[number] | 'processId') {
  const test = fixture();
  test.context[field] = '';
  test.registration[field] = '';
  test.request.params.processId = test.context.processId;
  expect(test.validate).toThrow(/^worker_request_refused$/);
}
it.each([...ownerFields, 'processId'] as const)(
  'refuses an empty %s even when registration and binding match', refusesEmptyBinding);

function refusesUnsafeGeneration(generation: number) {
  const test = fixture();
  test.context.generation = generation;
  test.registration.generation = generation;
  expect(test.validate).toThrow(/^worker_request_refused$/);
}
it.each([1.5, Number.MAX_SAFE_INTEGER + 1])(
  'refuses an unsafe generation in both registration and binding: %s', refusesUnsafeGeneration);
