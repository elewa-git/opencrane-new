import { expect, it } from 'vitest';
import { discoverInventory } from '../src/integrations/inventory.ts';

const metadata = { resultType: 'complete', ttlMs: 1000, cacheScope: 'public' };
const discovery = { ...metadata, supportedVersions: ['2026-07-28'], capabilities: { tools: {} },
  _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Fixture', version: '1' } } };
const validTool = { name: 'read', inputSchema: { type: 'object' } };
const bound = { type: 'string', 'x-mcp-header': 'Region' };
const inventory = (tools: unknown[]) => discoverInventory(method => Promise.resolve(JSON.stringify(
  method === 'server/discover' ? discovery : { ...metadata, tools },
)));

it('accepts declared primitive unions, metadata, icons and instance data without treating them as header annotations', async () => {
  const definition = { ...validTool, title: 'Read', description: 'Read a value',
    icons: [{ src: 'https://example.test/icon.png', sizes: ['any', '48x48'], mimeType: 'image/png', theme: 'dark' }],
    annotations: { title: 'Display name', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { 'org.example/source': 'fixture', plain: { anything: true } },
    inputSchema: { type: 'object', properties: {
      'x-mcp-header': { type: ['string', 'integer', 'boolean'], 'x-mcp-header': "!#$%&'*+-.^_`|~AZ09" },
      data: { const: { 'x-mcp-header': 'not an annotation' }, default: { 'x-mcp-header': false } },
    } },
    outputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
    extension: { preserved: true },
  };
  const discovered = await inventory([definition]);
  expect(discovered.toolCount).toBe(1);
  expect(JSON.parse(discovered.tools[0]!.definition)).toEqual(definition);
});

it.each<[Record<string, unknown>, string]>([
  [{ title: 42 }, 'invalid_tool_title'],
  [{ description: false }, 'invalid_tool_description'],
  [{ name: 42 }, 'invalid_tool_name'],
  [{ annotations: null }, 'invalid_tool_annotations'],
  [{ annotations: { title: false } }, 'invalid_tool_annotations'],
  ...['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].map<[Record<string, unknown>, string]>(hint =>
    [{ annotations: { [hint]: 'true' } }, 'invalid_tool_annotations']),
  [{ icons: {} }, 'invalid_tool_icons'],
  [{ icons: [null] }, 'invalid_tool_icons'],
  [{ icons: [{}] }, 'invalid_tool_icons'],
  [{ icons: [{ src: 42 }] }, 'invalid_tool_icons'],
  [{ icons: [{ src: 'not a URI' }] }, 'invalid_tool_icons'],
  [{ icons: [{ src: ' https://example.test/icon.png ' }] }, 'invalid_tool_icons'],
  [{ icons: [{ src: 'https://example.test/\nicon.png' }] }, 'invalid_tool_icons'],
  [{ icons: [{ src: 'https://example.test/icon.png', mimeType: 42 }] }, 'invalid_tool_icons'],
  [{ icons: [{ src: 'https://example.test/icon.png', sizes: [42] }] }, 'invalid_tool_icons'],
  [{ icons: [{ src: 'https://example.test/icon.png', theme: 'blue' }] }, 'invalid_tool_icons'],
  [{ _meta: [] }, 'invalid_tool_metadata'],
  [{ _meta: { 'bad key': true } }, 'invalid_tool_metadata'],
  [{ inputSchema: null }, 'invalid_input_schema'],
  [{ inputSchema: { type: 'array' } }, 'invalid_input_schema'],
  [{ inputSchema: { type: 'object', required: 'id' } }, 'invalid_input_schema'],
  [{ outputSchema: false }, 'invalid_output_schema'],
  [{ outputSchema: { type: 'invalid' } }, 'invalid_output_schema'],
])('excludes malformed declared Tool fields %j with a safe field-specific reason', async (fields, reason) => {
  const discovered = await inventory([{ ...validTool, ...fields }, { ...validTool, name: 'sibling' }]);
  expect(discovered.tools.map(t => t.name)).toEqual(['sibling']);
  expect(discovered).toMatchObject({ toolCount: 1, rejectedTools: [{ reason }] });
});

it.each([
  { 'x-mcp-header': 'Root' },
  { properties: { rows: { type: 'array', items: bound } } },
  { properties: { rows: { type: 'array', prefixItems: [bound] } } },
  ...['allOf', 'anyOf', 'oneOf'].map(keyword => ({ [keyword]: [{ properties: { region: bound } }] })),
  ...['not', 'if', 'then', 'else', 'contains', 'additionalProperties', 'unevaluatedProperties', 'propertyNames'].map(keyword => ({ [keyword]: bound })),
  { $defs: { region: bound }, properties: { region: { $ref: '#/$defs/region' } } },
  { definitions: { region: bound } },
  { patternProperties: { '^region$': bound } },
  { dependentSchemas: { region: { properties: { region: bound } } } },
])('excludes headers outside a static properties path: %j', async keywords => {
  const discovered = await inventory([{ ...validTool, inputSchema: { type: 'object', ...keywords } }]);
  expect(discovered).toMatchObject({ toolCount: 0, rejectedTools: [{ reason: 'unreachable_header' }] });
});

it('excludes case-insensitive header duplicates across nested properties, but permits distinct headers and tools', async () => {
  const properties = { region: { type: 'string', 'x-mcp-header': 'Region' }, nested: { type: 'object', properties: {
    zone: { type: 'integer', 'x-mcp-header': 'region' },
  } } };
  const rejected = await inventory([{ ...validTool, inputSchema: { type: 'object', properties } }]);
  expect(rejected).toMatchObject({ toolCount: 0, rejectedTools: [{ reason: 'duplicate_header_name' }] });
  properties.nested.properties.zone['x-mcp-header'] = 'Zone';
  const accepted = await inventory([{ ...validTool, inputSchema: { type: 'object', properties } },
    { name: 'other', inputSchema: { type: 'object', properties: { enabled: { type: 'boolean', 'x-mcp-header': 'Region' } } } }]);
  expect(accepted.toolCount).toBe(2);
});

it.each([{ type: 'array', items: { type: 'string' } }, { type: 'string' }, { type: 'number' },
  { type: 'integer' }, { type: 'boolean' }, { type: 'null' }, {}])(
  'retains output schema %j as immutable definition evidence and includes it in both digests', async outputSchema => {
    const definition = { ...validTool, outputSchema };
    const original = JSON.stringify(definition);
    const discovered = await inventory([definition]);
    expect(discovered.toolCount).toBe(1);
    expect(JSON.parse(discovered.tools[0]!.definition)).toEqual(JSON.parse(original));
    Object.assign(outputSchema, { description: 'Changed after discovery' });
    const changed = await inventory([definition]);
    expect(JSON.parse(discovered.tools[0]!.definition)).toEqual(JSON.parse(original));
    expect(changed.tools[0]!.revision).not.toBe(discovered.tools[0]!.revision);
    expect(changed.schemaDigest).not.toBe(discovered.schemaDigest);
  },
);

it.each(['number', 'object', 'array', 'null', undefined, ['string', 'number'], ['string', 'null']])(
  'excludes a header parameter with prohibited or ambiguous type %j', async type => {
    const discovered = await inventory([{ ...validTool, inputSchema: { type: 'object', properties: {
      region: { type, 'x-mcp-header': 'Region' },
    } } }]);
    expect(discovered).toMatchObject({ toolCount: 0, tools: [], rejectedTools: [{ name: 'read', reason: 'invalid_header_type' }] });
  },
);

it.each(['', 'Region\r\nInjected: value', 'Region\n', 'Region\t', 'Region\u0000', 'Region\u007f', 'bad name', 'bad:name', 'région', 42])(
  'excludes an invalid header name %j with a safe reason while retaining sibling tools', async header => {
    const rejected = { name: 'bad', inputSchema: { type: 'object', properties: {
      region: { type: 'string', 'x-mcp-header': header },
    } } };
    const discovered = await inventory([rejected, validTool]);
    expect(discovered.tools.map(t => t.name)).toEqual(['read']);
    expect(discovered).toMatchObject({ toolCount: 1, rejectedTools: [{ name: 'bad', reason: 'invalid_header_name' }] });
    expect(JSON.stringify(discovered)).not.toContain('Injected');
  },
);
