import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { database } from '@opencrane/projections/testing';
import { rebuildBudgetProjection } from '@opencrane/models';
import { logger } from '../../libs/handlers/test/helpers.ts';
import { seedRecoveryBudgets, expectRecoveryMoney } from './upgrade-recovery-budget-fixture.ts';
import { collectBudgetRecovery, checkBudgetRecovery } from './upgrade-recovery-budget.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let postgres: Awaited<ReturnType<typeof database>>;
let before: Awaited<ReturnType<typeof collectBudgetRecovery>>;
let sequence: number;
async function initialise() {
  nats = await natsFixture();
  postgres = await database('pg');
  const ids = await seedRecoveryBudgets(nats);
  sequence = await nats.reader.head();
  await rebuildBudgetProjection(postgres.db, nats.reader, logger);
  await expectRecoveryMoney(postgres.db, sequence, ids);
  before = await collectBudgetRecovery(postgres.db);
}
async function reset() {
  await postgres.db.query(`UPDATE projection_checkpoints SET sequence = $1
    WHERE name = 'model-budgets'`, [sequence]);
  await rebuildBudgetProjection(postgres.db, nats.reader, logger);
}
async function close() {
  await postgres?.close();
  await nats?.close();
}
beforeAll(initialise);
beforeEach(reset);
afterAll(close);

const corruptions = [
  ['held amount', 'UPDATE model_budget_calls SET held_cents = held_cents + 1'],
  ['missing settlement', "DELETE FROM model_budget_effects WHERE type = 'effect.resolved'"],
  ['current effect state', `UPDATE model_current_effects
    SET data = jsonb_set(data, '{state}', '"released"')`],
  ['lost reservation', 'DELETE FROM model_budget_calls WHERE held_cents = 120'],
  ['duplicated effect', `INSERT INTO model_budget_effects
    SELECT silo, event_id || '-duplicate', permit_id, position, time, type, outcome,
      cost_cents, settled_cents, resolved_by, change_ref FROM model_budget_effects`],
  ['budget totals', "UPDATE model_budgets SET state = jsonb_set(state, '{ceilingCents}', '1')"],
  ['reservation identity', "UPDATE model_budget_calls SET reservation_id = 'changed-' || reservation_id"],
  ['permit identity', "UPDATE model_budget_calls SET permit_id = 'changed-' || permit_id"],
  ['ahead checkpoint', `UPDATE projection_checkpoints SET sequence = sequence + 1
    WHERE name = 'model-budgets'`],
] as const;
async function refusesCorruption(_name: string, sql: string) {
  // Change stored rows before collecting them; never substitute a precomputed digest.
  await postgres.db.query(sql);
  const after = await collectBudgetRecovery(postgres.db);
  function compare() { checkBudgetRecovery(before, after, sequence); }
  expect(compare).toThrow('Budget recovery comparison refused');
}
it.each(corruptions)('refuses changed %s', refusesCorruption);

async function acceptsUnchangedRows() {
  const after = await collectBudgetRecovery(postgres.db);
  expect(after).toEqual(before);
  checkBudgetRecovery(before, after, sequence);
}
it('accepts all four unchanged tables and their checkpoint', acceptsUnchangedRows);

async function refusesMatchingAheadCheckpoints() {
  await postgres.db.query(`UPDATE projection_checkpoints SET sequence = sequence + 1
    WHERE name = 'model-budgets'`);
  const ahead = await collectBudgetRecovery(postgres.db);
  function compare() { checkBudgetRecovery(ahead, ahead, sequence); }
  expect(compare).toThrow('Budget recovery comparison refused');
}
it('refuses matching checkpoints ahead of the checked archive', refusesMatchingAheadCheckpoints);
