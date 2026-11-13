import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { storageClient } from '../apps/server/src/files/storage.ts';

const checked = Date.parse('2026-11-13T00:00:00Z');
let directory;
let leaseFile;
let server;
let endpoint;
let acceptedKey;
let requests;

function receiveRequest(request, response) {
  requests += 1;
  request.resume();
  const authorised = request.headers.authorization?.includes(`Credential=${acceptedKey}/`);
  if (!authorised) {
    response.writeHead(403, { 'content-type': 'application/xml' });
    response.end('<Error><Code>InvalidAccessKeyId</Code><Message>Retired lease</Message></Error>');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/xml' });
  if (request.url.includes('location')) {
    response.end('<LocationConstraint>us-east-1</LocationConstraint>');
  } else {
    response.end();
  }
}

function lease(accessKey, expiresAt = checked + 60000) {
  return { accessKey, secretKey: 'disposable-secret', sessionToken: 'disposable-session', expiresAt };
}

async function prepare() {
  vi.spyOn(Date, 'now').mockReturnValue(checked);
  directory = await mkdtemp(join(tmpdir(), 'storage-lease-'));
  leaseFile = join(directory, 'lease.json');
  acceptedKey = 'first-disposable';
  requests = 0;
  server = createServer(receiveRequest);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  endpoint = `http://127.0.0.1:${server.address().port}`;
}

async function cleanup() {
  server.closeAllConnections();
  server.close();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
}
beforeEach(prepare);
afterEach(cleanup);

async function rereadsRetiredLease() {
  const previous = lease(acceptedKey);
  await writeFile(leaseFile, JSON.stringify(previous));
  const client = storageClient(endpoint, leaseFile);
  await client.putObject('files', 'first.txt', Buffer.from('first'));
  acceptedKey = 'second-disposable';
  const oldFile = join(directory, 'old.json');
  await writeFile(oldFile, JSON.stringify(previous));
  const retired = storageClient(endpoint, oldFile);
  await expect(retired.putObject('files', 'retired.txt', Buffer.from('retired')))
    .rejects.toThrow();
  await writeFile(leaseFile, JSON.stringify(lease(acceptedKey)));
  await client.putObject('files', 'rotated.txt', Buffer.from('rotated'));
}
test('rereads credentials for each request after the service refuses the previous lease',
  rereadsRetiredLease);

async function refusesInvalidLifetime(expiresAt) {
  await writeFile(leaseFile, JSON.stringify(lease(acceptedKey, expiresAt)));
  const client = storageClient(endpoint, leaseFile);
  await expect(client.putObject('files', 'refused.txt', Buffer.from('refused')))
    .rejects.toThrow('Storage lease expired or overlong');
  expect(requests).toBe(0);
}
test.each([checked, checked - 1, checked + 900001])(
  'refuses lease expiry or excessive remaining lifetime %s before HTTP', refusesInvalidLifetime);
