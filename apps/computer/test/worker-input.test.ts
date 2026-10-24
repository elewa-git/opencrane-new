import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { workerRequest } from '../src/worker-request.ts';
import { workerRegistrations } from '../src/worker-registrations.ts';
import { prepareWorkerInput } from '../src/worker-input.ts';

const npmArgv = ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'];
const gitArgv = ['git', 'clone', '--no-checkout', 'https://github.com/example/demo.git'];
const lockfile = '{"lockfileVersion":3,"packages":{"":{"dependencies":{"demo":"1.2.3"}},' +
  '"node_modules/demo":{"version":"1.2.3",' +
  '"resolved":"https://registry.npmjs.org/demo/-/demo-1.2.3.tgz",' +
  '"integrity":"sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAA=="}}}';
const roots: string[] = [];
const cleanups: (() => void)[] = [];
function parent() {
  const path = fs.mkdtempSync(`${homedir()}/worker-input-`);
  roots.push(path);
  return path;
}
function request(argv = npmArgv, input = lockfile, operationId = 'operation-1') {
  const context = { executorId: 'executor', siloId: 'silo', personId: 'person',
    computerId: 'computer', processId: 'process', generation: 1 };
  const store = workerRegistrations(context, now);
  const hash = createHash('sha256');
  hash.update(JSON.stringify([argv, 'file:///workspace', input]));
  const registration = { ...context, threadId: 'thread', toolCallId: 'call', turnId: 'turn',
    operationId, operationDigest: hash.digest('hex'),
    host: argv[0] === 'npm' ? 'registry.npmjs.org' : 'github.com', port: 443, expiresAt: 2000 };
  store.register(registration, input);
  const params = { processId: 'process', argv, cwd: 'file:///workspace', env: {},
    tty: false, pipeStdin: false, arg0: null, metadata: { threadId: 'thread', toolCallId: 'call' } };
  const frame = Buffer.from(`${JSON.stringify({ id: 1, method: 'process/start', params })}\n`);
  function validate() { return workerRequest(frame, store.lookup, context, 1000); }
  return { validate, store, registration };
}
function now() { return 1000; }
function cleanup() {
  vi.restoreAllMocks();
  for (const dispose of cleanups.splice(0)) dispose();
  for (const path of roots.splice(0)) fs.rmSync(path, { recursive: true, force: true });
}
afterEach(cleanup);

function preparesNpm() {
  const base = parent();
  const checked = request();
  const plan = checked.validate();
  const prepared = prepareWorkerInput(plan, base);
  cleanups.push(prepared.cleanup);
  const work = `${base}/operation-1/operation`;
  expect(fs.readFileSync(`${work}/package-lock.json`, 'utf8')).toBe(lockfile);
  expect(fs.readFileSync(`${work}/package.json`, 'utf8'))
    .toBe('{"private":true,"dependencies":{"demo":"1.2.3"}}');
  expect(JSON.stringify(plan)).not.toContain('integrity');
  expect(plan.identity.operationDigest).toBe(checked.registration.operationDigest);
  for (const name of ['operation', 'tmp', 'cache', 'config', 'var', 'var/empty']) {
    expect(fs.statSync(`${base}/operation-1/${name}`).mode & 0o777).toBe(0o700);
  }
  expect(fs.statSync(`${work}/package-lock.json`).mode & 0o777).toBe(0o600);
  prepared.cleanup();
  expect(fs.readdirSync(base)).toEqual([]);
}
it('copies only the checked npm bytes and manifest into private locations', preparesNpm);

function preparesGit() {
  const base = parent();
  fs.writeFileSync(`${base}/private-canary`, 'private-canary');
  const prepared = prepareWorkerInput(request(gitArgv, '').validate(), base);
  cleanups.push(prepared.cleanup);
  for (const name of ['operation', 'tmp', 'cache', 'config', 'var/empty']) {
    expect(fs.readdirSync(`${base}/operation-1/${name}`)).toEqual([]);
  }
  prepared.cleanup();
  expect(fs.readFileSync(`${base}/private-canary`, 'utf8')).toBe('private-canary');
}
it('gives Git empty work, config and template folders without inherited files', preparesGit);

