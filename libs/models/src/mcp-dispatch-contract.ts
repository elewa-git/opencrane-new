import { z } from 'zod';
import type { toolCredentialReleaseSchema } from '@opencrane/events';
import type { MemoryDispatch } from './memory-context.ts';
import type { ModelCall } from './state.ts';
import type { mcpPolicy } from './mcp.ts';

const identifier = z.string().regex(/^[\w-]{1,200}$/u);
export const mcpDispatchRouteSchema = z.strictObject({
  serverId: identifier, connectionId: identifier,
  upstream: z.string().regex(/^[\w.-]+:\d{1,5}$/u),
  generation: identifier.optional(),
  revisionHeader: z.literal('x-opencrane-mcp-revision').optional(),
});
export type Route = z.infer<typeof mcpDispatchRouteSchema> & { locator?: string; standard?: boolean };
export interface McpAccessCheck {
  (): Promise<void>;
  prepare?: (deadline: number) => Promise<void>;
}

export interface MemorySend {
  method: string;
  sign: (dispatch: MemoryDispatch, expiresAt: number) => Promise<string>;
}
export interface BudgetBinding {
  confirmRoutine: () => Promise<void>;
  rootId?: string;
  modelCall: ModelCall;
  decisionId: string;
  admittedAt: number;
}
export interface Permit {
  gatewayBinding?: NonNullable<Awaited<ReturnType<typeof mcpPolicy>>['gatewayBinding']>;
  budget: BudgetBinding;
  memory?: MemorySend;
  memoryBinding: MemoryDispatch;
  requestId: string;
  silo: string;
  route: Route;
  policyRevision: number;
  reviewRevision: number | undefined;
  catalogueSequence: number;
  schemaDigest: string;
  toolRevision: string;
  toolName: string;
  bodyDigest: string;
  expiresAt: number;
  accessDeadline: number;
  confirmAccess: McpAccessCheck;
  release?: z.infer<typeof toolCredentialReleaseSchema> | undefined;
  prepareCredential?: () => Promise<void>;
}
