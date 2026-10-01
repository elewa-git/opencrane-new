// Health endpoint for the OpenCrane computer image.
//
// GET /health  (also /)  -> JSON with every supervised process (PID, state, uptime) and a live probe for
//                           each one. HTTP 200 when everything is up, 503 when something is not.
// GET /healthz           -> always 200 "ok" while this process itself is alive.
//
// Process data comes from the supervisor over its Unix socket (XML-RPC). Probes check that each process
// really answers, not just that it exists. No secrets are ever shown here.
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import { execFile } from "node:child_process";

const PORT = Number(process.env.HEALTH_PORT ?? 8080);
const SUPERVISOR_SOCKET = process.env.SUPERVISOR_SOCKET ?? "/tmp/supervisor.sock";
const EXPECTED = ["xvnc", "openbox", "chromium", "codex-app-server", "health"];

// --- Supervisor (XML-RPC over a Unix socket) ---------------------------------------------------------

function supervisorCall(method) {
  const body = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params></params></methodCall>`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SUPERVISOR_SOCKET,
        path: "/RPC2",
        method: "POST",
        headers: { "content-type": "text/xml", "content-length": Buffer.byteLength(body) },
        timeout: 3000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("timeout", () => req.destroy(new Error("supervisor RPC timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

// Reads every <struct> of an XML-RPC reply into a plain object. Good enough for the flat structs supervisor returns.
function parseStructs(xml) {
  const out = [];
  for (const chunk of xml.replace(/>\s+</g, "><").split("<struct>").slice(1)) {
    const body = chunk.split("</struct>")[0];
    const item = {};
    const member =
      /<member><name>([^<]+)<\/name><value>(?:<(?:int|i4|string|boolean|double)>)?([^<]*)(?:<\/(?:int|i4|string|boolean|double)>)?<\/value><\/member>/g;
    for (const m of body.matchAll(member)) item[m[1]] = m[2];
    out.push(item);
  }
  return out;
}

// --- Probes ------------------------------------------------------------------------------------------

function tcpProbe(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 2000 });
    socket.on("connect", () => {
      socket.destroy();
      resolve({ ok: true, detail: `tcp ${host}:${port} accepts connections` });
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ok: false, detail: `tcp ${host}:${port} timed out` });
    });
    socket.on("error", (err) => resolve({ ok: false, detail: `tcp ${host}:${port} ${err.code ?? err.message}` }));
  });
}

function httpProbe(url, describe) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ ok: res.statusCode === 200, detail: describe ? describe(text) : `GET ${url} -> ${res.statusCode}` });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ ok: false, detail: `GET ${url} failed: ${err.message}` }));
  });
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000, env: { ...process.env, DISPLAY: ":1" } }, (err, stdout) =>
      resolve({ ok: !err, stdout: stdout ?? "" }),
    );
  });
}

async function windowManagerProbe() {
  const r = await run("xprop", ["-display", ":1", "-root", "_NET_SUPPORTING_WM_CHECK"]);
  return { ok: r.ok && /window id/.test(r.stdout), detail: r.stdout.trim() || "no window manager answered on :1" };
}

const probes = {
  xvnc: () => tcpProbe("127.0.0.1", 6901),
  openbox: windowManagerProbe,
  chromium: () =>
    httpProbe("http://127.0.0.1:9222/json/version", (text) => {
      try {
        return `CDP answers: ${JSON.parse(text).Browser}`;
      } catch {
        return "CDP answered with something that is not JSON";
      }
    }),
  "codex-app-server": () => httpProbe("http://127.0.0.1:4500/readyz", () => "readyz 200"),
  health: async () => ({ ok: true, detail: `listening on :${PORT}` }),
};

// --- Desktop and network facts -----------------------------------------------------------------------

async function desktopInfo() {
  const r = await run("xwininfo", ["-display", ":1", "-root", "-tree"]);
  if (!r.ok) return { display: ":1", reachable: false, chromiumWindows: 0, windows: [] };
  // Lines look like:   0x400003 "about:blank - Chromium": ("chromium" "Chromium")  1280x800+0+0  +0+0
  const windows = [];
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^\s+(0x[0-9a-f]+) "([^"]*)": \("([^"]*)" "([^"]*)"\)\s+(\d+x\d+)/i);
    if (m) windows.push({ id: m[1], title: m[2], class: `${m[3]}/${m[4]}`, size: m[5] });
  }
  return {
    display: ":1",
    reachable: true,
    chromiumWindows: windows.filter((w) => /chrom/i.test(w.class)).length,
    windows: windows.slice(0, 10),
  };
}

// TCP listeners from /proc/net/tcp and tcp6 (state 0A = LISTEN).
function listeningPorts() {
  const found = new Set();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== "0A") continue;
      const [addrHex, portHex] = cols[1].split(":");
      const loopback = /^(0100007F|00000000000000000000000001000000)$/i.test(addrHex);
      found.add(`${loopback ? "loopback" : "all"}:${parseInt(portHex, 16)}`);
    }
  }
  return [...found].sort();
}

// --- The report --------------------------------------------------------------------------------------

async function report() {
  let processes = [];
  let supervisorError;
  try {
    const xml = await supervisorCall("supervisor.getAllProcessInfo");
    processes = parseStructs(xml).map((p) => ({
      name: p.name,
      state: p.statename,
      pid: Number(p.pid),
      uptimeSeconds: p.statename === "RUNNING" ? Math.max(0, Number(p.now) - Number(p.start)) : 0,
      exitStatus: Number(p.exitstatus),
      error: p.spawnerr || undefined,
    }));
  } catch (err) {
    supervisorError = String(err.message ?? err);
  }

  const withProbes = await Promise.all(
    processes.map(async (p) => ({ ...p, probe: probes[p.name] ? await probes[p.name]() : { ok: true, detail: "no probe" } })),
  );
  const missing = EXPECTED.filter((n) => !withProbes.some((p) => p.name === n));
  const notOk = withProbes.filter((p) => p.state !== "RUNNING" || !p.probe.ok).map((p) => p.name);
  const ok = !supervisorError && missing.length === 0 && notOk.length === 0;

  let supervisorPid;
  try {
    supervisorPid = Number(/<int>(\d+)<\/int>/.exec(await supervisorCall("supervisor.getPID"))?.[1]);
  } catch {
    /* reported through supervisorError */
  }
  let firstStart;
  try {
    firstStart = fs.readFileSync("/home/agent/.computer-first-start", "utf8").trim();
  } catch {
    /* not there yet */
  }

  return {
    status: ok ? "ok" : "degraded",
    service: "opencrane-computer",
    time: new Date().toISOString(),
    supervisor: { pid: supervisorPid, error: supervisorError },
    problems: ok ? [] : [...missing.map((n) => `${n}: missing`), ...notOk.map((n) => `${n}: not healthy`)],
    processes: withProbes,
    desktop: await desktopInfo(),
    listening: listeningPorts(),
    scratch: { path: "/home/agent", firstStart },
    kernel: fs.readFileSync("/proc/version", "utf8").trim().slice(0, 80),
    versions: {
      node: process.version,
      codex: process.env.COMPUTER_IMAGE_CODEX,
      kasmvnc: process.env.COMPUTER_IMAGE_KASMVNC,
      markitdown: process.env.COMPUTER_IMAGE_MARKITDOWN,
    },
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    return;
  }
  if (req.url === "/health" || req.url === "/") {
    const body = await report();
    res.writeHead(body.status === "ok" ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify(body, null, 2) + "\n");
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, "0.0.0.0", () => console.log(`[health] listening on 0.0.0.0:${PORT}`));
