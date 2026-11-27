import { createServer, request } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { organisationPage } from './web-page.mjs';
import { pathToFileURL } from 'node:url';
import { createLogger } from '@opencrane/observability';

const logger = createLogger('web-proxy');

const webRoot = '/app/apps/web/dist/web/browser';
const indexPath = join(webRoot, 'index.html');
const proxyPaths = ['/api', '/auth', '/ws', '/members'];
const connectionHeaders = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
];
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

function forwardedHeaders(headers) {
  const forwarded = { ...headers };
  const connectionOptions = headers.connection?.split(',') ?? [];
  for (const option of connectionOptions) delete forwarded[option.trim().toLowerCase()];
  for (const name of connectionHeaders) delete forwarded[name];
  return forwarded;
}

function proxyRequest(incoming, response) {
  function onUpstreamResponse(upstreamResponse) {
    // Let each connection advertise its own keep-alive timeout and frame its own body.
    const headers = forwardedHeaders(upstreamResponse.headers);
    response.writeHead(upstreamResponse.statusCode ?? 502, headers);
    upstreamResponse.pipe(response);
  }
  function onUpstreamError(error) {
    // Log the system code so the warning leaves out request data.
    const code = error.code ?? 'unknown_error';
    logger.warn({ code }, 'HTTP proxy request failed');
    if (response.headersSent) response.destroy();
    else sendError(response, 502);
  }
  const headers = forwardedHeaders(incoming.headers);
  // Open a fresh connection so an idle close cannot race the next save.
  const options = {
    hostname: 'server',
    port: 8080,
    method: incoming.method,
    path: incoming.url,
    headers,
    agent: false,
  };
  const upstream = request(options, onUpstreamResponse);
  upstream.on('error', onUpstreamError);
  incoming.pipe(upstream);
}

async function serveFile(response, path) {
  try {
    let content = await readFile(path);
    if (path === indexPath) {
      const page = organisationPage(content.toString('utf8'), process.env['ORGANISATION_NAME']);
      content = Buffer.from(page);
    }
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
  await serveFile(response, indexPath);
}

export function forwardUpgrade(incoming, socket, head, target) {
  const requestOptions = { method: incoming.method, headers: incoming.headers };
  const upstream = request(target, requestOptions);
  let upstreamSocket;

  function close() {
    upstream.destroy();
    upstreamSocket?.destroy();
    socket.destroy();
  }

  function failed(error) {
    const details = { err: error };
    logger.warn(details, 'WebSocket proxy connection failed');
    close();
  }

  function connected(response, remote, remoteHead) {
    upstreamSocket = remote;
    // Handle disconnects before writing headers or starting either direction of the stream.
    remote.on('error', failed);
    remote.on('close', close);
    const status = `HTTP/${response.httpVersion} ${response.statusCode} `
      + `${response.statusMessage}\r\n`;
    socket.write(status);
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) {
        socket.write(`${name}: ${value}\r\n`);
      }
    }
    socket.write('\r\n');
    if (remoteHead.length) {
      socket.write(remoteHead);
    }
    if (head.length) {
      remote.write(head);
    }
    remote.pipe(socket);
    socket.pipe(remote);
  }

  socket.on('error', failed);
  socket.on('close', close);
  upstream.on('upgrade', connected);
  upstream.on('response', close);
  upstream.on('error', failed);
  upstream.end();
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
  const target = new URL('http://server:8080');
  target.pathname = url.pathname;
  target.search = url.search;
  forwardUpgrade(incoming, socket, head, target);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  const server = createServer(handleRequest);
  server.on('upgrade', handleUpgrade);
  server.listen(8080, '0.0.0.0');
}
