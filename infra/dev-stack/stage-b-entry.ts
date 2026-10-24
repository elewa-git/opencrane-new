import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { registerHooks, stripTypeScriptTypes, type LoadHookContext,
  type LoadFnOutput } from 'node:module';
import { requireStageBStack } from './stage-b-guard.ts';
import { stageBLaunchSources } from './stage-b-launch.ts';

const root = new URL('../../', import.meta.url);
const directory = await requireStageBStack(process.env['DEV_STACK_ID'],
  process.env['STAGE_B_CLAIMED_ID'] ?? '', homedir(), root.pathname.slice(0, -1));
const role = process.argv[2];
if (role !== 'server' && role !== 'models') throw new Error('Rehearsal role refused');
const serverUrl = new URL('apps/server/src/main.ts', root);
const modelsUrl = new URL('apps/server/src/models-main.ts', root);
const serverSource = await readFile(serverUrl, 'utf8');
const modelsSource = await readFile(modelsUrl, 'utf8');
const sources = stageBLaunchSources(serverSource, modelsSource);
// Finish both injection checks before importing fixtures or starting any product service.
const { stageBNetwork } = await import('./test/stage-b-network.ts');
await stageBNetwork(directory);
const networkUrl = new URL('./test/stage-b-network.ts', import.meta.url);
const networkImport = `import { network as stageBNetwork } from ${JSON.stringify(networkUrl.href)};\n`;
function load(url: string, context: LoadHookContext,
  nextLoad: (url: string, context: LoadHookContext) => LoadFnOutput): LoadFnOutput {
  let source: string;
  if (url === serverUrl.href) source = sources.server;
  else if (url === modelsUrl.href) source = sources.models;
  else return nextLoad(url, context);
  const prepared = stripTypeScriptTypes(networkImport + source);
  return { format: 'module', source: prepared, shortCircuit: true };
}
registerHooks({ load });
if (role === 'server') await import(serverUrl.href);
else await import('./secondary-models.ts');
