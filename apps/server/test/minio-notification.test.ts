import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Client } from 'minio/dist/esm/minio.mjs';
import { expect, it } from 'vitest';

async function receivesNotification() {
  const record = { eventName: 's3:ObjectCreated:Put', s3: { object: { key: 'notes.txt' } } };
  let response: ServerResponse | undefined;
  function sendNotification(_request: IncomingMessage, reply: ServerResponse) {
    response = reply;
    const headers = { 'content-type': 'application/json' };
    reply.writeHead(200, headers);
    const line = JSON.stringify({ Records: [record] });
    const middle = Math.floor(line.length / 2);
    reply.write(line.slice(0, middle));
    reply.write(`${line.slice(middle)}\n`);
  }
  const server = createServer(sendNotification);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing notification fixture port');
  }
  const options = {
    endPoint: '127.0.0.1', port: address.port, useSSL: false, region: 'us-east-1',
  };
  const client = new Client(options);
  const events = ['s3:ObjectCreated:*'];
  const listener = client.listenBucketNotification('test-bucket', '', '', events);
  function waitForNotification(
    resolve: (record: unknown) => void,
    reject: (error: unknown) => void,
  ) {
    listener.once('notification', resolve);
    listener.once('error', reject);
  }
  try {
    const notification = await new Promise<unknown>(waitForNotification);
    expect(notification).toEqual(record);
  } finally {
    listener.stop();
    response?.destroy();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}

it('parses streamed Minio notifications with the fixed stream-json release', receivesNotification);
