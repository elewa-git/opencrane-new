import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startHarness, STUB_KEY, type Harness } from '../src/harness.js';
import { PROJECT_ROOT } from '../src/gateway-process.js';
import { sha256Hex } from '../src/model-stub.js';
import { costCents } from '../src/price-table.js';
import { buildGatewayConfig } from '../src/gateway-config.js';
import { safeUsageLine } from '../src/usage.js';
import { parseStrictJson } from '../src/shared/http.js';

const spawned = vi.hoisted(() => [] as { args: readonly string[]; env: NodeJS.ProcessEnv }[]);
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (file: string, args: readonly string[], options: import('node:child_process').SpawnOptions) => {
    spawned.push({ args, env: options.env ?? {} });
    return actual.spawn(file, args, options);
  } };
});
let h: Harness;
const valid = { model: 'stub-model', input: 'hello', stream: true, max_output_tokens: 2000 };
const headers = () => ({ 'content-type': 'application/json', 'x-oc-computer-token': h.computerToken, 'x-oc-turn-token': h.turnToken, authorization: 'Bearer client-must-never-arrive' });
async function call(body: unknown = valid, path = '/v1/responses', method = 'POST', hdr = headers()) {
  return fetch(h.gatewayUrl + path, { method, headers: hdr, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
}
async function denied(body: unknown, reason?: string) {
  const before = h.stub!.requests.length;
  const r = await call(body); expect(r.status).toBeGreaterThanOrEqual(400); await r.text();
  expect(h.stub!.requests).toHaveLength(before);
  if (reason) expect(h.decision.decisions().at(-1)?.reason).toBe(reason);
}
beforeEach(async () => { h = await startHarness(mkdtempSync(join(PROJECT_ROOT, '.state/test-'))); });
afterEach(async () => { if (h) { await h.close();
  for (const pid of [h.bridge.pid, h.gateway?.proc.pid]) if (pid) expect(() => process.kill(pid, 0)).toThrow();
  rmSync(h.dir, { recursive: true, force: true }); } });

describe('gateway caps, direct requests bypassing the proxy', () => {
  test('bounds, including legacy names and malformed JSON', async () => {
    for (const name of ['max_output_tokens', 'max_tokens', 'max_completion_tokens']) {
      for (const value of [2001, 1.5, '2000', 0, -1, null, true]) await denied({ ...valid, [name]: value });
    }
    await denied({ ...valid, max_output_tokens: undefined }, 'no_output_bound');
    await denied('{"model":"stub-model","model":"stub-model"}', 'duplicate_json_key');
    expect(() => parseStrictJson('{"n":01}')).toThrow();
    await denied({ ...valid, input: 'x'.repeat(1_048_577) });
  });
  test('hosted tools, nested and differently cased types', async () => {
    for (const type of ['web_search', 'web_search_preview', 'file_search', 'code_interpreter', 'image_generation', 'computer_use', 'Web_Search', 'FUNCTION', 'custom', 'local_shell', 'namespace']) {
      await denied({ ...valid, tools: [{ type }] }, 'hosted_tool_refused');
      await denied({ ...valid, tools: [{ type: 'function', tools: [{ type }] }] }, 'hosted_tool_refused');
      await denied({ ...valid, tools: [{ type: 'function', function: { tools: [{ type }] } }] }, 'hosted_tool_refused');
      await denied({ ...valid, tool_choice: { type: 'allowed_tools', tools: [{ type }] } }, 'hosted_tool_refused');
    }
    await denied({ ...valid, model: 'other' }, 'model_not_allowed');
    for (const extra of [{ n: 2 }, { background: true }, { previous_response_id: 'resp_x' }, { conversation: 'conv_x' }, { service_tier: 'priority' }, { input: [{ type: 'input_image', image_url: 'https://invalid' }] }]) await denied({ ...valid, ...extra });
  });
  test('six parallel reservations only; seventh and later denied', async () => {
    const results = await Promise.all(Array.from({ length: 9 }, async () => { const r = await call(); await r.text(); return r.status; }));
    expect(results.filter(status => status === 200)).toHaveLength(6);
    expect(results.filter(status => status === 403)).toHaveLength(3);
    expect(h.stub!.responseRequests()).toHaveLength(6);
    expect(h.decision.allowedCount()).toBe(6);
    await denied(valid, 'model_request_cap_reached');
  });
  test('both signatures, expiry, audience and claim binding verified', async () => {
    for (const key of ['x-oc-computer-token', 'x-oc-turn-token'] as const) {
      for (const bad of ['', 'forged', headers()[key].slice(0, -8) + 'invalidx', key.includes('computer') ? h.turnToken : h.computerToken]) {
        const r = await call(valid, '/v1/responses', 'POST', { ...headers(), [key]: bad }); expect(r.status).toBeGreaterThanOrEqual(400); await r.text();
      }
    }
    const expiredComputer = await h.issuer.mintComputerToken({ silo: 'smoke', computer: 'computer', assistant: 'assistant', ttlSeconds: -60 });
    const expiredTurn = await h.issuer.mintTurnToken({ silo: 'smoke', requester: 'owner', assistant: 'assistant', conversation: 'c', turn: 't', ttlSeconds: -60 });
    for (const hdr of [{ ...headers(), 'x-oc-computer-token': expiredComputer }, { ...headers(), 'x-oc-turn-token': expiredTurn }]) { const r = await call(valid, '/v1/responses', 'POST', hdr); expect(r.status).toBeGreaterThanOrEqual(400); await r.text(); }
    const mismatch = await h.issuer.mintTurnToken({ silo: 'other', requester: 'owner', assistant: 'assistant', conversation: 'c', turn: 't' });
    const r = await call(valid, '/v1/responses', 'POST', { ...headers(), 'x-oc-turn-token': mismatch }); expect(r.status).toBe(403); await r.text();
    expect(h.stub!.requests).toHaveLength(0);
    const ok = await call(); expect(ok.status).toBe(200); await ok.text();
    expect(h.decision.reservations()[0]).toMatchObject({ requester: 'owner', computer: 'computer', assistant: 'assistant' });
    expect(h.stub!.responseRequests()[0]?.authorizationSha256).toBe(sha256Hex(`Bearer ${STUB_KEY}`));
  });
  test('unrouted paths and methods cannot skip auth; decision outage fails closed', async () => {
    for (const path of ['/responses', '/v1/chat/completions', '/v1/responses/abc', '/v1/responses/', '/v1/models/abc', '/v1/%72esponses', '/v1//responses', '/']) {
      for (const method of ['GET', 'POST', 'PUT', 'OPTIONS']) {
        const r = await call(valid, path, method); expect(r.status).toBeGreaterThanOrEqual(400); await r.text();
      }
    }
    for (const [path, method] of [['/v1/models', 'POST'], ['/v1/responses', 'GET'], ['/v1/responses', 'PUT']]) {
      const r = await call(valid, path!, method!); expect(r.status).toBeGreaterThanOrEqual(400); await r.text();
    }
    for (const [path, method] of [['/v1/models', 'GET'], ['/v1/responses?x=1', 'POST']]) {
      const r = await call(valid, path!, method!, { ...headers(), 'x-oc-computer-token': '' }); expect(r.status).toBeGreaterThanOrEqual(400); await r.text();
    }
    const models = await call(undefined, '/v1/models', 'GET'); expect(models.status).toBe(200); expect((await models.json() as { data: unknown[] }).data.length).toBeGreaterThan(0);
    expect(h.decision.decisions().at(-1)).toMatchObject({ route: 'models', outcome: 'allow' });
    const before = h.stub!.requests.length;
    await h.decision.close();
    for (const [path, method] of [['/v1/responses', 'POST'], ['/v1/models', 'GET']]) {
      const r = await call(valid, path!, method!); expect(r.status).toBe(503); await r.text();
    }
    expect(h.stub!.requests).toHaveLength(before);
  });
});

test('Codex streams end to end, reads notes, uses placeholder only; gateway usage and auth', async () => {
  process.env.OPENAI_API_KEY = 'test-parent-env-must-not-reach-codex';
  try {
    const { deltas, messages } = await h.turn();
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toContain('Stub model');
    expect(JSON.stringify(messages)).toContain('OpenCrane gives each assistant a computer');
    expect(h.stub!.responseRequests()).toHaveLength(2);
    for (const request of h.stub!.responseRequests()) {
      expect(request.authorizationSha256).toBe(sha256Hex(`Bearer ${STUB_KEY}`));
      expect(request.headerNames).not.toContain('x-oc-computer-token'); expect(request.headerNames).not.toContain('x-oc-turn-token');
      expect(request.body).toMatchObject({ max_output_tokens: 2000 });
      expect((request.body as { tools: { type: string }[] }).tools.every(tool => tool.type === 'function')).toBe(true);
      expect(JSON.stringify((request.body as { tools: unknown }).tools)).not.toMatch(/"name":"(?:exec_command|shell|view_image|apply_patch)"/);
    }
    expect(h.proxy.requests.every(r => !r.forwardedHeaders.authorization)).toBe(true);
    expect(h.env.OC_PLACEHOLDER_API_KEY).toBe('placeholder-not-a-real-key');
    const childEnv = JSON.stringify(spawned.filter(call => call.args[0] === 'app-server').at(-1)?.env);
    expect(childEnv).toContain('\"OC_PLACEHOLDER_API_KEY\":\"placeholder-not-a-real-key\"');
    expect(childEnv).not.toContain('test-parent-env-must-not-reach-codex');
    expect(childEnv).not.toContain(STUB_KEY);
    expect(readFileSync(join(h.home, '.codex/config.toml'), 'utf8')).toContain('web_search = "disabled"');
    const scan = (path: string): void => { for (const name of readdirSync(path)) { const p = join(path, name); if (statSync(p).isDirectory()) scan(p); else { const contents = readFileSync(p).toString(); expect(contents).not.toContain('test-parent-env-must-not-reach-codex'); expect(contents).not.toContain(STUB_KEY); } } };
    scan(h.home);
    await expect.poll(() => h.usage().filter(u => u.status === 'CAPTURED').length).toBe(2);
    expect(h.usage()).toMatchObject([{ inputTokens: 1000, outputTokens: 120, costCents: 1 }, { inputTokens: 1100, outputTokens: 121, costCents: 1 }]);
    expect(costCents(h.table, 'stub-model', { inputTokens: 1000000, outputTokens: 1000000 })).toBe(285);
    expect(costCents(h.table, 'stub-model', { inputTokens: 1, outputTokens: 0 })).toBe(1);
  } finally { delete process.env.OPENAI_API_KEY; }
});

test('missing final usage keeps the reservation unsettled', async () => {
  h.stub!.setMode('cut-stream'); const r = await call(); await r.text().catch(() => undefined);
  expect(h.usage()).toMatchObject([{ status: 'PARTIAL' }]);
});

test('gateway makes one upstream attempt per reservation even on failures', async () => {
  h.stub!.setMode('error');
  for (let i = 1; i <= 6; i++) { const r = await call(); expect(r.status).toBe(500); await r.text(); expect(h.stub!.responseRequests()).toHaveLength(i); }
  await denied(valid, 'model_request_cap_reached');
});

test('real and stub routes differ only by upstream; log filter never stores raw errors', () => {
  const options = { gatewayPort: 3000, readinessPort: 3001, jwksUrl: 'http://127.0.0.1:3002/jwks.json', decisionServiceAddress: '127.0.0.1:3003' };
  const stub = buildGatewayConfig({ ...options, mode: 'stub', stubUpstreamAddress: '127.0.0.1:3004' });
  const real = buildGatewayConfig({ ...options, mode: 'real' });
  expect(stub.replace('(stub mode)', '(real mode)').replaceAll('\n          hostOverride: "127.0.0.1:3004"', '')).toBe(real);
  expect(real).toContain('attempts: 1');
  expect(safeUsageLine('error authorization: Bearer synthetic-secret')).toBeUndefined();
  expect(safeUsageLine('reservation="rsv_0123456789abcdef" llmInputTokens=3 llmOutputTokens=4 llmStreaming=true raw=synthetic-secret')).toBe('{"reservationId":"rsv_0123456789abcdef","inputTokens":3,"outputTokens":4}');
});

test('real preflight refuses unset, unknown, stub and unconfirmed models without starting services', () => {
  for (const model of ['', 'unknown-model', 'stub-model', 'gpt-4.1-mini']) {
    expect(() => execFileSync(process.execPath, ['--import', 'tsx', 'scripts/runner.ts', 'preflight'], {
      cwd: PROJECT_ROOT, env: { PATH: '/usr/bin:/bin', MODEL: model }, stdio: 'pipe',
    })).toThrow();
  }
  expect(h.stub!.requests).toHaveLength(0);
});
