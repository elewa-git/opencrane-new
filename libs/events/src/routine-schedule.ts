interface LocalOccurrence {
  occurrenceId: string;
  localDate: string;
  localTime: string;
  zone: string;
  checkAt: string;
}

type RoutineOccurrence = LocalOccurrence & (
  | { status: 'scheduled'; at: string; offsetMinutes: number; repeated: boolean }
  | { status: 'dst_skip'; at: null; offsetMinutes: null; repeated: false }
);

export function calculateRoutineOccurrence(_input: unknown): RoutineOccurrence {
  throw new Error('Routine occurrence calculation is not implemented');
}

export function previewRoutineOccurrences(_input: unknown): RoutineOccurrence[] {
  throw new Error('Routine preview is not implemented');
}
