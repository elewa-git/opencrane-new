// Owner decision, 2 October 2026: choose for the task, then keep optimising.
// Refine these rows from measured task success, latency and spend; no inferred router.
export const taskRouting = {
  chat_turn: { model: 'gpt-6.1-sol', reason: 'Complex tasks that also need to manage time and cost' },
  ambiguous_problem: { model: 'gpt-6-astra', reason: 'Ambiguous problems needing broad context' },
  deep_analysis: { model: 'gpt-6-astra', reason: 'Demanding analysis with exacting requirements' },
  ambitious_deliverable: { model: 'gpt-6-astra', reason: 'Ambitious projects needing complete results' },
  scoped_task: { model: 'gpt-6-luna', reason: 'Well-scoped problem-solving' },
  triage: { model: 'gpt-6-luna', reason: 'Prioritising work with clear constraints' },
  frequent_automation: { model: 'gpt-6-luna', reason: 'Frequent automation' },
  conversation_title: { model: 'gpt-6-luna', reason: 'Short conversation titles' },
  classify_upload: { model: 'gpt-6-luna', reason: 'Simple data extraction and classification' },
  summary: { model: 'gpt-6-luna', reason: 'Scoped summaries' },
} as const;
export type TaskKind = keyof typeof taskRouting;
export function modelForTask(task: string): string {
  const route = Object.entries(taskRouting).find(([kind]) => kind === task)?.[1];
  if (!route) throw new Error('Unknown task kind');
  return route.model;
}
