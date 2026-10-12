import { newDumpFiles } from './private-fault-evidence.mjs';
import { finishQualification } from './private-result.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { command, input, until } from '../../../spikes/s0-3-warm-pool/lab.mjs';

process.chdir(new URL('../../..', import.meta.url).pathname);
const namespace = `p414-private-${randomBytes(4).toString('hex')}`;
const evidencePath = 'docs/process/evidence/p4-14/private-turns.json';
const fixtureImage = 'k3d-ocn-registry:5000/opencrane/s035@sha256:6fe29bfc4455f19601bbca9e3cffa998fed57632484bb3a624a8da69beecee47';
const evidence = { namespace, date: new Date().toISOString(), result: 'PARTIAL', memoryAdmission: 'DISABLED',
  checks: {}, measurements: {}, conditions: {}, limitations: [
    'UID 1003 can write /tmp on node disk, /dev/shm and world-writable workspace directories.',
    'Concurrent private turns share UID 1003; only absent tools separate them.',
    'Bridge memory and supervisor stream buffers can be swapped under F1.',
    'The PVC holds memory-free content and text-free private outlines by design.',
    'Outline counts expose reply size and timing; ids are chosen by the client.',
  ] };
const journeyNames = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7'];
const measurementNames = ['podMounts', 'privateNodeMount', 'privateStatfs', 'writableCensus',
  'coreLimits', 'swapCgroups', 'nodeSwaps', 'hostCorePattern', 'privateHomePeakBytes',
  'initialiseLatency', 'twoTurnPeakMemory', 'runscOptions', 'realFault'];
for (const name of journeyNames) evidence.checks[name] = { result: 'NOT RUN' };
for (const name of measurementNames) evidence.measurements[name] = { result: 'NOT RUN' };
function check(name, passed, detail) {
  evidence.checks[name] = { result: passed ? 'PASS' : 'FAIL', detail };
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'} ${name}\n`);
}
function measurement(name, passed, value) {
  evidence.measurements[name] = { result: passed ? 'PASS' : 'FAIL', value };
}
function acceptedMeasurement(name, value, reason) {
  evidence.measurements[name] = { result: 'ACCEPTED', value, reason };
}
function save() {
  mkdirSync('docs/process/evidence/p4-14', { recursive: true });
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
}
function k(...args) {
  return command('kubectl', ['-n', namespace, ...args]);
}
function apply(value) {
  const args = ['-n', namespace, 'apply', '-f', '-'];
  const contents = JSON.stringify(value);
  return input('kubectl', args, contents);
}
function podExec(source, value = {}, pod = 'private') {
  return input('kubectl', ['-n', namespace, 'exec', '-i', pod, '--', 'node',
    '--input-type=module', '-e', source], JSON.stringify(value));
}
const stdinJson = `let raw='';for await(const chunk of process.stdin)raw+=chunk;const data=JSON.parse(raw);`;
async function provider(route, value) {
  const source = stdinJson + `const response=await fetch('http://127.0.0.1:3000/'+data.route,
    data.value===undefined?{}:{method:'POST',body:JSON.stringify(data.value)});
    console.log(await response.text());`;
  return JSON.parse(await podExec(source, { route, value }, 'backend'));
}
function variants(canary) {
  const bytes = Buffer.from(canary);
  const results = [bytes, Buffer.from(canary, 'utf16le'), Buffer.from(bytes.toString('hex'))];
  for (let offset = 0; offset < 3; offset++) {
    const padded = Buffer.concat([Buffer.alloc(offset), bytes]);
    const encoded = padded.toString('base64');
    const start = offset === 0 ? 0 : 4;
    results.push(Buffer.from(encoded.slice(start, -4)));
  }
  return results;
}
const canaries = {};
for (const kind of ['message', 'context', 'reply', 'reasoning', 'compaction', 'tool', 'alice', 'bob', 'fault', 'prompt']) {
  canaries[kind] = `P414_${kind}_${randomBytes(24).toString('hex')}`;
}
const privateCanaries = { ...canaries };
delete privateCanaries.prompt;

function encodePattern(bytes) {
  return bytes.toString('base64');
}

