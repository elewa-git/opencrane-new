import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { losslessJson } from '@opencrane/events/lossless-json';
import type { mcpServerDiscoveredDataSchema } from '@opencrane/events';

type CatalogueTool = NonNullable<ReturnType<typeof mcpServerDiscoveredDataSchema.parse>['tools']>[number];

export function toolEvidence(tool: Omit<CatalogueTool, 'revision' | 'definition'>): CatalogueTool {
  const annotations = { readOnlyHint: tool.readOnly === true,
    destructiveHint: tool.destructive === true };
  const definition = { name: tool.name, inputSchema: { type: 'object' }, annotations };
  const encoded = JSON.stringify(definition);
  const parsed = losslessJson(encoded);
  const review = { action: 'Use the fixture tool', consequence: 'Return the fixture result',
    targetArgument: 'id', fields: ['id'], stepUp: false };
  return { review, ...tool, definition: parsed.canonical, revision: parsed.digest };
}

export function catalogueEvidence(tools: CatalogueTool[]) {
  return { tools, toolCount: tools.length, schemaDigest: catalogueDigest(tools) };
}

