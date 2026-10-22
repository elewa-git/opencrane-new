import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import type { EventStore } from '@opencrane/event-store';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import {
  connectMemberFeed,
  conversations,
  files,
  members,
  pgDb,
  ProjectionRunner,
} from '@opencrane/projections';
import { Client } from 'minio/dist/esm/minio.mjs';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { fileCommand } from '../src/files/commands.ts';
import { FileRefusal, FileUnavailable } from '../src/files/refusals.ts';
import { uploadFile, type FileOptions } from '../src/files/routes.ts';
import { scanFile } from '../src/files/scanner.ts';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = { ...testAuthConfig(), expectedOrgId: 'org' };
const bytes = Buffer.from('Meeting at ten.');
let options: FileOptions;
let app: ReturnType<typeof buildServer>;
const cleanup: (() => Promise<unknown>)[] = [];
let scannerPort: number;
let runner: ProjectionRunner;

function respondWithInvalidVerdict(socket: Socket) {
  // Exceed the scanner's local response bound without a verdict terminator.
  socket.resume();
  socket.end('x'.repeat(4097));
}

async function cleanScan() {
  await Promise.resolve();
  return 'clean' as const;
}

async function seedUploadHistory(
  store: EventStore,
  auth: ReturnType<typeof memberAuthorisation>,
  db: ReturnType<typeof pgDb>,
) {
  const invitedMember = {
    memberId: 'alice', invitationId: 'invite', email: 'a@example.test', role: 'member',
    invitedBy: 'owner', invitedIdentity: { issuer: config.issuerUrl, sub: 'alice' },
  };
  const joinedMember = {
    memberId: 'alice', invitationId: 'invite', email: 'a@example.test', role: 'member',
    displayName: 'Alice',
  };
  const personalAssistant = { assistantId: 'assistant', ownerId: 'alice', kind: 'personal' };
  const conversation = {
    conversationId: 'conversation', assistantId: 'assistant', createdBy: 'alice',
    mode: 'agent_session',
  };
  const events = [
    envelope('test', 'member-alice', 'member.invited', invitedMember),
    envelope('test', 'member-alice', 'member.joined', joinedMember),
    envelope('test', 'assistant-assistant', 'assistant.created', personalAssistant),
    envelope('test', 'conversation-conversation', 'conversation.created', conversation),
  ];
  let memberSequence = 0;
  for (const event of events) {
    event.principal = { id: 'alice', kind: 'human' };
    let expectedSequence = 0;
    if (event.subject === 'member-alice') {
      expectedSequence = memberSequence;
    }
    const command = { event, expectedSequence };
    const result = await store.append(command);
    if (result.status !== 'appended') {
      throw new Error('Fixture event was not appended');
    }
    if (event.subject === 'member-alice') {
      memberSequence = result.sequence;
    }
    if (event.type !== 'member.invited') {
      await auth.handler.handle(event, db);
    }
  }
}

async function startUploadFixture() {
  const scanner = createServer(respondWithInvalidVerdict);
  scanner.listen(0, '127.0.0.1');
  await once(scanner, 'listening');
  const address = scanner.address();
  if (!address || typeof address === 'string') {
    throw new Error('Scanner fixture has no port');
  }
  scannerPort = address.port;
  async function closeScanner() {
    scanner.close();
    await once(scanner, 'close');
  }
  cleanup.push(closeScanner);

  const nats = await natsFixture();
  cleanup.push(nats.close.bind(nats));
  const dbs = await databases();
  cleanup.push(dbs.close.bind(dbs));
  const fga = await openfga();
  cleanup.push(fga.close.bind(fga));
  const binding = await createStore(fga.apiUrl, 'test');
  const db = pgDb(dbs.queue);
  const auth = memberAuthorisation(binding);
  const feed = await connectMemberFeed(dbs.queue.options.connectionString!);
  cleanup.push(feed.close.bind(feed));
  const objectOptions = { endPoint: '127.0.0.1', useSSL: false };
  const objects = new Client(objectOptions);
  options = { silo: 'test', store: nats.store, db, binding, feed, objects, scan: cleanScan };

  await seedUploadHistory(nats.store, auth, db);
  const loggerOptions = { level: 'silent' as const };
  const logger = createLogger('upload-failures', loggerOptions);
  runner = new ProjectionRunner(db, nats.store, logger);
  await runner.initialise(members);
  await runner.run(members);
  const file = {
    conversationId: 'conversation', fileId: 'file', name: 'notes.txt', mime: 'text/plain',
    size: bytes.length, sha256: 'a'.repeat(64), objectKey: 'test/file', uploadedBy: 'alice',
  };
  await fileCommand(nats.store, 'test', 'alice', 'uploaded-file', 'file.uploaded', file);
  // Build the read tables used by access checks and file downloads before testing outages.
  await runner.initialise(conversations);
  await runner.run(conversations);
  await runner.initialise(files);
  await runner.run(files);
  const serverOptions = { files: options };
  app = buildServer(config, serverOptions);
  cleanup.push(app.close.bind(app));
}
beforeAll(startUploadFixture, 30_000);

