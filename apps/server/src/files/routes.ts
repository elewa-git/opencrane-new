import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Client } from 'minio/dist/esm/minio.mjs';
import { z } from 'zod';
import { fileUploadedDataSchema } from '@opencrane/events';
import type { AuthConfig } from '@opencrane/auth';
import { memberAuthorisation } from '@opencrane/authz';
import { listFiles } from '@opencrane/projections';
import type { ChatOptions } from '../chat/routes.ts';
import { sessionFor } from '../members/routes.ts';
import { fileCommand, ownConversation } from './commands.ts';
import { inspectFile } from './types.ts';

export interface FileOptions extends Omit<ChatOptions, 'keys'> {
  objects: Client; scan(bytes: Buffer): Promise<'clean' | 'infected'>;
}
const id = z.string().regex(/^[\w-]{1,200}$/u);
const limit = 20 * 1024 * 1024;
export function registerFileRoutes(app: FastifyInstance, config: AuthConfig, options?: FileOptions) {
  app.get('/api/conversations/:conversationId/files/view', async (request, reply) => {
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    try {
      const { memberId, conversationId } = await authorise(options, config, request);
      const { path, preview } = z.object({ path: z.string(), preview: z.string().optional() }).parse(request.query);
      const rows = await ownConversation(options.store, options.silo, conversationId, memberId, true);
      const file = rows.filter(row => row.event.type === 'file.uploaded')
        .map(row => fileUploadedDataSchema.parse(row.event.data))
        .find(file => path === `uploads/${conversationId}/${file.fileId}/${file.name}`);
      if (!file) {
        await ownConversation(options.store, options.silo, conversationId, memberId);
        return reply.code(404).send({ status: 'not_found' });
      }
      if (!file.screenshot) await ownConversation(options.store, options.silo, conversationId, memberId);
      const stream = await options.objects.getObject('files', file.objectKey);
      return reply.header('Content-Type', file.mime).header('Content-Length', file.size)
        .header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Content-Disposition', `${preview === 'true' ? 'inline' : 'attachment'}; filename="${file.name}"`).send(stream);
    } catch (error) { return refuse(reply, error); }
  });
  // A raw body keeps this seam small: one file per request, no multipart parser or presigned credentials.
  void app.register((scope, _settings, done) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: limit }, (_request, body, done) => done(null, body));
    scope.route({ method: ['GET', 'POST'], url: '/api/conversations/:conversationId/files', bodyLimit: limit,
      async preParsing(request, reply, payload) {
        if (!sessionFor(request, config, new Date())) await reply.code(401).send({ status: 'refused' });
        return payload;
      },
      async handler(request, reply) {
        if (!options) return reply.code(503).send({ status: 'unavailable' });
        try {
          const { memberId, conversationId } = await authorise(options, config, request);
          if (request.method === 'GET') {
            const rows = await listFiles(options.db, options.silo, conversationId);
            const conversation = await ownConversation(options.store, options.silo, conversationId, memberId, true);
            const owner = z.object({ createdBy: z.string() }).parse(conversation[0]?.event.data).createdBy === memberId;
            const visible = owner ? rows : rows.filter(file => file.screenshot);
            if (!owner && !visible.length) throw new Error('Conversation refused');
            return reply.send({ rows: visible });
          }
          const name = z.string().regex(/^[\w][\w .()-]{0,119}$/u).parse(request.headers['x-file-name']);
          const key = id.parse(request.headers['idempotency-key']);
          if (!Buffer.isBuffer(request.body) || !request.body.length) return reply.code(400).send({ status: 'invalid_request' });
          const result = await uploadFile(options, memberId, conversationId, key, name, request.body);
          return reply.code(uploadStatus(result.status)).send(result);
        } catch (error) {
          return refuse(reply, error);
        }
      },
    });
    done();
  });
}
async function authorise(options: FileOptions, config: AuthConfig, request: FastifyRequest) {
  const session = sessionFor(request, config, new Date());
  if (!session) throw new Error('Unauthenticated');
  if (session.orgId !== config.expectedOrgId || options.silo !== options.binding.silo ||
      (request.method === 'POST' && request.headers.origin !== new URL(config.redirectUri).origin)) throw new Error('Conversation refused');
  const { conversationId } = z.object({ conversationId: id }).parse(request.params);
  const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub), auth = memberAuthorisation(options.binding);
  if (!memberId || !(await auth.check(memberId, 'member')).allowed || !(await auth.conversation(memberId, conversationId, request.method === 'POST' ? 'post' : 'read')).allowed) throw new Error('Conversation refused');
  await ownConversation(options.store, options.silo, conversationId, memberId, request.method === 'GET');
  return { memberId, conversationId };
}
function uploadStatus(status: string) {
  return ({ infected: 422, appended: 201, unavailable: 503 } as Record<string, number>)[status] ?? 409;
}
function refuse(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const known = new Map([['Unauthenticated', 401], ['Conversation refused', 403], ['Id reused', 409], ['Unsupported file type', 415], ['Unsafe Office document', 415], ['Invalid Office document', 415], ['File inspection timed out or exceeded limits', 415], ['File inspection failed or exceeded limits', 415], ['File inspection failed', 415]]);
  return reply.code(error instanceof z.ZodError ? 400 : known.get(message) ?? 503)
    .send({ status: 'refused', error: known.has(message) ? message : 'Upload unavailable or refused' });
}
export async function uploadFile(options: FileOptions, memberId: string, conversationId: string, key: string, name: string, bytes: Buffer, screenshot?: z.infer<typeof fileUploadedDataSchema>['screenshot'], fresh?: () => Promise<void>) {
  if (bytes.length > limit) throw new Error('File too large');
  const mime = await inspectFile(name, bytes), sha256 = createHash('sha256').update(bytes).digest('hex');
  const fileId = createHash('sha256').update(JSON.stringify([options.silo, conversationId, memberId, key])).digest('hex');
  const data = { conversationId, fileId, uploadedBy: memberId, name, size: bytes.length, sha256, ...(screenshot ? { screenshot } : {}) };
  const previous = (await ownConversation(options.store, options.silo, conversationId, memberId, !!screenshot)).find(row => row.event.id === `file-upload-${fileId}`);
  if (previous) {
    const saved = z.object({ fileId: z.string(), name: z.string(), sha256: z.string(), size: z.number() }).parse(previous.event.data);
    if (saved.name !== name || saved.sha256 !== sha256 || saved.size !== bytes.length) throw new Error('Id reused');
    return previous.event.type === 'file.rejected' ? { status: 'infected' as const, error: 'File rejected: malware detected', fileId } : { status: 'appended' as const, sequence: previous.sequence, fileId };
  }
  const objectKey = `${options.silo}/${conversationId}/${fileId}/${sha256}`;
  const verdict = await options.scan(bytes);
  await fresh?.();
  const type = verdict === 'clean' ? 'file.uploaded' : 'file.rejected';
  if (verdict === 'clean') await options.objects.putObject('files', objectKey, bytes, bytes.length, { 'Content-Type': mime });
  await fresh?.();
  const result = await fileCommand(options.store, options.silo, memberId, `file-upload-${fileId}`, type,
    verdict === 'clean' ? { ...data, mime, objectKey } : { ...data, reason: 'infected' }, fresh);
  return result.status === 'appended' && verdict === 'infected' ? { status: 'infected' as const, error: 'File rejected: malware detected', fileId } : { ...result, fileId };
}
