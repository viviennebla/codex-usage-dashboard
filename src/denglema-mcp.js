import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

import {
  bindDenglema,
  collectDenglemaSnapshot,
  getDenglemaStatus,
  syncDenglemaUsage,
  uploadLatestDenglemaSnapshot,
} from "./denglema.js";
import {
  DENGLEMA_SNAPSHOT_INTERVAL_MS,
  getLatestDenglemaSnapshot,
} from "./denglema-snapshot.js";

const DEFAULT_SERVER = "http://10.21.5.77:1600";
const SERVER_INFO = { name: "denglema", version: "0.1.2" };
const MIN_SCHEDULER_DELAY_MS = 60 * 1000;
const ERROR_RETRY_MS = 5 * 60 * 1000;

export const DENGLEMA_TOOLS = [
  {
    name: "denglema_status",
    description: "Check whether this native Codex installation is bound to Denglema. Never returns the installation token.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      title: "Check Denglema binding",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "denglema_bind",
    description: "Bind this native Codex installation to Denglema with a one-time pairing code from the Feishu page.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", minLength: 1, description: "One-time pairing code shown by Denglema." },
        name: { type: "string", description: "Optional friendly installation label." },
      },
      required: ["code"],
      additionalProperties: false,
    },
    annotations: {
      title: "Bind Denglema installation",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "denglema_latest_snapshot",
    description: "Read the latest local Denglema snapshot and whether it is pending upload. This never scans logs and never uploads.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      title: "Read latest Denglema snapshot",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "denglema_upload_latest",
    description: "Upload the current latest local Denglema snapshot. This does not rescan local Codex logs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      title: "Upload latest Denglema snapshot",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "denglema_sync",
    description: "Compatibility/manual action: immediately rescan today's Codex usage and optionally upload it. Prefer latest_snapshot plus upload_latest for normal plugin use.",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: { type: "boolean", default: false, description: "Collect locally without uploading." },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Force Denglema sync",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

function textResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function nextDenglemaSnapshotDelay(
  snapshot,
  now = new Date(),
  intervalMs = DENGLEMA_SNAPSHOT_INTERVAL_MS,
) {
  const observedAt = Date.parse(snapshot?.observed_at || "");
  if (!Number.isFinite(observedAt)) return MIN_SCHEDULER_DELAY_MS;
  const remaining = intervalMs - (now.getTime() - observedAt);
  return Math.max(MIN_SCHEDULER_DELAY_MS, remaining);
}

export function startDenglemaSnapshotScheduler(dependencies = {}) {
  const collect = dependencies.collectDenglemaSnapshot || collectDenglemaSnapshot;
  const setTimer = dependencies.setTimeout || setTimeout;
  const clearTimer = dependencies.clearTimeout || clearTimeout;
  let timer = null;
  let stopped = false;

  async function tick() {
    if (stopped) return;

    let delay = ERROR_RETRY_MS;
    try {
      const result = await collect({}, dependencies);
      const now = dependencies.now?.() || new Date();
      delay = nextDenglemaSnapshotDelay(
        result?.snapshot,
        now,
        DENGLEMA_SNAPSHOT_INTERVAL_MS,
      );
    } catch {
      delay = ERROR_RETRY_MS;
    }

    if (stopped) return;
    timer = setTimer(() => { void tick(); }, delay);
    if (typeof timer?.unref === "function") timer.unref();
  }

  void tick();

  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

async function callDenglemaTool(name, args = {}, dependencies = {}) {
  const status = dependencies.getDenglemaStatus || getDenglemaStatus;
  const bind = dependencies.bindDenglema || bindDenglema;
  const latest = dependencies.getLatestDenglemaSnapshot || getLatestDenglemaSnapshot;
  const upload = dependencies.uploadLatestDenglemaSnapshot || uploadLatestDenglemaSnapshot;
  const sync = dependencies.syncDenglemaUsage || syncDenglemaUsage;

  if (name === "denglema_status") {
    return status({}, dependencies);
  }
  if (name === "denglema_bind") {
    const code = String(args.code || "").trim();
    if (!code) throw new Error("pairing code is required");
    return bind({
      server: DEFAULT_SERVER,
      code,
      name: typeof args.name === "string" && args.name.trim() ? args.name.trim() : undefined,
    }, dependencies);
  }
  if (name === "denglema_latest_snapshot") {
    return latest({}, dependencies);
  }
  if (name === "denglema_upload_latest") {
    return upload({}, dependencies);
  }
  if (name === "denglema_sync") {
    return sync({ dryRun: args.dry_run === true }, dependencies);
  }
  throw new Error(`unknown Denglema tool: ${name}`);
}

export async function handleDenglemaMcpRequest(request, dependencies = {}) {
  const id = request?.id;
  const method = request?.method;

  if (method === "notifications/initialized") return null;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: request.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "Denglema keeps one latest local snapshot. The local MCP process refreshes it at most hourly while Codex is in use; uploads happen only when the user chooses.",
      },
    };
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: DENGLEMA_TOOLS } };
  }

  if (method === "tools/call") {
    try {
      const value = await callDenglemaTool(
        request.params?.name,
        request.params?.arguments || {},
        dependencies,
      );
      return { jsonrpc: "2.0", id, result: textResult(value) };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        result: textResult({ error: error?.message || String(error) }, true),
      };
    }
  }

  if (id === undefined || id === null) return null;
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

export function startDenglemaMcpServer() {
  const scheduler = startDenglemaSnapshotScheduler();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });

  lines.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const request = JSON.parse(line);
      const response = await handleDenglemaMcpRequest(request);
      if (response) process.stdout.write(JSON.stringify(response) + "\n");
    } catch (error) {
      process.stderr.write(`Denglema MCP error: ${error?.stack || error}\n`);
    }
  });

  lines.on("close", () => scheduler.stop());
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) startDenglemaMcpServer();
