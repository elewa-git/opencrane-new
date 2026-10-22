import { expect, it } from 'vitest';
import { getEventDefinition, toolDispatchRecordedDataSchema } from '../src/index.ts';

const definition = getEventDefinition('tool.dispatch_recorded')!;
const example = toolDispatchRecordedDataSchema.parse(definition.example);
const adapter = { decisionId: '00000000-0000-4000-8000-000000000001',
  startId: '00000000-0000-4000-8000-000000000001:tool-dispatch-started',
  connectionId: 'installed', generation: 1, recordDigest: 'a'.repeat(64), reviewRevision: 1 };

function checksAdapterEvidence() {
  const response = { ...example, outcome: 'responded', evidence: 'adapter_response_received',
    adapter };
  expect(toolDispatchRecordedDataSchema.safeParse(response).success).toBe(true);
  const unknown = { ...response, outcome: 'outcome_unknown', evidence: 'adapter_transport_uncertain' };
  expect(toolDispatchRecordedDataSchema.safeParse(unknown).success).toBe(true);
  const invalid = [
    { ...response, adapter: undefined }, { ...response, outcome: 'not_dispatched' },
    { ...unknown, outcome: 'responded' }, { ...example, adapter },
    { ...response, adapter: { ...adapter, generation: 0 } },
    { ...response, adapter: { ...adapter, startId: 'unrelated' } },
    { ...response, requestId: '00000000-0000-4000-8000-000000000002' },
    { ...response, adapter: { ...adapter, url: 'https://external.example.test' } },
  ];
  for (const value of invalid) {
    expect(toolDispatchRecordedDataSchema.safeParse(value).success).toBe(false);
  }
}
it('requires strict adapter bindings and matching remote outcomes', checksAdapterEvidence);

function checksUnsentAdapterEvidence() {
  const refused = { ...example, outcome: 'not_dispatched',
    evidence: 'adapter_dispatch_refused', adapter };
  expect(toolDispatchRecordedDataSchema.safeParse(refused).success).toBe(true);
  const invalid = [
    { ...refused, adapter: undefined },
    { ...refused, outcome: 'responded' },
    { ...refused, outcome: 'outcome_unknown' },
    { ...refused, requestId: '00000000-0000-4000-8000-000000000002' },
  ];
  for (const value of invalid) {
    expect(toolDispatchRecordedDataSchema.safeParse(value).success).toBe(false);
  }
}
it('binds proved remote non-dispatch to the original start', checksUnsentAdapterEvidence);
