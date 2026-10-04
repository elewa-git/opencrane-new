import { createHash } from 'node:crypto';

export interface JsonValue { canonical: string; value: string | boolean | null | Map<string, JsonValue> | JsonValue[]; kind: 'string' | 'number' | 'literal' | 'object' | 'array' }
/** lossless-json-v1: UTF-16 key order, JSON string escaping and untouched number lexemes. */
export function losslessJson(text: string) {
  let at = 0;
  const bad = (): never => { throw new Error('Invalid or ambiguous JSON'); };
  const space = () => { while (/[\x20\t\r\n]/u.test(text[at] ?? 'x')) at++; };
  function string(): string {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === '\\') { at++; continue; }
      if (c === '"') {
        const decoded: unknown = JSON.parse(text.slice(start, at));
        if (typeof decoded !== 'string' || /[\uD800-\uDFFF]/u.test(decoded)) return bad();
        return decoded;
      }
    }
    return bad();
  }
  function read(depth: number): JsonValue {
    if (depth > 64) return bad();
    space();
    const c = text[at];
    if (c === '"') { const value = string(); return { kind: 'string', value, canonical: quote(value) }; }
    if (c === '{' || c === '[') return collection(c, depth);
    const token = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u.exec(text.slice(at))?.[0];
    if (!token) return bad();
    at += token.length;
    const literal = token === 'true' || token === 'false' || token === 'null';
    return { kind: literal ? 'literal' : 'number', canonical: token, value: literal ? token === 'null' ? null : token === 'true' : token };
  }
  function collection(open: string, depth: number): JsonValue {
    at++; space();
    const object = new Map<string, JsonValue>(), array: JsonValue[] = [], close = open === '{' ? '}' : ']';
    if (text[at] !== close) for (;;) {
      space();
      if (open === '{') {
        if (text[at] !== '"') return bad();
        const key = string(); space();
        if (object.has(key) || ['__proto__', 'constructor'].includes(key) || text[at++] !== ':') return bad();
        object.set(key, read(depth + 1));
      } else array.push(read(depth + 1));
      space();
      if (text[at] !== ',') break;
      at++;
    }
    if (text[at++] !== close) return bad();
    return open === '{' ? { kind: 'object', value: object, canonical: `{${[...object.keys()].sort().map(k => `${quote(k)}:${object.get(k)!.canonical}`).join(',')}}` }
      : { kind: 'array', value: array, canonical: `[${array.map(v => v.canonical).join(',')}]` };
  }
  const result = read(0); space();
  if (at !== text.length) return bad();
  return { ...result, digest: createHash('sha256').update(result.canonical).digest('hex') };
}
function quote(value: string): string {
  const escapes = new Map([['"', '\\"'], ['\\', '\\\\'], ['\b', '\\b'], ['\f', '\\f'], ['\n', '\\n'], ['\r', '\\r'], ['\t', '\\t']]);
  // JSON requires escaping control characters, including those represented by unicode escapes.
  // eslint-disable-next-line no-control-regex
  return '"' + value.replace(/["\\\u0000-\u001f]/gu, c => escapes.get(c) ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '"';
}
