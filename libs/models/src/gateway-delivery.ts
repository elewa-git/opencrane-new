import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import type { Db } from '@opencrane/projections';
import { gatewayConfigurationSchema, gatewayObservationSchema } from '@opencrane/events';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { z } from 'zod';
import { envelope, history } from './actor.ts';
import { publicationDigest } from './publication.ts';
import { toolPolicyFromRows } from './tool-policy.ts';
import { gatewayConfigurationCurrent, gatewayMemberCurrent } from './gateway-generation.ts';
import { renderGatewayConfiguration, type GatewayRenderSettings } from './gateway-renderer.ts';

type Configuration = ReturnType<typeof gatewayConfigurationSchema.parse>;
export type GatewayAcknowledgement = Pick<Configuration, 'generation' | 'recordDigest' | 'members'> &
  { position: number };
const configuration = z.looseObject({
  gateways: z.record(z.string(), z.unknown()), routes: z.array(z.unknown()),
});

async function replaceConfiguration(file: string, config: unknown,
  replace: (sibling: string) => Promise<void>) {
  const sibling = `${file}.${randomUUID()}.next`;
  try {
    await writeFile(sibling, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    await replace(sibling);
  } finally {
    await rm(sibling, { force: true });
  }
}

export function gatewayDelivery(options: {
  store: Pick<EventStore, 'append' | 'head' | 'readEvent' | 'readStream'>;
  db: Db; silo: string; child: ChildProcess; configFile: string; controlPort: number;
  settings: GatewayRenderSettings; mode: 'live' | 'replay';
  requireLeader?: () => Promise<void>;
}) {
  const processRef = randomUUID();
  const subject = `gateway-config-${options.silo}`;
  let active: { record: Configuration; configDigest: string; response: string; path: string } | null = null;
  let writing = false;
  let closed = false;
  let observation: GatewayAcknowledgement | null = null;

  async function requireLeader() {
    await options.requireLeader?.();
  }

  function alive() {
    return !closed && options.child.pid !== undefined && options.child.exitCode === null &&
      options.child.signalCode === null && !options.child.killed;
  }

  async function deliver(input: Configuration) {
    if (options.mode === 'replay') return;
    if (writing || !alive()) throw new Error('Gateway delivery unavailable');
    writing = true;
    observation = null;
    active = null;
    try {
      const record = gatewayConfigurationSchema.parse(input);
      if (!await gatewayConfigurationCurrent(options.store, options.silo, record)) {
        throw new Error('Gateway delivery unavailable');
      }
      const rendered = renderGatewayConfiguration(record, options.settings);
      const parsed: unknown = JSON.parse(rendered.configBytes.toString('utf8'));
      const config = configuration.parse(parsed);
      const identity = { generation: record.generation, recordDigest: record.recordDigest,
        configDigest: rendered.configDigest, processRef };
      const response = JSON.stringify(identity);
      const path = `/configuration/${record.generation}/${processRef}`;
      // Keep process identity outside the repeatable configuration digest.
      config.gateways['control'] = { port: z.int().min(1).max(65535).parse(options.controlPort) };
      const controlRoute = { name: 'configuration', gateways: 'control',
        matches: [{ path: { exact: path }, method: 'GET' }],
        policies: { authorization: { rules: ['source.address == "127.0.0.1"'] },
          directResponse: { status: 200, body: response } } };
      config.routes.push(controlRoute);
      async function replace(sibling: string) {
        await requireLeader();
        if (!options.db.lock) throw new Error('Gateway locking unavailable');
        async function replaceLatest(locked: Db) {
          if (!await gatewayConfigurationCurrent(options.store, options.silo, record)) {
            throw new Error('Gateway delivery unavailable');
          }
          await requireLeader();
          // Recheck after leadership waits. Hold preparation until the rename finishes.
          if (!await gatewayConfigurationCurrent(options.store, options.silo, record)) {
            throw new Error('Gateway delivery unavailable');
          }
          // Check the gateway lock connection after all other waits. Budget leadership
          // uses a different session and cannot prove this lock is still held.
          const checkOptions = { deadline: performance.now() + 1000 };
          await locked.query('SELECT 1', [], checkOptions);
          if (!alive()) throw new Error('Gateway delivery unavailable');
          // Avoid yielding between the final check and the atomic file replacement.
          renameSync(sibling, options.configFile);
        }
        const lockOptions = { timeoutMs: 1000 };
        await options.db.lock(`gateway-configuration:${options.silo}`, replaceLatest, lockOptions);
      }
      await replaceConfiguration(options.configFile, config, replace);
      active = { record, configDigest: rendered.configDigest, response, path };
    } catch {
      throw new Error('Gateway delivery unavailable');
    } finally {
      writing = false;
    }
  }

  function usable(delivered: typeof active) {
    return options.mode === 'live' && delivered !== null && active === delivered &&
      !writing && alive();
  }

  async function currentObservation(delivered: NonNullable<typeof active>, row: StoredEvent) {
    // Recheck after saving or recovering a receipt: its sources or child may have changed.
    const current = await gatewayConfigurationCurrent(options.store, options.silo, delivered.record);
    if (!current || !usable(delivered)) {
      return null;
    }
    for (const member of delivered.record.members) {
      if (!await saveMemberReceipt(delivered, member, row)) return null;
    }
    const stillCurrent = await gatewayConfigurationCurrent(options.store, options.silo,
      delivered.record);
    if (!stillCurrent || !usable(delivered)) return null;
    observation = { generation: delivered.record.generation,
      recordDigest: delivered.record.recordDigest, members: delivered.record.members,
      position: row.sequence };
    return row;
  }

  async function saveMemberReceipt(delivered: NonNullable<typeof active>,
    member: Configuration['members'][number], observation: StoredEvent) {
    const subject = `mcp-${member.entry.serverId}`;
    const deadline = performance.now() + 10_000;
    const expectedGlobalSequence = await options.store.head(undefined, deadline);
    const rows = await history(options.store, subject, options.silo, deadline);
    if (!gatewayMemberCurrent(rows, member)) return false;
    const operation = { serverId: member.entry.serverId, changeRef: member.changeRef,
      fragmentDigest: member.fragmentDigest };
    const id = `mcp-observed:${publicationDigest(operation)}`;
    const state = toolPolicyFromRows(rows);
    for (const row of rows) {
      if (row.event.id === id) {
        return state.configurationObservation?.changeRef === member.changeRef &&
          state.configurationObservation.fragmentDigest === member.fragmentDigest;
      }
    }
    const current = await gatewayConfigurationCurrent(options.store, options.silo, delivered.record);
    if (!current || !usable(delivered)) return false;
    const { outcome: _outcome, ...observed } = gatewayObservationSchema.parse(observation.event.data);
    const data = { ...operation, ...observed, reviewRevision: member.entry.reviewRevision,
      sourceSequence: member.sourceSequence };
    const event = envelope(options.silo, subject, 'mcp.configuration_observed', data, id);
    // Refuse withdrawal on this server and newer preparations on the gateway stream.
    const command = { event, expectedSequence: state.sequence, expectedGlobalSequence, deadline };
    await requireLeader();
    const result = await options.store.append(command);
    return result.status === 'appended';
  }

  async function probe() {
    const delivered = active;
    if (!delivered || !usable(delivered)) return null;
    try {
      await requireLeader();
      const url = `http://127.0.0.1:${options.controlPort}${delivered.path}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: 'error' });
      if (response.status !== 200 || await response.text() !== delivered.response) return null;
      const rows = await history(options.store, subject, options.silo);
      if (!await gatewayConfigurationCurrent(options.store, options.silo, delivered.record)) return null;
      if (!usable(delivered)) return null;
      const id = `gateway-observed:${delivered.record.recordDigest}:` +
        `${delivered.configDigest}:${processRef}`;
      for (const row of rows) {
        if (row.event.id === id) {
          return await currentObservation(delivered, row);
        }
      }
      const data = { generation: delivered.record.generation,
        recordDigest: delivered.record.recordDigest, configDigest: delivered.configDigest,
        processRef, outcome: 'loaded', observedAt: new Date().toISOString() };
      const event = envelope(options.silo, subject, 'gateway.configuration_observed', data, id);
      const command = { event, expectedSequence: rows.at(-1)?.sequence ?? 0 };
      await requireLeader();
      const result = await options.store.append(command);
      if (result.status !== 'appended' || !usable(delivered)) return null;
      const row = await options.store.readEvent(result.sequence);
      return await currentObservation(delivered, row);
    } catch {
      // Leave an uncertain append for the next exact probe to recover from saved history.
      return null;
    }
  }
  async function observe() {
    const row = await probe();
    if (!row) observation = null;
    return row;
  }
  function acknowledged() {
    if (!usable(active)) return null;
    return observation;
  }
  function close() {
    closed = true;
    observation = null;
  }
  return { deliver, observe, acknowledged, close };
}
