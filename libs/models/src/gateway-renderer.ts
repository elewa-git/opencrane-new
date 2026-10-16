import { createHash } from 'node:crypto';
import { gatewayConfigurationSchema } from '@opencrane/events';
import { gatewayConfig, mcpRoute, type GatewayModelRoute } from './gateway.ts';
import { publicationDigest } from './publication.ts';

type Configuration = ReturnType<typeof gatewayConfigurationSchema.parse>;
type Entry = Configuration['members'][number]['entry'];

export type GatewayRenderSettings = GatewayModelRoute & {
  port: number;
  readinessPort: number;
  decisionUrl: string;
  issuer: string;
  upstream?: string;
  egressDecisionUrl?: string;
  memoryRoute?: Parameters<typeof mcpRoute>[0];
};

const DECISION_HEADERS = {
  generation: 'x-opencrane-gateway-generation',
  recordDigest: 'x-opencrane-record-digest',
  serverId: 'x-opencrane-server-id',
  connectionId: 'x-opencrane-connection-id',
  reviewRevision: 'x-opencrane-review-revision',
};
const SEGMENT = /^[\w-]{1,200}$/u;
const TOOL_NAME = /^[a-zA-Z0-9_.-]{1,128}$/u;

function refused(): never {
  // Keep rejected values out of errors, including schema validation details.
  throw new Error('Gateway configuration refused');
}

function loopbackListener(value: string) {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return refused();
  }
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' ||
      endpoint.port === '' || endpoint.username !== '' || endpoint.password !== '' ||
      endpoint.pathname !== '/' || endpoint.search !== '' || endpoint.hash !== '') {
    refused();
  }
}

function validSettings(settings: GatewayRenderSettings) {
  for (const port of [settings.port, settings.readinessPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      refused();
    }
  }
  loopbackListener(settings.decisionUrl);
  if (settings.egressDecisionUrl !== undefined) {
    loopbackListener(settings.egressDecisionUrl);
  }
}

function reserveRoute(route: Pick<Entry, 'serverId' | 'connectionId'>,
  servers: Set<string>, paths: Set<string>, names: Set<string>) {
  if (!SEGMENT.test(route.serverId) || !SEGMENT.test(route.connectionId)) {
    refused();
  }
  const path = `/mcp/${route.serverId}/${route.connectionId}`;
  const name = `mcp-${route.serverId}-${route.connectionId}`;
  if (servers.has(route.serverId) || paths.has(path) || names.has(name)) {
    refused();
  }
  servers.add(route.serverId);
  paths.add(path);
  names.add(name);
}

function toolRule(entry: Entry) {
  const names = new Set<string>();
  const enabled: string[] = [];
  for (const tool of entry.tools) {
    if (!TOOL_NAME.test(tool.name) || names.has(tool.name)) {
      refused();
    }
    names.add(tool.name);
    if (tool.mode !== 'block') {
      enabled.push(tool.name);
    }
  }
  if (enabled.length === 0) {
    return 'false';
  }
  // Compare joined values so repeated headers cannot hide behind their first value.
  return 'request.method == "POST" && ' +
    'default(request.headers.join()["mcp-method"], "") == "tools/call" && ' +
    'default(request.headers.join()["mcp-name"], "") in ' + JSON.stringify(enabled);
}

function reviewedRoute(entry: Entry, record: Configuration, settings: GatewayRenderSettings) {
  const target = { serverId: entry.serverId, connectionId: entry.connectionId, upstream: '' };
  const route = mcpRoute(target, settings.decisionUrl, settings.issuer);
  const http = route.policies.extAuthz.protocol.http;
  const constants = {
    [DECISION_HEADERS.generation]: JSON.stringify(String(record.generation)),
    [DECISION_HEADERS.recordDigest]: JSON.stringify(record.recordDigest),
    [DECISION_HEADERS.serverId]: JSON.stringify(entry.serverId),
    [DECISION_HEADERS.connectionId]: JSON.stringify(entry.connectionId),
    [DECISION_HEADERS.reviewRevision]: JSON.stringify(String(entry.reviewRevision)),
  };
  // Override caller values in the authorisation request, before any outbound replacement.
  http.addRequestHeaders = { ...http.addRequestHeaders, ...constants };
  const policies = { ...route.policies, authorization: { rules: [toolRule(entry)] } };
  return { ...route, policies };
}

export function renderGatewayConfiguration(input: unknown, settings: GatewayRenderSettings) {
  const parsed = gatewayConfigurationSchema.safeParse(input);
  if (!parsed.success) {
    return refused();
  }
  const record = parsed.data;
  const { recordDigest, ...saved } = record;
  if (publicationDigest(saved) !== recordDigest) {
    refused();
  }
  validSettings(settings);
  const servers = new Set<string>();
  const paths = new Set<string>();
  const names = new Set<string>();
  if (settings.memoryRoute) {
    reserveRoute(settings.memoryRoute, servers, paths, names);
  }
  const routes = [];
  for (const member of record.members) {
    const entry = member.entry;
    if (entry.accountMode !== 'none' || publicationDigest(entry) !== member.fragmentDigest) {
      refused();
    }
    reserveRoute(entry, servers, paths, names);
    routes.push(reviewedRoute(entry, record, settings));
  }
  const memoryRoutes = [];
  if (settings.memoryRoute) {
    memoryRoutes.push(settings.memoryRoute);
  }
  const config = gatewayConfig(settings.port, settings.readinessPort, settings.decisionUrl,
    settings.keyFile, settings.issuer, settings.upstream, memoryRoutes, settings.egressDecisionUrl,
    settings.managedCalls);
  config.routes.push(...routes);
  const configBytes = Buffer.from(JSON.stringify(config), 'utf8');
  const hash = createHash('sha256');
  hash.update(configBytes);
  const configDigest = hash.digest('hex');
  return { configBytes, configDigest };
}
