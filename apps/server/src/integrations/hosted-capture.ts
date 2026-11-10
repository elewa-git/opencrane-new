import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { hostedImageCheckedSchema, mcpHostedRunSchema, mcpHostedStartObservedSchema,
  mcpServerDiscoveredDataSchema } from '@opencrane/events';
import { envelope, foldHostedAdmission, history, toolPolicyFromRows } from '@opencrane/models';
import { z } from 'zod';
import { discoverInventory } from './inventory.ts';

type HostedRun = z.infer<typeof mcpHostedRunSchema>;
type Method = 'server/discover' | 'tools/list';
type Catalogue = z.infer<typeof mcpServerDiscoveredDataSchema>;
type ImageChecks = z.infer<typeof hostedImageCheckedSchema>['checks'];

// Only the trusted worker supplies this transport. Its observe call reads the current
// owned workload; its request call uses the checked discovery route through the gateway.
export interface HostedCaptureTransport {
  observe(signal: AbortSignal): Promise<HostedRun>;
  request(method: Method, cursor: string | undefined, signal: AbortSignal): Promise<string>;
}

const registrationSchema = z.object({ serverId: z.string(), kind: z.literal('hosted'),
  locator: z.string(), installation: z.object({ platform: z.string() }),
  credentialContract: z.unknown().optional() });

function sameRun(first: HostedRun, second: HostedRun) {
  return JSON.stringify(first) === JSON.stringify(second);
}

function savedStart(rows: StoredEvent[], startId: string) {
  function matches(row: StoredEvent) {
    return row.event.type === 'mcp.hosted_start_observed' &&
      row.event.commandId === startId;
  }
  return rows.findLast(matches);
}

function capturedCatalogue(rows: StoredEvent[], captureId: string, run: HostedRun) {
  function matches(row: StoredEvent) {
    return row.event.commandId === captureId &&
      (row.event.type === 'mcp.server_discovered' || row.event.type === 'mcp.tools_changed');
  }
  const saved = rows.findLast(matches);
  if (!saved) {
    return;
  }
  if (saved.event.source !== 'models' || saved.event.principal?.kind !== 'system' ||
      saved.event.principal.id !== 'models') {
    throw new Error('Hosted catalogue source unavailable');
  }
  const data = z.record(z.string(), z.unknown()).parse(saved.event.data);
  const raw = saved.event.type === 'mcp.tools_changed' ? data['catalogue'] : data;
  const catalogue = mcpServerDiscoveredDataSchema.parse(raw);
  if (!catalogue.hostedRun || !sameRun(catalogue.hostedRun, run)) {
    throw new Error('Hosted catalogue belongs to another run');
  }
  return catalogue;
}

function requireAdmission(rows: StoredEvent[], silo: string, serverId: string, run: HostedRun) {
  const first = rows[0];
  const registered = registrationSchema.safeParse(first?.event.data);
  if (!first || first.event.type !== 'mcp.server_registered' || !registered.success ||
      registered.data.serverId !== serverId || registered.data.credentialContract !== undefined ||
      registered.data.installation.platform !== run.platform ||
      !registered.data.locator.endsWith(`@sha256:${run.imageDigest}`)) {
    throw new Error('Hosted registration unavailable');
  }
  const admission = foldHostedAdmission(rows, silo, serverId);
  if (!admission || admission.status !== 'admitted' ||
      admission.imageDigest !== run.imageDigest || admission.platform !== run.platform ||
      !admission.checks) {
    throw new Error('Hosted image admission unavailable');
  }
  return earliestAdmissionExpiry(admission.checks);
}

function earliestAdmissionExpiry(checks: ImageChecks) {
  let expiresAt = Infinity;
  for (const check of Object.values(checks)) {
    if (check.verdict !== 'pass') {
      throw new Error('Hosted image admission unavailable');
    }
    expiresAt = Math.min(expiresAt, Date.parse(check.expiresAt));
    if ('databaseUpdatedAt' in check) {
      expiresAt = Math.min(expiresAt, Date.parse(check.databaseUpdatedAt) + 86_400_000);
    }
  }
  return new Date(expiresAt).toISOString();
}

async function readRows(store: EventStore, silo: string, serverId: string) {
  return history(store, `mcp-${serverId}`, silo, performance.now() + 10_000);
}

function checkedIdentity(observed: HostedRun, expected: HostedRun) {
  const checked = mcpHostedRunSchema.parse(observed);
  if (!sameRun(checked, expected)) {
    throw new Error('Hosted workload changed');
  }
}

