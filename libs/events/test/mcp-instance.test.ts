import { expect, it } from 'vitest';
import { parseEventByType } from '../src/index.ts';

const instanceId = 'f881c4329e9b65a9d225a3598a1f5a0f572307d8c8e1e3884528802df17f3523';
const start = {
  siloId: 'silo_1', userId: 'member_1', profileId: 'profile_1', serverId: 'server_1',
  startupAccessGeneration: 1, instanceId, connectionId: 'connection_1',
  imageDigest: 'a'.repeat(64), installGeneration: 1, upstreamBindingDigest: 'b'.repeat(64),
  workloadSpecDigest: 'c'.repeat(64), runGeneration: 1, changeRef: 'start_1',
  requestedAt: '2026-10-11T12:00:00Z', deadline: '2026-10-11T12:00:20Z',
};
const event = {
  id: 'event_1', type: 'mcp.instance_start_requested', source: 'opencrane-server',
  silo: 'silo_1', subject: `mcp-instance-${instanceId}`, time: start.requestedAt,
  data: start,
};

function checksStartupAccessGeneration() {
  const result = parseEventByType(event);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('Valid instance start was refused');
  expect(result.event.data).toEqual(start);

  const invalidGenerations = [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'];
  for (const startupAccessGeneration of invalidGenerations) {
    const data = { ...start, startupAccessGeneration };
    const invalid = { ...event, data };
    expect(parseEventByType(invalid).success).toBe(false);
  }
  const extraField = { ...start, credentialGeneration: 1 };
  const extra = { ...event, data: extraField };
  expect(parseEventByType(extra).success).toBe(false);
}

it('accepts only a positive integer startup access generation and no extra fields',
  checksStartupAccessGeneration);
