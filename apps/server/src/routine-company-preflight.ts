import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { RoutineState } from '@opencrane/events';
import { companySelectionFacts, foldCompanyConnection, foldConnectionSelection,
  history, type CompanyProfileReader, type OAuthConfigurationLoader } from '@opencrane/models';

type Run = NonNullable<RoutineState['activeRun']>;

function refuse(): never {
  throw new Error('Routine company unavailable');
}

function requireChoice(rows: StoredEvent[], run: Run) {
  const selection = foldConnectionSelection(rows);
  const choice = selection.selected;
  const definition = run.definition;
  if (!choice || choice.action !== 'select' || choice.ownerKind !== 'company' ||
      choice.userId !== definition.ownerId || choice.connectionId !== definition.connectionId ||
      choice.profileId !== definition.profileId ||
      choice.profileRevision !== definition.profileRevision) {
    refuse();
  }
  return { choice, sequence: selection.sequence };
}

function requireSavedProfile(rows: StoredEvent[], run: Run) {
  const profile = foldCompanyConnection(rows);
  const saved = profile.data;
  const definition = run.definition;
  if (profile.status !== 'saved_unverified' || !saved ||
      profile.sequence !== definition.profileRevision ||
      profile.sequence !== definition.connectionRevision ||
      saved.serverId !== definition.serverId ||
      saved.profile !== definition.profileId ||
      saved.activation.connectionId !== definition.connectionId) {
    refuse();
  }
  return saved;
}

/** Check the exact company choice and verified profile after the recorded computer wakes. */
export async function checkRoutineCompanyPreflight(store: EventStore, silo: string,
  run: Run, computerGeneration: number, loadConfiguration: OAuthConfigurationLoader,
  readProfile: CompanyProfileReader) {
  try {
    const definition = run.definition;
    if (definition.connectionKind !== 'company' || !definition.serverId ||
        computerGeneration < 1) refuse();
    const deadline = performance.now() + 10_000;
    const selectionSubject =
      `connection-selection-${definition.ownerId}-${definition.serverId}`;
    const selectionRows = await history(store, selectionSubject, silo, deadline);
    const selected = requireChoice(selectionRows, run);
    let savedProfile: ReturnType<typeof requireSavedProfile> | undefined;
    function checkedReader(rows: StoredEvent[]) {
      savedProfile = requireSavedProfile(rows, run);
      return readProfile(rows);
    }
    const facts = await companySelectionFacts(store, silo, selected.choice,
      loadConfiguration, checkedReader);
    if (!savedProfile || facts.accountId !== definition.companyAccountId ||
        facts.binding.accountDigest !== selected.choice.accountDigest ||
        facts.binding.generation !== savedProfile.activation.generation ||
        facts.binding.generation !== selected.choice.generation) {
      refuse();
    }
    for (const scope of definition.scopes) {
      if (!facts.scopes.includes(scope)) refuse();
    }
    const positions = new Map(facts.positions);
    positions.set(selectionSubject, selected.sequence);
    async function confirmCurrent() {
      const currentDeadline = performance.now() + 2_000;
      for (const [subject, position] of positions) {
        const currentPosition = await store.head(subject, currentDeadline);
        if (currentPosition !== position) refuse();
      }
      if (Date.now() >= facts.expiresAt || !await facts.oauth.configurationCurrent()) {
        refuse();
      }
    }
    await confirmCurrent();
    return { occurrenceId: run.occurrenceId, rootId: run.rootId,
      computerGeneration, confirmCurrent };
  } catch {
    refuse();
  }
}
