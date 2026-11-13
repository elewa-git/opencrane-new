import type { Binding } from '@opencrane/authz';
import { memberAuthorisation } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { history as modelHistory, readConnectionSelection } from '@opencrane/models';
import { applyToolPolicy, emptyToolPolicy, isToolPolicyAvailable } from '@opencrane/projections';

export interface TurnToolReaderOptions {
  silo: string;
  store: EventStore;
  binding: Binding;
  loadOAuthConfiguration?: (serverId: string) => Promise<unknown>;
}

/** Share the live turn's access and verified-account readers with connection notices. */
export function turnToolReaders(options: TurnToolReaderOptions) {
  async function readServer(serverId: string) {
    const rows = await modelHistory(options.store, `mcp-${serverId}`, options.silo,
      performance.now() + 10_000);
    let policy = emptyToolPolicy();
    for (const row of rows) {
      policy = applyToolPolicy(policy, row.event, row.sequence);
    }
    const discovered = policy.catalogue;
    if (!discovered || !isToolPolicyAvailable(policy)) return undefined;
    type Catalogue = NonNullable<typeof discovered>;
    function discoveryTool(tool: NonNullable<Catalogue['tools']>[number]) {
      return {
        name: tool.name,
        revision: tool.revision,
        ...(tool.definition ? { definition: tool.definition } : {}),
        ...(tool.review ? { review: tool.review } : {}),
      };
    }
    function policyTool(tool: (typeof policy.tools)[number]) {
      return {
        name: tool.name,
        revision: tool.revision,
        reviewed: tool.reviewed,
        mode: tool.mode,
        ...(tool.costCents === undefined ? {} : { costCents: tool.costCents }),
      };
    }
    const discoveryTools = (discovered.tools ?? []).map(discoveryTool);
    const policyTools = policy.tools.map(policyTool);
    return {
      serverId,
      connectionId: policy.connectionId,
      published: policy.published,
      accountMode: policy.accountMode,
      ...(discovered.serverInfo ? { serverInfo: discovered.serverInfo } : {}),
      discoveryTools,
      policyTools,
    };
  }
  async function canUseServer(serverId: string, subjectKind: 'person' | 'assistant',
    subjectId: string) {
    const auth = memberAuthorisation(options.binding);
    const permission = await auth.use(subjectKind, subjectId, 'mcp_server', serverId);
    return permission.allowed;
  }
  async function readSelection(requesterId: string, serverId: string) {
    if (!options.binding) return undefined;
    const selection = await readConnectionSelection(options.store, options.binding,
      requesterId, serverId, options.loadOAuthConfiguration);
    if (selection.status !== 'verified') return undefined;
    return { profileId: selection.profileId, profileRevision: selection.profileRevision,
      selectionRevision: selection.sequence, generation: selection.generation };
  }
  return { readServer, canUse: canUseServer, readSelection };
}
