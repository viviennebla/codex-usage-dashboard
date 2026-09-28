import assert from "node:assert/strict";
import test from "node:test";

import {
  DENGLEMA_TOOLS,
  checkDenglemaPluginUpdate,
  compareDenglemaVersions,
  handleDenglemaMcpRequest,
  nextDenglemaSnapshotDelay,
  startDenglemaSnapshotScheduler,
} from "../src/denglema-mcp.js";

test("snapshot scheduler delay targets one hour after the latest observation", () => {
  const now = new Date("2026-09-27T09:30:00Z");
  assert.equal(
    nextDenglemaSnapshotDelay(
      { observed_at: "2026-09-27T09:00:00.000Z" },
      now,
    ),
    30 * 60 * 1000,
  );
  assert.equal(
    nextDenglemaSnapshotDelay(
      { observed_at: "2026-09-27T08:00:00.000Z" },
      now,
    ),
    60 * 1000,
  );
});

test("snapshot scheduler collects immediately and notifies without an agent turn", async () => {
  let collects = 0;
  let notifications = 0;
  let scheduledDelay = null;
  let cleared = false;

  let onboardingChecks = 0;
  const scheduler = startDenglemaSnapshotScheduler({
    maybeOpenDenglemaOnboarding: async () => {
      onboardingChecks += 1;
      return { opened: false, reason: "bound" };
    },
    getDenglemaStatus: async () => ({ bound: true }),
    collectDenglemaSnapshot: async () => {
      collects += 1;
      return {
        collected: true,
        upload_status: "pending",
        snapshot: { observed_at: "2026-09-27T09:00:00.000Z" },
      };
    },
    maybeNotifyDenglemaSnapshot: async () => {
      notifications += 1;
      return { notified: true };
    },
    now: () => new Date("2026-09-27T09:30:00Z"),
    setTimeout: (_fn, delay) => {
      scheduledDelay = delay;
      return { unref() {} };
    },
    clearTimeout: () => { cleared = true; },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(collects, 1);
  assert.equal(notifications, 1);
  assert.equal(onboardingChecks, 1);
  assert.equal(scheduledDelay, 30 * 60 * 1000);

  scheduler.stop();
  assert.equal(cleared, true);
});

test("snapshot scheduler keeps running when native notification fails", async () => {
  let scheduledDelay = null;

  const scheduler = startDenglemaSnapshotScheduler({
    maybeOpenDenglemaOnboarding: async () => ({ opened: false, reason: "bound" }),
    getDenglemaStatus: async () => ({ bound: true }),
    collectDenglemaSnapshot: async () => ({
      collected: true,
      upload_status: "pending",
      snapshot: { observed_at: "2026-09-27T09:00:00.000Z" },
    }),
    maybeNotifyDenglemaSnapshot: async () => {
      throw new Error("notifications unavailable");
    },
    now: () => new Date("2026-09-27T09:30:00Z"),
    setTimeout: (_fn, delay) => {
      scheduledDelay = delay;
      return { unref() {} };
    },
    clearTimeout: () => {},
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduledDelay, 30 * 60 * 1000);
  scheduler.stop();
});

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



test("plugin version comparison and unavailable checks are safe", async () => {
  assert.equal(compareDenglemaVersions("0.1.13", "0.1.12"), 1);
  assert.equal(compareDenglemaVersions("0.1.12", "0.1.12"), 0);
  assert.equal(compareDenglemaVersions("0.1.11", "0.1.12"), -1);

  const result = await checkDenglemaPluginUpdate({
    fetch: async () => { throw new Error("offline"); },
  });
  assert.equal(result.current_version, "0.1.12");
  assert.equal(result.latest_version, null);
  assert.equal(result.update_available, false);
  assert.equal(result.update_check, "unavailable");
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
    fetch: async () => ({
      ok: true,
      json: async () => ({ version: "0.1.13" }),
    }),
    getLatestDenglemaSnapshot: async () => ({
      exists: true,
      upload_status: "pending",
      snapshot: {
        schema_version: 2,
        total_tokens: 1234,
        models: [{ name: "gpt-5.6-sol", total_tokens: 1000 }],
        projects: [{ name: "vimo-sop", total_tokens: 1234 }],
      },
      last_uploaded_schema_version: 1,
    }),
  });
  const value = JSON.parse(response.result.content[0].text);
  assert.equal(value.installation_id, "inst_1");
  assert.equal(value.plugin.current_version, "0.1.12");
  assert.equal(value.plugin.latest_version, "0.1.13");
  assert.equal(value.plugin.update_available, true);
  assert.equal(value.local_snapshot.schema_version, 2);
  assert.equal(value.local_snapshot.upload_status, "pending");
  assert.equal(value.local_snapshot.breakdown_upload_pending, true);
  assert.equal(value.local_snapshot.has_model_breakdown, true);
  assert.equal(value.local_snapshot.has_project_breakdown, true);
  assert.equal(value.local_snapshot.last_uploaded_schema_version, 1);
  assert.deepEqual(value.plugin.update_commands, [
    "codex plugin marketplace upgrade denglema",
    "codex plugin add denglema@denglema",
  ]);
  assert.equal(JSON.stringify(value).includes("secret"), false);
});

test("MCP bind uses the fixed service and uploads the latest snapshot once", async () => {
  let options;
  let uploads = 0;
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
    getLatestDenglemaSnapshot: async () => ({
      exists: true,
      snapshot: { date: "2026-09-28", total_tokens: 789 },
    }),
    uploadLatestDenglemaSnapshot: async () => {
      uploads += 1;
      return {
        ok: true,
        sample: { date: "2026-09-28", total_tokens: 789 },
        upload_status: "uploaded",
      };
    },
  });
  assert.deepEqual(options, {
    server: "https://vimo-dev-server.taila62aff.ts.net",
    code: "PAIR-123",
    name: "desk",
  });
  const value = JSON.parse(response.result.content[0].text);
  assert.equal(value.installation_id, "inst_2");
  assert.deepEqual(value.initial_upload, {
    status: "uploaded",
    date: "2026-09-28",
    total_tokens: 789,
  });
  assert.equal(uploads, 1);
});

