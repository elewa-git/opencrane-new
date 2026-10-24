import type { IntegrationRow, ToolPolicy } from '@opencrane/protocol';
import type { PresentationState } from '../shared-state/shared-state';
import { hasRecordedToolChanges } from './tool-changes';

export type ToolsReadState = 'loading' | 'loaded' | 'failed' | 'list-failed';

export interface IntegrationFact {
  label: string;
  kind: PresentationState;
  value: string;
  evidence: string;
  safeToRetry?: boolean;
}

export function buildIntegrationFacts(
  row: IntegrationRow,
  policy: ToolPolicy | undefined,
  toolsReadState: ToolsReadState,
  loadedAt: string,
): IntegrationFact[] {
  const facts: IntegrationFact[] = [];
  facts.push(buildInstalledFact(row, loadedAt));
  facts.push(buildConnectedFact());
  facts.push(buildAllowedForFact());
  facts.push(buildAvailabilityFact(policy, toolsReadState));
  if (policy?.driftHeld === true && toolsReadState === 'loaded') {
    const toolsChanged = hasRecordedToolChanges(policy);
    for (const fact of facts) {
      if (fact.label === 'Installed') {
        fact.kind = 'needs_input';
        fact.value = 'Paused';
        fact.evidence = 'The integration is installed, but calls are paused.';
        if (toolsChanged) {
          fact.value = 'Paused: tools changed';
          fact.evidence = 'The integration is installed, but its changed tools need review.';
        }
      }
      if (fact.label === 'Allowed for') {
        fact.kind = 'needs_input';
        fact.value = 'Paused';
        fact.evidence = 'Saved access choices remain, but calls are paused for everyone.';
      }
      if (fact.label === 'Available to the assistant') {
        fact.value = 'Paused';
        fact.evidence = 'Calls stay paused until the current publication is confirmed.';
        if (toolsChanged) {
          fact.evidence = 'Every call stays paused while changed tools need review.';
        }
      }
    }
  }
  return facts;
}

export function buildInstalledFact(row: IntegrationRow, loadedAt: string): IntegrationFact {
  const fact: IntegrationFact = {
    label: 'Installed',
    kind: row.status.kind,
    value: row.status.label,
    evidence: `${row.status.detail} · Loaded at ${formatTime(loadedAt)} UTC`,
  };
  if (row.status.safeToRetry !== undefined) fact.safeToRetry = row.status.safeToRetry;
  return fact;
}

export function buildConnectedFact(): IntegrationFact {
  return {
    label: 'Connected',
    kind: 'not_configured',
    value: 'Not available yet',
    evidence: "Connection status can't be read yet.",
  };
}

export function buildAllowedForFact(): IntegrationFact {
  return {
    label: 'Allowed for',
    kind: 'not_configured',
    value: 'Not available yet',
    evidence: "Access grants for this server can't be read yet. A tool mode alone gives nobody "
      + 'access.',
  };
}

export function buildAvailabilityFact(
  policy: ToolPolicy | undefined,
  toolsReadState: ToolsReadState,
): IntegrationFact {
  if (toolsReadState === 'list-failed') {
    return {
      label: 'Available to the assistant',
      kind: 'failed',
      value: 'Not checked',
      evidence: "Not checked: the integration list couldn't be loaded.",
    };
  }
  if (toolsReadState === 'failed') {
    return {
      label: 'Available to the assistant',
      kind: 'failed',
      value: "Couldn't check",
      evidence: 'The tool policy read failed. Refresh to read it again.',
    };
  }
  if (policy?.catalogue &&
      (policy.expiresAt === null || Date.parse(policy.expiresAt) <= Date.now())) {
    return {
      label: 'Available to the assistant', kind: 'blocked', value: 'Paused',
      evidence: 'The last successful tool check has expired. Calls stay paused.',
    };
  }
  if (policy?.published === false) {
    return {
      label: 'Available to the assistant',
      kind: 'blocked',
      value: 'No',
      evidence: 'Not published. The gateway refuses every call to an unpublished server.',
    };
  }
  if (policy?.published !== true) {
    return {
      label: 'Available to the assistant',
      kind: 'checking',
      value: 'Checking',
      evidence: 'The tool policy is being read.',
    };
  }
  return {
    label: 'Available to the assistant',
    kind: 'not_configured',
    value: 'Not available yet',
    evidence: 'Published, but access grants can\'t be read yet, so this can\'t be confirmed.',
  };
}

function formatTime(value: string): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC',
  };
  return new Date(value).toLocaleTimeString('en-GB', options);
}
