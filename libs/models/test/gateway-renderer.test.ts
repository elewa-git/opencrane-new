import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { gatewayConfigurationSchema } from '@opencrane/events';
import { renderGatewayConfiguration, type GatewayRenderSettings } from '../src/index.ts';
import { publicationDigest } from '../src/publication.ts';
import { gatewayConfig } from '../src/gateway.ts';

type Configuration = ReturnType<typeof gatewayConfigurationSchema.parse>;
type Entry = Configuration['members'][number]['entry'];
const digest = 'a'.repeat(64);
const canary = 'PRIVATE-CANARY-renderer';
const settings: GatewayRenderSettings = {
  port: 3100, readinessPort: 3101, decisionUrl: 'http://127.0.0.1:3102',
  issuer: 'opencrane-test', keyFile: '/absent/provider-key', upstream: '127.0.0.1:3103',
  egressDecisionUrl: 'http://127.0.0.1:3104',
  memoryRoute: { serverId: 'memory', connectionId: 'internal', upstream: 'unused' },
};
const routeSchema = z.looseObject({ name: z.string() });
const configSchema = z.looseObject({ routes: z.array(routeSchema) });

function entry(serverId: string): Entry {
  return { serverId, connectionId: 'installed', accountMode: 'none',
    reviewRevision: 7, catalogueDigest: digest, tools: [
      { name: 'read', mode: 'allow', revision: digest, reviewDigest: digest },
      { name: 'write', mode: 'ask', revision: digest, reviewDigest: digest },
      { name: 'delete', mode: 'block', revision: digest, reviewDigest: digest },
    ] };
}
function member(value: Entry) {
  return { entry: value, changeRef: `publish-${value.serverId}`, sourceSequence: 9,
    fragmentDigest: publicationDigest(value) };
}
function record(entries = [entry('alpha'), entry('bravo')]): Configuration {
  const members = entries.map(member);
  const saved = { changeRef: 'publish-bravo', generation: 2, rendererVersion: '1', members };
  return gatewayConfigurationSchema.parse({ ...saved, recordDigest: publicationDigest(saved) });
}
function routes(value: Configuration, fixed = settings) {
  const rendered = renderGatewayConfiguration(value, fixed);
  const parsed: unknown = JSON.parse(rendered.configBytes.toString('utf8'));
  return configSchema.parse(parsed).routes;
}
function route(value: Configuration, name: string) {
  function named(candidate: z.infer<typeof routeSchema>) {
    return candidate.name === name;
  }
  return routes(value).find(named)!;
}
function refuses(value: unknown, fixed = settings) {
  function render() {
    return renderGatewayConfiguration(value, fixed);
  }
  expect(render).toThrow('Gateway configuration refused');
  try {
    render();
  } catch (error) {
    expect(String(error)).not.toContain(canary);
  }
}

function deterministicReplay() {
  const saved = record();
  const before = structuredClone(saved);
  const replayed: unknown = JSON.parse(JSON.stringify(saved));
  const first = renderGatewayConfiguration(saved, settings);
  const second = renderGatewayConfiguration(replayed, settings);
  expect(Buffer.isBuffer(first.configBytes)).toBe(true);
  expect(second).toEqual(first);
  expect(renderGatewayConfiguration(saved, settings)).toEqual(first);
  const hash = createHash('sha256');
  hash.update(first.configBytes);
  expect(first.configDigest).toBe(hash.digest('hex'));
  expect(saved).toEqual(before);
  const corrupt = { ...saved, recordDigest: 'b'.repeat(64) };
  refuses(corrupt);
}
it('renders identical bytes and their SHA-256 from a saved or replayed record', deterministicReplay);

