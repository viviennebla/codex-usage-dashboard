import assert from "node:assert/strict";
import test from "node:test";

import {
  DENGLEMA_TOOLS,
  handleDenglemaMcpRequest,
} from "../src/denglema-mcp.js";

test("MCP initialize advertises only tools", async () => {
  const response = await handleDenglemaMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
});

test("MCP tool list exposes status, bind, latest, upload, and sync compatibility", async () => {
  const response = await handleDenglemaMcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  assert.deepEqual(
    response.result.tools.map((tool) => tool.name),
    [
      "denglema_status",
      "denglema_bind",
      "denglema_latest_snapshot",
      "denglema_upload_latest",
      "denglema_sync",
    ],
  );
  assert.equal(DENGLEMA_TOOLS[0].annotations.readOnlyHint, true);
  assert.equal(DENGLEMA_TOOLS[2].annotations.readOnlyHint, true);
});

test("MCP status never returns a token", async () => {
  const response = await handleDenglemaMcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "denglema_status", arguments: {} },
  }, {
    getDenglemaStatus: async () => ({
      bound: true,
      server: "http://deng.example",
      installation_id: "inst_1",
      has_token: true,
    }),
  });
  const value = JSON.parse(response.result.content[0].text);
  assert.equal(value.installation_id, "inst_1");
  assert.equal(JSON.stringify(value).includes("secret"), false);
});

test("MCP bind uses the fixed internal service and supplied code", async () => {
  let options;
  const response = await handleDenglemaMcpRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "denglema_bind", arguments: { code: "PAIR-123", name: "desk" } },
  }, {
    bindDenglema: async (value) => {
      options = value;
      return { ok: true, installation_id: "inst_2" };
    },
  });
  assert.deepEqual(options, {
    server: "http://10.21.5.77:1600",
    code: "PAIR-123",
    name: "desk",
  });
  assert.equal(JSON.parse(response.result.content[0].text).installation_id, "inst_2");
});

test("MCP latest snapshot is read-only", async () => {
  const response = await handleDenglemaMcpRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "denglema_latest_snapshot", arguments: {} },
  }, {
    getLatestDenglemaSnapshot: async () => ({
      exists: true,
      upload_status: "pending",
      snapshot: { date: "2026-09-27", total_tokens: 123 },
    }),
  });
  const value = JSON.parse(response.result.content[0].text);
  assert.equal(value.upload_status, "pending");
  assert.equal(value.snapshot.total_tokens, 123);
});

test("MCP upload latest does not request a rescan", async () => {
  let called = 0;
  const response = await handleDenglemaMcpRequest({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "denglema_upload_latest", arguments: {} },
  }, {
    uploadLatestDenglemaSnapshot: async () => {
      called += 1;
      return {
        ok: true,
        sample: { date: "2026-09-27", total_tokens: 456 },
        upload_status: "uploaded",
      };
    },
  });
  assert.equal(called, 1);
  assert.equal(JSON.parse(response.result.content[0].text).upload_status, "uploaded");
});

test("MCP sync keeps manual dry_run compatibility", async () => {
  let options;
  const response = await handleDenglemaMcpRequest({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "denglema_sync", arguments: { dry_run: true } },
  }, {
    syncDenglemaUsage: async (value) => {
      options = value;
      return { ok: true, dry_run: true, sample: { date: "2026-09-27", total_tokens: 42 } };
    },
  });
  assert.deepEqual(options, { dryRun: true });
  assert.equal(JSON.parse(response.result.content[0].text).sample.total_tokens, 42);
});

test("MCP tool errors are returned as tool errors", async () => {
  const response = await handleDenglemaMcpRequest({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "denglema_bind", arguments: {} },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /pairing code/i);
});
