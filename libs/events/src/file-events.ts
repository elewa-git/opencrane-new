import { z } from 'zod';
import { event } from './definition.ts';
const id = z.string().regex(/^[\w-]{1,200}$/u);
const screenshot = z.object({ computerId: id, generation: z.int().positive(), capturedAt: z.iso.datetime(),
  width: z.int().positive().max(4096), height: z.int().positive().max(4096) }).strict();
const identity = { conversationId: id, fileId: id, uploadedBy: id, name: z.string().regex(/^[\w][\w .()-]{0,119}$/u),
  size: z.int().positive().max(20 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/u), screenshot: screenshot.optional() };
export const fileUploadedDataSchema = z.object({ ...identity, mime: z.string().min(1), objectKey: z.string().regex(/^[\w/-]{1,800}$/u) }).strict();
export const fileRejectedDataSchema = z.object({ ...identity, reason: z.literal('infected') }).strict();
export const fileDeliveredDataSchema = z.object({ conversationId: id, fileId: id, computerId: id, sha256: identity.sha256,
  outcome: z.enum(['saved', 'kept_existing']).optional() }).strict();
const example = { conversationId: 'conv_1', fileId: 'file_1', uploadedBy: 'mem_1', name: 'notes.txt', size: 5, sha256: 'a'.repeat(64) };
export const fileEvents = [
  event('file.uploaded', 'conversation', 'A clean upload was scanned and stored.', fileUploadedDataSchema, { ...example, mime: 'text/plain', objectKey: 'silo/conv_1/file_1' }),
  event('file.rejected', 'conversation', 'The scanner refused an infected upload.', fileRejectedDataSchema, { ...example, reason: 'infected' }),
  event('file.delivered', 'conversation', 'The computer acknowledged a verified workspace file.', fileDeliveredDataSchema, { conversationId: 'conv_1', fileId: 'file_1', computerId: 'computer_1', sha256: example.sha256 }),
] as const;
