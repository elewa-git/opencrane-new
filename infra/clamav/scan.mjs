import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const refusal = 'Scanner scan refused';
export const stateFormat = '{{.Id}} {{.Image}} {{.State.StartedAt}} {{.State.Running}} {{.RestartCount}}';

function requireScan(condition) {
  if (!condition) {
    throw new Error(refusal);
  }
}

function databaseFacts(database) {
  return { file: database.file, sha256: database.sha256, version: database.version,
    builtAt: database.builtAt };
}

function frameBytes(bytes) {
  const frames = [Buffer.from('zINSTREAM\0')];
  const digest = createHash('sha256');
  let byteCount = 0;
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    const chunk = bytes.subarray(offset, offset + 65536);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(chunk.length);
    frames.push(size, chunk);
    digest.update(chunk);
    byteCount += chunk.length;
  }
  frames.push(Buffer.alloc(4));
  return { framed: Buffer.concat(frames), sha256: digest.digest('hex'), byteCount };
}

function runRequest(args, bytes, remaining, signal) {
  function execute(resolve, reject) {
    const options = { stdio: ['pipe', 'pipe', 'pipe'] };
    const child = spawn('docker', args, options);
    const chunks = [];
    let size = 0;
    let failed = false;
    let supplied = false;

    function fail() {
      failed = true;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill('SIGKILL');
    }
    function read(chunk) {
      size += chunk.length;
      if (size > 4096) {
        fail();
        return;
      }
      chunks.push(chunk);
    }
    function discard() {
      // Drain private diagnostics without retaining or forwarding them.
    }
    function sent() {
      supplied = true;
    }
    function closed(code) {
      clearTimeout(timer);
      signal.removeEventListener('abort', fail);
      if (failed || code !== 0 || !supplied) {
        reject(new Error(refusal));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    }
    const timer = setTimeout(fail, remaining);
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdin.on('finish', sent);
    child.stdout.on('data', read);
    child.stderr.on('data', discard);
    child.once('close', closed);
    signal.addEventListener('abort', fail, { once: true });
    if (signal.aborted) {
      fail();
    } else {
      child.stdin.end(bytes);
    }
  }
  return new Promise(execute);
}

export function createScanOperation(context) {
  const { state, manifest, imageDigest, manifestDigest, clock, fresh, stop, signal } = context;
  const scanner = state.split(' ')[0];

  async function scan(input) {
    try {
      const deadline = clock() + 60000;
      requireScan(Buffer.isBuffer(input.bytes) && input.bytes.length <= 20 * 1024 * 1024);
      // Copy before awaiting Docker so another caller cannot change the supplied frames.
      const bytes = Buffer.from(input.bytes);
      const supplied = frameBytes(bytes);
      requireScan(supplied.sha256 === input.sha256 && supplied.byteCount === input.byteCount);
      const signals = [signal];
      if (input.signal) {
        signals.push(input.signal);
      }
      const cancelled = AbortSignal.any(signals);

      function remaining() {
        const allowance = deadline - fresh();
        requireScan(!cancelled.aborted && allowance > 0);
        return allowance;
      }
      async function inspect() {
        const args = ['inspect', '--format', stateFormat, scanner];
        const observed = await runRequest(args, undefined, remaining(), cancelled);
        remaining();
        requireScan(observed.trim() === state);
      }

      await inspect();
      const args = ['exec', '-i', scanner, 'nc', '127.0.0.1', '3310'];
      const reply = await runRequest(args, supplied.framed, remaining(), cancelled);
      remaining();
      let verdict;
      if (reply === 'stream: OK\0') {
        verdict = 'clean';
      } else if (/^stream: [\x20-\x7e]+ FOUND\0$/.test(reply)) {
        verdict = 'infected';
      } else {
        throw new Error(refusal);
      }
      await inspect();
      const checked = fresh();
      requireScan(checked < deadline);
      const databaseExpiry = Date.parse(manifest.databaseUpdatedAt) + 86400000;
      const expires = Math.min(checked + 120000, databaseExpiry);
      const databases = manifest.databases.map(databaseFacts);
      return { verdict, sha256: supplied.sha256, byteCount: supplied.byteCount,
        imageDigest, manifestDigest, databaseUpdatedAt: manifest.databaseUpdatedAt,
        databases, checkedAt: new Date(checked).toISOString(),
        expiresAt: new Date(expires).toISOString() };
    } catch {
      // Retire the handle: killing a Docker client alone cannot confirm its remote process stopped.
      try {
        await stop();
      } finally {
        throw new Error(refusal);
      }
    }
  }
  return scan;
}
