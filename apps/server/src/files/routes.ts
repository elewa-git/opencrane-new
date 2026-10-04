import { createHash } from 'node:crypto';
import type {
  FastifyBodyParser,
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import type { Client } from 'minio/dist/esm/minio.mjs';
import { z } from 'zod';
import { fileUploadedDataSchema } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import type { AuthConfig } from '@opencrane/auth';
import { memberAuthorisation } from '@opencrane/authz';
import { listFiles } from '@opencrane/projections';
import type { ChatOptions } from '../chat/routes.ts';
import { sessionFor } from '../members/routes.ts';
import { fileCommand, ownConversation } from './commands.ts';
import {
  FileRefusal,
  FileUnavailable,
  isDependencyOutage,
  parseFileInput,
} from './refusals.ts';
import { inspectFile } from './types.ts';

export interface FileOptions extends Omit<ChatOptions, 'keys'> {
  objects: Client;
  scan(bytes: Buffer): Promise<'clean' | 'infected'>;
}

const id = z.string().regex(/^[\w-]{1,200}$/u);
const limit = 20 * 1024 * 1024;
const conversationParams = z.object({ conversationId: id });
const viewQuery = z.object({ path: z.string(), preview: z.string().optional() });
const filename = z.string().regex(/^[\w][\w .()-]{0,119}$/u);
const conversationOwner = z.object({ createdBy: z.string() });
const savedUpload = z.object({
  fileId: z.string(),
  name: z.string(),
  sha256: z.string(),
  size: z.number(),
});
type UploadedFile = z.infer<typeof fileUploadedDataSchema>;

export function registerFileRoutes(
  app: FastifyInstance,
  config: AuthConfig,
  options?: FileOptions,
) {
  async function viewHandler(request: FastifyRequest, reply: FastifyReply) {
    return handleFileView(options, config, request, reply);
  }
  app.get('/api/conversations/:conversationId/files/view', viewHandler);

  function fileRoutes(scope: FastifyInstance, _settings: unknown, done: () => void) {
    function authenticateUpload(
      request: FastifyRequest,
      _reply: FastifyReply,
      authenticated: HookHandlerDoneFunction,
    ) {
      if (!sessionFor(request, config, new Date())) {
        authenticated(new FileRefusal('unauthenticated'));
        return;
      }
      authenticated();
    }
    async function fileHandler(request: FastifyRequest, reply: FastifyReply) {
      return handleFileRequest(options, config, request, reply);
    }
    scope.setErrorHandler(handleParserError);
    // One raw file per request bounds memory without multipart or presigned credentials.
    const parserOptions = { parseAs: 'buffer' as const, bodyLimit: limit };
    scope.addContentTypeParser('application/octet-stream', parserOptions, parseFileBody);
    const route = {
      method: ['GET', 'POST'] as ('GET' | 'POST')[],
      url: '/api/conversations/:conversationId/files',
      bodyLimit: limit,
      onRequest: authenticateUpload,
      handler: fileHandler,
    };
    scope.route(route);
    done();
  }
  void app.register(fileRoutes);
}

const parseFileBody: FastifyBodyParser<Buffer> = function parseFileBody(_request, body, done) {
  done(null, body);
};

function handleParserError(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
  if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    const cause = { cause: error };
    const refusal = new FileRefusal('file_too_large', cause);
    return refuse(reply, refusal);
  }
  if (error instanceof FileRefusal) {
    return refuse(reply, error);
  }
  return reply.send(error);
}

async function handleFileView(
  options: FileOptions | undefined,
  config: AuthConfig,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!options) {
    const response = { status: 'unavailable' };
    reply.code(503);
    return reply.send(response);
  }
  try {
    const { memberId, conversationId } = await authorise(options, config, request);
    const { path, preview } = parseFileInput(viewQuery, request.query);
    const rows = await ownConversation(options.store, options.silo, conversationId, memberId, true);
    const file = findFileAtPath(rows, conversationId, path);
    if (!file) {
      await ownConversation(options.store, options.silo, conversationId, memberId);
      const response = { status: 'not_found' };
      reply.code(404);
      return reply.send(response);
    }
    if (!file.screenshot) {
      await ownConversation(options.store, options.silo, conversationId, memberId);
    }
    let stream: Awaited<ReturnType<Client['getObject']>>;
    try {
      stream = await options.objects.getObject('files', file.objectKey);
    } catch (error) {
      if (isDependencyOutage(error)) {
        const cause = { cause: error };
        throw new FileUnavailable('object_store', cause);
      }
      throw error;
    }
    let disposition = 'attachment';
    if (preview === 'true') {
      disposition = 'inline';
    }
    reply.header('Content-Type', file.mime);
    reply.header('Content-Length', file.size);
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('Content-Disposition', `${disposition}; filename="${file.name}"`);
    return reply.send(stream);
  } catch (error) {
    return refuse(reply, error);
  }
}

