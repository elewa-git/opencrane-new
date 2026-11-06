import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { createScannerService } from '../clamav/service.mjs';

const refusal = 'Development scanner unavailable';
const directory = process.env.DEV_STACK_DIR;
const port = Number(process.env.SCANNER_PORT);
const clamPort = Number(process.env.CLAMD_PORT);
const clamHost = process.env.CLAMD_HOST;
const silo = process.env.SILO_ID;
const issuer = process.env.TOKEN_ISSUER;
const stopped = new AbortController();

function frames(bytes) {
  const parts = [Buffer.from('zINSTREAM\0')];
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    const chunk = bytes.subarray(offset, offset + 65536);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(chunk.length);
    parts.push(size, chunk);
  }
  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts);
}

function scanWithClamd(bytes, signal) {
  function exchange(resolve, reject) {
    const socket = connect({ host: clamHost, port: clamPort });
    const chunks = [];
    let length = 0;
    let settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      socket.destroy();
      if (error) reject(new Error(refusal));
      else resolve(value);
    }
    function cancel() { finish(true); }
    function send() { socket.end(frames(bytes)); }
    function read(chunk) {
      length += chunk.length;
      if (length > 4096) finish(true);
      else chunks.push(chunk);
    }
    function complete() {
      const reply = Buffer.concat(chunks).toString('utf8');
      if (reply === 'stream: OK\0') finish(false, 'clean');
      else if (/^stream: [\x20-\x7e]+ FOUND\0$/u.test(reply)) finish(false, 'infected');
      else finish(true);
    }
    const timer = setTimeout(cancel, 60_000);
    socket.on('connect', send);
    socket.on('data', read);
    socket.on('end', complete);
    socket.on('error', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  }
  return new Promise(exchange);
}

function databaseFacts(name) {
  return { file: `${name}.cvd`, sha256: '0'.repeat(64), version: 1,
    builtAt: '2020-01-01T00:00:00.000Z' };
}

async function main() {
  if (!directory || !silo || !issuer || !clamHost || !Number.isInteger(port) ||
      !Number.isInteger(clamPort)) throw new Error(refusal);
  const publicKeys = await readFile(`${directory}/model-jwks.json`, 'utf8');
  const jwks = JSON.parse(publicKeys);
  const tls = { key: await readFile(`${directory}/scanner-server.key`),
    cert: await readFile(`${directory}/scanner-server.crt`) };
  const trust = [{ issuer, jwks, services: { server: silo,
    'image-worker': silo } }];
  // Use the same authenticated HTTPS service as upload tests. Only this local
  // process supplies development scan facts; production release checks stay separate.
  const databaseUpdatedAt = new Date().toISOString();
  const databases = ['main', 'daily', 'bytecode'].map(databaseFacts);
  async function scan(input) {
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length > 20 * 1024 * 1024 ||
        input.bytes.length !== input.byteCount) throw new Error(refusal);
    const bytes = Buffer.from(input.bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== input.sha256) throw new Error(refusal);
    const signal = AbortSignal.any([stopped.signal, input.signal]);
    const verdict = await scanWithClamd(bytes, signal);
    const checked = Date.now();
    const checkedAt = new Date(checked).toISOString();
    const expiresAt = new Date(checked + 120_000).toISOString();
    return { verdict, sha256, byteCount: bytes.length,
      imageDigest: `sha256:${'0'.repeat(64)}`,
      manifestDigest: `sha256:${'0'.repeat(64)}`,
      databaseUpdatedAt, databases, checkedAt, expiresAt };
  }
  const scanner = { scan, signal: stopped.signal, databaseUpdatedAt };
  const server = createScannerService({ scanner, tls, trust });
  server.once('error', reportFailure);
  server.listen(port, '0.0.0.0');
  function shutdown() {
    stopped.abort();
    server.closeAllConnections();
    server.close();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function reportFailure() {
  process.stderr.write(`${refusal}\n`);
  process.exitCode = 1;
}

main().catch(reportFailure);
