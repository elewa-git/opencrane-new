import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JSONWebKeySet } from 'jose';
import { z } from 'zod';
import { childStartRoute, type ChildStartHandler } from './decision-child-start.ts';
import { readBody } from './decision-request-body.ts';

const identifier = z.string().regex(/^[\w-]+$/u).max(200);
const preparation = z.strictObject({ scopeId: identifier, nightId: identifier });
export type MaintenancePrepare = (scopeId: string, nightId: string) =>
  Promise<{ outcome: string }>;

export async function maintenanceOrChildRoute(req: IncomingMessage, res: ServerResponse,
  silo: string, identity: { jwks: JSONWebKeySet; issuer: string },
  childStart?: ChildStartHandler, maintenancePrepare?: MaintenancePrepare) {
  if (req.url !== '/maintenance/prepare' || req.method !== 'POST') {
    return childStartRoute(req, res, silo, identity, childStart);
  }
  try {
    if (!maintenancePrepare) throw new Error('Preparation unavailable');
    const input = preparation.parse(JSON.parse(await readBody(req)));
    const result = await maintenancePrepare(input.scopeId, input.nightId);
    res.writeHead(result.outcome === 'unknown' ? 503 : 200);
    res.end('{}');
  } catch {
    res.writeHead(503);
    res.end('{}');
  }
  return true;
}
