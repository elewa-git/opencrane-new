function replaceOnce(source: string, expected: string, replacement: string) {
  if (source.split(expected).length !== 2) {
    throw new Error('Required network injection unavailable');
  }
  return source.replace(expected, replacement);
}

export function stageBLaunchSources(server: string, models: string) {
  // Refuse changed entrypoints instead of silently running any real outbound transport.
  const serverSource = replaceOnce(server, 'discovery: {}', 'discovery: stageBNetwork');
  const watchSource = replaceOnce(models,
    'remoteCatalogueWatch(db.db, events.store, silo, requireDispatchLeader);',
    'remoteCatalogueWatch(db.db, events.store, silo, requireDispatchLeader, stageBNetwork);');
  const modelsSource = replaceOnce(watchSource,
    'const dispatchOptions = { acknowledged, routes:',
    'const dispatchOptions = { remoteNetwork: stageBNetwork, acknowledged, routes:');
  return { server: serverSource, models: modelsSource };
}
