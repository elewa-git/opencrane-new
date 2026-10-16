import { hasRefusedMemoryControl, type Scope, type Source } from './memory-panel-data';
import { sourceMatchesReference } from './memory-panel-reads';

export function storeKindFromEvent(event: Event): 'fact' | 'preference' | undefined {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return undefined;
  return target.value === 'preference' ? 'preference' : 'fact';
}

export function storeBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function storeValidation(text: string, kind: 'fact' | 'preference',
  scopeKind: Scope['scopeKind'] | undefined): string {
  const bytes = storeBytes(text);
  if (bytes < 1 || bytes > 4096) return 'Facts must be 1 to 4,096 UTF-8 bytes.';
  const encodedText = new TextEncoder().encode(text);
  const decodedText = new TextDecoder('utf-8', { ignoreBOM: true }).decode(encodedText);
  if (hasRefusedMemoryControl(text) || decodedText !== text) {
    return 'Remove unsupported control characters and try again.';
  }
  if (kind === 'preference' && scopeKind !== 'person') {
    return 'Preferences can only be saved in your memory.';
  }
  return '';
}

export function storePayload(commandId: string, text: string, kind: 'fact' | 'preference',
  source: Source['reference'] | undefined): Record<string, unknown> {
  const sources = source ? [source] : [];
  return { commandId, text, kind, pinned: false, expiresAt: null, sources, dependsOn: [] };
}

export function storeSourceLabel(selected: Source['reference'] | undefined,
  sources: Source[]): string {
  if (!selected) return 'Your statement';
  const source = sources.find(sourceMatchesReference.bind(null, selected));
  return source?.label || 'Available source';
}
