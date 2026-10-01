import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTokenIssuer } from './tokens.js';
import { startDecisionService } from './decision-service.js';
import { startModelStub } from './model-stub.js';
import { startLocalForwardingProxy } from './proxy.js';
import { buildGatewayConfig } from './gateway-config.js';
import { spawnGateway, PROJECT_ROOT } from './gateway-process.js';
import { freePorts } from './shared/ports.js';
import { loadPriceTable, priceFor } from './price-table.js';
import { CodexBridge } from './bridge.js';
import { resolveNativeCodexBin } from './codex-bin.js';
import { buildCodexConfigToml, PLACEHOLDER_KEY_ENV_VAR, PLACEHOLDER_KEY_VALUE } from './codex-config.js';
import { startEgressGuard } from './egress-guard.js';
import { safeUsageLine, settle } from './usage.js';

export const STUB_KEY = 'stub-gateway-credential';
export const tablePath = join(PROJECT_ROOT, 'config/prices.json');
export async function startHarness(dir: string, mode: 'stub' | 'real' = 'stub', model = 'stub-model') {
  const table = loadPriceTable(tablePath);
  if (!priceFor(table, model) || (mode === 'real' && (model === 'stub-model' || !priceFor(table, model)?.confirmed))) throw new Error('MODEL must have a confirmed price');
  const cleanup: (() => Promise<void>)[] = [];
  const close = async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const issuer = await startTokenIssuer(); cleanup.push(issuer.close);
    const stub = mode === 'stub' ? await startModelStub() : undefined; if (stub) cleanup.push(stub.close);
    const decision = await startDecisionService({ jwksUrl: issuer.jwksUrl, allowedModel: model, priceTable: table, logPath: join(dir, 'decisions.jsonl') }); cleanup.push(decision.close);
    const [port, readyPort] = await freePorts(2);
    const gatewayUrl = `http://127.0.0.1:${port}`;
    const config = buildGatewayConfig({ mode, gatewayPort: port!, readinessPort: readyPort!, jwksUrl: issuer.jwksUrl, decisionServiceAddress: `127.0.0.1:${decision.port}`, stubUpstreamAddress: stub ? `127.0.0.1:${stub.port}` : undefined });
    const configPath = join(dir, 'agentgateway.yaml'); writeFileSync(configPath, config);
    const gateway = mode === 'stub' ? await spawnGateway({ configPath, readinessPort: readyPort!, providerKey: STUB_KEY, logPath: join(dir, 'gateway.log') }) : undefined;
    if (gateway) cleanup.push(gateway.stop);
    const computerToken = await issuer.mintComputerToken({ silo: 'smoke', computer: 'computer', assistant: 'assistant' });
    const turnToken = await issuer.mintTurnToken({ silo: 'smoke', assistant: 'assistant', conversation: 'conversation', turn: 'turn', requester: 'owner' });
    const proxy = await startLocalForwardingProxy({ gatewayUrl, computerToken }); cleanup.push(proxy.close);
    const guard = await startEgressGuard(); cleanup.push(guard.close);
    const home = join(dir, 'home'), workspace = join(home, 'workspace');
    mkdirSync(join(home, '.codex'), { recursive: true }); mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'notes.txt'), 'OpenCrane gives each assistant a computer. The gateway checks permission and budgets.\n');
    writeFileSync(join(home, '.codex/config.toml'), buildCodexConfigToml({ model, proxyBaseUrl: `${proxy.url}/v1`, placeholderKeyEnvVar: PLACEHOLDER_KEY_ENV_VAR }));
    const env = { [PLACEHOLDER_KEY_ENV_VAR]: PLACEHOLDER_KEY_VALUE, HTTP_PROXY: guard.url, HTTPS_PROXY: guard.url, ALL_PROXY: guard.url, http_proxy: guard.url, https_proxy: guard.url, all_proxy: guard.url, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    // Real runs never save model text or bridge messages. Only numeric usage survives.
    const bridge = new CodexBridge({ codexBinPath: resolveNativeCodexBin(), codexHome: home, cwd: workspace, env });
    cleanup.push(() => bridge.stop());
    return { dir, model, table, issuer, stub, decision, gateway, proxy, bridge, env, home, workspace, computerToken, turnToken, readyPort: readyPort!, gatewayUrl, close,
      async turn() {
        bridge.onServerRequest('item/tool/call', async ({ id, params }) => {
          const call = params as { tool: string; arguments: unknown };
          const permitted = call.tool === 'read_notes' && JSON.stringify(call.arguments) === '{}';
          await bridge.respondToServerRequest(id, { success: permitted, contentItems: [{ type: 'inputText', text: permitted ? readFileSync(join(workspace, 'notes.txt'), 'utf8') : 'refused' }] });
        });
        await bridge.start();
        await bridge.request('initialize', { clientInfo: { name: 'smoke', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        const { thread } = await bridge.request<{ thread: { id: string } }>('thread/start', { cwd: workspace, dynamicTools: [{ type: 'function', name: 'read_notes', description: 'Read notes.txt in the workspace. Takes no arguments.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] });
        proxy.setTurnToken(thread.id, turnToken);
        const deltas: string[] = [];
        let timer: NodeJS.Timeout;
        const done = new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('turn timed out')), 60000);
          bridge.onNotification((method, params) => {
            const p = params as { delta?: string; turn?: { status: string } };
            if (method === 'item/agentMessage/delta' && p.delta) deltas.push(p.delta);
            if (method === 'turn/completed') p.turn?.status === 'completed' ? resolve() : reject(new Error('turn failed'));
          });
        });
        try {
          await bridge.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Read notes.txt in the workspace using read_notes and summarise it in two sentences.', text_elements: [] }] });
          await done;
          return { deltas, messages: bridge.messages };
        } finally { clearTimeout(timer!); proxy.clearTurnToken(thread.id); }
      },
      usage() {
        const lines = gateway ? gateway.lines().flatMap(line => { const safe = safeUsageLine(line); return safe ? [safe] : []; }) : readFileSync(join(dir, 'usage.jsonl'), 'utf8').trim().split('\n');
        return settle(lines, decision.reservations(), table);
      },
    };
  } catch (error) { await close(); throw error; }
}
export type Harness = Awaited<ReturnType<typeof startHarness>>;
