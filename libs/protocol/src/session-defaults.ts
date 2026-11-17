import { sessionConfiguration } from '@opencrane/events/session-configuration';

export function sessionDefaults(assistantKind: string | undefined) {
  // Keep the composer's default separate from deployment-qualified turn admission.
  const configuration = sessionConfiguration({ conversation: {}, assistantKind,
    memoryEnabled: false });
  return { executionMode: configuration.executionMode };
}
