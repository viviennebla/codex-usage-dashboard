import assert from "node:assert/strict";
import test from "node:test";
import { calculateEventCostUSD, priceEvents } from "../src/pricing.js";
import { shouldReplaceSnapshot } from "../src/sync.js";

test("prices GPT-5.5 with its standard input, cache, and output rates", () => {
  const cost = calculateEventCostUSD({
    source: "sessions",
    model: "gpt-5.5",
    inputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    outputTokens: 1_000_000,
  });

  assert.equal(cost, 35.5);
});

test("prices an unrecognized Codex product mode as GPT-5.5 and marks the fallback", () => {
  const result = priceEvents([{
    source: "sessions",
    model: "codex-auto-review",
    inputTokens: 1_000_000,
    cacheReadTokens: 0,
    outputTokens: 0,
  }]);

  assert.equal(result.events[0].costUSD, 5);
  assert.equal(result.events[0].costPricingModel, "gpt-5.5");
  assert.equal(result.events[0].costPricingFallback, true);
  assert.equal(result.meta.updated_at, "2026-07-10T00:00:00.000Z");
});

test("keeps DeepSeek models on their own direct price table", () => {
  const result = priceEvents([{
    source: "sessions",
    model: "deepseek-v4-pro",
    inputTokens: 1_000_000,
    cacheReadTokens: 0,
    outputTokens: 0,
  }]);

  assert.equal(result.events[0].costUSD, 0.435);
  assert.equal(result.events[0].costPricingModel, "deepseek-v4-pro");
  assert.equal(result.events[0].costPricingFallback, false);
});

test("does not estimate a named model without an official price entry", () => {
  const result = priceEvents([{
    source: "sessions",
    model: "gpt-5.6-sol",
    inputTokens: 1_000_000,
    cacheReadTokens: 0,
    outputTokens: 0,
  }]);

  assert.equal(result.events[0].costUSD, null);
  assert.deepEqual(result.meta.unpriced_models, ["gpt-5.6-sol"]);
});

test("keeps a newer local snapshot when a pull returns an older one", () => {
  assert.equal(
    shouldReplaceSnapshot(
      { generated_at: "2026-07-10T02:30:00.000Z" },
      { generated_at: "2026-07-10T02:18:00.000Z" },
    ),
    false,
  );
  assert.equal(
    shouldReplaceSnapshot(
      { generated_at: "2026-07-10T02:18:00.000Z" },
      { generated_at: "2026-07-10T02:30:00.000Z" },
    ),
    true,
  );
});
