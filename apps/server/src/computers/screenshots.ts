import { recordIdSchema, fileUploadedDataSchema, fileRejectedDataSchema } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { sessionFor } from '../members/routes.ts';
import { sameOrigin } from '../members/guard.ts';
import { chatHistory } from '../chat/commands.ts';
import { FileRefusal } from '../files/refusals.ts';
import {
  findPreviousUpload, uploadFile, uploadIdentity, type FileOptions,
} from '../files/routes.ts';
import { sameViewComputer, viewAccess, ViewAccessRefused } from './view-access.ts';
import type { LiveViewOptions } from './view.ts';
import { captureDesktop } from './capture.ts';

type Result = { status: 'appended' | 'infected' | 'conflict'; fileId: string;
  sequence?: number; error?: string };
type Capture = Awaited<ReturnType<typeof authoriseCapture>>;

const statuses = { appended: 201, infected: 422, conflict: 409 };

export function registerScreenshots(app: FastifyInstance, config: AuthConfig,
  files?: FileOptions, view?: LiveViewOptions) {
  const pending = new Map<string, Promise<Result>>();
  async function screenshot(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    if (!sessionFor(request, config, new Date())) {
      return reply.code(401).send({ status: 'refused', error: 'Sign in to capture a screenshot.' });
    }
    if (!files || !view) {
      return reply.code(503).send({ status: 'unavailable', error: 'Screenshot unavailable.' });
    }
    try {
      const capture = await authoriseCapture(config, files, view, request);
      const { conversationId, fileId } = capture;
      const rows = await chatHistory(files.store, files.silo, conversationId);
      const previous = findPreviousUpload(rows, fileId);
      if (!previous && !pending.has(fileId) && pending.size >= 4) {
        return reply.code(503).send({ status: 'unavailable', error: 'Screenshot busy. Retry shortly.' });
      }
      const result = previous
        ? savedScreenshot(previous, fileId)
        : await currentCapture(pending, files, view, capture);
      // Check the current session even when returning a saved file or sharing a capture.
      await capture.checkAccess();
      return reply.code(statuses[result.status]).send(result);
    } catch (error) {
      return captureFailure(request, reply, error);
    }
  }
  app.post('/api/conversations/:conversationId/screenshots', { bodyLimit: 1024 }, screenshot);
}

function savedScreenshot(previous: StoredEvent, fileId: string): Result {
  const sequence = previous.sequence;
  const event = previous.event;
  if (event.type === 'file.uploaded' && fileUploadedDataSchema.parse(event.data).screenshot) {
    return { status: 'appended', fileId, sequence };
  }
  if (event.type === 'file.rejected' && fileRejectedDataSchema.parse(event.data).screenshot) {
    return { status: 'infected', fileId, sequence, error: 'File rejected: malware detected' };
  }
  throw new FileRefusal('id_reused');
}

function currentCapture(pending: Map<string, Promise<Result>>, files: FileOptions,
  view: LiveViewOptions, capture: Capture) {
  const { fileId } = capture;
  const previous = pending.get(fileId);
  if (previous) return previous;
  async function save() {
    try {
      return await captureFile(files, view, capture);
    } finally {
      pending.delete(fileId);
    }
  }
  const work = save();
  pending.set(fileId, work);
  return work;
}

async function captureComputer(view: LiveViewOptions, memberId: string, conversationId: string) {
  try {
    return await viewAccess(view, memberId, conversationId);
  } catch (error) {
    if (error instanceof ViewAccessRefused) {
      throw new FileRefusal('conversation_refused', { cause: error });
    }
    throw error;
  }
}

async function authoriseCapture(config: AuthConfig, files: FileOptions, view: LiveViewOptions,
  request: FastifyRequest) {
  const session = sessionFor(request, config, new Date());
  if (!session || !isOrganisationSession(config, session) || !sameOrigin(request, config) ||
      request.headers['x-opencrane-view'] !== '1') {
    throw new FileRefusal('conversation_refused');
  }
  // Check that desktop access and file storage refer to the same silo and event log.
  if (files.silo !== view.silo || files.store !== view.store || files.binding.silo !== files.silo) {
    throw new FileRefusal('conversation_refused');
  }
  const { conversationId } = z.object({ conversationId: recordIdSchema }).parse(request.params);
  const key = recordIdSchema.parse(request.headers['idempotency-key']);
  z.undefined().parse(request.body);
  const resolved = await files.feed.memberId(files.silo, config.issuerUrl, session.sub);
  if (!resolved) throw new FileRefusal('conversation_refused');
  const memberId = resolved;
  const computer = await captureComputer(view, memberId, conversationId);
  async function checkAccess() {
    if (!sessionFor(request, config, new Date())) {
      throw new FileRefusal('conversation_refused');
    }
    const current = await captureComputer(view, memberId, conversationId);
    if (!sameViewComputer(current, computer)) {
      throw new FileRefusal('conversation_refused');
    }
  }
  const uploadKey = `screenshot-${key}`;
  const fileId = uploadIdentity(files.silo, conversationId, memberId, uploadKey);
  return { computer, memberId, conversationId, fileId, uploadKey, checkAccess };
}

async function captureFile(files: FileOptions, view: LiveViewOptions,
  capture: Capture): Promise<Result> {
  const { computer, memberId, conversationId, fileId, uploadKey, checkAccess } = capture;
  await checkAccess();
  const desktop = await view.open(computer);
  const { bytes, capturedAt, width, height } = await captureDesktop(desktop);
  await checkAccess();
  const details = { computerId: computer.computerId, generation: computer.generation,
    capturedAt, width, height };
  const input = { key: uploadKey, name: `Screenshot-${fileId.slice(0, 12)}.png`,
    bytes, screenshot: details, checkAccess };
  const upload = await uploadFile(files, memberId, conversationId, input);
  const result: Result = { status: upload.status, fileId };
  if ('sequence' in upload) {
    result.sequence = upload.sequence;
  }
  if ('error' in upload) {
    result.error = upload.error;
  }
  return result;
}

function captureFailure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  const access = error instanceof FileRefusal && error.kind === 'conversation_refused';
  const reason = access ? 'access_changed' : 'capture_failed';
  request.log.warn({ operation: 'screenshot.capture', reason, err: error }, 'Screenshot refused');
  if (access) {
    return reply.code(403).send({ status: 'refused', reason,
      error: 'You need access to this chat to take a screenshot.' });
  }
  if (error instanceof FileRefusal) {
    return reply.code(error.statusCode).send({ status: 'refused', error: error.message });
  }
  const status = error instanceof z.ZodError ? 400 : 503;
  return reply.code(status).send({ status: 'refused', error: 'Screenshot could not be saved. Retry.' });
}
