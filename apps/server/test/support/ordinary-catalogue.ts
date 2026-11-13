import { losslessJson } from '@opencrane/events/lossless-json';
import { mcpServerDiscoveredDataSchema } from '@opencrane/events';
import { discoverInventory } from '../../src/integrations/inventory.ts';

export const ordinaryWrite = { name: 'write', inputSchema: { type: 'object' },
  annotations: { readOnlyHint: false, destructiveHint: false } };
export const rejectedSibling = { name: 'rejected', inputSchema: { type: 'object', required: 'bad' } };

export async function captureCatalogue(definitions: unknown[]) {
  const cache = { resultType: 'complete', ttlMs: 300_000, cacheScope: 'public' };
  const discovery = { ...cache, supportedVersions: ['2026-07-28'], capabilities: { tools: {} },
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Fixture', version: '1' } } };
  function call(method: string) {
    const result = method === 'server/discover' ? discovery : { ...cache, tools: definitions };
    return Promise.resolve(JSON.stringify(result));
  }
  const snapshot = await discoverInventory(call);
  return mcpServerDiscoveredDataSchema.parse({ serverId: 'fixture',
    connectionId: 'installed', accountMode: 'none', ...snapshot });
}

export function revision(definition: unknown) {
  const encoded = losslessJson(JSON.stringify(definition));
  const name = encoded.value instanceof Map ? encoded.value.get('name')?.value : undefined;
  if (typeof name !== 'string') throw new Error('Expected named fixture tool');
  return { name, revision: encoded.digest };
}
