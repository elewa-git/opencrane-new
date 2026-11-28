import assert from 'node:assert/strict';
import { chmod, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { root } from './config.ts';
import { secondary, stackId } from './identity.ts';

export const issuer = 'https://weownai-oidc-8dwlat.eu1.zitadel.cloud';
const missingFileSchema = z.object({ code: z.literal('ENOENT') });
const credentialErrorSchema = z.object({ code: z.enum(['ENOENT', 'EACCES', 'EPERM']) });
const providerCodeSchema = z.object({ code: z.number() });
const endpointSegments = new Set(['', 'admin', 'management', 'v1', 'orgs', 'me',
  'projects', 'apps', 'oidc', 'oidc_config', 'users', 'human', '_import', '_search',
  'grants', 'members']);

// Show only messages built here in the CLI. Keep private causes for error handling.
export class ZitadelSetupError extends Error {}

export async function secondaryCredentials() {
  assert(secondary, 'Only a secondary slot may use retained credentials');
  const directory = `${homedir()}/.config/opencrane/dev-stack-ci-${stackId}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  assert(await realpath(directory) === directory, 'Credential directory must not be a symlink');
  await chmod(directory, 0o700);
  return directory;
}

async function openCredentialReference(flags: number) {
  const directory = await secondaryCredentials();
  // Refuse links in the open itself so a replacement cannot redirect the read or write.
  const file = await open(`${directory}/zitadel-key-file`, flags | constants.O_NOFOLLOW, 0o600);
  try {
    const metadata = await file.stat();
    assert(metadata.isFile(), 'Credential reference must be a regular file');
    return file;
  } catch (cause) {
    await file.close();
    throw cause;
  }
}

async function readCredentialReference() {
  const file = await openCredentialReference(constants.O_RDONLY);
  try {
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

export async function retainCredentialReference(path: string) {
  const file = await openCredentialReference(constants.O_WRONLY | constants.O_CREAT);
  try {
    // Truncate only after opening and checking the actual file, never a linked target.
    await file.truncate(0);
    await file.writeFile(resolve(path));
    await file.chmod(0o600);
  } finally {
    await file.close();
  }
}

async function credentialFile() {
  const explicitFile = process.env['ZITADEL_KEY_FILE'];
  if (explicitFile !== undefined) {
    return resolve(explicitFile);
  }
  if (secondary) {
    try {
      return await readCredentialReference();
    } catch (error) {
      const missing = missingFileSchema.safeParse(error);
      if (!missing.success) {
        throw error;
      }
    }
  }
  return `${root}/.keys/.zitadel-key`;
}

async function readCredential() {
  try {
    const file = await credentialFile();
    const contents = await readFile(file, 'utf8');
    const credential = contents.trim();
    if (!credential) {
      throw new ZitadelSetupError('Zitadel credentials are empty; no request sent');
    }
    return credential;
  } catch (cause) {
    if (cause instanceof ZitadelSetupError) {
      throw cause;
    }
    const error = credentialErrorSchema.safeParse(cause);
    const code = error.success ? error.data.code : 'unavailable';
    throw new ZitadelSetupError(`Zitadel credentials unavailable (${code}); ` +
      'set ZITADEL_KEY_FILE to an existing private key file; no request sent', { cause });
  }
}

async function providerCode(response: Response) {
  try {
    const body: unknown = await response.json();
    // Show only Zitadel's numeric gRPC error code, never its response text.
    const parsed = providerCodeSchema.safeParse(body);
    if (parsed.success) {
      const code = parsed.data.code;
      if (Number.isInteger(code) && code >= 0 && code <= 16) {
        return { code: String(code), cause: undefined };
      }
    }
  } catch (cause) {
    // Keep interrupted bodies and malformed JSON private while retaining the HTTP status.
    return { code: 'unavailable', cause };
  }
  return { code: 'unavailable', cause: undefined };
}

function publicEndpoint(path: string) {
  const segments = path.split('/');
  for (const segment of segments) {
    // Accept decimal Zitadel ids, but never print other provider-supplied text.
    if (!endpointSegments.has(segment) && !/^\d{1,20}$/u.test(segment)) {
      return '[unrecognised endpoint]';
    }
  }
  return path;
}

export async function zitadelApi(path: string, orgId: string | undefined,
  body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const credential = await readCredential();
  const endpoint = publicEndpoint(path);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential}`,
    'content-type': 'application/json',
  };
  if (orgId) {
    headers['x-zitadel-orgid'] = orgId;
  }
  const options: RequestInit = {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers,
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(`${issuer}${path}`, options);
  } catch (cause) {
    throw new ZitadelSetupError(`Zitadel ${method} ${endpoint} failed before an HTTP response`,
      { cause });
  }
  if (!response.ok) {
    const failure = await providerCode(response);
    throw new ZitadelSetupError(`Zitadel ${method} ${endpoint} returned HTTP ${response.status}; ` +
      `code ${failure.code}`, { cause: failure.cause });
  }
  return response.json() as Promise<unknown>;
}
