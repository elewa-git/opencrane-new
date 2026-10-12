import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { body, json, record } from './http.ts';

const execute = promisify(execFile);
const GATE_FILE = '/home/agent/supervisor/stopped.json';
const CONTROL_SOCKET = '/run/executor/supervisor/control.sock';
const EXIT_LIMIT_MS = 10_000;
const EXECUTION_UIDS = [1001, 1003];
interface StopRequest {
  generation: number;
  podUid: string;
  takeoverId: string;
  affectedTurnIds: string[];
}
interface Gate extends StopRequest {
  epoch: string;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
    throw new Error('Invalid stop reference');
  }
  return value;
}

function readStopRequest(value: unknown): StopRequest {
  const input = record(value);
  const generation = input['generation'];
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Invalid generation');
  }
  const podUid = identifier(input['podUid']);
  if (podUid !== process.env['POD_UID']) throw new Error('Different Pod');
  const takeoverId = identifier(input['takeoverId']);
  const turnIds = input['affectedTurnIds'];
  if (!Array.isArray(turnIds) || turnIds.length > 64) throw new Error('Invalid affected turns');
  const affectedTurnIds = turnIds.map(identifier);
  if (new Set(affectedTurnIds).size !== affectedTurnIds.length) {
    throw new Error('Repeated affected turn');
  }
  return { generation, podUid, takeoverId, affectedTurnIds };
}

function ignoreExitedTask(error: unknown) {
  // Ignore only an exit during observation. Missing permissions are not quiet proof.
  if (!error || typeof error !== 'object' || !('code' in error)
    || error.code !== 'ENOENT') throw error;
}

function hasLiveExecutionThread(pid: string) {
  for (const thread of readdirSync(`/proc/${pid}/task`)) {
    try {
      const status = readFileSync(`/proc/${pid}/task/${thread}/status`, 'utf8');
      const uid = Number(/^Uid:\s+(\d+)/mu.exec(status)?.[1]);
      if (!Number.isSafeInteger(uid)) throw new Error('Task identity unavailable');
      if (!EXECUTION_UIDS.includes(uid)) continue;
      const state = /^State:\s+(\S)/mu.exec(status)?.[1];
      if (!state) throw new Error('Task state unavailable');
      // Check workers even when their main thread is a zombie.
      if (state !== 'Z' && state !== 'X') return true;
    } catch (error) {
      ignoreExitedTask(error);
    }
  }
  return false;
}

function hasLiveExecutionTasks() {
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      if (hasLiveExecutionThread(name)) return true;
    } catch (error) {
      ignoreExitedTask(error);
    }
  }
  return false;
}

async function stopProcesses(deadline: number) {
  for (const uid of EXECUTION_UIDS) {
    // Ignore tool-owned Python settings when running the termination helper.
    const args = [`--reuid=${uid}`, `--regid=${uid}`, '--clear-groups', '--no-new-privs', '--',
      '/usr/bin/python3', '-I', '/app/src/stop-processes.py'];
    const remainingMs = Math.floor(deadline - performance.now());
    if (remainingMs <= 0) throw new Error('Executor exit unavailable');
    const options = { timeout: remainingMs };
    await execute('/usr/bin/setpriv', args, options);
  }
}

async function proveExecutionStopped() {
  const deadline = performance.now() + EXIT_LIMIT_MS;
  while (true) {
    // Kill before scanning. The kernel prevents a fork from escaping this signal walk.
    await stopProcesses(deadline);
    await delay(25);
    const liveTasks = hasLiveExecutionTasks();
    if (performance.now() >= deadline) throw new Error('Executor exit unavailable');
    if (!liveTasks) return;
  }
}

function saveGate(gate: Gate) {
  // Save denial before stopping work. A crash must never reopen executor admission.
  const descriptor = openSync(GATE_FILE, 'wx', 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(gate));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const directory = openSync('/home/agent/supervisor', 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function supervisorStop() {
  // Keep even a damaged saved gate closed. This file records denial, never permission.
  let denied = existsSync(GATE_FILE);
  let gate: Gate | undefined;
  let stopping: Promise<void> | undefined;
  const sockets = new Set<Socket>();

  function admit(socket: Socket) {
    if (denied) {
      socket.destroy();
      return false;
    }
    sockets.add(socket);
    function closed() {
      sockets.delete(socket);
    }
    socket.once('close', closed);
    return true;
  }

  function restoreGate() {
    const saved = record(JSON.parse(readFileSync(GATE_FILE, 'utf8')) as unknown);
    const input = readStopRequest(saved);
    return { ...input, epoch: identifier(saved['epoch']) };
  }

  function sameRequest(input: StopRequest, saved: Gate) {
    const previous = { generation: saved.generation, podUid: saved.podUid,
      takeoverId: saved.takeoverId, affectedTurnIds: saved.affectedTurnIds };
    return JSON.stringify(input) === JSON.stringify(previous);
  }

  async function stop(input: StopRequest) {
    if (denied && !gate) gate = restoreGate();
    if (gate && !sameRequest(input, gate)) throw new Error('Different stop request');
    if (!gate) {
      denied = true;
      for (const socket of sockets) {
        socket.destroy();
      }
      const nextGate = { ...input, epoch: randomUUID() };
      saveGate(nextGate);
      gate = nextGate;
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    if (!stopping) stopping = proveExecutionStopped();
    try {
      await stopping;
    } finally {
      stopping = undefined;
    }
    return { kind: 'executor_stop', ...gate, executionQuiet: true, executionInventory: [],
      quietProof: 'unavailable', controlEnabled: false };
  }

  async function receive(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== 'POST' || request.url !== '/stop') throw new Error('Unknown request');
    const input = readStopRequest(await body(request));
    const receipt = await stop(input);
    // Report only executor exit. Browser connections and queued input still need proof.
    json(response, receipt);
  }

  function incoming(request: IncomingMessage, response: ServerResponse) {
    function failed() {
      const refusal = { error: 'Stop proof unavailable', controlEnabled: false };
      json(response, refusal, 400);
    }
    void receive(request, response).catch(failed);
  }
  const server = createServer(incoming);
  server.requestTimeout = 2000;
  server.listen(CONTROL_SOCKET);
  return { admit };
}
