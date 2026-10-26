import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tokenIssuer } from '@opencrane/auth';
import { z } from 'zod';
import { FileUnavailable } from './refusals.ts';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const date = z.iso.datetime();
const database = z.strictObject({
  file: z.string().regex(/^(main|daily|bytecode)\.(cvd|cld)$/u),
  sha256, version: z.int().positive(), builtAt: date,
});
const resultSchema = z.strictObject({
  purpose: z.literal('upload'), silo: z.string(), requestId: z.uuid(), fileId: z.string(),
  sha256, byteCount: z.int().nonnegative(), verdict: z.enum(['clean', 'infected']),
  imageDigest: digest, manifestDigest: digest, databases: z.array(database).length(3),
  databaseUpdatedAt: date, checkedAt: date, expiresAt: date,
});
interface ScannerSettings {
  url: string | undefined;
  caFile: string | undefined;
  privateKeyPath: string | undefined;
  issuer: string | undefined;
  silo: string;
}
interface UploadBinding { silo: string; fileId: string }

function hash(bytes: Buffer) {
  const digest = createHash('sha256');
  digest.update(bytes);
  return digest.digest('hex');
}
function requireScan(condition: unknown): asserts condition {
  if (!condition) {
    throw new FileUnavailable('scanner');
  }
}

export async function scanFile(settings: ScannerSettings, bytes: Buffer, binding: UploadBinding) {
  const controller = new AbortController();
  function expire() {
    controller.abort();
  }
  const timer = setTimeout(expire, 60000);
  const started = Date.now();
  const elapsedStart = performance.now();
  const input = { ...binding, purpose: 'upload' as const, requestId: randomUUID(),
    sha256: hash(bytes), byteCount: bytes.length };
  async function prepare() {
    requireScan(settings.url && settings.caFile && settings.privateKeyPath && settings.issuer);
    requireScan(binding.silo === settings.silo && bytes.length <= 20 * 1024 * 1024);
    const url = new URL(settings.url);
    requireScan(url.protocol === 'https:' && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname === '/scan/upload');
    const ca = await readFile(settings.caFile);
    requireScan(ca.length > 0);
    const scannerIdentity = { service: 'server' as const, silo: settings.silo };
    const tokenOptions = { privateKeyPath: settings.privateKeyPath,
      issuer: settings.issuer, scannerIdentity };
    const issuer = await tokenIssuer(tokenOptions);
    const passRequest = { purpose: input.purpose, requestId: input.requestId };
    const issued = await issuer.scanner(passRequest);
    controller.signal.throwIfAborted();
    const headers = { authorization: `Bearer ${issued.value}`, expect: '100-continue',
      'content-type': 'application/octet-stream', 'content-length': bytes.length,
      'x-scan-silo': input.silo, 'x-scan-purpose': input.purpose,
      'x-scan-request-id': input.requestId, 'x-scan-file-id': input.fileId,
      'x-scan-sha256': input.sha256 };
    const options = { method: 'POST', ca, headers, signal: controller.signal, agent: false as const,
      rejectUnauthorized: true, minVersion: 'TLSv1.2' as const };
    const value = await exchange(url, options, bytes);
    requireScan(performance.now() - elapsedStart < 60000 && Date.now() - started < 60000);
    const result = resultSchema.parse(value);
    function validate() {
      const now = Date.now();
      const checked = Date.parse(result.checkedAt);
      const expires = Date.parse(result.expiresAt);
      const updated = Date.parse(result.databaseUpdatedAt);
      // Keep expiry bounded even if wall time moves backwards.
      requireScan(performance.now() - elapsedStart < expires - started);
      requireScan(now >= started && checked <= now && updated <= checked &&
        now < updated + 86400000 && expires > now && expires <= checked + 120000 &&
        expires <= updated + 86400000 && expires <= issued.expiresAt);
      const names = new Set<string>();
      for (const database of result.databases) {
        names.add(database.file.split('.')[0]!);
        requireScan(Date.parse(database.builtAt) <= updated);
      }
      requireScan(names.size === 3);
      requireScan(result.silo === input.silo &&
        result.requestId === input.requestId && result.fileId === input.fileId &&
        result.sha256 === input.sha256 && result.byteCount === input.byteCount &&
        bytes.length === input.byteCount && hash(bytes) === input.sha256);
      return result.verdict;
    }
    validate();
    return validate;
  }
  function aborted(_resolve: unknown, reject: (error: Error) => void) {
    function fail() {
      reject(new FileUnavailable('scanner'));
    }
    controller.signal.addEventListener('abort', fail, { once: true });
  }
  try {
    return await Promise.race([prepare(), new Promise<never>(aborted)]);
  } catch {
    // Discard service replies, credentials and parser details at this boundary.
    throw new FileUnavailable('scanner');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function exchange(url: URL, options: Parameters<typeof request>[1], bytes: Buffer) {
  function send(resolve: (value: unknown) => void, reject: (error: Error) => void) {
    const client = request(url, options);
    let continued = false;
    function fail() {
      client.destroy();
      reject(new FileUnavailable('scanner'));
    }
    function continueUpload() {
      continued = true;
      client.end(bytes);
    }
    function response(reply: import('node:http').IncomingMessage) {
      if (!continued || reply.statusCode !== 200 ||
          reply.headers['content-type'] !== 'application/json') {
        fail();
        return;
      }
      const chunks: Buffer[] = [];
      let count = 0;
      function read(chunk: Buffer) {
        count += chunk.length;
        if (count > 4096) {
          fail();
          return;
        }
        chunks.push(chunk);
      }
      function end() {
        try {
          requireScan(reply.complete && count <= 4096);
          const body = Buffer.concat(chunks);
          resolve(JSON.parse(body.toString()) as unknown);
        } catch {
          fail();
        }
      }
      reply.on('data', read);
      reply.once('end', end);
      reply.once('error', fail);
    }
    client.once('continue', continueUpload);
    client.once('response', response);
    client.once('error', fail);
    client.flushHeaders();
  }
  return new Promise(send);
}
