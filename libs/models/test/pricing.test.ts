import { expect, it } from 'vitest';
import { costCents, reservationCents, requestReservationCents, models } from '../src/index.ts';

it('prices Astra short context in whole euro cents at the pinned planning FX', () => {
  // 100k input ($1) + 100k output ($5), at EUR 0.95/USD = 570 cents.
  expect(costCents('gpt-6-astra', 100_000, 100_000)).toBe(570);
});

it('charges reported cached tokens at the cached rate and selects the tier from total input', () => {
  // All 100k input cached ($0.10) + 100k output ($5) = 484.5 euro cents.
  expect(costCents('gpt-6-astra', 100_000, 100_000, 100_000)).toBe(485);
  expect(costCents('gpt-6-astra', 272_000, 0)).toBe(259);
  expect(costCents('gpt-6-astra', 272_001, 0)).toBe(517);
  expect(costCents('gpt-6-astra', 272_001, 0, 272_001)).toBe(52);
});

// Worked from the owner's USD table and the pinned EUR 0.95/USD tariff.
it.each([
  ['gpt-6-astra', 570, 1283, 10, 57, 119, 713],
  ['gpt-6.1-sol', 114, 257, 1, 6, 24, 143],
  ['gpt-6-luna', 6, 13, 1, 1, 2, 8],
  ['gpt-6-sol', 114, 257, 2, 12, 24, 143],
  ['gpt-5.6-sol', 228, 513, 4, 23, 48, 285],
  ['gpt-5.6-terra', 133, 285, 2, 12, 24, 143],
  ['gpt-5.6-luna', 14, 29, 1, 2, 3, 15],
  ['gpt-5.5', 333, 713, 5, 29, null, null],
  ['gpt-5.5-pro', 1995, 4275, null, null, null, null],
  ['gpt-5.4', 167, 357, 3, 15, null, null],
  ['gpt-5.4-pro', 1995, 4275, null, null, null, null],
] as const)('prices %s in both tiers, including supported cache reads/writes', (model, short, long, cachedShort, cachedLong, writeShort, writeLong) => {
  expect(costCents(model, 100_000, 100_000)).toBe(short);
  expect(costCents(model, 300_000, 100_000)).toBe(long);
  if (cachedShort !== null) {
    expect(costCents(model, 100_000, 0, 100_000)).toBe(cachedShort);
    expect(costCents(model, 300_000, 0, 300_000)).toBe(cachedLong);
  } else expect(() => costCents(model, 100_000, 0, 100_000)).toThrow('Unsupported cache usage');
  if (writeShort !== null) {
    expect(costCents(model, 100_000, 0, 0, 100_000)).toBe(writeShort);
    expect(costCents(model, 300_000, 0, 0, 300_000)).toBe(writeLong);
  } else expect(() => costCents(model, 100_000, 0, 0, 100_000)).toThrow('Unsupported cache usage');
});
it('refuses unknown models, retired reservations and invalid usage, and rounds once per call', () => {
  expect(models.filter(row => !row.retired)).toHaveLength(11);
  expect(() => costCents('unknown', 1, 1)).toThrow('Unknown model');
  expect(() => reservationCents('unknown', 1)).toThrow('Unknown model');
  for (const model of ['gpt-5-nano', 'gpt-5-mini']) {
    expect(models.find(row => row.id === model)?.retired).toBe(true);
    expect(() => reservationCents(model, 1)).toThrow('Retired model');
  }
  for (const count of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => costCents('gpt-6-luna', count, 1)).toThrow('Invalid usage');
    expect(() => reservationCents('gpt-6-luna', count)).toThrow('Invalid bound');
  }
  expect(() => costCents('gpt-6-luna', 1, 0, 2)).toThrow('Invalid usage');
  expect(() => costCents('gpt-6-luna', 1, 0, 1, 1)).toThrow('Invalid usage');
  expect(costCents('gpt-6-luna', 1, 1)).toBe(1);
  expect(costCents('gpt-6-luna', 0, 0)).toBe(0);
});
it('reserves long rates without a proven bound and covers cache writes as well as output', () => {
  expect(reservationCents('gpt-6-astra', 128)).toBe(2495);
  expect(reservationCents('gpt-6-astra', 2000)).toBe(2508);
  expect(reservationCents('gpt-6-astra', 100_000, 100_000)).toBe(594);
  expect(reservationCents('gpt-6-astra', 1, 272_000)).toBe(324);
  expect(reservationCents('gpt-6-astra', 1, 272_001)).toBe(647);
});