function refusesCopiedPlan() {
  const base = parent();
  const plan = request().validate();
  function copied() { return prepareWorkerInput({ ...plan }, base); }
  expect(copied).toThrow(/^worker_input_refused$/);
  expect(fs.readdirSync(base)).toEqual([]);
  const prepared = prepareWorkerInput(plan, base);
  prepared.cleanup();
  function reused() { return prepareWorkerInput(plan, base); }
  expect(reused).toThrow(/^worker_input_refused$/);
  expect(fs.readdirSync(base)).toEqual([]);
}
it('refuses copied plans and a second preparation of the same checked input', refusesCopiedPlan);

function refusesParent(kind: string) {
  const base = parent();
  let selected = base;
  if (kind === 'writable') fs.chmodSync(base, 0o720);
  if (kind === 'readable') fs.chmodSync(base, 0o750);
  if (kind === 'symlink') {
    selected = `${base}/private-canary`;
    fs.symlinkSync(base, selected);
  }
  if (kind === 'ancestor-link') {
    fs.symlinkSync(base, `${base}/link`);
    fs.mkdirSync(`${base}/child`, { mode: 0o700 });
    selected = `${base}/link/child`;
  }
  if (kind === 'traversal') selected = `${base}/../private-canary`;
  if (kind === 'foreign') {
    const original = fs.fstatSync;
    const identity = fs.statSync(base);
    function foreignOwner(...args: Parameters<typeof fs.fstatSync>) {
      const stat = original(...args);
      if (stat.ino === identity.ino) stat.uid = 12345;
      return stat;
    }
    vi.spyOn(fs, 'fstatSync').mockImplementation(foreignOwner);
  }
  function prepare() { return prepareWorkerInput(request().validate(), selected); }
  const before = fs.readdirSync(base);
  expect(prepare).toThrow(/^worker_input_refused$/);
  expect(fs.readdirSync(base)).toEqual(before);
}
it.each(['writable', 'readable', 'symlink', 'ancestor-link', 'traversal', 'foreign'])(
  'refuses a %s parent without changing it', refusesParent);

function refusesExisting(kind: string) {
  const base = parent();
  const target = parent();
  fs.writeFileSync(`${target}/private-canary`, 'private-canary');
  const operation = `${base}/operation-1`;
  if (kind === 'directory') fs.mkdirSync(operation);
  if (kind === 'symlink') fs.symlinkSync(target, operation);
  if (kind === 'file') fs.writeFileSync(operation, 'private-canary');
  function prepare() { return prepareWorkerInput(request().validate(), base); }
  const before = fs.lstatSync(operation);
  expect(prepare).toThrow(/^worker_input_refused$/);
  expect(fs.lstatSync(operation).ino).toBe(before.ino);
  expect(fs.readFileSync(`${target}/private-canary`, 'utf8')).toBe('private-canary');
}
it.each(['directory', 'symlink', 'file'])(
  'refuses a pre-existing operation %s without changing its target', refusesExisting);

function refusesTraversal(operationId: string) {
  const base = parent();
  function prepare() {
    return prepareWorkerInput(request(npmArgv, lockfile, operationId).validate(), base);
  }
  expect(prepare).toThrow(/^worker_input_refused$/);
  expect(fs.readdirSync(base)).toEqual([]);
}
it.each(['../private-canary', '/private-canary', '.', 'a/b', 'a\0b'])(
  'refuses an unsafe operation name %# before writing', refusesTraversal);

