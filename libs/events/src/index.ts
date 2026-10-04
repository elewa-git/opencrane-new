// unknownEventEnvelopeSchema is deliberately not exported here: it is a
// test-only building block (see envelope.ts), not part of this library's
// public surface. Every real event type has its own strict schema.
export {
  correlationIdsSchema,
  eventEnvelopeSchema,
  principalSchema,
  type CorrelationIds,
  type EventEnvelope,
  type Principal,
} from './envelope.ts';

export {
  approvalDecidedDataSchema,
  effectObservedDataSchema,
  memberJoinedDataSchema,
  messagePostedDataSchema,
  type ApprovalDecidedData,
  type EffectObservedData,
  type MemberJoinedData,
  type MessagePostedData,
} from './examples.ts';

export {
  eventRegistry,
  getEventDefinition,
  listEventTypes,
  type EventDefinition,
} from './registry.ts';

export { parseEventByType, type ParseEventByTypeResult } from './parse.ts';

export { handlerSubscriptions, type HandlerName } from './handlers.ts';
export { memberInvitedDataSchema } from './data.ts';

export { budgetCeilingSetDataSchema, decisionRecordedDataSchema } from './data.ts';

export { toolApprovalRequestedDataSchema, mcpServerDiscoveredDataSchema } from './data.ts';
export { fileUploadedDataSchema, fileRejectedDataSchema, fileDeliveredDataSchema } from './file-events.ts';

export { effectResolvedDataSchema, effectUncertainDataSchema } from './data.ts';
