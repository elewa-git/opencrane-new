import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Query } from '@opencrane/projections';

const sequenceSchema = z.number().int().nonnegative().safe();
const comparisonSchema = z.object({
  checkpoint: sequenceSchema,
  rowsDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type BudgetRecovery = z.infer<typeof comparisonSchema>;

/** Collect private comparison hashes with budget writers and effect workers stopped. */
export async function collectBudgetRecovery(db: Query): Promise<BudgetRecovery> {
  try {
    const options = { deadline: performance.now() + 60_000 };
    const checkpoint = await db.query<{ sequence: string }>(
      "SELECT sequence FROM projection_checkpoints WHERE name = 'model-budgets'", [], options);
    const hash = createHash('sha256');
    const tables = ['model_budgets', 'model_budget_calls',
      'model_budget_effects', 'model_current_effects'];
    for (const table of tables) {
      const result = await db.query(
        `SELECT * FROM ${table} AS entry ORDER BY to_jsonb(entry)::text COLLATE "C"`, [], options);
      hash.update(JSON.stringify([table, result.rows]));
    }
    const collected = { checkpoint: Number(checkpoint.rows[0]?.sequence),
      rowsDigest: hash.digest('hex') };
    return comparisonSchema.parse(collected);
  } catch {
    throw new Error('Budget recovery collection refused');
  }
}

export function checkBudgetRecovery(before: BudgetRecovery, after: BudgetRecovery,
  archiveSequence: number): void {
  try {
    const sequence = sequenceSchema.parse(archiveSequence);
    const expected = comparisonSchema.parse(before);
    const actual = comparisonSchema.parse(after);
    if (expected.checkpoint !== sequence || actual.checkpoint !== sequence ||
        !isDeepStrictEqual(expected, actual)) throw new Error();
  } catch {
    throw new Error('Budget recovery comparison refused');
  }
}
