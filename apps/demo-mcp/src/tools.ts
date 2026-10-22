import { z } from 'zod';
import { losslessJson } from '@opencrane/events/lossless-json';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';

const quoteId = z.literal('DEMO-001');
const slot = z.enum(['morning', 'afternoon']);
const readArguments = z.strictObject({ quoteId });
const changeArguments = z.strictObject({ quoteId, slot });
const output = z.strictObject({ quoteId, slot, amountCents: z.literal(12500),
  effectCount: z.int().nonnegative() });
const readTool = {
  name: 'read_fixture_quote', description: 'Read a synthetic demo quote. No supplier is contacted.',
  inputSchema: z.toJSONSchema(readArguments), outputSchema: z.toJSONSchema(output),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true,
    openWorldHint: false },
  _meta: { 'io.opencrane/costCents': 0,
    'io.opencrane/review': { action: 'Read demo quote',
      consequence: 'Read the synthetic quote without changing it.',
      targetArgument: 'quoteId', fields: ['quoteId'], stepUp: false } },
};
const changeTool = {
  name: 'change_delivery_slot', description: 'Change only the synthetic demo delivery slot.',
  inputSchema: z.toJSONSchema(changeArguments), outputSchema: z.toJSONSchema(output),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false,
    openWorldHint: false },
  _meta: { 'io.opencrane/costCents': 0,
    'io.opencrane/review': { action: 'Change demo delivery slot',
      consequence: 'Replace the slot in this demo process. No real delivery changes.',
      targetArgument: 'quoteId', fields: ['quoteId', 'slot'], stepUp: false } },
};
const tools = [readTool, changeTool];
function toolRevision(tool: typeof readTool) {
  const encoded = JSON.stringify(tool);
  return { name: tool.name, revision: losslessJson(encoded).digest };
}
const revisions = tools.map(toolRevision);
const revision = catalogueDigest(revisions);
const serverInfo = { name: 'OpenCrane demo', version: '0.1.0' };
export const discovery = { resultType: 'complete', supportedVersions: ['2026-07-28'],
  capabilities: { tools: {}, experimental: { 'io.opencrane/expectedRevision': {} } },
  serverInfo, _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
  ttlMs: 300000, cacheScope: 'public' };
export const catalogue = { resultType: 'complete', tools, ttlMs: 300000, cacheScope: 'public' };

export function createFixture() {
  let deliverySlot: z.infer<typeof slot> = 'morning';
  let effectCount = 0;
  return callTool;

  function callTool(name: string, args: unknown, expectedRevision: unknown) {
    // Keep the revision check and effect synchronous against a fixed catalogue.
    if (expectedRevision !== revision) {
      throw new Error('revision_mismatch');
    }
    if (name === readTool.name) {
      readArguments.parse(args);
    } else if (name === changeTool.name) {
      const checked = changeArguments.parse(args);
      deliverySlot = checked.slot;
      effectCount += 1;
    } else {
      throw new Error('invalid_request');
    }
    const structuredContent = { quoteId: 'DEMO-001', amountCents: 12500,
      slot: deliverySlot, effectCount };
    const content = [{ type: 'text', text: JSON.stringify(structuredContent) }];
    return { content, structuredContent, isError: false };
  }
}
