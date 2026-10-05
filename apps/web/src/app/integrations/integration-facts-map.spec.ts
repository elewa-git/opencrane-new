import type { IntegrationRow, ToolPolicy } from '@opencrane/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildAllowedForFact, buildAvailabilityFact, buildConnectedFact, buildInstalledFact,
  buildIntegrationFacts,
} from './integration-facts-map';

const loadedAt = '2026-10-05T09:14:00.000Z';

function integrationRow(
  kind: IntegrationRow['status']['kind'],
  label: string,
  detail: string,
  safeToRetry?: boolean,
): IntegrationRow {
  const status: IntegrationRow['status'] = { kind, label, detail };
  if (safeToRetry !== undefined) status.safeToRetry = safeToRetry;
  return {
    serverId: 'fixture-server',
    name: 'Fixture server',
    source: { kind: 'remote_url', label: 'Remote URL', detail: 'tools.example.test' },
    version: 'Version not provided',
    accountModel: 'Not provided',
    toolsAllowed: 0,
    toolsTotal: 1,
    status,
  };
}

function policy(published: boolean): ToolPolicy {
  return { connectionId: null, accountMode: null, published, sequence: 1, tools: [] };
}

describe('integration facts mapping', () => {
  it('maps every available fact without filling gaps with assumptions', () => {
    const row = integrationRow('ready', 'Ready', 'Published 5 Oct 2026, 09:14');
    const facts = buildIntegrationFacts(row, policy(false), 'loaded', loadedAt);
    expect(facts).toEqual([
      {
        label: 'Installed', kind: 'ready', value: 'Ready',
        evidence: 'Published 5 Oct 2026, 09:14 · Loaded at 09:14 UTC',
      },
      buildConnectedFact(),
      buildAllowedForFact(),
      {
        label: 'Available to the assistant', kind: 'blocked', value: 'No',
        evidence: 'Not published. The gateway refuses every call to an unpublished server.',
      },
    ]);
  });

  it('passes the retry fact through for the Installed card', () => {
    const row = integrationRow('failed', 'Failed', 'Validation failed', true);
    expect(buildInstalledFact(row, loadedAt)).toEqual({
      label: 'Installed', kind: 'failed', value: 'Failed',
      evidence: 'Validation failed · Loaded at 09:14 UTC', safeToRetry: true,
    });
  });

  it('does not claim assistant access from publication or tool modes', () => {
    expect(buildAvailabilityFact(policy(true), 'loaded')).toEqual({
      label: 'Available to the assistant', kind: 'not_configured',
      value: 'Not available yet',
      evidence: "Published, but access grants can't be read yet, so this can't be confirmed.",
    });
  });

  it('reports a tool read failure separately from the other facts', () => {
    expect(buildAvailabilityFact(undefined, 'failed')).toEqual({
      label: 'Available to the assistant', kind: 'failed', value: "Couldn't check",
      evidence: 'The tool policy read failed. Refresh to read it again.',
    });
  });

  it('keeps the four facts in the required order', () => {
    const facts = buildIntegrationFacts(
      integrationRow('needs_input', 'Needs input', 'Pending review'), undefined, 'failed', loadedAt,
    );
    const labels = facts.map(readLabel);
    expect(labels).toEqual([
      'Installed', 'Connected', 'Allowed for', 'Available to the assistant',
    ]);
  });
});

function readLabel(fact: { label: string }): string {
  return fact.label;
}
