function sortObjectKeys(_key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const keys = Object.keys(value);
  keys.sort();
  const fields: [string, unknown][] = [];
  for (const key of keys) {
    const field: unknown = Reflect.get(value, key);
    fields.push([key, field]);
  }
  return Object.fromEntries(fields);
}

function sortedJson(value: unknown): string | undefined {
  // Apply JSON's omission, toJSON and error rules before sorting plain JSON objects.
  const text: unknown = JSON.stringify(value);
  if (typeof text !== 'string') {
    return undefined;
  }
  const parsed: unknown = JSON.parse(text);
  return JSON.stringify(parsed, sortObjectKeys);
}

/** Compare JSON values with object key order ignored and array order preserved. */
export function sameJson(left: unknown, right: unknown): boolean {
  return sortedJson(left) === sortedJson(right);
}
