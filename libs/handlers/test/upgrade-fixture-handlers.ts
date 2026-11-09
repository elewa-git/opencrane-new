import type { HandlerName } from '@opencrane/events';

export const upgradeFixtureHandlerNames = [
  'update-openfga', 'seed-ownership', 'confirm-ownership', 'seed-model-grants',
  'check-hosted-image', 'seed-provider-default', 'create-assistant', 'claim-computer',
  'cleanup-departure', 'stop-budget-turns', 'prepare-gateway-configuration',
  'settle-budget', 'dream-memory', 'complete-welcome',
] as const satisfies readonly HandlerName[];
