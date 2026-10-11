import { spawn, type ChildProcess } from 'node:child_process';
import { toolObservation, toolObservationSchema, recordToolObservation } from './tool-dispatch.ts';
import { providerGatewayRoutes } from './provider-gateway.ts';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, open, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { envelope, history, type BudgetActor } from './actor.ts';

// These responses can arrive after an upstream request has already run.
const MAYBE_DISPATCHED = new Set([408, 504]);
// Every other header, including authorization and x-turn-token, is deliberately dropped.
const MCP_UPSTREAM_HEADERS = [
  '"content-type":"application/json"',
  '"accept":"application/json"',
  '"mcp-protocol-version":request.headers["mcp-protocol-version"]',
  '"mcp-method":request.headers["mcp-method"]',
  '"mcp-name":request.headers["mcp-name"]',
  '"x-request-id":request.headers["x-request-id"]',
];
// Send all tool-name header values, because agentgateway's HTTP check otherwise
// sends only the first one and hides duplicates from the decision service.
const MCP_DECISION_TOOL_NAME = 'default(request.headers.join()["mcp-name"], "")';
// The model provider receives no caller headers or turn token after authz checks the request.
const MODEL_UPSTREAM_HEADERS = [
  '"content-type":"application/json"',
  '"accept":"text/event-stream"',
  '"x-request-id":request.headers["x-request-id"]',
];
// agentgateway v1.5.0. Checksum source and update steps:
// spikes/s0-2-gateway/scripts/fetch-tools.sh.
const AGENTGATEWAY_SHA256_BY_BUILD = {
  'linux-amd64': 'daca5cda76e8c5ab0c1a75912fecf2d6365095403f810db72029c49d14a37e7b',
  'darwin-arm64': 'da432d35bd696da0564f7b2b6bbc783542b6b9c616d6c0c4d4c3daef9dfa11a1',
};

function logNumber(line: string, field: string): number | undefined {
  const value = new RegExp(`\\b${field}=(\\d+)(?=\\s|$)`, 'u').exec(line)?.[1];
  const number = value === undefined ? undefined : Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}
