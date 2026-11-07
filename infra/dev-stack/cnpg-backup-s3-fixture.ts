import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

function hash(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}
function hmac(key: string | Buffer, value: string) {
  return createHmac('sha256', key).update(value).digest();
}
function authenticated(request: IncomingMessage) {
  const authorization = request.headers.authorization ?? '';
  const match = /^AWS4-HMAC-SHA256 Credential=fixture-access\/([^,]+), SignedHeaders=([^,]+), Signature=(.+)$/u.exec(authorization);
  if (!match) {
    return false;
  }
  const [scope, signed, signature] = match.slice(1) as [string, string, string];
  const names = signed.split(';');
  let headers = '';
  for (const name of names) {
    headers += `${name}:${request.headers[name]}\n`;
  }
  const canonical = [request.method, request.url, '', headers, signed,
    request.headers['x-amz-content-sha256']].join('\n');
  const message = ['AWS4-HMAC-SHA256', request.headers['x-amz-date'], scope,
    hash(canonical)].join('\n');
  let key = Buffer.from('AWS4private-value-/private/path');
  for (const part of scope.split('/')) {
    key = hmac(key, part);
  }
  return hmac(key, message).toString('hex') === signature;
}

export function storageFixture() {
  const objects = new Map<string, Buffer>();
  const requests: string[] = [];
  const state = { fault: '', onRequest: (_method: string) => {} };
  function etag(bytes: Buffer) {
    return `"${createHash('md5').update(bytes).digest('hex')}"`;
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const method = request.method!;
    const path = request.url!;
    requests.push(method);
    state.onRequest(method);
    const allowed = /^\/database-backups\/local-check\/[^/]{1,100}$/u.test(path);
    if (!allowed || !authenticated(request) || state.fault === `deny ${method}`) {
      response.writeHead(403);
      response.end('<Error><Message>private-value-/private/path</Message></Error>');
      return;
    }
    if (state.fault === `stall ${method}`) {
      return;
    }
    if (method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      assert(bytes.length > 0 && bytes.length <= 128);
      assert.equal(request.headers['if-none-match'], '*');
      if (state.fault === 'collision') {
        objects.set(path, Buffer.from('foreign'));
      }
      if (objects.has(path)) {
        response.writeHead(412);
      } else {
        objects.set(path, bytes);
        response.setHeader('etag', etag(bytes));
      }
      response.end();
      return;
    }
    if (state.fault === 'missing') {
      objects.delete(path);
    }
    if (state.fault === 'changed' || (state.fault === 'changed before delete' && method === 'DELETE')) {
      objects.set(path, Buffer.from('foreign'));
    }
    const bytes = objects.get(path);
    if (!bytes || request.headers['if-match'] !== etag(bytes)) {
      response.writeHead(412);
      response.end();
      return;
    }
    if (method === 'GET') {
      response.setHeader('etag', etag(bytes));
      response.end(bytes);
      return;
    }
    assert.equal(method, 'DELETE');
    objects.delete(path);
    response.writeHead(204);
    response.end();
  }
  function serve(request: IncomingMessage, response: ServerResponse) {
    function failed(error: unknown) {
      response.destroy(error as Error);
    }
    void handle(request, response).catch(failed);
  }
  return { serve, state, objects, requests };
}
