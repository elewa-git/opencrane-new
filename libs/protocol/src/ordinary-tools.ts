import { z } from 'zod';
import type { ToolPolicy } from './integrations.ts';

type Catalogue = ToolPolicy['catalogue'];
type Tool = NonNullable<NonNullable<Catalogue>['tools']>[number];
const discoverySchema = z.object({ capabilities: z.object({
  experimental: z.record(z.string(), z.unknown()).optional(),
}) });

/** Separate standard definitions from servers that declare OpenCrane's contract. */
export function isOrdinaryToolCatalogue(catalogue: Catalogue | undefined): boolean {
  if (!catalogue?.discoverResult || !catalogue.tools || catalogue.hostedRun) return false;
  if (catalogue.declared) return false;
  // Require complete-list evidence when older discovery discarded any tools.
  if (catalogue.rejectedTools?.length && catalogue.declared !== false) return false;
  for (const tool of catalogue.tools) {
    if (tool.costCents !== undefined || tool.review !== undefined) return false;
  }
  try {
    const discovery = discoverySchema.parse(JSON.parse(catalogue.discoverResult));
    const experimental = discovery.capabilities.experimental ?? {};
    return !Object.hasOwn(experimental, 'io.opencrane/expectedRevision');
  } catch {
    return false;
  }
}

export function canReviewTool(catalogue: Catalogue | undefined,
  tool: Tool | undefined): boolean {
  if (!tool) return false;
  if (isOrdinaryToolCatalogue(catalogue)) return true;
  return tool.costCents === 0 && tool.review !== undefined;
}

export function hasOpenCraneToolDeclarations(definition: unknown): boolean {
  if (!definition || typeof definition !== 'object') return false;
  const metadata: unknown = Reflect.get(definition, '_meta');
  if (!metadata || typeof metadata !== 'object') return false;
  for (const key of Object.keys(metadata)) {
    if (key.startsWith('io.opencrane/')) return true;
  }
  return false;
}
