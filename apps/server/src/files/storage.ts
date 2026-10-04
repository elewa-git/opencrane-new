import { readFile } from 'node:fs/promises';
import { Client } from 'minio/dist/esm/minio.mjs';
import { CredentialProvider } from 'minio/dist/esm/CredentialProvider.mjs';
import { Credentials } from 'minio/dist/esm/Credentials.mjs';
import { z } from 'zod';

/** Only a short-lived, bucket-scoped lease reaches the server; rotation is read on each storage request. */
export function storageClient(url: string, leaseFile: string) {
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== '/') throw new Error('Invalid storage endpoint');
  const credentialsProvider = new CredentialProvider({ accessKey: '', secretKey: '' });
  credentialsProvider.getCredentials = async () => {
    const lease = z.object({ accessKey: z.string().min(1), secretKey: z.string().min(1), sessionToken: z.string().min(1), expiresAt: z.int() })
      .parse(JSON.parse(await readFile(leaseFile, 'utf8')) as unknown);
    if (lease.expiresAt <= Date.now() || lease.expiresAt > Date.now()+900_000) throw new Error('Storage lease expired or overlong');
    return new Credentials(lease);
  };
  return new Client({ endPoint: endpoint.hostname, port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)), useSSL: endpoint.protocol === 'https:', retryOptions: { disableRetry: true }, credentialsProvider });
}
