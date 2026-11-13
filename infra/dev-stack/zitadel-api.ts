import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, realpath } from 'node:fs/promises';
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

// Only messages built here may reach the CLI. Keep private causes for error handling.
export class ZitadelSetupError extends Error {}

export async function secondaryCredentials() {
  assert(secondary, 'Only a secondary slot may use retained credentials');
  const directory = `${homedir()}/.config/opencrane/dev-stack-ci-${stackId}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  assert(await realpath(directory) === directory, 'Credential directory must not be a symlink');
  await chmod(directory, 0o700);
  return directory;
}

async function credentialFile() {
  const explicitFile = process.env['ZITADEL_KEY_FILE'];
  if (explicitFile !== undefined) return resolve(explicitFile);
  if (secondary) {
    const directory = await secondaryCredentials();
    try {
      return await readFile(`${directory}/zitadel-key-file`, 'utf8');
    } catch (error) {
      const missing = missingFileSchema.safeParse(error);
      if (!missing.success) throw error;
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
    if (cause instanceof ZitadelSetupError) throw cause;
    const error = credentialErrorSchema.safeParse(cause);
    const code = error.success ? error.data.code : 'unavailable';
    throw new ZitadelSetupError(`Zitadel credentials unavailable (${code}); ` +
      'set ZITADEL_KEY_FILE to an existing private key file; no request sent', { cause });
  }
}

async function providerCode(response: Response) {
  try {
    const body: unknown = await response.json();
    // Zitadel uses numeric gRPC codes. Never print arbitrary provider strings or bodies.
    const parsed = providerCodeSchema.safeParse(body);
    if (parsed.success) {
      const code = parsed.data.code;
      if (Number.isInteger(code) && code >= 0 && code <= 16) return String(code);
    }
  } catch {
    // A proxy can return non-JSON errors; the HTTP status still identifies that response.
  }
  return 'unavailable';
}

function publicEndpoint(path: string) {
  const segments = path.split('/');
  for (const segment of segments) {
    // Zitadel entity ids are decimal numbers. Never print other provider-supplied text.
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
  const options: RequestInit = {
    method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${credential}`, 'content-type': 'application/json',
      ...(orgId ? { 'x-zitadel-orgid': orgId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  let response: Response;
  try {
    response = await fetch(`${issuer}${path}`, options);
  } catch (cause) {
    throw new ZitadelSetupError(`Zitadel ${method} ${endpoint} failed before an HTTP response`,
      { cause });
  }
  if (!response.ok) {
    const code = await providerCode(response);
    throw new ZitadelSetupError(`Zitadel ${method} ${endpoint} returned HTTP ${response.status}; ` +
      `code ${code}`);
  }
  return response.json() as Promise<unknown>;
}
