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
const schema = z.record(z.string(), z.unknown());
const toolName = z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/u).refine(n => !['constructor', '__proto__'].includes(n));
const metaKey = z.string().regex(/^(?:[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\/)?(?:[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)?$/u);
const tool = z.object({ name: toolName,
  title: z.string().optional(),
  inputSchema: schema.refine(s => s['type'] === 'object'), outputSchema: schema.optional(), description: z.string().max(16_384).optional(),
  annotations: z.object({ title: z.string().optional(), readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(), openWorldHint: z.boolean().optional() }).passthrough().optional(),
  icons: z.array(z.object({ src: z.string().regex(/^[^\s\p{Cc}]+$/u).pipe(z.url()), mimeType: z.string().optional(), sizes: z.array(z.string()).optional(),
    theme: z.enum(['light', 'dark']).optional() }).passthrough()).optional(),
  _meta: z.record(metaKey, z.unknown()).optional(),
}).passthrough();
const page = z.object({ ...cache, tools: z.array(z.unknown()).max(100), nextCursor: z.string().min(1).max(4096).optional() }).passthrough();

/** Keep the exact bounded tool JSON, independent of mutable server state and human policy. */
export async function discoverInventory(call: (method: 'server/discover' | 'tools/list', cursor?: string) => Promise<string>) {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.parse(checkedAt);
  const discoveryJson = await call('server/discover');
  const discoverResult = discovery.parse(JSON.parse(discoveryJson));
  if (Buffer.byteLength(JSON.stringify(discoverResult)) > 64 * 1024) throw new Error('inventory_limit');
  if (!discoverResult.supportedVersions.includes(version)) throw new Error('protocol_refused');
  let expiresAt = startedAt + Math.min(discoverResult.ttlMs, 300_000);
  const tools = [];
  const rejectedTools: { name?: string; revision: string; reason: string }[] = [];
  const names = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;
  for (let pages = 0; pages < 10; pages++) {
    const raw = await call('tools/list', cursor);
    const parsed = losslessJson(raw);
    const definitions = parsed.value instanceof Map ? parsed.value.get('tools')?.value : undefined;
    if (!Array.isArray(definitions)) throw new Error('protocol_refused');
    const result = page.parse(JSON.parse(raw));
    // Count TTLs from the start to avoid extending evidence while pages are read.
    expiresAt = Math.min(expiresAt, startedAt + result.ttlMs);
    for (const [index, rawTool] of result.tools.entries()) {
      const json = losslessJson(definitions[index]!.canonical);
      bytes += Buffer.byteLength(json.canonical);
      // Leave room in the event store's 1 MiB envelope for metadata and digests.
      if (bytes > 512 * 1024 || Buffer.byteLength(json.canonical) > 32 * 1024) throw new Error('inventory_limit');
      const checked = validateTool(rawTool);
      if (!checked.success) {
        rejectedTools.push({ ...checked.rejection, revision: json.digest });
        continue;
      }
      const definition = checked.definition;
      if (names.has(definition.name)) throw new Error('duplicate_tools');
      names.add(definition.name);
      const { readOnlyHint, destructiveHint } = definition.annotations ?? {};
      tools.push({ name: definition.name, revision: json.digest, reviewed: false,
        readOnly: readOnlyHint === true, destructive: destructiveHint === true,
        definition: json.canonical });
    }
    cursor = result.nextCursor;
    if (!cursor) {
      const identity = discoverResult._meta['io.modelcontextprotocol/serverInfo'];
      const serverInfo = { name: identity.name, version: identity.version };
      const snapshot = { checkedAt, expiresAt: new Date(expiresAt).toISOString(),
        toolCount: tools.length, tools, rejectedTools,
        discoverResult: losslessJson(discoveryJson).canonical,
        serverInfo,
        schemaDigest: catalogueDigest(tools) };
      return boundedInventory(snapshot);
    }
    if (cursors.has(cursor)) throw new Error('pagination_limit');
    cursors.add(cursor);
  }
  throw new Error('pagination_limit');
}

function validateTool(raw: unknown) {
  const checked = tool.safeParse(raw);
  const reason = checked.success ? schemaRejection(checked.data) : declarationRejection(checked.error);
  if (checked.success && !reason) return { success: true as const, definition: checked.data };
  const name = z.object({ name: toolName }).safeParse(raw);
  return { success: false as const, rejection: { ...(name.success ? { name: name.data.name } : {}), reason: reason! } };
}

function declarationRejection(error: z.ZodError) {
  const reasons = new Map([
    ['name', 'invalid_tool_name'], ['title', 'invalid_tool_title'], ['description', 'invalid_tool_description'],
    ['annotations', 'invalid_tool_annotations'], ['icons', 'invalid_tool_icons'], ['_meta', 'invalid_tool_metadata'],
    ['inputSchema', 'invalid_input_schema'], ['outputSchema', 'invalid_output_schema'],
  ]);
  return reasons.get(String(error.issues[0]?.path[0])) ?? 'invalid_tool_declaration';
}

function schemaRejection(definition: z.infer<typeof tool>) {
  for (const field of ['inputSchema', 'outputSchema'] as const) {
    const candidate = definition[field];
    if (!candidate) continue;
    const options = { strict: false, validateFormats: false, logger: false as const };
    const validator = candidate['$schema'] === 'http://json-schema.org/draft-07/schema#' ? new Ajv(options) : new Ajv2020(options);
    try { validator.compile(candidate); } catch { return field === 'inputSchema' ? 'invalid_input_schema' : 'invalid_output_schema'; }
  }
  return headerRejection(definition.inputSchema);
}

const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);
const schemaNodes = new Set(['items', 'prefixItems', 'additionalItems', 'contains', 'unevaluatedItems',
  'additionalProperties', 'unevaluatedProperties', 'propertyNames', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'contentSchema']);

function headerRejection(schema: unknown, headers = new Set<string>(), reachable?: boolean): string | undefined {
  if (!isObject(schema)) return;
  const node = schema;
  const rejection = headerAnnotationRejection(node, headers, reachable === true);
  if (rejection) return rejection;
  // Walk schema positions, not instance data in const, enum, default or examples.
  for (const [keyword, value] of Object.entries(node)) {
    let children: unknown[] = [];
    if (schemaMaps.has(keyword) && value && typeof value === 'object') children = Object.values(value);
    else if (schemaNodes.has(keyword)) children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      const reason = headerRejection(child, headers, keyword === 'properties' && reachable !== false);
      if (reason) return reason;
    }
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function headerAnnotationRejection(node: Record<string, unknown>, headers: Set<string>, reachable: boolean) {
  const header = node['x-mcp-header'];
  if (header === undefined) return;
  if (typeof header !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(header)) return 'invalid_header_name';
  if (!reachable) return 'unreachable_header';
  const types: unknown[] = Array.isArray(node['type']) ? node['type'] : [node['type']];
  if (!types.every(type => type === 'string' || type === 'integer' || type === 'boolean')) return 'invalid_header_type';
  if (headers.has(header.toLowerCase())) return 'duplicate_header_name';
  headers.add(header.toLowerCase());
  return undefined;
}

function boundedInventory<T>(inventory: T): T {
  if (Buffer.byteLength(JSON.stringify(inventory)) > 900 * 1024) throw new Error('inventory_limit');
  return inventory;
}


function catalogueDigest(tools: { name: string; revision: string }[]) {
  const revisions = tools.map(toolRevision);
  revisions.sort(compareNames);
  return losslessJson(JSON.stringify(revisions)).digest;
}
function toolRevision(tool: { name: string; revision: string }) {
  return { name: tool.name, revision: tool.revision };
}
function compareNames(first: { name: string }, second: { name: string }) {
  if (first.name < second.name) return -1;
  if (first.name > second.name) return 1;
  return 0;
}
