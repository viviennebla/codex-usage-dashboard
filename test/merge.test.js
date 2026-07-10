import assert from "node:assert/strict";
import test from "node:test";
import { mergeSnapshots } from "../src/merge.js";

test("recalculates remote model costs from the current price table", () => {
  const usage = {
    inputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    outputTokens: 1_000_000,
    totalTokens: 3_000_000,
    costUSD: 0.03,
    models: {
      "gpt-5.5": {
        inputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 3_000_000,
        costUSD: 0.03,
        costPricingModel: "deepseek-v4-pro",
        costPricingFallback: true,
      },
    },
  };
  const snapshot = {
    today: usage,
    totals: usage,
    models: usage.models,
    recent_days: [],
    activity_days: [],
    top_sessions: [],
    top_projects: [],
  };

  const merged = mergeSnapshots(new Map([["mac", { deviceName: "mac", snapshot }]]));

  assert.equal(merged.today.costUSD, 35.5);
  assert.equal(merged.totals.costUSD, 35.5);
  assert.equal(merged.models["gpt-5.5"].costUSD, 35.5);
  assert.equal(merged.models["gpt-5.5"].costPricingFallback, false);
  assert.equal(merged.cost.pricing.updated_at, "2026-07-10T00:00:00.000Z");
});

test("does not guess a price for an unknown model in a remote aggregate", () => {
  const usage = {
    inputTokens: 1_000_000,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalTokens: 1_000_000,
    costUSD: 0.435,
    models: {
      unknown: {
        inputTokens: 1_000_000,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 1_000_000,
        costUSD: 0.435,
        costPricingModel: "deepseek-v4-pro",
        costPricingFallback: true,
      },
    },
  };
  const snapshot = { today: usage, totals: usage, models: usage.models };

  const merged = mergeSnapshots(new Map([["remote", { deviceName: "remote", snapshot }]]));

  assert.equal(merged.today.costUSD, null);
  assert.equal(merged.models.unknown.costUSD, null);
});

test("marks model request counts incomplete when an older snapshot omits them", () => {
  const usage = (eventCount) => ({
    totalTokens: 100,
    models: {
      "gpt-5.5": {
        totalTokens: 100,
        ...(eventCount === undefined ? {} : { eventCount }),
      },
    },
  });
  const legacy = usage();
  const current = usage(4);
  const merged = mergeSnapshots(new Map([
    ["legacy", { deviceName: "legacy", snapshot: { today: legacy, totals: legacy, models: legacy.models } }],
    ["current", { deviceName: "current", snapshot: { today: current, totals: current, models: current.models } }],
  ]));

  assert.equal(merged.today.models["gpt-5.5"].eventCount, 4);
  assert.equal(merged.today.models["gpt-5.5"].eventCountIncomplete, true);
});
