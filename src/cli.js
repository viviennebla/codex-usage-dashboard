#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { hostname } from "node:os";

import { loadAllReports } from "./loader.js";
import { formatCli } from "./format.js";
import { buildSnapshot } from "./snapshot.js";
import {
  DEFAULT_STATE_PATH,
  writeStateFile,
  readStateFile,
  readDeviceStates,
  writeDeviceState,
  removeDeviceState,
} from "./state.js";
import { FileParseCache } from "./file-cache.js";
import {
  addDirectory,
  listDirectories,
  removeDirectory,
  readConfig,
  resolveSyncConnection,
  updateSyncConnection,
} from "./config.js";
import { pullFromServer, recordSyncStatus } from "./sync.js";
import { discoverSourceDiagnostics, inspectSource, sourceLabelMap } from "./sources.js";
import { CodexLimitsClient } from "./codex-limits.js";
import { readCodexStatusRateLimits } from "./status.js";
import { runSkillsCli } from "./skills-cli.js";
import { mergeWithDeviceStates } from "./headless.js";
import {
  configureConnection,
  createTerminalPrompter,
  runInteractiveCli,
  runInteractiveSkillsCli,
} from "./interactive-cli.js";

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function parseArgs(argv) {
  const [command = "interactive", ...rawRest] = argv;
  const rest = [...rawRest];
  const options = {
    command,
    state: DEFAULT_STATE_PATH,
    stateDir: "state",
    port: 34777,
    bind: "127.0.0.1",
  };
  if (command === "skills" && rest[0] && !rest[0].startsWith("-")) {
    options.skillsAction = rest.shift();
  }
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--since") options.since = rest[++index];
    else if (arg === "--until") options.until = rest[++index];
    else if (arg === "--timezone") options.timezone = rest[++index];
    else if (arg === "--state") options.state = rest[++index];
    else if (arg === "--state-dir") options.stateDir = rest[++index];
    else if (arg === "--port") options.port = Number(rest[++index]);
    else if (arg === "--bind") options.bind = rest[++index];
    else if (arg === "--no-cost") options.noCost = true;
    else if (arg === "--no-wsl") options.noWsl = true;
    else if (arg === "--path") options.path = rest[++index];
    else if (arg === "--type") options.type = rest[++index];
    else if (arg === "--kind") options.kind = rest[++index];
    else if (arg === "--label") options.label = rest[++index];
    else if (arg === "--server") options.server = rest[++index];
    else if (arg === "--device") options.device = rest[++index];
    else if (arg === "--token") options.token = rest[++index];
    else if (arg === "--names") options.names = rest[++index];
    else if (arg === "--strategy") options.strategy = rest[++index];
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
  }
  return options;
}

function help() {
  return `Codex Usage Dashboard

Usage:
  node src/cli.js                         Open the interactive terminal menu
  node src/cli.js configure               Save the sync server and token
  node src/cli.js snapshot [--since YYYYMMDD] [--state state/latest.json]
  node src/cli.js cli [--json] [--since YYYYMMDD] [--no-wsl]
  node src/cli.js web [--port 34777] [--bind 127.0.0.1] [--no-wsl]
  node src/cli.js push [--device <name>]
  node src/cli.js pull
  node src/cli.js register --path <dir> --type codex|claude|skills [--label <name>]
  node src/cli.js skills [list|pull|push|prompt] [advanced options]
  node src/cli.js skills prompt [--path <dir>] [--names a,b|--all] [--json]

Commands:
  interactive  Open the guided terminal menu (default).
  configure    Save connection settings for CLI and Web use.
  snapshot  Write the canonical dashboard snapshot.
  cli       Print a terminal summary from the snapshot.
  web       Start the local web dashboard.
  push      Push local snapshot to a remote dashboard server.
  pull      Pull snapshots from a remote dashboard server.
  register  Register a custom agent data directory.
  skills       Open the Skills menu, or run a non-interactive subcommand.

Connection settings are saved in ~/.codex-usage.json. Explicit --server/--token
options and DASHBOARD_TOKEN still override saved values for automation.
`;
}

async function createSnapshot(options) {
  const reports = await loadAllReports(options);
  const snapshot = await applyStatusLimits(buildSnapshot(reports, options));
  await writeStateFile(snapshot, options.state);
  return snapshot;
}

async function applyStatusLimits(snapshot) {
  try {
    const status = await readCodexStatusRateLimits({ timeoutMs: 5000 });
    return {
      ...snapshot,
      limits: status.limits,
      limit_updated_at: status.limit_updated_at,
      limit_source: status.source,
      limit_error: null,
    };
  } catch (error) {
    return {
      ...snapshot,
      limits: null,
      limit_updated_at: null,
      limit_source: "unavailable",
      limit_error: error?.message || "Codex status API unavailable",
    };
  }
}

