import { record as asRecord } from './record.ts';
// Starts the server the way it runs in production: its own Node process, launched
// with `node --experimental-strip-types`. Nothing else in the suite runs
// `main.ts` itself, so a bad import there could ship unnoticed. It also checks,
// on the real process's real stdout, that no secret in a request URL is printed.
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { encodeSession, loadAuthConfig } from '@opencrane/auth';
import { event, natsFixture } from '@opencrane/event-store/testing';

const TEST_SHUTDOWN_GRACE_MS = 500;

const TEST_OIDC_ENV = {
  OIDC_ISSUER_URL: 'https://issuer.example.test',
  OIDC_CLIENT_ID: 'opencrane-test',
  OIDC_REDIRECT_URI: 'https://app.example.test/auth/callback',
  OIDC_COOKIE_SECRET: 'test-only-cookie-secret-test-only-cookie-secret',
  // Blanked so a value exported by the host shell cannot change the result.
  OIDC_CLIENT_SECRET_ENV_VAR: '',
  OIDC_COOKIE_SECURE: '',
  OIDC_ALLOW_INSECURE_REQUESTS: '',
  OIDC_EXPECTED_ORG_ID: '',
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Ask the OS for a free TCP port by briefly binding to port 0, then releasing it. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (address === null || typeof address === 'string' ? reject(new Error('expected a network address')) : resolve(address.port)));
    });
  });
}

/** Parse every complete JSON line on `text`; a partial trailing line (still being written) is skipped. */
function parseJsonLines(text: string): Record<string, unknown>[] {
  return text.split('\n').flatMap((line) => {
    try {
      return [asRecord(JSON.parse(line))];
    } catch {
      return [];
    }
  });
}

/** The `req.url` of every line that has one. */
function loggedUrls(text: string): string[] {
  return parseJsonLines(text).flatMap((line) => {
    const url = asRecord(line['req'] ?? {})['url'];
    return typeof url === 'string' ? [url] : [];
  });
}

/** Send raw bytes and return the reply, so a request line `fetch` would refuse to build can be tested. */
async function sendRaw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = '';
    const socket = connect(port, '127.0.0.1');
    socket.on('data', (chunk: Buffer) => (received += chunk.toString('utf8')));
    socket.on('close', () => resolve(received));
    socket.on('error', reject);
    socket.write(request);
  });
}

