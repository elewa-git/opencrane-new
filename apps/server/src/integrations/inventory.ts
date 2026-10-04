import { z } from 'zod';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { losslessJson } from '@opencrane/models';
import { version } from './remote.ts';

const text = z.string().min(1).max(200);
const cache = { resultType: z.literal('complete'), ttlMs: z.int().nonnegative(), cacheScope: z.enum(['public', 'private']) };
const discovery = z.object({ ...cache, supportedVersions: z.array(text).min(1).max(20),
  capabilities: z.object({ tools: z.record(z.string(), z.unknown()) }).passthrough(), _meta: z.object({ 'io.modelcontextprotocol/serverInfo': z.object({ name: text, version: text }).passthrough() }).passthrough(),
}).passthrough();
const schema = z.record(z.string(), z.unknown()).refine(s => s['type'] === 'object');
const tool = z.object({ name: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/u).refine(n => !['constructor', '__proto__'].includes(n)),
  inputSchema: schema, outputSchema: schema.optional(), description: z.string().max(16_384).optional(),
  annotations: z.object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() }).passthrough().optional(),
}).passthrough();
const page = z.object({ ...cache, tools: z.array(tool).max(100), nextCursor: z.string().min(1).max(4096).optional() }).passthrough();

/** Keep the exact bounded tool JSON, independent of mutable server state and human policy. */
export async function discoverInventory(call: (method: 'server/discover' | 'tools/list', cursor?: string) => Promise<string>) {
  const discoveryJson = await call('server/discover');
  const discoverResult = discovery.parse(JSON.parse(discoveryJson));
  if (Buffer.byteLength(JSON.stringify(discoverResult)) > 64 * 1024) throw new Error('inventory_limit');
  if (!discoverResult.supportedVersions.includes(version)) throw new Error('protocol_refused');
  const tools = [];
  const names = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;
  for (let pages = 0; pages < 10; pages++) {
    const raw = await call('tools/list', cursor);
    const parsed = losslessJson(raw);
    const definitions = parsed.value instanceof Map ? parsed.value.get('tools')?.value : undefined;
    if (!Array.isArray(definitions)) throw new Error('protocol_refused');
    const result = page.parse(JSON.parse(raw));
    let index = 0;
    for (const definition of result.tools) {
      if (names.has(definition.name)) throw new Error('duplicate_tools');
      names.add(definition.name);
      const json = losslessJson(definitions[index++]!.canonical);
      bytes += Buffer.byteLength(json.canonical);
      // Leave room in the event store's 1 MiB envelope for metadata and digests.
      if (bytes > 512 * 1024 || Buffer.byteLength(json.canonical) > 32 * 1024) throw new Error('inventory_limit');
      validateSchemas(definition.inputSchema, definition.outputSchema);
      tools.push({ name: definition.name, revision: json.digest, reviewed: false,
        readOnly: definition.annotations?.readOnlyHint === true, destructive: definition.annotations?.destructiveHint === true,
        definition: json.canonical });
    }
    cursor = result.nextCursor;
    if (!cursor) return boundedInventory({ toolCount: tools.length, tools, discoverResult: losslessJson(discoveryJson).canonical,
      serverInfo: { name: discoverResult._meta['io.modelcontextprotocol/serverInfo'].name, version: discoverResult._meta['io.modelcontextprotocol/serverInfo'].version },
      schemaDigest: losslessJson(JSON.stringify(tools.map(t => ({ name: t.name, revision: t.revision })).sort((a, b) => a.name < b.name ? -1 : 1))).digest });
    if (cursors.has(cursor)) throw new Error('pagination_limit');
    cursors.add(cursor);
  }
  throw new Error('pagination_limit');
}

function validateSchemas(input: Record<string, unknown>, output?: Record<string, unknown>) {
  for (const candidate of [input, output]) if (candidate) {
    const options = { strict: false, validateFormats: false, logger: false as const };
    const validator = candidate['$schema'] === 'http://json-schema.org/draft-07/schema#' ? new Ajv(options) : new Ajv2020(options);
    validator.compile(candidate);
  }
}

function boundedInventory<T>(inventory: T): T {
  if (Buffer.byteLength(JSON.stringify(inventory)) > 900 * 1024) throw new Error('inventory_limit');
  return inventory;
}
