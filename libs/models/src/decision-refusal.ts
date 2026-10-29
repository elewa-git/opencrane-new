import type { ServerResponse } from 'node:http';
import { errors } from 'jose';
import { ZodError } from 'zod';
import { isEventStoreUnavailable } from '@opencrane/event-store';
import { ModelRequestRefused } from './state.ts';
import { BudgetRefused } from './budget-refusal.ts';
import { LoadedMemoryRefused } from './loaded-memory.ts';
import { MemoryToolRefused } from './memory-context.ts';
import { PayingGroupRefused, AuthorityApplying } from './paying-group.ts';
import { NativeDelegationDisabled } from './native-call-check.ts';
import { RoutineDispatchRefused } from './routine-dispatch.ts';

export function decisionError(error: unknown) {
  if (error instanceof BudgetRefused || error instanceof ModelRequestRefused ||
      error instanceof LoadedMemoryRefused || error instanceof MemoryToolRefused ||
      error instanceof PayingGroupRefused || error instanceof RoutineDispatchRefused ||
      error instanceof AuthorityApplying || error instanceof NativeDelegationDisabled) {
    return error.message;
  }
  return 'Request refused or decision service unavailable';
}

const unavailableReasons = new Set([
  'Authority snapshot expired',
  'Current authority unavailable',
  'Budget append unavailable',
  'Budget writer unavailable',
]);

function decisionUnavailable(error: unknown): boolean {
  if (isEventStoreUnavailable(error)) return true;
  return error instanceof Error && unavailableReasons.has(error.message);
}

export function respondDecisionUnavailable(response: ServerResponse, error: unknown,
  requestId: string): boolean {
  if (!decisionUnavailable(error)) return false;
  const body = { requestId, error: 'Decision service unavailable' };
  response.writeHead(503);
  response.end(JSON.stringify(body));
  return true;
}

const refusalReasons = new Map([
  ['Missing credentials', 'credentials_missing'],
  ['Credential binding mismatch', 'credential_binding_mismatch'],
  ['Computer control is pending', 'computer_control_pending'],
  ['Computer is not ready', 'computer_not_ready'],
  ['Computer generation mismatch', 'computer_generation_mismatch'],
  ['Computer silo mismatch', 'computer_silo_mismatch'],
  ['Computer changed', 'computer_changed'],
  ['Turn is not active', 'turn_not_active'],
  ['Invalid token lifetime', 'credential_lifetime_invalid'],
  ['Token has been rotated', 'credential_rotated'],
  ['Authority changed', 'authority_changed'],
  ['Authority snapshot expired', 'access_deadline_expired'],
  ['IAM projection behind', 'iam_projection_behind'],
  ['Current authority unavailable', 'iam_unavailable'],
  ['Budget append unavailable', 'budget_append_unavailable'],
  ['Budget writer unavailable', 'budget_writer_unavailable'],
  ['Current authority refused', 'current_authority_refused'],
  ['Membership unavailable or refused', 'membership_refused'],
  ['Assistant inactive', 'assistant_inactive'],
  ['Decision client disconnected', 'client_disconnected'],
]);

export function privateDecisionReason(error: unknown): string {
  if (error instanceof errors.JWTExpired) {
    return 'credential_expired';
  }
  if (error instanceof errors.JOSEError) {
    return 'credential_invalid';
  }
  if (error instanceof ZodError) {
    return 'invalid_request';
  }
  if (isEventStoreUnavailable(error)) {
    return 'event_store_unavailable';
  }
  // Log only fixed labels. Exception text can contain credentials or request values.
  if (error instanceof Error) {
    const reason = refusalReasons.get(error.message);
    if (reason !== undefined) {
      return reason;
    }
  }
  return 'decision_unavailable';
}