async function serveStatic(pathname) {
  const clean = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^[/\\]+/, "");
  if (clean.startsWith("..")) {
    return { status: 403, body: "Forbidden", type: "text/plain; charset=utf-8" };
  }
  const file = join("public", clean);
  return {
    status: 200,
    body: await readFile(file),
    type: MIME[extname(file)] || "application/octet-stream",
  };
}

/**
 * Read the request body from an incoming HTTP request.
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(Object.assign(err, { statusCode: 400, body: "Invalid JSON body" }));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Check bearer token. Returns true if no token is configured (auth disabled),
 * or if the request carries a matching token.
 */
function checkAuth(req, expected) {
  if (!expected) return true;
  const header = req.headers.authorization || "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  return bearer === expected;
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": MIME[".json"], "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

function startWeb(options) {
  const serverAuthToken = process.env.DASHBOARD_TOKEN || null;
  const stateDir = options.stateDir || "state";
  const maxSnapshotAgeMs = 5 * 60_000;
  const fileCache = new FileParseCache();
  const codexLimits = new CodexLimitsClient();
  const snapshotOptions = { ...options, fileCache };
  let localSnapshot = null;
  let mergedSnapshot = null;
  let refreshInFlight = null;
  let lastSnapshotRefreshAt = 0;

  function localDayKey(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function needsNewDaySnapshot(snapshot) {
    return snapshot?.today?.date !== localDayKey();
  }

  function invalidateMergedSnapshot() {
    mergedSnapshot = null;
  }

  async function buildMergedSnapshot(snapshot) {
    return mergeWithDeviceStates(snapshot, { stateDir });
  }

  async function getCachedSnapshot() {
    if (!localSnapshot) {
      localSnapshot = await readStateFile(options.state);
      lastSnapshotRefreshAt = Date.parse(localSnapshot?.generated_at || "") || 0;
    }
    if (!localSnapshot) return refreshDashboardSnapshot();
    if (
      needsNewDaySnapshot(localSnapshot) ||
      Date.now() - lastSnapshotRefreshAt >= maxSnapshotAgeMs
    ) return refreshDashboardSnapshot();
    if (mergedSnapshot) return mergedSnapshot;
    mergedSnapshot = await buildMergedSnapshot(localSnapshot);
    return mergedSnapshot;
  }

  async function getCachedLocalSnapshot() {
    if (!localSnapshot) {
      localSnapshot = await readStateFile(options.state);
      lastSnapshotRefreshAt = Date.parse(localSnapshot?.generated_at || "") || 0;
    }
    if (
      !localSnapshot ||
      needsNewDaySnapshot(localSnapshot) ||
      Date.now() - lastSnapshotRefreshAt >= maxSnapshotAgeMs
    ) return rebuildSnapshot();
    return localSnapshot;
  }

  async function rebuildSnapshot() {
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        localSnapshot = await createSnapshot(snapshotOptions);
        lastSnapshotRefreshAt = Date.now();
        invalidateMergedSnapshot();
        return localSnapshot;
      })().finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  async function refreshDashboardSnapshot() {
    await rebuildSnapshot();
    return getCachedSnapshot();
  }

  function compactRows(rows) {
    return Array.isArray(rows)
      ? rows.map(({ models, ...row }) => row)
      : rows;
  }

  function compactAggregate(row) {
    if (!row || typeof row !== "object") return row;
    const { models, ...aggregate } = row;
    return aggregate;
  }

  function dashboardSummary(snapshot) {
    const { top_projects, top_sessions, skills, per_device, ...summary } = snapshot;
    return {
      ...summary,
      recent_days: compactRows(summary.recent_days),
      activity_days: compactRows(summary.activity_days),
      trend_views: Array.isArray(summary.trend_views)
        ? summary.trend_views.map((view) => ({
          ...view,
          today: compactAggregate(view.today),
          totals: compactAggregate(view.totals),
          recent_days: compactRows(view.recent_days),
        }))
        : summary.trend_views,
    };
  }

  function detailSection(snapshot, section) {
    if (section === "projects") return { top_projects: compactRows(snapshot.top_projects) || [] };
    if (section === "sessions") return { top_sessions: compactRows(snapshot.top_sessions) || [] };
    if (section === "skills") return { skills: snapshot.skills || [] };
    return null;
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      // ── POST /api/push ── receive a device snapshot
      if (req.method === "POST" && url.pathname === "/api/push") {
        if (!checkAuth(req, serverAuthToken)) {
          sendError(res, 401, "Unauthorized — invalid or missing token");
          return;
        }
        const body = await readRequestBody(req);
        if (!body || !body.device_id) {
          sendError(res, 400, "Missing device_id in request body");
          return;
        }
        if (!body.snapshot) {
          sendError(res, 400, "Missing snapshot in request body");
          return;
        }
        const deviceId = String(body.device_id).replace(/[^a-zA-Z0-9._-]/g, "_");
        const deviceName = body.device_name || deviceId;
        await writeDeviceState(deviceId, deviceName, body.snapshot, stateDir);
        invalidateMergedSnapshot();
        console.log(`[push] received from ${deviceId} (${deviceName})`);
        sendJson(res, 200, { ok: true, device_id: deviceId });
        return;
      }

      // ── DELETE /api/push?device=... ── remove a device
      if (req.method === "DELETE" && url.pathname === "/api/push") {
        if (!checkAuth(req, serverAuthToken)) {
          sendError(res, 401, "Unauthorized");
          return;
        }
        const deviceId = url.searchParams.get("device");
        if (!deviceId) {
          sendError(res, 400, "Missing ?device= query parameter");
          return;
        }
        await removeDeviceState(String(deviceId).replace(/[^a-zA-Z0-9._-]/g, "_"), stateDir);
        invalidateMergedSnapshot();
        console.log(`[push] removed device ${deviceId}`);
        sendJson(res, 200, { ok: true, removed: deviceId });
        return;
      }

      // ── GET /api/snapshot ── return the cached local snapshot merged with pulled devices
      if (req.method === "GET" && url.pathname === "/api/snapshot") {
        sendJson(res, 200, dashboardSummary(await getCachedSnapshot()));
        return;
      }

      // ── POST /api/refresh ── explicitly rescan local JSONL logs
      if (req.method === "POST" && url.pathname === "/api/refresh") {
        sendJson(res, 200, dashboardSummary(await refreshDashboardSnapshot()));
        return;
      }

      // ── GET /api/details ── load lower-page lists from the cached snapshot
      if (req.method === "GET" && url.pathname === "/api/details") {
        const snapshot = await getCachedSnapshot();
        const section = url.searchParams.get("section") || "";
        const detail = detailSection(snapshot, section);
        if (!detail) {
          sendError(res, 400, "Unknown detail section");
          return;
        }
        sendJson(res, 200, { generated_at: snapshot.generated_at, section, ...detail });
        return;
      }

      // ── GET /api/snapshot/:deviceId ── return a specific device snapshot
      if (req.method === "GET" && url.pathname.startsWith("/api/snapshot/")) {
        const deviceId = url.pathname.slice("/api/snapshot/".length);
        if (!deviceId) {
          sendError(res, 400, "Missing device ID");
          return;
        }
        const { readStateFile } = await import("./state.js");
        const filePath = join(stateDir, `${deviceId}.json`);
        const snapshot = await readStateFile(filePath);
        if (!snapshot) {
          sendError(res, 404, `Device "${deviceId}" not found`);
          return;
        }
        sendJson(res, 200, snapshot);
        return;
      }

      // ── GET/POST /api/sync-config ── share local connection settings with the CLI
      if (url.pathname === "/api/sync-config") {
        if (req.method === "GET") {
          const config = await readConfig();
          sendJson(res, 200, {
            server: config.sync?.server || null,
            has_token: Boolean(config.sync?.token || process.env.DASHBOARD_TOKEN),
          });
          return;
        }
        if (req.method === "POST") {
          const body = await readRequestBody(req);
          if (!body?.server) {
            sendError(res, 400, "Missing server");
            return;
          }
          const sync = await updateSyncConnection({
            server: body.server,
            token: typeof body.token === "string" && body.token ? body.token : undefined,
            clearToken: body.clear_token === true,
          });
          sendJson(res, 200, { server: sync.server, has_token: Boolean(sync.token) });
          return;
        }
      }

      // ── POST /api/sync ── trigger pull from remote server
      if (req.method === "POST" && url.pathname === "/api/sync") {
        const body = await readRequestBody(req);
        const config = await readConfig();
        const { server: serverUrl } = resolveSyncConnection(body || {}, config);
        if (!serverUrl) {
          sendError(res, 400, "Missing 'server' in request body");
          return;
        }
        const result = await pullFromServer(serverUrl);
        invalidateMergedSnapshot();
        const { readSyncState } = await import("./sync.js");
        const syncState = await readSyncState();

        console.log(`[sync] ${result.message}`);
        sendJson(res, 200, {
          synced: result.synced,
          skipped: result.skipped,
          failed: result.failed,
          message: result.message,
          lastPullAt: syncState.lastPullAt,
          status: syncState.lastPullStatus || null,
          error: syncState.lastPullError || null,
        });
        return;
      }

      // ── POST /api/proxy-health ── proxy health check to remote server (avoids CORS)
      if (req.method === "POST" && url.pathname === "/api/proxy-health") {
        const body = await readRequestBody(req);
        const serverUrl = body?.server;
        if (!serverUrl) { sendError(res, 400, "Missing server"); return; }
        try {
          const remoteUrl = String(serverUrl).replace(/\/+$/, "");
          const resp = await fetch(`${remoteUrl}/health`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.json();
          sendJson(res, 200, data);
        } catch (err) {
          sendError(res, 502, `Cannot reach server: ${err.message}`);
        }
        return;
      }

      // ── GET /api/limits ── fast rate-limit refresh
      if (req.method === "GET" && url.pathname === "/api/limits") {
        try {
          const live = await codexLimits.readRateLimits();
          if (live.limits) {
            const updatedAt = new Date().toISOString();
            if (localSnapshot) {
              localSnapshot.limits = live.limits;
              localSnapshot.limit_updated_at = updatedAt;
              localSnapshot.limit_source = "codex_status_api";
              localSnapshot.limit_error = null;
              invalidateMergedSnapshot();
            }
            sendJson(res, 200, {
              ...live,
              limit_updated_at: updatedAt,
              generated_at: updatedAt,
              source: "codex_status_api",
              stale: false,
              limit_age_hours: 0,
            });
            return;
          }
          sendError(res, 502, "Codex status API returned no rate limits");
        } catch (error) {
          if (localSnapshot) {
            localSnapshot.limit_source = "unavailable";
            localSnapshot.limit_error = error?.message || "Codex status API unavailable";
          }
          sendError(res, 502, `Codex status API unavailable: ${error?.message || "unknown error"}`);
        }
        return;
      }

      // ── GET /api/sync-state ── return last push/pull times
      if (req.method === "GET" && url.pathname === "/api/sync-state") {
        const { readSyncState } = await import("./sync.js");
        const state = await readSyncState();
        sendJson(res, 200, {
          server: state.server || null,
          lastPushAt: state.lastPushAt || null,
          lastPullAt: state.lastPullAt || null,
          lastPushStatus: state.lastPushStatus || null,
          lastPullStatus: state.lastPullStatus || null,
          lastPushMessage: state.lastPushMessage || null,
          lastPullMessage: state.lastPullMessage || null,
          lastPushError: state.lastPushError || null,
          lastPullError: state.lastPullError || null,
          lastStatusAt: state.lastStatusAt || null,
          lastMessage: state.lastMessage || null,
          lastError: state.lastError || null,
          devices: state.devices || {},
        });
        return;
      }

      // ── POST /api/sync-status ── compare local vs remote snapshots
      if (req.method === "POST" && url.pathname === "/api/sync-status") {
        const body = await readRequestBody(req);
        const serverUrl = body?.server;
        if (!serverUrl) { sendError(res, 400, "Missing 'server' in request body"); return; }

        // Local snapshot
        const localSnapshot = await rebuildSnapshot();
        const localTime = localSnapshot.generated_at ? new Date(localSnapshot.generated_at).getTime() : 0;

        // Fetch remote device list
        const remoteUrl = String(serverUrl).replace(/\/+$/, "");
        let devices = [];
        try {
          const resp = await fetch(`${remoteUrl}/api/devices`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          devices = await resp.json();
        } catch (err) {
          sendError(res, 502, `Cannot reach server: ${err.message}`);
          return;
        }

        // Compare timestamps
        const comparison = devices.map((d) => {
          const remoteTime = d.generated_at ? new Date(d.generated_at).getTime() : 0;
          return {
            device_id: d.device_id,
            device_name: d.device_name,
            generated_at: d.generated_at,
            today_tokens: d.today_tokens || 0,
            is_newer: remoteTime > localTime,
            is_older: remoteTime <= localTime,
          };
        });

        sendJson(res, 200, {
          local: {
            generated_at: localSnapshot.generated_at,
            today_tokens: localSnapshot.today?.totalTokens || 0,
            total_tokens: localSnapshot.totals?.totalTokens || 0,
            skills_count: localSnapshot.skills?.length || 0,
            models_count: Object.keys(localSnapshot.models || {}).length,
          },
          devices: comparison,
        });
        return;
      }

      // ── POST /api/push-to-remote ── push local snapshot to a remote sync server
      if (req.method === "POST" && url.pathname === "/api/push-to-remote") {
        const body = await readRequestBody(req);
        const config = await readConfig();
        const { server: serverUrl, token } = resolveSyncConnection(body || {}, config);
        const deviceId = body?.device || hostname();
        if (!serverUrl) { sendError(res, 400, "Missing 'server'"); return; }

        const snapshot = await getCachedLocalSnapshot();
        const remoteUrl = String(serverUrl).replace(/\/+$/, "");
        const headers = { "content-type": "application/json" };
        if (token) headers.authorization = `Bearer ${token}`;
        await recordSyncStatus("push", "running", { server: remoteUrl, message: "Pushing local snapshot..." });

        try {
          const pushResp = await fetch(`${remoteUrl}/api/push`, {
            method: "POST",
            headers,
            body: JSON.stringify({ device_id: deviceId, device_name: deviceId, snapshot }),
          });
          if (!pushResp.ok) {
            const error = `Remote server returned ${pushResp.status}: ${await pushResp.text()}`;
            await recordSyncStatus("push", "failed", { server: remoteUrl, error });
            sendError(res, pushResp.status, error);
            return;
          }
          const result = await pushResp.json();

          const syncState = await recordSyncStatus("push", "success", {
            server: remoteUrl,
            message: `Pushed as ${result.device_id}`,
          });

          console.log(`[push-to-remote] pushed to ${remoteUrl} as ${deviceId}`);
          sendJson(res, 200, { ok: true, device_id: result.device_id, lastPushAt: syncState.lastPushAt });
        } catch (err) {
          await recordSyncStatus("push", "failed", { server: remoteUrl, error: err.message });
          sendError(res, 502, `Cannot reach server: ${err.message}`);
        }
        return;
      }

      // ── POST /api/sync-device ── pull a single device snapshot from remote
      if (req.method === "POST" && url.pathname === "/api/sync-device") {
        const body = await readRequestBody(req);
        const serverUrl = body?.server;
        const deviceId = body?.device_id;
        if (!serverUrl || !deviceId) {
          sendError(res, 400, "Missing 'server' or 'device_id'");
          return;
        }
        const remoteUrl = String(serverUrl).replace(/\/+$/, "");
        try {
          const resp = await fetch(`${remoteUrl}/api/snapshot/${encodeURIComponent(deviceId)}`);
          if (!resp.ok) {
            sendError(res, resp.status, `Remote error: ${resp.status}`);
            return;
          }
          const snapshot = await resp.json();
          await writeDeviceState(deviceId, deviceId, snapshot, stateDir);
          invalidateMergedSnapshot();
          console.log(`[sync-device] pulled ${deviceId}`);
          sendJson(res, 200, { ok: true, device_id: deviceId });
        } catch (err) {
          sendError(res, 502, `Failed to fetch device: ${err.message}`);
        }
        return;
      }

      // ── GET /api/devices ── list known devices
      if (url.pathname === "/api/devices") {
        const devices = await readDeviceStates(stateDir);
        const list = [...devices.values()].map((d) => ({
          device_id: d.deviceId,
          device_name: d.deviceName,
          generated_at: d.snapshot?.generated_at || null,
          today_tokens: d.snapshot?.today?.totalTokens || 0,
        }));
        sendJson(res, 200, list);
        return;
      }

      // ── GET /api/sources ── list registered + auto-discovered + synced devices
      if (req.method === "GET" && url.pathname === "/api/sources") {
        const cfg = await readConfig();
        const dirs = cfg.directories || [];
        const labels = sourceLabelMap(dirs);
        const registered = await Promise.all(dirs.map(async (dir) => ({
          ...await inspectSource(dir.path, dir.type, labels),
          origin: "registered",
          addedAt: dir.addedAt || null,
        })));
        const discovered = (await discoverSourceDiagnostics(dirs))
          .filter((d) => d.status !== "missing"); // skip paths that don't exist

        // Include synced remote devices as sources (exclude self)
        const devices = await readDeviceStates(stateDir);
        const localId = hostname();
        const remoteSources = [];
        for (const [deviceId, { deviceName, snapshot }] of devices) {
          if (deviceId === localId) continue; // skip own snapshots
          remoteSources.push({
            path: deviceId,
            normalized_path: deviceId,
            data_path: `state/${deviceId}.json`,
            type: "remote",
            label: deviceName || deviceId,
            display_name: deviceName || deviceId,
            status: "ok",
            origin: "remote",
            exists: true,
            files_found: snapshot?.diagnostics?.events_read || snapshot?.totals?.eventCount || 0,
            message: `Synced · ${snapshot?.generated_at?.slice(0, 10) || "unknown date"}`,
            today_tokens: snapshot?.today?.totalTokens || 0,
            generated_at: snapshot?.generated_at || null,
          });
        }

        sendJson(res, 200, {
          registered,
          discovered,
          remote: remoteSources,
        });
        return;
      }

      // ── POST /api/sources ── register a directory
      if (req.method === "POST" && url.pathname === "/api/sources") {
        const body = await readRequestBody(req);
        if (!body || !body.path) { sendError(res, 400, "Missing path"); return; }
        const type = body.type === "claude" ? "claude" : body.type === "skills" ? "skills" : "codex";
        const result = await addDirectory(body.path, type, body.label || null);
        const labels = sourceLabelMap(result.config.directories || []);
        const inspection = await inspectSource(body.path, type, labels);
        result.inspection = { ...inspection, origin: "registered" };
        sendJson(res, result.added ? 201 : 200, result);
        return;
      }

      // ── DELETE /api/sources?path=...&type=... ── remove a directory
      if (req.method === "DELETE" && url.pathname === "/api/sources") {
        const p = url.searchParams.get("path");
        const t = url.searchParams.get("type");
        if (!p) { sendError(res, 400, "Missing path"); return; }
        const result = await removeDirectory(p, t || null);
        sendJson(res, 200, result);
        return;
      }

      // ── GET /api/skills/local ── scan registered skill directories
      if (req.method === "GET" && url.pathname === "/api/skills/local") {
        const { scanAllSkillDirs, scanAgentInstallations, scanAllSkillBundles } = await import("./skills-sync.js");
        const cfg = await readConfig();
        const skills = await scanAllSkillDirs(cfg.directories || []);
        const bundles = await scanAllSkillBundles(cfg.directories || []);
        const installations = await scanAgentInstallations(cfg.directories || [], options);
        sendJson(res, 200, { skills, bundles, installations });
        return;
      }

      // ── GET /api/skills ── expose the current skill list for sync peers
      if (req.method === "GET" && url.pathname === "/api/skills") {
        const { readStoredSkillBundle, scanAllSkillDirs } = await import("./skills-sync.js");
        const cfg = await readConfig();
        const localSkills = await scanAllSkillDirs(cfg.directories || []);
        if (localSkills.length) {
          sendJson(res, 200, localSkills);
          return;
        }
        const storedBundle = await readStoredSkillBundle(stateDir);
        sendJson(res, 200, storedBundle?.skills || []);
        return;
      }

      // ── GET/POST /api/skills/bundle ── sync the complete source bundle directory
      if (url.pathname === "/api/skills/bundle") {
        const { readStoredSkillBundle, scanAllSkillBundles, writeStoredSkillBundle } = await import("./skills-sync.js");
        if (req.method === "GET") {
          const cfg = await readConfig();
          const bundles = await scanAllSkillBundles(cfg.directories || []);
          if (bundles.length) {
            sendJson(res, 200, bundles[0]);
            return;
          }
          const storedBundle = await readStoredSkillBundle(stateDir);
          if (!storedBundle) {
            sendError(res, 404, "No skill bundle is available");
            return;
          }
          sendJson(res, 200, storedBundle);
          return;
        }
        if (req.method === "POST") {
          if (!checkAuth(req, serverAuthToken)) {
            sendError(res, 401, "Unauthorized");
            return;
          }
          const body = await readRequestBody(req);
          try {
            const stored = await writeStoredSkillBundle(body?.bundle || body, stateDir);
            sendJson(res, 200, { ok: true, sha256: stored.sha256, file_count: stored.file_count, skills_count: stored.skills?.length || 0 });
          } catch (error) {
            sendError(res, 400, error?.message || "Invalid skill bundle");
          }
          return;
        }
      }

      // ── GET /api/skills/imported ── list Markdown staged for Agent installation
      if (req.method === "GET" && url.pathname === "/api/skills/imported") {
        const { readImportedSkills } = await import("./skills-sync.js");
        sendJson(res, 200, await readImportedSkills(stateDir));
        return;
      }

      // ── POST /api/skills/compare ── compare local vs remote
      if (req.method === "POST" && url.pathname === "/api/skills/compare") {
        const body = await readRequestBody(req);
        const { scanAllSkillDirs, compareSkills, readImportedSkills, scanAgentInstallations } = await import("./skills-sync.js");
        const cfg = await readConfig();
        const { server: serverUrl } = resolveSyncConnection(body || {}, cfg);
        const localSkills = await scanAllSkillDirs(cfg.directories || []);
        const importedSkills = await readImportedSkills(stateDir);
        const installations = await scanAgentInstallations(cfg.directories || [], options);
        let remoteSkills = [];
        if (serverUrl) {
          const remoteUrl = String(serverUrl).replace(/\/+$/, "");
          try {
            const resp = await fetch(`${remoteUrl}/api/skills`);
            if (resp.ok) remoteSkills = await resp.json();
          } catch { /* server unreachable → all local-only */ }
        }
        const comparison = compareSkills(localSkills, remoteSkills, importedSkills, installations);
        sendJson(res, 200, { local: localSkills, remote: remoteSkills, imported: importedSkills, installations, comparison });
        return;
      }

      // ── POST /api/skills/install-prompt ── generate a prompt for the user's Agent
      if (req.method === "POST" && url.pathname === "/api/skills/install-prompt") {
        const body = await readRequestBody(req);
        const names = body?.names || [];
        const cfg = await readConfig();
        const { buildCodexSkillInstallPrompt } = await import("./skills-sync.js");
        try {
          sendJson(res, 200, await buildCodexSkillInstallPrompt(names, cfg.directories || []));
        } catch (error) {
          sendError(res, 400, error?.message || "Cannot build install prompt");
        }
        return;
      }

      // ── POST /api/skills/push ── push the complete local skill source bundle to remote
      if (req.method === "POST" && url.pathname === "/api/skills/push") {
        const body = await readRequestBody(req);
        const names = body?.names || [];
        const { scanSelectedSkillBundle } = await import("./skills-sync.js");
        const cfg = await readConfig();
        const { server: serverUrl, token } = resolveSyncConnection(body || {}, cfg);
        if (!serverUrl) { sendError(res, 400, "Missing server"); return; }
        const remoteUrl = String(serverUrl).replace(/\/+$/, "");
        const results = [];
        const headers = { "content-type": "application/json" };
        if (token) headers.authorization = `Bearer ${token}`;
        try {
          const bundle = await scanSelectedSkillBundle(names, cfg.directories || []);
          const resp = await fetch(`${remoteUrl}/api/skills/bundle`, {
            method: "POST",
            headers,
            body: JSON.stringify({ bundle, device_id: hostname() }),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
          const data = await resp.json();
          for (const name of (names.length ? names : bundle.skills.map((skill) => skill.name))) results.push({ name, ok: true, bundle_sha256: data.sha256 });
          sendJson(res, 200, { ok: true, results, bundle: { sha256: bundle.sha256, file_count: bundle.file_count, skills_count: bundle.skills.length } });
        } catch (err) {
          for (const name of names) results.push({ name, ok: false, error: err.message });
          sendJson(res, 200, { ok: false, results, error: err.message });
        }
        return;
      }

      // ── POST /api/skills/pull-preview|pull ── preview or pull the complete remote skill source bundle
      if (req.method === "POST" && (url.pathname === "/api/skills/pull" || url.pathname === "/api/skills/pull-preview")) {
        const body = await readRequestBody(req);
        const names = body?.names || [];
        const strategy = body?.strategy === "merge" ? "merge" : "overwrite";
        const { applySkillBundleToDir, planSkillBundleApply, scanAllSkillDirs } = await import("./skills-sync.js");
        const cfg = await readConfig();
        const { server: serverUrl } = resolveSyncConnection(body || {}, cfg);
        if (!serverUrl) { sendError(res, 400, "Missing server"); return; }
        const localSkills = await scanAllSkillDirs(cfg.directories || []);
        const localMap = new Map(localSkills.map((skill) => [skill.name.toLowerCase(), skill]));
        const sourceDirs = new Set(names.map((name) => localMap.get(String(name).toLowerCase())?.source_dir).filter(Boolean));
        const targetDir = sourceDirs.size === 1
          ? [...sourceDirs][0]
          : (cfg.directories || []).find((dir) => dir.type === "skills")?.path;
        if (!targetDir) {
          sendError(res, 400, "No skill source directory is configured");
          return;
        }
        const remoteUrl = String(serverUrl).replace(/\/+$/, "");
        const results = [];
        try {
          const resp = await fetch(`${remoteUrl}/api/skills/bundle`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
          const bundle = await resp.json();
          const plan = await planSkillBundleApply(bundle, targetDir, { strategy });
          if (url.pathname === "/api/skills/pull-preview") {
            sendJson(res, 200, { plan, bundle: { sha256: plan.bundle_sha256, file_count: plan.file_count, skills_count: plan.skills_count } });
            return;
          }
          const applied = await applySkillBundleToDir(bundle, targetDir, { strategy });
          for (const name of (names.length ? names : (bundle.skills || []).map((skill) => skill.name))) results.push({ name, ok: true, bundle_sha256: applied.sha256 });
          sendJson(res, 200, { ok: true, results, plan, bundle: { sha256: applied.sha256, file_count: applied.file_count, skills_count: applied.skills.length } });
        } catch (err) {
          for (const name of names) results.push({ name, ok: false, error: err.message });
          sendJson(res, 200, { ok: false, results, error: err.message });
        }
        return;
      }

      // ── Static files ──
      if (url.pathname.startsWith("/api/")) {
        sendError(res, 404, `Unknown API endpoint: ${url.pathname}`);
        return;
      }
      const response = await serveStatic(url.pathname);
      res.writeHead(response.status, { "content-type": response.type });
      res.end(response.body);
    } catch (error) {
      const status = error.statusCode || 500;
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.stack : String(error));
    }
  });

  server.listen(options.port, options.bind, () => {
    const devicesHint = serverAuthToken ? "multi-device push enabled" : "local-only (set DASHBOARD_TOKEN for push auth)";
    console.log(`Codex Usage Dashboard: http://${options.bind}:${options.port}`);
    console.log(`  ${devicesHint}`);
  });
}

async function pushSnapshot(options) {
  const config = await readConfig();
  const connection = resolveSyncConnection(options, config);
  if (!connection.server) throw new Error("No sync server is configured; run `node src/cli.js configure` first");

  const deviceId = options.device || hostname();
  const token = connection.token;

  console.log(`Creating snapshot...`);
  const snapshot = await createSnapshot(options);
  console.log(`  Today: ${snapshot.today?.totalTokens?.toLocaleString("en-US") || 0} tokens`);

  const serverUrl = String(connection.server).replace(/\/+$/, "");
  const pushUrl = `${serverUrl}/api/push`;

  console.log(`Pushing to ${pushUrl} as "${deviceId}"...`);

  const headers = { "content-type": "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetch(pushUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        device_id: deviceId,
        device_name: deviceId,
        snapshot,
      }),
    });
  } catch (err) {
    console.error(`Push failed: ${err.message}`);
    console.error(`  Is the server running at ${serverUrl} ?`);
    process.exitCode = 1;
    return;
  }

  if (!response.ok) {
    console.error(`Push failed: HTTP ${response.status} — ${await response.text()}`);
    process.exitCode = 1;
    return;
  }

  const result = await response.json();
  console.log(`Push OK — device "${result.device_id}" registered on server.`);
}

