// Finds the real `codex` program inside the installed @openai/codex package.
//
// The npm package ships a small Node launcher that starts the real program as
// its own child. Stopping the launcher would leave the real program running,
// so the bridge starts the real binary directly (same idea as spike S0.1a).

import { createRequire } from "node:module";
import path from "node:path";
import { PROJECT_ROOT } from "./gateway-process.js";

export function resolveNativeCodexBin(): string {
  const platformPackageByTarget: Record<string, Record<string, string>> = {
    darwin: { arm64: "@openai/codex-darwin-arm64", x64: "@openai/codex-darwin-x64" },
    linux: { arm64: "@openai/codex-linux-arm64", x64: "@openai/codex-linux-x64" },
  };
  const targetTripleByTarget: Record<string, Record<string, string>> = {
    darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
    linux: { arm64: "aarch64-unknown-linux-musl", x64: "x86_64-unknown-linux-musl" },
  };
  const platformPackage = platformPackageByTarget[process.platform]?.[process.arch];
  const targetTriple = targetTripleByTarget[process.platform]?.[process.arch];
  if (!platformPackage || !targetTriple) {
    throw new Error(`unsupported platform for Codex: ${process.platform}/${process.arch}`);
  }
  const req = createRequire(path.join(PROJECT_ROOT, "package.json"));
  const platformPkgJson = req.resolve(`${platformPackage}/package.json`);
  return path.join(path.dirname(platformPkgJson), "vendor", targetTriple, "bin", "codex");
}
