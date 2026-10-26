import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { request as httpRequest, IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { urlToHttpOptions } from 'node:url';
import { Client } from 'minio/dist/esm/minio.mjs';
import { CredentialProvider } from 'minio/dist/esm/CredentialProvider.mjs';
import { Credentials } from 'minio/dist/esm/Credentials.mjs';
import { z } from 'zod';
import { FileUnavailable } from './refusals.ts';

type ResponseCallback = (response: IncomingMessage) => void;

interface RequestBounds {
  signal: AbortSignal;
  timeoutMs: number;
}

function storageTransport(useSSL: boolean, context: AsyncLocalStorage<RequestBounds>) {
  let nativeRequest = httpRequest;
  if (useSSL) {
    nativeRequest = httpsRequest;
  }

  function request(options: RequestOptions | string | URL, callback?: ResponseCallback):
    ReturnType<typeof httpRequest>;
  function request(url: string | URL, options: RequestOptions, callback?: ResponseCallback):
    ReturnType<typeof httpRequest>;
  function request(
    input: RequestOptions | string | URL,
    optionsOrCallback?: RequestOptions | ResponseCallback,
    callback?: ResponseCallback,
  ) {
    let requestOptions: RequestOptions;
    if (typeof input === 'string' || input instanceof URL) {
      const url = new URL(input);
      requestOptions = urlToHttpOptions(url);
    } else {
      requestOptions = input;
    }
    let onResponse = callback;
    if (typeof optionsOrCallback === 'function') {
      onResponse = optionsOrCallback;
    } else if (optionsOrCallback) {
      requestOptions = { ...requestOptions, ...optionsOrCallback };
    }

    const bounds = context.getStore();
    const timeoutMs = bounds?.timeoutMs ?? 60_000;
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (bounds) signals.push(bounds.signal);
    const signal = AbortSignal.any(signals);
    requestOptions = { ...requestOptions, signal, timeout: timeoutMs, maxHeaderSize: 16 * 1024 };

    function fail() {
      outgoing.destroy();
      // Report body failures even if consuming the response already closed the socket.
      outgoing.emit('error', new FileUnavailable('object_store'));
    }
    function handleResponse(response: IncomingMessage) {
      if (response.statusCode === 503) {
        // Mark the outage before MinIO's retry wrapper loses the HTTP status.
        response.destroy();
        fail();
        return;
      }
      const path = new URL(requestOptions.path ?? '/', 'http://storage.invalid');
      const isMetadata = path.searchParams.has('location');
      const isError = !response.statusCode || response.statusCode < 200 ||
        response.statusCode >= 300;
      if (isMetadata || isError) {
        // Bound these bytes before the SDK collects a whole region or error body in memory.
        void boundedResponse(response, onResponse).catch(fail);
        return;
      }
      onResponse?.(response);
    }
    const outgoing = nativeRequest(requestOptions, handleResponse);
    outgoing.on('timeout', fail);
    return outgoing;
  }
  return { request };
}

async function boundedResponse(response: IncomingMessage, callback?: ResponseCallback) {
  const chunks: Buffer[] = [];
  let count = 0;
  try {
    for await (const chunk of response) {
      if (!Buffer.isBuffer(chunk)) throw new FileUnavailable('object_store');
      count += chunk.length;
      if (count > 64 * 1024) throw new FileUnavailable('object_store');
      chunks.push(chunk);
    }
    // Give the SDK a completed, bounded response with the original status and headers.
    const saved = new IncomingMessage(response.socket);
    saved.complete = true;
    saved.statusCode = response.statusCode;
    saved.headers = response.headers;
    saved.rawHeaders = response.rawHeaders;
    saved.push(Buffer.concat(chunks));
    saved.push(null);
    callback?.(saved);
  } finally {
    response.destroy();
  }
}

const storageLease = z.object({
  accessKey: z.string().min(1),
  secretKey: z.string().min(1),
  sessionToken: z.string().min(1),
  expiresAt: z.int(),
});

/** Only a short-lived, bucket-scoped lease reaches the server; each request reads its rotation. */
export function storageClient(url: string, leaseFile: string) {
  const endpoint = new URL(url);
  const wrongProtocol = !['http:', 'https:'].includes(endpoint.protocol);
  if (wrongProtocol || endpoint.username || endpoint.password || endpoint.pathname !== '/') {
    throw new Error('Invalid storage endpoint');
  }
  const emptyCredentials = { accessKey: '', secretKey: '' };
  const credentialsProvider = new CredentialProvider(emptyCredentials);
  async function readCredentials() {
    const content = await readFile(leaseFile, 'utf8');
    const value: unknown = JSON.parse(content);
    const lease = storageLease.parse(value);
    const now = Date.now();
    if (lease.expiresAt <= now || lease.expiresAt > now + 900_000) {
      throw new Error('Storage lease expired or overlong');
    }
    return new Credentials(lease);
  }
  credentialsProvider.getCredentials = readCredentials;
  const useSSL = endpoint.protocol === 'https:';
  let defaultPort = 80;
  if (useSSL) {
    defaultPort = 443;
  }
  const context = new AsyncLocalStorage<RequestBounds>();
  const transport = storageTransport(useSSL, context);
  const options = {
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || defaultPort),
    useSSL,
    transport,
    retryOptions: { disableRetry: true },
    credentialsProvider,
  };
  const client = new Client(options);
  function getObjectBounded(bucket: string, address: string, bounds: RequestBounds) {
    bounds.signal.throwIfAborted();
    function download() {
      return client.getObject(bucket, address);
    }
    // Carry one capture's cancellation through region lookup and the object request.
    return context.run(bounds, download);
  }
  return Object.assign(client, { getObjectBounded });
}
