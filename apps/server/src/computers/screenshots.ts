import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isIdentityAllowed, type AuthConfig } from '@opencrane/auth';
import { fileUploadedDataSchema, fileRejectedDataSchema } from '@opencrane/events';
import { sessionFor } from '../members/routes.ts';
import { ownConversation } from '../files/commands.ts';
import { uploadFile, type FileOptions } from '../files/routes.ts';
import { viewAccess } from './view-access.ts';
import type { LiveViewOptions } from './view.ts';
import { captureDesktop } from './capture.ts';

type Result = { status: string; fileId: string; sequence?: number; error?: string };
const statusCode = (status: string) => ({ appended: 201, infected: 422, unavailable: 503 } as Record<string, number>)[status] ?? 409;

export function registerScreenshots(app: FastifyInstance, config: AuthConfig, files?: FileOptions, view?: LiveViewOptions) {
  const pending = new Map<string, Promise<Result>>();
  app.post('/api/conversations/:conversationId/screenshots', { bodyLimit: 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!sessionFor(request, config, new Date())) return reply.code(401).send({ status: 'refused', error: 'Sign in to capture a screenshot.' });
    if (!files || !view) return reply.code(503).send({ status: 'unavailable', error: 'Screenshot unavailable.' });
    try {
      const context = await authoriseCapture(config, files, view, request);
      const { fileId, conversationId, memberId, fresh } = context;
      const previous = (await ownConversation(files.store, files.silo, conversationId, memberId, true)).find(row => row.event.id === `file-upload-${fileId}`);
      if (previous) {
        const file = (previous.event.type === 'file.uploaded' ? fileUploadedDataSchema : fileRejectedDataSchema).parse(previous.event.data);
        if (!file.screenshot) throw new Error('Id reused');
        await fresh();
        const status = previous.event.type === 'file.uploaded' ? 'appended' : 'infected';
        return reply.code(statusCode(status)).send({ status, fileId, sequence: previous.sequence, ...(status === 'infected' ? { error: 'File rejected: malware detected' } : {}) });
      }
      if (!pending.has(fileId) && pending.size >= 4) return reply.code(503).send({ status: 'unavailable', error: 'Screenshot busy. Retry shortly.' });
      let work = pending.get(fileId);
      if (!work) {
        work = captureFile(files, view, context); pending.set(fileId, work);
        void work.finally(() => pending.delete(fileId)).catch(() => undefined);
      }
      const result = await work;
      // Even a coalesced retry must recheck its own current session.
      await fresh();
      return reply.code(statusCode(result.status)).send(result);
    } catch (error) {
      return captureFailure(request, reply, error);
    }
  });
}

async function authoriseCapture(config: AuthConfig, files: FileOptions, view: LiveViewOptions, request: FastifyRequest) {
  const session = sessionFor(request, config, new Date());
  if (!session || session.orgId !== config.expectedOrgId || !isIdentityAllowed(config, { issuer: config.issuerUrl, subject: session.sub, orgId: session.orgId }) || request.headers.origin !== new URL(config.redirectUri).origin || request.headers['x-opencrane-view'] !== '1' || files.silo !== view.silo || files.store !== view.store || files.binding.silo !== files.silo) throw new Error('Access changed');
  const id = z.string().regex(/^[\w-]{1,200}$/u);
  const { conversationId } = z.object({ conversationId: id }).parse(request.params);
  const key = id.parse(request.headers['idempotency-key']);
  // Capture accepts no URL, filesystem path, bytes, dimensions or claimed identity.
  z.undefined().parse(request.body);
  const memberId = await files.feed.memberId(files.silo, config.issuerUrl, session.sub);
  if (!memberId) throw new Error('Access changed');
  const computer = await viewAccess(view, memberId, conversationId);
  const fresh = async () => {
    if (!sessionFor(request, config, new Date()) || JSON.stringify(await viewAccess(view, memberId, conversationId)) !== JSON.stringify(computer)) throw new Error('Access changed');
  };
  const fileId = createHash('sha256').update(JSON.stringify([files.silo, conversationId, memberId, `screenshot-${key}`])).digest('hex');
  return { computer, memberId, conversationId, fileId, key, fresh };
}
async function captureFile(files: FileOptions, view: LiveViewOptions, context: Awaited<ReturnType<typeof authoriseCapture>>): Promise<Result> {
  const { computer, memberId, conversationId, fileId, key, fresh } = context;
  const captured = await captureDesktop(await view.open(computer));
  await fresh();
  const result = await uploadFile(files, memberId, conversationId, `screenshot-${key}`, `Screenshot-${fileId.slice(0, 12)}.png`, captured.bytes,
    { computerId: computer.computerId, generation: computer.generation, capturedAt: captured.capturedAt, width: captured.width, height: captured.height }, fresh);
  return { status: result.status, fileId, ...('sequence' in result ? { sequence: result.sequence } : {}), ...('error' in result ? { error: result.error } : {}) };
}

function captureFailure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  const reason = error instanceof Error ? error.message : '';
  const access = ['Access changed', 'Desktop access required', 'Conversation refused', 'Wrong silo'].includes(reason);
  request.log.warn({ operation: 'screenshot.capture', reason: access ? 'access_changed' : 'capture_failed' }, 'Screenshot refused');
  return reply.code(error instanceof z.ZodError ? 400 : reason === 'Id reused' ? 409 : access ? 403 : 503)
    .send({ status: 'refused', error: access ? 'Screenshot access is not available. Ask the desktop owner for access.' : 'Screenshot could not be saved. Retry.' });
}
