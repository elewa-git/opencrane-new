import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { BudgetActor } from './actor.ts';

function logNumber(line: string, field: string): number | undefined {
  const value = new RegExp(`\\b${field}=(\\d+)`, 'u').exec(line)?.[1];
  return value === undefined ? undefined : Number(value);
}
function gatewayConfig(port: number, readinessPort: number, decisionUrl: string, keyFile: string, issuer: string, upstream?: string) {
  const decision = new URL(decisionUrl);
  return {
    config: { adminAddr: 'off', statsAddr: 'off', readinessAddr: `127.0.0.1:${readinessPort}` },
    gateways: { default: { port } },
    frontendPolicies: { accessLog: { add: { reservation: 'extauthz.reservationId',
      inputTokens: 'llm.inputTokens', outputTokens: 'llm.outputTokens',
      cachedInputTokens: 'has(llm.cachedInputTokens) ? llm.cachedInputTokens : uint(0)',
      cacheWriteTokens: 'has(llm.cacheCreationInputTokens) ? llm.cacheCreationInputTokens : uint(0)' } } },
    routes: [{ name: 'models', gateways: 'default', matches: [{ path: { exact: '/v1/responses' }, method: 'POST' }],
      policies: {
        retry: { attempts: 1, codes: [] },
        jwtAuth: { mode: 'strict', preserveToken: true, issuer, audiences: ['agentgateway'],
          location: { header: { name: 'authorization', prefix: 'Bearer ' } }, jwks: { url: `${decisionUrl}/jwks.json` } },
        extAuthz: { host: decision.host, includeRequestHeaders: ['authorization', 'x-turn-token', 'session-id'],
          includeRequestBody: { maxRequestBytes: 1_048_576, allowPartialMessage: false },
          protocol: { http: { path: '"/authorize"', includeResponseHeaders: ['x-reservation-id'],
            metadata: { reservationId: 'response.headers["x-reservation-id"]' } } }, failureMode: { denyWithStatus: 503 } },
        transformations: { request: { replace: '{"content-type":"application/json", "accept":"text/event-stream"}' } },
      }, backends: [{ ai: { name: 'openai', provider: { openAI: {} }, ...(upstream ? { hostOverride: upstream } : {}) },
        policies: { backendAuth: { key: { file: keyFile } }, ai: { routes: { '/v1/responses': 'responses' }, overrides: { service_tier: 'default' } } } }],
    }],
  };
}
const observation = z.union([
  z.object({ id: z.uuid(), inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative(),
    cachedInputTokens: z.int().nonnegative().optional(), cacheWriteTokens: z.int().nonnegative().optional() }).strict(),
  z.object({ id: z.uuid(), outcome: z.literal('error') }).strict(),
]);
export async function ingestUsage(actor: BudgetActor, file: string) {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch (error) {
    if (z.object({ code: z.literal('ENOENT') }).safeParse(error).success) return;
    throw error;
  }
  // A killed writer can leave one incomplete final line. Its reservation stays charged.
  for (const line of text.split('\n').slice(0, -1)) {
    const value = observation.parse(JSON.parse(line));
    if ('outcome' in value) await actor.effect(value.id, undefined, value.outcome);
    else { const { id, ...usage } = value; await actor.effect(id, usage); }
  }
}
export async function startGateway(options: { binary: string; configFile: string; usageFile: string; keyFile: string;
  port: number; readinessPort: number; decisionUrl: string; issuer: string; upstream?: string }) {
  const expected = process.platform === 'linux' ? 'daca5cda76e8c5ab0c1a75912fecf2d6365095403f810db72029c49d14a37e7b'
    : 'da432d35bd696da0564f7b2b6bbc783542b6b9c616d6c0c4d4c3daef9dfa11a1';
  if (createHash('sha256').update(await readFile(options.binary)).digest('hex') !== expected) throw new Error('Gateway digest mismatch');
  await writeFile(options.configFile, JSON.stringify(gatewayConfig(options.port, options.readinessPort, options.decisionUrl, options.keyFile, options.issuer, options.upstream)), { mode: 0o600 });
  const child = spawn(options.binary, ['-f', options.configFile], {
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', RUST_LOG: 'info', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let writes = Promise.resolve(), failed = false;
  const lines = createInterface({ input: child.stdout });
  // Adapted from S0.1c: never persist raw gateway diagnostics, credentials or request bodies.
  lines.on('line', line => {
    const id = /\breservation="([a-f0-9-]{36})"/u.exec(line)?.[1];
    const input = logNumber(line, 'inputTokens'), output = logNumber(line, 'outputTokens');
    if (!id) return;
    const cached = logNumber(line, 'cachedInputTokens'), cacheWrites = logNumber(line, 'cacheWriteTokens');
    const status = logNumber(line, 'http\\.status') ?? 0;
    // Gateway transport failures carry an error; timeout responses are ambiguous too.
    const rejected = status >= 400 && status < 600 && status !== 408 && status !== 504 && !/\berror=/u.test(line);
    const value = input !== undefined && output !== undefined ? { id, inputTokens: input, outputTokens: output,
      cachedInputTokens: cached ?? 0, cacheWriteTokens: cacheWrites ?? 0 }
      : rejected ? { id, outcome: 'error' } : undefined;
    if (!value) return;
    const parsed = observation.safeParse(value);
    if (!parsed.success) { failed = true; return; }
    writes = writes.then(() => appendFile(options.usageFile, `${JSON.stringify(parsed.data)}\n`, { mode: 0o600 }))
      .catch(() => { failed = true; child.kill('SIGTERM'); });
  });
  child.stderr.resume();
  const exited = once(child, 'exit');
  const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    await exited; await writes; lines.close();
  };
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null || child.signalCode !== null || failed) throw new Error('Gateway stopped');
      try {
        if ((await fetch(`http://127.0.0.1:${options.readinessPort}/healthz/ready`)).ok) {
          return { stop, healthy: () => child.exitCode === null && child.signalCode === null && !failed };
        }
      } catch { /* Listener is still starting. */ }
      await delay(50);
    }
    throw new Error('Gateway readiness timed out');
  } catch (error) { await stop(); throw error; }
}
