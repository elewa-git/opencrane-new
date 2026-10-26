// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Jente Rosseel
// Adapt the OC1 Secret and HMAC checks. Keep their notice in connection-custody.NOTICE.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { connectionStageJournal } from './connection-stage-journal.ts';

const identifier = z.string().min(1).max(200);
const stageSchema = z.object({
  siloId: identifier, userId: identifier, serverId: identifier, connectionId: identifier,
  profileId: identifier, purpose: z.enum(['personal', 'company', 'validation']),
  generation: z.int().positive(), endpointDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  operationId: identifier, expectedSequence: z.int().nonnegative(), appendUntil: z.int().positive(),
  attemptId: identifier.optional(), attemptDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();
export type ConnectionStage = z.infer<typeof stageSchema>;
interface ConnectionIdentity { reference: string; uid: string; resourceVersion: string }
interface Result {
  status: 'staged' | 'recovered' | 'conflict' | 'unknown' | 'not_found' | 'deleted';
  identity?: ConnectionIdentity;
}
interface Keyring { currentKeyId: string; keys: Readonly<Record<string, Buffer>> }
const secretSchema = z.object({
  immutable: z.literal(true), type: z.literal('Opaque'),
  metadata: z.object({ name: z.string(), namespace: z.string(), uid: z.string().min(1),
    resourceVersion: z.string().min(1), labels: z.record(z.string(), z.string()),
    annotations: z.record(z.string(), z.string()) }),
  data: z.object({ token: z.string().max(11000) }),
});
type Secret = z.infer<typeof secretSchema>;
const pageSchema = z.object({
  metadata: z.object({ continue: z.string().max(4096).optional() }),
  items: z.array(z.unknown()).max(25),
});
const prefix = 'opencrane.ai/';

/** Keep credentials in one namespace reached through the server's private kubectl proxy. */
export function connectionCustody(apiUrl: string, namespace: string, keyring: Keyring,
  journalDirectory: string) {
  return new ConnectionCustody(apiUrl, namespace, keyring, journalDirectory);
}
class ConnectionCustody {
  private readonly namespace: string;
  private readonly keys = new Map<string, Buffer>();
  private readonly currentKeyId: string;
  private readonly collection: string;
  private readonly journal: ReturnType<typeof connectionStageJournal>;
  constructor(apiUrl: string, namespace: string, keyring: Keyring,
    journalDirectory: string) {
    this.namespace = namespace;
    const api = URL.parse(apiUrl);
    if (!api || api.protocol !== 'http:' || api.hostname !== '127.0.0.1'
        || api.username || api.password || api.pathname !== '/' || api.search || api.hash
        || !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(namespace)) {
      throw new Error('Connection custody configuration invalid');
    }
    for (const [keyId, key] of Object.entries(keyring.keys)) {
      if (!identifier.safeParse(keyId).success || key.length < 32 || key.length > 128) {
        throw new Error('Connection custody keyring invalid');
      }
      this.keys.set(keyId, Buffer.from(key));
    }
    this.currentKeyId = keyring.currentKeyId;
    if (!this.keys.has(this.currentKeyId)) {
      throw new Error('Connection custody keyring invalid');
    }
    this.collection = `${api.origin}/api/v1/namespaces/${namespace}/secrets`;
    this.journal = connectionStageJournal(journalDirectory);
  }

  private async request(method: string, name?: string, body?: object, query?: URLSearchParams) {
    let url = this.collection;
    if (name) {
      url += `/${name}`;
    }
    if (query) {
      url += `?${query.toString()}`;
    }
    const options: RequestInit = { method, redirect: 'error', signal: AbortSignal.timeout(5000) };
    if (body) {
      options.headers = { 'content-type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    return fetch(url, options);
  }
  private verify(secret: Secret, input: ConnectionStage, expected?: ConnectionIdentity,
    material?: string): ConnectionIdentity | undefined {
    const metadata = metadataFor(input);
    const name = nameFor(input);
    if (secret.metadata.name !== name || secret.metadata.namespace !== this.namespace
        || !matches(secret.metadata.labels, metadata.labels)
        || !matches(secret.metadata.annotations, metadata.annotations)) {
      return undefined;
    }
    const identity = { reference: name, uid: secret.metadata.uid,
      resourceVersion: secret.metadata.resourceVersion };
    if (expected && !sameIdentity(identity, expected)) {
      return undefined;
    }
    const key = this.keys.get(secret.metadata.annotations[`${prefix}keyId`] ?? '');
    const verifier = secret.metadata.annotations[`${prefix}verifier`] ?? '';
    const token = decodeToken(secret.data.token);
    if (!key || !token) {
      return undefined;
    }
    const actual = digest(key, input, token.toString('utf8'));
    if (!equalDigest(actual, verifier)) {
      return undefined;
    }
    if (material !== undefined && !equalDigest(digest(key, input, material), verifier)) {
      return undefined;
    }
    return identity;
  }
  async recover(input: ConnectionStage, expected?: ConnectionIdentity,
    material?: string): Promise<Result> {
    try {
      const checked = checkedStage(input);
      const name = nameFor(checked);
      // Rebuild missing preparation only when the caller supplies independent identity evidence.
      if (!await this.journal.prepared(recordFor(checked), expected !== undefined)) {
        return { status: 'conflict' };
      }
      const recorded = await this.journal.identity(name);
      const response = await this.request('GET', name);
      if (response.status === 404) {
        return { status: 'not_found' };
      }
      if (!response.ok) {
        return { status: 'unknown' };
      }
      const secret = secretSchema.safeParse(await readResponse(response));
      if (!secret.success) {
        return { status: 'conflict' };
      }
      // Require evidence from the create reply. Copied Secret fields cannot prove its UID.
      const original = recorded ?? expected;
      if (!original) {
        return { status: 'conflict' };
      }
      const identity = this.verify(secret.data, checked, original, material);
      if (identity && expected && !sameIdentity(identity, expected)) {
        return { status: 'conflict' };
      }
      if (!identity) {
        return { status: 'conflict' };
      }
      if (!await this.journal.pin(identity)) {
        return { status: 'conflict' };
      }
      return { status: 'recovered', identity };
    } catch {
      // Keep transport errors private: they can contain request or response material.
      return { status: 'unknown' };
    }
  }
  async stage(input: ConnectionStage, material: string,
    expected?: ConnectionIdentity): Promise<Result> {
    const checked = checkedStage(input);
    if (Buffer.byteLength(material) === 0 || Buffer.byteLength(material) > 8192) {
      throw new Error('Connection material invalid');
    }
    // Read a recorded identity before trying another create. Never adopt its replacement.
    if (expected) {
      return this.recover(checked, expected, material);
    }
    const metadata = metadataFor(checked);
    metadata.annotations[`${prefix}stage`] = JSON.stringify(checked);
    metadata.annotations[`${prefix}keyId`] = this.currentKeyId;
    const key = this.keys.get(this.currentKeyId)!;
    metadata.annotations[`${prefix}verifier`] = digest(key, checked, material);
    const body = { apiVersion: 'v1', kind: 'Secret', immutable: true, type: 'Opaque',
      metadata: { name: nameFor(checked), namespace: this.namespace, ...metadata },
      data: { token: Buffer.from(material).toString('base64') } };
    try {
      if (!await this.journal.prepared(recordFor(checked), true)) {
        return { status: 'conflict' };
      }
      const recorded = await this.journal.identity(nameFor(checked));
      if (recorded) {
        return this.recover(checked, recorded, material);
      }
      if (!await this.journal.claimCreate(nameFor(checked))) {
        return this.recoverCreate(checked, material);
      }
      const response = await this.request('POST', undefined, body);
      if (response.ok) {
        const secret = secretSchema.safeParse(await readResponse(response));
        if (!secret.success) {
          return { status: 'conflict' };
        }
        const identity = this.verify(secret.data, checked, undefined, material);
        if (!identity) {
          return { status: 'conflict' };
        }
        if (!await this.journal.pin(identity)) {
          return { status: 'conflict' };
        }
        return { status: 'staged', identity };
      }
    } catch {
      // Resolve a lost reply by reading this name, without creating a second generation.
      return this.recoverCreate(checked, material);
    }
    return this.recoverCreate(checked, material);
  }
  /** Prepare private consent material once. A saved create claim prevents another create. */
  async prepareAttempt(input: Omit<ConnectionStage, 'appendUntil'>, material: () => string) {
    try {
      const record = await this.journal.preparation(input.operationId);
      const appendUntil = record?.appendUntil ?? Date.now() + 600_000;
      const stage = checkedStage({ ...input, appendUntil });
      if (!stage.attemptId || Date.now() >= appendUntil) {
        return { status: 'unknown' as const };
      }
      if (!record) {
        await this.stage(stage, material());
      }
      const recovered = await this.recover(stage);
      if (recovered.status !== 'recovered' || !recovered.identity) {
        return { status: 'unknown' as const };
      }
      const contents = await this.readAttempt(stage, recovered.identity);
      if (contents === undefined || Date.now() >= stage.appendUntil) {
        return { status: 'unknown' as const };
      }
      return { status: 'prepared' as const, stage, identity: recovered.identity, contents };
    } catch {
      return { status: 'unknown' as const };
    }
  }
  /** Read only an exact private attempt. Never expose this through a member or admin API. */
  async readAttempt(input: ConnectionStage, expected: ConnectionIdentity) {
    try {
      const stage = checkedStage(input);
      if (!stage.attemptId || !expected || Date.now() >= stage.appendUntil) {
        return undefined;
      }
      const recovered = await this.recover(stage, expected);
      if (recovered.status !== 'recovered') {
        return undefined;
      }
      const response = await this.request('GET', expected.reference);
      if (!response.ok) {
        await response.body?.cancel();
        return undefined;
      }
      const secret = secretSchema.parse(await readResponse(response));
      if (!this.verify(secret, stage, expected)) {
        return undefined;
      }
      // Refuse material that expired while custody recovery or its final read was waiting.
      if (Date.now() >= stage.appendUntil) {
        return undefined;
      }
      return decodeToken(secret.data.token)?.toString('utf8');
    } catch {
      return undefined;
    }
  }
  /** Read one private maintenance page. Never expose its contents through a user API. */
  async candidates(continuation?: string) {
    try {
      if (continuation !== undefined && continuation.length > 4096) {
        return { status: 'unknown' as const };
      }
      const parameters = { limit: '25',
        labelSelector: 'app.kubernetes.io/managed-by=opencrane-server' };
      const query = new URLSearchParams(parameters);
      if (continuation) {
        query.set('continue', continuation);
      }
      const response = await this.request('GET', undefined, undefined, query);
      if (!response.ok) {
        await response.body?.cancel();
        return { status: 'unknown' as const };
      }
      const body = await readResponse(response, 1_048_576);
      const page = pageSchema.parse(body);
      const stages: ConnectionStage[] = [];
      for (const item of page.items) {
        const stage = this.candidate(item);
        if (stage) {
          stages.push(stage);
        }
      }
      return { status: 'listed' as const, stages,
        continuation: page.metadata.continue || undefined };
    } catch {
      return { status: 'unknown' as const };
    }
  }
  private candidate(item: unknown): ConnectionStage | undefined {
    try {
      const secret = secretSchema.parse(item);
      const record = secret.metadata.annotations[`${prefix}stage`];
      if (!record) {
        return undefined;
      }
      const raw: unknown = JSON.parse(record);
      const stage = checkedStage(raw);
      // Use the keyed check to find a profile, never to establish the original UID.
      if (this.verify(secret, stage)) {
        return stage;
      }
      return undefined;
    } catch {
      // Retain damaged objects without blocking healthy neighbours or later pages.
      return undefined;
    }
  }
  private async matchesDeletion(input: ConnectionStage, expected: ConnectionIdentity,
    pending: ConnectionIdentity) {
    const recorded = await this.journal.identity(nameFor(input));
    const prepared = await this.journal.prepared(recordFor(input), false);
    return prepared && recorded !== undefined && sameIdentity(recorded, expected)
      && sameIdentity(pending, expected);
  }
  async remove(input: ConnectionStage, expected?: ConnectionIdentity): Promise<Result> {
    if (!expected || input.attemptId !== undefined) {
      return { status: 'conflict' };
    }
    try {
      const checked = checkedStage(input);
      const pending = await this.journal.deletion(nameFor(checked));
      if (pending) {
        if (!await this.matchesDeletion(checked, expected, pending)) {
          return { status: 'conflict' };
        }
        const result = await this.confirmRemoval(expected.reference);
        if (result.status === 'deleted') {
          return result;
        }
        // Retry a failed send only while the original object is still unchanged.
        // Keep changed versions, including objects waiting for finalisers.
        const observed = await this.recover(checked, expected);
        if (observed.status !== 'recovered') {
          return result;
        }
      }
      const observed = await this.recover(checked, expected);
      if (observed.status !== 'recovered') {
        return observed;
      }
      if (!await this.journal.markDeletion(expected)) {
        return { status: 'conflict' };
      }
      const preconditions = { uid: expected.uid, resourceVersion: expected.resourceVersion };
      const response = await this.request('DELETE', expected.reference, { preconditions });
      if (response.ok) {
        return await this.confirmRemoval(expected.reference);
      }
      if (response.status === 404) {
        return { status: 'not_found' };
      }
      if (response.status === 409) {
        // Observe the conflict and stop. Never retry deletion with the new identity.
        await this.recover(checked, expected);
        return { status: 'conflict' };
      }
      return { status: 'unknown' };
    } catch {
      return { status: 'unknown' };
    }
  }
  private async confirmRemoval(reference: string): Promise<Result> {
    const response = await this.request('GET', reference);
    // Confirm absence. A successful DELETE can leave the credential readable behind a finaliser.
    await response.body?.cancel();
    if (response.status === 404) {
      return { status: 'deleted' };
    }
    return { status: 'unknown' };
  }
  private async recoverCreate(input: ConnectionStage, material: string): Promise<Result> {
    const recovered = await this.recover(input, undefined, material);
    if (recovered.status === 'not_found') {
      return { status: 'unknown' };
    }
    return recovered;
  }
}

function checkedStage(input: unknown): ConnectionStage {
  const checked = stageSchema.safeParse(input);
  if (!checked.success) {
    throw new Error('Connection stage invalid');
  }
  const stage = checked.data;
  if (stage.attemptId !== undefined || stage.attemptDigest !== undefined) {
    if (stage.attemptId !== stage.operationId || !stage.attemptDigest ||
        stage.generation !== 1 || stage.purpose !== 'personal') {
      throw new Error('Connection stage invalid');
    }
  }
  return stage;
}
function nameFor(input: ConnectionStage) {
  const coordinates = [input.siloId, input.connectionId, input.profileId];
  const hash = createHash('sha256');
  hash.update(JSON.stringify(coordinates));
  if (input.attemptId !== undefined) {
    hash.update(JSON.stringify(['oauth-attempt', input.attemptId]));
    return `mcp-${hash.digest('hex').slice(0, 40)}-attempt`;
  }
  return `mcp-${hash.digest('hex').slice(0, 40)}-g${input.generation}`;
}
function metadataFor(input: ConnectionStage) {
  const labels: Record<string, string> = { 'app.kubernetes.io/managed-by': 'opencrane-server' };
  const annotations: Record<string, string> = {};
  for (const [field, value] of Object.entries(input)) {
    if (['endpointDigest', 'operationId', 'expectedSequence', 'appendUntil'].includes(field)) {
      annotations[`${prefix}${field}`] = String(value);
    } else {
      const hash = createHash('sha256');
      hash.update(String(value));
      labels[`${prefix}${field}`] = `sha256-${hash.digest('hex').slice(0, 40)}`;
    }
  }
  return { labels, annotations };
}
function matches(actual: Record<string, string>, expected: Record<string, string>) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      return false;
    }
  }
  return true;
}
function digest(key: Buffer, input: ConnectionStage, material: string) {
  const hmac = createHmac('sha256', key);
  hmac.update('opencrane:mcp-connection-material:v1\0');
  // Bind the private recovery record too, so edits cannot extend the append deadline.
  hmac.update(JSON.stringify(input));
  hmac.update('\0');
  hmac.update(material, 'utf8');
  return hmac.digest('hex');
}
function equalDigest(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
async function readResponse(response: Response, maximumBytes = 32768): Promise<unknown> {
  if (!response.body) {
    throw new Error('Connection custody response invalid');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.length;
      if (size > maximumBytes) {
        throw new Error('Connection custody response too large');
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  } finally {
    await reader.cancel();
  }
}

function decodeToken(encoded: string) {
  const token = Buffer.from(encoded, 'base64');
  if (token.length === 0 || token.length > 8192 || token.toString('base64') !== encoded) {
    return undefined;
  }
  return token;
}
function sameIdentity(actual: ConnectionIdentity, expected: ConnectionIdentity) {
  return actual.reference === expected.reference && actual.uid === expected.uid
    && actual.resourceVersion === expected.resourceVersion;
}
function recordFor(input: ConnectionStage) {
  return { operationId: input.operationId, reference: nameFor(input),
    expectedSequence: input.expectedSequence, appendUntil: input.appendUntil };
}
