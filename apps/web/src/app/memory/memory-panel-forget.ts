import type { PageFact } from './memory-panel-data';
import type { ForgetTarget } from './memory-forget';

export function withoutHiddenFactText(memoryId: string, facts: PageFact[],
  reason: string): PageFact[] {
  if (reason === 'forgotten') {
    return facts.filter(hasDifferentMemoryId.bind(null, memoryId));
  }
  return facts.map(clearFactText.bind(null, memoryId));
}

function clearFactText(memoryId: string, fact: PageFact): PageFact {
  if (fact.memoryId !== memoryId || 'reason' in fact) return fact;
  // Keep the row, but discard text that the server has quarantined or destroyed.
  return { ...fact, text: '' };
}

function hasDifferentMemoryId(memoryId: string, fact: PageFact): boolean {
  return fact.memoryId !== memoryId;
}

export function factIndex(memoryId: string, facts: PageFact[]): number {
  return facts.findIndex(hasMemoryId.bind(null, memoryId));
}

function hasMemoryId(memoryId: string, fact: PageFact): boolean {
  return fact.memoryId === memoryId;
}

export function withoutForgetTarget(target: ForgetTarget, targets: ForgetTarget[]): ForgetTarget[] {
  return targets.filter(isDifferentTarget.bind(null, target));
}

function isDifferentTarget(target: ForgetTarget, candidate: ForgetTarget): boolean {
  return candidate !== target;
}

export function focusAfterForget(index: number): void {
  const rows = document.querySelectorAll<HTMLButtonElement>('.memory .fact');
  const focusTarget = rows[index] ?? document.querySelector<HTMLElement>('#memory-title');
  focusTarget?.focus();
}
