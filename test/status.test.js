import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCodexStatusRateLimits, preserveLoggedRateLimits } from "../src/status.js";

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

test("keeps JSONL rate limits when live status refresh fails", () => {
  const snapshot = {
    limits: { primary: { used_percent: 32 } },
    limit_updated_at: "2026-09-09T02:32:34.395Z",
  };
  const result = preserveLoggedRateLimits(snapshot, new Error("app-server unavailable"));

  assert.equal(result.limits.primary.used_percent, 32);
  assert.equal(result.limit_updated_at, snapshot.limit_updated_at);
  assert.equal(result.limit_source, "codex_jsonl_stale");
  assert.equal(result.limit_error, "app-server unavailable");
});
