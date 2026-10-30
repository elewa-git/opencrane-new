import { z } from 'zod';

const inspectionCause = z.object({ reason: z.enum([
  'unsupported_type', 'content_mismatch', 'macros', 'embedded_object', 'external_link',
  'encrypted', 'too_large', 'too_many_parts', 'invalid_file', 'unsafe_name',
]) });
type InspectionReason = z.infer<typeof inspectionCause>['reason'];

export class InspectionRefusal extends Error {
  readonly reason: InspectionReason;

  constructor(reason: InspectionReason, label = 'Unsafe Office document') {
    // Carry only a fixed code through the worker's standard Error serialisation.
    super(label, { cause: { reason } });
    this.reason = reason;
  }
}

export function inspectionReason(error: unknown): InspectionReason {
  if (error instanceof Error) {
    const cause = inspectionCause.safeParse(error.cause);
    if (cause.success) return cause.data.reason;
  }
  return 'invalid_file';
}
