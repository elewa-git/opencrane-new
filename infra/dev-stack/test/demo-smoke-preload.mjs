import { registerHooks } from 'node:module';

function load(url, context, nextLoad) {
  if (url.endsWith('/infra/dev-stack/config.ts')) {
    throw new Error('Recording fixture refuses configuration before the secondary id check');
  }
  return nextLoad(url, context);
}
registerHooks({ load });
