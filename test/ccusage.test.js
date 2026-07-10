import assert from "node:assert/strict";
import test from "node:test";
import { collectCodexToolCalls } from "../src/ccusage.js";

test("collects Codex GUI and MCP tool calls without double-counting call ids", () => {
  const tools = collectCodexToolCalls([
    { type: "function_call", name: "shell_command", call_id: "call-shell" },
    { type: "custom_tool_call", name: "apply_patch", call_id: "call-patch" },
    { type: "mcp_tool_call_end", call_id: "call-mcp", invocation: { server: "node_repl", tool: "js" } },
    { type: "function_call", name: "shell_command", call_id: "call-shell" },
  ]);

  assert.deepEqual(tools, [
    { name: "apply_patch", count: 1, agent: "codex" },
    { name: "node_repl/js", count: 1, agent: "codex" },
    { name: "shell_command", count: 1, agent: "codex" },
  ]);
});
