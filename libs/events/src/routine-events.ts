import { event } from './definition.ts';
import * as schemas from './routines.ts';

const definition = {
  name: 'Daily orders', ownerId: 'alice', ownerAdmissionId: 'joined-alice',
  assistantId: 'sales-assistant', assistantKind: 'team' as const, payingGroupId: 'sales',
  assistantPayingGroupId: 'sales', connectionId: 'odoo', connectionKind: 'company' as const,
  profileId: 'orders-bot',
  profileRevision: 1, connectionRevision: 1, companyAccountId: 'verified-bot', scopes: ['orders:read'],
  instructions: { ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1' },
  schedule: { frequency: 'daily' as const, localTime: '09:00', zone: 'Europe/Brussels' },
};
const slot = { localDate: '2026-10-11', localTime: '09:00', zone: 'Europe/Brussels',
  at: '2026-10-11T07:00:00Z', offsetMinutes: 120 };
const identity = { version: 1 as const, routineId: 'orders', definitionRevision: 1,
  scheduleRevision: 1, controlRevision: 1 };
const saved = { ...identity, definition, status: 'paused' as const, actorId: 'alice',
  effectiveAt: '2026-10-10T12:00:00Z', next: slot, cursor: null };
const control = { ...identity, actorId: 'alice', reason: 'owner_requested',
  source: 'owner' as const, affectedRun: null, next: slot };
const run = { occurrenceId: 'occurrence', rootId: 'root', conversationId: 'chat',
  messageId: 'message', turnId: 'turn' };
const due = { ...identity, ...run, source: 'scheduled' as const, definition,
  slot, firedAt: slot.at, startBy: '2026-10-11T07:01:00Z' };
const reassigned = { ...control, source: 'admin' as const, definition };
const skipped = { ...identity, occurrenceId: 'skipped', localDate: '2027-03-28',
  localTime: '02:30', zone: 'Europe/Brussels', reason: 'dst' as const, cursor: null, next: slot };
const missed = { ...identity, firstLocalDate: '2026-10-09', lastLocalDate: '2026-10-10',
  count: 2, reason: 'downtime' as const, cursor: null, next: slot };
const admitted = { ...identity, ...run, senderAttemptId: 'attempt',
  admission: { eventId: 'admission', position: 1 } };
const stop = { ...control, ...run };
const finished = { ...identity, ...run, outcome: 'cancelled' as const,
  reason: 'root_stopped', terminalEvidence: { eventId: 'closed', position: 4 } };

export const modernRoutineExamples = { saved, control, due };

export const routineEvents = [
  event('routine.reassigned', 'routine', 'An admin changed the owner; the routine stays paused.',
    schemas.routineReassignedSchema, reassigned),
  event('routine.occurrence_skipped', 'routine', 'A local slot was skipped.',
    schemas.routineSkippedSchema, skipped),
  event('routine.occurrences_missed', 'routine', 'A range was missed during downtime.',
    schemas.routineMissedSchema, missed),
  event('routine.run_activation_admitted', 'routine', 'A run admission and sender attempt were saved.',
    schemas.routineActivationSchema, admitted),
  event('routine.run_stop_requested', 'routine', 'The owner or an admin requested a run stop.',
    schemas.routineStopSchema, stop),
  event('routine.run_finished', 'routine', 'A run ended with recorded evidence.',
    schemas.routineFinishedSchema, finished),
];
