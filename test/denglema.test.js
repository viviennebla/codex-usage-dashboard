import assert from "node:assert/strict";
import test from "node:test";

import {
  bindDenglema,
  buildDenglemaUsageSample,
  getDenglemaStatus,
  syncDenglemaUsage,
} from "../src/denglema.js";

test("usage sample contains only cumulative daily total", () => {
  const sample = buildDenglemaUsageSample(
    { date: "2026-09-24", totalTokens: 12345 },
    new Date("2026-09-24T08:00:00Z"),
  );
  assert.deepEqual(sample, {
    schema_version: 1,
    observed_at: "2026-09-24T08:00:00.000Z",
    date: "2026-09-24",
    total_tokens: 12345,
  });
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
  });

  assert.deepEqual(status, {
    bound: true,
    server: "https://deng.example",
    installation_id: "inst_1",
    timezone: "Asia/Shanghai",
    has_token: true,
  });
  assert.equal(JSON.stringify(status).includes("do-not-print"), false);
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

test("sync uploads one small cumulative sample", async () => {
  let request;
  const result = await syncDenglemaUsage({}, {
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
  assert.equal(request.init.headers.authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(request.init.body), {
    schema_version: 1,
    observed_at: "2026-09-24T09:00:00.000Z",
    date: "2026-09-24",
    total_tokens: 9001,
  });
  assert.equal(result.sample.total_tokens, 9001);
});

test("dry run collects usage without requiring a binding or making HTTP requests", async () => {
  let fetchCalled = false;
  const result = await syncDenglemaUsage({ dryRun: true, timezone: "Asia/Shanghai" }, {
    readConfig: async () => ({ denglema: {} }),
    collectCodexDailyUsage: async () => ({ date: "2026-09-24", totalTokens: 4242 }),
    env: {},
    now: () => new Date("2026-09-24T09:00:00Z"),
    fetch: async () => {
      fetchCalled = true;
      throw new Error("must not fetch");
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.dry_run, true);
  assert.equal(result.sample.total_tokens, 4242);
  assert.equal(result.server, null);
});
