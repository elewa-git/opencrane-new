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

export function stageBComposeOverride(root: string, directory: string, id: string) {
  // Share only the claim and demo socket; keep the stack's private key folders outside models.
  const volumes = [
    `${directory}/stack-owner:${directory}/stack-owner:ro`,
    `${directory}/stage-b-demo.sock:${directory}/stage-b-demo.sock:ro`,
  ];
  const models = {
    image: 'opencrane-stage-b-local:tls',
    build: { context: root, dockerfile: 'infra/dev-stack/Dockerfile.stage-b' },
    command: ['node', '--experimental-strip-types', 'infra/dev-stack/stage-b-entry.ts', 'models'],
    environment: { STAGE_B_CLAIMED_ID: id },
    volumes,
  };
  return { services: { models } };
}