async function appendStart(store: EventStore, silo: string, serverId: string,
  run: HostedRun, rows: StoredEvent[], startId: string, admissionExpiresAt: string) {
  const prior = savedStart(rows, startId);
  if (prior) {
    const saved = mcpHostedStartObservedSchema.parse(prior.event.data);
    const { serverId: savedServerId, admissionExpiresAt: _admissionExpiresAt,
      ...savedRun } = saved;
    const current = toolPolicyFromRows(rows);
    if (savedServerId !== serverId || !sameRun(savedRun, run) ||
        !current.hostedRun || !sameRun(current.hostedRun, run)) {
      throw new Error('Hosted start identity changed');
    }
    return prior.sequence;
  }
  const policy = toolPolicyFromRows(rows);
  if (policy.hostedRun && run.runGeneration <= policy.hostedRun.runGeneration) {
    throw new Error('Hosted run generation did not advance');
  }
  const data = { serverId, ...run, admissionExpiresAt };
  const event = envelope(silo, `mcp-${serverId}`, 'mcp.hosted_start_observed', data, startId);
  event.source = 'models';
  event.principal = { kind: 'system', id: 'models' };
  try {
    const result = await store.append({ event, expectedSequence: policy.sequence });
    if (result.status === 'appended') {
      return result.sequence;
    }
  } catch {
    // Read the original command after an uncertain reply; never issue a second start.
  }
  const recovered = await readRows(store, silo, serverId);
  const saved = savedStart(recovered, startId);
  const parsed = mcpHostedStartObservedSchema.safeParse(saved?.event.data);
  if (!saved || !parsed.success || parsed.data.serverId !== serverId) {
    throw new Error('Hosted start outcome unknown');
  }
  const { serverId: _savedServerId, admissionExpiresAt: _admissionExpiresAt,
    ...savedRun } = parsed.data;
  if (!sameRun(savedRun, run)) {
    throw new Error('Hosted start outcome unknown');
  }
  return saved.sequence;
}

async function appendCatalogue(store: EventStore, silo: string, serverId: string,
  run: HostedRun, catalogue: Catalogue, startSequence: number, captureId: string) {
  const rows = await readRows(store, silo, serverId);
  requireAdmission(rows, silo, serverId, run);
  const prior = capturedCatalogue(rows, captureId, run);
  if (prior) {
    return prior;
  }
  const policy = toolPolicyFromRows(rows);
  if (policy.sequence !== startSequence || !policy.hostedRun ||
      !sameRun(policy.hostedRun, run)) {
    throw new Error('Hosted start changed during capture');
  }
  let type = 'mcp.server_discovered';
  let data: unknown = catalogue;
  if (policy.catalogue && policy.catalogue.schemaDigest !== catalogue.schemaDigest) {
    type = 'mcp.tools_changed';
    data = { serverId, previousSchemaDigest: policy.catalogue.schemaDigest,
      newSchemaDigest: catalogue.schemaDigest, catalogue };
  }
  const event = envelope(silo, `mcp-${serverId}`, type, data, captureId);
  event.source = 'models';
  event.principal = { kind: 'system', id: 'models' };
  try {
    const result = await store.append({ event, expectedSequence: startSequence });
    if (result.status === 'appended') {
      return catalogue;
    }
  } catch {
    // Recover only the original saved capture. A different append leaves access closed.
  }
  const recovered = await readRows(store, silo, serverId);
  const saved = capturedCatalogue(recovered, captureId, run);
  if (!saved || saved.schemaDigest !== catalogue.schemaDigest) {
    throw new Error('Hosted catalogue outcome unknown');
  }
  return saved;
}

async function capture(store: EventStore, silo: string, serverId: string,
  rawRun: unknown, transport: HostedCaptureTransport) {
  const run = mcpHostedRunSchema.parse(rawRun);
  const signal = AbortSignal.timeout(30_000);
  const rows = await readRows(store, silo, serverId);
  const admissionExpiresAt = requireAdmission(rows, silo, serverId, run);
  checkedIdentity(await transport.observe(signal), run);
  const current = toolPolicyFromRows(rows);
  if (current.hostedRun && !sameRun(current.hostedRun, run) &&
      run.runGeneration <= current.hostedRun.runGeneration) {
    throw new Error('Hosted run was replaced');
  }
  const startId = `hosted-start-${run.runGeneration}`;
  const captureId = `${startId}-catalogue`;
  const previous = capturedCatalogue(rows, captureId, run);
  if (previous) {
    return { schemaDigest: previous.schemaDigest };
  }
  const startSequence = await appendStart(store, silo, serverId, run, rows, startId,
    admissionExpiresAt);
  async function request(method: Method, cursor?: string) {
    signal.throwIfAborted();
    return transport.request(method, cursor, signal);
  }
  const inventory = await discoverInventory(request);
  checkedIdentity(await transport.observe(signal), run);
  signal.throwIfAborted();
  const catalogue = { serverId, ...inventory, hostedRun: run,
    connectionId: `installed-${serverId}`, accountMode: 'none' as const };
  const saved = await appendCatalogue(store, silo, serverId, run, catalogue,
    startSequence, captureId);
  return { schemaDigest: saved.schemaDigest };
}

export async function captureHostedStart(store: EventStore, silo: string, serverId: string,
  run: unknown, transport: HostedCaptureTransport) {
  try {
    return await capture(store, silo, serverId, run, transport);
  } catch {
    // Do not pass a tool reply, workload error or parser detail to logs or callers.
    throw new Error('Hosted catalogue capture unavailable');
  }
}
