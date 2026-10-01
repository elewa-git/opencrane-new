// Starts the server the way it runs in production: its own Node process, launched
// with `node --experimental-strip-types`. Nothing else in the suite runs
// `main.ts` itself, so a bad import there could ship unnoticed. It also checks,
// on the real process's real stdout, that no secret in a request URL is printed.
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

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
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

/** The `req.url` of every line that has one. */
function loggedUrls(text: string): string[] {
  return parseJsonLines(text).flatMap((line) => {
    const url = (line['req'] as { url?: unknown } | undefined)?.url;
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
  stop: () => Promise<void>;
}

/** Launch main.ts as a child process and wait until /healthz answers. */
async function startServer(): Promise<RunningServer> {
  const port = await findFreePort();
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, ['--experimental-strip-types', 'apps/server/src/main.ts'], {
    cwd: process.cwd(),
    // OTEL_EXPORTER_OTLP_ENDPOINT is blanked so the result never depends on what the host shell exports.
    // The OIDC settings are made-up test values: main.ts will not start without them, but nothing here
    // signs anyone in, so the issuer is never contacted.
    env: { ...process.env, ...TEST_OIDC_ENV, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'info', OTEL_EXPORTER_OTLP_ENDPOINT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

  /** Ask the child to stop, hard-kill it after 3 seconds, and resolve only once it has exited. */
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const hardKill = setTimeout(() => child.kill('SIGKILL'), 3_000);
      child.once('exit', () => {
        clearTimeout(hardKill);
        resolve();
      });
      child.kill('SIGTERM');
    });
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
