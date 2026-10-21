import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import * as files from 'node:fs/promises';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';

const directory = process.env['DEV_STACK_DIR'];
const recordFile = `${directory}/operations`;
const running = new Map();
let nextPid = 900000;
let switchedOn = false;
const containers = new Set();

function record(message) {
  appendFileSync(recordFile, `${message}\n`);
}
function snapshot() {
  const state = { processes: [...running.values()], containers: [...containers], switchedOn };
  writeFileSync(`${directory}/services.json`, JSON.stringify(state));
}
function failureAt(stage) {
  record(stage);
  if (process.env['START_FAILURE'] === stage) throw new Error(`Fixture failure: ${stage}`);
}

async function execute(command, args) {
  record(`exec ${command} ${args.join(' ')}`);
  if (args.includes('infra/dev-stack/journey.ts')) {
    throw new Error('Automated journey reached');
  }
  let stdout = '';
  if (command === 'tailscale') {
    if (args[0] === 'status') {
      stdout = JSON.stringify({ Self: { DNSName: 'owner.example.test.', TailscaleIPs: [] } });
    } else {
      stdout = '{}';
    }
  }
  if (command === 'kubectl') {
    if (args.includes('view')) stdout = '{"clusters":[{"cluster":{}}]}';
    else if (args.includes('namespace')) stdout = 'fixture-namespace';
    else stdout = 'fixture';
  }
  if (command === 'docker' && args.includes('compose')) {
    const services = ['postgres', 'nats', 'minio', 'clamav', 'openfga', 'models'];
    if (args.includes('ps')) stdout = [...containers].join('\n');
    for (const service of services) {
      if (args.includes('up') && args.includes(service)) containers.add(service);
      if (args.includes('stop') && args.includes(service)) containers.delete(service);
    }
    if (args.includes('down')) containers.clear();
    snapshot();
  }
  return { stdout, stderr: '' };
}
function execFixture() { throw new Error('Use the asynchronous command fixture'); }
execFixture[promisify.custom] = execute;
childProcess.execFile = execFixture;
function spawnFixture(_command, args) {
  const child = new EventEmitter();
  child.pid = nextPid++;
  child.unref = function unref() {};
  running.set(child.pid, args.join(' '));
  snapshot();
  function spawned() { child.emit('spawn'); }
  queueMicrotask(spawned);
  return child;
}
childProcess.spawn = spawnFixture;
const originalRead = files.readFile;
async function readFixture(path, ...args) {
  const match = /^\/proc\/(\d+)\/stat$/u.exec(String(path));
  if (!match) return originalRead(path, ...args);
  if (!running.has(Number(match[1]))) {
    const error = new Error('Fixture process stopped');
    error.code = 'ENOENT';
    throw error;
  }
  const fields = Array(22).fill('0');
  fields[0] = 'S';
  fields[16] = '10';
  fields[19] = 'fixture-start';
  return `${match[1]} (fixture) ${fields.join(' ')}`;
}
const fsDefault = (await import('node:fs/promises')).default;
fsDefault.readFile = readFixture;
process.kill = function killFixture(pid) {
  assert(pid < 0, 'Only fake process groups may be stopped');
  running.delete(-pid);
  snapshot();
  return true;
};
syncBuiltinESMExports();
Object.defineProperty(process.stdin, 'isTTY', { value: true });

async function fetchFixture(url) {
  record(`health ${url}`);
  if (String(url).endsWith('/org/integrations')) failureAt('after-switch-on');
  return new Response('ready');
}
globalThis.fetch = fetchFixture;

const configSource = `
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
export const directory = process.env.DEV_STACK_DIR;
export const root = process.cwd();
export const base = { PATH: '/nonexistent', HOME: process.env.HOME, DEV_STACK_ID: 'owner' };
export async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
export async function save(name, value) { await writeFile(directory + '/' + name, value); }
export async function readEnv(name) {
  const text = await readFile(directory + '/' + name + '.env', 'utf8');
  const values = {};
  for (const line of text.split('\\n')) {
    const split = line.indexOf('=');
    if (split >= 0) values[line.slice(0, split)] = line.slice(split + 1);
  }
  return values;
}
export async function writeEnv(name, values) {
  const lines = [];
  for (const [key, value] of Object.entries(values)) lines.push(key + '=' + value);
  await save(name + '.env', lines.join('\\n') + '\\n');
  if (name === 'settings' && values.DEV_REAL_PROVIDER === '1') {
    globalThis.startFixture.failureAt('saved-real-mode');
  }
}
export async function prepareDirectory() { await mkdir(directory, { recursive: true }); }
export async function generate(origin) {
  if (await exists(directory + '/settings.env')) return;
  await writeEnv('settings', { ORIGIN: origin, SILO_ID: 'fixture', OPENFGA_API_URL: 'https://fga.invalid' });
  for (const name of ['admin', 'projection', 'server', 'command', 'dispatcher', 'minio']) {
    await writeEnv(name, { DATABASE_URL: 'postgres://fixture.invalid/db' });
  }
  await save('database-ready', 'ready');
}
export async function authEnv() { return {}; }
`;
const replacements = new Map([
  ['/infra/dev-stack/config.ts', configSource],
  ['/infra/dev-stack/ports.ts', 'export async function checkPorts() { globalThis.startFixture.failureAt("infrastructure-check"); }'],
  ['/infra/dev-stack/model-network.ts', 'export async function modelFirewall() {}'],
  ['/infra/dev-stack/minio-tokens.ts', 'export async function issueMinioLease() {}'],
  ['/infra/dev-stack/provider-setup.ts', 'export async function setupDevProvider(settings, path) { await globalThis.startFixture.setup(path); }'],
]);
const packages = new Map([
  ['minio', 'export class Client { async bucketExists() { return true; } async setBucketLifecycle() {} }'],
  ['pg', 'export class Pool {}'],
  ['@opencrane/auth', 'export async function tokenIssuer() { return { jwks: {} }; }'],
  ['@opencrane/authz', 'export async function createStore() { return { silo: "fixture", apiUrl: "https://fga.invalid", storeId: "fixture", authorizationModelId: "fixture" }; }'],
  ['@opencrane/event-store', 'export async function connectEventStore() { return { store: { async head() { return 1; } }, async close() {} }; }'],
  ['@opencrane/models', 'export function readToolPolicy() {} export function envelope() { throw Error("Unexpected event"); } export async function managedProviderCallsEnabled() { return false; }'],
]);
async function setup(path) {
  assert.equal(path, '/synthetic-key-file');
  const settings = readFileSync(`${directory}/settings.env`, 'utf8');
  record(`mode-at-provider-check ${settings.includes('DEV_REAL_PROVIDER=1') ? 'real' : 'stub'}`);
  switchedOn = true;
  snapshot();
  const signal = process.env['START_SIGNAL'];
  if (signal) process.emit(signal);
}
globalThis.startFixture = { failureAt, setup };
function resolve(specifier, context, nextResolve) {
  if (packages.has(specifier)) return { url: `fixture:${specifier}`, shortCircuit: true };
  return nextResolve(specifier, context);
}
function load(url, context, nextLoad) {
  let source = packages.get(url.slice('fixture:'.length));
  for (const [suffix, replacement] of replacements) {
    if (url.endsWith(suffix)) source = replacement;
  }
  if (source !== undefined) return { format: 'module', source, shortCircuit: true };
  return nextLoad(url, context);
}
registerHooks({ resolve, load });
snapshot();
