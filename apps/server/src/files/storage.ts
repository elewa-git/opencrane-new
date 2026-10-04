import { readFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { urlToHttpOptions } from 'node:url';
import { Client } from 'minio/dist/esm/minio.mjs';
import { CredentialProvider } from 'minio/dist/esm/CredentialProvider.mjs';
import { Credentials } from 'minio/dist/esm/Credentials.mjs';
import { z } from 'zod';
import { FileUnavailable } from './refusals.ts';

type ResponseCallback = (response: IncomingMessage) => void;

function storageTransport(useSSL: boolean) {
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

    function handleResponse(response: IncomingMessage) {
      if (response.statusCode === 503) {
        // MinIO's retry wrapper loses HTTP status, so mark the outage before it sees the reply.
        response.resume();
        outgoing.destroy(new FileUnavailable('object_store'));
        return;
      }
      onResponse?.(response);
    }
    const outgoing = nativeRequest(requestOptions, handleResponse);
    return outgoing;
  }
  return { request };
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
  const transport = storageTransport(useSSL);
  const options = {
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || defaultPort),
    useSSL,
    transport,
    retryOptions: { disableRetry: true },
    credentialsProvider,
  };
  return new Client(options);
}
