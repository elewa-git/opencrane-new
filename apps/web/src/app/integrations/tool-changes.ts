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
  fullBefore: string | null;
  fullAfter: string | null;
}

export interface ToolComparison {
  rows: ToolChangeRow[];
  counts: { added: number; removed: number; changed: number };
  reviewable: boolean;
}

interface Definition {
  name?: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  metadata?: unknown;
  _meta?: unknown;
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
  let reviewable = true;
  for (const name of names) {
    const oldTool = oldTools.get(name);
    const currentTool = currentTools.get(name);
    const row = compareTool(name, oldTool, currentTool, policy);
    rows.push(row);
    if (!hasCompleteDefinitions(row, oldTool, currentTool)) reviewable = false;
    if (row.kind === 'Added') counts.added += 1;
    if (row.kind === 'Removed') counts.removed += 1;
    if (row.kind === 'Schema changed' || row.kind === 'Details changed') counts.changed += 1;
  }
  return { rows, counts, reviewable: reviewable && rows.length > 0 };
}

function hasCompleteDefinitions(
  row: ToolChangeRow, oldTool: SavedTool | undefined, currentTool: SavedTool | undefined,
): boolean {
  if (oldTool && row.fullBefore === null) return false;
  if (currentTool && row.fullAfter === null) return false;
  return true;
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

  if (oldTool && currentTool && oldTool.revision !== currentTool.revision) {
    fields.push(...detailChanges(beforeDefinition, afterDefinition));
  }

  return { name, kind,
    before: detailText(oldTool, beforeDefinition, afterDefinition),
    after: detailText(currentTool, afterDefinition, beforeDefinition),
    access: accessText(name, kind, policy), fields,
    fullBefore: fullDefinition(oldTool, beforeDefinition),
    fullAfter: fullDefinition(currentTool, afterDefinition) };
}

function fullDefinition(tool: SavedTool | undefined, definition: Definition | null): string | null {
  if (!tool?.definition || !definition) return null;
  return JSON.stringify(definition, null, 2);
}

function detailChanges(before: Definition | null, after: Definition | null): string[] {
  if (!before || !after) return [];
  const changes: string[] = [];
  if (before.title !== after.title) changes.push('Title changed');
  if (before.description !== after.description) changes.push('Description changed');
  if (JSON.stringify(before.annotations) !== JSON.stringify(after.annotations)) {
    changes.push('Annotations changed');
  }
  if (JSON.stringify(before.metadata) !== JSON.stringify(after.metadata) ||
      JSON.stringify(before._meta) !== JSON.stringify(after._meta)) {
    changes.push('Metadata changed');
  }
  return changes;
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

function detailText(
  tool: SavedTool | undefined, definition: Definition | null, other: Definition | null,
): string {
  if (!tool) return 'Not present';
  if (!definition) return 'Details not saved';
  const lines = [descriptionText(definition)];
  appendTitle(lines, definition, other);
  appendSavedValue(lines, 'Annotations', definition.annotations, other?.annotations);
  appendSavedValue(lines, 'Metadata', definition.metadata ?? definition._meta,
    other?.metadata ?? other?._meta);
  appendInputFields(lines, definition.inputSchema, other?.inputSchema);
  appendOutputSchema(lines, definition.outputSchema, other?.outputSchema);
  return lines.join('\n');
}

function descriptionText(definition: Definition): string {
  if (typeof definition.description !== 'string') return 'No description saved';
  return definition.description.slice(0, 300);
}

function appendTitle(lines: string[], definition: Definition, other: Definition | null): void {
  if (typeof definition.title !== 'string' && typeof other?.title !== 'string') return;
  lines.push(`Title: ${definition.title?.slice(0, 120) ?? 'Not saved'}`);
}

function appendOutputSchema(lines: string[], schema: unknown, otherSchema: unknown): void {
  if (JSON.stringify(schema) === JSON.stringify(otherSchema)) return;
  appendSavedValue(lines, 'Output schema', schema, otherSchema);
}

function appendSavedValue(
  lines: string[], label: string, value: unknown, otherValue: unknown,
): void {
  if (value === undefined && otherValue === undefined) return;
  if (value === undefined) {
    lines.push(`${label}: Not saved`);
    return;
  }
  const text = JSON.stringify(value);
  if (text) lines.push(`${label}: ${text.slice(0, 200)}`);
}

function appendInputFields(lines: string[], schema: unknown, otherSchema: unknown): void {
  const fields = topLevelFields(schema);
  const otherFields = topLevelFields(otherSchema);
  let shown = 0;
  for (const [name, value] of fields) {
    if (otherFields.has(name) && JSON.stringify(value) === JSON.stringify(otherFields.get(name))) {
      continue;
    }
    if (shown === 10) {
      lines.push('More input fields changed');
      break;
    }
    const detail = fieldText(value);
    lines.push(`Input ${name.slice(0, 100)}: ${detail}`);
    shown += 1;
  }
  if (shown === 0 && JSON.stringify(schema) !== JSON.stringify(otherSchema)) {
    appendSavedValue(lines, 'Input schema', schema, otherSchema);
  }
}

function fieldText(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return JSON.stringify(value)?.slice(0, 180) ?? 'unknown';
  }
  const parts: string[] = [];
  if ('type' in value && typeof value.type === 'string') parts.push(value.type);
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'type') continue;
    parts.push(`${key}: ${JSON.stringify(entry)}`);
  }
  return parts.join('; ').slice(0, 180);
}

function accessText(name: string, kind: ToolChangeRow['kind'], policy: ToolPolicy): string {
  if (kind === 'Removed') return 'Removed';
  const saved = policy.tools.find((tool) => tool.name === name);
  if (!saved?.reviewed) return unreviewedAccess(saved?.mode, kind);
  if (saved.mode === 'allow') return 'Allow automatically';
  if (saved.mode === 'ask') return 'Ask';
  return 'Block';
}

function unreviewedAccess(mode: string | undefined, kind: ToolChangeRow['kind']): string {
  if (kind === 'Added') return 'Block (new)';
  if (mode === 'ask') return 'Ask (saved choice; paused)';
  if (mode === 'allow') return 'Allow (saved choice; paused)';
  return 'Block until reviewed';
}
