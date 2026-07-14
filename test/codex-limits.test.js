import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRateLimitsResponse } from "../src/codex-limits.js";

test("normalizes Codex app-server limits without involving a model provider", () => {
  const result = normalizeRateLimitsResponse({
    rateLimits: {
      limitId: "legacy",
      primary: { usedPercent: 99, windowDurationMins: 15, resetsAt: 1 },
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        planType: "pro",
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: 1_800_100_000 },
      },
      codex_fast: {
        limitId: "codex_fast",
        limitName: "Fast model",
        primary: { usedPercent: 5, windowDurationMins: 10_080, resetsAt: 1_800_200_000 },
      },
    },
  });

  assert.equal(result.limits.limit_id, "codex");
  assert.equal(result.limits.plan_type, "pro");
  assert.equal(result.limits.primary.used_percent, 12);
  assert.equal(result.limits.primary.window_minutes, 300);
  assert.equal(result.limits.secondary.window_minutes, 10_080);
  assert.equal(result.limit_buckets.codex_fast.limit_name, "Fast model");
});
