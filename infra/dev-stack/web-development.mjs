import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { organisationPage } from '../package/web-page.mjs';

const webDirectory = fileURLToPath(new URL('../../apps/web/', import.meta.url));
const requireWeb = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { Architect, createBuilder } = requireWeb('@angular-devkit/architect');
const { WorkspaceNodeModulesArchitectHost } = requireWeb('@angular-devkit/architect/node');
const { schema, workspaces } = requireWeb('@angular-devkit/core');
const { NodeJsSyncHost } = requireWeb('@angular-devkit/core/node');
const { createConsoleLogger } = requireWeb('@angular-devkit/core/node/cli-logger');
const { executeDevServerBuilder } = requireWeb('@angular/build');

async function installationPage(page) {
  return organisationPage(page, process.env['ORGANISATION_NAME']);
}

function serveDevelopmentPage(options, context) {
  return executeDevServerBuilder(options, context, { indexHtmlTransformer: installationPage });
}

class DevelopmentHost extends WorkspaceNodeModulesArchitectHost {
  async loadBuilder(info) {
    if (info.name === '@angular/build:dev-server') {
      return createBuilder(serveDevelopmentPage);
    }
    return super.loadBuilder(info);
  }
}

export async function startDevelopmentServer(port, ownerHost, proxyFile) {
  const workspaceHost = workspaces.createWorkspaceHost(new NodeJsSyncHost());
  const { workspace } = await workspaces.readWorkspace(webDirectory, workspaceHost);
  const host = new DevelopmentHost(workspace, webDirectory);
  const registry = new schema.CoreSchemaRegistry();
  registry.addPostTransform(schema.transforms.addUndefinedDefaults);
  const architect = new Architect(host, registry);
  const logger = createConsoleLogger();
  const target = { project: 'web', target: 'serve', configuration: 'development' };
  const options = { host: '127.0.0.1', port, proxyConfig: proxyFile, allowedHosts: [ownerHost] };
  const run = await architect.scheduleTarget(target, options, { logger });
  async function stop() {
    await run.stop();
    process.exit(0);
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const result = await run.result;
  if (!result.success) {
    await run.stop();
    throw new Error('Development website build failed');
  }
}
