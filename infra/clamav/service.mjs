import { createServer } from 'node:https';
import { tokenVerifier } from '@opencrane/auth';

const refusal = 'Scanner request refused';
const maximumBytes = 20 * 1024 * 1024;
const maximumRequests = 2;
const maximumConnections = 8;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowedHeaders = new Set(['host', 'connection', 'authorization', 'expect',
  'content-type', 'content-length', 'x-scan-silo', 'x-scan-purpose',
  'x-scan-request-id', 'x-scan-file-id', 'x-scan-sha256']);

function requireRequest(condition) {
  if (!condition) {
    throw new Error(refusal);
  }
}

function metadata(request) {
  const headers = request.headers;
  requireRequest(request.method === 'POST' && request.url === '/scan/upload');
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index].toLowerCase();
    requireRequest(allowedHeaders.has(name));
  }
  requireRequest(request.rawHeaders.length === Object.keys(headers).length * 2);
  requireRequest(headers.expect === '100-continue' &&
    headers['content-type'] === 'application/octet-stream');
  const byteCount = Number(headers['content-length']);
  requireRequest(/^(0|[1-9][0-9]*)$/.test(headers['content-length']) &&
    Number.isSafeInteger(byteCount) && byteCount <= maximumBytes);
  const input = { purpose: headers['x-scan-purpose'], silo: headers['x-scan-silo'],
    requestId: headers['x-scan-request-id'], fileId: headers['x-scan-file-id'],
    sha256: headers['x-scan-sha256'], byteCount };
  const validFileId = uuid.test(input.fileId) || /^[a-f0-9]{64}$/.test(input.fileId);
  requireRequest(input.purpose === 'upload' && /^[\w-]{1,200}$/.test(input.silo) &&
    uuid.test(input.requestId) && validFileId && /^[a-f0-9]{64}$/.test(input.sha256));
  requireRequest(typeof headers.authorization === 'string' &&
    headers.authorization.startsWith('Bearer '));
  return input;
}

function reply(response, status, value) {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  const bytes = Buffer.from(JSON.stringify(value));
  requireRequest(bytes.length <= 4096);
  const headers = { 'content-type': 'application/json', 'content-length': bytes.length,
    connection: 'close', 'cache-control': 'no-store' };
  response.writeHead(status, headers);
  response.end(bytes);
}
function refuse(_request, response) {
  const result = { error: refusal };
  reply(response, 503, result);
}

function receive(request, expected, signal) {
  function collect(resolve, reject) {
    const chunks = [];
    let count = 0;
    function tidy() {
      request.removeListener('data', read);
      request.removeListener('end', end);
      request.removeListener('error', fail);
      signal.removeEventListener('abort', fail);
    }
    function fail() {
      tidy();
      request.pause();
      reject(new Error(refusal));
    }
    function read(chunk) {
      count += chunk.length;
      if (count > expected) {
        fail();
        return;
      }
      chunks.push(chunk);
    }
    function end() {
      if (count !== expected || !request.complete) {
        fail();
        return;
      }
      tidy();
      resolve(Buffer.concat(chunks));
    }
    request.on('data', read);
    request.once('end', end);
    request.once('error', fail);
    signal.addEventListener('abort', fail, { once: true });
    if (signal.aborted) {
      fail();
    }
  }
  return new Promise(collect);
}

export function createScannerService({ scanner, tls, trust, clock = Date.now }) {
  // Keep public trust in deployment settings; never select keys from request data.
  function seconds() {
    return Math.floor(clock() / 1000);
  }
  function verifier(entry) {
    const publicKeys = structuredClone(entry.jwks);
    return tokenVerifier(publicKeys, entry.issuer, seconds, entry.services);
  }
  const verifiers = trust.map(verifier);
  const arrivals = new WeakMap();
  function connected(socket) {
    const timing = { started: clock(), elapsedStart: performance.now() };
    arrivals.set(socket, timing);
  }
  const { scan, signal: retired, databaseUpdatedAt } = scanner;
  const databaseExpiry = Date.parse(databaseUpdatedAt) + 86400000;
  let activeRequests = 0;

  async function authenticate(value, input) {
    const expected = { purpose: 'upload', requestId: input.requestId };
    for (const verifier of verifiers) {
      try {
        const claims = await verifier.verifyScanner(value, expected);
        requireRequest(claims.silo === input.silo);
        return claims;
      } catch {
        // Try only the other configured issuers, without exposing verification errors.
      }
    }
    throw new Error(refusal);
  }

  async function handle(request, response) {
    // Reserve capacity before verifying passes or collecting any file bytes.
    if (activeRequests >= maximumRequests) {
      refuse(request, response);
      return;
    }
    activeRequests += 1;
    const { started, elapsedStart } = arrivals.get(request.socket);
    const controller = new AbortController();
    const signal = AbortSignal.any([retired, controller.signal]);
    function cancel() {
      controller.abort();
    }
    function failed() {
      refuse(request, response);
    }
    function disconnected() {
      if (!response.writableFinished) {
        cancel();
      }
    }
    function current() {
      const now = clock();
      requireRequest(!signal.aborted && now >= started && now - started < 60000 &&
        performance.now() - elapsedStart < 60000 && now < databaseExpiry);
      return now;
    }
    const elapsed = Math.max(clock() - started, performance.now() - elapsedStart);
    const timer = setTimeout(cancel, Math.max(0, 60000 - elapsed));
    signal.addEventListener('abort', failed, { once: true });
    request.once('aborted', cancel);
    response.once('close', disconnected);
    try {
      current();
      const input = metadata(request);
      const value = request.headers.authorization.slice(7);
      await authenticate(value, input);
      current();
      const pending = receive(request, input.byteCount, signal);
      response.writeContinue();
      const bytes = await pending;
      await authenticate(value, input);
      current();
      const scanInput = { bytes, sha256: input.sha256, byteCount: input.byteCount, signal };
      const result = await scan(scanInput);
      const claims = await authenticate(value, input);
      const now = current();
      requireRequest(result.sha256 === input.sha256 && result.byteCount === input.byteCount &&
        result.databaseUpdatedAt === databaseUpdatedAt &&
        Date.parse(result.checkedAt) <= now && Date.parse(result.expiresAt) > now);
      const expires = Math.min(Date.parse(result.expiresAt), databaseExpiry, claims.exp * 1000);
      const resultForCaller = { ...result, ...input, expiresAt: new Date(expires).toISOString() };
      reply(response, 200, resultForCaller);
    } catch {
      cancel();
      failed();
    } finally {
      // Keep the reservation until cancelled scan work has finished its cleanup.
      activeRequests -= 1;
      clearTimeout(timer);
      signal.removeEventListener('abort', failed);
      request.removeListener('aborted', cancel);
      response.removeListener('close', disconnected);
    }
  }
  const options = { ...tls, minVersion: 'TLSv1.2', maxHeaderSize: 8192,
    handshakeTimeout: 60000, headersTimeout: 60000, requestTimeout: 60000,
    connectionsCheckingInterval: 1000 };
  const server = createServer(options, refuse);
  server.prependListener('secureConnection', connected);
  server.on('checkContinue', handle);
  server.on('checkExpectation', refuse);
  function clientError(_error, socket) {
    socket.destroy();
  }
  server.on('clientError', clientError);
  server.setTimeout(60000);
  server.maxRequestsPerSocket = 1;
  // Let Node refuse excess TCP connections before creating TLS or HTTP buffers.
  server.maxConnections = maximumConnections;
  return server;
}
