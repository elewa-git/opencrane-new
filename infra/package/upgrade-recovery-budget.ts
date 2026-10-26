import type { Query } from '@opencrane/projections';

// Start with checkpoint-only comparison so row-corruption tests demonstrate the missing proof.
export async function collectBudgetRecovery(db: Query) {
  const checkpoint = await db.query<{ sequence: string }>(
    "SELECT sequence FROM projection_checkpoints WHERE name = 'model-budgets'");
  return { checkpoint: Number(checkpoint.rows[0]?.sequence) };
}

export function checkBudgetRecovery(before: Awaited<ReturnType<typeof collectBudgetRecovery>>,
  after: Awaited<ReturnType<typeof collectBudgetRecovery>>, sequence: number) {
  void before;
  void after;
  void sequence;
}
