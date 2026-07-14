import assert from "node:assert/strict";
import test from "node:test";
import { collectCodexToolCalls } from "../src/ccusage.js";

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
