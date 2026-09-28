import { hostname } from "node:os";

import {
  readConfig,
  resolveDenglemaConnection,
  updateDenglemaConnection,
} from "./config.js";
import {
  DENGLEMA_SNAPSHOT_INTERVAL_MS,
  acquireDenglemaCollectLock,
  getLatestDenglemaSnapshot,
  isDenglemaSnapshotDue,
  readLatestDenglemaSnapshot,
  writeDenglemaUploadState,
  writeLatestDenglemaSnapshot,
} from "./denglema-snapshot.js";
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

function normalizeDimensionRows(rows = []) {
  const totals = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = String(row?.name || "").trim().slice(0, 96);
    if (!name) continue;
    const tokens = nonNegativeInteger(row?.total_tokens ?? row?.totalTokens);
    if (tokens <= 0) continue;
    totals.set(name, (totals.get(name) || 0) + tokens);
  }
  return [...totals.entries()]
    .map(([name, total_tokens]) => ({ name, total_tokens }))
    .sort((a, b) => b.total_tokens - a.total_tokens || a.name.localeCompare(b.name));
}

export function buildDenglemaUsageSample(dailyUsage, observedAt = new Date()) {
  if (!dailyUsage?.date) throw new Error("No usage data is available for today");
  return {
    schema_version: 2,
    observed_at: observedAt.toISOString(),
    date: dailyUsage.date,
    total_tokens: nonNegativeInteger(dailyUsage.totalTokens),
    models: normalizeDimensionRows(dailyUsage.models),
    projects: normalizeDimensionRows(dailyUsage.projects),
  };
}

function uploadSample(snapshot) {
  if (!snapshot?.date || !snapshot?.observed_at) {
    throw new Error("No Denglema snapshot is available to upload");
  }
  const version = snapshot.schema_version === 2 ? 2 : 1;
  return {
    schema_version: version,
    observed_at: snapshot.observed_at,
    date: snapshot.date,
    total_tokens: nonNegativeInteger(snapshot.total_tokens),
    ...(version === 2 ? {
      models: normalizeDimensionRows(snapshot.models),
      projects: normalizeDimensionRows(snapshot.projects),
    } : {}),
  };
}

