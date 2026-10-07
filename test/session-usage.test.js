import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSessionUsageWindows, summarizeSessionUsageWindows } from "../src/session-usage.js";

test("session usage windows aggregate only the requested session and time range", () => {
  const windows = normalizeSessionUsageWindows([{
    key: "run-1",
    sessionId: "thread-1",
    since: "2026-10-07T00:00:00Z",
    until: "2026-10-07T00:10:00Z",
  }]);
  const result = summarizeSessionUsageWindows([
    { sessionId: "thread-1", timestamp: "2026-10-07T00:01:00Z", inputTokens: 7, cacheReadTokens: 3, outputTokens: 2, totalTokens: 12, costUSD: 0.01 },
    { sessionId: "thread-1", timestamp: "2026-10-07T00:09:00Z", inputTokens: 4, outputTokens: 1, reasoningOutputTokens: 1, totalTokens: 5, costUSD: 0.02 },
    { sessionId: "thread-1", timestamp: "2026-10-07T00:11:00Z", totalTokens: 99 },
    { sessionId: "thread-2", timestamp: "2026-10-07T00:05:00Z", totalTokens: 88 },
  ], windows);
  assert.equal(result[0].status, "matched");
  assert.deepEqual(result[0].usage, {
    inputTokens: 11,
    cacheCreationTokens: 0,
    cacheReadTokens: 3,
    outputTokens: 3,
    reasoningOutputTokens: 1,
    totalTokens: 17,
    eventCount: 2,
    costUSD: 0.03,
    firstActivity: "2026-10-07T00:01:00Z",
    lastActivity: "2026-10-07T00:09:00Z",
  });
});

test("missing usage stays explicit instead of becoming a zero attribution", () => {
  const windows = normalizeSessionUsageWindows([{
    key: "run-2",
    sessionId: "thread-missing",
    since: "2026-10-07T00:00:00Z",
    until: "2026-10-07T00:01:00Z",
  }]);
  const [result] = summarizeSessionUsageWindows([], windows);
  assert.equal(result.status, "no_events");
  assert.equal(result.usage, null);
});

test("window validation rejects malformed or reversed ranges", () => {
  assert.throws(() => normalizeSessionUsageWindows({}), /array/);
  assert.throws(() => normalizeSessionUsageWindows([{ key: "r", sessionId: "s", since: "bad", until: "2026-10-07T00:00:00Z" }]), /ISO timestamp/);
  assert.throws(() => normalizeSessionUsageWindows([{ key: "r", sessionId: "s", since: "2026-10-07T00:02:00Z", until: "2026-10-07T00:01:00Z" }]), /must not be before/);
});
