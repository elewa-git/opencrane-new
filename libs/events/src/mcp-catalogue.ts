import type { mcpServerDiscoveredDataSchema } from './data.ts';
import { losslessJson, type JsonValue } from './lossless-json.ts';

type Catalogue = ReturnType<typeof mcpServerDiscoveredDataSchema.parse>;
type Tool = NonNullable<Catalogue['tools']>[number];

export function catalogueDigest(tools: { name: string; revision: string }[]): string {
  const revisions = tools.map(toolRevision);
  revisions.sort(compareNames);
  const encoded = JSON.stringify(revisions);
  const parsed = losslessJson(encoded);
  return parsed.digest;
}

function toolRevision(tool: { name: string; revision: string }) {
  return { name: tool.name, revision: tool.revision };
}

function compareNames(first: { name: string }, second: { name: string }): number {
  if (first.name < second.name) {
    return -1;
  }
  if (first.name > second.name) {
    return 1;
  }
  return 0;
}

export function validateMcpCatalogue(catalogue: Catalogue): void {
  const tools = catalogue.tools;
  if (!tools || catalogue.toolCount !== tools.length) {
    throw new Error('Incomplete tool catalogue');
  }
  const names = new Set<string>();
  const revisions: { name: string; revision: string }[] = [];
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error('Duplicate tool names');
    }
    names.add(tool.name);
    const revision = checkedToolRevision(tool);
    revisions.push({ name: tool.name, revision });
  }
  // Derive the digest from saved definitions before keeping any previous review.
  if (catalogueDigest(revisions) !== catalogue.schemaDigest) {
    throw new Error('Tool catalogue digest mismatch');
  }
}

function checkedToolRevision(tool: Tool): string {
  if (tool.definition === undefined) {
    throw new Error('Missing saved tool definition');
  }
  const parsed = losslessJson(tool.definition);
  const definition = objectFields(parsed);
  const inputSchema = definition.get('inputSchema');
  if (definition.get('name')?.value !== tool.name || !inputSchema) {
    throw new Error('Tool definition mismatch');
  }
  const inputFields = objectFields(inputSchema);
  if (inputFields.get('type')?.value !== 'object') {
    throw new Error('Tool definition mismatch');
  }
  const outputSchema = definition.get('outputSchema');
  if (outputSchema) {
    objectFields(outputSchema);
  }
  const annotationValue = definition.get('annotations');
  let annotations = new Map<string, JsonValue>();
  if (annotationValue) {
    annotations = objectFields(annotationValue);
  }
  const readOnly = annotations.get('readOnlyHint')?.value === true;
  const destructive = annotations.get('destructiveHint')?.value === true;
  if (readOnly !== (tool.readOnly === true) || destructive !== (tool.destructive === true)) {
    throw new Error('Tool annotations mismatch');
  }
  if (parsed.digest !== tool.revision) {
    throw new Error('Tool revision mismatch');
  }
  return parsed.digest;
}

function objectFields(value: JsonValue): Map<string, JsonValue> {
  if (!(value.value instanceof Map)) {
    throw new Error('Expected a tool definition object');
  }
  return value.value;
}

export function toolReviewDigest(tool: { costCents?: number | undefined; review?: unknown }): string {
  const evidence = { costCents: tool.costCents ?? null, review: tool.review ?? null };
  const encoded = JSON.stringify(evidence);
  return losslessJson(encoded).digest;
}
