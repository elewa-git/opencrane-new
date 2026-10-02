import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Client } from 'minio/dist/esm/minio.mjs';
import { z } from 'zod';
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
          if (request.method === 'GET') return reply.send({ rows: await listFiles(options.db, options.silo, conversationId) });
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
  await ownConversation(options.store, options.silo, conversationId, memberId);
  return { memberId, conversationId };
}
function uploadStatus(status: string) {
  return ({ infected: 422, appended: 201, unavailable: 503 } as Record<string, number>)[status] ?? 409;
}
function refuse(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const known = new Map([['Unauthenticated', 401], ['Conversation refused', 403], ['Id reused', 409], ['Unsupported file type', 415], ['Unsafe Office document', 415], ['Invalid Office document', 415]]);
  return reply.code(error instanceof z.ZodError ? 400 : known.get(message) ?? 503)
    .send({ status: 'refused', error: known.has(message) ? message : 'Upload unavailable or refused' });
}
async function uploadFile(options: FileOptions, memberId: string, conversationId: string, key: string, name: string, bytes: Buffer) {
  const mime = await inspectFile(name, bytes), sha256 = createHash('sha256').update(bytes).digest('hex');
  const fileId = createHash('sha256').update(JSON.stringify([options.silo, conversationId, memberId, key])).digest('hex');
  const data = { conversationId, fileId, uploadedBy: memberId, name, size: bytes.length, sha256 };
  const previous = (await ownConversation(options.store, options.silo, conversationId, memberId)).find(row => row.event.id === `file-upload-${fileId}`);
  if (previous) {
    const saved = z.object({ fileId: z.string(), name: z.string(), sha256: z.string(), size: z.number() }).parse(previous.event.data);
    if (saved.name !== name || saved.sha256 !== sha256 || saved.size !== bytes.length) throw new Error('Id reused');
    return previous.event.type === 'file.rejected' ? { status: 'infected' as const, error: 'File rejected: malware detected', fileId } : { status: 'appended' as const, sequence: previous.sequence, fileId };
  }
  const objectKey = `${options.silo}/${conversationId}/${fileId}/${sha256}`;
  const quarantineKey = `${objectKey}/${randomUUID()}`;
  await options.objects.putObject('quarantine', quarantineKey, bytes);
  try {
    const verdict = await options.scan(bytes);
    const type = verdict === 'clean' ? 'file.uploaded' : 'file.rejected';
    if (verdict === 'clean') await options.objects.putObject('files', objectKey, bytes, bytes.length, { 'Content-Type': mime });
    const result = await fileCommand(options.store, options.silo, memberId, `file-upload-${fileId}`, type,
      verdict === 'clean' ? { ...data, mime, objectKey } : { ...data, reason: 'infected' });
    return result.status === 'appended' && verdict === 'infected' ? { status: 'infected' as const, error: 'File rejected: malware detected', fileId } : { ...result, fileId };
  } finally { await options.objects.removeObject('quarantine', quarantineKey); }
}
