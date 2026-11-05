import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import { proxy } from '../src/proxy.ts';
import { proxyControl, proxyGrants } from '../src/proxy-control.ts';
import * as proxyModule from '../src/mcp-proxy.ts';

export async function recallProxy(gateway: string,
  credential: Parameters<typeof proxyGrants>[1]) {
  const directory = mkdtempSync(`${tmpdir()}/recall-proxy-`);
  const controlSocket = `${directory}/control.sock`;
  const options = { callerPath: `${directory}/caller`, controlSocket, port: 0 };
  const controlKey = 'b'.repeat(64);
  // Observe the real catalogue without replacing its checks or expiry timer.
  const created = vi.spyOn(proxyModule, 'mcpProxy');
  const runtime = await proxy(gateway, options, undefined, undefined, controlKey);
  const result = created.mock.results.at(-1);
  created.mockRestore();
  if (result?.type !== 'return') {
    await runtime.close();
    throw new Error('Missing production MCP proxy');
  }
  const mcp = result.value;
  const callers = runtime.privateAuthority;
  const registrations = new Map<string, ReturnType<typeof runtime.privateCaller>>();
  function register(binding: Parameters<typeof runtime.privateCaller>[0]) {
    const registration = runtime.privateCaller(binding);
    registrations.set(binding.turnId, registration);
    return registration;
  }
  function control(path: string, input: unknown) {
    return proxyControl(path, input, controlSocket, controlKey);
  }
  async function close() {
    await runtime.close();
    const removal = { recursive: true, force: true };
    rmSync(directory, removal);
  }
  const grant = proxyGrants(control, credential);
  return { mcp, callers, registrations, register, control, close, grant,
    approvals: runtime.approvals, url: runtime.url };
}