function patterns() {
  const encoded = {};
  for (const [kind, canary] of Object.entries(privateCanaries)) {
    const bytePatterns = variants(canary);
    encoded[kind] = bytePatterns.map(encodePattern);
  }
  return encoded;
}
async function archive(paths, excluded = []) {
  const args = ['exec', 'k3d-ocn-server-0', 'tar', '-cf', '-'];
  for (const path of excluded) args.push(`--exclude=${path}`);
  args.push(...paths);
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.on('data', function collect(chunk) { chunks.push(chunk); });
  child.stderr.resume();
  await new Promise(function exited(resolve, reject) {
    child.on('error', reject);
    child.on('exit', function finished(code) {
      if (code === 0) resolve();
      else reject(new Error('Node archive unavailable'));
    });
  });
  return Buffer.concat(chunks);
}
function containsPrivate(bytes) {
  const hits = [];
  for (const [kind, canary] of Object.entries(privateCanaries)) {
    if (variants(canary).some(function matches(pattern) { return bytes.includes(pattern); })) hits.push(kind);
  }
  return hits;
}
let created = false;
let driver;
let metadata;
const observedPodIds = new Set();
let homePeak = 0;
let turnCounter = 0;
const terminalTurns = new Set();
const reports = [];
const pending = new Map();
let nextCommand = 0;
let savedPosition = 0;
const savedSequences = new Set();
const crashBefore = new Set(readdirSync('/var/crash'));

async function waitForLoad() {
  while (true) {
    const load = Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
    if (load < 16) return;
    process.stdout.write(`Load is ${load}; waiting before the live probe.\n`);
    await delay(5000);
  }
}

