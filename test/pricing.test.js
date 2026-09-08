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

test("prices GPT-5.6 Codex variants as GPT-5.5 until their own table is configured", () => {
  const result = priceEvents([{
    source: "sessions",
    model: "gpt-5.6-sol",
    inputTokens: 1_000_000,
    cacheReadTokens: 0,
    outputTokens: 0,
  }]);

  assert.equal(result.events[0].costUSD, 5);
  assert.equal(result.events[0].costPricingModel, "gpt-5.5");
  assert.equal(result.events[0].costPricingFallback, true);
});

test("recognizes GPT-6 Astra as a Codex model with fallback pricing", () => {
  const result = priceEvents([{
    source: "sessions",
    model: "gpt-6-astra",
    inputTokens: 1_000_000,
    cacheReadTokens: 0,
    outputTokens: 0,
  }]);

  assert.equal(result.events[0].costUSD, 5);
  assert.equal(result.events[0].costPricingModel, "gpt-5.5");
  assert.equal(result.events[0].costPricingFallback, true);
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
