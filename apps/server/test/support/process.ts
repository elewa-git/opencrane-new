import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { record as asRecord } from '../record.ts';
export const TEST_OIDC_ENV = {
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

/** Parse every complete JSON line on `text`; a partial trailing line (still being written) is skipped. */
export function parseJsonLines(text: string): Record<string, unknown>[] {
  return text.split('\n').flatMap((line) => {
    try {
      return [asRecord(JSON.parse(line))];
    } catch {
      return [];
    }
  });
}

/** The `req.url` of every line that has one. */
export function loggedUrls(text: string): string[] {
  return parseJsonLines(text).flatMap((line) => {
    const url = asRecord(line['req'] ?? {})['url'];
    return typeof url === 'string' ? [url] : [];
  });
}

/** Send raw bytes and return the reply, so a request line `fetch` would refuse to build can be tested. */
export async function sendRaw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = '';
    const socket = connect(port, '127.0.0.1');
    socket.on('data', (chunk: Buffer) => (received += chunk.toString('utf8')));
    socket.on('close', () => resolve(received));
    socket.on('error', reject);
    socket.write(request);
  });
}

export interface RunningServer {
  child: ReturnType<typeof spawn>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; exitedAtMs: number }>;
  port: number;
  stdout: () => string;
  stop: () => Promise<void>;
}

/** Launch main.ts as a child process and wait until /healthz answers. */
export async function startServer(extraEnv: NodeJS.ProcessEnv = {}): Promise<RunningServer> {
  let port = 0;
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, ['--experimental-strip-types', ...(extraEnv['TEST_PROCESS_FAULTS'] ? ['--import', './apps/server/test/support/process-faults.ts'] : []), 'apps/server/src/main.ts'], {
    cwd: process.cwd(),
    // OTEL_EXPORTER_OTLP_ENDPOINT is blanked so the result never depends on what the host shell exports.
    // The OIDC settings are made-up test values: main.ts will not start without them, but nothing here
    // signs anyone in, so the issuer is never contacted.
    env: { ...process.env, ...TEST_OIDC_ENV, NATS_URL: '', NATS_CA_FILE: '', NATS_CERT_FILE: '', NATS_KEY_FILE: '', SILO_ID: '', DATABASE_URL: '', SHUTDOWN_GRACE_MS: '1000', PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'info', OTEL_EXPORTER_OTLP_ENDPOINT: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; exitedAtMs: number }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, exitedAtMs: Date.now() })));
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

  /** Ask the child to stop, hard-kill it after 3 seconds, and resolve only once it has exited. */
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill('SIGTERM');
    const hardKill = setTimeout(() => child.kill('SIGKILL'), 3000);
    const result = await exited;
    clearTimeout(hardKill);
    if (result.code !== 0 || result.signal) throw new Error(`Server did not stop cleanly: ${JSON.stringify(result)}\n${stdout}\n${stderr}`);
  };

  // Poll rather than guess a delay: a cold type-stripping boot can take seconds on a loaded machine.
  const deadline = Date.now() + 25_000;
  for (;;) {
    const failure = child.exitCode !== null ? `server exited early with code ${String(child.exitCode)}` : Date.now() >= deadline ? 'server never became healthy' : undefined;
    if (failure !== undefined) {
      await stop();
      throw new Error(`${failure}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    const ready = parseJsonLines(stdout).find((line) => typeof line['msg'] === 'string'
      && line['msg'].startsWith('opencrane-server listening on '));
    if (ready) port = Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(String(ready['msg']))?.[1]);
    if (port && await fetch(`http://127.0.0.1:${port}/healthz`).then(async (response) => {
      await response.arrayBuffer();
      return response.ok;
    }, () => false)) {
      return { child, exited, port, stdout: () => stdout, stop };
    }
    await sleep(100);
  }
}
