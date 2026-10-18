import { createServer, request } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { extname, join, resolve } from 'node:path';

const webRoot = '/app/apps/web/dist/web/browser';
const proxyPaths = ['/api', '/auth', '/ws', '/members'];
const mime = {
  '.css': 'text/css', '.html': 'text/html', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function isProxyPath(path) {
  for (const prefix of proxyPaths) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function sendError(response, code) {
  response.writeHead(code);
  response.end();
}

function proxyRequest(incoming, response) {
  function onUpstreamResponse(upstreamResponse) {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  }
  function onUpstreamError() {
    if (response.headersSent) response.destroy();
    else sendError(response, 502);
  }
  const upstream = request({ hostname: 'server', port: 8080, method: incoming.method,
    path: incoming.url, headers: incoming.headers }, onUpstreamResponse);
  upstream.on('error', onUpstreamError);
  incoming.pipe(upstream);
}

async function serveFile(response, path) {
  try {
    const content = await readFile(path);
    response.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream' });
    response.end(content);
  } catch {
    sendError(response, 404);
  }
}

async function handleRequest(incoming, response) {
  let url;
  try {
    url = new URL(incoming.url ?? '/', 'http://localhost');
  } catch {
    sendError(response, 400);
    return;
  }
  if (isProxyPath(url.pathname)) {
    proxyRequest(incoming, response);
    return;
  }
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    sendError(response, 400);
    return;
  }
  const path = resolve(webRoot, `.${decodedPath}`);
  if (!path.startsWith(`${webRoot}/`) && path !== webRoot) {
    sendError(response, 404);
    return;
  }
  try {
    if ((await stat(path)).isFile()) {
      await serveFile(response, path);
      return;
    }
  } catch {
    // Let the browser app handle its own routes.
  }
  await serveFile(response, join(webRoot, 'index.html'));
}

function handleUpgrade(incoming, socket, head) {
  let url;
  try {
    url = new URL(incoming.url ?? '/', 'http://localhost');
  } catch {
    socket.destroy();
    return;
  }
  if (!isProxyPath(url.pathname)) {
    socket.destroy();
    return;
  }
  const upstream = connect(8080, 'server');
  function onConnect() {
    const headers = [];
    for (const [name, value] of Object.entries(incoming.headers)) {
      headers.push(`${name}: ${value}`);
    }
    upstream.write(`${incoming.method} ${incoming.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  }
  function onError() {
    socket.destroy();
  }
  upstream.on('connect', onConnect);
  upstream.on('error', onError);
}

const server = createServer(handleRequest);
server.on('upgrade', handleUpgrade);
server.listen(8080, '0.0.0.0');
