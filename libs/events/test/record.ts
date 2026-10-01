export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected a record');
  }
  return Object.fromEntries(Object.entries(value));
}