interface McpRoute { serverId: string; connectionId: string; upstream: string }
function mcpRoute(route: McpRoute, decisionUrl: string, issuer: string) {
  const segment = z.string().regex(/^[\w-]{1,200}$/u);
  segment.parse(route.serverId); segment.parse(route.connectionId);
  const path = `/mcp/${route.serverId}/${route.connectionId}`;
  const responseHeaders = ['x-request-id', 'x-opencrane-mcp-permit'];
  const upstreamHeaders = [...MCP_UPSTREAM_HEADERS,
    '"x-opencrane-mcp-permit":request.headers["x-opencrane-mcp-permit"]'];
  if (path === '/mcp/memory/server') {
    responseHeaders.push('x-memory-context');
    upstreamHeaders.push('"x-memory-context":request.headers["x-memory-context"]');
  }
  return { name: `mcp-${route.serverId}-${route.connectionId}`, gateways: 'default', matches: [{ path: { exact: path }, method: 'POST' }],
    policies: {
      jwtAuth: { mode: 'strict', preserveToken: true, issuer, audiences: ['agentgateway'],
        location: { header: { name: 'authorization', prefix: 'Bearer ' } }, jwks: { url: `${decisionUrl}/jwks.json` } },
      extAuthz: { host: new URL(decisionUrl).host,
        includeRequestHeaders: ['authorization', 'x-turn-token', 'session-id',
          'mcp-protocol-version', 'mcp-method', 'mcp-name', 'x-opencrane-tool-mode',
          'x-opencrane-approval-id'],
        includeRequestBody: { maxRequestBytes: 1_048_576, allowPartialMessage: false },
        protocol: { http: { path: JSON.stringify(`/authorize${path}`),
          addRequestHeaders: { 'mcp-name': MCP_DECISION_TOOL_NAME,
            'x-opencrane-tool-mode':
              'default(request.headers.join()["x-opencrane-tool-mode"], "")',
            'x-opencrane-approval-id':
              'default(request.headers.join()["x-opencrane-approval-id"], "")' },
          includeResponseHeaders: responseHeaders,
          metadata: { toolRequestId: 'response.headers["x-request-id"]' } } },
        failureMode: { denyWithStatus: 503 } },
      transformations: { request: { replace: `{${upstreamHeaders.join(', ')}}` } },
      ...(path === '/mcp/memory/server' ? {} :
        { urlRewrite: { path: { full: `/dispatch${path}` } } }),
    }, backends: [{ host: path === '/mcp/memory/server' ? route.upstream :
      new URL(decisionUrl).host, policies: {
      // Keep refusals from the checked sender. Remove forged markers from memory replies.
      responseHeaderModifier: { remove: path === '/mcp/memory/server' ?
        ['x-opencrane-decision'] : [] },
    } }] };
}
function gatewayConfig(
  port: number, readinessPort: number, decisionUrl: string, keyFile: string,
  issuer: string, upstream?: string, mcpRoutes: McpRoute[] = [],
) {
  const decision = new URL(decisionUrl);
  function configuredMcpRoute(route: McpRoute) {
    return mcpRoute(route, decisionUrl, issuer);
  }
  const providerRoutes = providerGatewayRoutes(decisionUrl, issuer, upstream);
  const configuredMcpRoutes = mcpRoutes.map(configuredMcpRoute);
  return {
    config: { adminAddr: 'off', statsAddr: 'off', readinessAddr: `127.0.0.1:${readinessPort}` },
    gateways: { default: { port } },
    frontendPolicies: { accessLog: { add: { reservation: 'extauthz.reservationId',
      inputTokens: 'llm.inputTokens', outputTokens: 'llm.outputTokens',
      cachedInputTokens: 'has(llm.cachedInputTokens) ? llm.cachedInputTokens : uint(0)',
      cacheWriteTokens: 'has(llm.cacheCreationInputTokens) ? llm.cacheCreationInputTokens : uint(0)',
      decisionRequestId: 'response.headers["x-request-id"]',
      toolRequestId: 'extauthz.toolRequestId' } } },
    routes: [...providerRoutes, ...configuredMcpRoutes, {
      name: 'models', gateways: 'default',
      matches: [{ path: { exact: '/v1/responses' }, method: 'POST' }],
      policies: {
          jwtAuth: { mode: 'strict', preserveToken: true, issuer, audiences: ['agentgateway'],
          location: { header: { name: 'authorization', prefix: 'Bearer ' } }, jwks: { url: `${decisionUrl}/jwks.json` } },
        extAuthz: { host: decision.host, includeRequestHeaders: ['authorization', 'x-turn-token', 'session-id'],
          includeRequestBody: { maxRequestBytes: 1_048_576, allowPartialMessage: false },
          protocol: { http: { path: '"/authorize"', includeResponseHeaders: ['x-reservation-id', 'x-request-id'],
            metadata: { reservationId: 'response.headers["x-reservation-id"]' } } }, failureMode: { denyWithStatus: 503 } },
        transformations: { request: { replace: `{${MODEL_UPSTREAM_HEADERS.join(', ')}}` } },
      }, backends: [{ ai: { name: 'openai', provider: { openAI: {} }, ...(upstream ? { hostOverride: upstream } : {}) },
        policies: { backendAuth: { key: { file: keyFile } }, ai: { routes: { '/v1/responses': 'responses' }, overrides: { service_tier: 'default' } } } }],
    }],
  };
}
const observation = z.union([
  toolObservationSchema,
  z.object({ id: z.uuid(), uncertainReason: z.enum(['missing_usage', 'transport_failure']) }).strict(),
  z.object({ id: z.uuid(), outcome: z.enum(['error', 'unknown']), reason: z.enum(['jwt_failed', 'dispatch_denied', 'observation_missing']) }).strict(),
  z.object({ id: z.uuid(), inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative(),
    cachedInputTokens: z.int().nonnegative().optional(), cacheWriteTokens: z.int().nonnegative().optional() }).strict(),
  z.object({ id: z.uuid(), outcome: z.literal('error') }).strict(),
]);
export interface UsageCursor {
  offset: number;
}

