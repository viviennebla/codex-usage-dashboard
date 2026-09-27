import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

import {
  bindDenglema,
  getDenglemaStatus,
  syncDenglemaUsage,
} from "./denglema.js";

const DEFAULT_SERVER = "http://10.21.5.77:1600";
const SERVER_INFO = { name: "denglema", version: "0.1.1" };

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
    name: "denglema_sync",
    description: "Collect today's cumulative Codex token usage for this native environment and sync it to Denglema. Set dry_run=true to collect without any network request.",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: { type: "boolean", default: false, description: "Collect locally without uploading." },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Sync Denglema usage",
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

async function callDenglemaTool(name, args = {}, dependencies = {}) {
  const status = dependencies.getDenglemaStatus || getDenglemaStatus;
  const bind = dependencies.bindDenglema || bindDenglema;
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
        instructions: "Denglema tracks only cumulative Codex token totals. Use status before bind/sync when binding state is unknown.",
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
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) startDenglemaMcpServer();