function keepsOperationsSeparate() {
  const base = parent();
  const first = prepareWorkerInput(request().validate(), base);
  const second = prepareWorkerInput(request(gitArgv, '', 'operation-2').validate(), base);
  cleanups.push(first.cleanup, second.cleanup);
  fs.renameSync(`${base}/operation-1`, `${base}/moved`);
  fs.renameSync(`${base}/operation-2`, `${base}/operation-1`);
  first.cleanup();
  expect(fs.readdirSync(`${base}/operation-1/operation`)).toEqual([]);
  expect(fs.existsSync(`${base}/operation-1/tmp`)).toBe(true);
  expect(fs.readdirSync(`${base}/moved`)).toEqual([]);
  second.cleanup();
}
it('retains owned identities when another operation replaces the root before cleanup',
  keepsOperationsSeparate);

function refusesInvalidInput(input: string) {
  const base = parent();
  function prepare() { return prepareWorkerInput(request(npmArgv, input).validate(), base); }
  expect(prepare).toThrow(/^worker_(request|registration)_refused$/);
  expect(fs.readdirSync(base)).toEqual([]);
}
it.each(['private-canary', lockfile.padEnd(65_537, ' ')])(
  'refuses invalid or oversized bytes without writing %#', refusesInvalidInput);

function removesPartialPreparation() {
  const base = parent();
  const original = fs.writeFileSync;
  function failWrite(...args: Parameters<typeof fs.writeFileSync>) {
    original(...args);
    throw new Error('private-canary');
  }
  vi.spyOn(fs, 'writeFileSync').mockImplementation(failWrite);
  const checked = request();
  function prepare() { return prepareWorkerInput(checked.validate(), base); }
  expect(prepare).toThrow(/^worker_input_refused$/);
  expect(fs.readdirSync(base)).toEqual([]);
  expect(checked.validate).toThrow(/^worker_request_refused$/);
}
it('removes partial owned files and never restores consumed permission', removesPartialPreparation);

function refusesReplacement(kind: string) {
  const base = parent();
  const target = parent();
  const canary = `${target}/private-canary`;
  fs.writeFileSync(canary, 'private-canary');
  const original = fs.openSync;
  let replaced = false;
  function replaceAfterOpen(...args: Parameters<typeof fs.openSync>) {
    const descriptor = original(...args);
    const path = String(args[0]);
    const selected = kind === 'directory' ? '/operation' : '/package.json';
    if (!replaced && path.endsWith(selected)) {
      replaced = true;
      fs.renameSync(path, `${base}/saved`);
      if (kind === 'hardlink') fs.linkSync(canary, path);
      else fs.symlinkSync(kind === 'directory' ? target : canary, path);
    }
    return descriptor;
  }
  vi.spyOn(fs, 'openSync').mockImplementation(replaceAfterOpen);
  function prepare() { return prepareWorkerInput(request().validate(), base); }
  expect(prepare).toThrow(/^worker_input_refused$/);
  expect(replaced).toBe(true);
  expect(fs.readFileSync(canary, 'utf8')).toBe('private-canary');
  expect(fs.readdirSync(target)).toEqual(['private-canary']);
}
it.each(['directory', 'file', 'hardlink'])(
  'refuses a replacement %s during preparation without touching its target', refusesReplacement);

function refusesNewHardlink() {
  const base = parent();
  const original = fs.writeFileSync;
  let linked = false;
  function addLink(...args: Parameters<typeof fs.writeFileSync>) {
    original(...args);
    if (!linked) {
      linked = true;
      fs.linkSync(`${base}/operation-1/operation/package.json`, `${base}/extra`);
    }
  }
  vi.spyOn(fs, 'writeFileSync').mockImplementation(addLink);
  function prepare() { return prepareWorkerInput(request().validate(), base); }
  expect(prepare).toThrow(/^worker_input_refused$/);
  expect(fs.existsSync(`${base}/extra`)).toBe(true);
}
it('refuses an extra hard link made while writing and leaves unowned entries alone',
  refusesNewHardlink);