async function recordUsageLine(actor: BudgetActor, line: string) {
  const parsed: unknown = JSON.parse(line);
  const value = observation.parse(parsed);
  if ('toolOutcome' in value) {
    await recordToolObservation(actor, value);
  } else if ('reason' in value) {
    const subject = `gateway-${value.id}`;
    const rows = await history(actor.store, subject, actor.silo);
    const eventId = `${value.id}:gateway`;
    function alreadyRecorded(row: typeof rows[number]) {
      return row.event.id === eventId;
    }
    if (rows.some(alreadyRecorded)) return;
    const payload = { requestId: value.id, outcome: value.outcome, reason: value.reason };
    const event = envelope(actor.silo, subject, 'gateway.observation_recorded', payload, eventId);
    const command = { event, expectedSequence: rows.at(-1)?.sequence ?? 0 };
    const result = await actor.store.append(command);
    if (result.status !== 'appended') throw new Error('Gateway evidence unavailable');
  } else if ('uncertainReason' in value) {
    await actor.uncertain(value.id, value.uncertainReason);
  } else if ('outcome' in value) {
    await actor.effect(value.id, undefined, value.outcome);
  } else {
    const { id, ...usage } = value;
    await actor.effect(id, usage);
  }
}

export async function ingestUsage(actor: BudgetActor, file: string,
  cursor: UsageCursor = { offset: 0 }) {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if (z.object({ code: z.literal('ENOENT') }).safeParse(error).success) return;
    throw error;
  }
  try {
    const details = await handle.stat();
    const size = details.size;
    if (size < cursor.offset) cursor.offset = 0;
    const bytes = Buffer.alloc(size - cursor.offset);
    if (!bytes.length) return;
    const result = await handle.read(bytes, 0, bytes.length, cursor.offset);
    const content = bytes.subarray(0, result.bytesRead);
    let start = 0;
    let end = content.indexOf(10, start);
    // Advance past a complete line only after its event has been saved successfully.
    while (end !== -1) {
      const line = content.subarray(start, end).toString('utf8');
      await recordUsageLine(actor, line);
      cursor.offset += end - start + 1;
      start = end + 1;
      end = content.indexOf(10, start);
    }
  } finally {
    await handle.close();
  }
}

export function gatewayUsage(line: string) {
  const tool = toolObservation(line);
  if (tool) return tool;
  const status = logNumber(line, 'http\\.status');
  // Provider attempts already record dispatch and result on their own stream.
  // They have no native usage reservation, so the ordinary refusal fallback would invent rows.
  const providerRoute =
    /\broute=default\/provider-(?:openai|anthropic)-(?:reachability|test)(?=\s|$)/u;
  if (providerRoute.test(line) && status !== 401) {
    return undefined;
  }
  const id = /\breservation="([a-f0-9-]{36})"/u.exec(line)?.[1];
  if (!id) {
    if (status === undefined) return undefined;
    // JWT failures have no decision. Refusals use the decision's response id, never a request header.
    const requestId = status === 401 ? undefined : z.uuid().safeParse(/\bdecisionRequestId="([^"]+)"/u.exec(line)?.[1]).data;
    return refusalObservation(requestId ?? randomUUID(), status);
  }
  const usage = nativeUsage(line, id);
  if (usage) return usage;
  return providerFailureObservation(id, line, status);
}
function providerFailureObservation(id: string, line: string, status?: number) {
  const maybeDispatched = status !== undefined && MAYBE_DISPATCHED.has(status);
  const hasTransportError = /\berror=/u.test(line);
  // A rejection without usage is treated as zero cost; it does not prove the provider did not run.
  const isDefiniteRejection = status !== undefined && status >= 400 && status < 600 &&
    !maybeDispatched && !hasTransportError;
  if (isDefiniteRejection) return { id, outcome: 'error' as const };
  const transportFailed = hasTransportError || maybeDispatched;
  const uncertainReason = transportFailed ? 'transport_failure' as const : 'missing_usage' as const;
  return { id, uncertainReason };
}
function refusalObservation(id: string, status: number) {
  const outcome = status >= 400 ? 'error' : 'unknown';
  let reason: 'jwt_failed' | 'dispatch_denied' | 'observation_missing';
  if (status === 401) {
    reason = 'jwt_failed';
  } else if (status >= 400) {
    reason = 'dispatch_denied';
  } else {
    reason = 'observation_missing';
  }
  return { id, outcome, reason };
}
function nativeUsage(line: string, id: string) {
  const token = z.int().nonnegative();
  const parsed = z.object({ id: z.uuid(), inputTokens: token, outputTokens: token,
    cachedInputTokens: token, cacheWriteTokens: token }).safeParse({ id,
    inputTokens: logNumber(line, 'inputTokens'), outputTokens: logNumber(line, 'outputTokens'),
    cachedInputTokens: line.includes('cachedInputTokens=') ? logNumber(line, 'cachedInputTokens') : 0,
    cacheWriteTokens: line.includes('cacheWriteTokens=') ? logNumber(line, 'cacheWriteTokens') : 0,
  });
  if (!parsed.success || parsed.data.cachedInputTokens + parsed.data.cacheWriteTokens > parsed.data.inputTokens) return undefined;
  return parsed.data;
}

