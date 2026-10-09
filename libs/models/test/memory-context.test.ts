import { beforeAll, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { parseMemoryRequest } from '../src/mcp.ts';
import { verifyMemoryContext } from '../src/memory-context.ts';

const scopeId = 'a'.repeat(64);
const metadata = { threadId: 'thread', callId: 'call',
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {} };
const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
  name: 'recall', arguments: { scopeId }, _meta: metadata } };
const headers = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call',
  'mcp-name': 'recall' };
const parsed = parseMemoryRequest(JSON.stringify(request), headers);
const claims: JWTPayload = { silo: 'test', requester: 'alice', assistant: 'assistant',
  computer: 'computer', generation: 1, conversation: 'conversation', turn: 'turn',
  thread: 'thread', operation: 'recall', scopes: [scopeId], contentAccess: 'private',
  bodyDigest: parsed.bodyDigest, callId: 'call',
  requestId: '11111111-1111-4111-8111-111111111111', contextPosition: 0 };
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let wrongKeys: typeof keys;
let identity: Parameters<typeof verifyMemoryContext>[1];

async function prepare() {
  keys = await generateKeyPair('ES256');
  wrongKeys = await generateKeyPair('ES256');
  const publicKey = await exportJWK(keys.publicKey);
  identity = { issuer: 'https://lifecycle.test/', jwks: { keys: [publicKey] } };
}
beforeAll(prepare);

async function sign(payload: JWTPayload, wrongKey = false, algorithm = 'ES256') {
  const token = new SignJWT(payload);
  token.setProtectedHeader({ alg: algorithm });
  if (algorithm === 'HS256') return token.sign(new Uint8Array(32));
  return token.sign(wrongKey ? wrongKeys.privateKey : keys.privateKey);
}
function timedClaims(): JWTPayload {
  const now = Date.now() / 1000;
  return { ...claims, iss: identity.issuer, aud: 'memory-mcp', iat: now, exp: now + 2 };
}

it('accepts a matching signed context and refuses a well-formed token from another key',
  async function signature() {
    const payload = timedClaims();
    const valid = await sign(payload);
    expect(await verifyMemoryContext(valid, identity, parsed)).toMatchObject(claims);
    const wrong = await sign(payload, true);
    await expect(verifyMemoryContext(wrong, identity, parsed)).rejects.toThrow();
  });

const restrictions = [
  { field: 'iss', value: 'https://other.test/' },
  { field: 'aud', value: 'agentgateway' },
  { field: 'operation', value: 'tools/list' },
  { field: 'scopes', value: ['b'.repeat(64)] },
  { field: 'thread', value: 'other-thread' },
  { field: 'callId', value: 'other-call' },
  { field: 'bodyDigest', value: 'b'.repeat(64) },
  { field: 'contentAccess', value: 'shared_only' },
];
async function refusesRestriction({ field, value }: { field: string; value: unknown }) {
  const payload = { ...timedClaims(), [field]: value };
  const token = await sign(payload);
  await expect(verifyMemoryContext(token, identity, parsed)).rejects.toThrow();
}
it.each(restrictions)('refuses $field independently of the matching request digest',
  refusesRestriction);

async function refusesAlgorithm() {
  const token = await sign(timedClaims(), false, 'HS256');
  await expect(verifyMemoryContext(token, identity, parsed)).rejects.toThrow();
}
it('refuses a token using another signing algorithm', refusesAlgorithm);

const requiredFields = Object.keys(claims);
requiredFields.push('iat', 'exp', 'iss', 'aud');
async function refusesMissingField(field: string) {
  const payload = timedClaims();
  delete payload[field];
  const token = await sign(payload);
  await expect(verifyMemoryContext(token, identity, parsed)).rejects.toThrow();
}
it.each(requiredFields)('refuses a missing %s claim', refusesMissingField);

const invalidFields = [
  { field: 'silo', value: '' }, { field: 'requester', value: 'a'.repeat(201) },
  { field: 'assistant', value: '*' }, { field: 'computer', value: '*' },
  { field: 'conversation', value: '*' }, { field: 'turn', value: '*' },
  { field: 'thread', value: '*' }, { field: 'generation', value: 0 },
  { field: 'generation', value: 1.5 }, { field: 'scopes', value: [scopeId, scopeId] },
  { field: 'scopes', value: ['bad'] }, { field: 'bodyDigest', value: 'bad' },
  { field: 'callId', value: '' }, { field: 'callId', value: 'a'.repeat(201) },
  { field: 'requestId', value: 'bad' }, { field: 'contextPosition', value: -1 },
  { field: 'contextPosition', value: 1.5 },
];
it.each(invalidFields)('refuses an invalid or unbounded $field claim ($value)',
  refusesRestriction);

const lifetimes = ['future', 'reversed', 'too-long', 'expired'];
async function refusesLifetime(lifetime: string) {
  const payload = timedClaims();
  const now = Date.now() / 1000;
  if (lifetime === 'future') {
    payload.iat = now + 10;
    payload.exp = now + 11;
  } else if (lifetime === 'reversed') {
    payload.iat = now + 11;
    payload.exp = now + 10;
  } else if (lifetime === 'too-long') {
    payload.iat = now;
    payload.exp = now + 2.001;
  } else {
    payload.iat = now - 2;
    payload.exp = now - 1;
  }
  const token = await sign(payload);
  await expect(verifyMemoryContext(token, identity, parsed)).rejects.toThrow();
}
it.each(lifetimes)('refuses a %s lifetime', refusesLifetime);

const invalidArguments = [
  { scopeId, extra: true }, { scopeId, memoryId: 'fact' },
  { scopeId, cursor: 'a'.repeat(2001) }, { scopeId, limit: 0 },
  { scopeId, limit: 21 }, { scopeId, limit: 1.5 }, { scopeId, limit: '1' },
  { scopeId, query: 1 },
];
function refusesArguments(argumentsValue: Record<string, unknown>) {
  const body = { ...request, params: { ...request.params, arguments: argumentsValue } };
  const raw = JSON.stringify(body);
  function parse() { parseMemoryRequest(raw, headers); }
  expect(parse).toThrow();
}
it.each(invalidArguments)('refuses strict recall arguments %j', refusesArguments);

it('refuses a session header and oversized UTF-8 request before parsing', function requestLimits() {
  const raw = JSON.stringify(request);
  const sessionHeaders = { ...headers, 'mcp-session-id': 'session' };
  function session() { parseMemoryRequest(raw, sessionHeaders); }
  expect(session).toThrow();
  const argumentsValue = { scopeId, query: 'é'.repeat(8192) };
  const body = { ...request, params: { ...request.params, arguments: argumentsValue } };
  function oversized() { parseMemoryRequest(JSON.stringify(body), headers); }
  expect(oversized).toThrow();
});

it('refuses when the verifier has no signing key', async function unavailableVerifier() {
  const token = await sign(timedClaims());
  const missing = { ...identity, jwks: { keys: [] } };
  await expect(verifyMemoryContext(token, missing, parsed)).rejects.toThrow();
});
