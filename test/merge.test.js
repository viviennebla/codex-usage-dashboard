import assert from "node:assert/strict";
import test from "node:test";
import { mergeSnapshots } from "../src/merge.js";

function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

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

test("does not merge a stale device's prior-day today usage", () => {
  const date = localDate();
  const usage = (rowDate, totalTokens, eventCount) => ({
    date: rowDate,
    totalTokens,
    models: {
      "deepseek-v4-pro": { totalTokens, eventCount },
    },
  });
  const current = usage(date, 40, 2);
  const stale = usage("2000-01-01", 900, 45);
  const merged = mergeSnapshots(new Map([
    ["current", { deviceName: "current", snapshot: { today: current, totals: current, models: current.models } }],
    ["stale", { deviceName: "stale", snapshot: { today: stale, totals: stale, models: stale.models } }],
  ]));

  assert.equal(merged.today.date, date);
  assert.equal(merged.today.totalTokens, 40);
  assert.equal(merged.today.models["deepseek-v4-pro"].eventCount, 2);
});

test("does not expose stale device usage in environment today views", () => {
  const date = localDate();
  const snapshot = {
    today: { date, totalTokens: 20, models: {} },
    totals: { totalTokens: 20, models: {} },
    models: {},
    trend_views: [{
      id: "macos",
      label: "macOS",
      display_name: "macOS",
      recent_days: [],
      today: { date: "2000-01-01", totalTokens: 900, models: {} },
      totals: { totalTokens: 900, models: {} },
    }],
  };
  const merged = mergeSnapshots(new Map([["stale", { deviceName: "stale", snapshot }]]));
  const view = merged.trend_views.find((item) => item.id === "macOS");

  assert.equal(view.today.totalTokens, 0);
  assert.equal(view.totals.totalTokens, 900);
});

test("combines trend views by environment across synced devices", () => {
  const view = (tokens) => ({
    id: "windows",
    label: "windows",
    display_name: "windows",
    environment: "windows",
    recent_days: [{ date: "2026-07-14", totalTokens: tokens, eventCount: 1 }],
    today: { totalTokens: tokens, eventCount: 1 },
    totals: { totalTokens: tokens, eventCount: 1 },
  });
  const merged = mergeSnapshots(new Map([
    ["one", { deviceName: "one", snapshot: { trend_views: [view(100)], today: view(100).today, totals: view(100).totals } }],
    ["two", { deviceName: "two", snapshot: { trend_views: [view(200)], today: view(200).today, totals: view(200).totals } }],
  ]));

  const windows = merged.trend_views.find((entry) => entry.id === "windows");
  assert.equal(windows.today.totalTokens, 300);
  assert.equal(windows.totals.totalTokens, 300);
  assert.deepEqual(windows.device_names, ["one", "two"]);
});

test("keeps existing project costs when an older snapshot lacks model details", () => {
  const merged = mergeSnapshots(new Map([
    ["legacy", {
      deviceName: "legacy",
      snapshot: {
        today: { totalTokens: 10 },
        totals: { totalTokens: 10 },
        top_projects: [{ projectName: "app", totalTokens: 10, costUSD: 1.23 }],
      },
    }],
  ]));

  assert.equal(merged.top_projects[0].costUSD, 1.23);
});
