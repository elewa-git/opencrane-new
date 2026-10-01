// One generated test per event type (69 of them): its own example must
// pass its own schema, and the same example with one extra field must
// fail, because every data schema in the registry is `.strict()`. This is
// the blanket version of the security rule "extra fields are rejected
// everywhere" — it runs for every event, not only the risky ones (see
// security-rules.test.ts for the plaintext/secret-specific checks).
import { describe, expect, it } from 'vitest';
import { eventRegistry } from '../src/registry.ts';

describe('every event data schema, generated from the registry', () => {
  for (const entry of eventRegistry) {
    describe(entry.type, () => {
      it('accepts its own valid example', () => {
        const result = entry.dataSchema.safeParse(entry.example);
        expect(result.success).toBe(true);
      });

      it('rejects that example with one extra field added', () => {
        const withExtraField = { ...(entry.example as Record<string, unknown>), unexpectedField: 'nope' };
        const result = entry.dataSchema.safeParse(withExtraField);
        expect(result.success).toBe(false);
      });
    });
  }
});
