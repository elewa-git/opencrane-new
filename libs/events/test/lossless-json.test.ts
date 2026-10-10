import { expect, it } from 'vitest';
import { losslessJson } from '../src/lossless-json.ts';

it('binds sorted UTF-16 keys and stable strings without changing any number text', () => {
  const value = losslessJson('{ "z": [9007199254740993,1.0,1e0,-0], "a":"\\u0061\\n", "𐀀":true,"":null }');
  expect(value.canonical).toBe('{"a":"a\\n","z":[9007199254740993,1.0,1e0,-0],"𐀀":true,"":null}');
  expect(losslessJson('{"b":2,"a":1}').digest).toBe('43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
  expect(losslessJson('{"a":1,"b":2}').digest).toBe(losslessJson('{"b":2,"a":1}').digest);
  expect(new Set(['1', '1.0', '1e0', '-0', '0'].map(n => losslessJson(n).digest)).size).toBe(5);
});
it.each(['{"a":1,"\\u0061":2}', '{"x":[{"a":1,"a":2}]}', '{"__proto__":1}', '{"x":{"constructor":0}}',
  '"\\ud800"', '"\\udc00"', '"\ud800"', '01', '1.', '1e', '[1,]', '{"a":1}x', '{"a":NaN}'])('refuses ambiguous or malformed JSON: %s', text => {
  expect(() => losslessJson(text)).toThrow();
});
