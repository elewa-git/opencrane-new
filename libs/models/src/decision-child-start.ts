import type { IncomingMessage, ServerResponse } from 'node:http';
import { computerTokenAudience, tokenVerifier } from '@opencrane/auth';
import type { JSONWebKeySet } from 'jose';
import { z } from 'zod';
import { readBody } from './decision-request-body.ts';

const identifier = z.string().regex(/^[\w-]+$/u).max(200);
const requestSchema = z.strictObject({
  conversationId: identifier, turnId: identifier, threadId: identifier,
});
const computerSchema = z.object({ typ: z.literal('computer'), silo: identifier,
  assistant: identifier, computer: identifier, generation: z.int().nonnegative() });
export type ChildStartHandler = (value: unknown) => Promise<unknown>;

export async function childStartRoute(req: IncomingMessage, res: ServerResponse,
  silo: string, identity: { jwks: JSONWebKeySet; issuer: string },
  childStart?: ChildStartHandler) {
  if (req.url !== '/child-start' || req.method !== 'POST') return false;
  try {
    if (!childStart) throw new Error('Child start unavailable');
    const bearer = z.string().parse(req.headers.authorization);
    if (!bearer.startsWith('Bearer ')) throw new Error('Child start unavailable');
    const verifier = tokenVerifier(identity.jwks, identity.issuer);
    const claims = await verifier.verify(bearer.slice(7), computerTokenAudience);
    const computer = computerSchema.parse(claims);
    if (computer.silo !== silo) throw new Error('Child start unavailable');
    const request = requestSchema.parse(JSON.parse(await readBody(req)));
    const selected = { ...request, assistantId: computer.assistant,
      computerId: computer.computer, generation: computer.generation };
    const admitted = await childStart(selected);
    res.end(JSON.stringify(admitted));
  } catch {
    // Return no private text, saved binding or inner error to a rejected caller.
    res.writeHead(503);
    res.end('{"error":"unavailable"}');
  }
  return true;
}