it('requires a positive output bound even for a trusted prompt bound', () => {
  expect(() => reservationCents('gpt-6-luna', 0, 1000)).toThrow('Invalid bound');
});

it('reserves a few cents for this Sol chat request with a 2,000-token output bound', () => {
  const body = { model: 'gpt-6.1-sol', input: 'Say OK.', instructions: 'Be brief.'.repeat(450), max_output_tokens: 2000, stream: true, n: 1 };
  expect(requestReservationCents(body)).toBe(3);
});

it.each([[272_000, 67], [272_001, 133], [300_000, 146]])('reserves the correct tier for a %i-byte request', (bytes, cents) => {
  const body = { model: 'gpt-6.1-sol', input: '', max_output_tokens: 2000 };
  body.input = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(body)));
  expect(requestReservationCents(body)).toBe(cents);
});

it('refuses a request whose input and output bounds exceed the supported context', () => {
  const body = { model: 'gpt-6.1-sol', input: 'x'.repeat(1_048_001), max_output_tokens: 2000 };
  expect(() => requestReservationCents(body)).toThrow('input and output bounds exceed the 1,050,000-token context');
});

it.each([0, 1.5, 2])('refuses multiplicity %s rather than leaving output unbounded', n => {
  const body = { model: 'gpt-6.1-sol', input: 'OK', max_output_tokens: 2000, n };
  expect(() => requestReservationCents(body)).toThrow('n = 1');
});

it('never reserves less than settlement for random text bodies and any tokenisation of at most one token per byte', () => {
  // Fixed seed makes failures repeatable without adding a property-testing dependency.
  let seed = 75;
  const random = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  const active = models.filter(row => !row.retired);
  for (let trial = 0; trial < 160; trial++) {
    const model = active[trial % active.length]!;
    const fragments = Array.from({ length: 7 }, () => ['ASCII', '£', '漢字', '😀', '\n"\\', '\u0000'][random(6)]!);
    const slot = random(fragments.length);
    fragments[slot] = fragments[slot]!.repeat([1, 128, 4096, 60_000, 68_000, 90_000][random(6)]!);
    const body = { model: model.id, stream: true, instructions: fragments[0]!, max_output_tokens: 16 + random(1985), n: 1,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: fragments[1]! }] },
        { type: 'function_call', call_id: 'call', name: 'run', arguments: fragments[2]! },
        { type: 'function_call_output', call_id: 'call', output: fragments[3]! },
        { type: 'additional_tools', id: 'tools', role: 'developer', tools: [{ type: 'namespace', name: 'functions',
          tools: [{ type: 'custom', name: 'exec', format: { type: 'grammar', syntax: 'lark', definition: fragments[4]! } }] }] },
      ],
      tools: [{ type: 'function', name: 'run', description: fragments[5]!, parameters: { type: 'object', properties: {
        [fragments[6]!]: { type: 'string', description: fragments[6]! },
      } } }],
    };
    const bytes = Buffer.byteLength(JSON.stringify(body));
    if (bytes + body.max_output_tokens > 1_050_000) {
      expect(() => requestReservationCents(body)).toThrow('context');
      continue;
    }
    const reservation = requestReservationCents(body);
    // Within each tier all prices are non-negative and cost increases with tokens.
    // Checking each tier's maximum therefore covers every smaller tokenisation and output.
    for (const input of [0, Math.min(bytes, 272_000), bytes, random(bytes + 1)]) {
      for (const [cached, writes] of [[0, 0], [model.short.cachedInputCents === null ? 0 : input, 0],
        [0, model.short.cacheWriteCents === null ? 0 : input]]) {
        expect(reservation, `seed 75, trial ${trial}, input ${input}`).toBeGreaterThanOrEqual(
          costCents(model.id, input, body.max_output_tokens, cached, writes));
      }
    }
  }
});