function completeRoutes() {
  const saved = record();
  const renderedRoutes = routes(saved);
  expect(renderedRoutes).toHaveLength(8);
  expect(route(saved, 'models')).toMatchObject({
    matches: [{ path: { exact: '/v1/responses' }, method: 'POST' }],
    backends: [{ policies: { backendAuth: { key: { file: settings.keyFile } } } }],
  });
  expect(route(saved, 'mcp-memory-internal')).not.toHaveProperty('policies.authorization');
  for (const serverId of ['alpha', 'bravo']) {
    const path = `/mcp/${serverId}/installed`;
    expect(route(saved, `mcp-${serverId}-installed`)).toMatchObject({
      matches: [{ path: { exact: path }, method: 'POST' }],
      policies: {
        authorization: { rules: [
          'request.method == "POST" && ' +
          'default(request.headers.join()["mcp-method"], "") == "tools/call" && ' +
          'default(request.headers.join()["mcp-name"], "") in ["read","write"]',
        ] },
        extAuthz: { protocol: { http: { addRequestHeaders: {
          'x-opencrane-gateway-generation': '"2"',
          'x-opencrane-record-digest': JSON.stringify(saved.recordDigest),
          'x-opencrane-server-id': JSON.stringify(serverId),
          'x-opencrane-connection-id': '"installed"',
          'x-opencrane-review-revision': '"7"',
        } } } },
        transformations: { request: { replace:
          '{"content-type":"application/json", "accept":"application/json", ' +
          '"mcp-protocol-version":request.headers["mcp-protocol-version"], ' +
          '"mcp-method":request.headers["mcp-method"], ' +
          '"mcp-name":request.headers["mcp-name"], ' +
          '"x-request-id":request.headers["x-request-id"], ' +
          '"x-opencrane-mcp-permit":request.headers["x-opencrane-mcp-permit"]}' } },
        urlRewrite: { path: { full: `/dispatch${path}` } },
      }, backends: [{ host: '127.0.0.1:3102' }],
    });
  }
}
it('renders fixed routes and each reviewed member with its own rule and constants', completeRoutes);

function changesOnlyMember(field: 'mode' | 'review' | 'connection') {
  const original = record();
  const changed = entry('alpha');
  if (field === 'mode') {
    changed.tools[0]!.mode = 'block';
  }
  if (field === 'review') {
    changed.reviewRevision++;
  }
  if (field === 'connection') {
    changed.connectionId = 'replacement';
  }
  const next = record([changed, entry('bravo')]);
  const first = renderGatewayConfiguration(original, settings);
  const second = renderGatewayConfiguration(next, settings);
  expect(second.configDigest).not.toBe(first.configDigest);
  const changedName = `mcp-alpha-${changed.connectionId}`;
  expect(route(next, changedName)).not.toEqual(route(original, 'mcp-alpha-installed'));
  // Keep other routes identical apart from the digest of the complete record they carry.
  const before = JSON.stringify(route(original, 'mcp-bravo-installed'));
  const after = JSON.stringify(route(next, 'mcp-bravo-installed'));
  expect(after.replaceAll(next.recordDigest, original.recordDigest)).toBe(before);
  expect(route(next, 'models')).toEqual(route(original, 'models'));
}
it.each(['mode', 'review', 'connection'] as const)('isolates a member %s change', changesOnlyMember);

function invalidMembers(kind: string) {
  const first = entry('alpha');
  const second = entry('bravo');
  if (kind === 'server' || kind === 'path') {
    second.serverId = 'alpha';
  }
  if (kind === 'server') {
    second.connectionId = 'different';
  }
  if (kind === 'memory') {
    first.serverId = 'memory';
    first.connectionId = 'internal';
  }
  if (kind === 'personal' || kind === 'company') {
    first.accountMode = kind;
  }
  if (kind === 'duplicate tool') {
    first.tools.push(first.tools[0]!);
  }
  refuses(record([first, second]));
}
it.each(['server', 'path', 'memory', 'personal', 'company', 'duplicate tool'])(
  'refuses an invalid %s before returning any bytes', invalidMembers);

function unsafeName(name: string) {
  const unsafe = entry('alpha');
  unsafe.tools[2]!.name = name;
  refuses(record([unsafe]));
}
it.each(['a" || true || "', 'read\n', 'read,write', 'read && write', 'a'.repeat(129),
  `${canary}\n`, 'a/b'])(
  'refuses unsafe names even on Block tools: %j', unsafeName);

function blocksAllNames() {
  const blocked = entry('alpha');
  for (const tool of blocked.tools) {
    tool.mode = 'block';
  }
  expect(route(record([blocked]), 'mcp-alpha-installed')).toHaveProperty(
    'policies.authorization.rules', ['false']);
}
it('keeps a route with no enabled names closed', blocksAllNames);

