#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { homedir, hostname } from "node:os";
import { existsSync } from "node:fs";

import { loadAllReports } from "./loader.js";
import { formatCli } from "./format.js";
import { buildSnapshot } from "./snapshot.js";
import {
  DEFAULT_STATE_PATH,
  writeStateFile,
  readDeviceStates,
  writeDeviceState,
  removeDeviceState,
} from "./state.js";
import { addDirectory, listDirectories, removeDirectory, readConfig } from "./config.js";
import { pullFromServer } from "./sync.js";

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
  node src/cli.js register --path <dir> --type codex|claude [--label <name>]

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
  const snapshot = buildSnapshot(reports, options);
  await writeStateFile(snapshot, options.state);
  return snapshot;
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
        console.log(`[push] removed device ${deviceId}`);
        sendJson(res, 200, { ok: true, removed: deviceId });
        return;
      }

      // ── GET /api/snapshot ── return local snapshot merged with pulled devices
      if (req.method === "GET" && url.pathname === "/api/snapshot") {
        const snapshot = await createSnapshot(options);

        // Merge pulled device snapshots into the view
        const { readDeviceStates: readDevs } = await import("./state.js");
        const devices = await readDevs(stateDir);
        if (devices.size > 0) {
          const { mergeSnapshots } = await import("./merge.js");
          // Add local as a device entry
          const allDevices = new Map(devices);
          const localName = hostname();
          allDevices.set(localName, { deviceName: localName, snapshot });
          const merged = mergeSnapshots(allDevices);

          // Carry over device-specific fields from local snapshot
          merged.skills = snapshot.skills || [];
          merged.limits = snapshot.limits || null;
          merged.burn_rate = snapshot.burn_rate || null;
          merged.active_session = snapshot.active_session || null;
          // Expose device list for frontend
          merged.devices = Object.values(merged.source_devices || {});

          sendJson(res, 200, merged);
        } else {
          sendJson(res, 200, snapshot);
        }
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
        console.log(`[sync] ${result.message}`);
        sendJson(res, 200, {
          synced: result.synced,
          failed: result.failed,
          message: result.message,
        });
        return;
      }

      // ── POST /api/sync-status ── compare local vs remote snapshots
      if (req.method === "POST" && url.pathname === "/api/sync-status") {
        const body = await readRequestBody(req);
        const serverUrl = body?.server;
        if (!serverUrl) { sendError(res, 400, "Missing 'server' in request body"); return; }

        // Local snapshot
        const localSnapshot = await createSnapshot(options);
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

      // ── GET /api/sources ── list registered + auto-discovered directories
      if (req.method === "GET" && url.pathname === "/api/sources") {
        const cfg = await readConfig();
        const dirs = cfg.directories || [];

        // Filesystem discovery of default paths
        const home = homedir();
        const discovered = [];
        const codexDefault = join(home, ".codex", "sessions");
        const claudeDefault1 = join(home, ".claude", "projects");
        const claudeDefault2 = join(home, ".config", "claude", "projects");

        if (existsSync(codexDefault)) discovered.push({ path: codexDefault, type: "codex", label: "auto-detected" });
        if (existsSync(claudeDefault1)) discovered.push({ path: claudeDefault1, type: "claude", label: "auto-detected" });
        if (existsSync(claudeDefault2)) discovered.push({ path: claudeDefault2, type: "claude", label: "auto-detected" });

        sendJson(res, 200, {
          registered: dirs,
          discovered,
        });
        return;
      }

      // ── POST /api/sources ── register a directory
      if (req.method === "POST" && url.pathname === "/api/sources") {
        const body = await readRequestBody(req);
        if (!body || !body.path) { sendError(res, 400, "Missing path"); return; }
        const type = body.type === "claude" ? "claude" : "codex";
        const result = await addDirectory(body.path, type, body.label || null);
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

      // ── Static files ──
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
  if (type !== "codex" && type !== "claude") {
    console.error("Error: --type must be 'codex' or 'claude'.");
    process.exitCode = 2;
    return;
  }

  const result = await addDirectory(options.path, type, options.label || null);
  if (result.added) {
    console.log(`Registered ${type} directory: ${options.path}`);
    if (options.label) console.log(`  Label: ${options.label}`);
  } else {
    console.log(`Already registered: ${options.path} (${result.reason})`);
  }

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
      console.error("Example: node src/cli.js pull --server http://8.160.186.237:34777");
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
