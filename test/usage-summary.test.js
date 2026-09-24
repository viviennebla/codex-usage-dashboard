import assert from "node:assert/strict";
import test from "node:test";

import { collectCodexDailyUsage, summarizeCodexDay } from "../src/usage-summary.js";

test("summarizeCodexDay ignores Claude events and other days", () => {
  const result = summarizeCodexDay([
    { timestamp: "2026-09-24T01:00:00Z", source: "sessions", totalTokens: 10 },
    { timestamp: "2026-09-24T02:00:00Z", source: "claude", totalTokens: 999 },
    { timestamp: "2026-09-23T23:00:00Z", source: "sessions", totalTokens: 5 },
  ], "2026-09-24", "UTC");
  assert.deepEqual(result, { date: "2026-09-24", totalTokens: 10 });
});

test("collectCodexDailyUsage scans one native Codex environment since local day start", async () => {
  let received;
  let resolved;
  const result = await collectCodexDailyUsage({ timezone: "Asia/Shanghai" }, {
    now: () => new Date("2026-09-24T12:00:00Z"),
    resolveCodexHomes: async (directories, options) => {
      resolved = { directories, options };
      return ["/native/.codex"];
    },
    loadCodexReports: async (options) => {
      received = options;
      return {
        events: [
          { timestamp: "2026-09-23T16:30:00Z", source: "sessions", totalTokens: 42 },
        ],
      };
    },
  });

  assert.deepEqual(resolved.directories, []);
  assert.equal(resolved.options.includeDefaults, true);
  assert.equal(resolved.options.noWsl, true);
  assert.deepEqual(received.codexHomes, ["/native/.codex"]);
  assert.equal(received.rawOnly, true);
  assert.equal(received.usageOnly, true);
  assert.equal(received.since, "2026-09-23T16:00:00.000Z");
  assert.equal(received.activitySince, received.since);
  assert.deepEqual(result, { date: "2026-09-24", totalTokens: 42 });
});