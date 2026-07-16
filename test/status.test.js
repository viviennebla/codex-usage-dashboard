import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCodexStatusRateLimits } from "../src/status.js";

test("normalizes Codex app-server rate limit status", () => {
  const limits = normalizeCodexStatusRateLimits({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        planType: "prolite",
        primary: {
          usedPercent: 27,
          windowDurationMins: 10080,
          resetsAt: 1784506916,
        },
        secondary: null,
      },
    },
  });

  assert.equal(limits.limit_id, "codex");
  assert.equal(limits.plan_type, "prolite");
  assert.equal(limits.primary.used_percent, 27);
  assert.equal(limits.primary.window_minutes, 10080);
  assert.equal(limits.primary.resets_at, "2026-07-20T00:21:56.000Z");
});
