import { serverMain } from '../../apps/server/src/main.ts';
import { fixtureNetwork } from './mcp-fixture.ts';
await serverMain(await fixtureNetwork());
