import { z } from 'zod';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { routineControlSchema } from '@opencrane/events';
import { MemberAccessRefused } from '@opencrane/models';

const id = z.string().min(1).max(300);
const revision = z.int().positive();
export const routineMetadataSchema = z.object({
  routineId: id, name: z.string().min(1).max(200), ownerId: id,
  assistantId: id, payingGroupId: id, status: z.enum(['active', 'paused', 'retired']),
  definitionRevision: revision, scheduleRevision: revision, controlRevision: revision,
  next: routineControlSchema.shape.next, executionAvailable: z.literal(false),
}).strict();

export async function readRoutineMetadata(store: EventStore, binding: Binding,
  memberId: string, routineId: string) {
  const auth = memberAuthorisation(binding, store);
  const saved = await auth.loadRoutineAccess(memberId, routineId);
  const permission = await saved.check('read_metadata');
  if (permission.status === 'unavailable') {
    throw new Error('Routine metadata unavailable');
  }
  if (!permission.allowed) {
    throw new MemberAccessRefused('Routine metadata refused');
  }
  const state = saved.state;
  const record = state?.definition;
  if (!state || !record) {
    throw new Error('Routine metadata unavailable');
  }
  const definition = record.definition;
  // Select public facts explicitly; never copy the encrypted definition or run links.
  const metadata = { routineId: state.routineId, name: definition.name,
    ownerId: definition.ownerId, assistantId: definition.assistantId,
    payingGroupId: definition.payingGroupId, status: state.status,
    definitionRevision: record.definitionRevision, scheduleRevision: record.scheduleRevision,
    controlRevision: record.controlRevision, next: record.next, executionAvailable: false };
  return routineMetadataSchema.parse(metadata);
}
