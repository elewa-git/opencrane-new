import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { FileUnavailable } from '../src/files/refusals.ts';
import { storageClient } from '../src/files/storage.ts';

function unavailableStorage(_request: IncomingMessage, response: ServerResponse) {
  response.writeHead(503);
  response.end('Private service diagnostic');
}

async function serviceUnavailableStatus() {
  const server = createServer(unavailableStorage);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Object-store fixture has no port');
  }
  const directory = await mkdtemp(`${tmpdir()}/storage-refusal-`);
  const leaseFile = `${directory}/lease`;
  const lease = {
    accessKey: 'disposable-test', secretKey: 'disposable-test', sessionToken: 'disposable-test',
    expiresAt: Date.now() + 60_000,
  };
  await writeFile(leaseFile, JSON.stringify(lease), { mode: 0o600 });
  const client = storageClient(`http://127.0.0.1:${address.port}`, leaseFile);
  try {
    const download = client.getObject('files', 'notes.txt');
    await expect(download).rejects.toBeInstanceOf(FileUnavailable);
    await expect(download).rejects.toMatchObject({ kind: 'object_store', statusCode: 503 });
  } finally {
    server.close();
    await once(server, 'close');
    await rm(directory, { recursive: true, force: true });
  }
}

it('marks the object service HTTP 503 before the SDK loses its status', serviceUnavailableStatus);