function restoreUploadDependencies() {
  vi.restoreAllMocks();
  options.scan = cleanScan;
}
afterEach(restoreUploadDependencies);

async function closeUploadFixture() {
  for (const close of cleanup.reverse()) {
    await close();
  }
}
afterAll(closeUploadFixture);

function uploadRequest(key: string, payload = bytes) {
  const now = Math.floor(Date.now() / 1000);
  const session = {
    sub: 'alice', orgId: 'org', roles: [], authTime: now, exp: now + 300,
  };
  const cookie = encodeSession(config, session);
  const headers = {
    origin: new URL(config.redirectUri).origin,
    'content-type': 'application/octet-stream',
    'x-file-name': 'notes.txt',
    'idempotency-key': key,
    cookie: `${config.cookieName}=${cookie}`,
  };
  return {
    method: 'POST' as const,
    url: '/api/conversations/conversation/files',
    headers,
    payload,
  };
}

function viewRequest() {
  const upload = uploadRequest('view');
  return {
    url: `${upload.url}/view?path=uploads/conversation/file/notes.txt`,
    headers: upload.headers,
  };
}

function failObjectStore(boundary: string, failure: Error) {
  if (boundary === 'upload') {
    const putObject = vi.spyOn(options.objects, 'putObject');
    putObject.mockRejectedValue(failure);
    return putObject;
  }
  const getObject = vi.spyOn(options.objects, 'getObject');
  getObject.mockRejectedValue(failure);
  return getObject;
}

async function unexpectedStoreFailure(boundary: string) {
  const failure = new TypeError('Private object-store diagnostic');
  const dependency = failObjectStore(boundary, failure);
  let request;
  if (boundary === 'view') {
    request = viewRequest();
  } else {
    request = uploadRequest('object-type-error');
  }
  const response = await app.inject(request);
  expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({ status: 'failed', error: 'Unexpected failure' });
  expect(dependency).toHaveBeenCalledOnce();
}
it.each(['upload', 'view'])(
  'returns a sanitised 500 for an unexpected object-store TypeError during %s',
  unexpectedStoreFailure,
);

async function confirmedStoreOutage(code: string) {
  const failure = Object.assign(new Error('Private storage diagnostic'), { code });
  const putObject = vi.spyOn(options.objects, 'putObject');
  putObject.mockRejectedValue(failure);
  const upload = uploadFile(options, 'alice', 'conversation', code, 'notes.txt', bytes);
  await expect(upload).rejects.toBeInstanceOf(FileUnavailable);
  await expect(upload).rejects.toMatchObject({ kind: 'object_store', statusCode: 503 });
  const request = uploadRequest(code);
  const response = await app.inject(request);
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable', error: 'Dependency unavailable' });
  expect(putObject).toHaveBeenCalledTimes(2);
  const getObject = vi.spyOn(options.objects, 'getObject');
  getObject.mockRejectedValue(failure);
  const view = viewRequest();
  const download = await app.inject(view);
  expect(download.statusCode).toBe(503);
  expect(download.json()).toEqual({ status: 'unavailable', error: 'Dependency unavailable' });
  expect(getObject).toHaveBeenCalledOnce();
}
it.each(['ECONNREFUSED', 'ETIMEDOUT', 'ServiceUnavailable'])(
  'marks a confirmed object-store %s outage with typed 503',
  confirmedStoreOutage,
);

async function invalidScannerResponse() {
  function invalidScan(content: Buffer) {
    return scanFile('127.0.0.1', scannerPort, content);
  }
  const scanner = vi.fn(invalidScan);
  options.scan = scanner;
  const request = uploadRequest('invalid-scanner-response');
  const response = await app.inject(request);
  expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({ status: 'failed', error: 'Unexpected failure' });
  expect(scanner).toHaveBeenCalledOnce();
}
it(
  'returns a sanitised 500 for a locally detected invalid scanner response',
  invalidScannerResponse,
);

async function refusedScannerConnection() {
  const unusedPort = createServer();
  unusedPort.listen(0, '127.0.0.1');
  await once(unusedPort, 'listening');
  const address = unusedPort.address();
  if (!address || typeof address === 'string') {
    throw new Error('Scanner outage fixture has no port');
  }
  unusedPort.close();
  await once(unusedPort, 'close');
  const port = address.port;
  function unavailableScan(content: Buffer) {
    return scanFile('127.0.0.1', port, content);
  }
  const scanner = vi.fn(unavailableScan);
  options.scan = scanner;
  const scan = unavailableScan(bytes);
  await expect(scan).rejects.toBeInstanceOf(FileUnavailable);
  await expect(scan).rejects.toMatchObject({ kind: 'scanner', statusCode: 503 });
  const request = uploadRequest('scanner-outage');
  const response = await app.inject(request);
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable', error: 'Dependency unavailable' });
  expect(scanner).toHaveBeenCalledOnce();
}
it('marks a refused scanner connection with typed 503', refusedScannerConnection);

