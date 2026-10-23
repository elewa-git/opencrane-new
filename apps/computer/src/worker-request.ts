import { createHash } from 'node:crypto';
import { record } from './http.ts';

type Registration = Readonly<{
  threadId: string; toolCallId: string; turnId: string; operationId: string;
  operationDigest: string; generation: number; host: string; port: number; expiresAt: number;
}>;
type Lookup = (threadId: string, toolCallId: string) => {
  generation: number; registration: Registration; input: string;
} | undefined;

const limits = Object.freeze({ wallMs: 300_000, idleMs: 30_000,
  outputBytes: 65_536, excerptLimit: 2000, frameBytes: 65_536 });
const npmForm = ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'];
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

function only(value: Record<string, unknown>, keys: string[]) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error();
  }
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error();
  return value;
}
function httpsDestination(value: string) {
  const url = new URL(value);
  const hostname = url.hostname;
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.href !== value || !/^[a-z0-9.-]+\.[a-z]{2,63}$/u.test(hostname) ||
      /[%\\\s]/u.test(value)) throw new Error();
  for (const label of hostname.split('.')) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) throw new Error();
  }
  return { host: hostname, port: Number(url.port || 443) };
}
function pinnedDependencies(raw: unknown, packages: Record<string, unknown>) {
  if (raw === undefined) return;
  const dependencies = record(raw);
  for (const [name, pinned] of Object.entries(dependencies)) {
    if (!packageName.test(name) || !version.test(text(pinned))) throw new Error();
    const installed = record(packages[`node_modules/${name}`]);
    if (installed['version'] !== pinned) throw new Error();
  }
}
function checkLockfile(input: string) {
  const lock = record(JSON.parse(input));
  only(lock, ['lockfileVersion', 'packages']);
  if (lock['lockfileVersion'] !== 3) throw new Error();
  const packages = record(lock['packages']);
  const root = record(packages['']);
  only(root, ['dependencies']);
  pinnedDependencies(root['dependencies'], packages);
  if (Object.keys(packages).length < 2) throw new Error();
  for (const [path, raw] of Object.entries(packages)) {
    if (path === '') continue;
    const name = path.slice('node_modules/'.length);
    if (!path.startsWith('node_modules/') || !packageName.test(name)) throw new Error();
    const entry = record(raw);
    only(entry, ['version', 'resolved', 'integrity', 'dependencies']);
    const pinned = text(entry['version']);
    if (!version.test(pinned)) throw new Error();
    const resolved = text(entry['resolved']);
    const destination = httpsDestination(resolved);
    const segments = name.split('/');
    const basename = segments.at(-1)!;
    const expected = `https://registry.npmjs.org/${name}/-/${basename}-${pinned}.tgz`;
    if (destination.host !== 'registry.npmjs.org' || resolved !== expected) throw new Error();
    const integrity = text(entry['integrity']);
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity)) throw new Error();
    pinnedDependencies(entry['dependencies'], packages);
  }
}
function operation(argv: string[], input: string) {
  if (JSON.stringify(argv) === JSON.stringify(npmForm)) {
    checkLockfile(input);
    const fixed = ['/usr/bin/npm', ...npmForm.slice(1), '--registry=https://registry.npmjs.org',
      '--userconfig=/dev/null', '--globalconfig=/dev/null'];
    return { argv: fixed, host: 'registry.npmjs.org', port: 443,
      env: { HOME: '/operation', PATH: '/usr/bin:/bin' } };
  }
  if (argv.length !== 4 || argv[0] !== 'git' || argv[1] !== 'clone' ||
      argv[2] !== '--no-checkout' || input !== '') throw new Error();
  const url = text(argv[3]);
  const destination = httpsDestination(url);
  if (!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*\.git$/u.test(new URL(url).pathname)) {
    throw new Error();
  }
  const fixed = ['/usr/bin/git', '-c', 'credential.helper=', '-c',
    'core.hooksPath=/var/empty', '-c', 'protocol.allow=never', '-c',
    'protocol.https.allow=always', '-c', 'http.followRedirects=false', 'clone',
    '--no-checkout', '--no-recurse-submodules', '--template=/var/empty', '--',
    url, '/operation/repository'];
  const env = { HOME: '/operation', PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '0' };
  return { argv: fixed, ...destination, env };
}
function startFrame(frame: Buffer) {
  if (frame.length > limits.frameBytes || frame.at(-1) !== 10 ||
      frame.subarray(0, -1).includes(10)) throw new Error();
  const request = record(JSON.parse(frame.toString('utf8')));
  only(request, ['id', 'method', 'params']);
  if (request['method'] !== 'process/start' || !Number.isSafeInteger(request['id'])) {
    throw new Error();
  }
  const params = record(request['params']);
  only(params, ['processId', 'argv', 'cwd', 'env', 'tty', 'pipeStdin', 'arg0', 'metadata']);
  text(params['processId']);
  if (params['cwd'] !== 'file:///workspace' || params['tty'] !== false ||
      params['pipeStdin'] !== false || params['arg0'] !== null ||
      Object.keys(record(params['env'])).length !== 0) throw new Error();
  const metadata = record(params['metadata']);
  only(metadata, ['threadId', 'toolCallId']);
  const argv = params['argv'];
  if (!Array.isArray(argv)) throw new Error();
  const checked = argv.map(text);
  return { argv: checked, cwd: params['cwd'], threadId: text(metadata['threadId']),
    toolCallId: text(metadata['toolCallId']) };
}

// Read registrations only from supervisor-owned state, never from the request.
// Native delivery is not proved yet; production supplies no registration.
export function workerRequest(frame: Buffer, lookup: Lookup, now = Date.now()) {
  try {
    const request = startFrame(frame);
    const live = lookup(request.threadId, request.toolCallId);
    if (!live || Buffer.byteLength(live.input) > limits.frameBytes) throw new Error();
    const saved = live.registration;
    if (saved.threadId !== request.threadId || saved.toolCallId !== request.toolCallId ||
        saved.generation !== live.generation || !Number.isSafeInteger(saved.generation) ||
        !Number.isSafeInteger(saved.expiresAt) || now >= saved.expiresAt) throw new Error();
    const prepared = operation(request.argv, live.input);
    if (prepared.host !== saved.host || prepared.port !== saved.port) throw new Error();
    const hash = createHash('sha256');
    hash.update(JSON.stringify([request.argv, request.cwd, live.input]));
    if (hash.digest('hex') !== saved.operationDigest) throw new Error();
    // Copy only reviewed identity fields; never copy credentials from trusted state either.
    const identity = Object.freeze({ threadId: saved.threadId, toolCallId: saved.toolCallId,
      turnId: text(saved.turnId), operationId: text(saved.operationId),
      operationDigest: saved.operationDigest, generation: saved.generation,
      host: saved.host, port: saved.port, expiresAt: saved.expiresAt });
    return Object.freeze({ execution: 'disabled' as const, argv: Object.freeze(prepared.argv),
      env: Object.freeze(prepared.env), cwd: '/operation', identity, limits });
  } catch {
    throw new Error('worker_request_refused');
  }
}
