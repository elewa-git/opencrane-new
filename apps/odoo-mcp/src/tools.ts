import { z } from 'zod';

function hasBoundedNoteBytes(note: string) {
  return Buffer.byteLength(note, 'utf8') <= 2048;
}

const noteDescription = 'At most 2,048 UTF-8 bytes (2 KiB). The note is not trimmed.';
const noteSchema = z.string().refine(hasBoundedNoteBytes).describe(noteDescription);

const snapshotSchema = z.object({
  id: z.int().positive(), name: z.string().max(2048), state: z.literal('draft'),
  note: z.union([noteSchema, z.literal(false)]),
  write_uid: z.tuple([z.int().positive(), z.string().max(2048)]), write_date: z.string(),
  lines: z.array(z.object({ id: z.int().positive(), description: z.string(),
    quantity: z.string().max(64) }).strict()).max(20),
}).strict();
const orderId = z.int().positive();
const readArguments = z.object({ orderId }).strict();
const writeArguments = readArguments.extend({ note: noteSchema,
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const displayLine = z.object({ id: orderId, description: z.string(), quantity: z.string() });
const readOutput = z.object({ snapshot: snapshotSchema,
  display: z.object({ name: z.string(), note: z.string(), author: z.string(),
    lines: z.array(displayLine) }), version: z.string(), noteDigest: z.string(),
  checkedAt: z.iso.datetime(), costCents: z.literal(0) }).strict();
const writeOutput = z.object({ outcome: z.literal('unavailable'), costCents: z.literal(0) }).strict();
const readTool = {
  name: 'read_draft_order', description: 'Unavailable until bounded Odoo reads are qualified.',
  inputSchema: z.toJSONSchema(readArguments), outputSchema: z.toJSONSchema(readOutput),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true,
    openWorldHint: true }, costCents: 0,
  review: { action: 'Read draft order', consequence: 'The order is read without changing it.',
    targetArgument: 'orderId', fields: ['orderId'], stepUp: false },
};
const writeTool = {
  name: 'update_draft_order_note', description: 'Unavailable until safe note writes are qualified.',
  inputSchema: z.toJSONSchema(writeArguments), outputSchema: z.toJSONSchema(writeOutput),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false,
    openWorldHint: true }, costCents: 0,
  review: { action: 'Replace draft note', consequence: 'The draft order note would be replaced.',
    targetArgument: 'orderId', fields: ['orderId', 'note', 'expectedVersion'], stepUp: false },
};
const serverInfo = { name: 'OpenCrane Odoo', version: '0.1.0' };
export const discover = { resultType: 'complete', supportedVersions: ['2026-07-28'],
  capabilities: { tools: {} }, serverInfo,
  _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo }, ttlMs: 0, cacheScope: 'public' };
export const catalogue = { resultType: 'complete', tools: [readTool, writeTool],
  ttlMs: 0, cacheScope: 'public' };

export function callTool(name: string, args: unknown) {
  if (name === writeTool.name) {
    writeArguments.parse(args);
    throw new Error('write_unavailable');
  }
  if (name === readTool.name) {
    readArguments.parse(args);
    throw new Error('read_unavailable');
  }
  throw new Error('unknown_tool');
}
