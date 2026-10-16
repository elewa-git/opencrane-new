import { gatewayEntrySchema } from '@opencrane/events';
import { toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { losslessJson } from '@opencrane/events/lossless-json';
import { isToolPolicyAvailable } from '@opencrane/projections';
import type { ToolPolicy } from '@opencrane/protocol';

export function publicationEntry(state: ToolPolicy) {
  const reviewed = state.reviewRevision !== undefined &&
    state.reviewRevision === state.policyRevision;
  // Prepare the reviewed replacement while calls remain held until its receipt arrives.
  const candidate = { ...state, published: true, driftHeld: false };
  const available = isToolPolicyAvailable(candidate);
  if (!reviewed || !available || state.accountMode !== 'none') {
    return null;
  }
  const tools = [];
  for (const tool of state.tools) {
    if (tool.mode !== 'block' && (!tool.reviewed || tool.costCents !== 0)) {
      return null;
    }
    function matchesName(declaration: { name: string }) {
      return declaration.name === tool.name;
    }
    const declaration = state.catalogue?.tools?.find(matchesName);
    if (!declaration) {
      return null;
    }
    tools.push({ name: tool.name, revision: tool.revision, mode: tool.mode,
      reviewDigest: toolReviewDigest(declaration) });
  }
  const entry = { serverId: state.serverId, connectionId: state.connectionId,
    accountMode: state.accountMode, catalogueDigest: state.catalogue?.schemaDigest,
    reviewRevision: state.reviewRevision, tools };
  return gatewayEntrySchema.parse(entry);
}

export function publicationDigest(value: unknown) {
  const encoded = JSON.stringify(value);
  return losslessJson(encoded).digest;
}
