import { z } from 'zod';
const id = z.string().regex(/^[\w-]{1,200}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const parameterHeader = z.string().regex(/^mcp-param-[!#$%&'*+.^_`|~0-9a-z-]+$/u);
export const reviewedToolSchema = z.object({ name: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/u), revision: digest,
  mode: z.enum(['allow', 'ask', 'block']), costCents: z.int().nonnegative().max(0).pipe(z.literal(0)).optional() }).strict();
export const desiredMcpSchema = z.object({ schemaDigest: digest, connectionId: id, accountMode: z.enum(['none', 'personal', 'company']),
  tools: z.array(reviewedToolSchema).max(1000), target: z.url(), route: z.string(), cel: z.string(), authz: z.string(),
  headerNames: z.array(z.union([z.enum(['content-type', 'accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'x-request-id', 'x-mcp-permit']), parameterHeader])), headerParameters: z.array(z.object({ tool: z.string(), path: z.array(z.string()),
    headerName: parameterHeader, types: z.array(z.enum(['string', 'integer', 'boolean'])) }).strict()), transport: z.literal('guarded-https'), version: z.literal('2026-07-28') }).strict();
export const publicationSchema = z.object({ serverId: id, publishedBy: id, changeRef: id, digest, desired: desiredMcpSchema }).strict();
export const configurationAppliedSchema = z.object({ serverId: id, changeRef: id, digest }).strict();
