import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

function hash(value: string | Buffer) {
  const hash = createHash('sha256');
  hash.update(value);
  return hash.digest('hex');
}
function hmac(key: string | Buffer, value: string) {
  const hash = createHmac('sha256', key);
  hash.update(value);
  return hash.digest();
}
function authenticated(request: IncomingMessage) {
  const authorization = request.headers.authorization ?? '';
  const pattern = /^AWS4-HMAC-SHA256 Credential=fixture-access\/([^,]+), SignedHeaders=([^,]+), Signature=(.+)$/u;
  const match = pattern.exec(authorization);
  if (!match) {
    return false;
  }
  const [scope, signed, signature] = match.slice(1) as [string, string, string];
  const names = signed.split(';');
  let headers = '';
  for (const name of names) {
    headers += `${name}:${request.headers[name]}\n`;
  }
  const url = new URL(request.url!, 'https://fixture.invalid');
  const canonical = [request.method, url.pathname, url.search.slice(1), headers, signed,
    request.headers['x-amz-content-sha256']].join('\n');
  const message = ['AWS4-HMAC-SHA256', request.headers['x-amz-date'], scope,
    hash(canonical)].join('\n');
  let key = Buffer.from('AWS4private-value-/private/path');
  for (const part of scope.split('/')) {
    key = hmac(key, part);
  }
  const calculated = hmac(key, message);
  return calculated.toString('hex') === signature;
}

export function storageFixture() {
  const objects = new Map<string, Buffer>();
  const requests: string[] = [];
  function onRequest(_method: string) {}
  const state = { fault: '', onRequest };
  function etag(bytes: Buffer) {
    const hash = createHash('md5');
    hash.update(bytes);
    return `"${hash.digest('hex')}"`;
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const method = request.method!;
    const url = new URL(request.url!, 'https://fixture.invalid');
    const path = url.pathname;
    requests.push(method);
    state.onRequest(method);
    const allowed = /^\/database-backups\/local-check\/[^/]{1,100}$/u.test(path);
    const denied = state.fault === `deny ${method}` || state.fault === 'server error';
    if (!allowed || !authenticated(request) || denied) {
      response.writeHead(state.fault === 'server error' ? 500 : 403);
      response.end('<Error><Message>private-value-/private/path</Message></Error>');
      return;
    }
    if (state.fault === `body stall ${method}`) {
      response.writeHead(200);
      response.write('x');
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
        if (state.fault === 'versioned' || state.fault === 'lost versioned PUT') {
          response.setHeader('x-amz-version-id', 'fixture+/=version');
        }
      }
      if (state.fault === 'lost PUT' || state.fault === 'lost versioned PUT') {
        response.destroy();
        return;
      }
      response.end();
      return;
    }
    if (method === 'HEAD') {
      const stored = objects.get(path);
      if (!stored) {
        response.writeHead(404);
      } else {
        response.setHeader('etag', etag(stored));
        if (state.fault === 'lost versioned PUT') {
          response.setHeader('x-amz-version-id', 'fixture+/=version');
        }
      }
      response.end();
      return;
    }
    if (method === 'DELETE' && !objects.has(path)) {
      response.writeHead(204);
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
      if (state.fault === 'versioned' || state.fault === 'lost versioned PUT') {
        response.setHeader('x-amz-version-id', 'fixture+/=version');
      }
      if (state.fault === 'bad body') {
        response.end('private-value-/private/path');
      } else if (state.fault === 'large body') {
        response.end('x'.repeat(4096));
      } else {
        response.end(bytes);
      }
      return;
    }
    assert.equal(method, 'DELETE');
    const versioned = state.fault === 'versioned' || state.fault === 'lost versioned PUT';
    if (!versioned || url.search === '?versionId=fixture%2B%2F%3Dversion') {
      objects.delete(path);
    }
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
