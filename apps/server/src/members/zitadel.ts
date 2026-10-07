import { readFile } from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';
import { z } from 'zod';

export class DirectoryOrganisationError extends Error {}

const user = z.object({ id: z.string().min(1).max(200), state: z.string(),
  details: z.object({ resourceOwner: z.string() }), human: z.object({
    profile: z.object({ displayName: z.string().max(500) }),
    email: z.object({ email: z.string().max(254), isEmailVerified: z.boolean().default(false) }),
  }).optional() });
const usersSchema = z.object({ result: z.array(user).max(2).default([]) });
const userSchema = z.object({ user });
const tokenSchema = z.object({ access_token: z.string().min(1) });
const credential = z.object({ keyId: z.string(), key: z.string(), userId: z.string() });
async function json(response: Response) {
  if (!response.ok) throw new Error('Directory unavailable');
  const chunks = [];
  let size = 0;
  if (!response.body) throw new Error('Directory response missing');
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 65_536) throw new Error('Directory response too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(text) as unknown;
}
async function directoryAccessToken(issuer: string, keyFile: string, signal: AbortSignal,
  send: typeof fetch = fetch) {
  const text = await readFile(keyFile, 'utf8');
  const saved = credential.parse(JSON.parse(text));
  const key = createPrivateKey(saved.key);
  const jwt = new SignJWT({});
  jwt.setProtectedHeader({ alg: 'RS256', kid: saved.keyId });
  jwt.setIssuer(saved.userId);
  jwt.setSubject(saved.userId);
  jwt.setAudience(issuer);
  jwt.setIssuedAt();
  jwt.setExpirationTime('1m');
  const assertion = await jwt.sign(key);
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    scope: 'openid urn:zitadel:iam:org:project:id:zitadel:aud', assertion });
  const request: RequestInit = { method: 'POST', body, signal, redirect: 'error' };
  const response = await send(`${issuer}/oauth/v2/token`, request);
  const result = await json(response);
  const token = tokenSchema.parse(result);
  return token.access_token;
}
export function zitadelDirectory(issuer: string, orgId: string, keyFile: string,
  send: typeof fetch = fetch) {
  if (issuer === 'https://weownai-oidc-8dwlat.eu1.zitadel.cloud'
    && orgId !== '393311211338337681') throw new DirectoryOrganisationError('Wrong dev organisation');
  function owned(person: z.infer<typeof user>) {
    if (person.details.resourceOwner !== orgId) {
      throw new DirectoryOrganisationError('Wrong directory organisation');
    }
    return person;
  }
  async function read(path: string, signal: AbortSignal, body?: unknown) {
    const token = await directoryAccessToken(issuer, keyFile, signal, send);
    const headers = { authorization: `Bearer ${token}`, 'x-zitadel-orgid': orgId,
      'content-type': 'application/json' };
    const orgRequest: RequestInit = { headers, signal, redirect: 'error' };
    const organisation = await send(`${issuer}/management/v1/orgs/me`, orgRequest);
    const orgSchema = z.object({ org: z.object({ id: z.literal(orgId), name: z.string() }) });
    const result = await json(organisation);
    const parsed = orgSchema.parse(result);
    const org = parsed.org;
    if (orgId === '393311211338337681' && org.name !== 'OpenCrane 2 Dev') {
      throw new DirectoryOrganisationError('Wrong dev organisation name');
    }
    const request: RequestInit = {
      method: body === undefined ? 'GET' : 'POST', signal, redirect: 'error',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const response = await send(`${issuer}/management/v1/${path}`, request);
    return json(response);
  }
  async function search(email: string, signal: AbortSignal) {
    const body = { query: { limit: '2' }, queries: [
      { emailQuery: { emailAddress: email, method: 'TEXT_QUERY_METHOD_EQUALS' } },
    ] };
    const result = await read('users/_search', signal, body);
    const people = usersSchema.parse(result);
    return people.result.map(owned);
  }
  async function get(subject: string, signal: AbortSignal) {
    const id = z.string().regex(/^[\w-]{1,200}$/u).parse(subject);
    const result = await read(`users/${id}`, signal);
    const person = userSchema.parse(result);
    return owned(person.user);
  }
  return { search, get };
}
