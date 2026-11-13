import type { JsonValue } from '@opencrane/events/lossless-json';

import { credentialPatterns, containsCredentialText } from './credential-patterns.ts';

function collectStringValues(value: JsonValue, values: string[]): void {
  if (value.value instanceof Map) {
    for (const nested of value.value.values()) collectStringValues(nested, values);
    return;
  }
  if (Array.isArray(value.value)) {
    for (const nested of value.value) collectStringValues(nested, values);
    return;
  }
  if (value.kind === 'string' && typeof value.value === 'string') {
    values.push(value.value);
  }
}

function collectTextBlocks(value: JsonValue, values: string[]): void {
  if (value.value instanceof Map) {
    for (const [key, nested] of value.value) {
      if (key === 'text' && nested.kind === 'string' &&
          typeof nested.value === 'string') {
        values.push(nested.value);
      } else {
        collectTextBlocks(nested, values);
      }
    }
    return;
  }
  if (Array.isArray(value.value)) {
    for (const nested of value.value) collectTextBlocks(nested, values);
  }
}

export function containsCredential(value: JsonValue, patterns: string[]): boolean {
  if (value.value instanceof Map) {
    for (const [key, nested] of value.value) {
      if (containsCredentialText(key, patterns) || containsCredential(nested, patterns)) {
        return true;
      }
    }
    return false;
  }
  if (Array.isArray(value.value)) {
    for (const nested of value.value) {
      if (containsCredential(nested, patterns)) return true;
    }
    return false;
  }
  return typeof value.value === 'string' && containsCredentialText(value.value, patterns);
}

export function replyContainsCredential(reply: JsonValue, contentType: string,
  material: string | undefined): boolean {
  const patterns = credentialPatterns(material);
  const values: string[] = [];
  const textBlocks: string[] = [];
  collectStringValues(reply, values);
  collectTextBlocks(reply, textBlocks);
  return containsCredential(reply, patterns) ||
    containsCredentialText(values.join(''), patterns) ||
    containsCredentialText(values.join(' '), patterns) ||
    containsCredentialText(textBlocks.join(''), patterns) ||
    containsCredentialText(textBlocks.join(' '), patterns) ||
    containsCredentialText(reply.canonical, patterns) ||
    containsCredentialText(contentType, patterns);
}

