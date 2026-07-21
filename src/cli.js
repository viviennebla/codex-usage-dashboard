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
import { addDirectory, listDirectories, removeDirectory, readConfig } from "./config.js";
import { pullFromServer, recordSyncStatus } from "./sync.js";
import { discoverSourceDiagnostics, inspectSource, sourceLabelMap } from "./sources.js";
import { CodexLimitsClient } from "./codex-limits.js";
import { readCodexStatusRateLimits } from "./status.js";

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function parseArgs(argv) {
  const [command = "--help", ...rest] = argv;
  const options = {
    command,
    state: DEFAULT_STATE_PATH,
    stateDir: "state",
    port: 34777,
    bind: "127.0.0.1",
  };
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
  }
  return options;
}

function help() {
  return `Codex Usage Dashboard

Usage:
  node src/cli.js snapshot [--since YYYYMMDD] [--state state/latest.json]
  node src/cli.js cli [--since YYYYMMDD] [--no-wsl]
  node src/cli.js web [--port 34777] [--bind 127.0.0.1] [--no-wsl]
  node src/cli.js push --server <url> [--device <name>] [--token <token>]
  node src/cli.js pull --server <url>
  node src/cli.js register --path <dir> --type codex|claude|skills [--label <name>]

Commands:
  snapshot  Write the canonical dashboard snapshot.
  cli       Print a terminal summary from the snapshot.
  web       Start the local web dashboard.
  push      Push local snapshot to a remote dashboard server.
  pull      Pull snapshots from a remote dashboard server.
  register  Register a custom agent data directory.
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
  const token = process.env.DASHBOARD_TOKEN || null;
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
    const remoteDevices = await readDeviceStates(stateDir);
    const localName = hostname();
    remoteDevices.delete(localName); // never merge own stale snapshot
    if (remoteDevices.size === 0) return snapshot;

    const { mergeSnapshots } = await import("./merge.js");
    const allDevices = new Map(remoteDevices);
    allDevices.set(localName, { deviceName: localName, snapshot });
    const cfg = await readConfig();
    const merged = mergeSnapshots(allDevices, cfg);

    // Carry over device-specific fields from the local snapshot.
    merged.skills = snapshot.skills || [];
    // Rate limits come from the active Codex account on this machine.
    // Synced device snapshots can be stale or from a different session, so keep
    // the dashboard's limit view tied to the local Codex status API.
    merged.limits = snapshot.limits || null;
    merged.limit_updated_at = snapshot.limit_updated_at || null;
    merged.limit_source = snapshot.limit_source || null;
    merged.limit_error = snapshot.limit_error || null;
    merged.burn_rate = snapshot.burn_rate || null;
    merged.active_session = snapshot.active_session || null;
    merged.devices = Object.values(merged.source_devices || {});

    const mergedSS = {};
    for (const [, { snapshot: devSnap }] of allDevices) {
      const ss = devSnap?.source_status;
      if (!ss) continue;
      for (const [src, info] of Object.entries(ss)) {
        if (!mergedSS[src]) {
          mergedSS[src] = { ...info };
        } else {
          mergedSS[src].today_events += info.today_events || 0;
          mergedSS[src].today_tokens += info.today_tokens || 0;
          mergedSS[src].total_events += info.total_events || 0;
          if (info.last_activity && (!mergedSS[src].last_activity || info.last_activity > mergedSS[src].last_activity)) {
            mergedSS[src].last_activity = info.last_activity;
          }
        }
      }
    }
    const now = new Date();
    for (const s of Object.values(mergedSS)) {
      const hoursSince = s.last_activity
        ? Math.round((now - new Date(s.last_activity)) / 3600000 * 10) / 10
        : Infinity;
      s.hours_since_last = hoursSince === Infinity ? null : hoursSince;
      s.status = hoursSince <= 1 ? "active"
        : hoursSince <= 24 ? "recent"
        : hoursSince <= 48 ? "idle"
        : hoursSince <= 168 ? "stale"
        : "expired";
    }
    merged.source_status = mergedSS;
    return merged;
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
        if (!checkAuth(req, token)) {
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
        if (!checkAuth(req, token)) {
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

      // ── POST /api/sync ── trigger pull from remote server
      if (req.method === "POST" && url.pathname === "/api/sync") {
        const body = await readRequestBody(req);
        const serverUrl = body?.server;
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
        const serverUrl = body?.server;
        const token = body?.token || null;
        const deviceId = body?.device || hostname();
        if (!serverUrl) { sendError(res, 400, "Missing 'server'"); return; }

        const snapshot = await rebuildSnapshot();
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
          if (!checkAuth(req, token)) {
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
        const serverUrl = body?.server;
        const { scanAllSkillDirs, compareSkills, readImportedSkills, scanAgentInstallations } = await import("./skills-sync.js");
        const cfg = await readConfig();
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
        const serverUrl = body?.server;
        const names = body?.names || [];
        const token = body?.token || null;
        if (!serverUrl) { sendError(res, 400, "Missing server"); return; }
        const { scanSelectedSkillBundle } = await import("./skills-sync.js");
        const cfg = await readConfig();
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
        const serverUrl = body?.server;
        const names = body?.names || [];
        const strategy = body?.strategy === "merge" ? "merge" : "overwrite";
        if (!serverUrl) { sendError(res, 400, "Missing server"); return; }
        const { applySkillBundleToDir, planSkillBundleApply, scanAllSkillDirs } = await import("./skills-sync.js");
        const cfg = await readConfig();
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
    const devicesHint = token ? "multi-device push enabled" : "local-only (set DASHBOARD_TOKEN for push auth)";
    console.log(`Codex Usage Dashboard: http://${options.bind}:${options.port}`);
    console.log(`  ${devicesHint}`);
  });
}

async function pushSnapshot(options) {
  if (!options.server) {
    console.error("Error: --server <url> is required for the push command.");
    console.error("Example: npm run push -- --server http://your-server:34777 --device my-laptop");
    process.exitCode = 2;
    return;
  }

  const deviceId = options.device || hostname();
  const token = options.token || process.env.DASHBOARD_TOKEN || null;

  console.log(`Creating snapshot...`);
  const snapshot = await createSnapshot(options);
  console.log(`  Today: ${snapshot.today?.totalTokens?.toLocaleString("en-US") || 0} tokens`);

  const serverUrl = String(options.server).replace(/\/+$/, "");
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

  if (options.command === "--help" || options.command === "-h") {
    console.log(help());
    return;
  }

  if (options.command === "snapshot") {
    const snapshot = await createSnapshot(options);
    console.log(`Wrote ${options.state}`);
    console.log(`Today: ${snapshot.today?.totalTokens?.toLocaleString("en-US") || 0} tokens`);
    return;
  }

  if (options.command === "cli") {
    const snapshot = await createSnapshot(options);
    console.log(formatCli(snapshot));
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
    if (!options.server) {
      console.error("Error: --server <url> is required for the pull command.");
      console.error("Example: node src/cli.js pull --server http://your-server:34777");
      process.exitCode = 2;
      return;
    }
    console.log(`Pulling from ${options.server}...`);
    const result = await pullFromServer(options.server);
    console.log(result.message);
    if (result.synced.length > 0) {
      for (const id of result.synced) {
        console.log(`  OK  ${id}`);
      }
    }
    if (result.failed.length > 0) {
      for (const f of result.failed) {
        console.log(`  FAIL  ${f.deviceId} — ${f.error}`);
      }
    }
    return;
  }

  if (options.command === "register") {
    await registerDirectory(options);
    return;
  }

  console.error(help());
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
