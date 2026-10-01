// Plain-English note: a tiny helper so every stub service can read a JSON
// body and send a JSON response without pulling in a web framework.

import type { IncomingMessage, ServerResponse } from "node:http";

export async function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`body exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T = unknown>(req: IncomingMessage, maxBytes = 1_000_000): Promise<T | undefined> {
  const buf = await readBody(req, maxBytes);
  if (buf.length === 0) return undefined;
  return JSON.parse(buf.toString("utf8")) as T;
}

/**
 * A small hand-written JSON parser that refuses a repeated key in the same
 * object, at any nesting depth.
 *
 * Plain-English: `JSON.parse('{"a":1,"a":2}')` silently keeps the last
 * value ({a: 2}) and throws nothing away the caller could notice. That is
 * exactly the shape of a request-smuggling trick: put a safe value first
 * (so a naive checker that reads the first match looks fine) and a
 * dangerous one second (so the object that is actually used is the
 * dangerous one), or the other way around if the checker reads the last
 * match. This parser walks the raw text itself and throws the moment it
 * sees a key repeated within one object, so a body built that way is
 * rejected outright instead of silently picked one way or the other.
 */
export class DuplicateJsonKeyError extends SyntaxError {}

export function parseStrictJson(text: string): unknown {
  let i = 0;
  const n = text.length;

  function fail(message: string): never {
    throw new SyntaxError(`${message} at position ${i}`);
  }
  function skipWs(): void {
    while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  }
  function parseValue(): unknown {
    skipWs();
    const c = text[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "t" || c === "f") return parseBoolean();
    if (c === "n") return parseNull();
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    fail(`unexpected character ${JSON.stringify(c)}`);
  }
  function parseObject(): Record<string, unknown> {
    i++; // consume '{'
    const obj: Record<string, unknown> = {};
    const seenKeys = new Set<string>();
    skipWs();
    if (text[i] === "}") {
      i++;
      return obj;
    }
    for (;;) {
      skipWs();
      if (text[i] !== '"') fail("expected a string key");
      const key = parseString();
      if (seenKeys.has(key)) throw new DuplicateJsonKeyError(`duplicate key ${JSON.stringify(key)} in one object, at position ${i}`);
      seenKeys.add(key);
      skipWs();
      if (text[i] !== ":") fail("expected ':' after object key");
      i++;
      obj[key] = parseValue();
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        break;
      }
      fail("expected ',' or '}' in object");
    }
    return obj;
  }
  function parseArray(): unknown[] {
    i++; // consume '['
    const arr: unknown[] = [];
    skipWs();
    if (text[i] === "]") {
      i++;
      return arr;
    }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        break;
      }
      fail("expected ',' or ']' in array");
    }
    return arr;
  }
  function parseString(): string {
    const start = i;
    i++; // consume opening quote
    let escaped = false;
    while (i < n) {
      const c = text[i];
      if (escaped) {
        escaped = false;
        i++;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        i++;
        continue;
      }
      if (c === '"') {
        i++;
        break;
      }
      i++;
    }
    if (i > n) fail("unterminated string");
    // Delegate the actual escape decoding to JSON.parse on just this one
    // string literal -- correct per the JSON grammar, and far simpler than
    // reimplementing \uXXXX handling by hand.
    return JSON.parse(text.slice(start, i)) as string;
  }
  function parseBoolean(): boolean {
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    fail("invalid literal");
  }
  function parseNull(): null {
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    fail("invalid literal");
  }
  function parseNumber(): number {
    const start = i;
    if (text[i] === "-") i++;
    while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    if (text[i] === ".") {
      i++;
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    }
    const raw = text.slice(start, i);
    if (raw.length === 0 || raw === "-") fail("invalid number");
    return Number(raw);
  }

  const result = parseValue();
  skipWs();
  if (i !== n) fail("unexpected trailing characters after the JSON value");
  return result;
}

/**
 * Reads a request body and parses it with `parseStrictJson`. Returns
 * `undefined` for an empty body (same convention as `readJson`). Throws
 * `SyntaxError` for anything malformed, including a duplicate key.
 */
export async function readStrictJson(req: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const buf = await readBody(req, maxBytes);
  if (buf.length === 0) return undefined;
  return parseStrictJson(buf.toString("utf8"));
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(payload);
}

export function log(service: string, fields: Record<string, unknown>): void {
  // One JSON line per log entry, so tests and humans can both grep it.
  console.log(JSON.stringify({ service, time: new Date().toISOString(), ...fields }));
}
