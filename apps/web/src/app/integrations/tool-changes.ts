import type { ToolPolicy } from '@opencrane/protocol';

type Catalogue = NonNullable<ToolPolicy['catalogue']>;
type SavedTool = NonNullable<Catalogue['tools']>[number];

interface ToolChangeRow {
  name: string;
  kind: 'Unchanged' | 'Schema changed' | 'Details changed' | 'Added' | 'Removed';
  before: string;
  after: string;
  access: string;
  fields: string[];
}

export interface ToolComparison {
  rows: ToolChangeRow[];
  counts: { added: number; removed: number; changed: number };
}

interface Definition {
  name?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export function compareToolCatalogues(policy: ToolPolicy): ToolComparison | null {
  const before = policy.previousCatalogue;
  const after = policy.catalogue;
  // Treat equal digests as a restart capture of the same list, not a new comparison.
  if (!before?.tools || !after?.tools || before.schemaDigest === after.schemaDigest) return null;

  const oldTools = new Map<string, SavedTool>();
  const currentTools = new Map<string, SavedTool>();
  for (const tool of before.tools) oldTools.set(tool.name, tool);
  for (const tool of after.tools) currentTools.set(tool.name, tool);

  const names = new Set([...oldTools.keys(), ...currentTools.keys()]);
  const rows: ToolChangeRow[] = [];
  const counts = { added: 0, removed: 0, changed: 0 };
  for (const name of names) {
    const oldTool = oldTools.get(name);
    const currentTool = currentTools.get(name);
    const row = compareTool(name, oldTool, currentTool, policy);
    rows.push(row);
    if (row.kind === 'Added') counts.added += 1;
    if (row.kind === 'Removed') counts.removed += 1;
    if (row.kind === 'Schema changed' || row.kind === 'Details changed') counts.changed += 1;
  }
  return { rows, counts };
}

function compareTool(
  name: string, oldTool: SavedTool | undefined, currentTool: SavedTool | undefined,
  policy: ToolPolicy,
): ToolChangeRow {
  const beforeDefinition = readDefinition(oldTool?.definition, name);
  const afterDefinition = readDefinition(currentTool?.definition, name);
  let kind: ToolChangeRow['kind'];
  const fields: string[] = [];
  if (!oldTool) kind = 'Added';
  else if (!currentTool) kind = 'Removed';
  else if (oldTool.revision === currentTool.revision) kind = 'Unchanged';
  else if (schemasDiffer(beforeDefinition, afterDefinition)) {
    kind = 'Schema changed';
    fields.push(...inputFieldChanges(beforeDefinition?.inputSchema, afterDefinition?.inputSchema));
    if (JSON.stringify(beforeDefinition?.outputSchema) !==
        JSON.stringify(afterDefinition?.outputSchema)) fields.push('Output schema changed');
  } else kind = 'Details changed';

  return { name, kind, before: detailText(oldTool, beforeDefinition),
    after: detailText(currentTool, afterDefinition),
    access: accessText(name, kind, policy), fields };
}

function readDefinition(value: string | undefined, name: string): Definition | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const definition: Definition = parsed;
    if (definition.name !== name ||
        typeof definition.inputSchema !== 'object' || definition.inputSchema === null) return null;
    return definition;
  } catch {
    return null;
  }
}

function schemasDiffer(before: Definition | null, after: Definition | null): boolean {
  if (!before || !after) return false;
  return JSON.stringify(before.inputSchema) !== JSON.stringify(after.inputSchema) ||
    JSON.stringify(before.outputSchema) !== JSON.stringify(after.outputSchema);
}

function inputFieldChanges(before: unknown, after: unknown): string[] {
  const oldFields = topLevelFields(before);
  const currentFields = topLevelFields(after);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [name, schema] of currentFields) {
    if (!oldFields.has(name)) added.push(name);
    else if (JSON.stringify(schema) !== JSON.stringify(oldFields.get(name))) changed.push(name);
  }
  for (const name of oldFields.keys()) if (!currentFields.has(name)) removed.push(name);
  const all = [...added, ...removed, ...changed];
  const visible = new Set(all.slice(0, 10));
  const result: string[] = [];
  function isVisible(name: string): boolean { return visible.has(name); }
  const shownAdded = added.filter(isVisible);
  const shownRemoved = removed.filter(isVisible);
  const shownChanged = changed.filter(isVisible);
  if (shownAdded.length) result.push(`Input fields added: ${shownAdded.join(', ')}`);
  if (shownRemoved.length) result.push(`Input fields removed: ${shownRemoved.join(', ')}`);
  if (shownChanged.length) result.push(`Input fields changed: ${shownChanged.join(', ')}`);
  if (all.length > 10) result.push(`and ${all.length - 10} more`);
  if (result.length === 0) result.push('Input schema changed');
  return result;
}

function topLevelFields(schema: unknown): Map<string, unknown> {
  if (typeof schema !== 'object' || schema === null || !('properties' in schema)) return new Map();
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return new Map();
  }
  return new Map(Object.entries(properties));
}

function detailText(tool: SavedTool | undefined, definition: Definition | null): string {
  if (!tool) return 'Not present';
  if (!definition) return 'Details not saved';
  if (typeof definition.description !== 'string') return 'No description saved';
  return definition.description.slice(0, 300);
}

function accessText(name: string, kind: ToolChangeRow['kind'], policy: ToolPolicy): string {
  if (kind === 'Removed') return 'Removed';
  const saved = policy.tools.find((tool) => tool.name === name);
  if (!saved?.reviewed && kind === 'Added') return 'Block (new)';
  if (!saved?.reviewed && kind !== 'Unchanged') return 'Block until reviewed';
  if (!saved?.reviewed) return 'Block until reviewed';
  if (saved.mode === 'allow') return 'Allow automatically';
  if (saved.mode === 'ask') return 'Ask';
  return 'Block';
}
