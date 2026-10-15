import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { EventStore } from '@opencrane/event-store';
import { mcpInstanceStopSchema, type EventEnvelope } from '@opencrane/events';
import { registerHandler } from '@opencrane/handlers';
import { envelope, history } from '@opencrane/models';
import { applyMcpInstance, type McpInstanceState } from '@opencrane/projections';
import type { McpKubernetes } from './mcp-kubernetes.ts';

async function currentStop(store: EventStore, silo: string, trigger: EventEnvelope) {
  const parsed = mcpInstanceStopSchema.safeParse(trigger.data);
  if (!parsed.success || trigger.silo !== silo || trigger.type !== 'mcp.instance_stop_requested' ||
      trigger.subject !== `mcp-instance-${parsed.data.instanceId}`) return;
  try {
    const rows = await history(store, trigger.subject, silo, performance.now() + 10_000);
    let state: McpInstanceState | undefined;
    let saved = false;
    for (const row of rows) {
      state = applyMcpInstance(state, row.event, row.sequence);
      if (row.event.type === 'mcp.instance_stop_requested') {
        saved = isDeepStrictEqual(row.event, trigger);
      }
    }
    if (!saved || state?.phase !== 'stopping' || !state.podUid ||
        state.start.runGeneration !== parsed.data.runGeneration ||
        state.start.changeRef !== parsed.data.startChangeRef) return;
    return state;
  } catch {
    throw new Error('MCP instance history unavailable');
  }
}
export function stopMcpInstanceHandler(store: EventStore, silo: string, kube: McpKubernetes) {
  async function handle(trigger: EventEnvelope) {
    const state = await currentStop(store, silo, trigger);
    if (!state) return;
    await kube.stop(state, trigger.id);
    const hash = createHash('sha256');
    hash.update(JSON.stringify([silo, trigger.id]));
    const id = hash.digest('hex');
    for (let attempt = 0; attempt < 3; attempt++) {
      // Recheck the run after Kubernetes waits so a later start can never receive this absence.
      const current = await currentStop(store, silo, trigger);
      if (!current) return;
      const data = { instanceId: current.start.instanceId, runGeneration: current.start.runGeneration,
        startChangeRef: current.start.changeRef, workloadSpecDigest: current.start.workloadSpecDigest,
        podUid: current.podUid, state: 'absent', expectedSequence: current.sequence };
      const event = envelope(silo, trigger.subject, 'mcp.instance_observed', data, id);
      const command = { event, expectedSequence: current.sequence, historyChecked: true as const,
        deadline: performance.now() + 10_000 };
      const result = await store.append(command);
      if (result.status === 'appended') return;
      if (result.status !== 'conflict') throw new Error('MCP absence append unconfirmed');
    }
    throw new Error('MCP absence append conflicted');
  }
  return registerHandler('stop-mcp-instance', handle);
}
