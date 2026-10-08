export { type Db, type Query } from "./db.ts";
export {
  pgDb,
  connectMemberFeed,
  connectMcpCatalogue,
  connectComputers,
  connectProjectionDb,
} from "./pg.ts";
export { pgliteDb } from "./pglite.ts";
export {
  ProjectionRunner,
  readEvents,
  type Projection,
  type EventSource,
} from "./runner.ts";
export { members } from "./members.ts";
export { mcpCatalogue } from "./mcp-catalogue.ts";
export { computers, mapComputerRows, type ComputerDbRow } from './computers.ts';
export {
  rebuildMemberProjection,
  rebuildMcpCatalogueProjection,
  rebuildComputersProjection,
} from "./rebuild.ts";
export {
  conversations, readConversation, listConversations, listOpenConversations,
} from './conversations.ts';

export { emptyToolPolicy, applyToolPolicy } from './tool-policy.ts';
export { auditTrail, readAudit } from './audit.ts';
export { rebuildAuditProjection } from './audit-rebuild.ts';

export { conversationKeys } from './keys.ts';
export { files, listFiles } from './files.ts';

export { groups, readGroups } from './groups.ts';
export { rebuildGroupProjection } from './group-rebuild.ts';

export { providers, readProviders, applyProvider, type ProviderState } from './providers.ts';
export { rebuildProviderProjection } from './provider-rebuild.ts';
export { modelAccess, readModelGrantRows, readModelAccessCandidates,
  type ModelGrantState } from './model-access.ts';
export { rebuildModelAccessProjection } from './model-access-rebuild.ts';

export { lifecycleComputerState } from './computer-chat-state.ts';