interface RunningServer {
  port: number;
  stdout: () => string;
  stop: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

interface StartServerOptions {
  injectNatsCloseFailure?: boolean;
}

/** Replace only the child process's event-store entrypoint so its real connection closer rejects. */
function natsCloseFailurePreload(): string {
  const target = pathToFileURL(resolve('libs/event-store/src/index.ts')).href;
  const replacement = `
    export * from ${JSON.stringify(target)};
    import { connectEventStore as realConnect } from ${JSON.stringify(target)};
    export async function connectEventStore(servers) {
      const events = await realConnect(servers);
      return { ...events, close: async () => { throw new Error('injected NATS close failure'); } };
    }
  `;
  const preload = `
    import { registerHooks } from 'node:module';
    const replacement = ${JSON.stringify(replacement)};
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === '@opencrane/event-store') {
          return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(replacement) };
        }
        return nextResolve(specifier, context);
      }
    });
  `;
  return `data:text/javascript,${encodeURIComponent(preload)}`;
}

/** Launch main.ts as a child process and wait until /healthz answers. */
async function startServer(extraEnv: NodeJS.ProcessEnv = {}, options: StartServerOptions = {}): Promise<RunningServer> {
  const port = await findFreePort();
  let stdout = '';
  let stderr = '';
  const args = ['--experimental-strip-types'];
  if (options.injectNatsCloseFailure === true) {
    args.push('--import', natsCloseFailurePreload());
  }
  args.push('apps/server/src/main.ts');
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    // OTEL_EXPORTER_OTLP_ENDPOINT is blanked so the result never depends on what the host shell exports.
    // The OIDC settings are made-up test values: main.ts will not start without them, but nothing here
    // signs anyone in, so the issuer is never contacted.
    env: { ...process.env, ...TEST_OIDC_ENV, NATS_URL: '', SILO_ID: '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'info', OTEL_EXPORTER_OTLP_ENDPOINT: '', SHUTDOWN_GRACE_MS: String(TEST_SHUTDOWN_GRACE_MS), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });

  /** Ask the child to stop and fail, with diagnostics, if its own deadline does not stop it. */
  const stop = async (): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { code: child.exitCode, signal: child.signalCode };
    }
    child.kill('SIGTERM');
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('server did not exit after SIGTERM')), 3_000);
        }),
      ]);
    } catch (error) {
      child.kill('SIGKILL');
      await exited;
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: error });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  // Poll rather than guess a delay: a cold type-stripping boot can take seconds on a loaded machine.
  const deadline = Date.now() + 25_000;
  for (;;) {
    const failure = child.exitCode !== null ? `server exited early with code ${String(child.exitCode)}` : Date.now() >= deadline ? 'server never became healthy' : undefined;
    if (failure !== undefined) {
      await stop();
      throw new Error(`${failure}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    if (await fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.ok, () => false)) {
      return { port, stdout: () => stdout, stop };
    }
    await sleep(100);
  }
}

describe('main.ts under the real Node runtime', () => {
  let server: RunningServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('exits 0 on idle SIGTERM and closes NATS exactly once', async () => {
    const nats = await natsFixture();
    try {
      const env = { ...TEST_OIDC_ENV, OIDC_EXPECTED_ORG_ID: 'org-acme',
        NATS_URL: nats.connection.getServer(), SILO_ID: 'acme' };
      server = await startServer(env);
      const invited = event('invite-process', 'member-alice', 'member.invited');
      await nats.store.append({ expectedSequence: 0, event: { ...invited, silo: 'acme',
        data: { ...invited.data, invitationId: 'invite-process',
          invitedIdentity: { issuer: env.OIDC_ISSUER_URL, sub: 'alice' },
          expiresAt: new Date(Date.now() + 60_000).toISOString() } } });
      const config = loadAuthConfig(env);
      const cookie = encodeSession(config, { sub: 'alice', orgId: 'org-acme', roles: [],
        authTime: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 });
      const response = await fetch(`http://127.0.0.1:${server.port}/members/join`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.example.test',
          cookie: `${config.cookieName}=${cookie}` },
        body: JSON.stringify({ memberId: 'alice', invitationId: 'invite-process', commandId: 'join-process', displayName: 'Alice' }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'joined', memberId: 'alice', sequence: 2 });
      expect(await nats.store.head()).toBe(2);
      const running = server;
      const exit = await running.stop();
      server = undefined;
      expect(exit).toEqual({ code: 0, signal: null });
      expect(parseJsonLines(running.stdout()).filter((line) => line['msg'] === 'event store connection closed')).toHaveLength(1);
    } finally {
      await server?.stop();
      await nats.close();
    }
  }, 40_000);

  it('exits 0 within the grace period with an open authenticated WebSocket', async () => {
    server = await startServer();
    const config = loadAuthConfig(TEST_OIDC_ENV);
    const cookie = encodeSession(config, { sub: 'alice', orgId: 'org-acme', roles: [],
      authTime: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { cookie: `${config.cookieName}=${cookie}`, origin: new URL(config.redirectUri).origin },
    });
    await new Promise<void>((resolveOpen, reject) => {
      socket.once('open', resolveOpen);
      socket.once('error', reject);
    });
    const socketClosed = new Promise<number>((resolveClose, reject) => {
      socket.once('close', resolveClose);
      socket.once('error', reject);
    });

    const started = Date.now();
    const running = server;
    const exit = await running.stop();
    server = undefined;

    expect(exit).toEqual({ code: 0, signal: null });
    expect(await socketClosed).toBe(1001);
    expect(Date.now() - started).toBeLessThan(TEST_SHUTDOWN_GRACE_MS + 1_000);
  }, 40_000);

  it('exits 0 within the grace period with a stalled partial-body request', async () => {
    server = await startServer();
    const socket = connect(server.port, '127.0.0.1');
    await new Promise<void>((resolveConnect, reject) => {
      socket.once('connect', resolveConnect);
      socket.once('error', reject);
    });
    socket.on('error', () => undefined);
    socket.write('POST /members/join HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{');
    for (let tries = 0; tries < 20 && !loggedUrls(server.stdout()).includes('/members/join'); tries += 1) {
      await sleep(25);
    }
    expect(loggedUrls(server.stdout())).toContain('/members/join');

    const started = Date.now();
    const running = server;
    const exit = await running.stop();
    server = undefined;

    expect(exit).toEqual({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(TEST_SHUTDOWN_GRACE_MS + 1_000);
  }, 40_000);

  it('exits non-zero within the grace period when NATS close rejects', async () => {
    const nats = await natsFixture();
    try {
      server = await startServer({ OIDC_EXPECTED_ORG_ID: 'org-acme', NATS_URL: nats.connection.getServer(), SILO_ID: 'acme' },
        { injectNatsCloseFailure: true });
      const started = Date.now();
      const running = server;
      const exit = await running.stop();
      server = undefined;

      expect(exit).toEqual({ code: 1, signal: null });
      expect(Date.now() - started).toBeLessThan(TEST_SHUTDOWN_GRACE_MS + 1_000);
      expect(parseJsonLines(running.stdout())).toContainEqual(expect.objectContaining({
        msg: 'server shutdown failed', cleanup: 'event store',
      }));
    } finally {
      await server?.stop();
      await nats.close();
    }
  }, 40_000);

  it('starts, serves /healthz, and never prints a secret from a request URL: known route, unknown route, plain GET to /ws, the sign-in callback, or a URL Node cannot parse', async () => {
    server = await startServer();
    const { port } = server;
    const get = (path: string): Promise<Response> => fetch(`http://127.0.0.1:${port}${path}`);

    const known = await get('/healthz?token=SECRET_MAIN_KNOWN');
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual({ status: 'ok' });
    // The "Route ... not found" line Fastify writes itself, and a plain GET (no upgrade) to the WebSocket path.
    expect((await get('/nope?token=SECRET_MAIN_404&code=SECRET_MAIN_CODE')).status).toBe(404);
    expect((await get('/ws?token=SECRET_MAIN_WS')).status).toBe(404);
    // The sign-in callback: its `code` and `state` are secrets, and so is the login-flow cookie. With a
    // cookie that is not a real one the route refuses the request, which needs no identity provider.
    const callback = await fetch(`http://127.0.0.1:${port}/auth/callback?code=SECRET_MAIN_AUTH_CODE&state=SECRET_MAIN_AUTH_STATE`, {
      headers: { cookie: 'oc_auth_flow=SECRET_MAIN_FLOW_COOKIE' },
    });
    expect(callback.status).toBe(400);
    // A request line the URL parser rejects: `fetch` will not send it, so use a raw socket.
    const raw = await sendRaw(port, 'GET //[x?token=SECRET_MAIN_BRACKET HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    expect(raw).toMatch(/^HTTP\/1\.1 \d{3} /u);

    // Wait until the last request shows up in redacted form before judging the output.
    const running = server;
    for (let tries = 0; tries < 60 && !loggedUrls(running.stdout()).includes('//[x?token=[Redacted]'); tries += 1) {
      await sleep(50);
    }

    const stdout = server.stdout();
    expect(stdout).not.toContain('SECRET_MAIN_');
    const lines = parseJsonLines(stdout);
    const messages = lines.map((line) => line['msg']);
    // Every line the server wrote is JSON, and the redacted forms are what was logged.
    expect(lines).toHaveLength(stdout.split('\n').filter(Boolean).length);
    expect(loggedUrls(stdout)).toEqual(expect.arrayContaining(['/healthz?token=[Redacted]', '/nope?token=[Redacted]&code=[Redacted]', '/auth/callback?code=[Redacted]&state=[Redacted]', '//[x?token=[Redacted]']));
    expect(messages).toContain('sign-in callback refused: login flow cookie is invalid');
    expect(messages).toContain('Route GET:/nope?token=[Redacted]&code=[Redacted] not found');
    expect(messages).toContain('Route GET:/ws?token=[Redacted] not found');
    // The request id is called request_id everywhere.
    expect(lines.some((line) => typeof line['request_id'] === 'string')).toBe(true);
    expect(lines.some((line) => 'reqId' in line)).toBe(false);
  }, 40_000);
});
