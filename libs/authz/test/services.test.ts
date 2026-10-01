import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { until } from "./services.ts";

const exec = promisify(execFile);

it("removes its OpenFGA container when the fixture process is interrupted", async () => {
  const module = new URL("./services.ts", import.meta.url).href;
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    `import { openfga } from ${JSON.stringify(module)}; await openfga(); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`,
  ]);
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
