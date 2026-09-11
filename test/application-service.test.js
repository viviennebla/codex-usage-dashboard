import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createUsageService, SNAPSHOT_REFRESH_POLICIES } from "../src/application-service.js";
import { storeInboundDeviceSnapshot } from "../src/cli.js";

const snapshot = {
  generated_at: new Date().toISOString(),
  today: { date: new Intl.DateTimeFormat("en-CA").format(new Date()), totalTokens: 12 },
  totals: { totalTokens: 12 },
};

function dependencies(overrides = {}) {
  return {
    readStateFile: async () => snapshot,
    mergeWithDeviceStates: async (value) => ({ ...value, merged: true }),
    readConfig: async () => ({ sync: { server: "https://sync.example", token: "token" } }),
    readCodexStatusRateLimits: async () => ({ limits: null, source: "test" }),
    ...overrides,
  };
}

test("viewing a snapshot never implicitly pulls", async () => {
  let pulls = 0;
  let loads = 0;
  const service = createUsageService({ state: "/tmp/cud-service-view.json", stateDir: "/tmp/cud-service" }, dependencies({
    pullFromServer: async () => { pulls += 1; },
    loadAllReports: async () => { loads += 1; return []; },
  }));

  const result = await service.getSnapshot({}, { policy: SNAPSHOT_REFRESH_POLICIES.CACHED });
  assert.equal(result.merged, true);
  assert.equal(pulls, 0);
  assert.equal(loads, 0);
});

test("inbound Web push delegates device storage to the shared service", async () => {
  let call;
  const service = { writeDeviceState: async (...args) => { call = args; } };
  const result = await storeInboundDeviceSnapshot({
    device_id: "remote/device",
    device_name: "Remote",
    snapshot: { schema_version: "0.2" },
  }, service, { stateDir: "/tmp/cud-inbound" });
  assert.deepEqual(result, { ok: true, device_id: "remote_device" });
  assert.deepEqual(call, ["remote_device", "Remote", { schema_version: "0.2" }, { stateDir: "/tmp/cud-inbound" }]);
});

test("force refresh and cached refresh use explicit policies", async () => {
  let loads = 0;
  let writes = 0;
  const service = createUsageService({ state: "/tmp/cud-service-policy.json" }, dependencies({
    loadAllReports: async () => { loads += 1; return [{ source: "test" }]; },
    buildSnapshot: () => ({ ...snapshot, generated_at: new Date().toISOString() }),
    writeStateFile: async () => { writes += 1; },
  }));

  await service.getSnapshot({}, { policy: SNAPSHOT_REFRESH_POLICIES.CACHED, merge: false });
  assert.equal(loads, 0);
  await service.getSnapshot({}, { policy: SNAPSHOT_REFRESH_POLICIES.FORCE, merge: false });
  assert.equal(loads, 1);
  assert.equal(writes, 1);
});

test("stale-while-revalidate returns stale data while one background refresh runs", async () => {
  let release;
  let loads = 0;
  const stale = { ...snapshot, generated_at: "2020-01-01T00:00:00.000Z", today: { date: "2020-01-01", totalTokens: 1 } };
  const service = createUsageService({ state: "/tmp/cud-service-swr.json" }, dependencies({
    readStateFile: async () => stale,
    loadAllReports: async () => {
      loads += 1;
      await new Promise((resolve) => { release = resolve; });
      return [];
    },
    buildSnapshot: () => snapshot,
    writeStateFile: async () => {},
  }));

  const result = await service.getSnapshot({}, {
    policy: SNAPSHOT_REFRESH_POLICIES.STALE_WHILE_REVALIDATE,
    merge: false,
  });
  assert.equal(result.generated_at, stale.generated_at);
  assert.equal(service.cacheStatus().refreshing, true);
  assert.equal(loads, 1);
  release();
  await service.refreshSnapshot();
  assert.equal(service.cacheStatus().refreshing, false);
});

test("closing the service cancels a background JSONL refresh", async () => {
  const stale = { ...snapshot, generated_at: "2020-01-01T00:00:00.000Z", today: { date: "2020-01-01" } };
  const service = createUsageService({ state: "/tmp/cud-service-close.json" }, dependencies({
    readStateFile: async () => stale,
    loadAllReports: async ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
    }),
  }));

  await service.getSnapshot({}, {
    policy: SNAPSHOT_REFRESH_POLICIES.STALE_WHILE_REVALIDATE,
    merge: false,
  });
  const pending = service.refreshSnapshot();
  service.close();
  await assert.rejects(pending, /cancelled/);
});

test("refresh emits a terminal failure event when loading fails", async () => {
  const events = [];
  const service = createUsageService({ state: "/tmp/cud-refresh-failure.json" }, dependencies({
    loadAllReports: async () => { throw new Error("JSONL unavailable"); },
  }));
  await assert.rejects(
    service.refreshSnapshot({}, { onProgress: (event) => events.push(event) }),
    /JSONL unavailable/,
  );
  assert.deepEqual(events.map((event) => event.status), ["running", "failed"]);
  assert.equal(events.at(-1).kind, "snapshot");
});

