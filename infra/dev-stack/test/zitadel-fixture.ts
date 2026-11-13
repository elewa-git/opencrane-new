import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const secondaryOwnerApp = {
  id: '393311211707436433', name: 'OpenCrane 2 Dev Web',
  details: { resourceOwner: '393311211338337681' },
  oidcConfig: {
    clientId: '393311211707501969', devMode: false, idTokenUserinfoAssertion: true,
    redirectUris: ['https://ocn-dev.tail00285e.ts.net/auth/callback'],
    postLogoutRedirectUris: ['https://ocn-dev.tail00285e.ts.net/'],
  },
};

export async function createZitadelFixture(state: unknown) {
  const home = await mkdtemp(`${tmpdir()}/zitadel-cli-`);
  const directory = `${home}/.config/opencrane/dev-stack-1`;
  const providerFile = `${home}/provider.json`;
  const env = { PATH: process.env['PATH'], HOME: home, DEV_STACK_ID: '1',
    ZITADEL_KEY_FILE: `${home}/pat`, MOCK_ZITADEL_FILE: providerFile };
  const args = ['--experimental-strip-types', '--import',
    './infra/dev-stack/test/zitadel-provider.mjs', 'infra/dev-stack/zitadel-setup.ts'];
  await writeFile(providerFile, JSON.stringify(state));
  await writeFile(env.ZITADEL_KEY_FILE, 'fake-private-credential');
  async function setup(environment: NodeJS.ProcessEnv = env) {
    return exec(process.execPath, args, { env: environment });
  }
  async function readState(): Promise<unknown> {
    return JSON.parse(await readFile(providerFile, 'utf8')) as unknown;
  }
  async function close() {
    await rm(home, { recursive: true, force: true });
  }
  return { home, directory, env, setup, readState, close };
}
