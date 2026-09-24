import { hostname } from "node:os";

import {
  readConfig,
  resolveDenglemaConnection,
  updateDenglemaConnection,
} from "./config.js";
import { collectCodexDailyUsage } from "./usage-summary.js";

function cleanServer(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().replace(/\/+$/, "")
    : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

export function buildDenglemaUsageSample(dailyUsage, observedAt = new Date()) {
  if (!dailyUsage?.date) throw new Error("No usage data is available for today");
  return {
    schema_version: 1,
    observed_at: observedAt.toISOString(),
    date: dailyUsage.date,
    total_tokens: nonNegativeInteger(dailyUsage.totalTokens),
  };
}

export async function bindDenglema(options = {}, dependencies = {}) {
  const readConfigFn = dependencies.readConfig || readConfig;
  const updateConnection = dependencies.updateDenglemaConnection || updateDenglemaConnection;
  const fetchFn = dependencies.fetch || fetch;
  const config = await readConfigFn(options.configPath);
  const server = cleanServer(options.server || config.denglema?.server);
  const code = String(options.code || "").trim();
  if (!server) throw new Error("Denglema server is required");
  if (!code) throw new Error("Pairing code is required");

  const response = await fetchFn(`${server}/api/installations/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      installation_name: options.name || hostname(),
    }),
  });
  if (!response.ok) {
    throw new Error(`Pairing failed: HTTP ${response.status} — ${await response.text()}`);
  }
  const payload = await response.json();
  if (!payload?.installation_id || !payload?.token) {
    throw new Error("Pairing response did not include installation credentials");
  }
  await updateConnection({
    server,
    installationId: payload.installation_id,
    token: payload.token,
    timezone: payload.timezone || null,
  }, options.configPath);
  return {
    ok: true,
    server,
    installation_id: payload.installation_id,
    user_id: payload.user_id || null,
  };
}

export async function syncDenglemaUsage(options = {}, dependencies = {}) {
  const readConfigFn = dependencies.readConfig || readConfig;
  const fetchFn = dependencies.fetch || fetch;
  const config = await readConfigFn(options.configPath);
  const connection = resolveDenglemaConnection(options, config, dependencies.env || process.env);
  const server = cleanServer(connection.server);
  if (!server) throw new Error("Denglema is not bound: missing server");
  if (!connection.token) throw new Error("Denglema is not bound: missing installation token");

  const collectUsage = dependencies.collectCodexDailyUsage || collectCodexDailyUsage;
  const observedAt = dependencies.now?.() || new Date();
  const dailyUsage = await collectUsage({
    ...options,
    timezone: options.timezone || connection.timezone || undefined,
  }, {
    loadAllReports: dependencies.loadAllReports,
    now: () => observedAt,
  });
  const sample = buildDenglemaUsageSample(dailyUsage, observedAt);
  const response = await fetchFn(`${server}/api/usage/sample`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${connection.token}`,
      },
      body: JSON.stringify(sample),
    });
    if (!response.ok) {
      throw new Error(`Usage upload failed: HTTP ${response.status} — ${await response.text()}`);
    }
  const payload = await response.json();
  return {
    ok: true,
    installation_id: connection.installationId || payload.installation_id || null,
    sample,
    ...payload,
  };
}

export async function runDenglemaCli(options = {}, dependencies = {}) {
  const action = options.denglemaAction || "sync";
  if (action === "bind") {
    const result = await bindDenglema(options, dependencies);
    console.log(`Denglema bound: ${result.installation_id}`);
    return 0;
  }
  if (action === "sync") {
    const result = await syncDenglemaUsage(options, dependencies);
    const tokens = result.sample.total_tokens.toLocaleString("en-US");
    console.log(`Denglema synced: ${tokens} tokens for ${result.sample.date}`);
    return 0;
  }
  console.error("Usage: node src/cli.js denglema bind --server <url> --code <pairing-code> [--name <label>]");
  console.error("       node src/cli.js denglema sync");
  return 2;
}