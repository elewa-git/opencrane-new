import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tokenIssuer } from '@opencrane/auth';
import { z } from 'zod';

const refusal = 'Image part scan refused';
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const date = z.iso.datetime();
const bindingSchema = z.strictObject({
  silo: z.string().regex(/^[\w-]{1,200}$/u),
  serverId: z.string().regex(/^[\w-]{1,200}$/u), attemptId: z.int().positive(),
  platform: z.enum(['linux/amd64', 'linux/arm64']), targetImageDigest: sha256,
});
const database = z.strictObject({
  file: z.string().regex(/^(main|daily|bytecode)\.(cvd|cld)$/u),
  sha256, version: z.int().positive(), builtAt: date,
});
const resultSchema = bindingSchema.extend({
  purpose: z.literal('image'), requestId: z.uuid(), sha256, byteCount: z.int().nonnegative(),
  verdict: z.enum(['clean', 'infected']), imageDigest: digest, manifestDigest: digest,
  databases: z.array(database).length(3), databaseUpdatedAt: date, checkedAt: date, expiresAt: date,
});
function requireScan(condition) {
  if (!condition) {
    throw new Error(refusal);
  }
}
function hash(bytes) {
  const digest = createHash('sha256');
  digest.update(bytes);
  return digest.digest('hex');
}
function sameBinding(actual, expected) {
  for (const field of Object.keys(bindingSchema.shape)) {
    requireScan(actual[field] === expected[field]);
  }
}
function validation(result, input, timing, passExpiry, signal) {
  // Retain only facts. The caller supplies its current bytes and binding again at use.
  return function validate(bytes, binding) {
    const now = Date.now();
    const checked = Date.parse(result.checkedAt);
    const updated = Date.parse(result.databaseUpdatedAt);
    const expires = Date.parse(result.expiresAt);
    requireScan(!signal?.aborted && bindingSchema.safeParse(binding).success);
    requireScan(Buffer.isBuffer(bytes) && bytes.length === input.byteCount);
    sameBinding(binding, input);
    requireScan(hash(bytes) === input.sha256 && now >= timing.started && checked <= now &&
      updated <= checked && now < updated + 86400000 && now < expires &&
      expires <= checked + 120000 && expires <= updated + 86400000 && expires <= passExpiry);
    requireScan(performance.now() - timing.elapsedStart < expires - timing.started);
    const names = new Set();
    for (const database of result.databases) {
      names.add(database.file.split('.')[0]);
      requireScan(Date.parse(database.builtAt) <= updated);
    }
    requireScan(names.size === 3);
    return result.verdict;
  };
}

export async function scanImagePart(settings, bytes, binding, signal) {
  const config = { ...settings };
  const timing = { started: Date.now(), elapsedStart: performance.now() };
  const controller = new AbortController();
  function cancel() {
    controller.abort();
  }
  const timer = setTimeout(cancel, 60000);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) {
    cancel();
  }
  async function prepare() {
    requireScan(Buffer.isBuffer(bytes) && bytes.length <= 20 * 1024 * 1024);
    const input = { ...bindingSchema.parse(binding), purpose: 'image', requestId: randomUUID(),
      sha256: hash(bytes), byteCount: bytes.length };
    requireScan(input.silo === config.silo && config.caFile && config.privateKeyPath &&
      config.issuer && digest.safeParse(config.imageDigest).success &&
      digest.safeParse(config.manifestDigest).success);
    const url = new URL(config.url);
    requireScan(url.protocol === 'https:' && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname === '/scan/image-part');
    const ca = await readFile(config.caFile);
    controller.signal.throwIfAborted();
    requireScan(ca.length > 0);
    const scannerIdentity = { service: 'image-worker', silo: config.silo };
    const tokenOptions = { privateKeyPath: config.privateKeyPath,
      issuer: config.issuer, scannerIdentity };
    const issuer = await tokenIssuer(tokenOptions);
    controller.signal.throwIfAborted();
    const passRequest = { purpose: input.purpose, requestId: input.requestId };
    const issued = await issuer.scanner(passRequest);
    controller.signal.throwIfAborted();
    const headers = { authorization: `Bearer ${issued.value}`, expect: '100-continue',
      'content-type': 'application/octet-stream', 'content-length': input.byteCount,
      'x-scan-silo': input.silo, 'x-scan-purpose': input.purpose,
      'x-scan-request-id': input.requestId, 'x-scan-sha256': input.sha256,
      'x-scan-server-id': input.serverId, 'x-scan-attempt-id': input.attemptId,
      'x-scan-platform': input.platform, 'x-scan-image-digest': input.targetImageDigest };
    const options = { method: 'POST', ca, headers, signal: controller.signal, agent: false,
      rejectUnauthorized: true, minVersion: 'TLSv1.2' };
    const value = await exchange(url, options, bytes);
    requireScan(Date.now() - timing.started < 60000 &&
      performance.now() - timing.elapsedStart < 60000);
    const result = resultSchema.parse(value);
    sameBinding(result, input);
    requireScan(result.requestId === input.requestId && result.sha256 === input.sha256 &&
      result.byteCount === input.byteCount && result.imageDigest === config.imageDigest &&
      result.manifestDigest === config.manifestDigest);
    const validate = validation(result, input, timing, issued.expiresAt, signal);
    validate(bytes, binding);
    return validate;
  }
  let rejectAborted;
  function aborted(_resolve, reject) {
    rejectAborted = reject;
  }
  const cancellation = new Promise(aborted);
  function fail() {
    rejectAborted(new Error(refusal));
  }
  controller.signal.addEventListener('abort', fail, { once: true });
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([prepare(), cancellation]);
  } catch {
    // Discard credentials, parser details and service diagnostics at this boundary.
    throw new Error(refusal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', fail);
    controller.abort();
    bytes = undefined;
  }
}

function exchange(url, options, bytes) {
  function send(resolve, reject) {
    const client = request(url, options);
    const chunks = [];
    let reply;
    let continued = false;
    let count = 0;
    function tidy() {
      client.removeListener('continue', continuePart);
      reply?.removeListener('data', read);
      reply?.removeListener('end', end);
      chunks.length = 0;
      bytes = undefined;
      reply?.destroy();
      client.destroy();
    }
    function fail() {
      tidy();
      reject(new Error(refusal));
    }
    function continuePart() {
      continued = true;
      client.end(bytes);
      bytes = undefined;
    }
    function read(chunk) {
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
        const result = JSON.parse(body.toString());
        tidy();
        resolve(result);
      } catch {
        fail();
      }
    }
    function response(incoming) {
      reply = incoming;
      if (!continued || reply.statusCode !== 200 ||
          reply.headers['content-type'] !== 'application/json') {
        fail();
        return;
      }
      reply.on('data', read);
      reply.once('end', end);
      reply.once('error', fail);
      reply.once('aborted', fail);
    }
    client.once('continue', continuePart);
    client.once('response', response);
    client.once('error', fail);
    client.flushHeaders();
  }
  return new Promise(send);
}
