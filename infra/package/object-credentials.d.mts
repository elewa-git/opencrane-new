export function issueObjectLease(identity: { accessKey: string; secretKey: string },
  leaseFile: string, endpoint: string, signal?: AbortSignal): Promise<void>;

export function storageTransport(protocol: 'http:' | 'https:', signal: AbortSignal):
  Pick<typeof import('node:http'), 'request'>;

export function ensureFileBucket(identity: { accessKey: string; secretKey: string },
  signal?: AbortSignal): Promise<void>;
