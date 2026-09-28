import assert from "node:assert/strict";
import test from "node:test";

import { collectCodexDailyUsage, summarizeCodexDay } from "../src/usage-summary.js";

test("summarizeCodexDay aggregates total, models, and workspace project basenames", () => {
  const result = summarizeCodexDay([
    {
      timestamp: "2026-09-24T01:00:00Z",
      source: "sessions",
      totalTokens: 10,
      model: "gpt-5.6-sol",
      projectName: "vimo-sop",
      projectKind: "workspace",
    },
    {
      timestamp: "2026-09-24T01:30:00Z",
      source: "sessions",
      totalTokens: 20,
      model: "gpt-5.6-sol",
      projectName: "private thread title",
      projectKind: "projectless_thread",
    },
    {
      timestamp: "2026-09-24T02:00:00Z",
      source: "claude",
      totalTokens: 999,
      model: "claude",
      projectName: "ignored",
      projectKind: "workspace",
    },
    {
      timestamp: "2026-09-23T23:00:00Z",
      source: "sessions",
      totalTokens: 5,
      model: "old-model",
      projectName: "old-project",
      projectKind: "workspace",
    },
  ], "2026-09-24", "UTC");

  assert.deepEqual(result, {
    date: "2026-09-24",
    totalTokens: 30,
    models: [{ name: "gpt-5.6-sol", totalTokens: 30 }],
    projects: [{ name: "vimo-sop", totalTokens: 10 }],
  });
});

test("collectCodexDailyUsage scans one native Codex environment and exposes stage timings", async () => {
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
          {
            timestamp: "2026-09-23T16:30:00Z",
            source: "sessions",
            totalTokens: 42,
            model: "gpt-5.6-sol",
            projectName: "demo",
            projectKind: "workspace",
          },
        ],
        timingsMs: {
          scanCandidates: 12,
          parseActiveSessions: 34,
        },
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
  assert.equal(result.date, "2026-09-24");
  assert.equal(result.totalTokens, 42);
  assert.deepEqual(result.models, [{ name: "gpt-5.6-sol", totalTokens: 42 }]);
  assert.deepEqual(result.projects, [{ name: "demo", totalTokens: 42 }]);
  assert.equal(result.timingsMs.scanCandidates, 12);
  assert.equal(result.timingsMs.parseActiveSessions, 34);
  assert.equal(Number.isFinite(result.timingsMs.aggregateModelsProjects), true);
});
