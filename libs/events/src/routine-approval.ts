import { z } from 'zod';

const id = z.string().regex(/^[\w:.-]{1,300}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const routineApprovalBindingSchema = z.strictObject({
  routineId: id, occurrenceId: id, rootId: id, threadId: id, payingGroupId: id,
  profileId: id, profileRevision: z.int().positive(),
  connectionRevision: z.int().positive(), selectionRevision: z.int().positive(),
  companyAccountId: id, accountDigest: digest, scopeDigest: digest,
  destinationDigest: digest,
});