async function startDriver() {
  let ready;
  const readyPromise = new Promise(function register(resolve) { ready = resolve; });
  driver = spawn('kubectl', ['-n', namespace, 'exec', '-i', 'private', '--', 'env',
    `P414_SINCE=${savedPosition}`, 'node', '--experimental-strip-types',
    '/fixture/private-driver.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
  function receive(line) {
    const value = JSON.parse(line);
    if (value.ready) { ready(); return; }
    if (value.report) {
      reports.push(value.report);
      if (value.acknowledged) {
        savedSequences.add(value.report.sequence);
        while (savedSequences.has(savedPosition + 1)) savedPosition++;
      }
      return;
    }
    const settle = pending.get(value.id);
    pending.delete(value.id);
    if (value.error) settle?.reject(new Error('Probe driver refused operation'));
    else settle?.resolve(value.result);
  }
  createInterface({ input: driver.stdout }).on('line', receive);
  driver.stderr.resume();
  await Promise.race([readyPromise, new Promise(function deadline(_resolve, reject) {
    const timer = setTimeout(function expired() { reject(new Error('Probe driver unavailable')); }, 15000);
    timer.unref();
  })]);
}
function drive(operation, value = {}) {
  const id = ++nextCommand;
  if (!driver || !driver.stdin.writable) {
    return Promise.reject(new Error('Probe driver is not connected'));
  }
  return new Promise(function register(resolve, reject) {
    const timer = setTimeout(function expire() {
      pending.delete(id);
      reject(new Error(`Probe driver timed out during ${operation}`));
    }, 30000);
    function resolveCommand(result) {
      clearTimeout(timer);
      resolve(result);
    }
    function rejectCommand(error) {
      clearTimeout(timer);
      reject(error);
    }
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
    driver.stdin.write(JSON.stringify({ id, operation, ...value }) + '\n');
  });
}
function terminal(id) {
  return reports.find(function ended(report) {
    return report.turnId === id && ['agent.turn_failed', 'agent.turn_completed'].includes(report.type);
  });
}
async function turn(marker = 'plain', member = 'alice', memoryFree = false, hold = false) {
  const previousPids = await privatePids();
  const previousHomes = await privateHomes();
  const id = `probe-${++turnCounter}`;
  terminalTurns.add(id);
  const context = memoryFree ? undefined : { exchanges: [{ at: '2026-10-05T00:00:00Z',
    member: canaries.context, assistant: [] }], omittedExchanges: 0 };
  const text = memoryFree ? `P414:${marker} P414_MEMORY_FREE`
    : `P414:${marker} ${canaries.message} ${canaries[member]}`;
  const frame = { type: 'turn', id, conversationId: id, assistantId: 'probe', requesterId: member,
    executionMode: memoryFree ? 'memory_free' : 'restricted', text, attachments: [],
    omittedAttachments: 0, token: 'preparing', expiresAt: Date.now() + 120000 };
  await drive('turn', { frame, context, hold });
  await until(function started() { return reports.some(function matches(report) {
    return report.turnId === id && report.type === 'agent.turn_started';
  }); }, 'turn admission', 20000);
  const currentPids = await privatePids();
  const currentHomes = await privateHomes();
  function newPid(pid) { return !previousPids.includes(pid); }
  function newHome(home) { return !previousHomes.includes(home); }
  return { id, frame, privatePid: currentPids.find(newPid),
    privateHome: currentHomes.find(newHome) };
}
async function ended(turn) {
  await until(function done() { return terminal(turn.id); }, 'turn terminal report', 30000);
  terminalTurns.add(turn.id);
  const started = performance.now();
  async function processRemoved() {
    const pids = await privatePids();
    const homes = await privateHomes();
    return !pids.includes(turn.privatePid) && !homes.includes(turn.privateHome);
  }
  try {
    await until(processRemoved, 'private turn process and home removed', 5000);
    const elapsed = performance.now() - started;
    check(`private release ${turn.id}`, elapsed <= 5000, { elapsed });
  } catch {
    check(`private release ${turn.id}`, false, 'Process or home survived the five-second limit');
    throw new Error('Private process leaked');
  }
}
async function privateHomes() {
  const source = `console.log(JSON.stringify((await import('node:fs')).readdirSync('/home/private')))`;
  return JSON.parse(await podExec(source));
}
async function privatePids() {
  const source = `import {readdirSync,readFileSync} from 'node:fs';const pids=[];
    for(const pid of readdirSync('/proc')){if(!/^\\d+$/.test(pid))continue;try{
      const uid=readFileSync('/proc/'+pid+'/status','utf8');
      const command=readFileSync('/proc/'+pid+'/comm','utf8').trim();
      if(/Uid:\\s+1003\\s/u.test(uid)&&command==='codex')pids.push(Number(pid));
    }catch{}}console.log(JSON.stringify(pids));`;
  return JSON.parse(await podExec(source));
}
async function sendPrivateSignal(pid, signal) {
  const source = stdinJson + `import {spawnSync} from 'node:child_process';
    const child=spawnSync('/usr/bin/setpriv',['--reuid=1003','--regid=1003','--clear-groups',
      '--','/bin/kill',data.signal,String(data.pid)],{stdio:'ignore'});
    if(child.status!==0)process.exit(1);`;
  await podExec(source, { signal, pid });
}
async function waitForPrivateExit(pid) {
  try {
    await until(async function processExited() {
      return !(await privatePids()).includes(pid);
    }, 'killed Codex process exits', 5000);
    return true;
  } catch {
    return false;
  }
}
async function released() {
  try {
    await until(async function clean() {
      return (await privatePids()).length === 0
        && JSON.parse(await podExec(`console.log(JSON.stringify((await import('node:fs')).readdirSync('/home/private')))`)).length === 0;
    }, 'private processes and homes removed', 5000);
  } catch {
    check('private release remaining', false, 'A process or home survived the five-second limit');
    throw new Error('Private process or home leaked');
  }
}
async function scan(name, active = false) {
  const paths = ['/home/agent', '/tmp', '/home/tool', '/run/executor', '/home/codex', '/run/codex', '/dev/shm'];
  const podHits = JSON.parse(await input('kubectl', ['-n', namespace, 'exec', '-i', 'private', '--',
    'node', '/fixture/private-scanner.mjs'], JSON.stringify({ paths, patterns: patterns() })));
  const privateHomeHits = JSON.parse(await input('kubectl', ['-n', namespace, 'exec', '-i', 'private', '--',
    'node', '/fixture/private-scanner.mjs'], JSON.stringify({ paths: ['/home/private'], patterns: patterns() })));
  const privateHomeAllowed = privateHomeHits.every(function inPrivateHome(hit) {
    return active && hit.path.startsWith('/home/private/turn-');
  });
  const pod = JSON.parse(await k('get', 'pod/private', '-o', 'json'));
  metadata = pod.metadata;
  const uid = metadata.uid;
  observedPodIds.add(uid);
  const claim = JSON.parse(await k('get', 'pvc/disk', '-o', 'json'));
  const volumes = JSON.parse(await k('get', 'pv', claim.spec.volumeName, '-o', 'json'));
  const pvcPath = volumes.spec.local?.path ?? volumes.spec.hostPath?.path;
  const nodePaths = [pvcPath];
  for (const observedId of observedPodIds) {
    nodePaths.push(`/var/lib/kubelet/pods/${observedId}`);
    nodePaths.push(`/var/log/pods/${namespace}_private_${observedId}`);
  }
  const existingPaths = await command('docker', ['exec', 'k3d-ocn-server-0', 'sh', '-c',
    'for path do if [ -e "$path" ]; then printf "%s\\n" "$path"; fi; done',
    'scan-paths', ...nodePaths]);
  const pathsToRead = existingPaths.split('\n').filter(function present(path) { return path.length > 0; });
  const nodeBytes = await archive(pathsToRead,
    [`*/${uid}/volumes/kubernetes.io~empty-dir/private*`]);
  const nodeHits = containsPrivate(nodeBytes);
  const privateVolumePath = `/var/lib/kubelet/pods/${uid}/volumes/kubernetes.io~empty-dir/private`;
  const privateVolumeBytes = await archive([privateVolumePath]);
  const privateNodeHits = containsPrivate(privateVolumeBytes);
  const logs = await k('logs', 'private');
  let previous = '';
  const restarts = pod.status.containerStatuses[0].restartCount;
  if (restarts > 0) previous = await k('logs', 'private', '--previous');
  const logHits = containsPrivate(Buffer.from(logs + previous));
  const crashHits = [];
  for (const file of readdirSync('/var/crash')) {
    if (crashBefore.has(file)) continue;
    crashHits.push(file);
  }
  const sizes = JSON.parse(await podExec(`import {readdirSync,lstatSync} from 'node:fs';
    function size(path){let total=0;for(const name of readdirSync(path)){const next=path+'/'+name;
      const stat=lstatSync(next);total+=stat.isDirectory()?size(next):stat.size}return total}
    const homes=[];
    for(const name of readdirSync('/home/private'))homes.push({name,bytes:size('/home/private/'+name)});
    console.log(JSON.stringify(homes));`));
  for (const home of sizes) homePeak = Math.max(homePeak, home.bytes);
  const privateVolumeAllowed = active || privateNodeHits.length === 0;
  check(`${name} scans`, !podHits.length && privateHomeAllowed && !nodeHits.length
    && privateVolumeAllowed && !logHits.length && !crashHits.length,
    { podHits, privateHomeHits, nodeHits, privateNodeHits, logHits, crashHits });
  if (!active) await released();
}
async function journey(name, run) {
  const previousFailures = Object.keys(evidence.checks).filter(function failed(key) {
    return evidence.checks[key].result === 'FAIL';
  });
  try {
    await run();
    const failures = Object.keys(evidence.checks).filter(function failed(key) {
      return evidence.checks[key].result === 'FAIL' && !previousFailures.includes(key);
    });
    check(name, failures.length === 0, failures);
  } catch (error) { check(name, false, error.message); }
}
async function guestInventory(value) {
  const args = ['-n', namespace, 'exec', '-i', 'private', '--',
    '/usr/bin/python3', '/fixture/private-inventory.py'];
  return JSON.parse(await input('kubectl', args, JSON.stringify(value)));
}

async function nodeInventory() {
  const nodePid = await command('docker', ['inspect', 'k3d-ocn-server-0', '--format', '{{.State.Pid}}']);
  const pod = JSON.parse(await k('get', 'pod/private', '-o', 'json'));
  const containerId = pod.status.containerStatuses[0].containerID.split('://')[1];
  const root = `/proc/${nodePid}/root`;
  const paths = ['/var/crash', '/var/lib/systemd/coredump', '/var/log/apport.log',
    '/var/log/kern.log', '/var/log/syslog'];
  const nodePaths = ['/var/crash', '/var/lib/systemd/coredump', '/tmp',
    `/var/log/pods/${namespace}_private_${pod.metadata.uid}`,
    `/run/k3s/containerd/io.containerd.runtime.v2.task/k8s.io/${containerId}`,
    `/var/lib/rancher/k3s/agent/containerd/io.containerd.runtime.v2.task/k8s.io/${containerId}`];
  for (const path of nodePaths) paths.push(root + path);
  const nodeLog = await command('docker', ['inspect', 'k3d-ocn-server-0', '--format', '{{.LogPath}}']);
  if (nodeLog) paths.push(nodeLog);
  const args = ['-n', 'python3', 'apps/computer/test/private-inventory.py'];
  return JSON.parse(await input('sudo', args, JSON.stringify({ paths })));
}

async function realFault(turn) {
  const census = await guestInventory({ operation: 'census' });
  const paths = [...census.directories, ...census.files];
  function topLevel(path) {
    return !paths.some(function parent(other) { return other !== path && path.startsWith(other + '/'); });
  }
  const roots = paths.filter(topLevel);
  const corePattern = await podExec(`console.log((await import('node:fs')).readFileSync('/proc/sys/kernel/core_pattern','utf8'))`);
  const beforeGuest = await guestInventory({ paths: roots });
  const beforeNode = await nodeInventory();
  const args = ['-n', namespace, 'exec', '-i', 'private', '--',
    '/usr/bin/prlimit', '--core=0:0', '--', '/usr/bin/setpriv',
    '--reuid=1003', '--regid=1003', '--clear-groups', '--no-new-privs', '--',
    'node', '/fixture/private-fault.mjs'];
  const faultInput = JSON.stringify({ pid: turn.privatePid, canary: canaries.fault });
  const fault = JSON.parse(await input('kubectl', args, faultInput));
  const afterGuest = await guestInventory({ paths: roots });
  const afterNode = await nodeInventory();
  const dumps = [...newDumpFiles(beforeGuest.files, afterGuest.files),
    ...newDumpFiles(beforeNode.files, afterNode.files)];
  const sameConditions = JSON.stringify(fault.target) === JSON.stringify(fault.helper);
  const passed = fault.signal === 'SIGSEGV' && fault.code === null && sameConditions && dumps.length === 0;
  measurement('realFault', passed, { fault, sameConditions, dumps, census, corePattern,
    beforeGuest, afterGuest, beforeNode, afterNode,
    scope: 'Native helper in the same Pod and private RAM home. Codex SIGSEGV handler is not executed.' });
  check('J4 real memory fault without a new dump', passed, { signal: fault.signal, sameConditions, dumps });
}

async function measureRunning() {
  const pids = await privatePids();
  const source = stdinJson + `import {readFileSync,readdirSync,statfsSync} from 'node:fs';
    let bridge;for(const pid of readdirSync('/proc')){try{if(readFileSync('/proc/'+pid+'/cmdline','utf8')
      .includes('/app/src/bridge.ts')){bridge=pid;break}}catch{}}
    const fs=statfsSync('/home/private');console.log(JSON.stringify({mounts:readFileSync('/proc/mounts','utf8'),
      privateStatfs:{type:fs.type,bytes:fs.bsize*fs.blocks},
      bridgeLimits:readFileSync('/proc/'+bridge+'/limits','utf8'),
      privateLimits:readFileSync('/proc/'+data.pid+'/limits','utf8')}));`;
  if (!pids.length) throw new Error('No private process available to measure');
  const values = JSON.parse(await podExec(source, { pid: pids[0] }));
  measurement('podMounts', true, values.mounts);
  values.privateStatfs.enforces16Mi = values.privateStatfs.bytes <= 16 * 1024 * 1024;
  values.privateStatfs.limitEnforced = values.privateStatfs.bytes <= 16 * 1024 * 1024;
  measurement('privateStatfs', values.privateStatfs.limitEnforced, values.privateStatfs);
  const limits = values.bridgeLimits + values.privateLimits;
  const zeroCore = (limits.match(/Max core file size\s+0\s+0/gu) ?? []).length === 2;
  measurement('coreLimits', zeroCore, { bridge: values.bridgeLimits, private: values.privateLimits });
  evidence.conditions.F2.guest = zeroCore ? 'PASS' : 'FAIL';
  const census = await guestInventory({ operation: 'census' });
  const writable = [...census.directories, ...census.files];
  function allowedPath(path) {
    return path === '/tmp' || path.startsWith('/tmp/') || path === '/dev/shm'
      || path.startsWith('/dev/shm/') || path.startsWith('/home/private/turn-');
  }
  const expected = census.directories.includes('/tmp') && census.directories.includes('/dev/shm');
  const hasPrivateHome = writable.some(function home(path) {
    return path.startsWith('/home/private/turn-');
  });
  measurement('writableCensus', expected && hasPrivateHome && writable.every(allowedPath), census);
  const nodeMounts = await command('docker', ['exec', 'k3d-ocn-server-0', 'cat', '/proc/mounts']);
  const ownMount = nodeMounts.split('\n').filter(function own(line) {
    return line.includes(metadata.uid) && line.includes('/private');
  });
  measurement('privateNodeMount', ownMount.some(function ram(line) { return line.includes(' tmpfs '); }), ownMount);
  const runtimeOptions = await command('docker', ['exec', 'k3d-ocn-server-0', 'sh', '-c',
    "awk '/runsc/ {inside=1} inside && /^\\[/ && !/runsc/ {exit} inside {print}' "
      + '/var/lib/rancher/k3s/agent/etc/containerd/config.toml; '
      + "find /var/lib/rancher/k3s -type f -name runsc.toml -print -exec cat {} \\;"]);
  measurement('runscOptions', !/debug-log|strace|debug\s*=\s*(true|"?1)/iu.test(runtimeOptions),
    runtimeOptions);
  const cgroups = await command('docker', ['exec', 'k3d-ocn-server-0', 'sh', '-c',
    `find /sys/fs/cgroup -type d -name '*${metadata.uid.replaceAll('-', '_')}*' -o -name '*${metadata.uid}*'`]);
  const group = cgroups.split('\n').find(function path(path) { return path.includes('pod'); });
  if (group) {
    const swap = await command('docker', ['exec', 'k3d-ocn-server-0', 'sh', '-c',
      `find '${group}' -name memory.swap.max -exec sh -c 'printf "%s " "$1"; cat "$1"' sh {} \\;`]);
    acceptedMeasurement('swapCgroups', swap,
      'Host swap is accepted on this dev box for the MVP; see #366.');
    const peak = await command('docker', ['exec', 'k3d-ocn-server-0', 'sh', '-c',
      `find '${group}' -name memory.peak -exec sh -c 'printf "%s " "$1"; cat "$1"' sh {} \\;`]);
    measurement('twoTurnPeakMemory', true, peak);
  }
}

await waitForLoad();
const hostSwaps = readFileSync('/proc/swaps', 'utf8');
const hostCorePattern = readFileSync('/proc/sys/kernel/core_pattern', 'utf8').trim();
evidence.conditions.F1 = { result: 'ACCEPTED (dev box, owner 12 Oct, #366)',
  hostSwaps, reason: 'Host swap is a post-MVP gap tracked in #366.' };
evidence.conditions.F2 = { result: 'ACCEPTED (dev box, owner 12 Oct, #366)',
  guest: 'NOT RUN', hostCorePattern };
acceptedMeasurement('hostCorePattern', hostCorePattern,
  'Host apport crash dumps are accepted on this dev box for the MVP; see #366.');
try {
  evidence.sourceCommit = await command('git', ['rev-parse', 'HEAD']);
  if (await command('kubectl', ['config', 'current-context']) !== 'k3d-ocn') throw new Error('k3d-ocn unavailable');
  if (await k('get', 'ns', namespace, '--ignore-not-found')) throw new Error('Probe namespace already exists');
  mkdirSync('apps/computer/.state', { recursive: true });
  await command('gcc', ['-static', '-s', '-O2', '-Wall', '-Wextra', '-Werror',
    'apps/computer/test/private-fault.c', '-o', 'apps/computer/.state/private-fault']);
  const template = JSON.parse(readFileSync('apps/computer/sandbox-template.json', 'utf8'));
  evidence.image = template.spec.podTemplate.spec.containers[0].image;
  await apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } });
  created = true;
  await apply({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'provider' }, data: {
    'private-provider.mjs': readFileSync('apps/computer/test/private-provider.mjs', 'utf8'),
    'private-driver.mjs': readFileSync('apps/computer/test/private-driver.mjs', 'utf8'),
    'private-scanner.mjs': readFileSync('apps/computer/test/private-scanner.mjs', 'utf8'),
    'private-fault.mjs': readFileSync('apps/computer/test/private-fault.mjs', 'utf8'),
    'private-inventory.py': readFileSync('apps/computer/test/private-inventory.py', 'utf8') },
    binaryData: { 'private-fault': readFileSync('apps/computer/.state/private-fault').toString('base64') } });
  await apply({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'backend',
    labels: { app: 'opencrane-gateway' } }, spec: { automountServiceAccountToken: false,
    terminationGracePeriodSeconds: 0, containers: [{ name: 'provider', image: fixtureImage,
      command: ['node', '/fixture/private-provider.mjs'], volumeMounts: [{ name: 'fixture', mountPath: '/fixture' }] }],
    volumes: [{ name: 'fixture', configMap: { name: 'provider' } }] } });
  await k('wait', '--for=condition=Ready', 'pod/backend', '--timeout=120s');
  const backend = JSON.parse(await k('get', 'pod/backend', '-o', 'json')).status.podIP;
  await provider('setup', canaries);
  await apply(JSON.parse(readFileSync('apps/computer/network-policy.json', 'utf8')));
  await apply({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'computer-runtime' },
    data: { gateway: `http://${backend}:3000` } });
  await apply({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'disk' },
    spec: { storageClassName: 'local-path', accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '1Gi' } } } });
  const spec = structuredClone(template.spec.podTemplate.spec);
  spec.volumes[0] = { name: 'home', persistentVolumeClaim: { claimName: 'disk' } };
  spec.volumes.push({ name: 'fixture', configMap: { name: 'provider', defaultMode: 0o555 } });
  spec.containers[0].volumeMounts.push({ name: 'fixture', mountPath: '/fixture', readOnly: true });
  await apply({ apiVersion: 'agents.x-k8s.io/v1beta1', kind: 'Sandbox', metadata: { name: 'private' },
    spec: { podTemplate: { metadata: { labels: { app: 'computer' } }, spec } } });
  await until(async function exists() { return await k('get', 'pod/private', '--ignore-not-found'); }, 'computer Pod');
  await k('wait', '--for=condition=Ready', 'pod/private', '--timeout=180s');
  metadata = JSON.parse(await k('get', 'pod/private', '-o', 'json')).metadata;
  await podExec(stdinJson + `import {mkdirSync,writeFileSync} from 'node:fs';
    process.setgroups([]);process.setgid(1001);process.setuid(1001);
    mkdirSync('/workspace/.agents/skills/probe',{recursive:true});
    writeFileSync('/workspace/AGENTS.md',data.prompt);
    writeFileSync('/workspace/.agents/skills/probe/SKILL.md',data.prompt);`, { prompt: canaries.prompt });
  const nodeSwaps = await command('docker', ['exec', 'k3d-ocn-server-0', 'cat', '/proc/swaps']);
  acceptedMeasurement('nodeSwaps', nodeSwaps,
    'Host swap is accepted on this dev box for the MVP; see #366.');
  await startDriver();
  await journey('J1', async function completes() {
    const plain = await turn(); await ended(plain);
    const reasoning = await turn('reasoning'); await ended(reasoning);
    check('reply and reasoning delivered', reports.some(function reply(report) { return report.text?.includes(canaries.reply); })
      && reports.some(function reasoning(report) { return report.text?.includes(canaries.reasoning); }));
    await scan('J1');
  });
  await journey('J2', async function concurrent() {
    const alice = await turn('heldAlice');
    const bob = await turn('heldBob', 'bob');
    const tools = await turn('plain', 'alice', true);
    await ended(tools);
    await until(async function both() { return (await privatePids()).length === 2; }, 'two private processes');
    await scan('J2 held', true); await measureRunning();
    await provider('release', {}); await ended(alice); await ended(bob); await scan('J2');
  });
  await journey('J3', async function stops() {
    const active = await turn('heldStop'); await scan('J3 held', true);
    const beforeRequests = (await provider('requests')).length;
    const stoppedAt = performance.now();
    await drive('stop', { frame: { type: 'stop', turnId: active.id, conversationId: active.id } });
    await ended(active);
    check('J3 Stop failed terminal', terminal(active.id)?.type === 'agent.turn_failed');
    check('J3 Stop bounded cleanup', performance.now() - stoppedAt <= 5000);
    await delay(500);
    check('J3 Stop no repeat', (await provider('requests')).length === beforeRequests);
    await scan('J3');
  });
  await journey('J4', async function crashes() {
    const doomed = await turn('heldCrash');
    const other = await turn('heldOther', 'bob');
    await scan('J4 held', true);
    await realFault(doomed);
    const beforeRequests = (await provider('requests')).length;
    const killStarted = performance.now();
    await sendPrivateSignal(doomed.privatePid, '-9');
    const exited = await waitForPrivateExit(doomed.privatePid);
    check('J4 SIGKILL process exits', exited);
    if (!exited) throw new Error('Private process survived SIGKILL');
    await ended(doomed);
    check('J4 SIGKILL failed terminal', terminal(doomed.id)?.type === 'agent.turn_failed');
    check('J4 SIGKILL bounded cleanup', performance.now() - killStarted <= 5000);
    await provider('release', {});
    await ended(other);
    await delay(500);
    check('J4 SIGKILL no repeat', (await provider('requests')).length === beforeRequests);
    await scan('J4');
  });
  await journey('J5', async function reconnects() {
    const active = await turn('heldReconnect'); await scan('J5 held', true);
    await drive('reconnect', { since: savedPosition });
    await provider('release', {}); await ended(active); await scan('J5');
  });
  await journey('J6', async function restarts() {
    for (const replacement of [false, true]) {
      const active = await turn('heldRestart', 'alice', false, true);
      await until(function delta() { return reports.some(function output(report) {
        return report.turnId === active.id && report.type === 'agent.message_delta';
      }); }, 'unacknowledged text');
      await scan(`J6 ${replacement} held`, true);
      const beforeRequests = (await provider('requests')).length;
      const old = JSON.parse(await k('get', 'pod/private', '-o', 'json'));
      driver.stdin.end();
      if (replacement) {
        await k('delete', 'pod/private', '--wait=true');
        await until(async function replaced() {
          const pod = JSON.parse(await k('get', 'pod/private', '-o', 'json'));
          return pod.metadata.uid !== old.metadata.uid;
        }, 'new Pod');
      } else {
        await podExec(`import {readdirSync,readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
          for(const pid of readdirSync('/proc')){try{if(readFileSync('/proc/'+pid+'/cmdline','utf8').includes('/app/src/bridge.ts')){
            spawnSync('/usr/bin/setpriv',['--reuid=1000','--regid=1000','--clear-groups','--','/bin/kill','-9',pid],{stdio:'ignore'});break}}catch{}}`);
        await until(async function restarted() {
          const pod = JSON.parse(await k('get', 'pod/private', '-o', 'json'));
          return pod.status.containerStatuses[0].restartCount > old.status.containerStatuses[0].restartCount;
        }, 'container restarted');
      }
      await k('wait', '--for=condition=Ready', 'pod/private', '--timeout=180s');
      await startDriver(); await ended(active);
      check(`J6 ${replacement} lost output`, reports.some(function lost(report) {
        return report.turnId === active.id && report.type === 'agent.output_lost';
      }));
      await drive('turn', { frame: { ...active.frame, expiresAt: Date.now() + 120000 } });
      await new Promise(function settle(resolve) { setTimeout(resolve, 500); });
      check(`J6 ${replacement} no repeat`, (await provider('requests')).length === beforeRequests);
      const fresh = await turn(); await ended(fresh); await scan(`J6 ${replacement}`);
    }
  });
  await journey('J7', async function refusesToolsAndCompacts() {
    for (const tool of ['exec_command', 'apply_patch', 'exec', 'request_user_input']) {
      const attempt = await turn(tool); await ended(attempt); await scan(`J7 ${tool}`);
      const requests = await provider('requests');
      check(`J7 ${tool} provider attempted`, requests.some(function attempted(request) {
        return request.marker === tool;
      }));
    }
    const direct = await drive('direct', { compact: true, text: `P414:compact ${canaries.compaction}` });
    const requests = await provider('requests');
    const compactions = requests.filter(function compact(request) { return request.marker === 'compact'; });
    check('direct ephemeral compaction', direct.compactCompleted && compactions.length >= 2,
      { notifications: direct.notifications, requests: compactions.length });
    await scan('J7 compact');
    const file = await podExec(`console.log((await import('node:fs')).existsSync('/tmp/private-tool-file'))`);
    check('tools created no file', file.trim() === 'false');
  });
  const latencies = [];
  for (let index = 0; index < 10; index++) latencies.push((await drive('direct')).elapsed);
  latencies.sort(function ascending(first, second) { return first - second; });
  measurement('initialiseLatency', true, { samples: latencies, p50: latencies[4], p95: latencies[9],
    method: 'Private socket connection request to initialise result, including process spawn' });
  measurement('privateHomePeakBytes', true, { bytes: homePeak,
    method: 'Largest single home sampled during held replies and after journeys' });
  await released();
  const requests = await provider('requests');
  const bobMarkers = new Set(['heldBob', 'heldOther']);
  const forbidden = new Set(['exec_command', 'shell', 'local_shell', 'write_stdin', 'apply_patch',
    'exec', 'js_repl', 'view_image', 'read_file', 'list_dir', 'grep_files', 'image_generation',
    'web_search', 'spawn_agent']);
  const toolsByRequest = [];
  let safe = true;
  let toolsSafe = true;
  for (const request of requests) {
    const body = JSON.stringify(request.body);
    const memoryFree = body.includes('P414_MEMORY_FREE');
    if (body.includes(canaries.prompt)) safe = false;
    if (memoryFree && body.includes(canaries.context)) safe = false;
    if (body.includes(canaries.alice) && body.includes(canaries.bob)) safe = false;
    const expectedMember = bobMarkers.has(request.marker) ? 'bob' : 'alice';
    if (body.includes(canaries.alice) && expectedMember !== 'alice') safe = false;
    if (body.includes(canaries.bob) && expectedMember !== 'bob') safe = false;
    const names = (request.body.tools ?? []).map(function name(tool) { return tool.name ?? tool.type; });
    toolsByRequest.push({ thread: request.thread, memoryFree, names });
    if (!memoryFree && names.some(function forbiddenTool(name) {
      return forbidden.has(name) || name.startsWith('mcp__');
    })) toolsSafe = false;
  }
  check('provider isolation', safe);
  check('advertised private tools', toolsSafe, toolsByRequest);
  for (const turnId of terminalTurns) {
    const sequences = new Set();
    const turnReports = reports.filter(function belongsToTurn(report) {
      return report.turnId === turnId;
    });
    for (const report of reports) {
      if (report.turnId === turnId && ['agent.turn_failed', 'agent.turn_completed'].includes(report.type)) sequences.add(report.sequence);
    }
    check(`one terminal ${turnId}`, sequences.size === 1, turnReports);
  }
  const journal = await podExec(`console.log((await import('node:fs')).readFileSync('/home/agent/codex/bridge-reports.jsonl','utf8'))`);
  const lines = journal.trim().split('\n').map(function parse(line) { return JSON.parse(line); });
  check('outline journal', lines.some(function outline(report) { return report.memoryOnly; })
    && lines.every(function noPrivateText(report) { return !report.memoryOnly || report.text === undefined; }));
} catch (error) {
  evidence.error = error.message;
  if (!created) evidence.infrastructure = 'NOT RUN';
} finally {
  driver?.stdin.end();
  try {
    if (created) await k('delete', 'namespace', namespace, '--wait=true', '--timeout=120s');
  } catch (error) {
    evidence.error = `Namespace cleanup failed: ${error.message}`;
  }
  finishQualification(evidence);
  save();
}
