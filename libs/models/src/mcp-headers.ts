import { z } from 'zod';
import { publicationSchema } from '@opencrane/events';
type McpPublication = z.infer<typeof publicationSchema>;
import { losslessJson, type JsonValue } from './lossless-json.ts';

/** Discovery already checked schema positions; persist only exact properties paths from that revision. */
export function reviewedHeaders(tools: { name: string; definition?: string | undefined }[]) {
  const mappings: McpPublication['desired']['headerParameters'] = [];
  function walk(tool: string, raw: unknown, path: string[]) {
    if (typeof raw === 'boolean') return;
    const schema = z.record(z.string(), z.unknown()).parse(raw);
    if (typeof schema['x-mcp-header'] === 'string') mappings.push({ tool, path,
      headerName: `mcp-param-${schema['x-mcp-header'].toLowerCase()}`,
      types: z.array(z.enum(['string', 'integer', 'boolean'])).parse(Array.isArray(schema['type']) ? schema['type'] : [schema['type']]) });
    const properties = z.record(z.string(), z.unknown()).parse(schema['properties'] ?? {});
    for (const [name, child] of Object.entries(properties)) walk(tool, child, [...path, name]);
  }
  for (const tool of tools) if (tool.definition) walk(tool.name, z.object({ inputSchema: z.unknown() }).parse(JSON.parse(tool.definition)).inputSchema, []);
  return mappings;
}

/** All mapped values come from the exact authorised body, never an arbitrary client header. */
export function mcpHeaders(publication: McpPublication, body: string) {
  const root = losslessJson(body).value;
  if (!(root instanceof Map)) throw new Error('MCP object required');
  const params = root.get('params')?.value;
  if (!(params instanceof Map)) throw new Error('MCP params required');
  const headers: Record<string, string> = {};
  for (const mapping of publication.desired.headerParameters) {
    if (mapping.tool !== params.get('name')?.value) continue;
    let node = params.get('arguments');
    for (const key of mapping.path) node = node?.value instanceof Map ? node.value.get(key) : undefined;
    if (!node || node.value === null) continue;
    headers[mapping.headerName] = encode(node, mapping.types);
  }
  return headers;
}
function encode(node: JsonValue, types: string[]) {
  if (node.kind === 'number' && types.includes('integer')) return integer(node.canonical);
  if (node.kind === 'literal' && typeof node.value === 'boolean' && types.includes('boolean')) return String(node.value);
  if (node.kind !== 'string' || typeof node.value !== 'string' || !types.includes('string')) throw new Error('Invalid header type');
  const value = node.value;
  // Encoding also prevents control characters or Unicode from becoming HTTP header syntax.
  // eslint-disable-next-line no-control-regex -- protocol's permitted HTTP field bytes.
  return !/^[\x09\x20-\x7e]*$/u.test(value) || value.trim() !== value || /^=\?base64\?.*\?=$/u.test(value)
    ? `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=` : value;
}

/** Keep decimal precision until the safe-integer check; Number() alone can round a fraction into an integer. */
function integer(raw: string) {
  const [mantissa = '', exponent = '0'] = raw.split(/[eE]/u);
  const digits = mantissa.replace('-', '').replace('.', '').replace(/^0+/u, '');
  if (!digits) return '0';
  const significant = digits.replace(/0+$/u, '');
  const fraction = mantissa.includes('.') ? mantissa.length - mantissa.indexOf('.') - 1 : 0;
  const scale = Number(exponent) - fraction + digits.length - significant.length;
  if (!Number.isFinite(scale) || scale < 0 || significant.length + scale > 16) throw new Error('Unsafe header integer');
  const value = BigInt(`${mantissa.startsWith('-') ? '-' : ''}${significant}${'0'.repeat(scale)}`);
  if (value < -9007199254740991n || value > 9007199254740991n) throw new Error('Unsafe header integer');
  return String(value);
}