test("Web/TUI-equivalent requests share the same snapshot pipeline", async () => {
  const calls = [];
  const deps = dependencies({
    loadAllReports: async (options) => { calls.push(["load", options.stateDir]); return []; },
    buildSnapshot: () => snapshot,
    writeStateFile: async () => {},
  });
  const service = createUsageService({ stateDir: "/tmp/cud-equivalent" }, deps);
  const webView = () => service.getSnapshot({}, { policy: SNAPSHOT_REFRESH_POLICIES.FORCE });
  const tuiView = () => service.getSnapshot({}, { policy: SNAPSHOT_REFRESH_POLICIES.FORCE });
  const [webSnapshot, tuiSnapshot] = await Promise.all([
    webView(),
    tuiView(),
  ]);
  assert.deepEqual(webSnapshot, tuiSnapshot);
  assert.deepEqual(calls.map((call) => call[0]), ["load"]);
});

test("pull propagates stateDir and maps partial result status", async () => {
  let pullOptions;
  const service = createUsageService({ stateDir: "/tmp/cud-state-dir" }, dependencies({
    pullFromServer: async (_server, options) => {
      pullOptions = options;
      return { synced: ["other"], skipped: [], failed: [{ deviceId: "bad", error: "offline" }] };
    },
  }));
  const result = await service.pull();
  assert.equal(pullOptions.stateDir, "/tmp/cud-state-dir");
  assert.equal(result.status, "partial");
  assert.equal(result.ok, false);
});

test("push returns the same terminal status contract", async () => {
  const events = [];
  const service = createUsageService({ stateDir: "/tmp/cud-push-status" }, dependencies({
    loadAllReports: async () => [],
    buildSnapshot: () => snapshot,
    writeStateFile: async () => {},
    fetch: async () => ({ ok: false, status: 401, text: async () => "invalid token" }),
  }));
  const result = await service.push({}, { onProgress: (event) => events.push(event.status) });
  assert.equal(result.status, "failed");
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 401);
  assert.deepEqual(events, ["running", "success", "running", "failed"]);
});

test("push and pull emit terminal failures when setup fails", async () => {
  const pushEvents = [];
  const pullEvents = [];
  const broken = dependencies({ readConfig: async () => { throw new Error("config unavailable"); } });
  const service = createUsageService({ stateDir: "/tmp/cud-setup-failure" }, broken);
  const push = await service.push({}, { onProgress: (event) => pushEvents.push(event.status) });
  const pull = await service.pull({}, { onProgress: (event) => pullEvents.push(event.status) });
  assert.equal(push.status, "failed");
  assert.equal(pushEvents.at(-1), "failed");
  assert.equal(pull.status, "failed");
  assert.equal(pullEvents.at(-1), "failed");
});

test("direct pull exits nonzero for a failed remote request", () => {
  const result = spawnSync(process.execPath, [
    "src/cli.js", "pull", "--server", "http://127.0.0.1:1", "--state-dir", "/tmp/cud-review-pull",
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 1);
});

test("source discovery and import use the shared source service", async () => {
  const added = [];
  const service = createUsageService({}, dependencies({
    readConfig: async () => ({ directories: [] }),
    discoverSourceDiagnostics: async () => [{ type: "codex", path: "/tmp/.codex", status: "ok", files_found: 2 }],
    addDirectory: async (...args) => { added.push(args); return { added: true }; },
  }));
  const discovered = await service.discoverSources();
  const result = await service.importSource(discovered[0]);
  assert.equal(result.added, true);
  assert.deepEqual(added, [["/tmp/.codex", "codex", null]]);
});

test("snapshot refresh does not block on live rate limits", async () => {
  let liveReads = 0;
  const service = createUsageService({ state: "/tmp/cud-limits.json" }, dependencies({
    readStateFile: async () => null,
    loadAllReports: async () => [],
    buildSnapshot: () => ({ ...snapshot, limits: { primary: { used_percent: 9 } }, limit_updated_at: "old" }),
    readCodexStatusRateLimits: async () => { liveReads += 1; throw new Error("live unavailable"); },
    writeStateFile: async () => {},
  }));
  const result = await service.getLocalSnapshot({}, { policy: SNAPSHOT_REFRESH_POLICIES.CACHED });
  assert.equal(result.limits.primary.used_percent, 9);
  assert.equal(result.limit_source, "codex_jsonl");
  assert.equal(result.limit_error, null);
  assert.equal(liveReads, 0);
  const live = await service.refreshRateLimits();
  assert.equal(live.status, "failed");
  assert.equal(live.snapshot.limits.primary.used_percent, 9);
  assert.equal(live.snapshot.limit_source, "codex_jsonl_stale");
  assert.equal(live.snapshot.limit_error, "live unavailable");
  assert.equal(liveReads, 1);
});
