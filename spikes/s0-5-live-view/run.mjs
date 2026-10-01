import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { lab, driver, until, command, sleep } from '../s0-3-warm-pool/lab.mjs';
import { gateway } from './gateway.mjs';
import { rfb, clipboard } from './rfb.mjs';
process.chdir(new URL('../..', import.meta.url).pathname);
const l = await lab('s05-view', 'spikes/s0-5-live-view/.state');
let d, g, forward;
try {
  const pod = await l.computer('desktop', '512Mi');
  await l.exec('desktop', `import {spawn} from 'node:child_process';import {openSync} from 'node:fs';const fd=openSync('/tmp/desktop.log','a');const c=spawn('setpriv',['--no-new-privs','node','/desktop/desktop.mjs'],{detached:true,stdio:['ignore',fd,fd]});c.unref();`);
  await until(async () => l.exec('desktop', `console.log(await fetch('http://127.0.0.1:6901').then(r=>r.status).catch(()=>0))`).then(x => x === '401'), 'Kasm Basic auth ready');
  const passwords = JSON.parse(await l.exec('desktop', `import {readFileSync} from 'node:fs';console.log(readFileSync('/home/desktop/credentials.json','utf8'));`));
  // Only the OpenCrane gateway can reach the backend relay; it listens on loopback in that Pod.
  await l.exec('backend', `import {spawn} from 'node:child_process';const c=spawn('node',['-e',\`const n=require('net');n.createServer(s=>{const u=n.connect(6901,'${pod.status.podIP}');s.pipe(u);u.pipe(s);s.on('error',()=>u.destroy());u.on('error',()=>s.destroy());s.on('close',()=>u.destroy());u.on('close',()=>s.destroy());}).listen(6902,'127.0.0.1')\`],{detached:true,stdio:'ignore'});c.unref();`);
  forward = spawn('kubectl', ['-n', l.ns, 'port-forward', 'pod/backend', ':6902', '--address=127.0.0.1']);
  let address; forward.stdout.on('data', b => { address = b.toString().match(/127.0.0.1:(\d+)/)?.[1]; });
  forward.stderr.on('data', () => {}); await until(() => address, 'gateway transport');
  d = await driver(l, 'desktop');
  const thread = (await d.rpc('thread/start', { cwd: '/workspace' })).thread.id;
  await l.grant('desktop', await l.admin('issue', { thread, ttl: 120000 }));
  const started = await d.rpc('turn/start', { threadId: thread, input: [{ type: 'text', text: 'KILL_ME: hold the model stream until takeover.', text_elements: [] }] });
  await until(() => d.messages.some(m => m.method === 'item/agentMessage/delta'), 'active model stream');
  let paused = false;
  const startAgent = async () => {
    assert.equal(paused, false, 'agent cannot start during human control');
    await d.turn(thread, 'AFTER_RELEASE: continue working after human release.');
  };
  g = await gateway(`http://127.0.0.1:${address}`, passwords, async () => {
    paused = true;
    await d.rpc('turn/interrupt', { threadId: thread, turnId: started.turn.id });
    await until(() => d.messages.some(m => m.method === 'turn/completed' && m.params.turn.status === 'interrupted'), 'agent pause acknowledged');
  }, async () => { paused = false; await startAgent(); });
  const action = (name, token) => fetch(g.url + '/computers/c1/' + name, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.equal((await action('takeover', 'invalid')).status, 401);
  assert.equal((await action('takeover', g.tokens.participant)).status, 403);
  await assert.rejects(rfb(g.url, 'invalid'), /403/);
  await assert.rejects(rfb(g.url, g.tokens.participant, 'http://untrusted.invalid'), /403/);
  // Direct Pod access from an unrelated Pod must fail, including with real Kasm credentials.
  await l.apply({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'outsider' }, spec: { automountServiceAccountToken: false, containers: [{ name: 'probe', image: l.image, command: ['sleep', '3600'] }] } });
  await l.k('wait', '--for=condition=Ready', 'pod/outsider', '--timeout=120s');
  const direct = await l.exec('outsider', `console.log(await fetch('http://${pod.status.podIP}:6901',{signal:AbortSignal.timeout(1500)}).then(r=>r.status).catch(()=> 'blocked'))`, {}, 'probe');
  assert.equal(direct, 'blocked');
  l.pass('gateway only', 'unrelated Pod direct access blocked; invalid OpenCrane session 401; participant takeover 403');
  const eventStart = `import {spawn} from 'node:child_process';import {openSync} from 'node:fs';process.setgroups([]);process.setgid(1002);process.setuid(1002);const f=openSync('/home/desktop/events','w');const c=spawn('stdbuf',['-oL','xev','-geometry','400x300+0+0'],{env:{PATH:process.env.PATH,HOME:'/home/desktop',DISPLAY:':1'},detached:true,stdio:['ignore',f,f]});c.unref();`;
  await l.exec('desktop', eventStart);
  await sleep(400);
  await l.exec('desktop', `import {execFileSync} from 'node:child_process';process.setgroups([]);process.setgid(1002);process.setuid(1002);const env={...process.env,DISPLAY:':1'};const id=execFileSync('xdotool',['search','--name','Event Tester'],{env}).toString().trim().split(String.fromCharCode(10))[0];execFileSync('xdotool',['windowfocus',id],{env});execFileSync('xdotool',['mousemove','20','20'],{env});`);
  const events = () => l.exec('desktop', `import {readFileSync} from 'node:fs';console.log(readFileSync('/home/desktop/events','utf8'));`);
  const viewer = await rfb(g.url, g.tokens.participant, 'http://opencrane.local', true);
  assert.ok(viewer.pixels > 0);
  const xvnc = () => l.exec('desktop', `import {readFileSync,readdirSync} from 'node:fs';for(const p of readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{const s=readFileSync('/proc/'+p+'/stat','utf8');if(s.includes('(Xvnc)'))console.log(s.split(' ').slice(0,22).filter((_,i)=>i===0||i===21).join(':'));}catch{}}`);
  const originalXvnc = await xvnc(); assert.ok(originalXvnc);
  const refuse = async (send, token = g.tokens.participant) => {
    const attack = await rfb(g.url, token);
    send(attack);
    await until(() => attack.socket.readyState === 3, 'viewer input disconnected', 10000);
  };
  await refuse(c => c.key(0x61));
  await refuse(c => c.pointer(100, 100));
  const huge = clipboard('x'.repeat(1024), 160 * 1024 * 1024);
  await refuse(c => { c.socket.send(huge); for (let i = 0; i < 16; i++) c.socket.send(Buffer.alloc(4096)); });
  // Reject the type alone, without waiting for a declared payload, even across messages.
  await refuse(c => c.socket.send(huge.subarray(0, 1)));
  for (const packet of [Buffer.from([6, 0, 0, 0, 0, 0, 0, 1, 120]),
    Buffer.from([6, 0, 0, 0, 255, 255, 255, 252, 0, 0, 0, 0]),
    clipboard('file'), Buffer.from([7]), Buffer.from([255]), Buffer.from([2, 0, 1, 1])]) {
    await refuse(c => c.socket.send(packet));
  }
  await refuse(c => { c.socket.send(Buffer.alloc(3000), { fin: false }); c.socket.send(Buffer.alloc(3000), { fin: true }); });
  await refuse(c => c.socket.send('text is not RFB'));
  const alive = JSON.parse(await l.k('get', 'pod/desktop', '-o', 'json'));
  assert.equal(alive.metadata.uid, pod.metadata.uid);
  assert.equal(alive.status.containerStatuses[0].restartCount, 0);
  assert.equal(alive.status.containerStatuses[0].state.running !== undefined, true);
  assert.equal(alive.spec.containers[0].resources.limits.memory, '512Mi');
  assert.equal(await xvnc(), originalXvnc, 'same Xvnc PID and start time after attacks');
  const healthy = await rfb(g.url, g.tokens.participant); assert.equal(healthy.pixels, 480000); healthy.socket.close();
  l.pass('viewer allocation boundary', '160 MiB binary clipboard declaration plus data disconnected; standard/extended clipboard, file/unknown input, oversized encodings and fragmented WebSocket rejected; same Xvnc PID/start time, same Pod UID, zero restarts, 512Mi limit, fresh 480000-pixel view');
  assert.doesNotMatch(await events(), /KeyPress event/);
  const pointer = () => l.exec('desktop', `import {execFileSync} from 'node:child_process';console.log(execFileSync('xdotool',['getmouselocation'],{env:{...process.env,DISPLAY:':1'}}).toString())`);
  assert.match(await pointer(), /x:20 y:20/);
  const before = await rfb(g.url, g.tokens.requester); before.key(0x62); await sleep(300);
  assert.doesNotMatch(await events(), /KeyPress event/); before.socket.close();
  assert.equal((await action('takeover', g.tokens.requester)).status, 200);
  assert.equal(g.mode(), 'human'); assert.equal(paused, true);
  await assert.rejects(startAgent(), /agent cannot start/);
  const count = (await l.records()).length; await sleep(600); assert.equal((await l.records()).length, count);
  const writer = await rfb(g.url, g.tokens.requester);
  writer.key(0x63); writer.pointer(150, 150); await sleep(400);
  await until(async () => /keysym 0x63/.test(await events()), 'requester key reaches X server', 15000); await until(async () => /x:150 y:150/.test(await pointer()), 'requester pointer reaches X server', 15000);
  // Viewer stays read-only even while another session controls the same X server.
  await refuse(c => c.key(0x64)); await refuse(c => c.pointer(200, 200));
  assert.equal((await events()).match(/KeyPress event/g)?.length, 1); assert.match(await pointer(), /x:150 y:150/);
  writer.socket.send(clipboard('requester clipboard survives'));
  const copied = await l.exec('desktop', `
    import {spawn} from 'node:child_process';import {once} from 'node:events';
    process.setgroups([]);process.setgid(1002);process.setuid(1002);
    const browser=spawn('chromium',['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--user-data-dir=/home/desktop/clipboard-profile','--remote-debugging-port=9223','about:blank'],{env:{PATH:process.env.PATH,HOME:'/home/desktop',DISPLAY:':1'},stdio:'ignore'});
    let ws;
    try {
      let pages;for(let i=0;i<150;i++){pages=await fetch('http://127.0.0.1:9223/json').then(r=>r.json()).catch(()=>null);if(pages?.length)break;await new Promise(r=>setTimeout(r,100));}
      ws=new WebSocket(pages[0].webSocketDebuggerUrl);await once(ws,'open');
      let id=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}});
      const rpc=(method,params={})=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
      await rpc('Browser.grantPermissions',{origin:'http://127.0.0.1:9223',permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
      await rpc('Page.navigate',{url:'http://127.0.0.1:9223/json/version'});await rpc('Page.bringToFront');
      let result;for(let i=0;i<100;i++){result=await rpc('Runtime.evaluate',{expression:'navigator.clipboard.readText()',awaitPromise:true,returnByValue:true});if(typeof result.result?.value==='string')break;await new Promise(r=>setTimeout(r,100));}
      if(typeof result.result?.value!=='string')throw new Error(JSON.stringify(result));
      console.log(result.result.value);await rpc('Browser.close');await once(browser,'exit');
    } finally {ws?.close();browser.kill();}
  `);
  assert.equal(copied, 'requester clipboard survives');
  l.pass('requester clipboard', 'binary text/plain input read from actual X clipboard by desktop Chromium during takeover');
  // Keep all three connections open: one stops reading while the desktop changes.
  const normal = await rfb(g.url, g.tokens.participant);
  const slow = await rfb(g.url, g.tokens.participant);
  let slowClose;
  slow.socket.on('close', (code, reason) => { slowClose = { code, reason: reason.toString() }; });
  slow.socket.pause();
  const update = Buffer.from([3, 0, 0, 0, 0, 0, 3, 32, 2, 88]); // Full 800x600 update.
  const rssBefore = process.memoryUsage().rss;
  let rssPeak = rssBefore, previousHash, frames = 0;
  // Gateway and protocol clients share this process; its RSS is a conservative gateway bound.
  const sample = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 10);
  try {
    for (let i = 0; i < 32; i++) {
      await l.exec('desktop', `import {execFileSync} from 'node:child_process';process.setgroups([]);process.setgid(1002);process.setuid(1002);const env={...process.env,DISPLAY:':1'};const id=execFileSync('xdotool',['search','--name','Event Tester'],{env}).toString().trim().split(String.fromCharCode(10))[0];execFileSync('xdotool',['windowmove',id,'${i % 2 ? 0 : 400}','0'],{env});`);
      if (i < 8) slow.socket.send(update);
      const frame = await normal.refresh();
      assert.equal(frame.pixels, 480000); assert.notEqual(frame.hash, previousHash); previousHash = frame.hash;
      assert.equal((await writer.refresh()).pixels, 480000);
      writer.pointer(150 + i, 150);
      await until(async () => (await pointer()).includes(`x:${150 + i} y:150`), 'requester control during slow view', 10000);
      assert.equal(normal.socket.readyState, 1); assert.equal(writer.socket.readyState, 1);
      frames++;
      if (i === 7) {
        slow.socket.resume();
        await until(() => slowClose, 'slow viewer closed by buffer limit', 10000);
        assert.deepEqual(slowClose, { code: 1013, reason: 'Viewer buffer limit exceeded' });
      }
    }
    assert.equal((await normal.refresh()).pixels, 480000);
    assert.equal((await writer.refresh()).pixels, 480000);
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    assert.ok(rssPeak < 256 * 1024 * 1024, `RSS peak ${rssPeak} exceeds 256 MiB`);
    assert.ok(rssPeak - rssBefore < 96 * 1024 * 1024, `RSS growth ${rssPeak - rssBefore} exceeds 96 MiB`);
    l.pass('slow viewer isolation', `${frames} changing frames, reader paused for the first 8 then closed 1013: ${slowClose.reason}; normal viewer and requester received every frame and requester pointer worked throughout; combined gateway/client RSS baseline ${rssBefore}, peak ${rssPeak}, growth ${rssPeak - rssBefore} bytes (bounds: 256 MiB total, 96 MiB growth); 4 MiB send cap in each viewer direction`);
  } finally {
    clearInterval(sample); slow.socket.terminate(); normal.socket.terminate();
  }
  assert.equal((await action('release', g.tokens.requester)).status, 200);
  await until(() => writer.socket.readyState === 3, 'writer disconnected on release');
  assert.ok((await l.records()).length > count); assert.equal(paused, false);
  const after = await rfb(g.url, g.tokens.requester); after.key(0x65); await sleep(300);
  assert.equal((await events()).match(/KeyPress event/g)?.length, 1); after.socket.close(); viewer.socket.close();
  l.pass('server-side view-only', `${viewer.pixels} framebuffer pixels received; raw viewer key/pointer connections closed, requester key c and pointer accepted only during takeover`);
  l.pass('pause/release', 'active Codex turn interrupted before control; no calls during hold; writer socket closed before new Codex turn completes after release');
  const desktopStatus = await l.exec('desktop', `import {readFileSync,readdirSync} from 'node:fs';for(const p of readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{const s=readFileSync('/proc/'+p+'/status','utf8');if(s.startsWith('Name:\\tXvnc'))console.log(s);}catch{}}`);
  assert.match(desktopStatus, /Uid:\s+1002/); assert.match(desktopStatus, /NoNewPrivs:\s+1/); assert.match(desktopStatus, /CapEff:\s+0+/);
  const isolation = await l.exec('desktop', `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';process.setgroups([]);process.setgid(1002);process.setuid(1002);for(const f of ['/home/codex/caller','/home/codex/tokens.json','/home/codex/.codex/config.toml'])assert.throws(()=>readFileSync(f),{code:'EACCES'});assert.equal((await fetch('http://127.0.0.1:8080/v1/responses',{method:'POST',body:'{}'})).status,401);assert.equal((await fetch('http://${l.backend}:3000/v1/responses',{method:'POST',body:'{}'})).status,403);assert.equal(await fetch('http://${l.backend}:9003/health',{signal:AbortSignal.timeout(1500)}).then(()=>false).catch(()=>true),true);console.log('DESKTOP_ISOLATION_PASS uid='+process.getuid());`);
  l.pass('desktop isolation', isolation + '; private Codex files EACCES, local model 401, gateway model 403, direct model blocked');
  writeFileSync(`${l.state}/x-events.txt`, await events());
} catch (e) { l.pass('run', e.message, 'FAIL'); throw e; }
finally {
  try { writeFileSync(`${l.state}/kasm.log`, await l.exec('desktop', `import {readFileSync} from 'node:fs';console.log(readFileSync('/tmp/desktop.log','utf8'))`)); } catch {}
  g?.close(); forward?.kill(); d?.child.kill(); await l.clean();
}
