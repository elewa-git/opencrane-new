import { z } from 'zod';
import { parseEventByType, providerBindingSchema, providerDrainSchema, providerRetiredSchema,
  type EventEnvelope } from '@opencrane/events';
import type { Projection } from './runner.ts';
import type { Query } from './db.ts';

interface ProviderFact {
  changeId: string;
  time: string;
  revision: number;
  outcome: string;
  attemptId?: string | undefined;
  model?: string | undefined;
  reservationId?: string | undefined;
  reservedCents?: number | undefined;
  settledCents?: number | undefined;
}
export interface ProviderState {
  providerId: string;
  provider: 'openai' | 'anthropic';
  name: string;
  revision: number;
  position: number;
  secretRef?: string;
  saved?: ProviderFact;
  reachable?: ProviderFact | undefined;
  modelAnswer?: ProviderFact | undefined;
  lastReachable?: ProviderFact | undefined;
  lastModelAnswer?: ProviderFact | undefined;
  enabledModels: string[];
  modelsChanged?: ProviderFact;
  managedCallsEnabled?: true;
  managedCallsDraining?: boolean;
  retired?: ProviderFact & { choices: z.infer<typeof providerRetiredSchema>['choices'] };
}
export function applyProvider(state: ProviderState | undefined,
  event: EventEnvelope, position: number): ProviderState {
  if (!parseEventByType(event).success) {
    throw new Error('Invalid provider event');
  }
  const data = z.record(z.string(), z.unknown()).parse(event.data);
  const providerId = z.string().parse(data['providerId']);
  requireProviderSubject(event, providerId);
  const revision = z.int().positive().parse(data['revision']);
  if (event.type === 'provider.created') {
    if (state || revision !== 1) {
      throw new Error('Invalid provider creation');
    }
    return { providerId, provider: z.enum(['openai', 'anthropic']).parse(data['provider']),
      name: z.string().parse(data['name']), revision, position, enabledModels: [] };
  }
  if (!state || state.providerId !== providerId) {
    throw new Error('Missing provider');
  }
  requireOpenForChange(state, event);
  if (event.type === 'provider.retired') {
    return retireProvider(state, event, revision, position);
  }
  if (applyRoutingChange(state, event, revision, position)) {
    return state;
  }
  const fact: ProviderFact = { changeId: event.id, time: event.time, revision,
    outcome: z.string().optional().parse(data['outcome']) ??
      (event.type.startsWith('provider.verification_') ? 'outcome_unknown' : 'recorded') };
  if (event.type === 'provider.key_saved' || event.type === 'provider.models_selected') {
    if (revision !== state.revision + 1) {
      throw new Error('Invalid configuration revision');
    }
    state.revision = revision;
    if (event.type === 'provider.key_saved') {
      state.reachable = undefined;
      state.modelAnswer = undefined;
      state.lastReachable = undefined;
      state.lastModelAnswer = undefined;
      state.secretRef = z.string().parse(data['secretRef']);
      state.saved = fact;
    } else {
      state.enabledModels = z.array(z.string()).parse(data['models']);
      state.modelsChanged = fact;
    }
  } else {
    applyVerification(state, data, fact);
  }
  state.position = position;
  return state;
}
function requireOpenForChange(state: ProviderState, event: EventEnvelope) {
  if (state.retired && event.type !== 'provider.verification_recorded') {
    throw new Error('Retired provider cannot change');
  }
}
function retireProvider(state: ProviderState, event: EventEnvelope,
  revision: number, position: number) {
  const retirement = providerRetiredSchema.parse(event.data);
  if (revision !== state.revision) {
    throw new Error('Invalid retirement revision');
  }
  state.retired = { changeId: event.id, time: event.time, revision,
    outcome: 'recorded', choices: retirement.choices };
  state.position = position;
  return state;
}
function requireProviderSubject(event: EventEnvelope, providerId: string) {
  let expectedSubject = `provider-${providerId}`;
  if (event.type === 'provider.managed_calls_enabled') {
    expectedSubject = `budget-${event.silo}`;
  }
  if (event.subject !== expectedSubject) {
    throw new Error('Provider subject mismatch');
  }
}
function applyVerification(state: ProviderState, data: Record<string, unknown>,
  fact: ProviderFact) {
  fact.attemptId = z.string().optional().parse(data['attemptId']);
  const kind = z.enum(['reachability', 'model']).parse(data['kind']);
  const current = kind === 'reachability' ? state.reachable : state.modelAnswer;
  // A late result can complete the same attempt after model selection.
  // Rotation or a newer attempt prevents old evidence from replacing current-key facts.
  if (fact.revision < state.revision && current?.attemptId !== fact.attemptId) {
    return;
  }
  if (fact.revision > state.revision) {
    throw new Error('Future verification revision');
  }
  fact.model = z.string().optional().parse(data['model']);
  fact.reservationId = z.string().optional().parse(data['reservationId']);
  fact.reservedCents = z.int().optional().parse(data['reservedCents']);
  fact.settledCents = z.int().optional().parse(data['settledCents']);
  if (kind === 'reachability') {
    state.reachable = fact;
  } else {
    state.modelAnswer = fact;
  }
  if (fact.outcome === 'pass') {
    if (kind === 'reachability') {
      state.lastReachable = fact;
    } else {
      state.lastModelAnswer = fact;
    }
  }
}
function providerProjection(name: string): Projection {
  const bindings = name === 'providers' ? 'model_bindings' : 'model_bindings_replay';
  return { name, create, drop, apply };
  async function create(db: Query) {
    await db.query(`CREATE TABLE IF NOT EXISTS ${bindings}
      (silo TEXT NOT NULL, kind TEXT NOT NULL, dependant_id TEXT NOT NULL,
      task TEXT NOT NULL, state JSONB NOT NULL, PRIMARY KEY (silo, kind, dependant_id, task))`);
    await db.query(`CREATE TABLE IF NOT EXISTS ${name}
      (silo TEXT NOT NULL, provider_id TEXT NOT NULL, state JSONB NOT NULL,
      PRIMARY KEY (silo, provider_id))`);
  }
  async function drop(db: Query) {
    await db.query(`DROP TABLE IF EXISTS ${bindings}`);
    await db.query(`DROP TABLE IF EXISTS ${name}`);
  }
  async function apply(db: Query, event: EventEnvelope, position: number) {
    if (!event.type.startsWith('provider.')) {
      return;
    }
    const data = z.object({ providerId: z.string() }).parse(event.data);
    const values = [event.silo, data.providerId];
    const existing = await db.query<{ state: ProviderState }>(
      `SELECT state FROM ${name} WHERE silo = $1 AND provider_id = $2`, values);
    const state = applyProvider(existing.rows[0]?.state, event, position);
    if (event.type === 'provider.model_binding_set') {
      const choice = providerBindingSchema.parse(event.data);
      const saved = { ...choice, position };
      await db.query(`INSERT INTO ${bindings} VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (silo, kind, dependant_id, task) DO UPDATE SET state = EXCLUDED.state`,
      [event.silo, choice.kind, choice.dependantId, choice.task, JSON.stringify(saved)]);
    }
    if (event.type === 'provider.retired') {
      const retirement = providerRetiredSchema.parse(event.data);
      for (const choice of retirement.choices) {
        const key = [event.silo, choice.kind, choice.dependantId, choice.task];
        const previous = await db.query<{ state: { providerId: string; model: string;
          state: string; position: number } }>(`SELECT state FROM ${bindings} WHERE silo = $1 AND kind = $2
          AND dependant_id = $3 AND task = $4`, key);
        const binding = previous.rows[0]?.state;
        if (!binding || binding.providerId !== choice.old.providerId ||
          binding.model !== choice.old.model || binding.state !== choice.old.state ||
          binding.position !== choice.old.bindingSequence) {
          throw new Error('Retirement binding changed');
        }
        const saved = retirementBinding(retirement, choice, position);
        await db.query(`UPDATE ${bindings} SET state = $5 WHERE silo = $1 AND kind = $2
          AND dependant_id = $3 AND task = $4`, [...key, JSON.stringify(saved)]);
      }
    }
    await db.query(`INSERT INTO ${name} VALUES ($1, $2, $3)
      ON CONFLICT (silo, provider_id) DO UPDATE SET state = EXCLUDED.state`,
    [...values, JSON.stringify(state)]);
  }
}
export const providers = providerProjection('providers');
export const replayProviders = providerProjection('providers_replay');
export function retirementBinding(retirement: z.infer<typeof providerRetiredSchema>,
  choice: z.infer<typeof providerRetiredSchema>['choices'][number], position: number) {
  const next = choice.next;
  const providerId = next.state === 'active' ? next.providerId : choice.old.providerId;
  const revision = next.state === 'active' ? next.revision : retirement.revision;
  const reason = next.state === 'paused'
    ? { reason: 'Paused by an administrator' as const } : {};
  return { providerId, revision, changedBy: retirement.changedBy,
    kind: choice.kind, dependantId: choice.dependantId, task: choice.task,
    expectedProviderSequence: retirement.expectedProviderSequence,
    previousBindingSequence: choice.old.bindingSequence, state: next.state,
    model: next.model, position, ...reason };
}
export async function readProviders(db: Query, silo: string, providerId?: string) {
  let sql = 'SELECT state FROM providers WHERE silo = $1';
  const parameters = [silo];
  if (providerId) {
    sql += ' AND provider_id = $2';
    parameters.push(providerId);
  }
  sql += ' ORDER BY provider_id';
  const result = await db.query<{ state: ProviderState }>(sql, parameters);
  function publicState(row: { state: ProviderState }) {
    const { secretRef: _secretRef, ...state } = row.state;
    return state;
  }
  return result.rows.map(publicState);
}

function applyRoutingChange(state: ProviderState, event: EventEnvelope, revision: number,
  position: number) {
  const type = event.type;
  const routingTypes = ['provider.model_binding_set', 'provider.managed_calls_enabled',
    'provider.managed_calls_drain_set'];
  if (!routingTypes.includes(type)) {
    return false;
  }
  if (revision !== state.revision) {
    throw new Error('Invalid binding configuration revision');
  }
  if (type === 'provider.managed_calls_enabled') {
    state.managedCallsEnabled = true;
    state.managedCallsDraining = false;
    // Keep the provider position on its own stream for later configuration commands.
    return true;
  }
  if (type === 'provider.managed_calls_drain_set') {
    const data = providerDrainSchema.parse(event.data);
    state.managedCallsDraining = data.draining;
  }
  state.position = position;
  return true;
}
