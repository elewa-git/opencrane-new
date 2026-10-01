// Self-test for the computer image. Run it inside a running computer:
//   node /opt/computer/selftest.mjs
// It is used twice with the same checks: once inside Cloud Build (plain container) and once inside the
// Pod on the gVisor node pool. Prints one line per check and a JSON summary; exits 1 if any check fails.
//
// Every check is written so that it fails if the thing it covers breaks (a process missing, Chromium not
// rendering, the VNC port closed, an unexpected open port, and so on).
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";

const require = createRequire("/opt/computer/");
const HEALTH = "http://127.0.0.1:8080/health";
const results = [];

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("check timed out after 45s")), 45_000)),
    ]);
    results.push({ name, pass: true, detail: String(detail ?? ""), ms: Date.now() - started });
  } catch (err) {
    results.push({ name, pass: false, detail: String(err?.message ?? err), ms: Date.now() - started });
  }
  const r = results.at(-1);
  console.log(`${r.pass ? "PASS" : "FAIL"} ${name} (${r.ms} ms) ${r.detail}`);
}

function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000, env: { ...process.env, DISPLAY: ":1" }, ...opts }, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd} ${args.join(" ")} failed: ${err.message} ${stderr}`.trim())) : resolve(stdout),
    );
  });
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function wsOnce(url, protocols, onOpen) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`websocket ${url} gave no message within 10s`));
    }, 10_000);
    ws.onopen = () => onOpen?.(ws);
    ws.onmessage = (e) => {
      clearTimeout(timer);
      const text = typeof e.data === "string" ? e.data : Buffer.from(e.data).toString("latin1");
      ws.close();
      resolve(text);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`websocket ${url} error`));
    };
  });
}

const EXPECTED = ["xvnc", "openbox", "chromium", "codex-app-server", "health"];

await check("health endpoint says ok and lists every process with PID and uptime", async () => {
  const res = await fetch(HEALTH);
  const body = await res.json();
  assert(res.status === 200, `GET /health returned ${res.status}: ${JSON.stringify(body.problems)}`);
  assert(body.status === "ok", `status is ${body.status}`);
  for (const name of EXPECTED) {
    const p = body.processes.find((x) => x.name === name);
    assert(p, `process ${name} missing from health report`);
    assert(p.state === "RUNNING" && p.pid > 0 && Number.isFinite(p.uptimeSeconds), `${name} is ${p.state} pid=${p.pid}`);
    assert(p.probe.ok, `${name} probe failed: ${p.probe.detail}`);
  }
  return body.processes.map((p) => `${p.name}:pid=${p.pid},up=${p.uptimeSeconds}s`).join(" ");
});

await check("runs as a non-root user", async () => {
  assert(process.getuid() !== 0, "running as root");
  return `uid=${process.getuid()} gid=${process.getgid()}`;
});

await check("kernel string is readable (placement is checked separately by smoke.sh)", async () => {
  const v = fs.readFileSync("/proc/version", "utf8").trim().slice(0, 100);
  return v;
});

await check("Chromium renders a page through its debugging port and a screenshot is a real PNG", async () => {
  const { chromium } = require("playwright-core");
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 20_000 });
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    await page.goto("data:text/html,<title>ocn-selftest</title><h1 id=x>hello from the computer</h1>");
    const title = await page.title();
    const text = await page.locator("#x").textContent();
    const ua = await page.evaluate(() => navigator.userAgent);
    fs.mkdirSync("/home/agent/work", { recursive: true });
    const shot = "/home/agent/work/selftest.png";
    await page.screenshot({ path: shot });
    await page.close();
    const png = fs.readFileSync(shot);
    assert(title === "ocn-selftest", `unexpected title ${title}`);
    assert(text === "hello from the computer", `unexpected text ${text}`);
    assert(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "screenshot is not a PNG");
    assert(png.length > 2000, `screenshot is only ${png.length} bytes`);
    return `${ua.match(/Chrome\/[\d.]+/)?.[0] ?? ua}; screenshot ${png.length} bytes`;
  } finally {
    await browser.close().catch(() => {});
  }
});

await check("Chromium has a real window on the KasmVNC desktop", async () => {
  const out = await sh("xwininfo", ["-display", ":1", "-root", "-tree"]);
  const windows = out.split("\n").filter((l) => /\("[^"]*" "[^"]*"\)/.test(l) && /chrom/i.test(l));
  assert(windows.length > 0, "no Chromium window found on display :1");
  return `${windows.length} Chromium window(s): ${windows[0].trim().slice(0, 100)}`;
});

await check("KasmVNC serves its web client on :6901", async () => {
  const res = await fetch("http://127.0.0.1:6901/");
  const html = await res.text();
  assert(res.status === 200, `GET / returned ${res.status}`);
  assert(/html/i.test(html), "response is not HTML");
  return `HTTP ${res.status}, ${html.length} bytes, mentions KasmVNC: ${/kasm/i.test(html)}`;
});

await check("KasmVNC websocket answers a browser with the VNC (RFB) banner", async () => {
  // KasmVNC requires Origin, which Node's WebSocket client does not send.
  const { chromium } = require("playwright-core");
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = await browser.contexts()[0].newPage();
  try {
    await page.goto("http://127.0.0.1:6901/");
    const banner = await page.evaluate(() => new Promise((resolve, reject) => {
      const socket = new WebSocket("ws://127.0.0.1:6901/websockify", ["binary"]);
      socket.binaryType = "arraybuffer";
      const timer = setTimeout(() => { socket.close(); reject(new Error("RFB timeout")); }, 10000);
      socket.onmessage = event => {
        clearTimeout(timer);
        resolve(new TextDecoder().decode(event.data));
        socket.close();
      };
      socket.onerror = () => { clearTimeout(timer); reject(new Error("VNC websocket failed")); };
    }));
    assert(banner.startsWith("RFB 003."), `unexpected first message ${JSON.stringify(banner.slice(0, 20))}`);
    return banner.trim();
  } finally {
    await page.close();
    await browser.close();
  }
});

await check("Codex app-server (idle) answers the initialize request", async () => {
  const reply = await wsOnce("ws://127.0.0.1:4500", undefined, (ws) =>
    ws.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "selftest", version: "0" } } })),
  );
  const parsed = JSON.parse(reply);
  assert(parsed.result?.userAgent, `unexpected reply ${reply.slice(0, 200)}`);
  return parsed.result.userAgent;
});

await check("only the expected ports listen outside the container's loopback (6901 and 8080)", async () => {
  const listening = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of fs.readFileSync(file, "utf8").split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== "0A") continue;
      const [addr, port] = cols[1].split(":");
      const loop = /^(0100007F|00000000000000000000000001000000)$/i.test(addr);
      listening.push({ loop, port: parseInt(port, 16) });
    }
  }
  const open = [...new Set(listening.filter((l) => !l.loop).map((l) => l.port))].sort((a, b) => a - b);
  const loopOnly = [...new Set(listening.filter((l) => l.loop).map((l) => l.port))].sort((a, b) => a - b);
  const unexpected = open.filter((p) => ![6901, 8080].includes(p));
  assert(unexpected.length === 0, `unexpected externally reachable ports: ${unexpected.join(",")}`);
  assert(open.includes(6901) && open.includes(8080), `expected 6901 and 8080 open, got ${open.join(",")}`);
  return `open to the network: ${open.join(",")}; loopback only: ${loopOnly.join(",")}`;
});

await check("/home/agent is a separate volume and a marker file can be written and read back", async () => {
  const mounts = fs.readFileSync("/proc/mounts", "utf8").split("\n").filter((l) => l.split(" ")[1] === "/home/agent");
  assert(mounts.length > 0, "/home/agent is not a separate volume");
  const first = fs.readFileSync("/home/agent/.computer-first-start", "utf8").trim();
  const marker = "/home/agent/work/selftest-marker.txt";
  fs.mkdirSync("/home/agent/work", { recursive: true });
  const nonce = crypto.randomBytes(8).toString("hex");
  fs.writeFileSync(marker, `${nonce}\n`);
  assert(fs.readFileSync(marker, "utf8").trim() === nonce, "marker did not read back");
  return `mount: ${mounts[0]?.slice(0, 80) ?? "(no separate mount: part of the container layer)"}; first start ${first}`;
});

await check("Codex CLI is the pinned version and runs without a key", async () => {
  const out = (await sh("codex", ["--version"])).trim();
  assert(out.includes("0.159.3"), `unexpected version ${out}`);
  assert(!process.env.OPENAI_API_KEY && !process.env.CODEX_API_KEY, "a provider key is set in the environment");
  const mcp = await sh("playwright-mcp", ["--version"]);
  assert(mcp.includes("0.0.83"), `unexpected MCP version ${mcp}`);
  return `${out}; Playwright MCP ${mcp.trim()}`;
});

await check("MarkItDown converts HTML to Markdown and poppler is installed", async () => {
  fs.mkdirSync("/home/agent/work", { recursive: true });
  const input = "/home/agent/work/selftest.html";
  fs.writeFileSync(input, "<html><body><h1>Quarterly report</h1><p>Revenue grew.</p></body></html>");
  const md = await sh("markitdown", [input]);
  assert(/#\s*Quarterly report/.test(md), `unexpected markdown ${JSON.stringify(md.slice(0, 120))}`);
  await sh("pdftotext", ["-v"]);
  const poppler = "pdftotext -v exited successfully";
  return `markitdown ok; ${poppler.split("\n")[0] || "pdftotext present"}`;
});

await check("the bridge and local forwarding proxy are present and import cleanly, but are not running", async () => {
  const bridge = await import("/opt/computer/spike-s0-1/bridge.js");
  const proxy = await import("/opt/computer/spike-s0-1/local-proxy.js");
  assert(typeof bridge.CodexBridge === "function", "CodexBridge export missing");
  assert(typeof proxy.startLocalForwardingProxy === "function", "startLocalForwardingProxy export missing");
  const health = await (await fetch(HEALTH)).json();
  assert(!health.processes.some((p) => /bridge|proxy/.test(p.name)), "bridge or proxy is supervised, but must not start by default");
  return "bridge.js and local-proxy.js import; not started";
});

const failed = results.filter((r) => !r.pass);
console.log(
  JSON.stringify({ host: os.hostname(), at: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results }),
);
process.exit(failed.length === 0 ? 0 : 1);
