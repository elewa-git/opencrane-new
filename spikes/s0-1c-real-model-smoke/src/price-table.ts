// Price table and cost in whole euro cents.
//
// Plain-English summary: money is always an integer number of euro cents
// (AGENTS.md rule). The price table file lists, for each model, the price in
// US dollars per million input tokens and per million output tokens, plus one
// USD-to-EUR rate for the whole table. All the sums below use BigInt on fixed
// point numbers, so no floating point is involved, and the result is rounded
// UP to the next whole cent: we would rather over-count than under-count.
//
// Prices and the rate are written as decimal strings (for example "0.40")
// with at most 6 decimal places, so they are read exactly.

import { readFileSync } from "node:fs";

const SCALE_DIGITS = 6;
const SCALE = 10n ** BigInt(SCALE_DIGITS);
const TOKENS_PER_PRICE_UNIT = 1_000_000n; // prices are per million tokens

export interface ModelPrice {
  /** USD per million input tokens, as a decimal string. */
  inputUsdPerMillion: string;
  /** USD per million output tokens, as a decimal string. */
  outputUsdPerMillion: string;
  /** True only once a person has checked the figures against the provider's price page. */
  confirmed: boolean;
  /** Where the figures came from (free text). */
  source: string;
}

export interface PriceTable {
  version: number;
  /** EUR per 1 USD, as a decimal string. A fixed planning constant, not a live rate. */
  usdToEurRate: string;
  usdToEurRateNote: string;
  models: Record<string, ModelPrice>;
}

export interface TokenUsage {
  /** All prompt tokens, including any served from the provider's cache. */
  inputTokens: number;
  /** All completion tokens, including reasoning tokens. */
  outputTokens: number;
}

/** Reads a decimal string like "0.40" into an integer scaled by 10^6. */
export function parseDecimalScaled(text: string, label: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) {
    throw new Error(`${label}: "${text}" is not a plain decimal number with at most ${SCALE_DIGITS} decimal places`);
  }
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? "").padEnd(SCALE_DIGITS, "0") || "0");
  return whole * SCALE + fraction;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function assertTokenCount(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative whole number, got ${String(value)}`);
  }
  return BigInt(value);
}

export function loadPriceTable(path: string): PriceTable {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as PriceTable;
  if (typeof parsed !== "object" || parsed === null || typeof parsed.models !== "object" || parsed.models === null) {
    throw new Error(`price table ${path} has no "models" object`);
  }
  // Fail early on a badly written price: parse them all once.
  parseDecimalScaled(parsed.usdToEurRate, "usdToEurRate");
  for (const [id, price] of Object.entries(parsed.models)) {
    parseDecimalScaled(price.inputUsdPerMillion, `${id}.inputUsdPerMillion`);
    parseDecimalScaled(price.outputUsdPerMillion, `${id}.outputUsdPerMillion`);
  }
  return parsed;
}

/** The price row for a model, or undefined. Uses an own-property check so "constructor" and friends never match. */
export function priceFor(table: PriceTable, model: string): ModelPrice | undefined {
  return Object.prototype.hasOwnProperty.call(table.models, model) ? table.models[model] : undefined;
}

/**
 * Cost in integer euro cents, rounded UP, for the given token counts.
 *
 * cents = ceil( (inputTokens * inputPrice + outputTokens * outputPrice) / 1,000,000 * usdToEurRate * 100 )
 *
 * Cached prompt tokens are charged at the full input price, which can only
 * over-count (the provider charges less for cached tokens).
 */
export function costCents(table: PriceTable, model: string, usage: TokenUsage): number {
  const price = priceFor(table, model);
  if (!price) throw new Error(`no price for model "${model}" in the price table`);
  const inTokens = assertTokenCount(usage.inputTokens, "inputTokens");
  const outTokens = assertTokenCount(usage.outputTokens, "outputTokens");
  const inPrice = parseDecimalScaled(price.inputUsdPerMillion, "inputUsdPerMillion");
  const outPrice = parseDecimalScaled(price.outputUsdPerMillion, "outputUsdPerMillion");
  const rate = parseDecimalScaled(table.usdToEurRate, "usdToEurRate");

  // Every factor below is scaled by 10^6 except the token counts, so the one
  // division at the end removes: tokens-per-price-unit (10^6), price scale
  // (10^6) and rate scale (10^6).
  const numerator = (inTokens * inPrice + outTokens * outPrice) * rate * 100n;
  const denominator = TOKENS_PER_PRICE_UNIT * SCALE * SCALE;
  const cents = ceilDiv(numerator, denominator);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("cost does not fit in a safe integer");
  return Number(cents);
}
