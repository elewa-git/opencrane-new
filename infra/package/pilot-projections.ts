import { budgets } from '@opencrane/models';
import { members, mcpCatalogue, computers, conversations, files, auditTrail,
  personalSettings, groups, providers, modelAccess, egressPolicy, connectionProfiles,
  childRequests, type Projection } from '@opencrane/projections';

export const pilotProjections: Projection[] = [members, mcpCatalogue, computers,
  conversations, files, budgets, auditTrail, personalSettings, groups, providers,
  modelAccess, egressPolicy, connectionProfiles, childRequests];

function projectionName(projection: Projection) {
  return projection.name;
}
export const pilotProjectionNames = pilotProjections.map(projectionName);
