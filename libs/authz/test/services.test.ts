import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createStore, memberAuthorisation } from "../src/index.ts";
import { openfga, until } from "./services.ts";

const exec = promisify(execFile);
const module = new URL("./services.ts", import.meta.url).href;

function startFixture() {
  return spawn(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    `import { openfga } from ${JSON.stringify(module)}; await openfga(); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`,
  ]);
}

function openTcpSocketCount() {
  const resources = process.getActiveResourcesInfo();
  return resources.filter((resource) => resource === "TCPSocketWrap").length;
}

it("reuses one OpenFGA connection for repeated authorisation checks", async () => {
  const fga = await openfga();
  try {
    const binding = await createStore(fga.apiUrl, "connection-reuse");
    const socketsBefore = openTcpSocketCount();
    for (let index = 0; index < 300; index++) {
      const authorisation = memberAuthorisation({ ...binding });
      const result = await authorisation.check("alice", "member");
      expect(result.status).toBe("ok");
    }
    const openedSockets = openTcpSocketCount() - socketsBefore;

    expect(openedSockets).toBeLessThanOrEqual(5);
  } finally {
    await fga.close();
  }
}, 120_000);

it("removes its OpenFGA container when the fixture process is interrupted", async () => {
  const child = startFixture();
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const containers = async () => (await exec("docker", [
    "ps", "-aq", "--filter", `label=opencrane.test.process=${child.pid}`,
  ])).stdout.trim();
  try {
    await until(() => output.includes("ready"), 30_000);
    expect(await containers()).not.toBe("");
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    expect((await exited)[1]).toBe("SIGTERM");
    await until(async () => (await containers()) === "");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const remaining = await containers();
    if (remaining) await exec("docker", ["rm", "-f", ...remaining.split("\n")]);
  }
}, 45_000);

it("removes a renamed fixture by id without removing a container that took its old name", async () => {
  const child = startFixture();
  let output = "";
  let replacement = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const fixtures = async () => (await exec("docker", [
    "ps", "-aq", "--filter", `label=opencrane.test.process=${child.pid}`,
  ])).stdout.trim();
  try {
    await until(() => output.includes("ready"), 30_000);
    const fixture = await fixtures();
    const oldName = (await exec("docker", ["inspect", "--format", "{{.Name}}", fixture])).stdout.trim().slice(1);
    const image = (await exec("docker", ["inspect", "--format", "{{.Config.Image}}", fixture])).stdout.trim();
    await exec("docker", ["rename", fixture, `renamed-${randomUUID()}`]);
    replacement = (await exec("docker", ["run", "-d", "--name", oldName, image, "run", "--playground-enabled=false", "--metrics-enabled=false", "--log-level", "error"])).stdout.trim();
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    expect((await exited)[1]).toBe("SIGTERM");
    await until(async () => (await fixtures()) === "");
    expect((await exec("docker", ["inspect", "--format", "{{.State.Running}}", replacement])).stdout.trim()).toBe("true");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const remaining = await fixtures();
    if (remaining) await exec("docker", ["rm", "-f", ...remaining.split("\n")]);
    if (replacement) await exec("docker", ["rm", "-f", replacement]);
  }
}, 45_000);