export async function getDenglemaStatus(options = {}, dependencies = {}) {
  const readConfigFn = dependencies.readConfig || readConfig;
  const config = await readConfigFn(options.configPath);
  const connection = resolveDenglemaConnection(options, config, dependencies.env || process.env);
  const server = cleanServer(connection.server);
  return {
    bound: Boolean(server && connection.token),
    server,
    installation_id: connection.installationId || null,
    timezone: connection.timezone || null,
    has_token: Boolean(connection.token),
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

export async function collectDenglemaSnapshot(options = {}, dependencies = {}) {
  const totalStarted = Date.now();
  const readConfigFn = dependencies.readConfig || readConfig;
  const collectUsage = dependencies.collectCodexDailyUsage || collectCodexDailyUsage;
  const now = dependencies.now?.() || new Date();
  const intervalMs = Number.isFinite(Number(options.intervalMs))
    ? Math.max(0, Number(options.intervalMs))
    : DENGLEMA_SNAPSHOT_INTERVAL_MS;

  const config = await readConfigFn(options.configPath);
  const connection = resolveDenglemaConnection(options, config, dependencies.env || process.env);
  const timezone = options.timezone || connection.timezone || undefined;

  const before = await readLatestDenglemaSnapshot(options, dependencies);
  if (!options.force && !isDenglemaSnapshotDue(before, now, intervalMs)) {
    return {
      ok: true,
      collected: false,
      reason: "not_due",
      ...(await getLatestDenglemaSnapshot(options, dependencies)),
      timings_ms: { total: Date.now() - totalStarted },
    };
  }

  const lock = await acquireDenglemaCollectLock(options, dependencies);
  if (!lock.acquired) {
    return {
      ok: true,
      collected: false,
      reason: "busy",
      ...(await getLatestDenglemaSnapshot(options, dependencies)),
      timings_ms: { total: Date.now() - totalStarted },
    };
  }

  try {
    const latest = await readLatestDenglemaSnapshot(options, dependencies);
    if (!options.force && !isDenglemaSnapshotDue(latest, now, intervalMs)) {
      return {
        ok: true,
        collected: false,
        reason: "not_due",
        ...(await getLatestDenglemaSnapshot(options, dependencies)),
      };
    }

    const dailyUsage = await collectUsage({
      ...options,
      timezone,
    }, {
      now: () => now,
    });
    const sample = buildDenglemaUsageSample(dailyUsage, now);
    const snapshot = {
      ...sample,
      timezone: timezone || null,
    };

    const writeStarted = Date.now();
    await writeLatestDenglemaSnapshot(snapshot, options, dependencies);
    const writeSnapshotMs = Date.now() - writeStarted;
    const latestResult = await getLatestDenglemaSnapshot(options, dependencies);

    return {
      ok: true,
      collected: true,
      ...latestResult,
      timings_ms: {
        scan_candidates: Number(dailyUsage.timingsMs?.scanCandidates || 0),
        parse_active_sessions: Number(dailyUsage.timingsMs?.parseActiveSessions || 0),
        aggregate_models_projects: Number(dailyUsage.timingsMs?.aggregateModelsProjects || 0),
        write_snapshot: writeSnapshotMs,
        total: Date.now() - totalStarted,
      },
    };
  } finally {
    await lock.release();
  }
}

export async function uploadLatestDenglemaSnapshot(options = {}, dependencies = {}) {
  const totalStarted = Date.now();
  const readConfigFn = dependencies.readConfig || readConfig;
  const fetchFn = dependencies.fetch || fetch;
  const now = dependencies.now?.() || new Date();
  const config = await readConfigFn(options.configPath);
  const connection = resolveDenglemaConnection(options, config, dependencies.env || process.env);
  const server = cleanServer(connection.server);

  if (!server) throw new Error("Denglema is not bound: missing server");
  if (!connection.token) throw new Error("Denglema is not bound: missing installation token");

  const latest = await readLatestDenglemaSnapshot(options, dependencies);
  const sample = uploadSample(latest);

  const uploadStarted = Date.now();
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
  const uploadHttpMs = Date.now() - uploadStarted;
  await writeDenglemaUploadState({
    schema_version: sample.schema_version,
    date: sample.date,
    total_tokens: sample.total_tokens,
    uploaded_at: now.toISOString(),
    installation_id: connection.installationId || payload.installation_id || null,
  }, options, dependencies);

  return {
    ok: true,
    installation_id: connection.installationId || payload.installation_id || null,
    sample,
    upload_status: "uploaded",
    ...payload,
    timings_ms: {
      upload_http: uploadHttpMs,
      total: Date.now() - totalStarted,
    },
  };
}

export async function syncDenglemaUsage(options = {}, dependencies = {}) {
  const totalStarted = Date.now();
  const collected = await collectDenglemaSnapshot({
    ...options,
    force: true,
  }, dependencies);

  if (!collected.exists || !collected.snapshot) {
    throw new Error("Denglema could not generate a local snapshot");
  }

  if (options.dryRun === true) {
    return {
      ok: true,
      dry_run: true,
      installation_id: null,
      sample: uploadSample(collected.snapshot),
      timings_ms: {
        ...(collected.timings_ms || {}),
        total: Date.now() - totalStarted,
      },
    };
  }

  const uploaded = await uploadLatestDenglemaSnapshot(options, dependencies);
  return {
    ...uploaded,
    timings_ms: {
      ...(collected.timings_ms || {}),
      upload_http: Number(uploaded.timings_ms?.upload_http || 0),
      total: Date.now() - totalStarted,
    },
  };
}

export async function runDenglemaCli(options = {}, dependencies = {}) {
  const action = options.denglemaAction || "sync";

  if (action === "status") {
    const status = await getDenglemaStatus(options, dependencies);
    if (options.json) {
      console.log(JSON.stringify(status));
    } else if (status.bound) {
      console.log(`Denglema bound: ${status.installation_id || "installation"} → ${status.server}`);
    } else {
      console.log("Denglema not bound. Open the Denglema web page and create a pairing code.");
    }
    return 0;
  }

  if (action === "bind") {
    const result = await bindDenglema(options, dependencies);
    const uploaded = await syncDenglemaUsage({ ...options, dryRun: false }, dependencies);
    const tokens = uploaded.sample.total_tokens.toLocaleString("en-US");
    console.log(`Denglema ready: ${result.installation_id} · uploaded ${tokens} tokens for ${uploaded.sample.date}`);
    return 0;
  }

  if (action === "snapshot") {
    const result = await getLatestDenglemaSnapshot(options, dependencies);
    console.log(JSON.stringify(result));
    return 0;
  }

  if (action === "collect") {
    const result = await collectDenglemaSnapshot(options, dependencies);
    console.log(JSON.stringify(result));
    return 0;
  }

  if (action === "upload") {
    const result = await uploadLatestDenglemaSnapshot(options, dependencies);
    const tokens = result.sample.total_tokens.toLocaleString("en-US");
    console.log(`Denglema uploaded: ${tokens} tokens for ${result.sample.date}`);
    return 0;
  }

  if (action === "sync") {
    const result = await syncDenglemaUsage(options, dependencies);
    const tokens = result.sample.total_tokens.toLocaleString("en-US");
    if (result.dry_run) {
      console.log(`Denglema dry run: ${tokens} tokens for ${result.sample.date} (nothing uploaded)`);
    } else {
      console.log(`Denglema synced: ${tokens} tokens for ${result.sample.date}`);
    }
    return 0;
  }

  console.error("Usage: node src/cli.js denglema status [--json]");
  console.error("       node src/cli.js denglema bind --server <url> --code <pairing-code> [--name <label>]");
  console.error("       node src/cli.js denglema snapshot");
  console.error("       node src/cli.js denglema collect");
  console.error("       node src/cli.js denglema upload");
  console.error("       node src/cli.js denglema sync [--dry-run]");
  return 2;
}
