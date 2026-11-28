import { credentialPatterns, containsCredentialText } from './credential-patterns.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { StoredEvent } from '@opencrane/event-store';
import { losslessJson } from '@opencrane/events/lossless-json';
import { toolPolicyFromRows } from './tool-policy.ts';
import { exchangeRemote, prepareRemote, type RemoteNetwork } from './remote-https.ts';

export interface BearerIdentityInput {
  rows: StoredEvent[];
  material: string;
  network?: RemoteNetwork;
}
export class BearerIdentityRefused extends Error {}

const registrationFields = { kind: z.literal('remote'), locator: z.url() };
const registrationSchema = z.object(registrationFields);
const subjectTextSchema = z.string();
const subjectSchema = subjectTextSchema.regex(/^[\x21-\x7e]{1,255}$/u);
const identityFields = { subject: subjectSchema };
const identityResultFields = {
  isError: z.literal(false),
  structuredContent: z.object(identityFields),
};
const identityReplyFields = {
  jsonrpc: z.literal('2.0'),
  id: z.string(),
  result: z.object(identityResultFields),
};
const identitySchema = z.object(identityReplyFields);

/** Check only the admin's reviewed read-only tool; never accept a tool name from a member. */
export async function verifyBearerIdentity(input: BearerIdentityInput) {
  try {
    return await checkIdentity(input);
  } catch (error) {
    throw new BearerIdentityRefused('Identity not verified', { cause: error });
  }
}

async function checkIdentity(input: BearerIdentityInput) {
  const policy = toolPolicyFromRows(input.rows);
  if (!policy.identityTool) {
    return undefined;
  }
  function namedIdentity(tool: { name: string }) {
    return tool.name === policy.identityTool;
  }
  const tool = policy.tools.find(namedIdentity);
  if (!tool?.readOnly || !tool.reviewed || tool.costCents !== 0 ||
      policy.accountMode !== 'personal' || !policy.published) {
    throw new Error('Identity check unavailable');
  }
  function isRegistration(row: StoredEvent) {
    return row.event.type === 'mcp.server_registered';
  }
  const registration = input.rows.findLast(isRegistration);
  const source = registrationSchema.parse(registration?.event.data);
  const network = input.network ?? {};
  const signal = AbortSignal.timeout(network.deadlineMs ?? 10_000);
  const request = identityRequest(policy.identityTool, policy.catalogue?.schemaDigest, input.material);
  const target = await prepareRemote(source.locator, network, signal);
  const reply = await exchangeRemote(target, request.raw, request.headers, network, signal, 16_384);
  const decoderOptions = { fatal: true };
  const decoder = new TextDecoder('utf-8', decoderOptions);
  const text = decoder.decode(reply.data);
  losslessJson(text);
  const replyBody: unknown = JSON.parse(text);
  const parsed = identitySchema.parse(replyBody);
  const subject = parsed.result.structuredContent.subject;
  const patterns = credentialPatterns(input.material);
  if (parsed.id !== request.id || containsCredentialText(subject, patterns)) {
    throw new Error('Identity check unavailable');
  }
  const account = {
    issuer: source.locator,
    subject,
    scopes: [],
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  return { toolName: tool.name, toolRevision: tool.revision, account };
}

function identityRequest(toolName: string, revision: string | undefined, material: string) {
  const id = randomUUID();
  const version = '2026-07-28';
  const request = {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: {},
      _meta: { 'io.modelcontextprotocol/protocolVersion': version },
    },
  };
  const raw = JSON.stringify(request);
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${material}`,
    'mcp-protocol-version': version,
    'mcp-method': 'tools/call',
    'mcp-name': toolName,
    'x-opencrane-mcp-revision': revision,
  };
  return { id, raw, headers };
}