test("MCP bind stays successful when there is no local snapshot", async () => {
  const response = await handleDenglemaMcpRequest({
    jsonrpc: "2.0",
    id: 40,
    method: "tools/call",
    params: { name: "denglema_bind", arguments: { code: "PAIR-EMPTY" } },
  }, {
    bindDenglema: async () => ({ ok: true, installation_id: "inst_empty" }),
    getLatestDenglemaSnapshot: async () => ({
      exists: false,
      snapshot: null,
      upload_status: "missing",
    }),
    uploadLatestDenglemaSnapshot: async () => {
      throw new Error("upload should not run");
    },
  });
  const value = JSON.parse(response.result.content[0].text);
  assert.equal(value.installation_id, "inst_empty");
  assert.deepEqual(value.initial_upload, {
    status: "skipped",
    reason: "no_snapshot",
  });
});

test("MCP bind preserves binding when initial upload fails", async () => {
  const response = await handleDenglemaMcpRequest({
    jsonrpc: "2.0",
    id: 41,
    method: "tools/call",
    params: { name: "denglema_bind", arguments: { code: "PAIR-FAIL" } },
  }, {
    bindDenglema: async () => ({ ok: true, installation_id: "inst_fail" }),
    getLatestDenglemaSnapshot: async () => ({
      exists: true,
      snapshot: { date: "2026-09-28", total_tokens: 321 },
    }),
    uploadLatestDenglemaSnapshot: async () => {
      throw new Error("network down");
    },
  });
  const value = JSON.parse(response.result.content[0].text);
  assert.equal(value.installation_id, "inst_fail");
  assert.deepEqual(value.initial_upload, {
    status: "failed",
    error: "network down",
  });
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
