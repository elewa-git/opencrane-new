import { createHash } from 'node:crypto';
import { mcpInstanceStartSchema, mcpInstanceStopSchema,
  mcpInstanceObservedSchema, type EventEnvelope } from '@opencrane/events';
import type { Projection } from './runner.ts';

type Start = ReturnType<typeof mcpInstanceStartSchema.parse>;
const identitySchema = mcpInstanceStartSchema.pick({ siloId: true, userId: true,
  profileId: true, serverId: true, credentialGeneration: true });
export function mcpInstanceId(raw: unknown): string {
  const key = identitySchema.parse(raw);
  const fields = [key.siloId, key.userId, key.profileId, key.serverId, key.credentialGeneration];
  const hash = createHash('sha256');
  hash.update(JSON.stringify(fields));
  return hash.digest('hex');
}
export interface McpInstanceState {
  start: Start;
  sequence: number;
  phase: 'waking' | 'stopping' | 'sleeping' | 'unavailable' | 'unknown';
  podUid?: string;
  reason?: ReturnType<typeof mcpInstanceObservedSchema.parse>['reason'];
}
const types = new Set(['mcp.instance_start_requested', 'mcp.instance_stop_requested',
  'mcp.instance_observed']);

export function applyMcpInstance(current: McpInstanceState | undefined,
  event: EventEnvelope, sequence: number): McpInstanceState | undefined {
  if (!types.has(event.type)) return current;
  if (event.type === 'mcp.instance_start_requested') return applyStart(current, event, sequence);
  if (!current) throw new Error('Instance start missing');
  const schema = event.type === 'mcp.instance_observed'
    ? mcpInstanceObservedSchema : mcpInstanceStopSchema;
  const data = schema.parse(event.data);
  if (event.silo !== current.start.siloId ||
      event.subject !== `mcp-instance-${current.start.instanceId}` ||
      data.instanceId !== current.start.instanceId ||
      data.runGeneration !== current.start.runGeneration ||
      data.startChangeRef !== current.start.changeRef) {
    throw new Error('Instance run mismatch');
  }
  if (event.type === 'mcp.instance_stop_requested') {
    const stop = mcpInstanceStopSchema.parse(data);
    if (stop.requestedBy !== current.start.userId || stop.expectedSequence !== current.sequence) {
      throw new Error('Instance stop mismatch');
    }
    return { ...current, sequence, phase: 'stopping' };
  }
  return applyObservation(current, event, sequence);
}

function applyObservation(current: McpInstanceState, event: EventEnvelope,
  sequence: number): McpInstanceState {
  const observed = mcpInstanceObservedSchema.parse(event.data);
  if (observed.workloadSpecDigest !== current.start.workloadSpecDigest ||
      (current.podUid !== undefined && observed.podUid !== current.podUid)) {
    throw new Error('Instance workload mismatch');
  }
  if (observed.state === 'absent' && (current.phase !== 'stopping' || !current.podUid)) {
    throw new Error('Instance absence requires the original stopped Pod');
  }
  if (current.phase === 'sleeping') throw new Error('Instance run already absent');
  let phase: McpInstanceState['phase'] = current.phase;
  if (observed.state === 'failed') phase = 'unavailable';
  if (observed.state === 'unknown') phase = 'unknown';
  if (observed.state === 'stopping') phase = 'stopping';
  if (observed.state === 'absent') phase = 'sleeping';
  // Keep late starting reports from undoing stop or confirmed absence.
  return { ...current, sequence, phase, podUid: observed.podUid, reason: observed.reason };
}

function applyStart(current: McpInstanceState | undefined, event: EventEnvelope,
  sequence: number): McpInstanceState {
  const start = mcpInstanceStartSchema.parse(event.data);
  const identity = { siloId: start.siloId, userId: start.userId, profileId: start.profileId,
    serverId: start.serverId, credentialGeneration: start.credentialGeneration };
  const duration = Date.parse(start.deadline) - Date.parse(start.requestedAt);
  if (start.instanceId !== mcpInstanceId(identity) || event.silo !== start.siloId ||
      event.subject !== `mcp-instance-${start.instanceId}` || duration <= 0 || duration > 20_000) {
    throw new Error('Instance identity or deadline mismatch');
  }
  if (current) {
    const previous = current.start;
    if (current.phase !== 'sleeping' || start.runGeneration !== previous.runGeneration + 1 ||
        start.connectionId !== previous.connectionId || start.imageDigest !== previous.imageDigest ||
        start.installGeneration !== previous.installGeneration ||
        start.upstreamBindingDigest !== previous.upstreamBindingDigest ||
        start.changeRef === previous.changeRef) {
      throw new Error('Instance replacement mismatch');
    }
  } else if (start.runGeneration !== 1) {
    throw new Error('Initial instance run mismatch');
  }
  return { start, sequence, phase: 'waking' };
}

export const mcpInstances: Projection = {
  name: 'mcp instances',
  async create(db) {
    await db.query(`CREATE TABLE IF NOT EXISTS mcp_instances (
      silo TEXT NOT NULL, instance_id TEXT NOT NULL, state JSONB NOT NULL,
      PRIMARY KEY (silo, instance_id))`);
  },
  async drop(db) {
    await db.query('DROP TABLE IF EXISTS mcp_instances');
  },
  async apply(db, event, sequence) {
    if (!types.has(event.type)) return;
    const instanceId = event.subject.slice('mcp-instance-'.length);
    const saved = await db.query<{ state: McpInstanceState }>(
      'SELECT state FROM mcp_instances WHERE silo=$1 AND instance_id=$2', [event.silo, instanceId]);
    const state = applyMcpInstance(saved.rows[0]?.state, event, sequence);
    await db.query(`INSERT INTO mcp_instances VALUES ($1,$2,$3)
      ON CONFLICT (silo, instance_id) DO UPDATE SET state=$3`,
    [event.silo, instanceId, JSON.stringify(state)]);
  },
};
