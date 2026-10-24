import { errors } from 'jose';
import { ZodError } from 'zod';
import { isEventStoreUnavailable } from '@opencrane/event-store';

const refusalReasons = new Map([
  ['Budget writer lost its fence', 'budget_writer_replaced'],
  ['Budget writer unavailable', 'budget_writer_unavailable'],
  ['Budget append contention', 'budget_append_contention'],
  ['MCP dispatch expired', 'dispatch_expired'],
  ['MCP policy changed', 'tool_policy_changed'],
  ['Catalogue watch unavailable', 'catalogue_watch_unavailable'],
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
