import { createHash } from "node:crypto";

/** Stable hash of any JSON-serialisable value, for "rebuilt == original" comparisons. */
export function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
