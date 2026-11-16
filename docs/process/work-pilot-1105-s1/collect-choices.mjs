/** Read selection records through the event store's supported category query. */
export async function collectChoices(store, serverId) {
  const choices = [];
  for await (const row of store.readStream('connection-*')) {
    const choice = row.event.data;
    if (row.event.type !== 'connection.selected' || choice.serverId !== serverId) continue;
    choices.push({ sequence: row.sequence, expectedSequence: choice.expectedSequence,
      userId: choice.userId, profileId: choice.profileId,
      allowedAssistantIds: choice.allowedAssistantIds });
  }
  return choices;
}
