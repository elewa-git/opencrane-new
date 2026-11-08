import { checkProxy, runServiceCheck } from './bridge-check.ts';

export { checkProxy };

if (process.argv[1]?.endsWith('/proxy-check.ts')) {
  await runServiceCheck('proxy');
}