function findFileAtPath(rows: StoredEvent[], conversationId: string, path: string) {
  for (const row of rows) {
    if (row.event.type !== 'file.uploaded') {
      continue;
    }
    const file = fileUploadedDataSchema.parse(row.event.data);
    if (path === `uploads/${conversationId}/${file.fileId}/${file.name}`) {
      return file;
    }
  }
  return undefined;
}

async function handleFileRequest(
  options: FileOptions | undefined,
  config: AuthConfig,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!options) {
    const response = { status: 'unavailable' };
    reply.code(503);
    return reply.send(response);
  }
  try {
    const { memberId, conversationId } = await authorise(options, config, request);
    if (request.method === 'GET') {
      const rows = await visibleFiles(options, conversationId, memberId);
      const response = { rows };
      return reply.send(response);
    }
    const name = parseFileInput(filename, request.headers['x-file-name']);
    const key = parseFileInput(id, request.headers['idempotency-key']);
    if (!Buffer.isBuffer(request.body)) {
      throw new FileRefusal('invalid_request');
    }
    const result = await uploadFile(options, memberId, conversationId, key, name, request.body);
    const status = uploadStatus(result.status);
    reply.code(status);
    return reply.send(result);
  } catch (error) {
    return refuse(reply, error);
  }
}

async function visibleFiles(options: FileOptions, conversationId: string, memberId: string) {
  const rows = await listFiles(options.db, options.silo, conversationId);
  const conversation = await ownConversation(
    options.store, options.silo, conversationId, memberId, true,
  );
  const owner = conversationOwner.parse(conversation[0]?.event.data);
  if (owner.createdBy === memberId) {
    return rows;
  }
  function isScreenshot(file: (typeof rows)[number]) {
    return Boolean(file.screenshot);
  }
  const visible = rows.filter(isScreenshot);
  if (!visible.length) {
    throw new FileRefusal('conversation_refused');
  }
  return visible;
}

async function authorise(options: FileOptions, config: AuthConfig, request: FastifyRequest) {
  const session = sessionFor(request, config, new Date());
  if (!session) {
    throw new FileRefusal('unauthenticated');
  }
  const wrongOrganisation = session.orgId !== config.expectedOrgId;
  const wrongSilo = options.silo !== options.binding.silo;
  const appOrigin = new URL(config.redirectUri).origin;
  const wrongOrigin = request.method === 'POST' && request.headers.origin !== appOrigin;
  if (wrongOrganisation || wrongSilo || wrongOrigin) {
    throw new FileRefusal('conversation_refused');
  }
  const { conversationId } = parseFileInput(conversationParams, request.params);
  const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
  if (!memberId) {
    throw new FileRefusal('conversation_refused');
  }
  const auth = memberAuthorisation(options.binding);
  const membership = await auth.check(memberId, 'member');
  if (!membership.allowed) {
    throw new FileRefusal('conversation_refused');
  }
  let action: 'post' | 'read' = 'read';
  if (request.method === 'POST') {
    action = 'post';
  }
  const permission = await auth.conversation(memberId, conversationId, action);
  if (!permission.allowed) {
    throw new FileRefusal('conversation_refused');
  }
  await ownConversation(
    options.store, options.silo, conversationId, memberId, request.method === 'GET',
  );
  return { memberId, conversationId };
}

type UploadStatus = 'appended' | 'infected' | 'unavailable' | 'conflict';

function uploadStatus(status: UploadStatus) {
  switch (status) {
    case 'infected':
      return 422;
    case 'appended':
      return 201;
    case 'unavailable':
      return 503;
    case 'conflict':
      return 409;
  }
}

