import type { AuditFilter } from '@opencrane/protocol';

const familyPrefixes = {
  members: ['member', 'ownership', 'team', 'assistant', 'grant', 'silo'],
  tools: ['tool', 'mcp', 'connection', 'egress', 'credential', 'provider', 'model'],
  spending: ['budget', 'effect', 'decision', 'gateway'],
  memory: ['memory'],
  routines: ['routine'],
} as const;

export function prefixCondition(prefix: string, parameters: unknown[]): string {
  parameters.push(`${prefix}.`);
  const start = parameters.length;
  parameters.push(`${prefix}/`);
  return `(event_type COLLATE "C" >= $${start}
    AND event_type COLLATE "C" < $${parameters.length})`;
}

export function familyCondition(family: NonNullable<AuditFilter['family']>,
  parameters: unknown[]): string {
  const conditions: string[] = [];
  for (const prefix of familyPrefixes[family]) {
    conditions.push(prefixCondition(prefix, parameters));
  }
  return `(${conditions.join(' OR ')})`;
}
