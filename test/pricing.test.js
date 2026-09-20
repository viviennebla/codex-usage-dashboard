import assert from "node:assert/strict";
import test from "node:test";
import { calculateEventCostUSD, priceEvents } from "../src/pricing.js";
import {
  isDeviceSyncDisabled,
  shouldFetchRemoteSnapshot,
  shouldReplaceSnapshot,
  updateDeviceSyncPreference,
} from "../src/sync.js";

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
  assert.equal(result.meta.updated_at, "2026-09-11T00:00:00.000Z");
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

test("prices GPT-5.6 Sol with its current direct rate", () => {
  const result = priceEvents([{
    source: "sessions",
    model: "gpt-5.6-sol",
    inputTokens: 1_000_000,
    cacheReadTokens: 0,
    outputTokens: 0,
  }]);

  assert.equal(result.events[0].costUSD, 4);
  assert.equal(result.events[0].costPricingModel, "gpt-5.6-sol");
  assert.equal(result.events[0].costPricingFallback, false);
});

test("prices GPT-6 Astra with its current direct rate", () => {
  const result = priceEvents([{
    source: "sessions",
    model: "gpt-6-astra",
    inputTokens: 1_000_000,
    cacheReadTokens: 0,
    outputTokens: 0,
  }]);

  assert.equal(result.events[0].costUSD, 10);
  assert.equal(result.events[0].costPricingModel, "gpt-6-astra");
  assert.equal(result.events[0].costPricingFallback, false);
});

test("prices the GPT-5.6 family with direct input, cache, cache-write, and output rates", () => {
  const expected = {
    "gpt-5.6-sol": 29.4,
    "gpt-5.6-terra": 16.7,
    "gpt-5.6-luna": 1.67,
  };

  for (const [model, costUSD] of Object.entries(expected)) {
    const result = priceEvents([{
      source: "sessions",
      model,
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
      outputTokens: 1_000_000,
    }]);
    assert.equal(result.events[0].costUSD, costUSD);
    assert.equal(result.events[0].costPricingFallback, false);
  }
});

test("marks GPT-5.3 Codex Spark as an estimate based on the official Codex family rate", () => {
  const result = priceEvents([{
    source: "sessions",
    model: "gpt-5.3-codex-spark",
    inputTokens: 1_000_000,
    outputTokens: 0,
  }]);

  assert.equal(result.events[0].costUSD, 1.75);
  assert.equal(result.events[0].costPricingModel, "gpt-5.3-codex");
  assert.equal(result.events[0].costPricingFallback, true);
});

test("prices GPT-5.4 Mini with its direct standard API rate", () => {
  const result = priceEvents([{
    source: "sessions",
    model: "gpt-5.4-mini",
    inputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    outputTokens: 1_000_000,
  }]);

  assert.equal(result.events[0].costUSD, 5.325);
  assert.equal(result.events[0].costPricingModel, "gpt-5.4-mini");
  assert.equal(result.events[0].costPricingFallback, false);
});

test("prices Claude Opus 4.8 with its direct standard API and 5-minute cache-write rates", () => {
  const result = priceEvents([{
    source: "claude",
    model: "claude-opus-4-8",
    inputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    outputTokens: 1_000_000,
  }]);

  assert.equal(result.events[0].costUSD, 36.75);
  assert.equal(result.events[0].costPricingModel, "claude-opus-4-8");
  assert.equal(result.events[0].costPricingFallback, false);
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

test("skips fetching unchanged remote snapshots by device metadata", () => {
  assert.equal(
    shouldFetchRemoteSnapshot(
      { generated_at: "2026-07-10T02:30:00.000Z" },
      { generated_at: "2026-07-10T02:30:00.000Z" },
    ),
    false,
  );
  assert.equal(
    shouldFetchRemoteSnapshot(
      { generated_at: "2026-07-10T02:18:00.000Z" },
      { generated_at: "2026-07-10T02:30:00.000Z" },
    ),
    true,
  );
  assert.equal(
    shouldFetchRemoteSnapshot(
      { generated_at: "2026-07-10T02:30:00.000Z" },
      { generated_at: null },
    ),
    true,
  );
});

test("persists a local stop-sync preference until the device is resumed", () => {
  const disabled = updateDeviceSyncPreference(
    { devices: { retired: { todayTokens: 100 } } },
    "retired",
    false,
    { deviceName: "Old laptop", totalTokens: 500, disabledAt: "2026-09-08T00:00:00Z" },
  );

  assert.equal(isDeviceSyncDisabled(disabled, "retired"), true);
  assert.equal(disabled.devices.retired, undefined);
  assert.equal(disabled.disabledDevices.retired.deviceName, "Old laptop");

  const resumed = updateDeviceSyncPreference(disabled, "retired", true);
  assert.equal(isDeviceSyncDisabled(resumed, "retired"), false);
});
