import type { PageFact } from './memory-panel-data';
import type { ForgetTarget } from './memory-forget';

export function withoutForgottenFact(memoryId: string, facts: PageFact[]): PageFact[] {
  return facts.filter(hasDifferentMemoryId.bind(null, memoryId));
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