async function keepsPrivateDataOut() {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-renderer-'));
  const keyFile = join(directory, 'provider-key');
  const fixed = { ...settings, keyFile };
  const saved = record();
  const log = vi.spyOn(console, 'log');
  const warn = vi.spyOn(console, 'warn');
  const error = vi.spyOn(console, 'error');
  try {
    const missingFile = renderGatewayConfiguration(saved, fixed);
    await writeFile(keyFile, canary);
    expect(renderGatewayConfiguration(saved, fixed)).toEqual(missingFile);
    expect(missingFile.configBytes.toString('utf8')).not.toContain(canary);
    const description = { ...saved.members[0]!.entry, description: canary };
    const altered = { ...saved, members: [{ ...saved.members[0], entry: description }] };
    refuses(altered);
    const clientHeaders = { ...saved, headers: { authorization: canary } };
    refuses(clientHeaders);
    refuses({ ...saved, rendererVersion: canary });
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
}
it('never reads the key file or echoes private input into bytes, logs or errors', keepsPrivateDataOut);

function rejectsRemoteDecision(decisionUrl: string) {
  refuses(record(), { ...settings, decisionUrl });
}
it.each(['http://example.com:3102', 'http://secret:canary@127.0.0.1:3102',
  'http://127.0.0.1:3102/path', 'https://127.0.0.1:3102'])(
  'requires a plain loopback decision listener: %s', rejectsRemoteDecision);

function refusesFragmentMismatch() {
  const saved = record();
  saved.members[0]!.fragmentDigest = 'b'.repeat(64);
  const { recordDigest: _digest, ...payload } = saved;
  saved.recordDigest = publicationDigest(payload);
  refuses(saved);
}
it('refuses a changed fragment even when the whole record digest matches', refusesFragmentMismatch);

function rejectsUnsafeIdentity(field: 'serverId' | 'connectionId') {
  const changed = entry('alpha');
  changed[field] = `../${canary}`;
  refuses(record([changed]));
}
it.each(['serverId', 'connectionId'] as const)(
  'refuses an unsafe route %s without quoting it', rejectsUnsafeIdentity);

function refusesAmbiguousRouteNames() {
  const first = entry('alpha-beta');
  first.connectionId = 'gamma';
  const second = entry('alpha');
  second.connectionId = 'beta-gamma';
  refuses(record([first, second]));
}
it('refuses distinct paths that would share a gateway route name', refusesAmbiguousRouteNames);

function fixedRoutesStayUnchanged() {
  const fixed: GatewayRenderSettings = { port: settings.port, readinessPort: settings.readinessPort,
    decisionUrl: settings.decisionUrl, issuer: settings.issuer, keyFile: settings.keyFile,
    memoryRoute: settings.memoryRoute };
  for (const options of [fixed, settings]) {
    const memoryRoutes = [options.memoryRoute];
    const expected = gatewayConfig(options.port, options.readinessPort, options.decisionUrl,
      options.keyFile, options.issuer, options.upstream, memoryRoutes, options.egressDecisionUrl);
    const rendered = renderGatewayConfiguration(record([]), options);
    expect(rendered.configBytes.toString('utf8')).toBe(JSON.stringify(expected));
  }
}
it('keeps startup route bytes with and without optional upstream and egress', fixedRoutesStayUnchanged);

function independentOfAmbientState() {
  const saved = record();
  const before = renderGatewayConfiguration(saved, settings);
  vi.useFakeTimers();
  vi.stubEnv('MODEL_MCP_ROUTES', canary);
  vi.stubEnv('OPENAI_API_KEY', canary);
  try {
    vi.setSystemTime(new Date('2040-01-01T00:00:00Z'));
    expect(renderGatewayConfiguration(saved, settings)).toEqual(before);
    vi.setSystemTime(new Date('2050-01-01T00:00:00Z'));
    expect(renderGatewayConfiguration(saved, settings)).toEqual(before);
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
}
it('does not use the clock or environment to render a saved record', independentOfAmbientState);

function refusesInvalidPort(port: number) {
  refuses(record(), { ...settings, port });
  refuses(record(), { ...settings, readinessPort: port });
}
it.each([0, 65536, 1.5, NaN])('refuses invalid listener port %s', refusesInvalidPort);