async function emptyUpload() {
  const empty = Buffer.alloc(0);
  const upload = uploadFile(options, 'alice', 'conversation', 'empty', 'notes.txt', empty);
  await expect(upload).rejects.toBeInstanceOf(FileRefusal);
  await expect(upload).rejects.toMatchObject({ kind: 'invalid_request', statusCode: 400 });
  const request = uploadRequest('empty', empty);
  const response = await app.inject(request);
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ status: 'refused', error: 'Invalid request' });
}
it('refuses an empty upload with typed 400 at the upload and HTTP boundaries', emptyUpload);

async function refusesFilesAfterRemovalAndInvitation() {
  const store = options.store;
  const removal = { memberId: 'alice', removedBy: 'owner' };
  const invitation = {
    memberId: 'alice', invitationId: 'later-invite', email: 'a@example.test',
    role: 'member', invitedBy: 'owner',
  };
  const removed = envelope('test', 'member-alice', 'member.removed', removal);
  const invited = envelope('test', 'member-alice', 'member.invited', invitation);
  // Leave SQL and OpenFGA unchanged to prove that stored removal stops access.
  for (const event of [removed, invited]) {
    const expectedSequence = await store.head(event.subject);
    const command = { event, expectedSequence };
    const result = await store.append(command);
    expect(result.status).toBe('appended');
  }
  const upload = uploadRequest('after-removal');
  const list = { url: upload.url, headers: upload.headers };
  const download = viewRequest();
  const refusedResponse = { status: 'refused', error: 'Conversation refused' };
  for (const request of [list, download, upload]) {
    const response = await app.inject(request);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual(refusedResponse);
  }
  const before = await store.head('conversation-conversation');
  const file = {
    conversationId: 'conversation', fileId: 'after-removal', name: 'notes.txt',
    mime: 'text/plain', size: bytes.length, sha256: 'a'.repeat(64),
    objectKey: 'test/after-removal', uploadedBy: 'alice',
  };
  const command = fileCommand(store, 'test', 'alice', 'after-removal', 'file.uploaded', file);
  const refusedCommand = { kind: 'conversation_refused', statusCode: 403 };
  await expect(command).rejects.toMatchObject(refusedCommand);
  expect(await store.head('conversation-conversation')).toBe(before);
}
it('refuses file reads, uploads and commands after removal followed by an invitation',
  refusesFilesAfterRemovalAndInvitation);

async function listsUploadAfterProjectionCatchesUp() {
  const created = envelope('test', 'conversation-lagged', 'conversation.created', {
    conversationId: 'lagged', assistantId: 'assistant', createdBy: 'alice',
    mode: 'agent_session',
  });
  const command = { event: created, expectedSequence: 0 };
  expect((await options.store.append(command)).status).toBe('appended');
  await memberAuthorisation(options.binding).handler.handle(created, options.db);
  await runner.run(conversations);
  await runner.run(files);
  const putObject = vi.spyOn(options.objects, 'putObject');
  putObject.mockResolvedValue({ etag: 'fixture', versionId: null });
  const request = { ...uploadRequest('projection-lag'),
    url: '/api/conversations/lagged/files' };
  const listRequest = { url: request.url, headers: request.headers };
  const empty = await app.inject(listRequest);
  expect(empty.statusCode).toBe(200);
  expect(empty.json()).toEqual({ rows: [] });
  const upload = await app.inject(request);
  expect(upload.statusCode).toBe(201);
  const saved = upload.json<{ sequence: number; fileId: string }>();
  const checkpoint = await runner.checkpoint(files);
  expect(checkpoint).toBeLessThan(saved.sequence);
  const stored = await options.store.readEvent(saved.sequence);
  expect(stored.event.type).toBe('file.uploaded');

  const applying = await app.inject(listRequest);
  expect(applying.statusCode, applying.body).toBe(425);
  expect(applying.json()).toEqual({ status: 'applying' });
  expect(applying.headers['cache-control']).toBe('no-store');

  await runner.run(files);
  const available = await app.inject(listRequest);
  expect(available.statusCode).toBe(200);
  expect(available.json()).toMatchObject({ rows: [{ fileId: saved.fileId }] });
}
it('reports an upload still applying instead of returning an incomplete list',
  listsUploadAfterProjectionCatchesUp);
