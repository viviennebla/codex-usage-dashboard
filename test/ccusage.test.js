import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectCodexToolCalls, loadCodexReports } from "../src/ccusage.js";

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
