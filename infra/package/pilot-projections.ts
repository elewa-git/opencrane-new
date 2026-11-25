import { budgets } from '@opencrane/models';
import { members, mcpCatalogue, computers, conversations, files, auditTrail,
  personalSettings, groups, providers, modelAccess, egressPolicy, connectionProfiles,
  childRequests, routines, type Projection } from '@opencrane/projections';

const pilotProjections: readonly Projection[] = [members, mcpCatalogue, computers,
  conversations, files, budgets, auditTrail, personalSettings, groups, providers,
  modelAccess, egressPolicy, connectionProfiles, childRequests];

export function pilotProjectionsFor(providerMode = false): readonly Projection[] {
  return providerMode ? [...pilotProjections, routines] : pilotProjections;
}

function projectionName(projection: Projection) {
  return projection.name;
}

export function pilotProjectionNames(providerMode = false) {
  const selected = pilotProjectionsFor(providerMode);
  return selected.map(projectionName);
}
