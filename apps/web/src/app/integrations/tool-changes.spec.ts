import { toolPolicySchema } from '@opencrane/protocol';
import { describe, expect, it } from 'vitest';
import { compareToolCatalogues } from './tool-changes';

const checkedAt = '2026-10-15T09:00:00.000Z';
const expiresAt = '2026-10-15T09:05:00.000Z';

function digest(value: string): string {
  let number = 0;
  for (const character of value) number = (number * 31 + character.charCodeAt(0)) >>> 0;
  return number.toString(16).padStart(64, '0');
}

function tool(name: string, description: string, inputSchema: object, outputSchema?: object) {
  const definition = JSON.stringify({ name, description, inputSchema, outputSchema });
  return { name, revision: digest(definition), reviewed: false, definition };
}

function catalogue(tools: ReturnType<typeof tool>[]) {
  return { serverId: 'fixture-server', toolCount: tools.length,
    schemaDigest: digest(JSON.stringify(tools.map(({ name, revision }) => ({ name, revision })))),
    checkedAt, expiresAt, tools };
}

function policy(before: ReturnType<typeof tool>[] | null, after: ReturnType<typeof tool>[] | null) {
  const previousCatalogue = before === null ? null : catalogue(before);
  const currentCatalogue = after === null ? null : catalogue(after);
  return toolPolicySchema.parse({ connectionId: 'fixture-connection', accountMode: 'none',
    published: false, driftHeld: true, sequence: 2, previousCatalogue,
    catalogue: currentCatalogue, checkedAt, expiresAt,
    tools: after?.map(({ name, revision }) => ({ name, revision, reviewed: false,
      readOnly: false, mode: 'block', suggestion: 'ask' })) ?? [] });
}

describe('changed tool comparison', () => {
  const input = { type: 'object', properties: { account: { type: 'string' } } };

  it('classifies unchanged, schema, details, added and removed tools', () => {
    const before = [tool('same', 'Same', input), tool('schema', 'Before', input),
      tool('details', 'Before', input), tool('removed', 'Gone', input)];
    const changedInput = { type: 'object', properties: { amount: { type: 'number' } } };
    const after = [before[0]!, tool('schema', 'Before', changedInput),
      tool('details', 'After', input), tool('added', 'New', input)];
    const result = compareToolCatalogues(policy(before, after));
    expect(result?.rows.map((row) => row.kind)).toEqual([
      'Unchanged', 'Schema changed', 'Details changed', 'Removed', 'Added',
    ]);
    expect(result?.counts).toEqual({ added: 1, removed: 1, changed: 2 });
    expect(result?.rows[1]?.fields).toContain('Input fields removed: account');
    expect(result?.rows[1]?.fields).toContain('Input fields added: amount');
    expect(result?.rows[2]?.before).toContain('Before');
    expect(result?.rows[2]?.after).toContain('After');
  });

  it('reports output changes and limits a long field list', () => {
    const oldTool = tool('many', 'Same', input, { type: 'object' });
    const properties = Object.fromEntries(Array.from({ length: 12 }, (_, index) =>
      [`field${index}`, { type: 'string' }]));
    const newTool = tool('many', 'Same', { type: 'object', properties },
      { type: 'object', properties: { result: { type: 'string' } } });
    const result = compareToolCatalogues(policy([oldTool], [newTool]));
    expect(result?.rows[0]?.kind).toBe('Schema changed');
    expect(result?.rows[0]?.fields.join(' ')).toContain('and 3 more');
    expect(result?.rows[0]?.fields.join(' ')).toContain('Output schema changed');
  });

  it('shows old and new field limits and marks an added field', () => {
    const oldInput = { type: 'object', properties: {
      note: { type: 'string', maxLength: 500 },
    } };
    const newInput = { type: 'object', properties: {
      note: { type: 'string', maxLength: 2000 },
      internal: { type: 'boolean' },
    } };
    const result = compareToolCatalogues(policy(
      [tool('update_note', 'Updates a draft order note', oldInput)],
      [tool('update_note', 'Updates a draft order note', newInput)],
    ));
    const changed = result?.rows[0];
    expect(changed?.kind).toBe('Schema changed');
    expect(changed?.before).toContain('maxLength: 500');
    expect(changed?.after).toContain('maxLength: 2000');
    expect(changed?.after).toContain('internal: boolean');
    expect(changed?.fields).toContain('Input fields added: internal');
  });

  it('shows both titles when only a title changes', () => {
    const oldTool = tool('lookup', 'Looks up an order', input);
    const newTool = tool('lookup', 'Looks up an order', input);
    oldTool.definition = JSON.stringify({ name: 'lookup', title: 'Find order',
      description: 'Looks up an order', inputSchema: input });
    newTool.definition = JSON.stringify({ name: 'lookup', title: 'Search orders',
      description: 'Looks up an order', inputSchema: input });
    newTool.revision = digest(newTool.definition);
    const result = compareToolCatalogues(policy([oldTool], [newTool]));
    expect(result?.rows[0]?.kind).toBe('Details changed');
    expect(result?.rows[0]?.before).toContain('Find order');
    expect(result?.rows[0]?.after).toContain('Search orders');
    expect(result?.rows[0]?.fields).toContain('Title changed');
  });

  it('withholds counts when either snapshot is absent or digests match', () => {
    const saved = tool('same', 'Same', input);
    expect(compareToolCatalogues(policy(null, [saved]))).toBeNull();
    expect(compareToolCatalogues(policy([saved], null))).toBeNull();
    expect(compareToolCatalogues(policy([saved], [saved]))).toBeNull();
  });

  it('shows a safe placeholder for a missing or invalid definition', () => {
    const before = tool('missing', 'Before', input);
    const after = tool('missing', 'After', input);
    delete (before as { definition?: string }).definition;
    after.definition = '{invalid';
    const result = compareToolCatalogues(policy([before], [after]));
    expect(result?.rows[0]?.before).toBe('Details not saved');
    expect(result?.rows[0]?.after).toBe('Details not saved');
  });

  it('limits untrusted descriptions without changing the tool name', () => {
    const name = 'x'.repeat(2000);
    const before = tool(name, 'Before', input);
    const after = tool(name, '<img src=x onerror=alert(1)>'.repeat(100), input);
    const result = compareToolCatalogues(policy([before], [after]));
    expect(result?.rows[0]?.name).toHaveLength(2000);
    expect(result?.rows[0]?.kind).toBe('Details changed');
    expect(result?.rows[0]?.after).toHaveLength(300);
  });
});