async function pullSnapshots(options) {
  const config = await readConfig();
  const { server } = resolveSyncConnection(options, config);
  if (!server) throw new Error("No sync server is configured; run `node src/cli.js configure` first");
  console.log(`Pulling from ${server}...`);
  const result = await pullFromServer(server);
  console.log(result.message);
  for (const id of result.synced) console.log(`  OK  ${id}`);
  for (const failure of result.failed) console.log(`  FAIL  ${failure.deviceId} — ${failure.error}`);
  return result;
}

async function showUsage(options) {
  const config = await readConfig();
  const { server } = resolveSyncConnection(options, config);
  if (server) {
    const result = await pullFromServer(server);
    console.error(`[sync] ${result.message}`);
    for (const failure of result.failed) console.error(`[sync] ${failure.deviceId}: ${failure.error}`);
  }
  const localSnapshot = await createSnapshot(options);
  const snapshot = await mergeWithDeviceStates(localSnapshot, { stateDir: options.stateDir });
  console.log(options.json ? JSON.stringify(snapshot, null, 2) : formatCli(snapshot));
  return snapshot;
}

async function registerDirectory(options) {
  if (!options.path) {
    console.error("Error: --path <dir> is required.");
    console.error("Example: npm run register -- --path /mnt/wsl/.codex --type codex --label wsl-ubuntu");
    process.exitCode = 2;
    return;
  }
  const type = options.type || "codex";
  if (type !== "codex" && type !== "claude" && type !== "skills") {
    console.error("Error: --type must be 'codex', 'claude', or 'skills'.");
    process.exitCode = 2;
    return;
  }

  const result = await addDirectory(options.path, type, options.label || null);
  const labels = sourceLabelMap(result.config.directories || []);
  const inspection = await inspectSource(options.path, type, labels);
  if (result.added) {
    console.log(`Registered ${type} directory: ${options.path}`);
    if (options.label) console.log(`  Label: ${options.label}`);
  } else {
    console.log(`Already registered: ${options.path} (${result.reason})`);
  }
  console.log(`  Status: ${inspection.status} - ${inspection.message}`);
  console.log(`  Name: ${inspection.display_name}`);
  console.log(`  Files: ${inspection.files_found}`);

  // Also print current registry
  const dirs = await listDirectories();
  if (dirs.length > 0) {
    console.log(`\nRegistered directories (${dirs.length}):`);
    for (const d of dirs) {
      console.log(`  [${d.type}] ${d.path}${d.label ? ` (${d.label})` : ""}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "interactive") {
    if (!process.stdin.isTTY) {
      console.log(help());
      return;
    }
    process.exitCode = await runInteractiveCli(options, {
      showUsage,
      pushUsage: pushSnapshot,
      pullUsage: pullSnapshots,
    });
    return;
  }

  if (options.command === "--help" || options.command === "-h") {
    console.log(help());
    return;
  }

  if (["configure", "config", "connect"].includes(options.command)) {
    if (!process.stdin.isTTY) throw new Error("Connection setup requires an interactive terminal");
    const prompt = createTerminalPrompter();
    try {
      await configureConnection(prompt);
    } finally {
      prompt.close();
    }
    return;
  }

  if (options.command === "snapshot") {
    const snapshot = await createSnapshot(options);
    console.log(`Wrote ${options.state}`);
    console.log(`Today: ${snapshot.today?.totalTokens?.toLocaleString("en-US") || 0} tokens`);
    return;
  }

  if (options.command === "cli") {
    await showUsage(options);
    return;
  }

  if (options.command === "web") {
    startWeb(options);
    return;
  }

  if (options.command === "push") {
    await pushSnapshot(options);
    return;
  }

  if (options.command === "pull") {
    await pullSnapshots(options);
    return;
  }

  if (options.command === "register") {
    await registerDirectory(options);
    return;
  }

  if (options.command === "skills") {
    if (options.help) {
      console.log(help());
      return;
    }
    if (!options.skillsAction && process.stdin.isTTY) {
      const prompt = createTerminalPrompter();
      try {
        await runInteractiveSkillsCli(options, prompt);
      } finally {
        prompt.close();
      }
      return;
    }
    process.exitCode = await runSkillsCli(options);
    return;
  }

  console.error(help());
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