function refuse(reply: FastifyReply, error: unknown) {
  if (error instanceof FileRefusal) {
    const response = { status: 'refused', error: error.message };
    reply.code(error.statusCode);
    return reply.send(response);
  }
  if (error instanceof FileUnavailable) {
    const response = { status: 'unavailable', error: error.message };
    reply.code(error.statusCode);
    return reply.send(response);
  }
  const response = { status: 'failed', error: 'Unexpected failure' };
  reply.code(500);
  return reply.send(response);
}

async function inspectUpload(name: string, bytes: Buffer) {
  try {
    return await inspectFile(name, bytes);
  } catch (error) {
    // Parser details stay in the cause; clients receive a stable content refusal.
    const cause = { cause: error };
    throw new FileRefusal('unsupported_file', cause);
  }
}

function sha256Digest(value: string | Buffer) {
  const hash = createHash('sha256');
  hash.update(value);
  return hash.digest('hex');
}

function findPreviousUpload(rows: StoredEvent[], fileId: string) {
  for (const row of rows) {
    if (row.event.id === `file-upload-${fileId}`) {
      return row;
    }
  }
  return undefined;
}

function acknowledgePreviousUpload(
  previous: StoredEvent,
  fileId: string,
  name: string,
  sha256: string,
  size: number,
) {
  const saved = savedUpload.parse(previous.event.data);
  if (saved.name !== name || saved.sha256 !== sha256 || saved.size !== size) {
    throw new FileRefusal('id_reused');
  }
  if (previous.event.type === 'file.rejected') {
    return infectedUpload(fileId);
  }
  return { status: 'appended' as const, sequence: previous.sequence, fileId };
}

function infectedUpload(fileId: string) {
  return { status: 'infected' as const, error: 'File rejected: malware detected', fileId };
}

export async function uploadFile(
  options: FileOptions,
  memberId: string,
  conversationId: string,
  key: string,
  name: string,
  bytes: Buffer,
  screenshot?: UploadedFile['screenshot'],
  fresh?: () => Promise<void>,
) {
  if (!bytes.length) {
    throw new FileRefusal('invalid_request');
  }
  if (bytes.length > limit) {
    throw new FileRefusal('file_too_large');
  }
  const mime = await inspectUpload(name, bytes);
  const sha256 = sha256Digest(bytes);
  const identity = JSON.stringify([options.silo, conversationId, memberId, key]);
  const fileId = sha256Digest(identity);
  const data = {
    conversationId,
    fileId,
    uploadedBy: memberId,
    name,
    size: bytes.length,
    sha256,
    ...(screenshot ? { screenshot } : {}),
  };
  const rows = await ownConversation(
    options.store, options.silo, conversationId, memberId, Boolean(screenshot),
  );
  const previous = findPreviousUpload(rows, fileId);
  if (previous) {
    return acknowledgePreviousUpload(previous, fileId, name, sha256, bytes.length);
  }
  const objectKey = `${options.silo}/${conversationId}/${fileId}/${sha256}`;
  const verdict = await options.scan(bytes);
  await fresh?.();
  let type: 'file.uploaded' | 'file.rejected';
  let eventData: object;
  if (verdict === 'clean') {
    const metadata = { 'Content-Type': mime };
    try {
      await options.objects.putObject('files', objectKey, bytes, bytes.length, metadata);
    } catch (error) {
      if (isDependencyOutage(error)) {
        const cause = { cause: error };
        throw new FileUnavailable('object_store', cause);
      }
      throw error;
    }
    type = 'file.uploaded';
    eventData = { ...data, mime, objectKey };
  } else {
    type = 'file.rejected';
    eventData = { ...data, reason: 'infected' };
  }
  await fresh?.();
  const result = await fileCommand(
    options.store, options.silo, memberId, `file-upload-${fileId}`, type, eventData, fresh,
  );
  if (result.status === 'unavailable') {
    throw new FileUnavailable('event_store', { cause: result.cause });
  }
  if (result.status === 'rejected') {
    throw new Error('File event rejected');
  }
  if (result.status === 'appended' && verdict === 'infected') {
    return infectedUpload(fileId);
  }
  return { ...result, fileId };
}
