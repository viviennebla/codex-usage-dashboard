import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectCodexToolCalls, loadCodexReports } from "../src/ccusage.js";
import { FileParseCache } from "../src/file-cache.js";

test("collects user MCP calls without counting native Codex tools", () => {
  const tools = collectCodexToolCalls([
    { type: "function_call", name: "shell_command", call_id: "call-shell" },
    { type: "custom_tool_call", name: "apply_patch", call_id: "call-patch" },
    { type: "mcp_tool_call_end", call_id: "call-node", invocation: { server: "node_repl", tool: "js" } },
    { type: "mcp_tool_call_end", call_id: "call-mcp", invocation: { server: "github", tool: "search_repositories" } },
    { type: "mcp_tool_call_end", call_id: "call-mcp", invocation: { server: "github", tool: "search_repositories" } },
    { type: "function_call", name: "shell_command", call_id: "call-shell" },
  ]);

  assert.deepEqual(tools, [
    { name: "github/search_repositories", count: 1, agent: "codex" },
  ]);
});

test("keeps GPT-6 Astra attribution when tool results contain model-like fields", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-astra-model-"));
  const sessionDir = join(home, "sessions", "2026", "09", "08");
  const timestamp = "2026-09-08T10:00:00.000Z";
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "rollout-astra.jsonl"), [
    { timestamp, type: "session_meta", payload: { id: "session-astra", cwd: "D:/workspace/example" } },
    { timestamp, type: "turn_context", payload: { model: "gpt-6-astra" } },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "mcp_tool_call_end",
        result: { Ok: { structuredContent: { model_id: "2" } } },
      },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 10,
            total_tokens: 110,
          },
        },
      },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");

  try {
    const report = await loadCodexReports({ codexHomes: [home] });
    assert.equal(report.events.length, 1);
    assert.equal(report.events[0].model, "gpt-6-astra");
    assert.equal(report.daily.totals.models["gpt-6-astra"].totalTokens, 110);
    assert.equal(report.daily.totals.models["2"], undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("incrementally parses appended Codex JSONL records", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-usage-incremental-"));
  const sessions = join(root, "sessions", "2026", "09", "09");
  await mkdir(sessions, { recursive: true });
  const file = join(sessions, "rollout.jsonl");
  const rows = [
    { timestamp: "2026-09-09T00:00:00.000Z", type: "session_meta", payload: { id: "session-1", cwd: "/tmp/project" } },
    { timestamp: "2026-09-09T00:01:00.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } } },
  ];
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const fileCache = new FileParseCache();
  const options = { codexHomes: [root], fileCache, timezone: "UTC" };

  const first = await loadCodexReports(options);
  await appendFile(file, `${JSON.stringify({
    timestamp: "2026-09-09T00:02:00.000Z",
    payload: { type: "token_count", info: { last_token_usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 } } },
  })}\n`);
  const incremental = await loadCodexReports(options);
  const full = await loadCodexReports({ ...options, fileCache: null });

  assert.equal(first.events.length, 1);
  assert.equal(incremental.events.length, 2);
  assert.equal(fileCache.stats().incrementalParses, 1);
  assert.deepEqual(incremental.events, full.events);
  assert.deepEqual(incremental.daily, full.daily);
});

test("activitySince keeps long-lived sessions with recent tail activity", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "codex-activity-filter-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sessions = join(home, "sessions", "2026", "01", "01");
  await mkdir(sessions, { recursive: true });

  const recentFile = join(sessions, "rollout-recent.jsonl");
  const oldFile = join(sessions, "rollout-old.jsonl");
  const makeRows = (timestamp, sessionId, totalTokens) => [
    { timestamp, type: "session_meta", payload: { id: sessionId, cwd: "/tmp/project" } },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: totalTokens,
            output_tokens: 0,
            total_tokens: totalTokens,
          },
        },
      },
    },
  ];

  await writeFile(
    recentFile,
    makeRows("2026-09-24T01:00:00.000Z", "recent-session", 42)
      .map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  await writeFile(
    oldFile,
    makeRows("2026-01-01T01:00:00.000Z", "old-session", 99)
      .map((row) => JSON.stringify(row)).join("\n") + "\n",
  );

  const oldMtime = new Date("2026-01-02T00:00:00.000Z");
  await utimes(recentFile, oldMtime, oldMtime);
  await utimes(oldFile, oldMtime, oldMtime);

  const report = await loadCodexReports({
    codexHomes: [home],
    rawOnly: true,
    usageOnly: true,
    since: "2026-09-23T16:00:00.000Z",
    activitySince: "2026-09-23T16:00:00.000Z",
  });

  assert.equal(report.tool.filesRead, 1);
  assert.equal(report.events.length, 1);
  assert.equal(report.events[0].totalTokens, 42);
});

test("omitting activitySince preserves full file scanning", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "codex-full-scan-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sessions = join(home, "sessions", "2026", "01", "01");
  await mkdir(sessions, { recursive: true });

  const writeSession = async (name, timestamp, totalTokens) => {
    const file = join(sessions, name);
    await writeFile(file, [
      { timestamp, type: "session_meta", payload: { id: name, cwd: "/tmp/project" } },
      {
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: totalTokens, output_tokens: 0, total_tokens: totalTokens } },
        },
      },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    return file;
  };

  await writeSession("rollout-old.jsonl", "2026-01-01T01:00:00.000Z", 99);
  await writeSession("rollout-recent.jsonl", "2026-09-24T01:00:00.000Z", 42);

  const report = await loadCodexReports({
    codexHomes: [home],
    rawOnly: true,
    usageOnly: true,
    since: "2026-09-23T16:00:00.000Z",
  });

  assert.equal(report.tool.filesRead, 2);
  assert.equal(report.events.length, 1);
  assert.equal(report.events[0].totalTokens, 42);
});