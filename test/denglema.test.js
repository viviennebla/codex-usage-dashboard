import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bindDenglema,
  buildDenglemaUsageSample,
  collectDenglemaSnapshot,
  configureDenglemaAutoUpload,
  getDenglemaStatus,
  normalizeDenglemaUsageLimits,
  syncDenglemaUsage,
  uploadLatestDenglemaSnapshot,
} from "../src/denglema.js";
import { getLatestDenglemaSnapshot, resolveDenglemaDataDir, snapshotUploadStatus } from "../src/denglema-snapshot.js";

async function withTempData(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "denglema-test-"));
  try {
    return await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("Denglema data dir stays stable across plugin runtime env injection", () => {
  const resolved = resolveDenglemaDataDir({}, {
    env: {
      PLUGIN_DATA: "/tmp/plugin-data-should-not-win",
      CLAUDE_PLUGIN_DATA: "/tmp/claude-plugin-data-should-not-win",
    },
  });
  assert.equal(resolved.endsWith("/.codex-usage/denglema"), true);
});

test("usage sample contains only cumulative daily total", () => {
  const sample = buildDenglemaUsageSample(
    { date: "2026-09-24", totalTokens: 12345 },
    new Date("2026-09-24T08:00:00Z"),
  );
  assert.deepEqual(sample, {
    schema_version: 2,
    harness: "codex",
    observed_at: "2026-09-24T08:00:00.000Z",
    date: "2026-09-24",
    total_tokens: 12345,
    models: [],
    projects: [],
  });
});



test("usage-limit snapshots record remaining quota without absolute account quota", () => {
  const limits = normalizeDenglemaUsageLimits({
    limit_updated_at: "2026-09-30T07:00:00Z",
    limits: {
      primary: {
        used_percent: 82.5,
        window_minutes: 300,
        resets_at: "2026-09-30T09:00:00Z",
      },
      secondary: {
        used_percent: 41,
        window_minutes: 10080,
        resets_at: "2026-10-05T00:00:00Z",
      },
    },
  });

  assert.deepEqual(limits, {
    updated_at: "2026-09-30T07:00:00.000Z",
    primary: {
      used_percent: 82.5,
      remaining_percent: 17.5,
      window_minutes: 300,
      resets_at: "2026-09-30T09:00:00.000Z",
    },
    secondary: {
      used_percent: 41,
      remaining_percent: 59,
      window_minutes: 10080,
      resets_at: "2026-10-05T00:00:00.000Z",
    },
  });

  const sample = buildDenglemaUsageSample(
    { date: "2026-09-30", totalTokens: 123 },
    new Date("2026-09-30T07:00:00Z"),
    "codex",
    { limits, limit_updated_at: limits.updated_at },
  );
  assert.equal(sample.usage_limits.primary.remaining_percent, 17.5);
});

test("collector falls back to the latest native rate-limit event when live status is unavailable", async () => withTempData(async (dataDir) => {
  const result = await collectDenglemaSnapshot({ dataDir, force: true }, {
    readConfig: async () => ({ denglema: { timezone: "UTC" } }),
    collectCodexDailyUsage: async () => ({
      date: "2026-09-30",
      totalTokens: 1234,
      models: [],
      projects: [],
      rateLimits: {
        primary: {
          used_percent: 80,
          window_minutes: 10080,
          resets_at: "2026-10-04T05:04:22.000Z",
        },
        secondary: null,
      },
      rateLimitsUpdatedAt: "2026-09-30T09:32:42.953Z",
    }),
    readCodexStatusRateLimits: async () => {
      throw new Error("failed to initialize sqlite state runtime under /home/smore/.codex");
    },
    env: {},
    now: () => new Date("2026-09-30T09:40:00Z"),
  });

  assert.equal(result.collected, true);
  assert.deepEqual(result.snapshot.usage_limits, {
    updated_at: "2026-09-30T09:32:42.953Z",
    primary: {
      used_percent: 80,
      remaining_percent: 20,
      window_minutes: 10080,
      resets_at: "2026-10-04T05:04:22.000Z",
    },
    secondary: null,
  });
}));

test("collector prefers live rate limits over JSONL fallback when live status is valid", async () => withTempData(async (dataDir) => {
  const result = await collectDenglemaSnapshot({ dataDir, force: true }, {
    readConfig: async () => ({ denglema: { timezone: "UTC" } }),
    collectCodexDailyUsage: async () => ({
      date: "2026-09-30",
      totalTokens: 1234,
      models: [],
      projects: [],
      rateLimits: {
        primary: { used_percent: 80, window_minutes: 10080 },
        secondary: null,
      },
      rateLimitsUpdatedAt: "2026-09-30T09:32:42.953Z",
    }),
    readCodexStatusRateLimits: async () => ({
      limits: {
        primary: {
          used_percent: 25,
          window_minutes: 300,
          resets_at: "2026-09-30T12:00:00Z",
        },
        secondary: null,
      },
      limit_updated_at: "2026-09-30T09:39:00Z",
      source: "codex_status_api",
    }),
    env: {},
    now: () => new Date("2026-09-30T09:40:00Z"),
  });

  assert.equal(result.snapshot.usage_limits.primary.used_percent, 25);
  assert.equal(result.snapshot.usage_limits.primary.remaining_percent, 75);
  assert.equal(result.snapshot.usage_limits.updated_at, "2026-09-30T09:39:00.000Z");
}));

test("newer usage-limit observation stays pending even when tokens did not change", () => {
  const snapshot = {
    schema_version: 2,
    date: "2026-09-30",
    total_tokens: 1000,
    usage_limits: { updated_at: "2026-09-30T08:00:00.000Z" },
  };
  assert.equal(snapshotUploadStatus(snapshot, {
    schema_version: 2,
    date: "2026-09-30",
    total_tokens: 1000,
    usage_limits_updated_at: "2026-09-30T07:00:00.000Z",
  }), "pending");
  assert.equal(snapshotUploadStatus(snapshot, {
    schema_version: 2,
    date: "2026-09-30",
    total_tokens: 1000,
    usage_limits_updated_at: "2026-09-30T08:00:00.000Z",
  }), "uploaded");
});

test("schema v2 snapshot stays pending after only a legacy v1 upload", () => {
  const snapshot = {
    schema_version: 2,
    date: "2026-09-28",
    total_tokens: 1000,
    models: [{ name: "gpt-5.6-sol", total_tokens: 1000 }],
    projects: [{ name: "vimo-sop", total_tokens: 1000 }],
  };
  assert.equal(snapshotUploadStatus(snapshot, {
    date: "2026-09-28",
    total_tokens: 1000,
  }), "pending");
  assert.equal(snapshotUploadStatus(snapshot, {
    schema_version: 2,
    date: "2026-09-28",
    total_tokens: 1000,
  }), "uploaded");
});

test("status never exposes the installation token", async () => {
  const status = await getDenglemaStatus({}, {
    readConfig: async () => ({
      denglema: {
        server: "https://deng.example/",
        installationId: "inst_1",
        token: "do-not-print",
        timezone: "Asia/Shanghai",
      },
    }),
    env: {},
    readCodexStatusRateLimits: async () => ({ limits: null }),
  });

  assert.deepEqual(status, {
    bound: true,
    server: "https://deng.example",
    installation_id: "inst_1",
    timezone: "Asia/Shanghai",
    has_token: true,
    auto_upload: {
      enabled: false,
      interval: null,
    },
  });
  assert.equal(JSON.stringify(status).includes("do-not-print"), false);
});

test("auto upload configuration requires an allowed explicit interval", async () => {
  let saved;
  const enabled = await configureDenglemaAutoUpload({
    enabled: true,
    interval: "3h",
  }, {
    updateDenglemaAutoUpload: async (value) => {
      saved = value;
      return value;
    },
  });
  assert.deepEqual(saved, { enabled: true, interval: "3h" });
  assert.deepEqual(enabled, { enabled: true, interval: "3h" });

  const disabled = await configureDenglemaAutoUpload({
    enabled: false,
  }, {
    updateDenglemaAutoUpload: async (value) => value,
  });
  assert.deepEqual(disabled, { enabled: false, interval: null });

  await assert.rejects(
    configureDenglemaAutoUpload({
      enabled: true,
      interval: "15m",
    }, {
      updateDenglemaAutoUpload: async (value) => value,
    }),
    /1h, 3h, 6h, 1d/,
  );
});

test("bind stores opaque installation credentials returned by pairing", async () => {
  let saved;
  const result = await bindDenglema({
    server: "https://deng.example/",
    code: "ABCD-EFGH",
    name: "gpu-01",
  }, {
    readConfig: async () => ({ denglema: {} }),
    updateDenglemaConnection: async (value) => { saved = value; },
    fetch: async (url, init) => {
      assert.equal(url, "https://deng.example/api/installations/pair");
      assert.deepEqual(JSON.parse(init.body), {
        code: "ABCD-EFGH",
        installation_name: "gpu-01",
      });
      return {
        ok: true,
        json: async () => ({
          installation_id: "inst_1",
          token: "secret",
          user_id: "u_1",
          timezone: "Asia/Shanghai",
        }),
      };
    },
  });
  assert.equal(result.user_id, "u_1");
  assert.deepEqual(saved, {
    server: "https://deng.example",
    installationId: "inst_1",
    token: "secret",
    timezone: "Asia/Shanghai",
  });
});

test("collector refreshes at most once per hour and overwrites the latest snapshot", async () => withTempData(async (dataDir) => {
  let scans = 0;
  let now = new Date("2026-09-27T08:00:00Z");
  const dependencies = {
    readConfig: async () => ({ denglema: { timezone: "Asia/Shanghai" } }),
    collectCodexDailyUsage: async () => {
      scans += 1;
      return { date: "2026-09-27", totalTokens: scans * 100 };
    },
    env: {},
    readCodexStatusRateLimits: async () => ({ limits: null }),
    now: () => now,
  };

  const first = await collectDenglemaSnapshot({ dataDir }, dependencies);
  assert.equal(first.collected, true);
  assert.equal(first.snapshot.total_tokens, 100);
  assert.equal(first.upload_status, "pending");

  now = new Date("2026-09-27T08:59:59Z");
  const throttled = await collectDenglemaSnapshot({ dataDir }, dependencies);
  assert.equal(throttled.collected, false);
  assert.equal(throttled.reason, "not_due");
  assert.equal(scans, 1);

  now = new Date("2026-09-27T09:00:00Z");
  const refreshed = await collectDenglemaSnapshot({ dataDir }, dependencies);
  assert.equal(refreshed.collected, true);
  assert.equal(refreshed.snapshot.total_tokens, 200);
  assert.equal(scans, 2);

  const latest = await getLatestDenglemaSnapshot({ dataDir }, { env: {} });
  assert.equal(latest.snapshot.total_tokens, 200);
}));

test("upload latest sends the stored snapshot without rescanning", async () => withTempData(async (dataDir) => {
  let scans = 0;
  const baseDeps = {
    readConfig: async () => ({
      denglema: {
        server: "https://deng.example",
        installationId: "inst_1",
        token: "secret",
        timezone: "Asia/Shanghai",
      },
    }),
    collectCodexDailyUsage: async () => {
      scans += 1;
      return { date: "2026-09-27", totalTokens: 4321 };
    },
    env: {},
    readCodexStatusRateLimits: async () => ({ limits: null }),
    now: () => new Date("2026-09-27T08:00:00Z"),
  };
  await collectDenglemaSnapshot({ dataDir, force: true }, baseDeps);

  let request;
  const result = await uploadLatestDenglemaSnapshot({ dataDir }, {
    ...baseDeps,
    now: () => new Date("2026-09-27T08:10:00Z"),
    fetch: async (url, init) => {
      request = { url, init };
      return {
        ok: true,
        json: async () => ({ installation_id: "inst_1", accepted_total: 4321 }),
      };
    },
  });

  assert.equal(scans, 1);
  assert.equal(request.url, "https://deng.example/api/usage/sample");
  assert.equal(request.init.headers.authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(request.init.body), {
    schema_version: 2,
    harness: "codex",
    observed_at: "2026-09-27T08:00:00.000Z",
    date: "2026-09-27",
    total_tokens: 4321,
    models: [],
    projects: [],
  });
  assert.equal(result.upload_status, "uploaded");

  const latest = await getLatestDenglemaSnapshot({ dataDir }, { env: {} });
  assert.equal(latest.upload_status, "uploaded");
  assert.equal(latest.last_uploaded_total, 4321);
  assert.equal(latest.last_uploaded_schema_version, 2);
}));

test("sync compatibility refreshes then uploads one cumulative sample", async () => withTempData(async (dataDir) => {
  let request;
  const result = await syncDenglemaUsage({ dataDir }, {
    readConfig: async () => ({
      denglema: {
        server: "https://deng.example",
        installationId: "inst_1",
        token: "secret",
        timezone: "Asia/Shanghai",
      },
    }),
    collectCodexDailyUsage: async () => ({ date: "2026-09-24", totalTokens: 9001 }),
    env: {},
    readCodexStatusRateLimits: async () => ({ limits: null }),
    now: () => new Date("2026-09-24T09:00:00Z"),
    fetch: async (url, init) => {
      request = { url, init };
      return {
        ok: true,
        json: async () => ({ installation_id: "inst_1", accepted_total: 9001 }),
      };
    },
  });

  assert.equal(request.url, "https://deng.example/api/usage/sample");
  assert.deepEqual(JSON.parse(request.init.body), {
    schema_version: 2,
    harness: "codex",
    observed_at: "2026-09-24T09:00:00.000Z",
    date: "2026-09-24",
    total_tokens: 9001,
    models: [],
    projects: [],
  });
  assert.equal(result.sample.total_tokens, 9001);
}));

test("dry run refreshes latest without requiring a binding or making HTTP requests", async () => withTempData(async (dataDir) => {
  let fetchCalled = false;
  const result = await syncDenglemaUsage({
    dataDir,
    dryRun: true,
    timezone: "Asia/Shanghai",
  }, {
    readConfig: async () => ({ denglema: {} }),
    collectCodexDailyUsage: async () => ({ date: "2026-09-24", totalTokens: 4242 }),
    env: {},
    readCodexStatusRateLimits: async () => ({ limits: null }),
    now: () => new Date("2026-09-24T09:00:00Z"),
    fetch: async () => {
      fetchCalled = true;
      throw new Error("must not fetch");
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.dry_run, true);
  assert.equal(result.sample.total_tokens, 4242);

  const latest = await getLatestDenglemaSnapshot({ dataDir }, { env: {} });
  assert.equal(latest.snapshot.total_tokens, 4242);
  assert.equal(latest.upload_status, "pending");
}));
