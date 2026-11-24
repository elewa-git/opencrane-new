export async function qualifyJoinedWorkspace(join, accessReady, openWorkspace) {
  await join();
  // Wait for permission before the first protected read; a join reply can arrive earlier.
  await accessReady();
  return openWorkspace();
}
