import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { command, input, until } from '../../../spikes/s0-3-warm-pool/lab.mjs';

process.chdir(new URL('../../..', import.meta.url).pathname);
const namespace = 'p414-private';
const evidencePath = 'docs/process/evidence/p4-14/private-turns.json';
const fixtureImage = 'k3d-ocn-registry:5000/opencrane/s035@sha256:6fe29bfc4455f19601bbca9e3cffa998fed57632484bb3a624a8da69beecee47';
const evidence = { date: new Date().toISOString(), result: 'PARTIAL', memoryAdmission: 'DISABLED',
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
  'initialiseLatency', 'twoTurnPeakMemory', 'runscOptions'];
for (const name of journeyNames) evidence.checks[name] = { result: 'NOT RUN' };
for (const name of measurementNames) evidence.measurements[name] = { result: 'NOT RUN' };
function check(name, passed, detail) {
  evidence.checks[name] = { result: passed ? 'PASS' : 'FAIL', detail };
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'} ${name}\n`);
}
function measurement(name, passed, value) {
  evidence.measurements[name] = { result: passed ? 'PASS' : 'FAIL', value };
}
function save() {
  mkdirSync('docs/process/evidence/p4-14', { recursive: true });
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
}
function k(...args) { return command('kubectl', ['-n', namespace, ...args]); }
function apply(value) { return input('kubectl', ['-n', namespace, 'apply', '-f', '-'], JSON.stringify(value)); }
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
for (const kind of ['message', 'context', 'reply', 'reasoning', 'compaction', 'tool', 'alice', 'bob', 'prompt']) {
  canaries[kind] = `P414_${kind}_${randomBytes(24).toString('hex')}`;
}
const privateCanaries = { ...canaries };
delete privateCanaries.prompt;
const scanner = stdinJson + `
import {lstatSync,readdirSync,readFileSync} from 'node:fs';
const hits=[];
function visit(path){
  let stat;try{stat=lstatSync(path)}catch{return}
  if(stat.isSymbolicLink())return;
  if(stat.isDirectory()){let names;try{names=readdirSync(path)}catch{return}
    for(const name of names)visit(path+'/'+name);return}
  if(!stat.isFile())return;
  let bytes;try{bytes=readFileSync(path)}catch{return}
  for(const [kind,patterns] of Object.entries(data.patterns)){
    if(patterns.some(function matches(pattern){return bytes.includes(Buffer.from(pattern,'base64'))})){
      hits.push({path,kind});break}}
}
for(const path of data.paths)visit(path);
console.log(JSON.stringify(hits));`;
function patterns() {
  const encoded = {};
  for (const [kind, canary] of Object.entries(privateCanaries)) {
    encoded[kind] = variants(canary).map(function encode(bytes) { return bytes.toString('base64'); });
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
const driverSource = `
import {WebSocket} from '/app/node_modules/ws/wrapper.mjs';
import {createInterface} from 'node:readline';
import {connect} from 'node:net';
import {codexConnection} from '/app/src/codex-connection.ts';
import {once} from 'node:events';
let socket;let since=Number(process.env.P414_SINCE??0);
const settings=new Map();
async function open(){
 await fetch('http://127.0.0.1:8081/credentials',{method:'POST',body:JSON.stringify({
  id:'probe',value:'probe-computer',expiresAt:Date.now()+600000})});
 socket=new WebSocket('ws://127.0.0.1:8081/bridge',{headers:{'x-bridge-token':'probe-computer'}});
 socket.on('error',function failed(){});
 socket.on('message',function received(raw){const report=JSON.parse(raw.toString());
  const setting=settings.get(report.turnId)??{};
  const context=setting.context;
  const acknowledged=!setting.hold||!['agent.message_delta','agent.message_completed','agent.reasoning_summarised'].includes(report.type);
  console.log(JSON.stringify({report,acknowledged}));
  if(acknowledged)socket.send(JSON.stringify({type:'ack',sequence:report.sequence,
   token:'probe-turn',expiresAt:Date.now()+120000,...(report.type==='agent.turn_started'&&context!==undefined?{context}:{})}));
 });
 await once(socket,'open');socket.send(JSON.stringify({type:'resume',since}));
}
await open();console.log(JSON.stringify({ready:true}));
async function execute(data){
 if(data.operation==='turn'){settings.set(data.frame.id,{context:data.context,hold:data.hold??false});socket.send(JSON.stringify(data.frame));return {}}
 if(data.operation==='stop'){socket.send(JSON.stringify(data.frame));return {}}
 if(data.operation==='reconnect'){socket.terminate();await once(socket,'close');since=data.since;await open();return {}}
 if(data.operation==='direct'){
  if(process.getuid()!==1000){
   process.setgroups([]);process.setgid(1000);process.setuid(1000);
  }
  const started=performance.now();
  const session=connect('/run/executor/private.sock');
  const notifications=[];
  function received(message){
   if(message.id!==undefined&&typeof message.method==='string'){
    connection.reply(message.id,{code:-32601,message:'Not available in a private turn'});
    return;
   }
   notifications.push(message);
  }
  function failed(){session.destroy()}
  const connection=codexConnection(session,session,{message:received,failed});
  try{
  await once(session,'connect');
  await connection.rpc('initialize',{clientInfo:{name:'probe',version:'1'},capabilities:{experimentalApi:true}});
  connection.notify('initialized',{});const elapsed=performance.now()-started;
  if(data.compact){const response=await connection.rpc('thread/start',{
   model:'gpt-6.1-sol',approvalPolicy:'never',sandbox:'read-only',ephemeral:true,environments:[]});
   const thread=response.thread.id;
   const http=await import('node:http');
   await new Promise(function grant(resolve,reject){const request=http.request({socketPath:'/run/codex/control.sock',
    path:'/grant',method:'POST'},function received(response){response.resume();response.on('end',resolve)});
    request.on('error',reject);request.end(JSON.stringify({thread,computer:'probe-computer',token:'probe-turn',expires:Date.now()+120000}))});
   await connection.rpc('turn/start',{threadId:thread,input:[{type:'text',text:data.text,text_elements:[]}]});
   const deadline=Date.now()+20000;while(!notifications.some(function ended(event){return event.method==='turn/completed'})&&Date.now()<deadline){await new Promise(function wait(resolve){setTimeout(resolve,20)})}
   const previousCount=notifications.length;
   await connection.rpc('thread/compact/start',{threadId:thread});
   function compactCompleted(){return notifications.slice(previousCount).some(function compact(event){
    return event.method==='thread/compacted'||(event.method==='item/completed'
     &&event.params?.item?.type==='contextCompaction')})}
   const compactDeadline=Date.now()+20000;
   while(!compactCompleted()&&Date.now()<compactDeadline){
    await new Promise(function wait(resolve){setTimeout(resolve,20)})
   }
   return {elapsed,compactCompleted:compactCompleted(),
    notifications:notifications.map(function name(event){return event.method})};
  }
  return {elapsed,notifications:notifications.map(function name(event){return event.method})};
  }finally{session.destroy()}
 }
 return {};
}
const lines=createInterface({input:process.stdin});
let queue=Promise.resolve();
function received(line){const data=JSON.parse(line);
 async function run(){try{const result=await execute(data);console.log(JSON.stringify({id:data.id,result}))}
 catch(error){console.log(JSON.stringify({id:data.id,error:error.name}))}}
 queue=queue.then(run);
}
lines.on('line',received);lines.on('close',function close(){socket.terminate();process.exit(0)});
`;
async function startDriver() {
  let ready;
  const readyPromise = new Promise(function register(resolve) { ready = resolve; });
  driver = spawn('kubectl', ['-n', namespace, 'exec', '-i', 'private', '--', 'env',
    `P414_SINCE=${savedPosition}`, 'node', '--experimental-strip-types', '--input-type=module',
    '-e', driverSource], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  function register(resolve, reject) { pending.set(id, { resolve, reject }); }
  const result = new Promise(register);
  driver.stdin.write(JSON.stringify({ id, operation, ...value }) + '\n');
  return result;
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
      if(/Uid:\\s+1003\\s/u.test(readFileSync('/proc/'+pid+'/status','utf8'))
        &&readFileSync('/proc/'+pid+'/cmdline','utf8').includes('app-server'))pids.push(Number(pid));
    }catch{}}console.log(JSON.stringify(pids));`;
  return JSON.parse(await podExec(source));
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
  const podHits = JSON.parse(await podExec(scanner, { paths, patterns: patterns() }));
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
  const logs = await k('logs', 'private');
  let previous = '';
  try { previous = await k('logs', 'private', '--previous'); } catch { /* No previous container yet. */ }
  const logHits = containsPrivate(Buffer.from(logs + previous));
  const crashHits = [];
  for (const file of readdirSync('/var/crash')) {
    if (crashBefore.has(file)) continue;
    if (containsPrivate(readFileSync(`/var/crash/${file}`)).length) crashHits.push(file);
  }
  const sizes = JSON.parse(await podExec(`import {readdirSync,statSync} from 'node:fs';
    function size(path){let total=0;for(const name of readdirSync(path)){const next=path+'/'+name;
      const stat=statSync(next);total+=stat.isDirectory()?size(next):stat.size}return total}
    const homes=[];
    for(const name of readdirSync('/home/private'))homes.push({name,bytes:size('/home/private/'+name)});
    console.log(JSON.stringify(homes));`));
  for (const home of sizes) homePeak = Math.max(homePeak, home.bytes);
  check(`${name} scans`, !podHits.length && !nodeHits.length && !logHits.length && !crashHits.length,
    { podHits, nodeHits, logHits, crashHits });
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
  measurement('privateStatfs', values.privateStatfs.type === 0x01021994, values.privateStatfs);
  const limits = values.bridgeLimits + values.privateLimits;
  const zeroCore = (limits.match(/Max core file size\s+0\s+0/gu) ?? []).length === 2;
  measurement('coreLimits', zeroCore, { bridge: values.bridgeLimits, private: values.privateLimits });
  evidence.conditions.F2.guest = zeroCore ? 'PASS' : 'FAIL';
  const census = stdinJson + `import {readdirSync,lstatSync,openSync,closeSync,unlinkSync,constants} from 'node:fs';
    const directories=[];function walk(path,depth){let stat;try{stat=lstatSync(path)}catch{return}
      if(!stat.isDirectory())return;directories.push(path);if(depth===4)return;
      let names;try{names=readdirSync(path)}catch{return};for(const name of names)walk((path==='/'?'':path)+'/'+name,depth+1)}
    walk('/',0);process.setgroups([]);process.setgid(1003);process.setuid(1003);const writable=[];
    for(const path of directories){const file=(path||'')+'/p414-write-'+process.pid;
      try{const fd=openSync(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
        closeSync(fd);unlinkSync(file);writable.push(path||'/')}catch{}}
    console.log(JSON.stringify(writable));`;
  const writable = JSON.parse(await podExec(census));
  function allowedPath(path) {
    return path === '/tmp' || path === '/dev/shm' || path.startsWith('/home/private/turn-');
  }
  measurement('writableCensus', writable.every(allowedPath), writable);
  const nodeMounts = await command('docker', ['exec', 'k3d-ocn-server-0', 'cat', '/proc/mounts']);
  const ownMount = nodeMounts.split('\n').filter(function own(line) {
    return line.includes(metadata.uid) && line.includes('/private');
  });
  measurement('privateNodeMount', ownMount.some(function ram(line) { return line.includes(' tmpfs '); }), ownMount);
  const config = await command('docker', ['exec', 'k3d-ocn-server-0', 'sh', '-c',
    'cat /var/lib/rancher/k3s/agent/etc/containerd/config.toml; find /var/lib/rancher/k3s -name runsc.toml -exec cat {} \\;']);
  const runscLines = config.split('\n').filter(function runtime(line) {
    return /runsc|debug|strace/u.test(line);
  });
  measurement('runscOptions', !runscLines.some(function tracing(line) {
    return /debug-log|strace|debug\s*=\s*(true|"?1)/u.test(line);
  }), runscLines);
  const cgroups = await command('docker', ['exec', 'k3d-ocn-server-0', 'sh', '-c',
    `find /sys/fs/cgroup -type d -name '*${metadata.uid.replaceAll('-', '_')}*' -o -name '*${metadata.uid}*'`]);
  const group = cgroups.split('\n').find(function path(path) { return path.includes('pod'); });
  if (group) {
    const swap = await command('docker', ['exec', 'k3d-ocn-server-0', 'sh', '-c',
      `find '${group}' -name memory.swap.max -exec sh -c 'printf "%s " "$1"; cat "$1"' sh {} \\;`]);
    measurement('swapCgroups', !swap.includes('max'), swap);
    const peak = await command('docker', ['exec', 'k3d-ocn-server-0', 'sh', '-c',
      `find '${group}' -name memory.peak -exec sh -c 'printf "%s " "$1"; cat "$1"' sh {} \\;`]);
    measurement('twoTurnPeakMemory', true, peak);
  }
}

const hostSwaps = readFileSync('/proc/swaps', 'utf8');
const hostCorePattern = readFileSync('/proc/sys/kernel/core_pattern', 'utf8').trim();
evidence.conditions.F1 = { result: hostSwaps.trim().split('\n').length > 1 ? 'FAIL' : 'NOT RUN',
  hostSwaps, reason: 'Swap must be off and checked at every relevant cgroup level' };
evidence.conditions.F2 = { result: hostCorePattern.startsWith('|') ? 'FAIL' : 'NOT RUN',
  guest: 'NOT RUN', hostCorePattern };
evidence.measurements.hostCorePattern = { result: evidence.conditions.F2.result,
  value: hostCorePattern };
try {
  if (await command('kubectl', ['config', 'current-context']) !== 'k3d-ocn') throw new Error('k3d-ocn unavailable');
  if (await k('get', 'ns', namespace, '--ignore-not-found')) throw new Error('Probe namespace already exists');
  const template = JSON.parse(readFileSync('apps/computer/sandbox-template.json', 'utf8'));
  evidence.image = template.spec.podTemplate.spec.containers[0].image;
  await apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } });
  created = true;
  await apply({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'provider' }, data: {
    'private-provider.mjs': readFileSync('apps/computer/test/private-provider.mjs', 'utf8') } });
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
  measurement('nodeSwaps', nodeSwaps.trim().split('\n').length === 1, nodeSwaps);
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
    await drive('stop', { frame: { type: 'stop', turnId: active.id, conversationId: active.id } });
    await ended(active); await scan('J3');
  });
  await journey('J4', async function crashes() {
    for (const signal of ['-SEGV', '-9']) {
      const before = await privatePids();
      const doomed = await turn('heldCrash');
      const pids = await privatePids();
      function newlyStarted(pid) { return !before.includes(pid); }
      const doomedPid = pids.find(newlyStarted);
      if (doomedPid === undefined) throw new Error('Crash target process unavailable');
      const other = await turn('heldOther', 'bob');
      await scan(`J4 ${signal} held`, true);
      await podExec(stdinJson + `import {spawnSync} from 'node:child_process';
        const child=spawnSync('/usr/bin/setpriv',['--reuid=1003','--regid=1003','--clear-groups',
          '--','/bin/kill',data.signal,String(data.pid)],{stdio:'ignore'});
        if(child.status!==0)process.exit(1);`, { signal, pid: doomedPid });
      await ended(doomed); await provider('release', {}); await ended(other); await scan(`J4 ${signal}`);
    }
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
    for (const report of reports) {
      if (report.turnId === turnId && ['agent.turn_failed', 'agent.turn_completed'].includes(report.type)) sequences.add(report.sequence);
    }
    check(`one terminal ${turnId}`, sequences.size === 1);
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
  if (created) await k('delete', 'namespace', namespace, '--wait=true', '--timeout=120s');
  const failures = Object.entries(evidence.checks).filter(function failed(entry) { return entry[1].result === 'FAIL'; });
  if (hostSwaps.trim().split('\n').length > 1
    || evidence.measurements.nodeSwaps.result === 'FAIL') {
    evidence.conditions.F1.result = 'FAIL';
  } else if (evidence.measurements.nodeSwaps.result === 'PASS') {
    evidence.conditions.F1.result = 'PASS';
  }
  const missing = Object.entries(evidence.checks).filter(function missing(entry) { return entry[1].result === 'NOT RUN'; });
  const measurementFailures = Object.entries(evidence.measurements).filter(function required(entry) {
    return !['swapCgroups', 'nodeSwaps', 'hostCorePattern'].includes(entry[0]) && entry[1].result !== 'PASS';
  });
  let liveResult = 'PASS';
  const failedMeasurements = measurementFailures.filter(function failed(entry) {
    return entry[1].result === 'FAIL';
  });
  if (failures.length || failedMeasurements.length || (created && evidence.error)) liveResult = 'FAIL';
  else if (missing.length || measurementFailures.length) liveResult = 'NOT RUN';
  evidence.conditions.F3 = { result: liveResult,
  failing: failures.map(function name(entry) { return entry[0]; }),
  missing: measurementFailures.map(function name(entry) { return entry[0]; }) };
  save();
  function productFailure(entry) {
    const name = entry[0];
    return name.endsWith(' scans') || name.endsWith(' no repeat')
      || name.startsWith('one terminal ') || name.startsWith('private release ')
      || name === 'provider isolation' || name === 'tools created no file';
  }
  if (failures.some(productFailure)) process.exitCode = 1;
}