export async function startGateway(options: { binary: string; configFile: string; usageFile: string; keyFile: string;
  port: number; readinessPort: number; decisionUrl: string; issuer: string; upstream?: string;
  mcpRoutes?: McpRoute[];
  onChildSpawn?: (child: ChildProcess, stop: (signal?: NodeJS.Signals) => Promise<void>) => void;
}) {
  const build = process.platform === 'linux' ? 'linux-amd64' : 'darwin-arm64';
  const expected = AGENTGATEWAY_SHA256_BY_BUILD[build];
  if (createHash('sha256').update(await readFile(options.binary)).digest('hex') !== expected) throw new Error('Gateway digest mismatch');
  await writeFile(options.configFile, JSON.stringify(gatewayConfig(options.port, options.readinessPort, options.decisionUrl, options.keyFile, options.issuer, options.upstream, options.mcpRoutes)), { mode: 0o600 });
  const child = spawn(options.binary, ['-f', options.configFile], {
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', RUST_LOG: 'info', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let writes = Promise.resolve(), failed = false;
  let errorLine = '';
  let stderrBuffer = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrBuffer += chunk;
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() ?? '';
    const match = lines.find(line => /\bError:/u.test(line));
    if (match) errorLine = match.trim();
  });
  const lines = createInterface({ input: child.stdout });
  // Adapted from S0.1c: never persist raw gateway diagnostics, credentials or request bodies.
  lines.on('line', line => {
    const value = gatewayUsage(line);
    if (!value) return;
    const parsed = observation.safeParse(value);
    if (!parsed.success) { failed = true; return; }
    writes = writes.then(() => appendFile(options.usageFile, `${JSON.stringify(parsed.data)}\n`, { mode: 0o600 }))
      .catch(() => { failed = true; child.kill('SIGTERM'); });
  });
  child.stderr.on('end', () => {
    if (!errorLine && /\bError:/u.test(stderrBuffer)) errorLine = stderrBuffer.trim();
  });
  // Exit can precede the final stdout records; close waits for the pipes to drain.
  const closed = once(child, 'close');
  const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    await closed; await writes; lines.close();
  };
  options.onChildSpawn?.(child, stop);
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null || child.signalCode !== null || failed) {
        await stop();
        const status = child.signalCode ? `signal ${child.signalCode}` : `exit code ${child.exitCode}`;
        const diagnostic = errorLine ? `: ${errorLine}` : '';
        throw new Error(`Gateway stopped (${status})${diagnostic}`);
      }
      try {
        if ((await fetch(`http://127.0.0.1:${options.readinessPort}/healthz/ready`)).ok) {
          // Readiness can precede the request listener. A TCP probe creates no request audit.
          const probe = connect(options.port, '127.0.0.1');
          probe.setTimeout(1000, () => probe.destroy(new Error('Gateway listener timed out')));
          await once(probe, 'connect').finally(() => probe.destroy());
          return { stop, healthy: () => child.exitCode === null && child.signalCode === null && !failed };
        }
      } catch { /* Listener is still starting. */ }
      await delay(50);
    }
    throw new Error('Gateway readiness timed out');
  } catch (error) { await stop(); throw error; }
}
