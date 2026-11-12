import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { basename, extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { organisationPage } from '../package/web-page.mjs';

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const proxyPaths = ['/api', '/auth', '/ws', '/members'];
const rendererPolicy = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; "
  + "base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

function matchesProxyPath(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function proxyTarget(pathname, configuration) {
  for (const prefix of proxyPaths) {
    if (matchesProxyPath(pathname, prefix)) return configuration[prefix]?.target;
  }
  return undefined;
}

function upstreamUrl(request, target) {
  // Keep the saved server as the destination even when a client sends an absolute URL.
  const incoming = new URL(request.url, 'http://localhost');
  const upstream = new URL(target);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  return upstream;
}

function allowedHost(request, ownerHost) {
  try {
    const host = new URL(`http://${request.headers.host}`).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === ownerHost;
  } catch {
    return false;
  }
}

function fileForPath(pathname, buildDirectory) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decodedPath.includes('\\') || decodedPath.includes('\0')) return undefined;
  // Refuse parent paths before resolving the requested file inside the build.
  const segments = decodedPath.split('/');
  if (segments.includes('..') || segments.includes('.')) return undefined;
  const filename = extname(decodedPath) ? decodedPath : '/index.html';
  const file = resolve(buildDirectory, `.${filename}`);
  if (!file.startsWith(`${buildDirectory}${sep}`)) return undefined;
  return file;
}

function cacheControl(filename) {
  if (/-[A-Z0-9]{8}\.[^.]+$/u.test(basename(filename))) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

function indexPolicy(nonce) {
  return "default-src 'self'; script-src 'self'; "
    + `style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; `
    + "connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; "
    + "frame-ancestors 'none'";
}

function compressionFor(request) {
  const accepted = request.headers['accept-encoding'] ?? '';
  if (/\bgzip\b/u.test(accepted)) return { name: 'gzip', stream: createGzip() };
  return undefined;
}

async function serveFile(request, response, pathname, buildDirectory) {
  const filename = fileForPath(pathname, buildDirectory);
  if (!filename) {
    response.writeHead(400).end();
    return;
  }
  let details;
  try {
    details = await stat(filename);
  } catch {
    response.writeHead(404).end();
    return;
  }
  if (!details.isFile()) {
    response.writeHead(404).end();
    return;
  }
  const isIndex = basename(filename) === 'index.html';
  const etag = `W/"${details.size}-${Math.trunc(details.mtimeMs)}"`;
  const headers = {
    'cache-control': cacheControl(filename),
    'content-type': contentTypes[extname(filename)] ?? 'application/octet-stream',
    'etag': etag,
    'referrer-policy': 'same-origin',
    vary: 'Accept-Encoding',
    'x-content-type-options': 'nosniff',
  };
  let nonce;
  if (isIndex) {
    // Give each page its own nonce so Angular can add styles under the page policy.
    nonce = randomBytes(18).toString('base64');
    headers['content-security-policy'] = indexPolicy(nonce);
  } else if (basename(filename) === 'mermaid-renderer.html') {
    headers['content-security-policy'] = rendererPolicy;
  }
  if (!isIndex && request.headers['if-none-match'] === etag) {
    response.writeHead(304, headers).end();
    return;
  }
  if (request.method === 'HEAD') {
    response.writeHead(200, headers).end();
    return;
  }
  let source;
  if (isIndex) {
    const index = await readFile(filename, 'utf8');
    const page = organisationPage(index, process.env['ORGANISATION_NAME']);
    const body = page.replace('<app-root', `<app-root ngCspNonce="${nonce}"`);
    source = Readable.from([body]);
  } else {
    source = createReadStream(filename);
  }
  const compression = compressionFor(request);
  if (compression) {
    headers['content-encoding'] = compression.name;
    response.writeHead(200, headers);
    source.pipe(compression.stream).pipe(response);
  } else {
    response.writeHead(200, headers);
    source.pipe(response);
  }
  function sourceFailed() {
    response.destroy();
  }
  source.on('error', sourceFailed);
}

function forwardRequest(request, response, target) {
  const upstream = httpRequest(upstreamUrl(request, target), {
    method: request.method,
    headers: request.headers,
  });
  function receive(upstreamResponse) {
    response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  }
  function fail() {
    if (!response.headersSent) response.writeHead(502).end();
    else response.destroy();
  }
  upstream.on('response', receive);
  upstream.on('error', fail);
  request.pipe(upstream);
}

function forwardUpgrade(request, socket, head, target) {
  const upstream = httpRequest(upstreamUrl(request, target), {
    method: request.method,
    headers: request.headers,
  });
  function connected(upstreamResponse, upstreamSocket, upstreamHead) {
    const status = `HTTP/${upstreamResponse.httpVersion} ${upstreamResponse.statusCode} `
      + `${upstreamResponse.statusMessage}\r\n`;
    socket.write(status);
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (value !== undefined) socket.write(`${name}: ${value}\r\n`);
    }
    socket.write('\r\n');
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    function closeClient() {
      socket.destroy();
    }
    function closeUpstream() {
      upstreamSocket.destroy();
    }
    upstreamSocket.on('error', closeClient);
    upstreamSocket.on('close', closeClient);
    socket.on('error', closeUpstream);
    socket.on('close', closeUpstream);
  }
  function fail() {
    upstream.destroy();
    socket.destroy();
  }
  upstream.on('upgrade', connected);
  upstream.on('response', fail);
  upstream.on('error', fail);
  upstream.end();
}

export async function startWebServer(buildDirectory, port, ownerHost, proxyFile) {
  const configuration = JSON.parse(await readFile(proxyFile, 'utf8'));
  const directory = resolve(buildDirectory);
  function handleRequest(request, response) {
    if (!allowedHost(request, ownerHost)) {
      response.writeHead(403).end();
      return;
    }
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const target = proxyTarget(pathname, configuration);
    if (target) {
      forwardRequest(request, response, target);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    void serveFile(request, response, pathname, directory).catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy();
    });
  }
  const server = createServer(handleRequest);
  function handleUpgrade(request, socket, head) {
    if (!allowedHost(request, ownerHost)) {
      socket.destroy();
      return;
    }
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const target = proxyTarget(pathname, configuration);
    if (!target || !configuration['/ws']?.ws || !matchesProxyPath(pathname, '/ws')) {
      socket.destroy();
      return;
    }
    forwardUpgrade(request, socket, head, target);
  }
  server.on('upgrade', handleUpgrade);
  await new Promise((resolveListen) => server.listen(port, '127.0.0.1', resolveListen));
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [buildDirectory, port, ownerHost, proxyFile] = process.argv.slice(2);
  await startWebServer(buildDirectory, Number(port), ownerHost, proxyFile);
}
