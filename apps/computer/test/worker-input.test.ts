import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
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
